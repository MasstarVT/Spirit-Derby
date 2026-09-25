#!/usr/bin/env node
/*
 * Spirit Derby - tools/community-test.js
 * Assertion tests for M5 community systems (plan sections 4, 6.4, 6.5, 6.7):
 *   betting   odds from the next field, place / replace / cancel / limits / !bet all, one bet per
 *             player, SP taken at once, locked odds, resolve math + stats, refunds on abort / new
 *             day / reset day / season end / non-starters, lock during a race
 *   effects   !boost / !snack / !sabotage costs, caps, own-runner rule, cooldown, public line,
 *             queued effects consumed by startRace and visible in record events, abort restores
 *   ribbon    named colours / #hex / off / same colour / requires a runner
 *   commands  mod-only !race / !event vs viewers, !hype / !odds / !bets / !achievements / !help
 *   achievements  unlock exactly once with SP, the reply mentions it, Hype Train window,
 *             synthetic race checks (Comeback Kid, Karma, Longshot ...), a scripted session with
 *             at least 8 different achievements, a real Karma backfire
 *   seasons   summary fields, rollback rules, history entry, refunds before the SP carry,
 *             achievements kept, automatic end after the last day, admin RESET SEASON
 *
 *   node tools/community-test.js [--verbose] [--transcript]
 *
 * --transcript also prints a readable chat transcript of a scripted stream (join x4, claim, bets,
 * boost, sabotage, race, results with payouts and achievements, 7 days to the season summary).
 * SD.clock is frozen (advance with tick(ms)). Exit code 1 on failure.
 */
'use strict';

const SD = require('./load-core.js');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;
const TRANSCRIPT = process.argv.indexOf('--transcript') >= 0;

// -----------------------------------------------------------------------------
// Tiny assert helper (same shape as the other suites so run-tests.js can tally it)
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
const EV = SD.EVENTS;
const EC = SD.CONFIG.ECONOMY;
const CH = SD.CONFIG.RACE.CHAT;
const MOD = { source: 'twitch', isMod: true };
const ADMIN = { source: 'admin', isMod: true };

function fresh(opts) {
  const rt = SD.state.runtime;
  rt.cooldowns = {};
  rt.runnerCooldowns = {};
  rt.chatFeed = [];
  rt.nervousCheers = {};
  rt.activity = {};
  rt.hypeRecent = {};
  SD.state.set(SD.state.create(Object.assign({ seedSalt: SALT, dayEventId: 'clearSkies' }, opts || {})));
  SD.game.init();
  SD.betting.clearCache();
  tick(60000);
  return SD.state.get();
}
function S() { return SD.state.get(); }
// Every line is 11 s after the previous one (past the 10 s per-user cooldown).
function say(user, text, opts) { tick(11000); return SD.processCommand(user, text, opts); }
function player(u) { return SD.players.get(S(), u); }
function runner(q) { return SD.state.findRunner(q).runner; }
function capture(name) {
  const list = [];
  const off = SD.bus.on(name, function (p) { list.push(p); });
  return { list: list, off: off };
}
function field() { return SD.betting.fieldOdds(S()).field; }
function oddsOf(id) { const o = SD.betting.odds(S(), id); return o ? o.odds : null; }
function race(opts) {
  const st = SD.game.startRace(opts || {});
  if (!st.ok) return { ok: false, message: st.message };
  return SD.game.endRace();
}
function unlockedIds(u) { return (player(u) && player(u).achievements) || []; }

ok(!!SD.betting && !!SD.achievements, 'SD.betting and SD.achievements are loaded (tools/load-core.js order)');
ok(SD.testing.loadedFiles.indexOf('js/betting.js') >= 0 && SD.testing.loadedFiles.indexOf('js/achievements.js') >= 0, 'betting.js + achievements.js in the core load order');

// =============================================================================
section('betting: odds for the next field');
// =============================================================================
{
  SD.achievements.disable(); // pure SP arithmetic first; achievements get their own sections
  fresh();
  const fo = SD.betting.fieldOdds(S());
  eq(fo.field.length, 4, 'the next field has settings.runnerCount (4) runners');
  eq(fo.field.map(function (r) { return r.id; }), SD.game.previewField().map(function (r) { return r.id; }), 'field = SD.game.previewField() (lane order)');
  ok(SD.betting.fieldOdds(S()) === fo, 'fieldOdds is cached while nothing changes');
  const ents = SD.race.buildEntrants(SD.game.previewField(), {
    distance: S().settings.distance, hypeLevel: S().hype.value, dayEvent: SD.state.dayEvent(), cheerBonus: {}
  });
  eq(fo.entrants.map(function (e) { return e.odds; }), ents.map(function (e) { return e.odds; }), 'odds = SD.race.buildEntrants on the preview field');
  const o = SD.betting.odds(S(), fo.field[0].id);
  eq([o.odds, o.winProb], [ents[0].odds, ents[0].winProb], 'odds(state, runnerId) -> { odds, winProb }');
  const outsider = S().runners.filter(function (r) { return !fo.byId[r.id]; })[0];
  eq(SD.betting.odds(S(), outsider.id), null, 'a runner outside the next field has no odds');
  eq(fo.favourite.odds, Math.min.apply(null, ents.map(function (e) { return e.odds; })), 'favourite = lowest odds');
  // Queued cheers count toward the preview odds exactly like startRace's cheerBonus.
  S().raceEffects.push({ type: 'cheer', runnerId: fo.field[3].id, by: 'x', count: 40 });
  const fo2 = SD.betting.fieldOdds(S());
  ok(fo2 !== fo && fo2.byId[fo.field[3].id].odds < fo.byId[fo.field[3].id].odds, 'queued cheers invalidate the cache and shorten the odds',
    [fo.byId[fo.field[3].id].odds, fo2.byId[fo.field[3].id].odds]);
  eq(SD.betting.payoutFor(10, 2.3), 23, 'payoutFor(10, 2.3) = 23 (no float dust)');
  eq(SD.betting.payoutFor(33, 1.7), 56, 'payoutFor(33, 1.7) = floor(56.1) = 56');
}

