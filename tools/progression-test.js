#!/usr/bin/env node
/*
 * Spirit Derby - tools/progression-test.js
 * Assertion tests for M3 (plan sections 6.3, 6.4, 4 and 12): XP / level-ups (thresholds,
 * cap / energy / stat gains, MAX_LEVEL, runner:levelup + hype from training and races),
 * SD.leaderboards (ordering, shared ranks, season vs all-time scope, participation formula,
 * resolve / format / rankOf), the !leaderboard / !lb / !top / !rank / !status replies, the
 * read-only anti-spam rule for participation, and a real race updating the boards.
 *
 *   node tools/progression-test.js [--verbose]
 *
 * SD.clock is frozen (advance with tick(ms)). Exit code 1 on failure.
 */
'use strict';

const SD = require('./load-core.js');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;

// -----------------------------------------------------------------------------
// Tiny assert helper (same shape as parser-test.js so run-tests.js can tally it)
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
// Harness: frozen clock, fresh deterministic state
// -----------------------------------------------------------------------------
let NOW = 1700000000000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }

const SALT = 424242;
function fresh(opts) {
  const rt = SD.state.runtime;
  rt.cooldowns = {};
  rt.runnerCooldowns = {};
  rt.chatFeed = [];
  rt.nervousCheers = {};
  rt.activity = {};
  SD.state.set(SD.state.create(Object.assign({ seedSalt: SALT, dayEventId: 'clearSkies' }, opts || {})));
  SD.game.init();
  tick(60000);
  return SD.state.get();
}
function S() { return SD.state.get(); }
function say(user, text, opts) { return SD.processCommand(user, text, opts); }
function player(u) { return SD.players.get(S(), u); }
function runner(q) { return SD.state.findRunner(q).runner; }
const LB = SD.leaderboards;
const P = SD.CONFIG.PROGRESSION;
const USER_CD = SD.CONFIG.COOLDOWNS.USER_S * 1000;
const RO_WINDOW = SD.CONFIG.LEADERBOARDS.READONLY_ACTIVITY_S * 1000;

ok(!!LB, 'SD.leaderboards is loaded (js/leaderboards.js in tools/load-core.js order)');

// -----------------------------------------------------------------------------
section('XP formula and level-ups (runners.addXp)');
// -----------------------------------------------------------------------------
{
  fresh();
  const R = SD.runners;
  eq([R.xpToNext(1), R.xpToNext(2), R.xpToNext(5), R.xpToNext(20)], [60, 80, 140, 440], 'xpToNext(L) = 60 + 20(L-1)');
  eq(P.MAX_LEVEL, 20, 'MAX_LEVEL 20');

  const moss = runner('moss');
  const before = { stats: Object.assign({}, moss.stats), cap: R.statCap(1), maxE: moss.maxEnergy, energy: moss.energy };
  moss.energy = 50;
  const a = R.addXp(moss, 59);
  eq([a.levelUps, moss.level, moss.xp], [0, 1, 59], '59 XP: still level 1');
  const b = R.addXp(moss, 1);
  eq([b.levelUps, b.level, moss.level, moss.xp], [1, 2, 2, 0], '60 XP: 1 -> 2, xp resets to 0');
  eq(R.statCap(2) - before.cap, 4, 'stat cap +4 per level');
  eq(R.statCap(2), 68, 'level 2 cap = 60 + 4 x 2');
  eq(moss.maxEnergy - before.maxE, 2, 'energy max +2');
  eq(moss.energy, 52, 'current energy grows with the new max');
  SD.CONFIG.STATS.forEach(function (k) { eq(moss.stats[k] - before.stats[k], 1, '+1 ' + k + ' on level-up'); });
  eq(moss.totalXp, 60, 'totalXp (season) counts every point');
  eq(moss.lifetime.totalXp, 60, 'lifetime.totalXp counts every point');

  const c = R.addXp(moss, 80 + 100 + 5);   // L2 -> L4 with 5 spare
  eq([c.levelUps, moss.level, moss.xp], [2, 4, 5], 'multi-level jump: 2 -> 4 with 5 XP left over');

  // Stats already at the cap stay at the (new) cap.
  const ember = runner('ember');
  ember.stats.speed = R.statCap(1);
  R.addXp(ember, 60);
  eq(ember.stats.speed, R.statCap(2) - 3, 'a capped stat gains +1 (still under the new cap)');

  const glow = runner('glow');
  const big = R.addXp(glow, 100000);
  eq([big.levelUps, glow.level], [19, 20], 'huge XP stops at MAX_LEVEL 20');
  ok(glow.xp <= R.xpToNext(20), 'xp at max level is capped', glow.xp);
  eq(glow.maxEnergy, R.energyMax(20), 'energy max at level 20 = 100 + 2 x 19');
  eq(glow.maxEnergy, 138, 'energy max 138 at level 20');
  const again = R.addXp(glow, 5000);
  eq([again.levelUps, glow.level], [0, 20], 'no level-ups past MAX_LEVEL');
  ok(glow.totalXp === 105000, 'totalXp keeps counting at max level', glow.totalXp);
}

