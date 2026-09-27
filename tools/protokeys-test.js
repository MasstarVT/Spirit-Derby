#!/usr/bin/env node
/*
 * Spirit Derby - tools/protokeys-test.js
 * Review batch 3: prototype-safe maps for user-controlled keys. Chat words, usernames, command
 * arguments, settings keys and save-file keys named like Object.prototype members ('constructor',
 * '__proto__', 'hasOwnProperty', 'toString', 'valueOf' ...) must never resolve to an inherited
 * member or write onto Object.prototype:
 *   SD.util.own / hasOwn / setOwn / dict, '!constructor' / '!__proto__' (unknown commands),
 *   !help / SD.commands.get, every command with those words as the username and as arguments,
 *   'constructor' and '__proto__' as real players (cooldowns, hype credit, no pollution, isMod),
 *   save export / import with those keys, !ribbon, !leaderboard, SD.game.updateSettings (and junk
 *   settings keys in saves), training.normalizeStat / trainRunner, catalog lookups in runners.js,
 *   and the error cooldown that stops a crashing command from flooding the log.
 *
 *   node tools/protokeys-test.js [--verbose]
 *
 * Exit code 1 on failure.
 */
'use strict';

const SD = require('./load-core.js');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;

// -----------------------------------------------------------------------------
// Tiny assert helper
// -----------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log('\n' + title);
}
function ok(cond, name, detail) {
  if (cond) {
    passed++;
    if (VERBOSE) console.log('  PASS ' + name);
  } else {
    failed++;
    const line = name + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '');
    failures.push(currentSection + ' > ' + line);
    console.log('  FAIL ' + line);
  }
  return !!cond;
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  return ok(a === e, name, 'expected ' + e + ', got ' + a);
}
function has(str, needle, name) {
  return ok(typeof str === 'string' && str.indexOf(needle) >= 0, name, 'expected "' + needle + '" in "' + str + '"');
}

// -----------------------------------------------------------------------------
// Harness: frozen clock, fresh deterministic state, console.error capture
// -----------------------------------------------------------------------------
let NOW = 1700000000000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }

const consoleErrors = [];
const realConsoleError = console.error;
console.error = function () { consoleErrors.push(Array.prototype.join.call(arguments, ' ')); };

function fresh() {
  const rt = SD.state.runtime;
  rt.cooldowns = {};              // plain maps on purpose: readers must not rely on dict()
  rt.activity = {};
  rt.runnerCooldowns = {};
  rt.chatFeed = [];
  rt.nervousCheers = {};
  rt.hypeRecent = {};
  SD.state.set(SD.state.create({ seedSalt: 424242, dayEventId: 'clearSkies' }));
  SD.game.init();
  tick(60000);
  return SD.state.get();
}
// Achievements on (as in the app): their progress / hype maps are keyed by login too.
SD.achievements.init();
function S() { return SD.state.get(); }
function say(user, text, opts) {
  return SD.commands.handleChat(Object.assign({ username: user, text: text, source: 'twitch' }, opts || {}));
}
function player(u) { return SD.players.get(S(), u); }
function runner(q) { return SD.state.findRunner(q).runner; }
function errorLogs() { return S().log.filter(function (e) { return e.type === 'error'; }); }

// Object.prototype / Object must never gain keys from chat.
const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
const OBJECT_NAMES = Object.getOwnPropertyNames(Object).sort().join(',');
function unpolluted() {
  return Object.getOwnPropertyNames(Object.prototype).sort().join(',') === PROTO_NAMES &&
    Object.getOwnPropertyNames(Object).sort().join(',') === OBJECT_NAMES &&
    ({}).isMod === undefined && ({}).spiritPoints === undefined && ({}).runnerId === undefined;
}

// The words the review asked for, plus a few more Object.prototype members.
const WORDS = ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf'];
const MORE_WORDS = ['isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupSetter__'];