// =============================================================================
section('betting: place, limits, replace, cancel, !bet all');
// =============================================================================
{
  fresh();
  ['FoxFan', 'MothMom', 'AcornAndy', 'Lurker'].forEach(function (u) { say(u, '!join'); });
  const F = field();
  const A = F[0], B = F[1], C = F[2];
  const outsider = S().runners.filter(function (r) { return F.indexOf(r) < 0; })[0];

  const noJoin = say('Stranger', '!bet ' + A.name + ' 50');
  eq([noJoin.ok, S().bets.length], [false, 0], '!bet needs !join first');
  const r1 = say('FoxFan', '!bet ' + A.name + ' 5');
  eq(r1.ok, false, 'below the minimum is refused');
  has(r1.message, 'minimum bet is ' + EC.BET_MIN, '… "minimum bet is 10"');
  const r2 = say('FoxFan', '!bet ' + A.name + ' 300');
  has(r2.message, 'maximum bet is ' + EC.BET_MAX, 'above the maximum is refused');
  player('lurker').spiritPoints = 40;
  const r3 = say('Lurker', '!bet ' + A.name + ' 50');
  has(r3.message, 'Not enough Spirit Points', 'insufficient funds refused');
  eq([player('lurker').spiritPoints, S().bets.length], [40, 0], 'a refused bet writes nothing');
  const r4 = say('FoxFan', '!bet ' + outsider.name + ' 50');
  has(r4.message, "isn't in the next race", 'a runner outside the next field is refused');
  const r5 = say('FoxFan', '!bet ' + A.name);
  eq(r5.ok, false, '!bet <runner> without an amount shows the usage');

  const placed = capture(EV.BET_PLACED);
  const hype0 = S().hype.value;
  const oddsA = oddsOf(A.id);
  const b1 = say('FoxFan', '!bet ' + A.name + ' 50');
  placed.off();
  ok(b1.ok, '!bet <runner> <amount> ok', b1.message);
  eq(player('foxfan').spiritPoints, 150, 'SP deducted immediately (200 - 50)');
  eq(S().bets.length, 1, 'one open bet');
  const bet = S().bets[0];
  eq([bet.username, bet.runnerId, bet.amount, bet.odds], ['foxfan', A.id, 50, oddsA], 'bet { username, runnerId, amount, odds locked at placement }');
  has(b1.message, 'pays ' + SD.betting.payoutFor(50, oddsA) + ' SP', 'reply shows the potential payout');
  eq(player('foxfan').stats.bets, 1, 'stats.bets counts the bet');
  eq(player('foxfan').stats.spSpentTotal, 50, 'stats.spSpentTotal += 50');
  eq(S().hype.value - hype0, SD.CONFIG.HYPE.GAINS.bet, 'hype +1 for a bet');
  eq(placed.list.length, 1, 'bet:placed emitted');
  ok(b1.effects.some(function (e) { return e.type === 'bet' && e.amount === 50; }), 'effects include { type:"bet" }');

  const b2 = say('FoxFan', '!bet 80 ' + B.name);
  ok(b2.ok, '!bet <amount> <runner> also works', b2.message);
  has(b2.message, 'was refunded', 'replacing mentions the refund');
  eq(S().bets.length, 1, 'still one open bet per player');
  eq([S().bets[0].runnerId, S().bets[0].amount], [B.id, 80], 'the new bet replaced the old one');
  eq(player('foxfan').spiritPoints, 120, 'old 50 refunded, new 80 taken');
  eq(player('foxfan').stats.bets, 1, 'a replacement is not counted as another bet');
  eq([player('foxfan').stats.spSpentTotal, player('foxfan').stats.spEarnedTotal], [80, 200], 'a refund reverses the spend (not "SP earned")');
  eq(say('FoxFan', '!bet ' + B.name + ' 80').ok, false, 'an identical bet is refused');

  const b3 = say('FoxFan', '!bet 30');
  ok(b3.ok && S().bets[0].runnerId === B.id && S().bets[0].amount === 30, '!bet <amount> reuses your bet\'s runner', b3.message);
  has(say('FoxFan', '!bet').message, 'Your bet: 30 SP on ' + B.name, '!bet alone shows your bet');

  player('mothmom').spiritPoints = 180;
  const all1 = say('MothMom', '!bet ' + C.name + ' all');
  ok(all1.ok, '!bet <runner> all', all1.message);
  eq([S().bets[1].amount, player('mothmom').spiritPoints], [180, 0], '"all" = your whole balance when under the max');
  player('acornandy').spiritPoints = 400;
  const all2 = say('AcornAndy', '!bet all ' + A.name);
  ok(all2.ok, '!bet all <runner>', all2.message);
  eq([S().bets[2].amount, player('acornandy').spiritPoints], [EC.BET_MAX, 150], '"all" is capped at 250');
  player('lurker').spiritPoints = 5;
  has(say('Lurker', '!bet ' + A.name + ' all').message, 'at least ' + EC.BET_MIN + ' SP', '"all" with under 10 SP is refused');
  // "all" counts the stake of the bet it replaces
  const all3 = say('MothMom', '!bet ' + A.name + ' all');
  eq([all3.ok, S().bets.filter(function (b) { return b.username === 'mothmom'; })[0].amount, player('mothmom').spiritPoints], [true, 180, 0],
    '"all" while holding a bet = balance + the refunded stake');

  const cancel = say('FoxFan', '!bet cancel');
  ok(cancel.ok, '!bet cancel', cancel.message);
  eq([player('foxfan').spiritPoints, SD.betting.betOf(S(), 'foxfan')], [200, null], 'cancel refunds the stake (all 200 SP back)');
  eq(say('FoxFan', '!bet cancel').ok, false, 'nothing left to cancel');

  const o = SD.betting.open(S());
  eq([o.count, o.total], [2, 430], 'open(state) -> { count, total }');
  eq(o.byRunner[A.id].count, 2, 'open(state).byRunner counts per runner');
}

// =============================================================================
section('betting: resolve at the finish (winners paid at locked odds, losers lose)');
// =============================================================================
{
  fresh();
  const users = ['Bettor1', 'Bettor2', 'Bettor3', 'Bettor4'];
  users.forEach(function (u) { say(u, '!join'); });
  const F = field();
  const amounts = [40, 60, 100, 150];
  users.forEach(function (u, i) { ok(say(u, '!bet ' + F[i].name + ' ' + amounts[i]).ok, u + ' bets ' + amounts[i] + ' on ' + F[i].name); });
  const locked = {};
  S().bets.forEach(function (b) { locked[b.username] = b.odds; });
  const before = {};
  users.forEach(function (u) { before[u.toLowerCase()] = player(u).spiritPoints; });
  const resolved = capture(EV.BET_RESOLVED);
  const fin = capture(EV.RACE_FINISHED);
  const start = SD.game.startRace();
  ok(start.ok, 'race starts');
  eq(S().bets.every(function (b) { return b.recordId === start.record.id; }), true, 'startRace locks the bets to the race (recordId)');
  const locked1 = say('Bettor1', '!bet ' + F[1].name + ' 20');
  eq([locked1.ok, locked1.locked], [false, true], '!bet is locked during the race');
  has(say('Bettor1', '!odds').message, 'bets locked', '!odds shows the live race odds');
  has(say('Bettor1', '!bets').message, 'riding on this race', '!bets during the race');
  const res = SD.game.endRace();
  resolved.off(); fin.off();
  const winId = res.record.results[0].runnerId;
  eq(res.bets.length, 4, 'finishRace returns the resolved bets');
  ok(res.record.bets === res.bets || JSON.stringify(res.record.bets) === JSON.stringify(res.bets), 'record.bets holds them');
  eq(fin.list[0].bets.length, 4, 'race:finished payload carries the bets');
  let good = 0;
  res.bets.forEach(function (b) {
    const won = b.runnerId === winId;
    const expPay = won ? SD.betting.payoutFor(b.amount, locked[b.username]) : 0;
    if (b.won === won && b.payout === expPay && b.odds === locked[b.username] && b.net === expPay - b.amount &&
        player(b.username).spiritPoints === before[b.username] + expPay &&
        player(b.username).stats.betsWon === (won ? 1 : 0)) good++;
  });
  eq(good, 4, 'each bet: won iff its runner won, payout = floor(amount x locked odds), balance + payout, stats.betsWon');
  eq(res.bets.filter(function (b) { return b.won; }).length, 1, 'exactly one winning bet');
  eq(resolved.list.length, 1, 'bet:resolved emitted once');
  eq([resolved.list[0].winners, resolved.list[0].losers, resolved.list[0].totalStaked], [1, 3, 350], 'bet:resolved { winners, losers, totalStaked }');
  eq(S().bets.length, 0, 'no open bets after the race');
  ok(S().log.some(function (e) { return e.type === 'bet' && /^Bets paid: /.test(e.text); }), 'a "Bets paid" log line');
}

