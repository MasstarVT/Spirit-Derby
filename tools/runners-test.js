#!/usr/bin/env node
/*
 * Spirit Derby - tools/runners-test.js (M6)
 * Roster growth and debug helpers:
 *   create   !create <name>: refused while a runner is free (the reply names them), refused when
 *            settings.allowCreate is off (two wordings), refused when you already own a runner or
 *            have not joined, race-locked; name rules (3-20 chars, letters / digits / spaces /
 *            apostrophes, 3+ plain letters or digits, not reserved, unique case-insensitively, not a
 *            prefix of another runner); success = a random species runner, stats summing to 200,
 *            a style that species runs, a style-suited catalog ability, custom:true, claimed, the
 *            Creator achievement (once), a card summary in the reply; the runner races
 *   spawn    admin SPAWN RUNNER shares the code (SD.game.spawnRunner): unique names, no Creator,
 *            CONFIG.RUNNERS.MAX_ACTIVE caps both paths with a readable refusal
 *   debug    SD.debug.state / lastRace / lastRaceJSON / simulate (deterministic, no state change) /
 *            replay / bus.wildcard; SD.VERSION 1.0.0
 *
 *   node tools/runners-test.js [--verbose] [--transcript]
 * --transcript prints the !create chat transcript (success, name taken, free-runner refusal,
 * creation switched off, paddock full).
 */
'use strict';

const SD = require('./load-core.js');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;
const TRANSCRIPT = process.argv.indexOf('--transcript') >= 0;

