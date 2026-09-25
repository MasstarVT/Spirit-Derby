#!/usr/bin/env node
/*
 * Spirit Derby - tools/fuzz-test.js (M6)
 * Headless season fuzz: a seeded rng drives 12 fictional viewers (two of them mods, plus the
 * streamer's own console) who spam random commands - every registered command and alias with
 * valid, invalid and hostile arguments, unknown runners, spam bursts, mid-race attempts, mod
 * commands from non-mods, !bet all, !create - across 3 full seasons, while races start at
 * random moments and are sometimes paused, resumed, ended or aborted through SD.game, days are
 * skipped, settings change and the clock jumps.
 *
 * After EVERY command it asserts:
 *   - no exception escaped processCommand, no handler crashed ("Something went wrong"), no
 *     console.error (the bus and the pipeline log swallowed exceptions there)
 *   - the result is well-formed ({ ok:boolean, isCommand:boolean, message:string })
 *   - the race lock held: a lockedDuringRace command (and a mod's !event change) during a race is
 *     refused, no command changed the race in progress, only a mod !race starts a race
 *   - non-mods cannot start a race or change the day event
 *   - no NaN / Infinity / function anywhere in the state (deep scan, race history excluded: every
 *     record is scanned once, ticks included, when it is recorded)
 *   - runners: 1 <= stat <= cap, 0 <= energy <= maxEnergy, maxEnergy / cap match the level,
 *     0 <= fatigue <= 120, condition matches fatigue, unique names, at most MAX_ACTIVE active
 *   - players: SP integer >= 0, stats >= 0, one runner per viewer (owner <-> runnerId agree)
 *   - at most one open bet per player, bets within limits on known runners; queued effects within caps
 *   - currentRace is null or a well-formed record in a valid status; hype within 0..max
 * After every race (and every 25 commands with no race running): the finished record is sane
 * (places 1..n, hash, no NaN), SD.persistence.save() works, and export -> import gives back an
 * identical state (only the "Save imported." log line differs).
 * Finally the game must reach Season 4. Prints a command-outcome histogram.
 *
 *   node tools/fuzz-test.js [--seed N] [--seasons 3] [--verbose]
 * Exit code 1 on any failure.
 */
'use strict';

const SD = require('./load-core.js');

const argv = process.argv.slice(2);
function argVal(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
}
const VERBOSE = argv.indexOf('--verbose') >= 0;
const SEED = Number(argVal('--seed', 20260924)) >>> 0;
const SEASONS = Math.max(1, Number(argVal('--seasons', 3)) | 0);
const TARGET_SEASON = SEASONS + 1;
const MAX_STEPS = 200000;

// -----------------------------------------------------------------------------
// Assertions (same PASS / FAIL / "OK: n passed" shape as the other suites)
// -----------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failureKinds = {};   // kind -> { count, first:[details] }
function ok(cond, kind, detail) {
  if (cond) { passed++; return true; }
  failed++;
  const f = failureKinds[kind] || (failureKinds[kind] = { count: 0, first: [] });
  f.count++;
  if (f.first.length < 5) f.first.push(detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  if (f.count <= 3) console.log('  FAIL ' + kind + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) + ')' : ''));
  return false;
}

// console.error is where swallowed exceptions end up (bus listeners, the command pipeline).
const consoleErrors = [];
const realError = console.error;
console.error = function () {
  consoleErrors.push(Array.prototype.map.call(arguments, function (a) { return a && a.stack ? a.stack.split('\n').slice(0, 3).join(' | ') : String(a); }).join(' '));
  if (VERBOSE) realError.apply(console, arguments);
};

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------
let NOW = 1767225600000; // 2026-01-01
SD.clock.set(function () { return NOW; });
function advance(ms) { NOW += Math.max(0, Math.round(ms)); }

// Keep the saves small and fast: 3 full race logs, and no automatic save on every mutation
// (the fuzz saves explicitly after every race and checks it worked).
SD.CONFIG.HISTORY_FULL_LOGS = 3;
SD.persistence.setAutoSave(false);

const rng = SD.rng.create(SEED);            // the fuzz's own choices (the game has its own seeds)
// SP ledger: within a season every player's balance = balance at season start + SP earned - SP spent
// (refunds lower spSpentTotal). The baseline is taken when a season starts (and is 0 for new players).
const spBase = {};
SD.bus.on(SD.EVENTS.SEASON_STARTED, function () {
  const st = SD.state.get();
  Object.keys(st.players).forEach(function (k) { spBase[k] = st.players[k].spiritPoints; });
});
SD.state.set(SD.state.create({ seedSalt: SEED ^ 0x5bd1e995 }));
SD.game.init();
SD.achievements.init();
function S() { return SD.state.get(); }

const VIEWERS = [
  { name: 'FoxFan' }, { name: 'MothMom' }, { name: 'AcornAndy' }, { name: 'WispWatcher' },
  { name: 'BrambleBob' }, { name: 'LanternLiz', isMod: true }, { name: 'Raid_Rick' }, { name: 'xX_Owl_Xx' },
  { name: 'Zoë_Ümlaut' }, { name: '@AtSign' }, { name: 'Spam Sam' }, { name: 'ModMaya', isMod: true }
];
const STREAMER = { name: 'Streamer', admin: true };
const SOURCES = ['twitch', 'twitch', 'twitch', 'bridge', 'sim'];

function pick(arr) { return arr[rng.int(arr.length)]; }
function chance(p) { return rng.float() < p; }
function weighted(items) { return rng.weighted(items, function (x) { return x[0]; })[1]; }