// =============================================================================
section('betting: refunds (abort, new day, reset day, season end, non-starters)');
// =============================================================================
{
  fresh();
  say('Refundo', '!join');
  const A = field()[0];
  say('Refundo', '!bet ' + A.name + ' 100');
  eq(player('refundo').spiritPoints, 100, 'bet taken');
  SD.game.startRace();
  const ab = SD.game.abortRace();
  eq([ab.refunded, player('refundo').spiritPoints, S().bets.length], [1, 200, 0], 'abortRace refunds the bet');

  say('Refundo', '!bet ' + field()[0].name + ' 70');
  const nd = SD.game.nextDay();
  eq([nd.refunded, player('refundo').spiritPoints, S().bets.length], [1, 200, 0], 'nextDay refunds open bets');

  say('Refundo', '!bet ' + field()[0].name + ' 60'); // first command of day 2 also pays the +50 daily bonus
  const bal = player('refundo').spiritPoints;
  const rd = SD.game.resetDay();
  eq([rd.refunded, player('refundo').spiritPoints], [1, bal + 60], 'resetDay refunds open bets');

  say('Refundo', '!bet ' + field()[0].name + ' 100');
  const preSp = player('refundo').spiritPoints + 100;
  const rs = SD.game.resetSeason();
  eq(rs.summary.refundedBets, 1, 'season end refunds open bets');
  eq(player('refundo').spiritPoints, EC.SEASON_BASE_SP + Math.floor(preSp * EC.SEASON_CARRY), 'refund happens before the 10% carry');

  // A bet on a runner that drops out of the field is refunded at the gate.
  fresh();
  say('Gatey', '!join');
  const f4 = field().map(function (r) { return r.id; });
  SD.game.updateSettings({ runnerCount: 2 });
  const f2 = SD.game.previewField().map(function (r) { return r.id; });
  SD.game.updateSettings({ runnerCount: 4 });
  const dropId = f4.filter(function (id) { return f2.indexOf(id) < 0; })[0];
  say('Gatey', '!bet ' + SD.state.runnerById(dropId).name + ' 50');
  SD.game.updateSettings({ runnerCount: 2 });
  const st = SD.game.startRace();
  eq([st.ok, S().bets.length, player('gatey').spiritPoints], [true, 0, 200], 'a non-starter bet is refunded when the gates open');
  ok(S().log.some(function (e) { return /is not in this race/.test(e.text); }), '… with a log line');
  SD.game.endRace();
}

// =============================================================================
section('!boost: cost, per-runner cap, own runner allowed, queued for the next race');
// =============================================================================
{
  fresh();
  ['FoxFan', 'MothMom', 'AcornAndy'].forEach(function (u) { say(u, '!join'); });
  const F = field();
  say('FoxFan', '!claim ' + F[0].name);
  const T = F[1];
  const b1 = say('FoxFan', '!boost ' + T.name);
  ok(b1.ok, '!boost <runner>', b1.message);
  has(b1.message, T.name, 'reply names the runner');
  has(b1.message, '2 more boosts allowed', 'reply says how many boosts remain');
  eq(player('foxfan').spiritPoints, 200 - EC.BOOST_COST, 'boost costs 40 SP');
  eq(S().raceEffects, [{ type: 'boost', runnerId: T.id, by: 'foxfan', count: 1, paid: EC.BOOST_COST }], 'queued { type:"boost", runnerId, by, count, paid }');
  eq(player('foxfan').stats.boosts, 1, 'stats.boosts');
  say('FoxFan', '!boost ' + T.name);
  const b3 = say('FoxFan', '!boost ' + T.name);
  has(b3.message, 'last boost allowed', 'third boost is the last one');
  eq([S().raceEffects.length, S().raceEffects[0].count, S().raceEffects[0].paid], [1, 3, 120], 'same viewer + runner merges (count 3, paid 120)');
  const b4 = say('MothMom', '!boost ' + T.name);
  eq([b4.ok, player('mothmom').spiritPoints], [false, 200], 'max ' + CH.MAX_BOOSTS_PER_RUNNER + ' boosts per runner per race (no SP taken)');
  const own = say('FoxFan', '!boost');
  ok(own.ok && S().raceEffects.some(function (e) { return e.type === 'boost' && e.runnerId === F[0].id; }), 'boosting your own runner is allowed', own.message);
  player('acornandy').spiritPoints = 10;
  const poor = say('AcornAndy', '!boost ' + F[2].name);
  has(poor.message, 'costs ' + EC.BOOST_COST + ' SP', 'insufficient SP refused');
  eq(say('Nobody', '!boost ' + F[2].name).ok, false, '!boost needs !join');
}

// =============================================================================
section('!snack: +10 energy, 2 per runner per day, full energy refused');
// =============================================================================
{
  fresh();
  say('Muncher', '!join');
  const T = field()[0];
  T.energy = 50;
  const s1 = say('Muncher', '!snack ' + T.name);
  ok(s1.ok, '!snack <runner>', s1.message);
  eq([T.energy, T.daily.snacks, player('muncher').spiritPoints], [50 + EC.SNACK_ENERGY, 1, 200 - EC.SNACK_COST], 'energy +10, daily.snacks 1, 25 SP');
  has(s1.message, '1 snack left today', 'reply says snacks left');
  T.energy = T.maxEnergy - 3;
  say('Muncher', '!snack ' + T.name);
  eq(T.energy, T.maxEnergy, 'energy is clamped to max');
  T.energy = 40;
  const s3 = say('Muncher', '!snack ' + T.name);
  eq([s3.ok, T.energy, player('muncher').spiritPoints], [false, 40, 200 - 2 * EC.SNACK_COST], 'max ' + EC.SNACKS_PER_DAY + ' snacks per runner per day');
  const U2 = field()[1];
  U2.energy = U2.maxEnergy;
  has(say('Muncher', '!snack ' + U2.name).message, 'full of energy', 'a full runner is refused');
  SD.game.nextDay();
  T.energy = 40;
  ok(say('Muncher', '!snack ' + T.name).ok, 'snacks reset on the next day');
}

// =============================================================================
section('!sabotage: cost, own runner, cooldown, caps, public line, decided at the gate');
// =============================================================================
{
  fresh();
  ['FoxFan', 'MothMom', 'AcornAndy', 'WispWatcher'].forEach(function (u) { say(u, '!join'); });
  const F = field();
  say('MothMom', '!claim ' + F[2].name);
  const T = F[0];
  const selfSab = say('MothMom', '!sabotage ' + F[2].name);
  eq([selfSab.ok, player('mothmom').spiritPoints], [false, 200], 'you cannot sabotage your own runner');
  has(selfSab.message, "can't sabotage your own runner", '… friendly reply');
  const chat = capture(EV.CHAT_MESSAGE);
  const s1 = say('MothMom', '!sabotage ' + T.name);
  chat.off();
  ok(s1.ok, '!sabotage <runner> (the own-runner refusal did not start the cooldown)', s1.message);
  has(s1.message, 'decided at the gate', 'reply: the outcome is decided at the gate');
  eq(player('mothmom').spiritPoints, 200 - EC.SABOTAGE_COST, 'sabotage costs 60 SP');
  eq(S().raceEffects.filter(function (e) { return e.type === 'sabotage'; }), [{ type: 'sabotage', runnerId: T.id, by: 'mothmom', count: 1, paid: EC.SABOTAGE_COST }], 'queued { type:"sabotage", by }');
  eq(player('mothmom').stats.sabotages, 1, 'stats.sabotages');
  const kinds = chat.list.map(function (m) { return m.kind; });
  eq(kinds, ['user', 'reply', 'system'], 'the public system line comes right after the reply');
  eq(chat.list[2] && chat.list[2].text, '\u{1FAA8} MothMom slipped a pebble into ' + T.name + "'s shoe…", 'public line "MothMom slipped a pebble into …\'s shoe…"');

  const cd = say('MothMom', '!sabotage ' + F[1].name);
  eq([cd.ok, cd.cooldown], [false, true], 'second sabotage within 10 minutes is on cooldown');
  has(cd.message, 'cooling down', '… cooldown reply');
  tick(SD.CONFIG.COOLDOWNS.SABOTAGE_S * 1000);
  ok(say('MothMom', '!sabotage ' + F[1].name).ok, 'allowed again after the 10-minute cooldown');
  ok(say('FoxFan', '!sabotage ' + T.name).ok, 'a second viewer may sabotage the same target');
  const cap = say('AcornAndy', '!sabotage ' + T.name);
  eq([cap.ok, player('acornandy').spiritPoints], [false, 200], 'max ' + CH.MAX_SABOTAGE_PER_TARGET + ' sabotages per target');
  ok(say('AcornAndy', '!sabotage ' + F[3].name).ok, 'fourth pebble on another runner');
  const full = say('WispWatcher', '!sabotage ' + F[1].name);
  eq(full.ok, false, 'max ' + CH.MAX_SABOTAGE_PER_RACE + ' sabotages per race');
  has(full.message, 'only hides ' + CH.MAX_SABOTAGE_PER_RACE + ' pebbles', '… per-race cap reply');
  eq(SD.commands.get('sabotage').lockedDuringRace, true, '!sabotage is race-locked');
}