// -----------------------------------------------------------------------------
section('SD.util own / hasOwn / setOwn / dict');
// -----------------------------------------------------------------------------
{
  const U = SD.util;
  const o = {};
  eq([U.own(o, 'constructor'), U.own(o, '__proto__'), U.own(o, 'toString')], [undefined, undefined, undefined],
    'own() ignores inherited members');
  eq([U.hasOwn(o, 'constructor'), U.hasOwn(null, 'x'), U.own(null, 'x'), U.own(undefined, 'x')], [false, false, undefined, undefined],
    'hasOwn / own tolerate missing maps');
  U.setOwn(o, '__proto__', { a: 1 });
  U.setOwn(o, 'constructor', 5);
  eq(Object.getPrototypeOf(o) === Object.prototype, true, 'setOwn("__proto__") does not change the prototype');
  eq([U.own(o, '__proto__'), U.own(o, 'constructor'), Object.keys(o)], [{ a: 1 }, 5, ['__proto__', 'constructor']],
    'setOwn stores own, enumerable entries');
  eq(JSON.parse(JSON.stringify(o)).constructor, 5, 'setOwn entries survive JSON');
  eq(U.own(JSON.parse(JSON.stringify(o)), '__proto__'), { a: 1 }, 'a "__proto__" entry round-trips through JSON as an own key');
  U.setOwn(o, '__proto__', 7);
  eq(U.own(o, '__proto__'), 7, 'setOwn overwrites an existing own "__proto__" entry');
  const d = U.dict({ a: 1 });
  eq([Object.getPrototypeOf(d), d.a, d.constructor, d.toString, d.__proto__], [null, 1, undefined, undefined, undefined],
    'dict() has no prototype');
  d.__proto__ = 3;
  eq([Object.keys(d), d.__proto__], [['a', '__proto__'], 3], 'dict()["__proto__"] = x stores an own entry');
  eq(unpolluted(), true, 'Object.prototype untouched by the helpers');
}

// -----------------------------------------------------------------------------
section('command names that are Object.prototype members (commands#2)');
// -----------------------------------------------------------------------------
{
  fresh();
  consoleErrors.length = 0;
  WORDS.concat(MORE_WORDS).forEach(function (w) {
    const r = say('viewer', '!' + w);
    ok(r.ok === false && r.unknown === true && r.message.indexOf('Unknown command') === 0, '!' + w + ' is an unknown command', r);
    const h = say('viewer', '!help ' + w);
    ok(h.ok === false && h.message.indexOf('No command called') === 0, '!help ' + w + ' -> no such command', h.message);
    let g;
    try { g = SD.commands.get(w); } catch (e) { g = 'threw ' + e.message; }
    eq(g, null, 'SD.commands.get("' + w + '") -> null');
    eq(SD.commands.cooldownLeft('viewer', w), 0, 'cooldownLeft("' + w + '") -> 0');
    eq(SD.commands.resolveName(w), w.toLowerCase(), 'resolveName("' + w + '") is not an alias');
    const src = SD.commands.handleChat({ username: 'viewer', text: 'hi', source: w });
    const line = SD.state.runtime.chatFeed[SD.state.runtime.chatFeed.length - 1];
    ok(src.ok && line.source === 'sim', 'source "' + w + '" is not a known source (falls back to sim)', line.source);
  });
  eq(errorLogs().length, 0, 'no error lines in the event log');
  eq(consoleErrors.length, 0, 'no console.error');
  // 300 '!constructor' messages cannot wipe the log (they are plain unknown commands now).
  const before = S().log.length;
  for (let i = 0; i < 300; i++) say('spammer' + (i % 7), i % 2 ? '!constructor' : '!__proto__');
  eq([S().log.length, errorLogs().length], [before, 0], '!constructor / !__proto__ spam adds nothing to the event log');
  eq(SD.commands.list({ all: true }).filter(function (d) { return WORDS.indexOf(d.name) >= 0; }).length, 0, 'list() has no prototype entries');
  eq(unpolluted(), true, 'Object.prototype untouched');
}