// -----------------------------------------------------------------------------
// Argument generators (valid, invalid and hostile)
// -----------------------------------------------------------------------------
const STAT_WORDS = ['speed', 'stamina', 'power', 'wisdom', 'luck', 'spd', 'STA', 'pow', 'wis', 'luk', 'fast', 'smart',
  'charisma', 'SPEED!!', '', '123', 'speedy'];
const AMOUNTS = ['10', '50', '100', '250', '251', '9', '0', '-5', 'all', 'ALL', 'max', 'all-in', '1e3', '12.5', '99999999999999999999',
  'abc', '25sp', '0x10', '249', '75'];
const COLOURS = ['gold', 'teal', 'crimson', 'lilac', '#ff00aa', '#abc', 'off', 'none', 'purpleish', '#12345', '#GGGGGG', 'Gold', ''];
const EVENT_WORDS = ['harvest', 'fog', 'cryptid', 'clear', 'today', 'status', 'xyz', 'moon', 'F', ''];
const LB_WORDS = ['wins', 'xp', 'sp', 'part', 'victories', 'hype', 'all', 'season', 'lifetime', 'foo', 'points', 'wins-player'];
const JUNK = ['', ' ', '@', '@@@', '💥', 'null', 'undefined', 'NaN', 'Infinity', '__proto__', 'constructor', 'toString',
  '<script>', '"quotes"', "it's", 'a'.repeat(60), '​', 'r999', 'r01', 'r1'];
const CREATE_NAMES = ['Pebble Dash', "Thistle O'Hare", 'Clover Zoom', 'Dusk Hopper', 'Fen Glimmer', 'Rowan Streak', 'Mossy', 'ab',
  'Way Too Long Runner Name Here', '🦊🦊🦊', 'all', 'r05', 'Moss', 'Moss Runner', 'moss runner', 'Glow', 'Zoë Dash', 'Ünïcode Ok',
  '  spaced   out  ', "O'Brien 2", 'Cinder Bolt', 'Lichen Leap', 'Juniper Jet', 'Sorrel Sprint', 'Bracken Blur', 'X1Y2Z3'];

function runnerArg() {
  const st = S();
  const rs = st.runners;
  const r = pick(rs);
  return weighted([
    [5, r.name], [6, r.name.split(' ')[0].toLowerCase()], [2, r.name.toUpperCase().replace(/\s+/g, '')], [2, r.id],
    [2, '@' + r.name.split(' ')[0]], [1, r.name.slice(0, 2)], [2, pick(['Nobody', 'x', 'moss runner runner', 'glow wisp 2', 'm', 'the'])],
    [1, pick(JUNK)]
  ]);
}
function viewerArg() {
  return weighted([[5, pick(VIEWERS).name], [1, 'Streamer'], [2, pick(['nobody', '@', 'Zoe', 'spam', 'mothmom'])], [1, pick(JUNK)]]);
}

// A chat line for `v`. Mostly real commands, some aliases, unknown commands and plain chat.
function lineFor(v) {
  const st = S();
  const p = SD.state.player(SD.players.keyOf(v.name));
  const mine = p ? SD.players.runnerOf(st, p.username) : null;
  const free = SD.players.freeRunners(st);
  if (!p && chance(0.7)) return '!join';
  if (p && !mine && !free.length && chance(0.6)) {
    return '!create ' + (chance(0.7) ? pick(SD.DATA.NAME_PARTS.first) + ' ' + pick(['Dash', 'Zoom', 'Leap', 'Jet', 'Blur', 'Sprint']) + (chance(0.3) ? ' ' + rng.int(99) : '')
      : pick(CREATE_NAMES));
  }
  if (p && !mine && free.length && chance(0.3)) return chance(0.5) ? '!claim' : '!claim ' + runnerArg();
  const cmd = weighted([
    [3, 'join'], [6, 'claim'], [4, 'create'], [16, 'train'], [6, 'rest'], [14, 'cheer'], [4, 'status'], [4, 'inspect'],
    [5, 'race'], [4, 'event'], [3, 'help'], [4, 'leaderboard'], [2, 'rank'], [12, 'bet'], [3, 'bets'], [3, 'odds'],
    [5, 'boost'], [5, 'snack'], [4, 'sabotage'], [3, 'ribbon'], [2, 'hype'], [2, 'achievements'],
    [4, 'alias'], [3, 'unknown'], [3, 'chat']
  ]);
  switch (cmd) {
    case 'join': return '!join' + (chance(0.1) ? ' ' + pick(JUNK) : '');
    case 'claim': return '!claim' + (chance(0.7) ? ' ' + runnerArg() : '');
    case 'create': return '!create' + (chance(0.9) ? ' ' + pick(CREATE_NAMES) : '');
    case 'train': return weighted([
      [5, '!train ' + pick(STAT_WORDS)], [4, '!train ' + runnerArg() + ' ' + pick(STAT_WORDS)], [2, '!t ' + pick(STAT_WORDS) + ' ' + runnerArg()],
      [1, '!train'], [1, '!train ' + runnerArg()], [1, '!train ' + pick(JUNK) + ' ' + pick(JUNK)]]);
    case 'rest': return pick(['!rest', '!r', '!rest ' + runnerArg(), '!r ' + pick(JUNK)]);
    case 'cheer': return pick(['!cheer', '!c', '!cheer ' + runnerArg(), '!c ' + runnerArg(), '!cheer ' + pick(JUNK)]);
    case 'status': return pick(['!status', '!stats', '!status ' + pick(JUNK)]);
    case 'inspect': return pick(['!inspect ' + runnerArg(), '!i ' + runnerArg(), '!inspect', '!i ' + pick(JUNK)]);
    case 'race': return pick(['!race', '!race 2000', '!race 2400m', '!race status', '!race 999', '!race ' + pick(JUNK), '!race 1600']);
    case 'event': return pick(['!event', '!event today', '!event ' + pick(EVENT_WORDS), '!event ' + pick(JUNK)]);
    case 'help': return pick(['!help', '!h', '!commands', '!help train', '!help !bet', '!help create', '!help ' + pick(JUNK), '!help race']);
    case 'leaderboard': return pick(['!lb', '!top', '!leaderboard', '!lb ' + pick(LB_WORDS), '!lb ' + pick(LB_WORDS) + ' ' + pick(LB_WORDS), '!top ' + pick(JUNK)]);
    case 'rank': return pick(['!rank', '!rank ' + viewerArg()]);
    case 'bet': return weighted([
      [5, '!bet ' + runnerArg() + ' ' + pick(AMOUNTS)], [3, '!bet ' + pick(AMOUNTS) + ' ' + runnerArg()], [3, '!bet ' + runnerArg() + ' all'],
      [1, '!bet all ' + runnerArg()], [2, '!bet ' + pick(AMOUNTS)], [1, '!bet'], [2, '!bet cancel'], [1, '!bet ' + pick(JUNK) + ' ' + pick(JUNK)]]);
    case 'bets': return '!bets';
    case 'odds': return '!odds' + (chance(0.1) ? ' ' + pick(JUNK) : '');
    case 'boost': return pick(['!boost ' + runnerArg(), '!boost', '!boost ' + pick(JUNK)]);
    case 'snack': return pick(['!snack ' + runnerArg(), '!snack', '!snack ' + pick(JUNK)]);
    case 'sabotage': return pick(['!sabotage ' + runnerArg(), '!sabotage', '!sabotage ' + pick(JUNK)]);
    case 'ribbon': return '!ribbon' + (chance(0.9) ? ' ' + pick(COLOURS) : '');
    case 'hype': return '!hype';
    case 'achievements': return pick(['!achievements', '!ach', '!badges ' + viewerArg()]);
    case 'alias': return pick(['!T speed', '!LB wins all', '!Stats', '!R', '!C moss', '!I glow', '!H', '!Commands', '!TOP xp', '!ACH']);
    case 'unknown': return pick(['!discord', '!so @someone', '!xyz', '!', '!!', '!123', '!train_', '!bet_', '!créer', '!' + 'z'.repeat(40)]);
    default: return pick(['LET\'S GOOO', 'no way', 'who fed the boar', '   ', '!', 'moss moss moss', '@FoxFan hi', 'mushroom rings are OP']);
  }
}