// =============================================================================
section('queued effects are consumed by startRace and appear in the race record');
// =============================================================================
{
  fresh();
  ['FoxFan', 'MothMom', 'Admin'].forEach(function (u) { say(u, '!join'); });
  const F = field();
  const T = F[1];
  const outside = S().runners.filter(function (r) { return F.indexOf(r) < 0; })[0];
  say('FoxFan', '!boost ' + T.name);
  say('FoxFan', '!boost ' + T.name);
  say('MothMom', '!sabotage ' + T.name);
  say('MothMom', '!cheer ' + T.name);
  tick(700000);
  const outBoost = say('FoxFan', '!boost ' + outside.name);
  has(outBoost.message, 'not in the next field', 'boosting a runner outside the next field says it waits');
  const queuedBefore = JSON.parse(JSON.stringify(S().raceEffects));
  const st = SD.game.startRace();
  ok(st.ok, 'race starts');
  const rec = st.record;
  eq(S().raceEffects.map(function (e) { return e.runnerId; }), [outside.id], 'effects for the field are consumed; others stay queued');
  const inputs = rec.inputs.chatEffects;
  eq(inputs.filter(function (e) { return e.type === 'boost' && e.runnerId === T.id; }).length, 2, 'record.inputs.chatEffects: 2 boosts');
  eq(inputs.filter(function (e) { return e.type === 'sabotage'; }).map(function (e) { return e.by; }), ['MothMom'], '… and the sabotage (by display name)');
  const chatEv = rec.events.filter(function (e) { return e.kind === 'chat' && e.runnerId === T.id; });
  eq(chatEv.filter(function (e) { return e.data.type === 'boost'; }).length, 2, 'record events: both boosts (fired or fizzled) with the viewer name');
  ok(chatEv.filter(function (e) { return e.data.type === 'boost'; }).every(function (e) { return e.data.by === 'FoxFan' && e.text.indexOf('FoxFan') >= 0; }), '… by FoxFan');
  eq(chatEv.filter(function (e) { return e.data.type === 'sabotage'; }).length, 1, 'record events: the sabotage (stuck, backfired or fizzled)');
  eq(chatEv.filter(function (e) { return e.data.type === 'cheer'; }).length, 1, 'record events: the cheer at the gate');
  const ab = SD.game.abortRace();
  ok(ab.ok, 'abort');
  eq(S().raceEffects.length, queuedBefore.length, 'abortRace puts the paid effects back in the queue');
}

// =============================================================================
section('!ribbon: named colours, #hex, off, same colour, needs a runner');
// =============================================================================
{
  fresh();
  say('Ribbons', '!join');
  has(say('Ribbons', '!ribbon teal').message, '!claim', '!ribbon needs a claimed runner');
  say('Ribbons', '!claim moss');
  const M = runner('moss');
  const help = say('Ribbons', '!ribbon');
  ok(help.ok && help.message.indexOf('teal') >= 0 && player('ribbons').spiritPoints === 200, '!ribbon alone lists colours (free)');
  const r1 = say('Ribbons', '!ribbon teal');
  ok(r1.ok, '!ribbon teal', r1.message);
  eq([M.ribbonColor, player('ribbons').spiritPoints], [SD.DATA.RIBBON_COLORS.teal, 200 - EC.RIBBON_COST], 'ribbon stored as hex, 100 SP');
  eq(say('Ribbons', '!ribbon teal').ok, false, 'the same colour again is refused');
  const r2 = say('Ribbons', '!ribbon #F6A');
  eq([r2.ok, M.ribbonColor, player('ribbons').spiritPoints], [true, '#ff66aa', 0], '#rgb is normalised to #rrggbb');
  eq(say('Ribbons', '!ribbon crimson').ok, false, 'no SP left -> refused');
  eq(say('Ribbons', '!ribbon mauveish').ok, false, 'unknown colour refused');
  const off = say('Ribbons', '!ribbon off');
  eq([off.ok, M.ribbonColor, player('ribbons').spiritPoints], [true, null, 0], '!ribbon off removes it for free');
  M.ribbonColor = '#4fd1c5';
  const st = SD.game.startRace();
  const ent = st.record.entrants.filter(function (e) { return e.runnerId === M.id; })[0];
  ok(!ent || ent.ribbonColor === '#4fd1c5', 'the race entrant carries the ribbon colour');
  const locked = say('Ribbons', '!ribbon gold');
  eq(locked.locked, true, '!ribbon is locked during a race');
  SD.game.endRace();
}

// =============================================================================
section('money commands are locked during a race');
// =============================================================================
{
  fresh();
  say('Locky', '!join');
  say('Locky', '!claim moss');
  SD.game.startRace();
  ['!bet moss 20', '!boost moss', '!snack moss', '!sabotage glow', '!ribbon gold'].forEach(function (cmd) {
    const r = say('Locky', cmd);
    eq([r.ok, !!r.locked], [false, true], cmd + ' refused while racing');
  });
  eq(player('locky').spiritPoints, 200, 'no SP moved');
  ok(say('Locky', '!hype').ok && say('Locky', '!odds').ok && say('Locky', '!bets').ok, '!hype / !odds / !bets work mid-race');
  SD.game.endRace();
}

// =============================================================================
section('!race / !event: viewers read, mods act');
// =============================================================================
{
  fresh();
  say('Viewer', '!join');
  const v1 = say('Viewer', '!race');
  ok(v1.ok && !S().currentRace, 'viewer !race does not start a race');
  has(v1.message, 'Next up', 'viewer gets the status line');
  has(v1.message, 'Favourite:', '… with the favourite');
  say('Viewer', '!bet ' + field()[0].name + ' 20');
  has(say('Viewer', '!race').message, 'Bets: 1 bet (20 SP)', '… and the open bets');
  const m1 = say('ModMia', '!race', MOD);
  ok(m1.ok && !!S().currentRace, 'mod !race starts the race', m1.message);
  eq(m1.severity, 'epic', 'start reply is epic');
  has(m1.message, '1 bet (20 SP) locked in', 'start reply mentions the locked bets');
  const m2 = say('ModMia', '!race', MOD);
  ok(m2.ok && m2.message.indexOf('is about to start') >= 0, 'mod !race during a race shows the status (no second race)');
  SD.game.endRace();
  const m3 = say('Streamer', '!race 2000', ADMIN);
  eq([m3.ok, S().currentRace && S().currentRace.record.distance], [true, 2000], 'streamer !race 2000 picks the distance');
  SD.game.endRace();
  const m4 = say('ModMia', '!race status', MOD);
  ok(m4.ok && !S().currentRace, 'mod !race status only looks');

  has(say('Viewer', '!event').message, 'Clear Skies', 'viewer !event: today\'s event');
  say('Viewer', '!event harvest');
  eq(S().season.activeDayEvent, 'clearSkies', 'a viewer cannot change the day event');
  const e1 = say('ModMia', '!event harvest', MOD);
  eq([e1.ok, S().season.activeDayEvent], [true, 'harvestFestival'], 'mod !event <name> triggers it (unique prefix)');
  has(e1.message, 'Harvest Festival', '… reply names it');
  const e2 = say('ModMia', '!event', MOD);
  ok(e2.ok && S().season.activeDayEvent !== 'harvestFestival', 'mod !event rolls a random different event');
  const cur = S().season.activeDayEvent;
  const e3 = say('ModMia', '!event today', MOD);
  ok(e3.ok && S().season.activeDayEvent === cur && e3.message.indexOf('Today (') === 0, 'mod !event today just looks');
  const e4 = say('ModMia', '!event moonlitGlade', MOD);
  eq(S().season.activeDayEvent, 'moonlitGlade', 'mod !event <id>');
  ok(e4.ok, '… ok');
  eq(say('ModMia', '!event zzz', MOD).ok, false, 'unknown day event refused');

  const help = say('Viewer', '!help').message;
  ['!bet', '!bets', '!odds', '!boost', '!snack', '!sabotage', '!ribbon', '!hype', '!achievements'].forEach(function (c) { has(help, c, '!help lists ' + c); });
  ok(help.length <= 400, '!help fits in one chat line', help.length);
  has(say('Viewer', '!help sabotage').message, '10-minute cooldown', '!help sabotage explains the rules');
}