// -----------------------------------------------------------------------------
section('every command with prototype words as username and arguments');
// -----------------------------------------------------------------------------
{
  const names = SD.commands.list({ all: true }).map(function (d) { return d.name; });
  ok(names.length >= 20, 'the registry lists every command', names.length);
  const argSets = [];
  WORDS.forEach(function (w) {
    argSets.push([w], [w, w], ['moss', w], [w, 'speed'], [w, '50'], ['moss', '50', w]);
  });
  const users = WORDS.concat(['FoxFan']);
  let crashes = [];
  let polluted = false;
  let badPlayers = [];
  consoleErrors.length = 0;
  users.forEach(function (u) {
    [false, true].forEach(function (isMod) {
      fresh();
      [u, 'helper'].forEach(function (x) { say(x, '!join', { source: 'bridge', isMod: isMod }); });
      say(u, '!claim moss', { source: 'bridge', isMod: isMod });
      names.forEach(function (n) {
        [[]].concat(argSets).forEach(function (args) {
          tick(601000);
          const text = '!' + n + (args.length ? ' ' + args.join(' ') : '');
          const r = say(u, text, { source: 'bridge', isMod: isMod });
          if (!r || typeof r.message !== 'string' || r.message.indexOf('Something went wrong') >= 0) crashes.push(u + ': ' + text + ' -> ' + (r && r.message));
          if (!unpolluted()) polluted = true;
          if (S().currentRace) SD.game.abortRace();
        });
      });
      Object.keys(S().players).forEach(function (k) {
        const p = S().players[k];
        if (!p || typeof p !== 'object' || p.username !== k || !isFinite(p.spiritPoints)) badPlayers.push(k);
      });
      try { JSON.parse(SD.persistence.exportJSON()); } catch (e) { crashes.push('export failed for ' + u + ': ' + e.message); }
    });
  });
  eq(crashes.slice(0, 5), [], 'no command crashes ("Something went wrong") for any word as username or argument');
  eq(consoleErrors.slice(0, 3), [], 'no console.error during the sweep');
  eq(polluted, false, 'Object.prototype and Object never gain keys during the sweep');
  eq(badPlayers, [], 'every stored player is an own entry keyed by its login');
}

// -----------------------------------------------------------------------------
section('"constructor" is a real viewer (commands#3)');
// -----------------------------------------------------------------------------
{
  fresh();
  consoleErrors.length = 0;
  const j = say('constructor', '!join');
  eq([j.ok, j.message.indexOf('Welcome') === 0], [true, true], 'constructor can !join');
  const p = player('constructor');
  ok(p && p !== Object && Object.prototype.hasOwnProperty.call(S().players, 'constructor'), 'stored as an own player entry');
  eq(p && p.stats.spEarnedTotal >= SD.CONFIG.ECONOMY.JOIN_SP && p.spiritPoints === p.stats.spEarnedTotal, true, 'gets the join SP');
  eq(SD.state.player('constructor') === p, true, 'SD.state.player finds the own entry');
  const c1 = say('constructor', '!cheer');
  eq(c1.ok, true, 'first !cheer works');
  tick(1500);
  const c2 = say('constructor', '!cheer');
  eq([c2.ok, !!c2.cooldown], [false, true], 'second !cheer inside the cheer cooldown is refused as a cooldown');
  eq(S().hype.value, SD.CONFIG.HYPE.GAINS.cheer, 'hype rose once, not twice');
  eq(SD.util.own(S().hype.contributions, 'constructor'), SD.CONFIG.HYPE.GAINS.cheer, 'hype credit stored under "constructor"');
  const energy = runner('velvet').energy;
  tick(60000);
  const t1 = say('constructor', '!train velvet speed');
  tick(1500);
  const t2 = say('constructor', '!train velvet speed');
  eq([t1.ok, t2.ok, !!t2.cooldown], [true, false, true], '!train is cooled down for constructor like for anyone');
  ok(runner('velvet').energy < energy, 'the first training happened');
  eq(Object.getOwnPropertyNames(Object).sort().join(','), OBJECT_NAMES, 'the Object constructor gained no keys');
  // A never-joined 'constructor' does not pass the player gate.
  fresh();
  const g = say('constructor', '!cheer');
  eq([g.ok, g.message], [false, "You're not in the derby yet — type !join"], 'an unjoined "constructor" is not a player');
  eq(player('constructor'), null, 'SD.players.get("constructor") -> null before !join');
  eq(SD.state.player('constructor'), null, 'SD.state.player("constructor") -> null before !join');
  eq(consoleErrors.length, 0, 'no console.error');
}