// -----------------------------------------------------------------------------
section('level-up side effects through SD.game (hype +8, runner:levelup, log)');
// -----------------------------------------------------------------------------
{
  fresh();
  const moss = runner('moss');
  moss.xp = SD.runners.xpToNext(1) - 1;
  const ups = [];
  const off = SD.bus.on(SD.EVENTS.RUNNER_LEVELUP, function (p) { ups.push(p); });
  let res = null;
  for (let i = 0; i < 6 && !(res && res.levelUps); i++) res = SD.game.trainRunner(moss.id, 'speed', 'streamer');
  off();
  ok(res && res.levelUps === 1, 'training pushed Moss Runner over the threshold', res && res.outcome);
  eq(moss.level, 2, 'Moss Runner is level 2');
  eq(ups.length, 1, 'runner:levelup emitted once');
  eq(ups[0] && [ups[0].runnerId, ups[0].name, ups[0].level, ups[0].levelUps], [moss.id, moss.name, 2, 1], 'runner:levelup payload');
  const trainHype = SD.CONFIG.TRAINING.REWARDS[res.outcome].hype;
  ok(S().hype.value >= P.LEVELUP_HYPE + trainHype - 0.01, 'hype includes +8 for the level-up', S().hype.value);
  ok(S().log.some(function (l) { return l.type === 'levelup' && l.text === 'Moss Runner reached level 2!'; }), 'log line "Moss Runner reached level 2!"');
}

// -----------------------------------------------------------------------------
section('leaderboards: resolve / scope words');
// -----------------------------------------------------------------------------
{
  eq(LB.CATEGORIES.map(function (c) { return c.id; }),
    ['runnerWins', 'runnerXp', 'spiritPoints', 'participation', 'raceVictories', 'hypeContributions'], 'six categories in order');
  eq(LB.CATEGORIES.map(function (c) { return c.kind; }), ['runner', 'runner', 'player', 'player', 'player', 'player'], 'kinds');
  ok(LB.CATEGORIES.every(function (c) { return c.name && c.short && c.desc && Array.isArray(c.aliases); }), 'every category has name/short/desc/aliases');
  const cases = {
    wins: 'runnerWins', WINS: 'runnerWins', runnerWins: 'runnerWins', xp: 'runnerXp', sp: 'spiritPoints', points: 'spiritPoints',
    part: 'participation', active: 'participation', victories: 'raceVictories', 'wins-player': 'raceVictories',
    hype: 'hypeContributions', '!lb': null, bogus: null, '': null
  };
  Object.keys(cases).forEach(function (k) { eq(LB.resolve(k), cases[k], 'resolve("' + k + '")'); });
  eq(LB.resolve(null), null, 'resolve(null)');
  eq([LB.resolveScope('all'), LB.resolveScope('all-time'), LB.resolveScope('Lifetime'), LB.resolveScope('season'), LB.resolveScope('wins')],
    ['all', 'all', 'all', 'season', null], 'resolveScope');
  eq(LB.fmtNum(1240), '1,240', 'fmtNum thousands separator');
  eq(LB.fmtNum(12.5), '12.5', 'fmtNum keeps one decimal');
}