// =============================================================================
section('!hype / !odds / !bets replies');
// =============================================================================
{
  fresh();
  say('Hyper', '!join');
  const h0 = say('Hyper', '!hype');
  has(h0.message, 'Hype 0/120', '!hype shows the value');
  has(h0.message, 'next: 25', '… and the next threshold');
  SD.game.addHype(30);
  const h1 = say('Hyper', '!hype').message;
  has(h1, 'The crowd is getting loud!', '!hype names the current tier');
  has(h1, 'next: 50', '… next 50');
  has(h1, '(20 to go)', '… distance to it');
  SD.game.addHype(100);
  has(say('Hyper', '!hype').message, 'FOREST AWAKENED', '!hype at max tier');
  const od = say('Hyper', '!odds').message;
  ok(field().every(function (r) { return od.indexOf(r.name + ' ') >= 0; }), '!odds lists every runner in the next field', od);
  has(od, 'Next race (Race 1/3, ' + S().settings.distance + ' m)', '!odds header');
  has(say('Hyper', '!bets').message, 'No open bets', '!bets with none');
  say('Hyper', '!bet ' + field()[0].name + ' 50');
  const bs = say('Hyper', '!bets').message;
  has(bs, '1 bet · 50 SP', '!bets totals');
  has(bs, 'Yours: 50 SP on ' + field()[0].name, '!bets shows your own bet');
}

// =============================================================================
section('hype thresholds: ADD HYPE crosses 25 / 50 / 100 with banner events');
// =============================================================================
{
  fresh();
  const th = capture(EV.HYPE_THRESHOLD);
  SD.game.addHype(25, 'streamer');
  SD.game.addHype(25, 'streamer');
  SD.game.addHype(50, 'streamer');
  th.off();
  eq(th.list.map(function (t) { return t.id; }), ['loud', 'feral', 'awakened'], 'one hype:threshold per crossing');
  ok(th.list.every(function (t) { return t.text && t.value >= t.threshold && t.by === 'streamer'; }), 'payload { id, value, threshold, text, by }');
  eq(SD.hype.tier(S().hype.value), 3, 'tier 3 (body[data-hype-tier="3"] glow)');
}

// =============================================================================
section('achievements: unlock exactly once, with SP, in the reply');
// =============================================================================
{
  SD.achievements.init();
  fresh();
  ok(SD.achievements.catalog().length >= 15, 'catalog has at least 15 achievements', SD.achievements.catalog().length);
  ['firstSteps', 'stableHand', 'trainer', 'criticalHit', 'overtrainer', 'wellRested', 'cheerleader', 'hypeTrain', 'forestAwakened',
    'highRoller', 'sharpEye', 'longshot', 'ownersPride', 'podiumRegular', 'photoFinish', 'comebackKid', 'saboteur', 'karma', 'seasonChampion']
    .forEach(function (id) { ok(!!SD.achievements.get(id), 'catalog has ' + id); });
  ok(SD.achievements.catalog().every(function (a) { return a.sp >= EC.ACHIEVEMENT_SP_MIN && a.sp <= EC.ACHIEVEMENT_SP_MAX; }), 'every reward is 25..100 SP');

  const un = capture(EV.ACHIEVEMENT_UNLOCKED);
  const j = say('FoxFan', '!join');
  has(j.message, '\u{1F3C5} Achievement: First Steps (+25 SP)', '!join reply announces First Steps');
  eq(j.severity, 'epic', '… as an epic reply');
  eq(player('foxfan').spiritPoints, EC.JOIN_SP + 25, 'SP credited (200 + 25)');
  eq(player('foxfan').stats.spEarnedTotal, EC.JOIN_SP + 25, 'counted as SP earned');
  eq(player('foxfan').achievements, ['firstSteps'], 'player.achievements holds the id');
  const entry = S().achievements.unlocked[0];
  eq([entry.id, entry.username, entry.displayName, entry.sp, entry.season], ['firstSteps', 'foxfan', 'FoxFan', 25, 1], 'state.achievements.unlocked entry');
  eq([un.list.length, un.list[0].name, un.list[0].duringCommand], [1, 'First Steps', true], 'achievement:unlocked emitted (duringCommand)');
  ok(S().log.some(function (e) { return e.type === 'achievement' && e.severity === 'epic' && /FoxFan unlocked First Steps/.test(e.text); }), 'epic log line');
  const j2 = say('FoxFan', '!join');
  eq([j2.message.indexOf('Achievement') < 0, player('foxfan').spiritPoints, un.list.length], [true, EC.JOIN_SP + 25, 1], 'a second !join unlocks nothing');
  say('FoxFan', '!claim moss');
  say('FoxFan', '!claim glow');
  eq(unlockedIds('foxfan'), ['firstSteps', 'stableHand'], 'Stable Hand once (re-claiming does not repeat it)');
  un.off();
  const a1 = say('FoxFan', '!achievements');
  has(a1.message, 'FoxFan: 2/' + SD.achievements.catalog().length + ' achievements (+50 SP)', '!achievements count/total');
  has(a1.message, 'latest: \u{1F3E1} Stable Hand, \u{1F463} First Steps', '… newest first');
  has(say('MothMom', '!join') && say('MothMom', '!achievements FoxFan').message, 'FoxFan: 2/', '!achievements <viewer>');
  eq(say('MothMom', '!achievements Ghost').ok, false, 'unknown viewer refused');
  eq(SD.achievements.listFor(S(), 'foxfan').map(function (a) { return a.id; }), ['firstSteps', 'stableHand'], 'listFor(state, user)');
  eq(S().achievements.unlocked.length, 3, 'three unlocks in total (FoxFan x2, MothMom x1)');
}

// =============================================================================
section('achievements: Hype Train goes to recent contributors only');
// =============================================================================
{
  fresh();
  ['Early', 'Late', 'Crosser'].forEach(function (u) { say(u, '!join'); });
  say('Early', '!cheer');
  tick(SD.CONFIG.ACHIEVEMENTS.HYPE_WINDOW_MS + 60000);
  SD.game.addHype(40, 'late');
  ok(S().hype.value < 50, 'still under 50', S().hype.value);
  let n = 0;
  while (S().hype.value < 50 && n++ < 10) { tick(31000); say('Crosser', '!cheer'); }
  ok(unlockedIds('crosser').indexOf('hypeTrain') >= 0, 'the viewer whose cheer crossed 50 gets Hype Train');
  ok(unlockedIds('late').indexOf('hypeTrain') >= 0, 'a viewer who added hype within the window gets it too');
  ok(unlockedIds('early').indexOf('hypeTrain') < 0, 'a stale contributor does not');
  SD.game.addHype(60, 'late');
  ok(unlockedIds('late').indexOf('forestAwakened') >= 0 && unlockedIds('crosser').indexOf('forestAwakened') >= 0, 'Forest Awakened for the recent crowd at 100');
}