// -----------------------------------------------------------------------------
section('"__proto__" is a real viewer and never pollutes Object.prototype (commands#3)');
// -----------------------------------------------------------------------------
{
  fresh();
  consoleErrors.length = 0;
  const j = say('__proto__', '!join', { source: 'bridge', isMod: true });
  eq(j.ok, true, '__proto__ can !join (bridge, isMod)');
  eq(({}).isMod, undefined, 'Object.prototype.isMod stays undefined');
  eq(unpolluted(), true, 'Object.prototype untouched');
  const p = player('__proto__');
  ok(p && p !== Object.prototype && p.username === '__proto__' && p.isMod === true, 'own "__proto__" player with the mod flag', p && p.username);
  eq(Object.keys(S().players), ['__proto__'], 'state.players lists the "__proto__" key');
  eq(Object.getPrototypeOf(S().players) === Object.prototype, true, 'state.players keeps its normal prototype');
  // The review's escalation: a non-mod viewer must still be refused a race.
  say('foxfan', '!join', { source: 'bridge', isMod: false });
  const r = say('foxfan', '!race', { source: 'bridge', isMod: false });
  eq(!!S().currentRace, false, 'a non-mod bridge viewer cannot start a race afterwards');
  ok(r.message.indexOf('No race running') === 0, '!race from a non-mod is the read-only status line', r.message);
  const mr = say('__proto__', '!race', { source: 'bridge', isMod: true });
  eq([mr.ok, !!S().currentRace], [true, true], 'the "__proto__" mod can start a race');
  SD.game.abortRace();
  // Hype credit, claims and achievements progress work under the key.
  tick(60000);
  eq(say('__proto__', '!claim moss', { source: 'bridge', isMod: true }).ok, true, '__proto__ can claim a runner');
  eq(SD.players.runnerOf(S(), '__proto__') && SD.players.runnerOf(S(), '__proto__').id, runner('moss').id, 'runnerOf("__proto__") is its runner');
  eq(runner('moss').ownerKey, '__proto__', 'runner.ownerKey is "__proto__"');
  tick(60000);
  eq(say('__proto__', '!train speed', { source: 'bridge', isMod: true }).ok, true, '__proto__ can train its runner');
  tick(60000);
  eq(say('__proto__', '!cheer moss', { source: 'bridge', isMod: true }).ok, true, '__proto__ can cheer');
  ok(SD.util.own(S().hype.contributions, '__proto__') > 0, 'hype credit stored under an own "__proto__" key', S().hype.contributions);
  ok(Object.prototype.hasOwnProperty.call(S().achievements.progress, '__proto__'), 'achievements.progress has an own "__proto__" entry');
  const lb = SD.leaderboards.top(S(), 'hypeContributions', 10, 'season');
  ok(lb.some(function (e) { return e.id === '__proto__'; }), 'the hype board lists "__proto__"');
  const rank = say('foxfan', '!rank __proto__', { source: 'bridge' });
  ok(rank.ok && rank.message.indexOf('__proto__') >= 0, '!rank __proto__ finds the viewer', rank.message);
  const top = SD.seasons.summary(S()).topHypeContributor;
  eq(top && [top.username, top.displayName], ['__proto__', '__proto__'], 'season summary: top hype is "__proto__"');
  eq(unpolluted(), true, 'Object.prototype still untouched');
  eq(consoleErrors.length, 0, 'no console.error');

  // Save export -> import keeps both prototype-named players and their data.
  say('constructor', '!join');
  const json = SD.persistence.exportJSON();
  ok(json.indexOf('"__proto__":{') >= 0, 'the export has a "__proto__" player key');
  const spP = player('__proto__').spiritPoints, spC = player('constructor').spiritPoints;
  fresh();
  const imp = SD.persistence.importJSON(json);
  eq(imp.ok, true, 'importJSON ok');
  eq([player('__proto__') && player('__proto__').spiritPoints, player('constructor') && player('constructor').spiritPoints], [spP, spC],
    'both players survive export / import');
  eq(Object.keys(S().players).sort(), ['__proto__', 'constructor', 'foxfan'], 'no player lost or invented');
  eq(Object.getPrototypeOf(S().players) === Object.prototype, true, 'the imported players map has the normal prototype');
  eq(runner('moss').ownerKey, '__proto__', 'the "__proto__" claim survives import');
  eq(SD.players.runnerOf(S(), '__proto__') && SD.players.runnerOf(S(), '__proto__').id, runner('moss').id, 'runnerOf still works after import');
  ok(SD.util.own(S().hype.contributions, '__proto__') > 0, 'hype credit survives import');
  tick(60000);
  eq(say('__proto__', '!cheer', { source: 'bridge' }).ok, true, 'the imported "__proto__" player can act');
  eq(unpolluted(), true, 'Object.prototype untouched after import');
}

