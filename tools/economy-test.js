#!/usr/bin/env node
/*
 * Spirit Derby - tools/economy-test.js (review batch 4: betting integrity and economy correctness)
 *   A  odds are never above the fair price minus the house edge (race-engine#1): HOUSE / p rounded
 *      down, no 1.3x floor; an odds-on runner (under RACE.ODDS.MIN) takes no bets
 *   B  bets are settled at min(quoted, gate odds) (race-engine#2, lifecycle-concurrency#2): a free
 *      !rest after the bet, a smaller field, a mod's !race <distance>, an odds-on gate price
 *   C  odds see the hype tier and queued boosts / sabotages (economy-abuse#5)
 *   D  a mid-race !cheer never sets backing (economy-abuse#2)
 *   E  a bet counts once, when it is settled: stats.bets, hype (toward the next race), High Roller;
 *      an aborted / interrupted race counts nothing (economy-abuse#8, economy#7)
 *   F  winning bets count only the profit as SP earned (economy-abuse#9)
 *   G  odds are shown with their decimal (economy#9)
 *   H  aborting / interrupting a race leaves no gate moods behind (director-state#2)
 *   I  command fixes: info-only !bet / !ribbon (commands#5), near-full !snack (commands#6), mod
 *      !race arguments (commands#7), !rest's real hype change (commands#8), the !sabotage per-race
 *      cap counts the next race only (economy-abuse#11)
 *   J  season rollover: the snack counter resets (director-state#7)
 *
 *   node tools/economy-test.js [--verbose]
 */
'use strict';