// =============================================================================
section('achievements: race checks on a crafted record');
// =============================================================================
{
  fresh();
  ['Ann', 'Ben', 'Cid', 'Dot'].forEach(function (u) { say(u, '!join'); });
  const ids = S().runners.slice(0, 4).map(function (r) { return r.id; });
  const rec = {
    id: 'test-rec-1', distance: 2400, season: 1, day: 1,
    entrants: ids.map(function (id, i) { return { runnerId: id, lane: i + 1, odds: 3 }; }),
    results: [
      { runnerId: ids[0], name: 'A', place: 1, ownerAtRace: 'Ann' },
      { runnerId: ids[1], name: 'B', place: 2, ownerAtRace: 'Ben' },
      { runnerId: ids[2], name: 'C', place: 3, ownerAtRace: 'Cid' },
      { runnerId: ids[3], name: 'D', place: 4, ownerAtRace: null }
    ],
    events: [
      { tick: 5, kind: 'phase', runnerId: ids[1], data: { phase: 'FINAL_TURN' } },
      { tick: 3, kind: 'event', runnerId: ids[2], data: { eventId: 'cryptidCrossing', targets: [ids[2]] } },
      { tick: 9, kind: 'chat', runnerId: ids[3], data: { type: 'sabotage', by: 'Dot', backfire: true } }
    ],
    ticks: [0, 1, 2, 3, 4, 5].map(function (t) {
      return { t: t, pos: ids.map(function (id, i) { return { id: id, rank: t === 5 ? (i === 0 ? 4 : i) : i + 1 }; }) };
    }),
    bets: [{ username: 'dot', runnerId: ids[0], amount: 20, odds: 12, payout: 240, won: true }],
    summary: { photoFinish: true }
  };
  const got = SD.achievements.checkRace(S(), rec);
  const pairs = got.map(function (a) { return a.username + ':' + a.id; }).sort();
  ['ann:ownersPride', 'ann:marathonMind', 'ann:comebackKid', 'ann:photoFinish', 'ben:photoFinish', 'cid:cryptidWhisperer',
    'dot:karma', 'dot:sharpEye', 'dot:longshot'].forEach(function (p) { ok(pairs.indexOf(p) >= 0, 'checkRace unlocks ' + p, pairs); });
  ok(got.every(function (a) { return a.recordId === 'test-rec-1' && a.name && a.icon; }), 'unlocks are tagged with the race id (name, icon)');
  const n0 = S().achievements.unlocked.length;
  SD.achievements.checkRace(S(), rec);
  eq(S().achievements.unlocked.length, n0, 'checking the same race twice unlocks nothing new');
  eq(SD.achievements.progress(S(), 'ann').podiums, 1, 'podium progress counted once per race');
}

// =============================================================================
section('achievements: a scripted session unlocks at least 8 different ones');
// =============================================================================
{
  fresh();
  const spEvents = capture(EV.PLAYER_SP);
  const crew = ['Alice', 'Bob', 'Cara', 'Dan'];
  crew.forEach(function (u) { say(u, '!join'); });
  const F = field();
  crew.forEach(function (u, i) { say(u, '!claim ' + F[i].name); });
  // Alice overtrains her runner (Trainer, Overtrainer, maybe Critical Hit).
  const AR = SD.players.runnerOf(S(), 'alice');
  const stats = ['speed', 'stamina', 'power', 'wisdom', 'luck'];
  let k = 0;
  while (AR.condition !== 'Exhausted' && k < 60) {
    AR.energy = AR.maxEnergy;
    say('Alice', '!train ' + stats[k % 5]);
    k++;
  }
  eq(AR.condition, 'Exhausted', 'Alice trained her runner into Exhausted (' + k + ' trains)');
  ok(unlockedIds('alice').indexOf('trainer') >= 0, 'Trainer (10 trains)');
  ok(unlockedIds('alice').indexOf('overtrainer') >= 0, 'Overtrainer (into Exhausted)');
  // Bob rests 5 times (3-minute rest cooldown per runner).
  for (let i = 0; i < 5; i++) { tick(181000); say('Bob', '!rest'); }
  ok(unlockedIds('bob').indexOf('wellRested') >= 0, 'Well Rested (5 rests)');
  // Cara cheers 25 times (30 s cooldown) -> Cheerleader, and the crowd crosses 50.
  for (let i = 0; i < 25; i++) { tick(31000); say('Cara', '!cheer ' + F[2].name); }
  ok(unlockedIds('cara').indexOf('cheerleader') >= 0, 'Cheerleader (25 cheers)');
  ok(unlockedIds('cara').indexOf('hypeTrain') >= 0, 'Hype Train (hype past 50)');
  SD.game.addHype(100, 'cara');
  ok(unlockedIds('cara').indexOf('forestAwakened') >= 0, 'Forest Awakened (hype 100)');
  // Dan: High Roller, Saboteur.
  const hr = say('Dan', '!bet ' + F[0].name + ' 200');
  has(hr.message, 'High Roller', 'High Roller in the !bet reply');
  const sab = say('Dan', '!sabotage ' + F[1].name);
  ok(sab.ok && unlockedIds('dan').indexOf('saboteur') >= 0, 'Saboteur (first sabotage, via command:result)');
  // Four races: somebody wins (Owner's Pride) and somebody reaches 3 podiums.
  for (let r = 0; r < 4; r++) {
    S().runners.forEach(function (x) { x.energy = x.maxEnergy; });
    const res = race();
    ok(res.ok, 'race ' + (r + 1) + ' finished', res.message);
  }
  const winners = crew.filter(function (u) { return unlockedIds(u).indexOf('ownersPride') >= 0; });
  ok(winners.length >= 1, "Owner's Pride for a winning owner", winners);
  const pod = crew.filter(function (u) { return unlockedIds(u).indexOf('podiumRegular') >= 0; });
  ok(pod.length >= 1, 'Podium Regular (3 podiums in 4 races, pigeonhole)', pod);
  const rs = SD.game.resetSeason();
  const champOwner = rs.summary.championOwner;
  ok(!!champOwner && unlockedIds(champOwner).indexOf('seasonChampion') >= 0, 'Season Champion for the champion\'s owner', champOwner);
  spEvents.off();

  const distinct = {};
  S().achievements.unlocked.forEach(function (a) { distinct[a.id] = true; });
  const list = Object.keys(distinct).sort();
  ok(list.length >= 8, 'at least 8 different achievements unlocked (' + list.length + ': ' + list.join(', ') + ')');
  const seen = {};
  let dupes = 0;
  S().achievements.unlocked.forEach(function (a) { const key = a.username + ':' + a.id; if (seen[key]) dupes++; seen[key] = true; });
  eq(dupes, 0, 'no viewer unlocked the same achievement twice');
  const achSp = spEvents.list.filter(function (e) { return e.reason === 'achievement'; });
  eq(achSp.length, S().achievements.unlocked.length, 'one SP award per unlock');
  ok(achSp.every(function (e, i) { return e.delta === SD.achievements.get(S().achievements.unlocked[i].id).sp; }), 'each award = the catalog sp');
  crew.forEach(function (u) {
    ok(unlockedIds(u).length > 0 && unlockedIds(u).every(function (id) { return S().achievements.unlocked.some(function (a) { return a.username === u.toLowerCase() && a.id === id; }); }),
      u + ' keeps achievements across the season reset');
  });
}