// -----------------------------------------------------------------------------
// Invariant checks
// -----------------------------------------------------------------------------
function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

// NaN / Infinity / functions / undefined array slots anywhere (returns the first bad path).
function scan(value, path, skip, seen) {
  seen = seen || new Set();
  const t = typeof value;
  if (t === 'number') return isFinite(value) ? null : path + ' = ' + value;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return path + ' is a ' + t;
  if (value === null || t !== 'object') return null;
  if (seen.has(value)) return path + ' is a cycle';
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (value[i] === undefined) return path + '[' + i + '] is undefined';
      const r = scan(value[i], path + '[' + i + ']', skip, seen);
      if (r) return r;
    }
  } else {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (skip && skip[path + '.' + k]) continue;
      const r = scan(value[k], path + '.' + k, skip, seen);
      if (r) return r;
    }
  }
  seen.delete(value);
  return null;
}

function checkRecord(rec, where) {
  if (!ok(isObj(rec) && rec.id && Array.isArray(rec.entrants) && Array.isArray(rec.results), 'record: well-formed', where)) return;
  ok(rec.entrants.length >= 1 && rec.entrants.length <= SD.CONFIG.RACE.MAX_RUNNERS, 'record: entrant count', where + ' ' + rec.entrants.length);
  ok(rec.results.length === rec.entrants.length, 'record: one result per entrant', where);
  const places = rec.results.map(function (r) { return r.place; }).sort(function (a, b) { return a - b; });
  ok(places.every(function (p, i) { return p === i + 1; }), 'record: places 1..n', where + ' ' + places.join(','));
  ok(typeof rec.hash === 'string' && /^[0-9a-f]{8}$/.test(rec.hash), 'record: hash', where + ' ' + rec.hash);
  const bad = scan(rec, 'record');
  ok(!bad, 'record: no NaN / Infinity', where + ' ' + bad);
}

function checkCurrentRace(st, where) {
  const cr = st.currentRace;
  if (cr === null) return;
  ok(isObj(cr) && isObj(cr.record) && /^(countdown|running|paused|finished)$/.test(cr.status) && typeof cr.startedAt === 'number' &&
    cr.record.id && Array.isArray(cr.record.entrants) && cr.record.entrants.length >= 1 && Array.isArray(cr.record.results) &&
    cr.record.results.length === cr.record.entrants.length, 'currentRace: null or a well-formed record', where);
}

const STATE_SKIP = { 'state.raceHistory': true };