// -----------------------------------------------------------------------------
section('persistence.normalize with prototype-named keys');
// -----------------------------------------------------------------------------
{
  fresh();
  const raw = JSON.parse(SD.persistence.exportJSON());
  const moss = raw.runners.filter(function (r) { return r.rosterKey === 'mossRunner' || /moss/i.test(r.name); })[0];
  const fern = raw.runners.filter(function (r) { return /fern/i.test(r.name); })[0];
  const text = JSON.stringify(raw).replace('"players":{}',
    '"players":{"constructor":{"username":"constructor","displayName":"Constructor","spiritPoints":300,"runnerId":"' + moss.id + '"},' +
    '"__proto__":{"username":"__proto__","displayName":"Proto","spiritPoints":150}}');
  const parsed = JSON.parse(text);
  const pm = parsed.runners.filter(function (r) { return r.id === moss.id; })[0];
  pm.ownerKey = 'constructor'; pm.owner = 'Constructor';
  const pf = parsed.runners.filter(function (r) { return r.id === fern.id; })[0];
  pf.ownerKey = null; pf.owner = 'toString';   // legacy label naming no player: released
  parsed.bets = [{ id: 'b1', username: '__proto__', displayName: 'Proto', runnerId: moss.id, runnerName: moss.name, amount: 50, odds: 3 },
    { id: 'b2', username: 'toString', displayName: 'x', runnerId: moss.id, runnerName: moss.name, amount: 50, odds: 3 }];
  parsed.hype.contributions = JSON.parse('{"__proto__": 4, "constructor": 2, "valueOf": "x"}');
  const st = SD.persistence.migrate(parsed);
  eq(Object.keys(st.players).sort(), ['__proto__', 'constructor'], 'both prototype-named players load');
  eq([SD.players.get(st, 'constructor').spiritPoints, SD.players.get(st, '__proto__').spiritPoints], [300, 150], 'their SP is kept');
  eq([st.runners.filter(function (r) { return r.id === moss.id; })[0].ownerKey, SD.players.get(st, 'constructor').runnerId], ['constructor', moss.id],
    'the "constructor" claim is kept');
  eq(st.runners.filter(function (r) { return r.id === fern.id; })[0].owner, null, 'a legacy "toString" label (no such player) is released');
  eq(st.bets.map(function (b) { return b.username; }), ['__proto__'], 'the "__proto__" bet is kept, the "toString" bet (no player) dropped');
  eq([SD.util.own(st.hype.contributions, '__proto__'), SD.util.own(st.hype.contributions, 'constructor'), SD.util.hasOwn(st.hype.contributions, 'valueOf')],
    [4, 2, false], 'hype contributions: own numeric entries kept, junk dropped');
  eq(unpolluted(), true, 'Object.prototype untouched by normalize');
}