// =============================================================================
section('achievements: a real sabotage backfire gives Karma');
// =============================================================================
{
  fresh();
  say('Streamer', '!join', ADMIN);
  let backfired = null;
  for (let i = 0; i < 16 && !backfired; i++) {
    S().runners.forEach(function (x) { x.energy = x.maxEnergy; });
    const t = field()[0];
    t.stats.wisdom = 70;                       // backfire chance min(0.5, 0.15 + 70/200) = 50%
    player('streamer').spiritPoints = 500;
    const r = say('Streamer', '!sabotage ' + t.name, ADMIN); // the streamer console skips cooldowns
    if (!r.ok) { ok(false, 'streamer sabotage accepted', r.message); break; }
    const res = race();
    const ev = res.record.events.filter(function (e) { return e.kind === 'chat' && e.data && e.data.type === 'sabotage'; })[0];
    if (ev && ev.data.backfire) backfired = res;
  }
  ok(!!backfired, 'a sabotage backfired within 16 races');
  ok(unlockedIds('streamer').indexOf('karma') >= 0, 'Karma unlocked for the saboteur');
  ok(backfired && backfired.achievements.some(function (a) { return a.id === 'karma'; }), '… and listed in the race:finished achievements');
}

// =============================================================================
section('season end: summary fields, rollback, history, refunds');
// =============================================================================
{
  fresh();
  const crew = ['Alice', 'Bob', 'Cara', 'Dan'];
  crew.forEach(function (u) { say(u, '!join'); });
  const F = field();
  crew.forEach(function (u, i) { say(u, '!claim ' + F[i].name); });
  for (let i = 0; i < 4; i++) say('Alice', '!train speed');
  for (let i = 0; i < 6; i++) { tick(31000); say('Cara', '!cheer'); }
  say('Bob', '!bet ' + F[1].name + ' 100');
  const r1 = race();
  const r2 = race();
  ok(r1.ok && r2.ok, 'two races run');
  const days = [];
  for (let d = 0; d < 6; d++) days.push(SD.game.nextDay()); // days 2..7 (each new day refunds open bets)
  // Leftovers on the last day that must be refunded before the carry-over.
  ok(say('Bob', '!bet ' + field()[0].name + ' 50').ok, 'Bob leaves an open bet on the last day');
  const outside = S().runners.filter(function (r) { return field().indexOf(r) < 0 && !r.owner; })[0];
  say('Dan', '!boost ' + outside.name);

  // Expected values before the rollover.
  const table = S().runners.filter(function (r) { return r.record.races > 0; }).sort(function (a, b) {
    return (b.record.wins - a.record.wins) || (b.totalXp - a.totalXp) || (b.record.podiums - a.record.podiums) || (a.name < b.name ? -1 : 1);
  });
  const champ = table[0];
  const champOwner = champ.owner;
  const champWins = champ.record.wins;
  const mvp = crew.map(function (u) { return player(u); }).sort(function (a, b) { return b.stats.spEarnedTotal - a.stats.spEarnedTotal || (a.username < b.username ? -1 : 1); })[0];
  const mvpSp = mvp.stats.spEarnedTotal;
  const topOdds = Math.max(r1.record.results[0].odds, r2.record.results[0].odds);
  const hypeTop = Object.keys(S().hype.contributions).sort(function (a, b) { return S().hype.contributions[b] - S().hype.contributions[a] || (a < b ? -1 : 1); })[0];
  const expectStats = {};
  S().runners.forEach(function (r) {
    const st = {};
    SD.CONFIG.STATS.forEach(function (k) {
      const base = r.baseStats[k];
      st[k] = Math.max(1, Math.min(SD.runners.statCap(1), base + Math.floor(Math.max(0, r.stats[k] - base) * SD.CONFIG.SEASON.STAT_CARRY)));
    });
    expectStats[r.id] = { stats: st, lifetimeRaces: r.lifetime.races, lifetimeWins: r.lifetime.wins };
  });
  const expectSp = {};
  crew.forEach(function (u) {
    const p = player(u);
    const refund = (u === 'Bob' ? 50 : 0) + (u === 'Dan' ? EC.BOOST_COST : 0);
    expectSp[p.username] = EC.SEASON_BASE_SP + Math.floor((p.spiritPoints + refund) * EC.SEASON_CARRY);
  });
  const achBefore = {};
  crew.forEach(function (u) { achBefore[u] = unlockedIds(u).slice(); });
  const unlockedS1 = S().achievements.unlocked.filter(function (a) { return a.season === 1; }).length;
  const commandsBefore = player('alice').stats.commands;

  const ended = capture(EV.SEASON_ENDED);
  days.push(SD.game.nextDay());
  ended.off();
  eq(days.map(function (x) { return !!x.seasonEnded; }), [false, false, false, false, false, false, true], 'nextDay x7: days 2..7, then the season ends');
  eq(ended.list.length, 1, 'season:ended emitted once');
  const sum = ended.list[0].summary;
  eq([sum.number, sum.totalRaces], [1, 2], 'summary: number, totalRaces');
  eq([sum.championRunnerId, sum.championName, sum.championWins, sum.championOwner], [champ.id, champ.name, champWins, champOwner],
    'summary: champion runner (wins, then XP) and its owner');
  eq([sum.mvpUsername, sum.mvpSpEarned], [mvp.displayName, mvpSp], 'summary: MVP by SP earned');
  eq(sum.biggestUpset && sum.biggestUpset.odds, topOdds, 'summary: biggest upset = highest winning odds');
  eq(sum.biggestUpset.upset, topOdds >= SD.CONFIG.RACE.UPSET_ODDS, '… flagged as a true upset only at >= 10x');
  eq(sum.topHypeContributor && sum.topHypeContributor.username, hypeTop, 'summary: top hype contributor');
  eq(sum.topHypeContributor.displayName, player(hypeTop).displayName, '… with the display name');
  eq(sum.achievementsCount, unlockedS1, 'summary: achievements unlocked this season');
  eq(sum.runnerTable.map(function (r) { return r.runnerId; }), table.map(function (r) { return r.id; }), 'summary: per-runner table in champion order');
  ok(sum.runnerTable.every(function (r) { return 'wins' in r && 'races' in r && 'podiums' in r && 'xp' in r && r.rank >= 1; }), '… rows { rank, wins, races, podiums, xp }');
  eq([sum.refundedBets, sum.refundedEffects], [1, 1], 'open bet + queued boost refunded at season end');

  const hist = S().season.history;
  eq(hist.length, 1, 'archived to season.history');
  const h = hist[0];
  eq([h.number, h.championName, h.championOwner, h.mvpUsername, h.totalRaces, h.achievementsCount], [1, champ.name, champOwner, mvp.displayName, 2, unlockedS1], 'history entry fields');
  ok(Array.isArray(h.runnerTable) && h.runnerTable.length <= SD.CONFIG.SEASON.HISTORY_TABLE_N && h.endedAt > 0, 'history keeps a small win table + endedAt');

  eq([S().season.number, S().season.day, S().season.racesRun], [2, 1, 0], 'season 2, day 1');
  let rollOk = 0;
  S().runners.forEach(function (r) {
    const e = expectStats[r.id];
    if (r.level === 1 && r.xp === 0 && r.totalXp === 0 && r.owner === null && r.record.races === 0 &&
        JSON.stringify(r.stats) === JSON.stringify(e.stats) && JSON.stringify(r.baseStats) === JSON.stringify(e.stats) &&
        r.lifetime.races === e.lifetimeRaces && r.lifetime.wins === e.lifetimeWins && r.energy === r.maxEnergy) rollOk++;
  });
  eq(rollOk, S().runners.length, 'runners: level 1, base + 10% of gains, owners cleared, season record reset, lifetime kept');
  let spOk = 0;
  crew.forEach(function (u) {
    const p = player(u);
    const bonus = u.toLowerCase() === SD.players.keyOf(champOwner) ? SD.achievements.get('seasonChampion').sp : 0;
    if (p.spiritPoints === expectSp[p.username] + bonus) spOk++;
  });
  eq(spOk, 4, 'players: SP = 200 + 10% of the balance after refunds (+ Season Champion reward)');
  eq([player('alice').stats.commands, player('alice').lifetime.commands >= commandsBefore, player('alice').runnerId], [0, true, null], 'seasonal stats rolled into lifetime, runner released');
  ok(crew.every(function (u) { return achBefore[u].every(function (id) { return unlockedIds(u).indexOf(id) >= 0; }); }), 'players keep their achievements');
  ok(unlockedIds(champOwner).indexOf('seasonChampion') >= 0, 'Season Champion unlocked for ' + champOwner);
  eq([S().bets.length, S().raceEffects.length, S().hype.value], [0, 0, 0], 'bets, queued effects and hype cleared');
  ok(say('Alice', '!claim ' + field()[0].name).ok, 're-claim in the new season');
}

