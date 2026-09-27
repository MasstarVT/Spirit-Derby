#!/usr/bin/env node
/*
 * Spirit Derby - tools/fuzz-test.js (M6)
 * Headless season fuzz: a seeded rng drives 17 fictional viewers (four of them mods, plus the
 * streamer's own console) who spam random commands - every registered command and alias with
 * valid, invalid and hostile arguments, unknown runners, spam bursts, mid-race attempts, mod
 * commands from non-mods, !bet all, !create - across 3 full seasons, while races start at
 * random moments and are sometimes paused, resumed, ended or aborted through SD.game, days are
 * skipped, settings change and the clock jumps. Review batch 10 (tools-tests#10): RESET SEASON also
 * happens mid-season, and the streamer's admin actions (settings, day event, clock + tickClock, spawn,
 * hype, a refused RESET SEASON / NEXT DAY, EXPORT -> IMPORT) also happen while a race is on: the race
 * on the track must not change, and an imported copy of a live race cancels it with bets refunded once.
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
 *   - players: SP integer >= 0, stats >= 0, one runner per viewer: every owned runner's ownerKey is
 *     a player whose runnerId points back at it (no orphans), every player.runnerId points at a runner
 *     that player owns, the owner label is that player's display name; no reserved ('#') key is ever
 *     a player, a hype contributor or an achiever (review batch 2). Some viewers have display names
 *     that are not their login (きつね for kitsune_jp, "Mod Mia" for modmia, "Fox Fan" for user_42),
 *     the streamer's console speaks as '#streamer', and a spoofed '#streamer' arrives from Twitch;
 *     SEND AS <viewer> (source admin, the viewer's login) plays and must succeed at least once
 *   - the logins 'constructor' and '__proto__' (a mod) play like anyone, and neither Object nor
 *     Object.prototype ever gains a key (review batch 3)
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
// A mid-season RESET SEASON (review batch 10) skips the rest of that season: the target moves one
// season on, so SEASONS seasons are still played in full.
let TARGET_SEASON = SEASONS + 1;
// The season in which the forced mid-season reset and the forced mid-race import happen: season 2, or
// season 1 with --seasons 1 (so every --seasons value exercises both).
const FORCE_SEASON = Math.min(2, SEASONS);
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
// Since review batch 4 the Season Champion reward is paid inside the rollover commit (after the SP
// carry-over, before season:started), so it is already in the new season's balance and earned stat:
// the baseline is balance - earned + spent, and at that point the only SP a player can have earned
// in the new season is that reward (spent 0).
const spBase = Object.create(null);   // keyed by login ('constructor' / '__proto__' are viewers too)
SD.bus.on(SD.EVENTS.SEASON_STARTED, function () {
  const st = SD.state.get();
  const champSp = SD.achievements.get('seasonChampion').sp;
  Object.keys(st.players).forEach(function (k) {
    const p = st.players[k];
    ok(p.stats.spSpentTotal === 0 && (p.stats.spEarnedTotal === 0 || p.stats.spEarnedTotal === champSp),
      'players: a new season starts with nothing spent and only a Season Champion reward earned', k + ' ' + JSON.stringify(p.stats));
    spBase[k] = p.spiritPoints - p.stats.spEarnedTotal + p.stats.spSpentTotal;
  });
});
SD.state.set(SD.state.create({ seedSalt: SEED ^ 0x5bd1e995 }));
SD.game.init();
SD.achievements.init();
function S() { return SD.state.get(); }

const VIEWERS = [
  { name: 'FoxFan' }, { name: 'MothMom' }, { name: 'AcornAndy' }, { name: 'WispWatcher' },
  { name: 'BrambleBob' }, { name: 'LanternLiz', isMod: true }, { name: 'Raid_Rick' }, { name: 'xX_Owl_Xx' },
  { name: 'Zoë_Ümlaut' }, { name: '@AtSign' }, { name: 'Spam Sam' }, { name: 'ModMaya', isMod: true },
  // name = the login (player key), display = a display name that is NOT the login in other case
  { name: 'kitsune_jp', display: 'きつね' }, { name: 'modmia', display: 'Mod Mia', isMod: true }, { name: 'user_42', display: 'Fox Fan' },
  // logins named like Object.prototype members (review batch 3): real viewers, never Object.prototype
  { name: 'constructor' }, { name: '__proto__', display: 'Proto Fan', isMod: true }
];
const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
const OBJECT_NAMES = Object.getOwnPropertyNames(Object).sort().join(',');
const STREAMER = { name: SD.players.STREAMER_KEY, display: 'Streamer', admin: true };
const SPOOF = { name: '#Streamer', display: 'Streamer', spoof: true };   // a Twitch / bridge line claiming the console key
// SEND AS <viewer>: the streamer acting for a viewer, exactly as SD.ui.admin.sendAs() does it (the
// viewer's login, source 'admin' = no cooldowns and the open-training bypass, mod rights, the
// player's display name). Unlike the '#streamer' console this actor plays.
function sendAsActor() {
  const key = SD.players.keyOf(pick(VIEWERS).name);
  const p = SD.state.player(key);
  return { name: key, display: (p && p.displayName) || key, sendAs: true };
}
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
  return weighted([[5, pick(VIEWERS).name], [1, pick(VIEWERS).display || 'Streamer'], [1, 'Streamer'], [2, pick(['nobody', '@', 'Zoe', 'spam', 'mothmom'])], [1, pick(JUNK)]]);
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
    case 'unknown': return pick(['!discord', '!so @someone', '!xyz', '!', '!!', '!123', '!train_', '!bet_', '!créer', '!' + 'z'.repeat(40), '!constructor', '!__proto__']);
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
  const owners = Object.create(null);
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
    if (r.owner || r.ownerKey) {
      const k2 = r.ownerKey;
      ownerChecks++;
      ok(typeof k2 === 'string' && !!k2 && !!r.owner, 'runners: owner label <-> ownerKey both set', where + ' ' + r.name + ' ' + r.owner + ' / ' + k2);
      ok(!owners[k2], 'players: one runner per viewer', where + ' ' + k2 + ' owns ' + (owners[k2] || '') + ' and ' + r.name);
      owners[k2] = r.name;
      const p = Object.prototype.hasOwnProperty.call(st.players, k2) ? st.players[k2] : null;
      if (ok(!!p, 'players: every owned runner belongs to a player (no orphans)', where + ' ' + r.name + ' ownerKey ' + k2 + ' label ' + r.owner)) {
        ok(p.runnerId === r.id, 'players: runner.ownerKey <-> player.runnerId agree', where + ' ' + r.name + ' owner ' + k2 + ' runnerId ' + p.runnerId);
        ok(r.owner === p.displayName, "runners: the owner label is the owner's display name", where + ' ' + r.name + ' ' + r.owner + ' / ' + p.displayName);
        if (p.displayName.toLowerCase() !== k2) distinctOwnerChecks++;
      }
    }
  });
  ok(active <= C.RUNNERS.MAX_ACTIVE, 'runners: at most MAX_ACTIVE active', where + ' ' + active);

  // players
  Object.keys(st.players).forEach(function (k) {
    const p = st.players[k];
    ok(p.username === k, 'players: keyed by username', where + ' ' + k);
    ok(!SD.players.isReservedKey(k), 'identity: no reserved key is a player', where + ' ' + k);
    if (p.runnerId != null) {
      runnerIdChecks++;
      const mine = SD.state.runnerById(p.runnerId, st);
      ok(!!mine && !mine.retired && mine.ownerKey === k, 'players: player.runnerId points at a runner that player owns',
        where + ' ' + k + ' runnerId ' + p.runnerId + ' ownerKey ' + (mine && mine.ownerKey));
    }
    ok(Number.isInteger(p.spiritPoints) && p.spiritPoints >= 0, 'players: SP is an integer >= 0', where + ' ' + k + ' ' + p.spiritPoints);
    ok(SD.players.STAT_KEYS.every(function (s) { return p.stats[s] >= 0 && p.lifetime[s] >= 0; }), 'players: stats >= 0', where + ' ' + k);
    const expect = (spBase[k] || 0) + p.stats.spEarnedTotal - p.stats.spSpentTotal;
    ok(p.spiritPoints === expect, 'players: SP ledger (start + earned - spent = balance)', where + ' ' + k + ' balance ' + p.spiritPoints + ' expected ' + expect +
      ' (start ' + (spBase[k] || 0) + ', earned ' + p.stats.spEarnedTotal + ', spent ' + p.stats.spSpentTotal + ')');
  });

  ok(!Object.keys(st.hype.contributions).some(SD.players.isReservedKey), 'identity: no hype credit for a reserved key', where);
  ok(Object.getOwnPropertyNames(Object.prototype).sort().join(',') === PROTO_NAMES && Object.getOwnPropertyNames(Object).sort().join(',') === OBJECT_NAMES &&
    ({}).isMod === undefined, 'identity: Object.prototype / Object never gain keys from chat', where);
  ok(!st.achievements.unlocked.some(function (a) { return SD.players.isReservedKey(a.username); }), 'identity: no achievement for a reserved key', where);

  // bets
  const betBy = Object.create(null);
  st.bets.forEach(function (b) {
    ok(!betBy[b.username], 'bets: at most one open bet per player', where + ' ' + b.username);
    betBy[b.username] = true;
    ok(Object.prototype.hasOwnProperty.call(st.players, b.username), 'bets: placed by a known player', where + ' ' + b.username);
    ok(!!SD.state.runnerById(b.runnerId, st), 'bets: on a known runner', where + ' ' + b.runnerId);
    ok(Number.isInteger(b.amount) && b.amount >= C.ECONOMY.BET_MIN && b.amount <= C.ECONOMY.BET_MAX, 'bets: amount within limits', where + ' ' + b.amount);
    ok(b.odds >= C.RACE.ODDS.MIN && b.odds <= C.RACE.ODDS.MAX, 'bets: odds within limits', where + ' ' + b.odds);
    // Review batch 4: a bet locked into the running race is settled at min(quoted, gate odds).
    const gate = b.recordId && st.currentRace && st.currentRace.record.id === b.recordId
      ? st.currentRace.record.entrants.filter(function (e) { return e.runnerId === b.runnerId; })[0] : null;
    if (gate) ok(b.odds <= gate.odds, 'bets: a locked bet never pays more than the gate odds', where + ' ' + b.odds + ' > ' + gate.odds);
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
    const p = Object.prototype.hasOwnProperty.call(st.players, a.username) ? st.players[a.username] : null;
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
  // Review batch 10: the queue itself may hold more than MAX_SABOTAGE_PER_RACE pebbles (by design since review
  // batch 4: a pebble on a runner outside the next field does not count, and the field changes with rests,
  // runnerCount, spawns ...). The per-race cap is checked where it applies: the pebbles a race takes at the gate.
  ok(sabTotal <= CH.MAX_SABOTAGE_PER_TARGET * Math.max(1, st.runners.length), 'raceEffects: sabotage queue bounded by the per-target cap', where + ' ' + sabTotal);
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
    // Review batch 4: odds are never raised above HOUSE / p (the 1.3x floor is gone); a runner under
    // ODDS.MIN is odds-on (shown at FLOOR, takes no bets). The bound used to be ODDS.MIN..MAX.
    const O = SD.CONFIG.RACE.ODDS;
    ok(fo.entrants.every(function (e) {
      return e.odds >= O.FLOOR && e.odds <= O.MAX && e.winProb > 0 && e.winProb < 1 &&
        (e.odds < O.MIN || e.odds * e.winProb <= O.HOUSE + 0.001);
    }), 'betting: next-field odds within limits and never above the fair price minus the house edge', where);
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
let spoofs = 0;
let sendAsLines = 0, sendAsOk = 0;
let ownerChecks = 0, runnerIdChecks = 0, distinctOwnerChecks = 0;
let lockedAttempts = 0;
let createdOk = 0;
function send(v, text) {
  const st = S();
  const lockedBefore = SD.state.isRaceLocked(st);
  const raceBefore = st.currentRace ? st.currentRace.record.id + ':' + st.currentRace.status : null;
  const dayEventBefore = st.season.activeDayEvent;
  const errsBefore = consoleErrors.length;
  const source = v.admin || v.sendAs ? 'admin' : pick(SOURCES);
  const isMod = !!v.isMod || !!v.admin || !!v.sendAs;
  const parsed = SD.commands.parse(text);
  const def = parsed ? SD.commands.get(parsed.name) : null;
  let res;
  try {
    res = SD.processCommand(v.name, text, { source: source, isMod: isMod, displayName: v.display || v.name });
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
  if (v.spoof) {
    spoofs++;
    ok(!res.ok && res.reserved === true && !res.isCommand, 'identity: a reserved key from ' + source + ' is refused', where + ' -> ' + res.message);
  }
  if (v.admin && res.ok && def && (def.requiresPlayer || def.requiresRunner || def.name === 'join')) {
    ok(false, 'identity: the streamer console never plays', where + ' -> ' + res.message);
  }
  if (v.sendAs) {
    sendAsLines++;
    ok(!res.reserved, 'identity: SEND AS a viewer login is never treated as the console', where + ' -> ' + res.message);
    if (res.ok && def && (def.requiresPlayer || def.requiresRunner || def.name === 'join')) sendAsOk++;
  }

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
let reloads = 0, reloadsMidRace = 0, seasonResets = 0, midSeasonResets = 0;
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

// Admin actions the streamer can take with or without a race (review batch 10, tools-tests#10: the
// drawer, the console and main.js's 30 s tickClock all run while a race is on).
let midRaceAdmin = 0, midRaceImports = 0;
function adminAction(act, where) {
  if (act === 'settings') {
    const patch = pick([
      { openTraining: chance(0.7) }, { allowCreate: chance(0.75) }, { userCooldownS: pick([0, 2, 5, 10, 15]) },
      { hypeMultiplier: pick([0, 0.5, 1, 1.5, 3]) }, { runnerCount: 2 + rng.int(9) }, { distance: pick([1200, 1600, 2000, 2400, 999]) },
      { eventFrequency: pick(['none', 'low', 'normal', 'high', 'chaos', 'bogus']) }, { autoAdvanceDay: chance(0.8) },
      { debug: chance(0.5) }, { seedOverride: pick([null, 12345, 'abc']) }, { bogusKey: 1 }, { distance: 'NaN', runnerCount: 'x' },
      { twitch: { channel: '#Some_Chan!!', enabled: 'yes' } }, { bridge: { url: 'http://nope' } }, { resultsAutoCloseMs: -5 }
    ]);
    SD.game.updateSettings(patch);
    settingsChanges++;
    return 'settings ' + JSON.stringify(patch);
  } else if (act === 'spawn') {
    const res = SD.game.spawnRunner(chance(0.5) ? { name: pick(CREATE_NAMES) } : {});
    if (res && res.id) spawns++;
    else ok(res && res.ok === false && /full/.test(res.message), 'director: spawn only refused when the paddock is full', where + ' ' + JSON.stringify(res));
    return 'spawn';
  } else if (act === 'hype') {
    SD.game.addHype(pick([25, -10, 60, 120, -500]), 'streamer');
    return 'hype';
  } else if (act === 'dayEvent') {
    SD.game.triggerDayEvent(chance(0.5) ? pick(SD.DATA.DAY_EVENTS).id : (chance(0.5) ? 'bogus' : undefined));
    return 'day event';
  } else if (act === 'clock') {
    advance(pick([60000, 5 * 60000, 20 * 60000, 45 * 60000]));
    SD.game.tickClock();
    return 'clock';
  }
  return act;
}

// EXPORT JSON -> IMPORT while a race is running: the imported copy never keeps a live race. It is
// cancelled like a reload: open bets refunded exactly once, the race's paid chat effects queued again.
function roundTripMidRace(where) {
  const st = S();
  if (!st.currentRace) return;
  const spBefore = Object.keys(st.players).reduce(function (a, k) { return a + st.players[k].spiritPoints; }, 0);
  const staked = st.bets.reduce(function (a, b) { return a + b.amount; }, 0);
  const effects = st.raceEffects.length + (st.currentRace.record.inputs ? (st.currentRace.record.inputs.raceEffects || []).length : 0);
  let json;
  try { json = SD.persistence.exportJSON(); } catch (e) { ok(false, 'import mid-race: state is JSON-serialisable', where + ' ' + e.message); return; }
  const res = SD.persistence.importJSON(json);
  if (!ok(res && res.ok, 'import mid-race: import of an export succeeds', where + ' ' + (res && res.error))) return;
  const now = S();
  ok(now.currentRace === null, 'import mid-race: the imported copy has no live race', where + ' ' + (now.currentRace && now.currentRace.status));
  const spAfter = Object.keys(now.players).reduce(function (a, k) { return a + now.players[k].spiritPoints; }, 0);
  ok(spAfter === spBefore + staked && now.bets.length === 0, 'import mid-race: open bets are refunded exactly once',
    where + ' SP ' + spBefore + ' + staked ' + staked + ' -> ' + spAfter + ', bets left ' + now.bets.length);
  ok(now.raceEffects.length === effects, 'import mid-race: the paid chat effects of the race are queued again', where + ' ' + effects + ' -> ' + now.raceEffects.length);
  midRaceImports++;
  racesAborted++;
  afterRace(where + ' import mid-race');
}

function raceSignature(st) {
  const cr = st.currentRace;
  if (!cr) return null;
  const r = cr.record;
  return JSON.stringify([r.id, r.hash, r.seed, r.distance, r.results.map(function (x) { return x.runnerId + ':' + x.place; }),
    r.entrants.map(function (e) { return e.runnerId + ':' + e.odds + ':' + e.lane; }), (st.bets || []).map(function (b) { return b.id + ':' + b.odds; })]);
}

function director() {
  const st = S();
  const cr = st.currentRace;
  const where = 'director S' + st.season.number + 'D' + st.season.day;
  if (!cr) {
    let act = weighted([
      [10, 'start'], [72, 'none'], [1.2, 'nextDay'], [0.5, 'resetDay'], [4, 'settings'], [0.25, 'spawn'], [2, 'hype'],
      [2, 'dayEvent'], [6, 'clock'], [1, 'reload'], [0.3, 'resetSeason']
    ]);
    // At least one mid-season RESET SEASON on every seed: in FORCE_SEASON (2, or 1 with --seasons 1), once
    // bets or queued effects are open (day 5 at the latest).
    const forceReset = !midSeasonResets && st.season.number === FORCE_SEASON && st.season.day >= 3 &&
      (st.bets.length > 0 || st.raceEffects.length > 0 || st.season.day >= 5);
    if (forceReset) act = 'resetSeason';
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
        const used = (res.record.inputs && res.record.inputs.raceEffects) || [];
        const pebbles = used.reduce(function (a, e) { return a + (e && e.type === 'sabotage' ? Math.max(1, Number(e.count) || 1) : 0); }, 0);
        ok(pebbles <= SD.CONFIG.RACE.CHAT.MAX_SABOTAGE_PER_RACE, 'race: at most MAX_SABOTAGE_PER_RACE pebbles are taken at the gate', where + ' ' + pebbles);
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
    } else if (act === 'settings' || act === 'spawn' || act === 'hype' || act === 'dayEvent' || act === 'clock') {
      checkState(where + ' ' + adminAction(act, where));
    } else if (act === 'reload') {
      reload(where);
    } else if (act === 'resetSeason') {
      const res = SD.game.resetSeason();
      ok(res.ok && res.summary && S().season.day === 1 && S().season.racesRun === 0 && S().bets.length === 0 && S().raceEffects.length === 0,
        'director: RESET SEASON mid-season archives and restarts (bets and queued effects refunded)', where + ' ' + res.message);
      seasonResets++;
      midSeasonResets++;
      TARGET_SEASON++;
      checkState(where + ' resetSeason');
      afterRace(where + ' resetSeason');
    }
    // Days with autoAdvanceDay off would never end on their own.
    if (!S().currentRace && S().settings.autoAdvanceDay === false && S().season.raceIndexInDay >= S().season.racesPerDay && chance(0.3)) {
      SD.game.nextDay();
      nextDays++;
    }
    return;
  }
  // A race is on: flip countdown -> running (playback), pause / resume, reload, finish or abort.
  let act = weighted([[cr.status === 'countdown' ? 25 : 0, 'go'], [6, 'pause'], [cr.status === 'paused' ? 20 : 0, 'resume'],
    [3, 'reload'], [30, 'end'], [3, 'abort'], [30, 'none'],
    [4, 'settings'], [1, 'spawn'], [3, 'hype'], [4, 'dayEvent'], [5, 'clock'], [1, 'resetSeason'], [1, 'nextDay'], [2.5, 'import']]);
  if (!midRaceImports && st.season.number >= FORCE_SEASON && (st.bets.length > 0 || cr.status === 'running')) act = 'import';   // on every seed
  if (act === 'settings' || act === 'spawn' || act === 'hype' || act === 'dayEvent' || act === 'clock' || act === 'resetSeason' || act === 'nextDay') {
    // An admin action during a race never changes the race on the track (its record, field, odds or
    // the bets on it) or its status; RESET SEASON / NEXT DAY are refused.
    const sig = raceSignature(S());
    const status = cr.status;
    let what = act;
    if (act === 'resetSeason' || act === 'nextDay') {
      const res = act === 'resetSeason' ? SD.game.resetSeason() : SD.game.nextDay();
      ok(res && res.ok === false, 'director: ' + act + ' is refused during a race', where + ' ' + (res && res.message));
    } else {
      what = adminAction(act, where);
    }
    midRaceAdmin++;
    ok(raceSignature(S()) === sig && S().currentRace.status === status, 'director: a mid-race admin action leaves the race alone', where + ' ' + what);
  } else if (act === 'import') {
    roundTripMidRace(where);
    return;
  } else if (act === 'go') SD.game.setRaceStatus('running');
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
  const v = chance(0.04) ? STREAMER : (chance(0.01) ? SPOOF : (chance(0.05) ? sendAsActor() : pick(VIEWERS)));
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
ok(st.season.history.length >= SEASONS + midSeasonResets, 'season history has an entry per season played or reset', st.season.history.length);
ok(createdOk > 0, '!create succeeded at least once', createdOk);
ok(lockedAttempts > 0, 'mid-race locked commands were attempted', lockedAttempts);
ok(ownerChecks > 0 && runnerIdChecks > 0, 'the owner <-> runnerId invariant actually ran (both directions)', ownerChecks + ' / ' + runnerIdChecks);
ok(distinctOwnerChecks > 0, 'viewers whose display name is not their login owned runners', distinctOwnerChecks);
ok(spoofs > 0, 'spoofed #streamer lines were sent', spoofs);
ok(sendAsOk > 0, 'SEND AS (source admin, a viewer login) ran player commands successfully', sendAsOk + ' of ' + sendAsLines);
ok(midSeasonResets > 0, 'RESET SEASON was fuzzed mid-season (not only the final reset)', midSeasonResets);
ok(midRaceAdmin > 0, 'admin actions were fuzzed during races', midRaceAdmin);
ok(midRaceImports > 0, 'EXPORT -> IMPORT was fuzzed during races', midRaceImports);
ok(consoleErrors.length === 0, 'no console.error during the whole run', consoleErrors.slice(0, 3).join(' || '));

console.log('\nCommand-outcome histogram (' + commandsRun + ' commands):');
const cols = ['total', 'ok', 'refused', 'cooldown', 'locked', 'unknown'];
console.log('  ' + 'command'.padEnd(14) + cols.map(function (c) { return c.padStart(9); }).join(''));
Object.keys(hist).sort(function (a, b) { return hist[b].total - hist[a].total || (a < b ? -1 : 1); }).forEach(function (k) {
  console.log('  ' + k.padEnd(14) + cols.map(function (c) { return String(hist[k][c]).padStart(9); }).join(''));
});
console.log('\nRaces finished ' + racesFinished + ', aborted ' + racesAborted + ', pauses ' + pauses + ', manual next days ' + nextDays +
  ', settings changes ' + settingsChanges + ', admin spawns ' + spawns + ', reloads ' + reloads + ' (' + reloadsMidRace + ' mid-race), season resets ' + seasonResets + ' (' + midSeasonResets + ' mid-season), mid-race admin actions ' + midRaceAdmin + ', mid-race imports ' + midRaceImports + ', !create ok ' + createdOk + ', locked attempts ' + lockedAttempts +
  ', spoofed console lines ' + spoofs + ', SEND AS lines ' + sendAsLines + ' (' + sendAsOk + ' player commands ok), owner checks ' + ownerChecks + ' (' + distinctOwnerChecks + ' by non-case-variant names), runnerId checks ' + runnerIdChecks +
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