// -----------------------------------------------------------------------------
section('!ribbon with prototype words (commands#4)');
// -----------------------------------------------------------------------------
{
  fresh();
  consoleErrors.length = 0;
  say('FoxFan', '!join');
  say('FoxFan', '!claim moss');
  SD.state.mutate('test', function (s) { SD.players.addSp(s, 'foxfan', 1000, 'test'); });
  const sp = player('foxfan').spiritPoints;
  ['constructor', 'Con Structor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'].forEach(function (w) {
    tick(60000);
    const r = say('FoxFan', '!ribbon ' + w);
    ok(!r.ok && r.message.indexOf('Unknown colour') === 0, '!ribbon ' + w + ' is an unknown colour', r.message);
  });
  eq([player('foxfan').spiritPoints, runner('moss').ribbonColor], [sp, null], 'no SP charged, no ribbon stored');
  tick(60000);
  const red = say('FoxFan', '!ribbon red');
  eq([red.ok, runner('moss').ribbonColor], [true, SD.DATA.RIBBON_COLORS.red], '!ribbon red still works');
  has(red.message, 'wears a red ribbon', 'a named colour is named in the reply');
  tick(60000);
  const hex = say('FoxFan', '!ribbon #ABC');
  eq([hex.ok, runner('moss').ribbonColor], [true, '#aabbcc'], '!ribbon #hex still works');
  has(hex.message, 'wears a #aabbcc ribbon', 'a hex colour is shown as hex');
  // A non-string ribbonColor (e.g. written by an older build) no longer crashes the next !ribbon.
  SD.state.mutate('test', function (s) { SD.state.runnerById(runner('moss').id, s).ribbonColor = function () {}; });
  tick(60000);
  const again = say('FoxFan', '!ribbon blue');
  eq([again.ok, runner('moss').ribbonColor], [true, SD.DATA.RIBBON_COLORS.blue], '!ribbon blue over a non-string ribbonColor works');
  eq(consoleErrors.length, 0, 'no console.error');
}

// -----------------------------------------------------------------------------
section('leaderboard aliases and scopes (economy#10)');
// -----------------------------------------------------------------------------
{
  fresh();
  const L = SD.leaderboards;
  WORDS.concat(MORE_WORDS).forEach(function (w) {
    eq([L.resolve(w), L.resolveScope(w), L.get(w)], [null, null, null], 'resolve / resolveScope / get("' + w + '") -> null');
  });
  eq([L.resolve('wins'), L.resolveScope('all'), L.get('xp') && L.get('xp').id], ['runnerWins', 'all', 'runnerXp'], 'real aliases still resolve');
  ['!lb constructor', '!top Constructor', '!lb constructor all', '!leaderboard __proto__'].forEach(function (t) {
    const r = say('viewer', t);
    ok(r.ok && r.message.indexOf('No board called') === 0, t + ' -> "No board called ..."', r.message);
  });
  const w = say('viewer', '!lb wins constructor');
  ok(w.ok && w.message.length > 0 && w.message.indexOf('No board') < 0, '!lb wins constructor -> the wins board', w.message);
}

// -----------------------------------------------------------------------------
section('SD.game.updateSettings with inherited keys (director-state#6)');
// -----------------------------------------------------------------------------
{
  fresh();
  let threw = null, a, b, c, d;
  try {
    a = SD.game.updateSettings({ constructor: 5, toString: 'x' });
    b = SD.game.updateSettings({ hasOwnProperty: 1 });
    c = SD.game.updateSettings({ valueOf: 1, isPrototypeOf: 1 });
    d = SD.game.updateSettings(JSON.parse('{"__proto__": 1, "distance": 1600}'));
  } catch (e) { threw = e.message; }
  eq(threw, null, 'updateSettings never throws on inherited keys');
  eq([a.ok, a.applied, a.rejected], [false, {}, ['constructor', 'toString']], 'constructor / toString are rejected');
  eq([b.ok, b.rejected], [false, ['hasOwnProperty']], 'hasOwnProperty is rejected');
  eq(c.rejected, ['valueOf', 'isPrototypeOf'], 'valueOf / isPrototypeOf are rejected');
  eq([d.rejected, d.applied], [['__proto__'], { distance: 1600 }], '"__proto__" from JSON is rejected, a real key next to it applies');
  const s = S().settings;
  eq(['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'].filter(function (k) { return Object.prototype.hasOwnProperty.call(s, k); }), [],
    'no junk keys written into settings');
  eq(typeof String(s), 'string', 'String(settings) works');
  eq(s.distance, 1600, 'the real setting was saved');
  // Saves written by older builds with those junk keys load without them.
  const raw = JSON.parse(SD.persistence.exportJSON());
  raw.settings.toString = '[object Undefined]';
  raw.settings.constructor = 5;
  raw.settings.futureSetting = 'kept';
  const text = JSON.stringify(raw).replace('"settings":{', '"settings":{"__proto__":{"isMod":true},');
  const st = SD.persistence.migrate(JSON.parse(text));
  eq(['toString', 'constructor', '__proto__'].filter(function (k) { return Object.prototype.hasOwnProperty.call(st.settings, k); }), [],
    'junk Object.prototype-named settings keys are dropped on load');
  eq([st.settings.futureSetting, st.settings.distance], ['kept', 1600], 'other unknown keys and real settings are kept');
  eq([typeof String(st.settings), unpolluted()], ['string', true], 'the loaded settings stringify; Object.prototype untouched');
}