let passed = 0;
let failed = 0;
function section(t) { console.log('\n' + t); }
function ok(cond, name, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '')); }
  return !!cond;
}
function eq(a, b, name) { return ok(JSON.stringify(a) === JSON.stringify(b), name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function has(str, needle, name) { return ok(typeof str === 'string' && str.indexOf(needle) >= 0, name, 'expected "' + needle + '" in "' + str + '"'); }

let NOW = 1767225600000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }
SD.achievements.init();
const transcript = [];

function fresh(opts) {
  const rt = SD.state.runtime;
  rt.cooldowns = {}; rt.runnerCooldowns = {}; rt.activity = {}; rt.chatFeed = []; rt.hypeRecent = {};
  SD.state.set(SD.state.create(Object.assign({ seedSalt: 424242, dayEventId: 'clearSkies' }, opts || {})));
  SD.game.init();
  SD.betting.clearCache();
  tick(60000);
  return SD.state.get();
}
function S() { return SD.state.get(); }
function say(user, text, opts) {
  tick(11000);
  const r = SD.processCommand(user, text, Object.assign({ source: 'twitch' }, opts || {}));
  transcript.push('@' + user + ': ' + text + '\n    ↳ ' + (r.ok ? '' : '[refused] ') + r.message);
  return r;
}
function note(text) { transcript.push('-- ' + text); }
// Every roster runner gets an owner (viewers V1..Vn).
function claimAll() {
  const free = SD.players.freeRunners(S());
  free.forEach(function (r, i) {
    const u = 'Owner' + (i + 1) + '_' + S().runners.length;
    SD.processCommand(u, '!join', { source: 'twitch' });
    SD.processCommand(u, '!claim ' + r.id, { source: 'twitch' });
  });
  return SD.players.freeRunners(S()).length;
}
const R = SD.CONFIG.RUNNERS;

// =============================================================================
section('create: refusals before any runner is made');
// =============================================================================
(function () {
  fresh();
  note('fresh game: 10 roster runners, nobody owns anything');
  const n0 = S().runners.length;
  let r = say('FoxFan', '!create Pebble Dash');
  ok(!r.ok && /type !join/.test(r.message), 'not joined -> type !join');
  say('FoxFan', '!join');
  r = say('FoxFan', '!create');
  ok(!r.ok && /Usage: !create <name>/.test(r.message), 'no name -> usage');
  r = say('FoxFan', '!create Pebble Dash');
  ok(!r.ok && /Moss Runner, Moonhoof, Thunder Fern and 7 more are still free — !claim one!/.test(r.message), 'free runners -> the reply names them', r.message);
  eq(S().runners.length, n0, 'nothing was created');
  say('FoxFan', '!claim moss');
  r = say('FoxFan', '!create Pebble Dash');
  ok(!r.ok && /You already run with .*Moss Runner\. One runner per viewer!/.test(r.message), 'already owns a runner -> refused', r.message);

  // Everyone else claims; Glow Wisp stays free.
  note('eight more viewers claim; only Glow Wisp is left');
  const free = SD.players.freeRunners(S()).filter(function (x) { return x.name !== 'Glow Wisp'; });
  free.forEach(function (x, i) { SD.processCommand('V' + i, '!join'); SD.processCommand('V' + i, '!claim ' + x.id); });
  say('MothMom', '!join');
  r = say('MothMom', '!create Pebble Dash');
  ok(!r.ok && r.message.indexOf('Glow Wisp is still free — !claim one!') === 0, 'one free runner -> "Glow Wisp is still free"', r.message);
  SD.game.updateSettings({ allowCreate: false });
  note('streamer unticks "Allow !create"');
  r = say('MothMom', '!create Pebble Dash');
  eq(r.message, 'Glow Wisp is still free — !claim one, or wait for the streamer to allow !create.', 'creation off + a free runner');
  say('MothMom', '!claim glow');
  say('AcornAndy', '!join');
  r = say('AcornAndy', '!create Pebble Dash');
  ok(!r.ok && /Every runner has an owner and creating runners is switched off/.test(r.message), 'creation off + nothing free', r.message);
  SD.game.updateSettings({ allowCreate: true });
  note('streamer ticks "Allow !create" again');
})();

// =============================================================================
section('create: name rules');
// =============================================================================
(function () {
  const cases = [
    ['ab', /is 2 characters long/],
    ['Way Too Long Runner Name', /is 24 characters long/],
    ['🦊🦊🦊', /characters a runner cannot wear/],
    ['Pebble-Dash', /characters a runner cannot wear/],
    ['ÉÉÉ', /at least 3 plain letters or digits/],
    ['all', /command word/],
    ['r05', /command word/],
    ['moss runner', /already a runner called Moss Runner/],
    ['MOSSRUNNER', /already a runner called Moss Runner/],
    ['Moss', /too close to Moss Runner/],
    ['Glow Wisps', /too close to Glow Wisp/]
  ];
  cases.forEach(function (c) {
    const r = say('AcornAndy', '!create ' + c[0]);
    ok(!r.ok && c[1].test(r.message), 'name "' + c[0] + '" refused', r.message);
  });
  const chk = SD.runners.checkName(S(), "  Thistle   O'Hare ");
  ok(chk.ok && chk.name === "Thistle O'Hare", 'spaces are collapsed, apostrophes allowed');
  ok(SD.runners.checkName(S(), 'Zoë Dash').ok, 'accented letters allowed (with 3+ plain letters)');
  ok(SD.runners.checkName(S(), 'R2 D2 Go').ok, 'digits allowed');
})();

// =============================================================================
section('create: success');
// =============================================================================
(function () {
  const before = S().runners.length;
  const spawned = [];
  const off = SD.bus.on(SD.EVENTS.RUNNER_SPAWNED, function (p) { spawned.push(p); });
  const r = say('AcornAndy', '!create Pebble Dash');
  off();
  ok(r.ok, '!create Pebble Dash', r.message);
  eq(S().runners.length, before + 1, 'one runner more');
  const rn = S().runners[S().runners.length - 1];
  eq(rn.name, 'Pebble Dash', 'with the chosen name');
  ok(rn.custom === true && !rn.rosterKey, 'custom:true');
  eq(SD.runners.statTotal(rn), SD.CONFIG.PROGRESSION.STAT_TOTAL, 'stats sum to 200');
  const sp = SD.DATA.SPECIES[rn.speciesId];
  ok(sp && sp.styles.indexOf(rn.style) >= 0 && rn.emoji === sp.emoji, 'a random species template and a style that species runs', rn.speciesId + ' ' + rn.style);
  ok(SD.DATA.STYLE_ABILITIES[rn.style].indexOf(rn.ability.id) >= 0 && !!SD.DATA.ABILITIES[rn.ability.id], 'a style-suited ability from the catalog', rn.ability.id);
  eq(rn.owner, 'AcornAndy', 'claimed by the creator');
  eq(S().players.acornandy.runnerId, rn.id, 'player.runnerId points at it');
  ok(spawned.length === 1 && spawned[0].by === 'acornandy' && spawned[0].runner.id === rn.id, 'runner:spawned { runner, by }');
  ok(S().players.acornandy.achievements.indexOf('creator') >= 0, 'Creator achievement unlocked');
  has(r.message, '✨ AcornAndy created ' + rn.emoji + ' Pebble Dash, a ' + rn.species + ' ' + SD.runners.styleName(rn.style) + '!', 'the reply announces the runner');
  has(r.message, 'SPD ' + rn.stats.speed + ' STA ' + rn.stats.stamina, 'the reply has the card summary (stats)');
  has(r.message, 'Ability: ' + rn.ability.name, 'and the ability');
  has(r.message, 'Achievements: Creator (+25 SP)', 'and the achievement');
  ok(r.message.length <= 300, 'a chat-sized reply', r.message.length);
  ok(S().log.some(function (e) { return /A new runner joins the derby: .*Pebble Dash.*created by AcornAndy/.test(e.text); }), 'logged with the creator');
  const insp = say('FoxFan', '!inspect pebble');
  ok(insp.ok && /Pebble Dash/.test(insp.message) && /Owner: AcornAndy/.test(insp.message), '!inspect finds it by a short name');
  const t = say('AcornAndy', '!train speed');
  ok(t.ok && /Pebble Dash/.test(t.message), 'the creator can train it');

  const dup = say('LateLu', '!join') && say('LateLu', '!create pebble DASH');
  ok(!dup.ok && /already a runner called Pebble Dash/.test(dup.message), 'the name is now taken (case-insensitive)', dup.message);
  const second = say('LateLu', "!create Thistle O'Hare");
  ok(second.ok, 'another viewer creates another runner', second.message);
  const again = say('LateLu', '!create Clover Zoom');
  ok(!again.ok && /One runner per viewer/.test(again.message), 'one runner per viewer', again.message);
  eq(S().players.latelu.achievements.filter(function (x) { return x === 'creator'; }).length, 1, 'Creator once per viewer');

  // The created runner races: make it one of the few rested runners.
  S().runners.forEach(function (x) { if (x.id !== rn.id && ['r01', 'r02', 'r03'].indexOf(x.id) < 0) x.energy = 0; });
  const race = SD.game.startRace({ distance: 1200 });
  ok(race.ok && race.record.entrants.some(function (e) { return e.runnerId === rn.id; }), 'the created runner makes the field', race.message);
  SD.game.endRace();
  ok(SD.state.runnerById(rn.id).record.races === 1, 'and finishes a race');
  const lock = SD.game.startRace();
  if (lock.ok) {
    const lr = say('Nobody1', '!join') && say('Nobody1', '!create Lichen Leap');
    ok(!lr.ok && /a race is running/.test(lr.message), '!create is locked during a race', lr.message);
    SD.game.abortRace();
  } else {
    ok(true, '(no second race today)');
  }
})();

// =============================================================================
section('spawn: admin SPAWN RUNNER and MAX_ACTIVE');
// =============================================================================
(function () {
  fresh();
  const spawned = [];
  const off = SD.bus.on(SD.EVENTS.RUNNER_SPAWNED, function (p) { spawned.push(p); });
  const a = SD.game.spawnRunner({ name: 'Moss Runner' });
  const b = SD.game.spawnRunner({});
  off();
  eq(a.name, 'Moss Runner 2', 'SPAWN RUNNER makes names unique');
  ok(a.custom && b.custom && b.name && SD.runners.statTotal(b) === 200, 'random name, custom, stats sum to 200');
  ok(spawned.every(function (p) { return p.by === null; }), 'admin spawns carry no creator (no Creator achievement)');
  const max = R.MAX_ACTIVE;
  let guard = 0;
  while (SD.state.activeRunners().length < max && guard++ < 100) SD.game.spawnRunner({});
  eq(SD.state.activeRunners().length, max, 'spawning up to MAX_ACTIVE (' + max + ')');
  const full = SD.game.spawnRunner({ name: 'One Too Many' });
  ok(full && full.ok === false && /The paddock is full: 24 runners already/.test(full.message), 'SPAWN RUNNER beyond the cap is refused with a readable message', full && full.message);
  eq(SD.state.activeRunners().length, max, 'nothing spawned');
  note('the paddock holds ' + max + ' runners (CONFIG.RUNNERS.MAX_ACTIVE) and every one has an owner');
  claimAll();
  say('LateLu', '!join');
  const r = say('LateLu', '!create Lichen Leap');
  ok(!r.ok && /The paddock is full \(24 runners\)/.test(r.message), '!create beyond the cap is refused', r.message);
  const preview = SD.game.previewField(10);
  ok(preview.length === 10, 'a 24-runner roster still races (field of 10)');
})();

// =============================================================================
section('help / list');
// =============================================================================
(function () {
  const d = SD.commands.get('create');
  ok(d && d.requiresPlayer && d.lockedDuringRace && d.minArgs === 1, '!create is registered, needs a player, is race-locked');
  const h = say('FoxFan', '!help create');
  ok(h.ok && /!create <name>/.test(h.message) && /every runner already has an owner/.test(h.message), '!help create explains it', h.message);
  ok(say('FoxFan', '!help').message.indexOf('!claim, !create, !train') >= 0, '!help lists !create next to !claim');
})();

// =============================================================================
section('SD.debug');
// =============================================================================
(function () {
  fresh();
  eq(SD.VERSION, '1.0.0', 'SD.VERSION is 1.0.0');
  ok(SD.debug.state() === S(), 'SD.debug.state() is the live state');
  eq(SD.debug.lastRace(), null, 'no race yet');
  eq(SD.debug.lastRaceJSON(), '', 'no race JSON yet');
  const snapshot = JSON.stringify(S());
  const a = SD.debug.simulate(12345, 2000);
  const b = SD.debug.simulate('12345', 2000);
  eq(snapshot, JSON.stringify(S()), 'simulate() does not change the game');
  ok(a.distance === 2000 && a.seed === 12345 && a.hash === b.hash, 'simulate(seed, distance) is deterministic', a.hash + ' / ' + b.hash);
  ok(SD.debug.simulate(12346, 2000).hash !== a.hash, 'another seed, another race');
  eq(SD.debug.simulate('0x3039', 2000).hash, a.hash, 'hex seeds work');
  const s = SD.game.startRace();
  ok(SD.debug.lastRace() === S().currentRace.record, 'lastRace() is the race on the track');
  const live = JSON.parse(SD.debug.lastRaceJSON());
  ok(live.status === 'countdown' && live.record.id === s.record.id && live.spiritDerby === '1.0.0' && live.engineVersion === SD.race.ENGINE_VERSION,
    'lastRaceJSON() wraps the record with version info and status');
  SD.game.endRace();
  const done = JSON.parse(SD.debug.lastRaceJSON(true));
  ok(done.status === 'finished' && done.record.hash === s.record.hash, 'after the finish it is the last finished race');
  ok(SD.debug.replay().sameHash, 'SD.debug.replay() re-simulates to the same hash');
  const logs = [];
  const realLog = console.log;
  console.log = function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); };
  try {
    ok(SD.debug.bus.wildcard(true) === true && SD.debug.bus.isOn(), 'bus.wildcard(true) turns the logger on');
    SD.bus.emit('race:frame', {});
    SD.bus.emit('test:event', { x: 1 });
    SD.debug.bus.wildcard(true, /^race:frame$/);
    SD.bus.emit('race:frame', {});
    SD.bus.emit('test:event', {});
    ok(SD.debug.bus.wildcard(false) === false && !SD.debug.bus.isOn(), 'bus.wildcard(false) turns it off');
    SD.bus.emit('test:event', {});
  } finally {
    console.log = realLog;
  }
  eq(logs.map(function (l) { return l.split(' ')[1]; }), ['test:event', 'race:frame'], 'noisy race:frame skipped by default; a filter picks events');
})();

if (TRANSCRIPT) {
  console.log('\n----- !create transcript -----');
  console.log(transcript.join('\n'));
}
console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