function checkState(where) {
  const st = S();
  const C = SD.CONFIG;
  const bad = scan(st, 'state', STATE_SKIP);
  if (!ok(!bad, 'state: no NaN / Infinity / functions (deep scan)', where + ' ' + bad)) return;
  checkCurrentRace(st, where);
  ok(st.hype.value >= 0 && st.hype.value <= st.hype.max, 'hype: within 0..max', where + ' ' + st.hype.value);

  // runners
  const names = {};
  let active = 0;
  const owners = {};
  st.runners.forEach(function (r) {
    const cap = SD.runners.statCap(r.level);
    const statsOk = C.STATS.every(function (k) { return Number.isInteger(r.stats[k]) && r.stats[k] >= 1 && r.stats[k] <= cap; });
    ok(statsOk, 'runner: 1 <= stat <= cap (integers)', where + ' ' + r.name + ' ' + JSON.stringify(r.stats) + ' cap ' + cap);
    ok(r.level >= 1 && r.level <= C.PROGRESSION.MAX_LEVEL && Number.isInteger(r.level), 'runner: level 1..20', where + ' ' + r.name + ' ' + r.level);
    ok(r.maxEnergy === SD.runners.energyMax(r.level), 'runner: maxEnergy matches level', where + ' ' + r.name);
    ok(r.energy >= 0 && r.energy <= r.maxEnergy, 'runner: 0 <= energy <= maxEnergy', where + ' ' + r.name + ' ' + r.energy + '/' + r.maxEnergy);
    ok(r.fatigue >= 0 && r.fatigue <= C.CONDITION.MAX_FATIGUE, 'runner: 0 <= fatigue <= 120', where + ' ' + r.name + ' ' + r.fatigue);
    ok(r.condition === SD.runners.conditionOf(r.fatigue), 'runner: condition matches fatigue', where + ' ' + r.name);
    ok(r.xp >= 0 && r.totalXp >= 0, 'runner: xp >= 0', where + ' ' + r.name);
    ok(!!SD.DATA.MOODS[r.mood] && !!SD.DATA.STYLES[r.style], 'runner: valid mood + style', where + ' ' + r.name);
    const k = SD.util.nameKey(r.name);
    ok(!names[k], 'runner: unique names', where + ' ' + r.name);
    names[k] = true;
    if (!r.retired) active++;
    if (r.owner) {
      const ok2 = SD.players.keyOf(r.owner);
      ok(!owners[ok2], 'players: one runner per viewer', where + ' ' + r.owner + ' owns ' + (owners[ok2] || '') + ' and ' + r.name);
      owners[ok2] = r.name;
      const p = st.players[ok2];
      if (p) ok(p.runnerId === r.id, 'players: runner.owner <-> player.runnerId agree', where + ' ' + r.name + ' owner ' + r.owner + ' runnerId ' + p.runnerId);
    }
  });
  ok(active <= C.RUNNERS.MAX_ACTIVE, 'runners: at most MAX_ACTIVE active', where + ' ' + active);

  // players
  Object.keys(st.players).forEach(function (k) {
    const p = st.players[k];
    ok(p.username === k, 'players: keyed by username', where + ' ' + k);
    ok(Number.isInteger(p.spiritPoints) && p.spiritPoints >= 0, 'players: SP is an integer >= 0', where + ' ' + k + ' ' + p.spiritPoints);
    ok(SD.players.STAT_KEYS.every(function (s) { return p.stats[s] >= 0 && p.lifetime[s] >= 0; }), 'players: stats >= 0', where + ' ' + k);
    const expect = (spBase[k] || 0) + p.stats.spEarnedTotal - p.stats.spSpentTotal;
    ok(p.spiritPoints === expect, 'players: SP ledger (start + earned - spent = balance)', where + ' ' + k + ' balance ' + p.spiritPoints + ' expected ' + expect +
      ' (start ' + (spBase[k] || 0) + ', earned ' + p.stats.spEarnedTotal + ', spent ' + p.stats.spSpentTotal + ')');
  });

  // bets
  const betBy = {};
  st.bets.forEach(function (b) {
    ok(!betBy[b.username], 'bets: at most one open bet per player', where + ' ' + b.username);
    betBy[b.username] = true;
    ok(!!st.players[b.username], 'bets: placed by a known player', where + ' ' + b.username);
    ok(!!SD.state.runnerById(b.runnerId, st), 'bets: on a known runner', where + ' ' + b.runnerId);
    ok(Number.isInteger(b.amount) && b.amount >= C.ECONOMY.BET_MIN && b.amount <= C.ECONOMY.BET_MAX, 'bets: amount within limits', where + ' ' + b.amount);
    ok(b.odds >= C.RACE.ODDS.MIN && b.odds <= C.RACE.ODDS.MAX, 'bets: odds within limits', where + ' ' + b.odds);
  });

  // day structure, ids, achievements
  ok(st.season.raceIndexInDay >= 0 && st.season.raceIndexInDay <= st.season.racesPerDay && st.season.day >= 1 && st.season.day <= st.season.daysPerSeason,
    'season: day and race slot within bounds', where + ' day ' + st.season.day + ' race ' + st.season.raceIndexInDay);
  const ids = {};
  st.runners.forEach(function (r) { ok(!ids[r.id], 'runners: unique ids', where + ' ' + r.id); ids[r.id] = true; });
  const ach = {};
  st.achievements.unlocked.forEach(function (a) {
    const k = a.username + ':' + a.id;
    ok(!ach[k], 'achievements: unlocked once per viewer', where + ' ' + k);
    ach[k] = true;
    const p = st.players[a.username];
    ok(!!p && p.achievements.indexOf(a.id) >= 0, 'achievements: listed on the player', where + ' ' + k);
  });
  if (st.currentRace && SD.state.isRaceLocked(st)) {
    ok(st.bets.every(function (b) { return b.recordId === st.currentRace.record.id; }), 'bets: every open bet is locked into the running race', where);
  }

  // queued chat effects
  const boosts = {}, sabs = {};
  let sabTotal = 0;
  st.raceEffects.forEach(function (e) {
    ok(isObj(e) && /^(boost|sabotage|cheer)$/.test(e.type) && !!SD.state.runnerById(e.runnerId, st) && e.count >= 1, 'raceEffects: well-formed', where + ' ' + JSON.stringify(e));
    if (e.type === 'boost') boosts[e.runnerId] = (boosts[e.runnerId] || 0) + e.count;
    if (e.type === 'sabotage') { sabs[e.runnerId] = (sabs[e.runnerId] || 0) + e.count; sabTotal += e.count; }
  });
  const CH = C.RACE.CHAT;
  ok(Object.keys(boosts).every(function (id) { return boosts[id] <= CH.MAX_BOOSTS_PER_RUNNER; }), 'raceEffects: boost cap per runner', where);
  ok(Object.keys(sabs).every(function (id) { return sabs[id] <= CH.MAX_SABOTAGE_PER_TARGET; }), 'raceEffects: sabotage cap per target', where);
  ok(sabTotal <= CH.MAX_SABOTAGE_PER_RACE, 'raceEffects: sabotage cap per race', where + ' ' + sabTotal);
}