// -----------------------------------------------------------------------------
section('leaderboards: ordering, ties, scope, participation');
// -----------------------------------------------------------------------------
{
  const st = fresh();
  ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm'].forEach(function (u) { say(u, '!join'); });
  tick(USER_CD + 1);
  say('Alder', '!claim moss');
  const sp = { alder: 500, birch: 300, cedar: 300, dogwood: 100, elm: 0 };
  Object.keys(sp).forEach(function (k) { player(k).spiritPoints = sp[k]; });

  const t = LB.top(st, 'spiritPoints');
  eq(t.map(function (e) { return [e.rank, e.name, e.value]; }),
    [[1, 'Alder', 500], [2, 'Birch', 300], [2, 'Cedar', 300], [4, 'Dogwood', 100]], 'SP: sorted, ties share rank 2, next rank is 4, zero excluded');
  eq(t[0].label, '500 SP', 'label with unit');
  eq([t[0].kind, t[0].runnerName, t[0].runnerEmoji, t[1].runnerName], ['player', 'Moss Runner', runner('moss').emoji, null], 'player entries carry their runner');
  eq(LB.top(st, 'spiritPoints', 2).length, 2, 'top(n) limits rows');
  eq(LB.rankOf(st, 'spiritPoints', 'Cedar'), { rank: 2, value: 300, label: '300 SP', total: 4 }, 'rankOf by display name');
  eq(LB.rankOf(st, 'spiritPoints', 'elm'), null, 'rankOf: zero value is unranked');
  eq(LB.rankOf(st, 'spiritPoints', 'nobody'), null, 'rankOf: unknown player');
  eq(LB.rankOf(st, 'nope', 'alder'), null, 'rankOf: unknown board');

  // All-time SP = SP earned over every season (lifetime + this season).
  player('dogwood').lifetime.spEarnedTotal = 5000;
  eq(LB.top(st, 'spiritPoints', 1, 'all')[0].name, 'Dogwood', 'all-time SP ranks lifetime SP earned');
  eq(LB.top(st, 'spiritPoints', 1, { scope: 'all' })[0].label, LB.fmtNum(5000 + player('dogwood').stats.spEarnedTotal) + ' SP earned', 'scope as { scope } + all-time label');
  eq(LB.top(st, 'spiritPoints', 1)[0].name, 'Alder', 'season scope is the default');

  // Participation = commands + trains x2 + cheers + rests + bets; never SP / victories / hype.
  const b = player('birch');
  Object.assign(b.stats, { commands: 5, trains: 3, cheers: 2, rests: 1, bets: 1, raceVictories: 9, hypeContributed: 99, spEarnedTotal: 9999 });
  b.spiritPoints = 99999;
  eq(LB.participation(b, 'season'), 5 + 6 + 2 + 1 + 1, 'participation formula (15)');
  b.lifetime.trains = 10;
  eq(LB.participation(b, 'all'), 15 + 20, 'all-time participation adds lifetime counters');
  eq(LB.rankOf(st, 'participation', 'birch').value, 15, 'participation board value');
  eq(LB.top(st, 'raceVictories')[0].name, 'Birch', 'victories board is independent');
  eq(LB.top(st, 'hypeContributions')[0].value, 99, 'hype board reads hypeContributed');
  b.lifetime.raceVictories = 4;
  eq(LB.rankOf(st, 'raceVictories', 'birch', 'all').value, 13, 'all-time victories = lifetime + season');

  // Runner boards: season = record / totalXp, all-time = lifetime.
  const vc = runner('velvet'), moss = runner('moss'), ember = runner('ember');
  vc.record.wins = 3; moss.record.wins = 2; ember.record.wins = 1;
  vc.lifetime.wins = 3; moss.lifetime.wins = 7; ember.lifetime.wins = 1;
  const w = LB.top(st, 'runnerWins');
  eq(w.map(function (e) { return e.name; }), ['Velvet Comet', 'Moss Runner', 'Ember Tail'], 'runner wins ordering');
  eq([w[1].owner, w[1].level, w[0].owner, w[0].emoji, w[0].kind], ['Alder', 1, null, vc.emoji, 'runner'], 'runner entries carry owner display name, level, emoji');
  eq(LB.format(st, 'runnerWins'), '🏆 Runner wins: 1. Velvet Comet (3) · 2. Moss Runner (2) · 3. Ember Tail (1)', 'format() chat line');
  eq(LB.format(st, 'runnerWins', 3, 'all'), '🏆 Runner wins (all-time): 1. Moss Runner (7) · 2. Velvet Comet (3) · 3. Ember Tail (1)', 'format() all-time');
  moss.record.wins = 3;
  eq(LB.format(st, 'wins', 2), '🏆 Runner wins: 1. Moss Runner (3) · 1. Velvet Comet (3)', 'format() shows shared ranks (alias id ok)');
  eq(LB.rankOf(st, 'runnerWins', 'velvet'), { rank: 1, value: 3, label: '3 wins', total: 3 }, 'rankOf a runner by name');
  eq(LB.rankOf(st, 'runnerWins', ember.id).label, '1 win', 'singular unit');
  eq(LB.leader(st).names, ['Moss Runner', 'Velvet Comet'], 'leader() lists tied leaders');
  has(LB.format(st, 'runnerXp'), 'no XP earned yet', 'empty board message');
  vc.totalXp = 120; vc.lifetime.totalXp = 400;
  eq(LB.top(st, 'runnerXp')[0].value, 120, 'runner XP season = totalXp');
  eq(LB.top(st, 'runnerXp', 1, 'all')[0].value, 400, 'runner XP all-time = lifetime.totalXp');
  eq(LB.format(S(), 'bogus'), '', 'format() of an unknown board is empty');
}