const SD = require('./load-core.js');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
let passed = 0;
let failed = 0;
const failures = [];
let currentSection = '';
function section(title) { currentSection = title; console.log('\n' + title); }
function ok(cond, name, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  PASS ' + name); }
  else {
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
// Harness
// -----------------------------------------------------------------------------
let NOW = 1767225600000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }
SD.persistence.setAutoSave(false);

const EV = SD.EVENTS;
const O = SD.CONFIG.RACE.ODDS;
const EC = SD.CONFIG.ECONOMY;
const MOD = { source: 'twitch', isMod: true };

function fresh(opts) {
  const rt = SD.state.runtime;
  rt.cooldowns = {}; rt.runnerCooldowns = {}; rt.chatFeed = []; rt.nervousCheers = {}; rt.activity = {}; rt.hypeRecent = {};
  SD.state.set(SD.state.create(Object.assign({ seedSalt: 424242, dayEventId: 'clearSkies' }, opts || {})));
  SD.game.init();
  SD.betting.clearCache();
  tick(60000);
  return SD.state.get();
}
function S() { return SD.state.get(); }
function say(user, text, opts) { tick(11000); return SD.processCommand(user, text, Object.assign({ source: 'twitch' }, opts || {})); }
function player(u) { return SD.players.get(S(), u); }
function field() { return SD.betting.fieldOdds(S()).field; }
function oddsOf(id) { const o = SD.betting.odds(S(), id); return o ? o.odds : null; }
function capture(name) {
  const list = [];
  const off = SD.bus.on(name, function (p) { list.push(p); });
  return { list: list, off: off };
}
function gateOdds(record, runnerId) {
  const e = record.entrants.filter(function (x) { return x.runnerId === runnerId; })[0];
  return e ? e.odds : null;
}
function setAllStats(r, v) { SD.CONFIG.STATS.forEach(function (k) { r.stats[k] = v; }); }
function rosterRunners(n) { return SD.DATA.ROSTER.slice(0, n).map(function (e, i) { return SD.runners.spawnFromRoster(e, i); }); }

SD.achievements.disable();

// =============================================================================
section('A. Odds never exceed the fair price minus the house edge (race-engine#1)');
// =============================================================================
{
  eq([SD.race.oddsFor(0.5), SD.race.oddsFor(0.3), SD.race.oddsFor(0.7), SD.race.oddsFor(0.8)], [1.7, 2.8, 1.2, 1],
    'oddsFor(p) = HOUSE / p rounded DOWN to 0.1 (0.85/0.3 = 2.83 -> 2.8, 0.85/0.7 = 1.21 -> 1.2)');
  eq([SD.race.oddsFor(0.95), SD.race.oddsFor(0.001)], [O.FLOOR, O.MAX], 'shown at least FLOOR (1.0x) and at most MAX (25x)');
  let worst = 0, bad = 0;
  for (let i = 1; i < 1000; i++) {
    const p = i / 1000;
    const o = SD.race.oddsFor(p);
    if (o >= O.MIN) { worst = Math.max(worst, p * o); if (p * o > O.HOUSE + 1e-9) bad++; }
  }
  eq(bad, 0, 'for every p, a bettable price returns at most HOUSE (0.85) per SP on average (worst ' + worst.toFixed(4) + ')');

  // A dominant runner in a stock field: the verifier's case (p ~ 0.83 used to be clamped UP to 1.3x).
  const runners = rosterRunners(6);
  SD.CONFIG.STATS.forEach(function (k) { runners[0].stats[k] += 18; });
  const ents = SD.race.buildEntrants(runners, { distance: 2000, hypeLevel: 0 });
  const fav = ents[0];
  ok(fav.winProb > 0.75, 'the trained runner is a heavy favourite', fav.winProb);
  ok(fav.odds * fav.winProb <= O.HOUSE + 0.001 || fav.odds < O.MIN, 'its odds never beat the house edge (no 1.3x floor)', [fav.odds, fav.winProb]);
  ok(ents.every(function (e) { return e.odds < O.MIN || e.odds * e.winProb <= O.HOUSE + 0.001; }), 'the same for every entrant');

  // An odds-on runner takes no bets.
  fresh();
  say('Alice', '!join'); say('Bob', '!join');
  const F = field();
  const star = F[0];
  setAllStats(star, 64);
  F.slice(1).forEach(function (r) { setAllStats(r, 20); });
  SD.betting.clearCache();
  const starOdds = oddsOf(star.id);
  ok(starOdds < O.MIN, star.name + ' is odds-on (' + starOdds + 'x < ' + O.MIN + 'x)');
  const r = say('Bob', '!bet ' + star.name + ' 100');
  eq([r.ok, S().bets.length, player('bob').spiritPoints], [false, 0, EC.JOIN_SP], 'a bet on an odds-on runner is refused and writes nothing');
  has(r.message, 'odds-on', '… with an "odds-on" reply');
}

// =============================================================================
section('B. Bets settle at min(quoted, gate odds) (race-engine#2, lifecycle-concurrency#2)');
// =============================================================================
{
  // Bet on a tired runner, then rest it for free before the gate.
  fresh();
  say('Bob', '!join'); say('Alice', '!join');
  const moss = SD.state.findRunner('moss').runner;
  ok(say('Bob', '!claim moss').ok, 'Bob owns Moss Runner (owned runners always make the field)');
  moss.energy = 20; moss.fatigue = 95; SD.runners.refreshCondition(moss);
  SD.betting.clearCache();
  ok(!!SD.betting.fieldOdds(S()).byId[moss.id], 'Moss Runner is in the next field');
  const b = say('Alice', '!bet moss 200');
  ok(b.ok, 'Alice bets 200 on the Exhausted Moss Runner', b.message);
  const quoted = S().bets[0].odds;
  ok(say('Alice', '!rest moss').ok, '… then rests it for free');
  const after = oddsOf(moss.id);
  ok(after < quoted, 'the rest shortened its preview odds', [quoted, after]);
  const locked = capture(EV.BET_LOCKED);
  const st = say('ModMaya', '!race', MOD);
  locked.off();
  ok(st.ok, 'a mod starts the race', st.message);
  const rec = S().currentRace.record;
  const gate = gateOdds(rec, moss.id);
  const bet = S().bets[0];
  eq(bet.odds, Math.min(quoted, gate), 'the bet is settled at min(quoted, gate odds)');
  ok(bet.odds < quoted, 'Alice no longer holds the stale long price', [quoted, bet.odds]);
  has(st.message, 'at shorter gate odds', "the mod's !race reply says a bet was re-priced");
  ok(S().log.some(function (e) { return e.type === 'bet' && /Odds shortened at the gate: Alice's 200 SP on Moss Runner now pays/.test(e.text); }), 'a log line tells the bettor');
  eq(locked.list.length && locked.list[0].repriced.map(function (x) { return [x.username, x.quoted, x.odds]; }), [['alice', quoted, bet.odds]], 'bet:locked { repriced: [{ quoted, odds }] }');
  const fin = SD.game.endRace();
  const rb = fin.bets[0];
  eq([rb.odds, rb.payout], [bet.odds, rb.won ? SD.betting.payoutFor(200, bet.odds) : 0], 'the payout uses the settled odds');

  // Nothing changes between bet and gate -> the gate price equals the quote (no re-pricing).
  fresh();
  say('Carl', '!join');
  const F0 = field();
  S().raceEffects.push({ type: 'boost', runnerId: F0[1].id, by: 'x', count: 2, paid: 80 }, { type: 'sabotage', runnerId: F0[2].id, by: 'y', count: 1, paid: 60 });
  say('Carl', '!bet ' + F0[1].name + ' 50');
  const q0 = S().bets[0].odds;
  const preview = SD.betting.fieldOdds(S()).entrants.map(function (e) { return e.odds; });
  const s0 = SD.game.startRace();
  eq([S().bets[0].odds, s0.bets.repriced.length], [q0, 0], 'an unchanged race keeps the quoted odds (preview = gate)');
  eq(s0.record.entrants.map(function (e) { return e.odds; }), preview, 'the gate prices queued boosts / sabotages exactly like the paddock');
  SD.game.endRace();

  // The streamer shrinks the field after 8 bets were placed on an 8-runner preview.
  fresh();
  SD.game.updateSettings({ runnerCount: 8 });
  const F8 = field();
  const quotes = {};
  F8.forEach(function (r, i) {
    const u = 'eight' + i;
    say(u, '!join');
    ok(say(u, '!bet ' + r.name + ' 50').ok, u + ' bets on ' + r.name);
    quotes[u] = S().bets[S().bets.length - 1].odds;
  });
  SD.game.updateSettings({ runnerCount: 4 });
  const s4 = SD.game.startRace();
  ok(s4.ok && s4.record.entrants.length === 4, 'the race runs with 4 runners');
  eq(s4.bets.refunded.length, 4, 'the 4 non-starter bets are refunded');
  ok(S().bets.length === 4 && S().bets.every(function (x) { return x.odds === Math.min(quotes[x.username], gateOdds(s4.record, x.runnerId)); }),
    'every other bet pays min(8-runner quote, 4-runner gate odds)', S().bets.map(function (x) { return [quotes[x.username], x.odds, gateOdds(s4.record, x.runnerId)]; }));
  ok(S().bets.reduce(function (a, x) { return a + 1 / x.odds; }, 0) >= 1, 'the locked prices imply >= 100% (no dutching profit)');
  SD.game.endRace();

  // A mod's !race <distance> after bets were quoted at the configured distance.
  fresh();
  SD.game.updateSettings({ distance: 1200 });
  const F12 = field();
  F12.forEach(function (r, i) { say('dist' + i, '!join'); say('dist' + i, '!bet ' + r.name + ' 50'); });
  const q12 = S().bets.map(function (x) { return x.odds; });
  const s24 = say('ModMaya', '!race 2400', MOD);
  const rec24 = S().currentRace.record;
  eq(rec24.distance, 2400, '!race 2400 runs at 2400 m');
  ok(S().bets.every(function (x, i) { return x.odds === Math.min(q12[i], gateOdds(rec24, x.runnerId)); }), 'bets quoted at 1200 m pay min(quote, 2400 m gate odds)', s24.message);
  SD.game.endRace();

  // A runner that becomes odds-on before the gate: the bet is refunded, never paid under MIN.
  fresh();
  say('Dora', '!join');
  const Fd = field();
  ok(say('Dora', '!bet ' + Fd[0].name + ' 100').ok, 'Dora bets on ' + Fd[0].name);
  setAllStats(Fd[0], 64);
  Fd.slice(1).forEach(function (r) { setAllStats(r, 20); });
  const lk = capture(EV.BET_LOCKED);
  const so = SD.game.startRace();
  lk.off();
  ok(gateOdds(so.record, Fd[0].id) < O.MIN, 'the runner is odds-on at the gate');
  eq([S().bets.length, player('dora').spiritPoints, player('dora').stats.bets], [0, EC.JOIN_SP, 0], 'the bet is refunded in full and does not count');
  eq(lk.list[0].refunded.map(function (x) { return x.reason; }), ['oddsOn'], 'bet:locked lists it as an odds-on refund');
  ok(S().log.some(function (e) { return /odds-on at the gate/.test(e.text); }), '… with a log line');
  SD.game.endRace();
}

// =============================================================================
section('C. Odds see the hype tier and queued boosts / sabotages (economy-abuse#5)');
// =============================================================================
{
  eq([SD.race.hypeTempMult(0, 2400), SD.race.hypeTempMult(24, 2400), SD.race.hypeTempMult(30, 2400), SD.race.hypeTempMult(60, 2400)],
    [1, 1, O.HYPE_TEMP.LOUD, O.HYPE_TEMP.FERAL], 'hypeTempMult: 1 below LOUD, then LOUD / FERAL');
  eq([SD.race.hypeTempMult(110, 1200), SD.race.hypeTempMult(110, 2400)], [O.HYPE_TEMP.AWAKENED[1200], O.HYPE_TEMP.AWAKENED[2400]], '… AWAKENED per distance');
  const runners = rosterRunners(8);
  const calm = SD.race.buildEntrants(runners, { distance: 2400, hypeLevel: 0 });
  const awake = SD.race.buildEntrants(runners, { distance: 2400, hypeLevel: 110 });
  const byP = function (list) { return list.slice().sort(function (a, b) { return a.winProb - b.winProb; }); };
  const cLong = byP(calm)[0], aLong = awake.filter(function (e) { return e.runnerId === cLong.runnerId; })[0];
  const cFav = byP(calm)[7], aFav = awake.filter(function (e) { return e.runnerId === cFav.runnerId; })[0];
  ok(aLong.winProb > cLong.winProb && aLong.odds < cLong.odds, 'Forest Awakened shortens the longshot (' + cLong.odds + 'x -> ' + aLong.odds + 'x)');
  ok(aFav.winProb < cFav.winProb, 'and lengthens the favourite (' + cFav.odds + 'x -> ' + aFav.odds + 'x)');
  const calm2 = SD.race.buildEntrants(runners, { distance: 2400, hypeLevel: 20 });
  eq(calm2.map(function (e) { return e.winProb; }), calm.map(function (e) { return e.winProb; }), 'below LOUD the odds are exactly the calibrated hype-0 odds');

  fresh();
  const F = field();
  const fo0 = SD.betting.fieldOdds(S());
  S().hype.value = 110;
  const fo1 = SD.betting.fieldOdds(S());
  ok(fo1 !== fo0 && fo1.entrants.some(function (e, i) { return e.winProb !== fo0.entrants[i].winProb; }), 'the paddock odds follow the hype tier');
  S().hype.value = 0;
  const base = oddsOf(F[2].id);
  S().raceEffects.push({ type: 'boost', runnerId: F[2].id, by: 'x', count: 3, paid: 120 });
  const boosted = oddsOf(F[2].id);
  ok(boosted < base, 'three queued boosts shorten the runner\'s odds (' + base + 'x -> ' + boosted + 'x)');
  S().raceEffects = [{ type: 'sabotage', runnerId: F[2].id, by: 'x', count: 2, paid: 120 }];
  const sabbed = oddsOf(F[2].id);
  ok(sabbed > base, 'two queued pebbles lengthen them (' + base + 'x -> ' + sabbed + 'x)');
  S().raceEffects = [];
  const pts = SD.race.chatEffectPts(SD.race.buildEntrants(F, { distance: 1200 }),
    [{ runnerId: F[0].id, type: 'boost', count: 5 }], 1200);
  eq(Math.round(pts[F[0].id] * 1000) / 1000, Math.round(3 * SD.CONFIG.RACE.CHAT.BOOST * SD.CONFIG.RACE.CHAT.BOOST_TICKS / 150 * 200 * 1000) / 1000,
    'chatEffectPts caps boosts at MAX_BOOSTS_PER_RUNNER (3) like the engine');
}

// =============================================================================
section('D. A mid-race !cheer never sets backing (economy-abuse#2)');
// =============================================================================
{
  fresh();
  say('Mallory', '!join');
  say('Early', '!join');
  const st = SD.game.startRace();
  SD.game.setRaceStatus('running');
  const winner = st.record.results[0];
  const c = say('Mallory', '!cheer ' + winner.name);
  ok(c.ok, 'Mallory cheers the (visible) leader mid-race', c.message);
  eq(player('mallory').backing, { runnerId: null, actions: 0 }, 'backing is untouched by a mid-race cheer');
  const sp0 = player('mallory').spiritPoints;
  SD.game.endRace();
  eq([player('mallory').spiritPoints - sp0, player('mallory').stats.raceVictories, player('mallory').stats.racesParticipated], [0, 0, 0],
    'no backer SP, no race victory, no participation from the race');
  eq(player('mallory').stats.cheers, 1, 'the cheer itself still counts');

  // Control: a cheer before the gate backs the runner.
  const F = field();
  tick(31000);
  ok(say('Early', '!cheer ' + F[0].name).ok, 'a pre-race cheer');
  eq(player('early').backing.runnerId, F[0].id, 'backs the runner for the next race');
}

// =============================================================================
section('E. A bet counts once, when it is settled (economy-abuse#8, economy#7)');
// =============================================================================
{
  const GB = SD.CONFIG.HYPE.GAINS.bet;
  fresh();
  say('Cycler', '!join');
  const F = field();
  const h0 = S().hype.value;
  for (let i = 0; i < 30; i++) {
    say('Cycler', '!bet ' + F[0].name + ' 10');
    say('Cycler', '!bet cancel');
  }
  const p = player('cycler');
  eq([p.spiritPoints, p.stats.bets, p.stats.hypeContributed, S().hype.value - h0], [EC.JOIN_SP, 0, 0, 0],
    '30 bet + cancel cycles: no stats.bets, no hype, no hype credit');
  say('Cycler', '!bet ' + F[0].name + ' 10');
  say('Cycler', '!bet ' + F[1].name + ' 20');
  eq(p.stats.bets, 0, 'a replacement bet does not count either');
  const h1 = S().hype.value;
  SD.game.startRace();
  eq([p.stats.bets, p.stats.hypeContributed, S().hype.value - h1], [0, 0, 0], 'nothing is counted at the gate (the race may still be aborted)');
  const hy = capture(EV.HYPE_CHANGED);
  const fin = SD.game.endRace();
  hy.off();
  eq([p.stats.bets, p.stats.hypeContributed], [1, GB], 'the settled bet counts once when the race finishes (stats.bets, hype credit)');
  const reasons = hy.list.map(function (e) { return e.reason; });
  const betEv = hy.list.filter(function (e) { return e.reason === 'bet'; });
  eq(betEv.map(function (e) { return [e.by, e.delta]; }), [['cycler', GB]], 'one hype:changed for the bet, credited to the bettor');
  ok(reasons.indexOf('afterRace') >= 0 && reasons.indexOf('bet') > reasons.indexOf('afterRace'),
    '… added after the post-race decay, so it builds toward the next race', reasons);
  eq(fin.record.hypeAfter, S().hype.value, 'record.hypeAfter includes the bet hype');

  // High Roller: never for a bet that is cancelled; once the 200 SP bet is settled in a finished race.
  SD.achievements.init();
  fresh();
  say('Roller', '!join');
  const sp = player('roller').spiritPoints;
  const F2 = field();
  const b = say('Roller', '!bet ' + F2[0].name + ' 200');
  ok(b.ok && b.message.indexOf('High Roller') < 0, 'no High Roller in the !bet reply', b.message);
  say('Roller', '!bet cancel');
  eq([player('roller').spiritPoints, player('roller').achievements.indexOf('highRoller')], [sp, -1], 'bet + cancel: no High Roller, no SP');
  say('Roller', '!bet ' + F2[0].name + ' 200');
  const st = SD.game.startRace();
  eq(player('roller').achievements.indexOf('highRoller'), -1, 'no High Roller at the gate either');
  const fin2 = SD.game.endRace();
  ok(player('roller').achievements.indexOf('highRoller') >= 0, 'High Roller unlocks when the race settles the 200 SP bet');
  const entry = S().achievements.unlocked.filter(function (a) { return a.id === 'highRoller'; })[0];
  eq(entry && entry.recordId, st.record.id, '… tagged with the race');
  ok(fin2.achievements.some(function (a) { return a.id === 'highRoller' && a.username === 'roller'; }), '… and listed with its results');

  // An aborted race (streamer END / abortRace) and an interrupted one (reload mid-race) refund the bets
  // and count nothing: no stats.bets, no hype, no High Roller (review batch 4, fix round 1).
  fresh();
  say('Dan', '!join');
  const F3 = field();
  const dan = function () { return player('dan'); };
  const sp3 = dan().spiritPoints;
  const h3 = S().hype.value;
  ok(say('Dan', '!bet ' + F3[1].name + ' 200').ok, 'a 200 SP bet');
  const unl = capture(EV.ACHIEVEMENT_UNLOCKED);
  ok(SD.game.startRace().ok && S().bets.length === 1 && !!S().bets[0].recordId, 'the bet is locked in at the gate');
  SD.game.abortRace();
  unl.off();
  eq([dan().spiritPoints, dan().stats.bets, dan().stats.hypeContributed, S().hype.value - h3, dan().achievements.indexOf('highRoller'), S().bets.length],
    [sp3, 0, 0, 0, -1, 0], 'abortRace: full refund, no stats.bets, no hype, no High Roller');
  eq(unl.list.length, 0, '… and no achievement:unlocked at all');

  const again = say('Dan', '!bet ' + field()[1].name + ' 200'); // an aborted race still used its race number: a new field
  ok(again.ok, 'the same bet again', again.message);
  ok(SD.game.startRace().ok, 'a race starts');
  const copy = JSON.parse(JSON.stringify(S()));
  ok(SD.persistence.recoverInterruptedRace(copy), 'recoverInterruptedRace (reload mid-race)');
  const cd = copy.players.dan;
  eq([cd.spiritPoints, cd.stats.bets, cd.stats.hypeContributed, copy.hype.value - h3, cd.achievements.indexOf('highRoller'), copy.bets.length],
    [sp3, 0, 0, 0, -1, 0], 'an interrupted race: full refund, no stats.bets, no hype, no High Roller');
  SD.game.abortRace();
  SD.achievements.disable();

  // Bet hype never claims a tier the running race lacks (fix round 1): at hype 99 one more bet used to
  // cross Forest Awakened at the gate, after the race had been simulated at 99.
  SD.achievements.init();
  fresh();
  say('Edge', '!join');
  ok(SD.game.addHype(99 - S().hype.value, 'edge').ok && S().hype.value === 99, 'hype 99 before the gate');
  ok(say('Edge', '!bet ' + field()[2].name + ' 20').ok, 'one bet');
  const thr = capture(EV.HYPE_THRESHOLD);
  const s99 = SD.game.startRace();
  thr.off();
  eq([thr.list.length, S().hype.value, s99.record.settingsSnapshot.hypeLevel], [0, 99, 99],
    'startRace crosses no hype threshold: the race runs at 99 and the meter stays at 99');
  eq([player('edge').achievements.indexOf('forestAwakened'), s99.record.summary.forestAwakened], [-1, false],
    'no Forest Awakened unlock for a race that is not awakened');
  SD.game.endRace();
  eq(player('edge').stats.bets, 1, 'the bet counts when settled');
  SD.achievements.disable();
}

// =============================================================================
section('F. Winning bets count only the profit as SP earned (economy-abuse#9)');
// =============================================================================
{
  fresh();
  const F = field();
  const users = F.map(function (r, i) { return 'punter' + i; });
  users.forEach(function (u, i) { say(u, '!join'); say(u, '!bet ' + F[i].name + ' 100'); });
  const spEv = capture(EV.PLAYER_SP);
  SD.game.startRace();
  const fin = SD.game.endRace();
  spEv.off();
  const won = fin.bets.filter(function (x) { return x.won; })[0];
  ok(!!won, 'one bet won');
  const w = player(won.username);
  eq([w.stats.spEarnedTotal, w.stats.spSpentTotal, w.spiritPoints], [EC.JOIN_SP + won.payout - 100, 0, EC.JOIN_SP - 100 + won.payout],
    'the winner: the stake comes back as a refund (spent 0) and only the profit counts as earned');
  const reasons = spEv.list.filter(function (e) { return e.username === won.username; }).map(function (e) { return [e.reason, e.delta]; });
  eq(reasons, [['betStake', 100], ['betWin', won.payout - 100]], 'player:sp: betStake (refund) + betWin (profit)');
  fin.bets.filter(function (x) { return !x.won; }).forEach(function (x) {
    eq([player(x.username).stats.spEarnedTotal, player(x.username).stats.spSpentTotal], [EC.JOIN_SP, 100], x.username + ' (lost): earned unchanged, stake spent');
  });
}

// =============================================================================
section('G. Odds are shown with their decimal (economy#9)');
// =============================================================================
{
  eq([SD.betting.fmtOdds(11.6), SD.betting.fmtOdds(24.5), SD.betting.fmtOdds(10), SD.betting.fmtOdds(2)], ['11.6x', '24.5x', '10.0x', '2.0x'],
    'fmtOdds never rounds to whole numbers');
  fresh();
  say('Longo', '!join');
  const F = field();
  setAllStats(F[3], 12);
  SD.betting.clearCache();
  const o = oddsOf(F[3].id);
  ok(o >= 10, F[3].name + ' is a longshot (' + o + 'x)');
  const r = say('Longo', '!bet ' + F[3].name + ' 200');
  has(r.message, 'at ' + o.toFixed(1) + 'x — pays ' + SD.betting.payoutFor(200, o) + ' SP', 'the reply quotes the exact odds next to the payout');
  has(say('Longo', '!odds').message, F[3].name + ' ' + o.toFixed(1) + 'x', '!odds shows the exact odds');
}

// =============================================================================
section('H. Aborted / interrupted races leave no gate moods (director-state#2)');
// =============================================================================
{
  fresh();
  S().hype.value = 120;
  const before = {};
  S().runners.forEach(function (r) { before[r.id] = r.mood; });
  const st = SD.game.startRace();
  const gateMoods = st.record.entrants.map(function (e) { return e.mood; });
  ok(gateMoods.some(function (m) { return m === 'Chaotic' || m === 'Fired Up'; }), 'the gate rolled Chaotic / Fired Up moods onto the entrants', gateMoods);
  ok(S().runners.every(function (r) { return r.mood === before[r.id]; }), 'the live runners keep their moods while the race runs');
  SD.game.abortRace();
  ok(S().runners.every(function (r) { return r.mood === before[r.id]; }), 'after abortRace every runner has its pre-gate mood');
  // Reload mid-race.
  const st2 = SD.game.startRace();
  ok(st2.ok, 'another race starts');
  const copy = JSON.parse(JSON.stringify(S()));
  SD.persistence.recoverInterruptedRace(copy);
  ok(copy.currentRace === null && copy.runners.every(function (r) { return r.mood === before[r.id]; }), 'an interrupted race (reload) leaves the pre-gate moods too');
  const fin = SD.game.endRace();
  ok(fin.record.results.every(function (res) { return SD.state.runnerById(res.runnerId).mood === res.moodAfter; }), 'a finished race sets each runner\'s moodAfter as before');
}

// =============================================================================
section('I. Command fixes (commands#5, #6, #7, #8, economy-abuse#11)');
// =============================================================================
{
  // commands#5: info-only !bet / !ribbon count like read-only commands and stamp no cooldown.
  fresh();
  say('Info', '!join');
  say('Info', '!claim moss');
  const p = player('info');
  const F = field();
  tick(60000);
  const c0 = p.stats.commands;
  const r1 = SD.processCommand('info', '!bet', { source: 'twitch' });
  tick(1000);
  const r2 = SD.processCommand('info', '!ribbon', { source: 'twitch' });
  tick(1000);
  SD.processCommand('info', '!status', { source: 'twitch' });
  ok(r1.ok && r2.ok, 'no-argument !bet and !ribbon answer', [r1.message, r2.message]);
  eq(r1.cooldownMs, 0, 'the info line reports no cooldown');
  eq(p.stats.commands - c0, 1, '!bet, !ribbon and !status inside one READONLY_ACTIVITY_S window count once');
  tick(1000);
  const real = SD.processCommand('info', '!bet ' + F[0].name + ' 50', { source: 'twitch' });
  ok(real.ok, 'a real bet right after the info line is not refused as "cooling down"', real.message);
  eq(p.stats.commands - c0, 2, 'the real bet counts');

  // commands#6: a near-full runner cannot be snacked.
  fresh();
  say('Snacker', '!join');
  const moss = SD.state.findRunner('moss').runner;
  moss.energy = moss.maxEnergy - 0.25;
  const s1 = say('Snacker', '!snack moss');
  eq([s1.ok, player('snacker').spiritPoints, moss.daily.snacks || 0], [false, EC.JOIN_SP, 0], 'a snack that would add < 1 energy is refused: no SP, no daily slot');
  has(s1.message, 'full of energy', '… "already full of energy"');
  moss.energy = moss.maxEnergy - 1;
  const s2 = say('Snacker', '!snack moss');
  eq([s2.ok, player('snacker').spiritPoints, moss.daily.snacks], [true, EC.JOIN_SP - EC.SNACK_COST, 1], 'exactly 1 energy short: the snack is sold');
  has(s2.message, 'Energy +1', '… for +1 energy');

  // commands#7: a mod's !race only starts with no argument or a supported distance.
  fresh();
  SD.game.updateSettings({ distance: 2400 });
  ['!race 1500', '!race soon', '!race when', '!race 2000 laps', '!race go now'].forEach(function (t) {
    const r = say('ModMaya', t, MOD);
    ok(!r.ok && !S().currentRace, '"' + t + '" is refused and starts nothing', r.message);
  });
  ['!race next?', '!race info?', '!race status', '!race ?'].forEach(function (t) {
    const r = say('ModMaya', t, MOD);
    ok(r.ok && !S().currentRace && /No race running/.test(r.message), '"' + t + '" only shows the status line', r.message);
  });
  has(say('ModMaya', '!race 1500', MOD).message, '1500 m is not a race distance', 'an unsupported distance says so');
  has(say('ModMaya', '!race soon', MOD).message, '!race <1200|1600|2000|2400>', 'the refusal carries the usage');
  const st1 = say('ModMaya', '!race 2000m', MOD);
  ok(st1.ok && S().currentRace && S().currentRace.record.distance === 2000, '!race 2000m starts a 2000 m race', st1.message);
  SD.game.abortRace();
  const st2 = say('ModMaya', '!race 1600 m', MOD);
  ok(st2.ok && S().currentRace && S().currentRace.record.distance === 1600, '!race 1600 m starts a 1600 m race');
  SD.game.abortRace();
  const st3 = say('ModMaya', '!race', MOD);
  ok(st3.ok && S().currentRace && S().currentRace.record.distance === 2400, '!race starts at the configured distance');
  SD.game.abortRace();
  const v = say('Viewer', '!race 1500');
  ok(v.ok && !S().currentRace, 'a viewer\'s !race <anything> still just shows the status', v.message);

  // commands#8: !rest reports the hype change that really happened.
  fresh();
  say('Rester', '!join');
  S().hype.value = 2;
  const rr = say('Rester', '!rest moss');
  ok(rr.ok, '!rest moss', rr.message);
  has(rr.message, 'Hype -2', 'the reply says Hype -2 (hype was 2)');
  eq([rr.effects.filter(function (e) { return e.type === 'hype'; })[0].delta, S().hype.value], [-2, 0], 'the hype effect carries the real delta');
  const r0 = say('Rester', '!rest glow');
  ok(r0.ok && r0.message.indexOf('Hype') < 0, 'at hype 0 the reply does not claim a hype change', r0.message);
  eq(r0.effects.filter(function (e) { return e.type === 'hype'; })[0].delta, 0, '… and the effect delta is 0');

  // economy-abuse#11: the per-race pebble cap counts only the next race's field.
  fresh();
  SD.game.updateSettings({ runnerCount: 4 });
  const Fs = field();
  const outside = S().runners.filter(function (r) { return Fs.indexOf(r) < 0; });
  ok(outside.length >= 5, 'at least 5 runners are outside the next field');
  ['a1', 'a2', 'a3', 'a4'].forEach(function (u, i) {
    say(u, '!join');
    ok(say(u, '!sabotage ' + outside[i].name).ok, u + ' parks a pebble on ' + outside[i].name + ' (not in the next race)');
  });
  say('honest', '!join');
  ok(say('honest', '!sabotage ' + Fs[0].name).ok, 'a pebble on a next-race runner is still accepted (4 parked pebbles do not count)');
  ['h2', 'h3', 'h4'].forEach(function (u, i) { say(u, '!join'); ok(say(u, '!sabotage ' + Fs[1 + (i % 2)].name).ok, u + ' sabotages ' + Fs[1 + (i % 2)].name); });
  say('late', '!join');
  const full = say('late', '!sabotage ' + Fs[3].name);
  eq(full.ok, false, 'the fifth pebble for the next race is refused');
  has(full.message, 'next race has them all', '… "the next race has them all"');
  ok(say('late', '!sabotage ' + outside[4].name).ok, 'a pebble on a runner outside the next race is still accepted');

  // SD.game.raceEffectsFor: at most MAX_SABOTAGE_PER_RACE pebbles per race, the rest wait (split by count).
  const q = [
    { type: 'sabotage', runnerId: 'A', by: 'u1', count: 1, paid: 60 },
    { type: 'boost', runnerId: 'A', by: 'u2', count: 2, paid: 80 },
    { type: 'sabotage', runnerId: 'B', by: 'u3', count: 2, paid: 120 },
    { type: 'sabotage', runnerId: 'Z', by: 'u4', count: 1, paid: 60 },
    { type: 'sabotage', runnerId: 'C', by: 'u5', count: 2, paid: 120 }
  ];
  const sp = SD.game.raceEffectsFor(q, ['A', 'B', 'C']);
  eq(sp.used.map(function (e) { return [e.type, e.runnerId, e.count, e.paid]; }),
    [['sabotage', 'A', 1, 60], ['boost', 'A', 2, 80], ['sabotage', 'B', 2, 120], ['sabotage', 'C', 1, 60]], 'raceEffectsFor: used (4 pebbles, C split)');
  eq(sp.rest.map(function (e) { return [e.type, e.runnerId, e.count, e.paid]; }),
    [['sabotage', 'Z', 1, 60], ['sabotage', 'C', 1, 60]], 'raceEffectsFor: the rest stays queued (paid split by count)');

  // A real race whose field has 5 queued pebbles uses 4; the fifth waits.
  fresh();
  const F5 = field();
  S().raceEffects = [
    { type: 'sabotage', runnerId: F5[0].id, by: 'x1', count: 2, paid: 120 },
    { type: 'sabotage', runnerId: F5[1].id, by: 'x2', count: 2, paid: 120 },
    { type: 'sabotage', runnerId: F5[2].id, by: 'x3', count: 1, paid: 60 }
  ];
  const race5 = SD.game.startRace();
  const usedSab = race5.record.inputs.raceEffects.filter(function (e) { return e.type === 'sabotage'; }).reduce(function (a, e) { return a + e.count; }, 0);
  eq([usedSab, S().raceEffects.length, S().raceEffects[0] && S().raceEffects[0].runnerId], [4, 1, F5[2].id], 'the race takes 4 pebbles, the fifth stays queued');
  SD.game.endRace();
}

// =============================================================================
section('J. Season rollover resets the snack counter (director-state#7)');
// =============================================================================
{
  fresh();
  say('Feeder', '!join');
  const moss = SD.state.findRunner('moss').runner;
  moss.daily = { snacks: EC.SNACKS_PER_DAY };
  S().season.day = S().season.daysPerSeason;
  const nd = SD.game.nextDay();
  ok(nd.seasonEnded && S().season.day === 1, 'NEXT DAY on the last day starts a new season');
  eq(moss.daily.snacks, 0, 'the snack counter is reset for Day 1');
  moss.energy = 40;
  ok(say('Feeder', '!snack moss').ok, '!snack works on Day 1 of the new season');
  moss.daily = { snacks: EC.SNACKS_PER_DAY };
  SD.game.resetSeason();
  eq(moss.daily.snacks, 0, 'RESET SEASON resets it too');
}

// -----------------------------------------------------------------------------
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