// First differing path between two JSON values.
function diff(a, b, path) {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return path + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
  if (Array.isArray(a) !== Array.isArray(b)) return path + ': array vs object';
  if (Array.isArray(a)) {
    if (a.length !== b.length) return path + '.length: ' + a.length + ' vs ' + b.length;
    for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], path + '[' + i + ']'); if (d) return d; }
    return null;
  }
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join('|') !== kb.join('|')) return path + ' keys: ' + ka.filter(function (k) { return kb.indexOf(k) < 0; }).concat(['/']).concat(kb.filter(function (k) { return ka.indexOf(k) < 0; })).join(',');
  for (let i = 0; i < ka.length; i++) { const d = diff(a[ka[i]], b[ka[i]], path + '.' + ka[i]); if (d) return d; }
  return null;
}

// Read models the UI and chat use: every board in both scopes, rankOf, format, the season summary,
// the next field's odds, runner one-liners, SD.debug.simulate. Nothing may throw or produce NaN.
let readChecks = 0;
function checkReadModels(where) {
  const st = S();
  try {
    SD.leaderboards.CATEGORIES.forEach(function (c) {
      ['season', 'all'].forEach(function (scope) {
        const top = SD.leaderboards.top(st, c.id, 10, scope);
        ok(top.every(function (e) { return isFinite(e.value) && e.rank >= 1; }), 'boards: finite values and ranks', where + ' ' + c.id + ' ' + scope);
        const line = SD.leaderboards.format(st, c.id, 3, scope);
        ok(typeof line === 'string' && line.length > 0 && !/NaN|undefined/.test(line), 'boards: format() line', where + ' ' + line);
      });
    });
    Object.keys(st.players).slice(0, 4).forEach(function (k) { SD.leaderboards.rankOf(st, 'spiritPoints', k); });
    const sum = SD.seasons.summary(st);
    ok(!scan(sum, 'summary'), 'seasons: summary() has no NaN', where + ' ' + scan(sum, 'summary'));
    const fo = SD.betting.fieldOdds(st);
    ok(fo.entrants.every(function (e) { return e.odds >= SD.CONFIG.RACE.ODDS.MIN && e.odds <= SD.CONFIG.RACE.ODDS.MAX && e.winProb > 0 && e.winProb < 1; }),
      'betting: next-field odds within limits', where);
    const pSum = fo.entrants.reduce(function (a, e) { return a + e.winProb; }, 0);
    ok(!fo.entrants.length || Math.abs(pSum - 1) < 0.0005 * fo.entrants.length, 'betting: win probabilities sum to 1 (4-decimal rounding)', where + ' ' + pSum);
    st.runners.forEach(function (r) { const d = SD.runners.describe(r); ok(!/NaN|undefined/.test(d), 'runners: describe() line', where + ' ' + d); });
    if (chance(0.1) && fo.field.length >= 2) {
      const rec = SD.debug.simulate(rng.int(1e9), pick(SD.CONFIG.RACE.DISTANCES));
      checkRecord(rec, where + ' SD.debug.simulate');
    }
    readChecks++;
  } catch (e) {
    ok(false, 'read models: nothing throws', where + ' ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  }
}

let roundTrips = 0;
function roundTrip(where) {
  if (S().currentRace) return;
  let json;
  try { json = SD.persistence.exportJSON(); } catch (e) { ok(false, 'persistence: state is JSON-serialisable', where + ' ' + e.message); return; }
  const before = JSON.parse(json);
  const res = SD.persistence.importJSON(json);
  if (!ok(res && res.ok, 'persistence: import of an export succeeds', where + ' ' + (res && res.error))) return;
  const after = JSON.parse(SD.persistence.exportJSON());
  const last = after.log[after.log.length - 1];
  ok(last && last.text === 'Save imported.', 'persistence: import adds one log line', where);
  delete before.log; delete after.log;
  delete before.meta.updatedAt; delete after.meta.updatedAt;
  const d = diff(before, after, 'state');
  ok(!d, 'persistence: export -> import gives back the same state', where + ' ' + d);
  roundTrips++;
}

// -----------------------------------------------------------------------------
// Command runner + histogram
// -----------------------------------------------------------------------------
const hist = {};   // command -> { ok, refused, cooldown, locked, unknown, total }
function tally(res) {
  const name = !res.isCommand ? '(chat)' : (res.unknown ? '(unknown)' : res.command);
  const h = hist[name] || (hist[name] = { total: 0, ok: 0, refused: 0, cooldown: 0, locked: 0, unknown: 0 });
  h.total++;
  if (!res.isCommand) h.ok++;
  else if (res.unknown) h.unknown++;
  else if (res.ok) h.ok++;
  else if (res.cooldown) h.cooldown++;
  else if (res.locked) h.locked++;
  else h.refused++;
}

let commandsRun = 0;
let lockedAttempts = 0;
let createdOk = 0;
function send(v, text) {
  const st = S();
  const lockedBefore = SD.state.isRaceLocked(st);
  const raceBefore = st.currentRace ? st.currentRace.record.id + ':' + st.currentRace.status : null;
  const dayEventBefore = st.season.activeDayEvent;
  const errsBefore = consoleErrors.length;
  const source = v.admin ? 'admin' : pick(SOURCES);
  const isMod = !!v.isMod || !!v.admin;
  const parsed = SD.commands.parse(text);
  const def = parsed ? SD.commands.get(parsed.name) : null;
  let res;
  try {
    res = SD.processCommand(v.name, text, { source: source, isMod: isMod, displayName: v.name });
  } catch (e) {
    ok(false, 'pipeline: no exception escapes processCommand', text + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    return null;
  }
  commandsRun++;
  const where = '#' + commandsRun + ' @' + v.name + ' "' + text.slice(0, 60) + '"';
  if (!ok(res && typeof res.ok === 'boolean' && typeof res.isCommand === 'boolean' && typeof res.message === 'string', 'pipeline: well-formed result', where)) return res;
  tally(res);
  ok(!/Something went wrong/.test(res.message), 'pipeline: no handler crashed', where + ' -> ' + res.message);
  ok(consoleErrors.length === errsBefore, 'pipeline: no console.error', where + ' -> ' + consoleErrors.slice(errsBefore).join(' || ').slice(0, 300));
  if (def && def.name === 'create' && res.ok) createdOk++;

  // race lock
  const after = S();
  const raceAfter = after.currentRace ? after.currentRace.record.id + ':' + after.currentRace.status : null;
  if (lockedBefore && def && def.lockedDuringRace) {
    lockedAttempts++;
    ok(!res.ok, 'race lock: locked commands are refused during a race', where + ' -> ' + res.message);
  }
  const modEventChange = def && def.name === 'event' && isMod && !(parsed.args.length && /^(today|status|info|now|\?)$/i.test(parsed.args[0]));
  if (lockedBefore && modEventChange) ok(!res.ok, 'race lock: a mod cannot change the day event during a race', where + ' -> ' + res.message);
  if (raceBefore) {
    ok(raceAfter === raceBefore, 'race lock: commands never change the race in progress', where + ' ' + raceBefore + ' -> ' + raceAfter);
  } else if (raceAfter) {
    ok(def && def.name === 'race' && isMod && res.ok, 'race: only a mod !race starts a race', where + ' -> ' + raceAfter);
  }
  if (!isMod && def && def.name === 'event') ok(after.season.activeDayEvent === dayEventBefore, 'permissions: non-mods cannot change the day event', where);
  if (!isMod && def && def.name === 'race') ok(!raceAfter || raceBefore, 'permissions: non-mods cannot start a race', where);
  checkState(where);
  return res;
}

// -----------------------------------------------------------------------------
// Director actions
// -----------------------------------------------------------------------------
let racesFinished = 0, racesAborted = 0, raceStartFails = 0, pauses = 0, nextDays = 0, settingsChanges = 0, spawns = 0;
let lastHistoryLen = 0;

function afterRace(where) {
  const st = S();
  const h = st.raceHistory;
  if (h.length !== lastHistoryLen || (h.length && h[h.length - 1].id !== (afterRace.lastId || null))) {
    const rec = h[h.length - 1];
    if (rec) { checkRecord(rec, where); afterRace.lastId = rec.id; }
  }
  lastHistoryLen = h.length;
  // Season records of every runner = what the race history says (finishRace bookkeeping + season reset).
  const season = st.season.number;
  const recs = h.filter(function (rec) { return rec.season === season; });
  ok(recs.length === st.season.racesRun, 'history: season.racesRun = races recorded this season', where + ' ' + recs.length + ' vs ' + st.season.racesRun);
  const seenRec = {};
  h.forEach(function (rec) { ok(!seenRec[rec.id], 'history: unique race ids', where + ' ' + rec.id); seenRec[rec.id] = true; });
  st.runners.forEach(function (r) {
    let races = 0, wins = 0, podiums = 0;
    recs.forEach(function (rec) {
      const res = rec.results.filter(function (x) { return x.runnerId === r.id; })[0];
      if (res) { races++; if (res.place === 1) wins++; if (res.place <= 3) podiums++; }
    });
    ok(r.record.races === races && r.record.wins === wins && r.record.podiums === podiums, 'history: runner season record matches the race history',
      where + ' ' + r.name + ' ' + JSON.stringify([r.record.races, r.record.wins, r.record.podiums]) + ' vs ' + JSON.stringify([races, wins, podiums]));
    let all = 0;
    h.forEach(function (rec) { if (rec.results.some(function (x) { return x.runnerId === r.id; })) all++; });
    ok(r.lifetime.races === all, 'history: runner lifetime races match the race history', where + ' ' + r.name + ' ' + r.lifetime.races + ' vs ' + all);
  });
  const saved = SD.persistence.save();
  ok(saved === true, 'persistence: save() works', where + ' ' + (SD.persistence.lastError() && SD.persistence.lastError().message));
  const stt = SD.persistence.stats();
  ok(stt.bytes > 0 && stt.races === st.raceHistory.length && stt.players === Object.keys(st.players).length, 'persistence: stats() match the state', where + ' ' + JSON.stringify(stt));
  checkState(where);
  roundTrip(where);
}

// "Reload the page": flush the save, load it back like main.js does, re-init the director. A race
// in progress is interrupted: its bets are refunded and its paid chat effects go back in the queue.
let reloads = 0, reloadsMidRace = 0, seasonResets = 0;
function reload(where) {
  const st = S();
  const midRace = !!st.currentRace;
  const spBefore = Object.keys(st.players).reduce(function (a, k) { return a + st.players[k].spiritPoints; }, 0);
  const staked = st.bets.reduce(function (a, b) { return a + b.amount; }, 0);
  const effects = st.raceEffects.length + (midRace && st.currentRace.record.inputs ? (st.currentRace.record.inputs.raceEffects || []).length : 0);
  ok(SD.persistence.save() === true, 'reload: save before reload', where);
  const loaded = SD.persistence.load();
  ok(loaded && loaded.fromStorage && loaded.state, 'reload: load() restores the saved game', where);
  if (!loaded || !loaded.state) return;
  SD.state.set(loaded.state);
  SD.game.init();
  const now = S();
  ok(now.currentRace === null || now.currentRace.status === 'finished', 'reload: an interrupted race is cancelled', where);
  const spAfter = Object.keys(now.players).reduce(function (a, k) { return a + now.players[k].spiritPoints; }, 0);
  ok(spAfter === spBefore + (midRace ? staked : 0) && (!midRace || now.bets.length === 0), 'reload: open bets are refunded exactly once (mid-race)',
    where + ' SP ' + spBefore + ' + staked ' + staked + ' -> ' + spAfter);
  if (midRace) ok(now.raceEffects.length === effects, 'reload: paid chat effects of the interrupted race are queued again', where + ' ' + effects + ' -> ' + now.raceEffects.length);
  reloads++;
  if (midRace) reloadsMidRace++;
  checkState(where + ' reload');
}

function director() {
  const st = S();
  const cr = st.currentRace;
  const where = 'director S' + st.season.number + 'D' + st.season.day;
  if (!cr) {
    const act = weighted([
      [10, 'start'], [72, 'none'], [1.2, 'nextDay'], [0.5, 'resetDay'], [4, 'settings'], [0.25, 'spawn'], [2, 'hype'],
      [2, 'dayEvent'], [6, 'clock'], [1, 'reload']
    ]);
    if (act === 'start') {
      const opts = {};
      if (chance(0.6)) opts.distance = pick(SD.CONFIG.RACE.DISTANCES);
      if (chance(0.3)) opts.runnerCount = 2 + rng.int(7);
      if (chance(0.05)) opts.seed = rng.int(1e9);
      const count = opts.runnerCount;
      const preview = opts.seed == null ? SD.game.previewField(count).map(function (r) { return r.id; }).join(',') : null;
      const res = SD.game.startRace(opts);
      if (res.ok && preview != null) {
        const lanes = res.record.entrants.slice().sort(function (a, b) { return a.lane - b.lane; }).map(function (e) { return e.runnerId; }).join(',');
        ok(lanes === preview, 'race: the paddock preview is the real field (same runners, same lanes)', where + ' ' + preview + ' vs ' + lanes);
      }
      if (res.ok) {
        const inField = {};
        res.record.entrants.forEach(function (e) { inField[e.runnerId] = true; });
        ok(!S().raceEffects.some(function (e) { return inField[e.runnerId]; }), 'race: queued effects of the field are consumed at the gate', where);
      }
      if (res.ok) { raceStartFails = 0; checkCurrentRace(S(), where + ' start'); checkRecord(S().currentRace.record, where + ' start'); }
      else if (++raceStartFails >= 3) { SD.game.nextDay(); nextDays++; raceStartFails = 0; }
    } else if (act === 'nextDay') {
      const res = SD.game.nextDay();
      ok(res.ok, 'director: nextDay works without a race', where + ' ' + res.message);
      nextDays++;
      checkState(where + ' nextDay');
    } else if (act === 'resetDay') {
      SD.game.resetDay();
      checkState(where + ' resetDay');
    } else if (act === 'settings') {
      const patch = pick([
        { openTraining: chance(0.7) }, { allowCreate: chance(0.75) }, { userCooldownS: pick([0, 2, 5, 10, 15]) },
        { hypeMultiplier: pick([0, 0.5, 1, 1.5, 3]) }, { runnerCount: 2 + rng.int(9) }, { distance: pick([1200, 1600, 2000, 2400, 999]) },
        { eventFrequency: pick(['none', 'low', 'normal', 'high', 'chaos', 'bogus']) }, { autoAdvanceDay: chance(0.8) },
        { debug: chance(0.5) }, { seedOverride: pick([null, 12345, 'abc']) }, { bogusKey: 1 }, { distance: 'NaN', runnerCount: 'x' },
        { twitch: { channel: '#Some_Chan!!', enabled: 'yes' } }, { bridge: { url: 'http://nope' } }, { resultsAutoCloseMs: -5 }
      ]);
      SD.game.updateSettings(patch);
      settingsChanges++;
      checkState(where + ' settings ' + JSON.stringify(patch));
    } else if (act === 'spawn') {
      const res = SD.game.spawnRunner(chance(0.5) ? { name: pick(CREATE_NAMES) } : {});
      if (res && res.id) spawns++;
      else ok(res && res.ok === false && /full/.test(res.message), 'director: spawn only refused when the paddock is full', where + ' ' + JSON.stringify(res));
      checkState(where + ' spawn');
    } else if (act === 'hype') {
      SD.game.addHype(pick([25, -10, 60, 120, -500]), 'streamer');
      checkState(where + ' hype');
    } else if (act === 'dayEvent') {
      SD.game.triggerDayEvent(chance(0.5) ? pick(SD.DATA.DAY_EVENTS).id : (chance(0.5) ? 'bogus' : undefined));
      checkState(where + ' day event');
    } else if (act === 'clock') {
      advance(pick([60000, 5 * 60000, 20 * 60000, 45 * 60000]));
      SD.game.tickClock();
      checkState(where + ' clock');
    } else if (act === 'reload') {
      reload(where);
    } else if (act === 'resetSeason') {
      const res = SD.game.resetSeason();
      ok(res.ok && res.summary && S().season.day === 1 && S().bets.length === 0, 'director: RESET SEASON archives and restarts', where + ' ' + res.message);
      seasonResets++;
      checkState(where + ' resetSeason');
    }
    // Days with autoAdvanceDay off would never end on their own.
    if (!S().currentRace && S().settings.autoAdvanceDay === false && S().season.raceIndexInDay >= S().season.racesPerDay && chance(0.3)) {
      SD.game.nextDay();
      nextDays++;
    }
    return;
  }
  // A race is on: flip countdown -> running (playback), pause / resume, reload, finish or abort.
  const act = weighted([[cr.status === 'countdown' ? 25 : 0, 'go'], [6, 'pause'], [cr.status === 'paused' ? 20 : 0, 'resume'],
    [3, 'reload'], [30, 'end'], [3, 'abort'], [30, 'none']]);
  if (act === 'go') SD.game.setRaceStatus('running');
  else if (act === 'pause' && cr.status !== 'paused') { SD.game.pauseRace(); pauses++; }
  else if (act === 'resume') SD.game.resumeRace();
  else if (act === 'reload') reload(where + ' mid-race');
  else if (act === 'end' || act === 'abort') {
    const res = act === 'end' ? SD.game.endRace() : SD.game.abortRace();
    ok(res && res.ok, 'director: end / abort works', where + ' ' + (res && res.message));
    ok(S().currentRace === null, 'director: the race is gone after end / abort', where);
    if (act === 'abort') racesAborted++; else racesFinished++;
    afterRace(where + ' after race');
  }
  checkState(where + ' race');
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------
const t0 = Date.now();
console.log('Spirit Derby fuzz test v' + SD.VERSION + ' | seed ' + SEED + ' | ' + VIEWERS.length + ' viewers | target: Season ' + TARGET_SEASON);
let steps = 0;
let sinceRoundTrip = 0;
const seasonSeen = {};
while (S().season.number < TARGET_SEASON && steps < MAX_STEPS) {
  steps++;
  const st = S();
  if (!seasonSeen[st.season.number]) { seasonSeen[st.season.number] = true; console.log('  season ' + st.season.number + ' begins at step ' + steps + ' (' + commandsRun + ' commands so far)'); }
  if (chance(S().currentRace ? 0.5 : 0.25)) director();
  const v = chance(0.04) ? STREAMER : pick(VIEWERS);
  const text = lineFor(v);
  if (chance(0.04)) {
    // spam burst: the same line 5-12 times within a second
    const n = 5 + rng.int(8);
    for (let i = 0; i < n; i++) { send(v, text); advance(50 + rng.int(100)); }
  } else {
    send(v, text);
    advance(200 + rng.int(12000));
  }
  if (++sinceRoundTrip >= 25 && !S().currentRace) { sinceRoundTrip = 0; roundTrip('periodic #' + commandsRun); checkReadModels('periodic #' + commandsRun); }
}

// Seasons above were played in full (3 races x 7 days). Admin RESET SEASON once at the end.
if (S().currentRace) SD.game.endRace();
{
  const res = SD.game.resetSeason();
  ok(res.ok && res.summary && S().season.day === 1 && S().bets.length === 0 && S().raceEffects.length === 0, 'director: RESET SEASON archives and restarts', res.message);
  seasonResets++;
  checkState('final RESET SEASON');
  roundTrip('final RESET SEASON');
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------
const st = S();
ok(steps < MAX_STEPS, 'the fuzzed game reaches Season ' + TARGET_SEASON + ' by playing', 'season ' + st.season.number + ' after ' + steps + ' steps');
ok(st.season.history.length >= SEASONS, 'season history has ' + SEASONS + ' entries', st.season.history.length);
ok(createdOk > 0, '!create succeeded at least once', createdOk);
ok(lockedAttempts > 0, 'mid-race locked commands were attempted', lockedAttempts);
ok(consoleErrors.length === 0, 'no console.error during the whole run', consoleErrors.slice(0, 3).join(' || '));

console.log('\nCommand-outcome histogram (' + commandsRun + ' commands):');
const cols = ['total', 'ok', 'refused', 'cooldown', 'locked', 'unknown'];
console.log('  ' + 'command'.padEnd(14) + cols.map(function (c) { return c.padStart(9); }).join(''));
Object.keys(hist).sort(function (a, b) { return hist[b].total - hist[a].total || (a < b ? -1 : 1); }).forEach(function (k) {
  console.log('  ' + k.padEnd(14) + cols.map(function (c) { return String(hist[k][c]).padStart(9); }).join(''));
});
console.log('\nRaces finished ' + racesFinished + ', aborted ' + racesAborted + ', pauses ' + pauses + ', manual next days ' + nextDays +
  ', settings changes ' + settingsChanges + ', admin spawns ' + spawns + ', reloads ' + reloads + ' (' + reloadsMidRace + ' mid-race), season resets ' + seasonResets + ', !create ok ' + createdOk + ', locked attempts ' + lockedAttempts +
  ', export/import round trips ' + roundTrips + ', read-model checks ' + readChecks + ', active runners ' + SD.state.activeRunners(st).length + ', players ' + Object.keys(st.players).length);
console.log('Reached Season ' + TARGET_SEASON + ' by playing after ' + steps + ' steps (' + SEASONS + ' seasons of ' + SD.CONFIG.SEASON.DAYS + ' days, ' + racesFinished + ' races finished), then RESET SEASON -> Season ' + st.season.number + '. ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

if (failed) {
  console.log('\nFailures by kind:');
  Object.keys(failureKinds).forEach(function (k) {
    console.log('  ' + failureKinds[k].count + ' x ' + k);
    failureKinds[k].first.forEach(function (d) { console.log('      ' + String(d).slice(0, 500)); });
  });
  console.log('\nFAILED: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log('\nOK: ' + passed + ' passed, ' + failed + ' failed');