// =============================================================================
section('season end: automatic after the last day, and admin RESET SEASON');
// =============================================================================
{
  fresh();
  say('Solo', '!join');
  say('Solo', '!claim ' + field()[0].name);
  S().season.day = S().season.daysPerSeason;
  const order = [];
  const offs = [EV.RACE_FINISHED, EV.SEASON_ENDED, EV.SEASON_STARTED].map(function (n) { return SD.bus.on(n, function () { order.push(n); }); });
  let last = null;
  for (let i = 0; i < S().season.racesPerDay; i++) {
    S().runners.forEach(function (x) { x.energy = x.maxEnergy; });
    last = race();
  }
  offs.forEach(function (o) { o(); });
  ok(last.ok && last.dayAdvanced && last.dayAdvanced.seasonEnded, 'the last race of the last day ends the season (autoAdvanceDay)');
  eq(order.slice(-3), [EV.RACE_FINISHED, EV.SEASON_ENDED, EV.SEASON_STARTED], 'race:finished, then season:ended, then season:started');
  eq(S().season.number, 2, 'season 2 started');
  eq(last.dayAdvanced.summary.totalRaces, 3, 'summary counts the 3 races');

  const ended = capture(EV.SEASON_ENDED);
  const rs = SD.game.resetSeason();
  ended.off();
  ok(rs.ok && ended.list.length === 1 && ended.list[0].summary.number === 2, 'admin RESET SEASON emits season:ended with the summary (the modal)');
  eq(S().season.history.map(function (x) { return x.number; }), [1, 2], 'both seasons archived');
}

// =============================================================================
section('persistence: bets, queued effects and achievements survive export / import');
// =============================================================================
{
  fresh();
  ['Keeper', 'Other'].forEach(function (u) { say(u, '!join'); });
  say('Keeper', '!bet ' + field()[0].name + ' 30');
  say('Other', '!boost ' + field()[1].name);
  const json = SD.persistence.exportJSON();
  const before = { bets: S().bets, fx: S().raceEffects, ach: S().achievements.unlocked.length };
  fresh();
  const imp = SD.persistence.importJSON(json);
  ok(imp.ok, 'importJSON ok');
  eq(S().bets, before.bets, 'open bets restored');
  eq(S().raceEffects, before.fx, 'queued effects (with paid) restored');
  eq(S().achievements.unlocked.length, before.ach, 'achievements restored');
  ok(S().achievements.progress && typeof S().achievements.progress === 'object', 'achievements.progress present');
  eq(S().meta.betCounter, 1, 'meta.betCounter restored');
}

// =============================================================================
// Transcript (node tools/community-test.js --transcript)
// =============================================================================
if (TRANSCRIPT) {
  fresh();
  const lines = [];
  const off = SD.bus.on(EV.CHAT_MESSAGE, function (m) {
    if (m.kind === 'user') lines.push(m.displayName + ': ' + m.text);
    else if (m.kind === 'reply') lines.push('   ↳ @' + m.displayName + ' ' + m.text);
    else lines.push('   [chat] ' + m.text);
  });
  const offs = [
    SD.bus.on(EV.ACHIEVEMENT_UNLOCKED, function (a) { if (!a.duringCommand) lines.push('   [toast] 🏅 ' + a.displayName + ' unlocked ' + a.name + ' (+' + a.sp + ' SP)'); }),
    SD.bus.on(EV.RACE_STARTED, function (p) { lines.push('   [race] ' + p.record.trackName + ' ' + p.record.distance + ' m: ' + p.record.entrants.map(function (e) { return e.name + ' ' + e.odds + 'x'; }).join(', ')); }),
    SD.bus.on(EV.RACE_FINISHED, function (p) {
      lines.push('   [results] ' + p.record.results.map(function (r) { return r.place + '. ' + r.name + (r.ownerAtRace ? ' (' + r.ownerAtRace + ' +' + r.spOwner + ' SP)' : ''); }).join(' · '));
      lines.push('   [results] bets: ' + (p.bets.length ? p.bets.map(function (b) { return b.displayName + ' ' + b.amount + ' on ' + b.runnerName + ' @' + b.odds + 'x → ' + (b.won ? '+' + b.payout : 'lost'); }).join(' · ') : 'none'));
      lines.push('   [results] achievements: ' + (p.achievements.length ? p.achievements.map(function (a) { return a.displayName + ' ' + a.name + ' +' + a.sp; }).join(' · ') : 'none'));
      lines.push('   [results] chat effects: ' + p.record.events.filter(function (e) { return e.kind === 'chat'; }).map(function (e) { return e.text; }).join(' | '));
    }),
    SD.bus.on(EV.SEASON_ENDED, function (p) {
      const s = p.summary;
      lines.push('   [SEASON SUMMARY] Season ' + s.number + ': champion ' + s.championName + ' (' + s.championWins + (s.championWins === 1 ? ' win' : ' wins') + ', owner ' + s.championOwner + ') · MVP ' + s.mvpUsername +
        ' (' + s.mvpSpEarned + ' SP earned) · ' + s.totalRaces + ' races · biggest upset ' + (s.biggestUpset ? s.biggestUpset.winnerName + ' @' + s.biggestUpset.odds + 'x' : '-') +
        ' · top hype ' + (s.topHypeContributor ? s.topHypeContributor.displayName + ' (' + s.topHypeContributor.hype + ')' : '-') + ' · ' + s.achievementsCount + ' achievements');
      lines.push('   [SEASON SUMMARY] table: ' + s.runnerTable.map(function (r) { return r.rank + '. ' + r.name + ' ' + r.wins + 'W/' + r.races + ' ' + r.xp + 'xp'; }).join(' · '));
    })
  ];
  const crew = ['FoxFan', 'MothMom', 'AcornAndy', 'WispWatcher'];
  crew.forEach(function (u) { say(u, '!join'); });
  const F = field();
  crew.forEach(function (u, i) { say(u, '!claim ' + F[i].name.split(' ')[0].toLowerCase()); });
  say('FoxFan', '!odds');
  say('FoxFan', '!bet ' + F[1].name.split(' ')[0].toLowerCase() + ' 50');
  say('MothMom', '!bet 120 ' + F[3].name.split(' ')[0].toLowerCase());
  say('AcornAndy', '!bet ' + F[2].name.split(' ')[0].toLowerCase() + ' all');
  say('WispWatcher', '!boost');
  say('MothMom', '!sabotage ' + F[0].name.split(' ')[0].toLowerCase());
  say('FoxFan', '!cheer ' + F[0].name.split(' ')[0].toLowerCase());
  say('WispWatcher', '!bets');
  say('Streamer', '!race', ADMIN);
  SD.game.endRace();
  say('FoxFan', '!achievements');
  say('MothMom', '!hype');
  for (let d = 0; d < 7; d++) {
    const r = SD.game.nextDay();
    lines.push('   [admin NEXT DAY] ' + r.message);
  }
  off(); offs.forEach(function (o) { o(); });
  console.log('\n--- TRANSCRIPT ---\n' + lines.join('\n'));
}

// -----------------------------------------------------------------------------
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