// -----------------------------------------------------------------------------
section('training stat names (runners-data#5)');
// -----------------------------------------------------------------------------
{
  fresh();
  WORDS.concat(MORE_WORDS, ['Constructor', 'con structor']).forEach(function (w) {
    eq(SD.training.normalizeStat(w), null, 'normalizeStat("' + w + '") -> null');
  });
  eq([SD.training.normalizeStat('SPD'), SD.training.normalizeStat('luck')], ['speed', 'luck'], 'real stats and aliases still resolve');
  const r = runner('moss');
  const before = JSON.stringify([r.stats, r.trainStreak, r.energy, r.xp]);
  say('bob', '!join');
  const sp = player('bob').spiritPoints;
  const res = SD.game.trainRunner(r.id, 'constructor', 'bob');
  eq(res.ok, false, 'SD.game.trainRunner(id, "constructor") is refused');
  has(res.message, 'Unknown stat "constructor"', 'the refusal names the stat as typed');
  eq(JSON.stringify([runner('moss').stats, runner('moss').trainStreak, runner('moss').energy, runner('moss').xp]), before, 'the runner is unchanged');
  eq(player('bob').spiritPoints, sp, 'no SP awarded');
  tick(60000);
  const one = say('bob', '!train constructor');
  eq([one.ok, one.message.indexOf('Usage:') === 0], [false, true], '!train constructor -> usage');
  tick(60000);
  const two = say('bob', '!train moss constructor');
  eq(two.ok, false, '!train moss constructor is refused');
  has(two.message, 'Unknown stat "constructor"', '... naming "constructor", not a native function');
  ok(two.message.indexOf('native code') < 0, 'no function source in the reply', two.message);
}

// -----------------------------------------------------------------------------
section('catalog lookups for saved / API runner fields');
// -----------------------------------------------------------------------------
{
  fresh();
  const r = SD.runners.normalize({ id: 'r77', name: 'Junk Runner', style: 'constructor', mood: '__proto__', stats: {} });
  eq([r.style, r.mood], ['paceChaser', SD.CONFIG.MOOD.DEFAULT], 'runners.normalize resets prototype-named style / mood');
  eq(SD.runners.setMood(r, 'constructor'), false, 'setMood("constructor") is refused');
  eq(SD.runners.styleName('constructor'), 'constructor', 'styleName("constructor") returns the word, not a function');
  const sp = SD.game.spawnRunner({ name: 'Proto Spawn', speciesId: 'constructor', style: '__proto__', abilityId: 'toString' });
  ok(sp && sp.id && SD.util.hasOwn(SD.DATA.STYLES, sp.style) && sp.ability && SD.util.hasOwn(SD.DATA.ABILITIES, sp.ability.id),
    'spawnRunner ignores prototype-named species / style / ability', sp && [sp.style, sp.ability]);
  ok(typeof sp.species === 'string', 'the spawned runner has a real species', sp && sp.species);
  const ents = SD.race.buildEntrants([Object.assign({}, runner('moss'), { abilityId: 'constructor', mood: 'constructor', style: 'constructor' })],
    { distance: 1200, hypeLevel: 0, dayEvent: null, cheerBonus: {} });
  eq([ents[0].abilityId, ents[0].mood, ents[0].style], [null, SD.CONFIG.MOOD.DEFAULT, 'paceChaser'], 'race entrants ignore prototype-named ability / mood / style');
}