// -----------------------------------------------------------------------------
section('!leaderboard / !lb / !top / !rank / !status');
// -----------------------------------------------------------------------------
{
  fresh();
  const lb0 = say('Lurker', '!leaderboard');
  eq([lb0.ok, lb0.command], [true, 'leaderboard'], '!leaderboard works without joining');
  has(lb0.message, '🍃 Spirit Points:', 'default board is Spirit Points');
  has(lb0.message, 'nobody has joined yet', 'empty SP board');
  has(lb0.message, 'More: !lb wins', 'no-arg reply lists the other boards');
  say('FoxFan', '!join');
  say('MothMom', '!join');
  player('mothmom').spiritPoints = 900;
  const lb1 = say('FoxFan', '!lb');
  eq(lb1.ok, true, '!lb ok');
  has(lb1.message, '1. MothMom (900) · 2. FoxFan (200)', '!lb lists SP top 3');
  eq(lb1.cooldownMs, 0, 'read-only: no cooldown stamped');
  eq(say('FoxFan', '!lb').ok, true, 'immediate second !lb is fine (no cooldown)');
  has(say('FoxFan', '!lb wins').message, '🏆 Runner wins: no winners yet', '!lb wins (empty)');
  has(say('FoxFan', '!top xp').message, '⭐ Runner XP:', '!top alias');
  has(say('FoxFan', '!lb points').message, '🍃 Spirit Points:', '!lb points alias');
  has(say('FoxFan', '!lb part').message, '🙌 Participation:', '!lb part');
  has(say('FoxFan', '!lb active').message, '🙌 Participation:', '!lb active');
  has(say('FoxFan', '!lb victories').message, '🎖️ Race victories:', '!lb victories');
  has(say('FoxFan', '!lb wins-player').message, '🎖️ Race victories:', '!lb wins-player');
  has(say('FoxFan', '!lb hype').message, '🔥 Hype:', '!lb hype');
  has(say('FoxFan', '!lb sp all').message, '🍃 Spirit Points (all-time):', '!lb sp all');
  has(say('FoxFan', '!lb all sp').message, '(all-time)', 'scope word first works too');
  const bogus = say('FoxFan', '!leaderboard bogus');
  eq(bogus.ok, true, '!leaderboard bogus is a friendly ok reply');
  has(bogus.message, 'No board called "bogus"', 'unknown board named');
  has(bogus.message, 'wins, xp, sp, part, victories, hype', 'unknown board lists the valid names');

  const r1 = say('FoxFan', '!rank');
  eq(r1.ok, true, '!rank ok');
  eq(r1.message, 'FoxFan: #2 in SP (200) · unranked in victories · unranked in hype', '!rank line');
  tick(SD.CONFIG.COOLDOWNS.CHEER_S * 1000);
  say('FoxFan', '!cheer');
  has(say('FoxFan', '!rank').message, '#1 in hype (3)', '!rank picks up a cheer');
  has(say('FoxFan', '!rank mothmom').message, 'MothMom: #1 in SP (900)', "!rank <viewer> shows someone else's rank");
  const rNo = say('Lurker', '!rank');
  eq(rNo.ok, false, '!rank without joining refused');
  has(rNo.message, '!join', '!rank refusal hints at !join');
  has(say('FoxFan', '!rank ghost').message, 'No viewer called', '!rank unknown viewer');
  has(say('FoxFan', '!status').message, 'FoxFan: 202 SP · #2 in SP', '!status includes the SP rank');
  has(say('FoxFan', '!help leaderboard').message, '!leaderboard [wins|xp|sp|part|victories|hype]', '!help leaderboard');
  has(say('FoxFan', '!help').message, '!rank', '!help lists !rank');

  // Read-only commands still work mid-race.
  const field = SD.game.previewField();
  ok(field.length >= 2, 'field available');
  SD.game.startRace();
  eq(SD.state.isRaceLocked(), true, 'race locked');
  eq(say('FoxFan', '!lb wins').ok, true, '!lb works during a race');
  eq(say('FoxFan', '!rank').ok, true, '!rank works during a race');
  SD.game.abortRace();
}