// -----------------------------------------------------------------------------
section('UI catalog labels (SD.ui.dom.info) for prototype-named ids');
// -----------------------------------------------------------------------------
{
  require('../js/ui/dom.js');
  const info = SD.ui.dom.info;
  eq([info.abilityName('constructor'), info.style('constructor').name, info.species('__proto__'), info.moodEmoji('constructor')],
    ['constructor', 'constructor', '__proto__', '🙂'], 'unknown ids are shown as typed, never as "Object" / a function');
  eq(info.ability({ abilityId: 'constructor' }), null, 'a "constructor" ability id is no ability');
  eq([info.style('frontRunner').name, info.abilityName('forestsFavor')], ['Front Runner', "Forest's Favor"], 'real ids still resolve');
}

// -----------------------------------------------------------------------------
section('an unexpected handler failure is cooled down and logged once');
// -----------------------------------------------------------------------------
{
  fresh();
  consoleErrors.length = 0;
  let calls = 0;
  SD.commands.register({
    name: 'boomtest', cooldownMs: 0, hidden: true,
    handler: function () { calls++; throw new TypeError('kaboom'); }
  });
  SD.commands.register({
    name: 'boomslow', cooldownMs: 120000, hidden: true,
    handler: function () { calls++; throw new TypeError('kaboom'); }
  });
  const first = say('viewer', '!boomtest');
  has(first.message, 'Something went wrong with !boomtest', 'the first failure replies as before');
  const flood = [];
  for (let i = 0; i < 20; i++) { tick(500); flood.push(say('viewer', '!boomtest')); }
  eq(calls, 1, 'the handler is not run again inside the error cooldown');
  eq(flood.every(function (r) { return !r.ok && r.cooldown === true; }), true, 'repeats are refused as a cooldown');
  eq([errorLogs().length, consoleErrors.length], [1, 1], 'one error log line and one console.error, not 21');
  const other = say('otherviewer', '!boomtest');
  has(other.message, 'Something went wrong', 'the error cooldown is per viewer');
  eq(errorLogs().length, 2, 'the other viewer logs its own failure');
  tick(SD.CONFIG.COOLDOWNS.ERROR_S * 1000);
  say('viewer', '!boomtest');
  eq(calls, 3, 'after COOLDOWNS.ERROR_S the command runs again');
  const admin = say('#streamer', '!boomtest', { source: 'admin' });
  const admin2 = say('#streamer', '!boomtest', { source: 'admin' });
  eq([admin.cooldown, admin2.cooldown, calls], [undefined, undefined, 5], 'the streamer console stays exempt from cooldowns');
  // A failing command with its own longer cooldown is cooled down for that length.
  say('viewer', '!boomslow');
  tick(SD.CONFIG.COOLDOWNS.ERROR_S * 1000 + 1000);
  const slow = say('viewer', '!boomslow');
  eq([slow.cooldown, calls], [true, 6], 'a crashing command with a 120 s cooldown stays cooled down past ERROR_S');
  tick(120000);
  say('viewer', '!boomslow');
  eq(calls, 7, '... and runs again after its own cooldown');
  SD.commands.unregister('boomtest');
  SD.commands.unregister('boomslow');
  // Normal refusals (CommandError) are not error-cooled: !claim with a bad name can be retried.
  say('viewer', '!join');
  tick(60000);
  const bad = say('viewer', '!claim nosuchrunner');
  const retry = say('viewer', '!claim moss');
  eq([bad.ok, retry.ok], [false, true], 'a CommandError refusal does not lock the command');
}

// -----------------------------------------------------------------------------
console.error = realConsoleError;
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