// -----------------------------------------------------------------------------
section('participation cannot be farmed with read-only spam');
// -----------------------------------------------------------------------------
{
  fresh();
  say('Spammer', '!join');
  const c0 = player('spammer').stats.commands;
  eq(c0, 1, 'the join counts');
  tick(RO_WINDOW);
  for (let i = 0; i < 25; i++) { say('Spammer', '!status'); say('Spammer', '!lb'); say('Spammer', '!rank'); }
  eq(player('spammer').stats.commands, 2, '75 read-only commands inside one window count once');
  tick(RO_WINDOW);
  say('Spammer', '!help');
  eq(player('spammer').stats.commands, 3, 'counts again after the window');
  say('Spammer', '!claim moss');
  eq(player('spammer').stats.commands, 4, 'mutating commands (with a cooldown) always count');
  eq(LB.rankOf(S(), 'participation', 'spammer').value, 4, 'participation = 4 commands');
}

// -----------------------------------------------------------------------------
section('a finished race updates the boards (claimed winner)');
// -----------------------------------------------------------------------------
{
  fresh();
  const field = SD.game.previewField();
  eq(field.length, 4, 'preview field has 4 runners');
  const owners = ['Owner1', 'Owner2', 'Owner3', 'Owner4'];
  owners.forEach(function (u, i) {
    say(u, '!join');
    ok(say(u, '!claim ' + field[i].name).ok, u + ' claims ' + field[i].name);
  });
  field[0].xp = SD.runners.xpToNext(1) - 1;   // any finishing place levels this one up
  eq(LB.top(S(), 'runnerWins').length, 0, 'no runner wins before the race');
  eq(LB.top(S(), 'raceVictories').length, 0, 'no victories before the race');

  const ups = [];
  let fin = null;
  const offU = SD.bus.on(SD.EVENTS.RUNNER_LEVELUP, function (p) { ups.push(p); });
  const offF = SD.bus.on(SD.EVENTS.RACE_FINISHED, function (p) { fin = p; });
  const started = SD.game.startRace();
  eq(started.ok, true, 'startRace ok');
  const rec = started.record;
  const end = SD.game.endRace();
  offU(); offF();
  eq(end.ok, true, 'endRace ok');

  const win = rec.results[0];
  const winner = SD.state.runnerById(win.runnerId);
  const winOwner = SD.players.keyOf(win.ownerAtRace);
  const wins = LB.top(S(), 'runnerWins');
  eq(wins.map(function (e) { return [e.rank, e.id, e.value]; }), [[1, winner.id, 1]], 'runnerWins: the winner has 1 win');
  eq(wins[0].owner, player(winOwner).displayName, 'winner row shows the owner');
  const vic = LB.top(S(), 'raceVictories');
  eq(vic.map(function (e) { return [e.rank, e.id, e.value]; }), [[1, winOwner, 1]], 'raceVictories: the winning owner has 1 victory');
  eq(LB.top(S(), 'runnerXp').length, 4, 'all four racers earned XP');
  ok(LB.top(S(), 'runnerXp').every(function (e, i, a) { return i === 0 || a[i - 1].value >= e.value; }), 'XP board sorted descending');
  has(say('Owner1', '!lb wins').message, '🏆 Runner wins: 1. ' + winner.name + ' (1)', '!lb wins after the race');
  has(say('Owner2', '!lb victories').message, '1. ' + player(winOwner).displayName + ' (1)', '!lb victories after the race');
  has(say(winOwner, '!rank').message, '#1 in victories (1)', '!rank shows the victory');
  eq(ups.filter(function (u) { return u.runnerId === field[0].id; }).length, 1, 'runner:levelup emitted for the near-threshold runner');
  const lvRes = rec.results.filter(function (r) { return r.runnerId === field[0].id; })[0];
  ok(lvRes.levelUps >= 1, 'result.levelUps set', lvRes.levelUps);
  ok(fin && fin.levelUps.some(function (l) { return l.runnerId === field[0].id && l.level === 1 + lvRes.levelUps && l.levelUps === lvRes.levelUps; }),
    'race:finished lists the level-up', fin && fin.levelUps);
  eq(field[0].level, 1 + lvRes.levelUps, 'runner level matches the level-ups');

  // Season rollover: season boards reset, all-time keeps the history.
  const xpWinner = winner.totalXp;
  ok(xpWinner > 0, 'winner has season XP');
  eq(SD.game.resetSeason().ok, true, 'resetSeason ok');
  eq(winner.totalXp, 0, 'season XP (totalXp) resets with the season');
  ok(winner.lifetime.totalXp >= xpWinner, 'lifetime XP kept');
  eq(LB.top(S(), 'runnerWins').length, 0, 'season wins board empty after the rollover');
  eq(LB.top(S(), 'runnerWins', 10, 'all')[0].id, winner.id, 'all-time wins keep the winner');
  eq(LB.top(S(), 'raceVictories').length, 0, 'season victories empty after the rollover');
  eq(LB.top(S(), 'raceVictories', 10, 'all')[0].id, winOwner, 'all-time victories keep the owner (lifetime + season)');
  has(say('Owner1', '!lb wins all').message, '(all-time): 1. ' + winner.name + ' (1)', '!lb wins all after the rollover');
}

// -----------------------------------------------------------------------------
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
