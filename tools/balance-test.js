#!/usr/bin/env node
/*
 * Spirit Derby - tools/balance-test.js
 * Headless balance harness for the race engine (plan section 12).
 *
 *   node tools/balance-test.js [--races 1000] [--distance 1600] [--runners 8]
 *                              [--events none|low|normal|high|chaos] [--seed 42]
 *                              [--matrix] [--dump SEED] [--streamday] [--quick]
 *
 * Main table: `--races` seeded races with the first N roster runners (fresh, level 1).
 * Assertions (exit code 1 on failure):
 *   - determinism: same seed -> identical hash, ticks and events; different seed -> different hash
 *   - no NaN anywhere; every race finishes under MAX_TICKS; 1000 races simulate in < 3 s
 *   - roster win rates in 8-runner fields (8-of-10 rotated so all ten are covered):
 *       single distance: every runner in [5%, 40%] at 1200 / 1600 m, [3%, 40%] at 2000 m+
 *         (M4: the stamina pool now makes 2000 / 2400 m a real stamina test, so low-Stamina
 *         runners are specialists there, exactly as in the matrix rule below);
 *       --matrix: every runner's AVERAGE over 1200/1600/2000/2400 in [5%, 40%], and
 *                 every runner in [3%, 40%] at each single distance (distance specialists
 *                 are intended: Ember Tail fades at 2400 m, Moonhoof thrives there)
 *   - odds calibration: mean |implied - actual| <= 3pp and worst runner <= 8pp per distance;
 *     M4: also on mixed fields (roster + random runners, levels 1-8, any condition / mood /
 *     energy, 4-10 runners): every implied-probability bucket within 4pp of the actual rate
 *   - style-clone fields (2 per style, all stats 40): each style wins 15-35% per distance
 *   - Ember Tail wins more at 1200 m than at 2400 m; Moonhoof the reverse
 *   - M4 sensitivity (8-runner clone fields, all stats 40, Excellent + Happy unless stated,
 *     >= 2000 races each at --distance, fixed seed):
 *       8 identical clones each 12.5% +/- 3, and the clone with the best hidden per-race form
 *         wins < 60% (race-level luck exists, but one roll does not decide the race)
 *       condition (one clone, others Excellent): Good >= 8%, Tired >= 5%, Exhausted >= 2.5%,
 *         and Good >= Tired >= Exhausted
 *       mood (one clone, others Happy): Sleepy >= 9%, Nervous >= 8%, and every mood within
 *         12.5% +/- 4 points
 *       stats: +20 Speed 25-45%; +8 to every stat (a level-5-ish runner) >= 35%; a +20
 *         Stamina clone gains more at 2400 m than at 1200 m
 *       4-runner case @1200 m (Thunder Fern + Moonhoof: Lv1 Excellent Happy; Moss Runner Lv3
 *         Normal Happy 45/45/42/43/40; Velvet Comet Lv2 Good Sleepy 58/40/35/43/31):
 *         Velvet Comet >= 15% and Moss Runner >= 15% (better stats must count), and making
 *         Velvet Comet Happy + Excellent may at most double her win rate
 *   - --streamday: 20 trains without rest leave the runner Exhausted for its first race,
 *     with a visible race-day penalty (stat multiplier and odds vs its fresh self)
 * Changed bound (M4): "+20 Speed >= 35%" became "+20 Speed in 25-45%". M4 doubled the stat
 * slope AND the race-level randomness so condition / mood stop deciding races; a +20 Speed
 * clone now wins ~33%, and the new "+8 to every stat >= 35%" check carries the "a better
 * runner must win clearly more often" intent. The upper bound keeps randomness alive.
 * --dump SEED prints one full RaceRecord; --streamday plays a 20-train / 3-rest /
 * 3-race stream day on one runner and prints the energy/fatigue/condition trajectory.
 */
'use strict';

const SD = require('./load-core.js');

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { races: 1000, distance: 1600, runners: 8, events: 'normal', seed: 42, matrix: false, dump: null, streamday: false, quick: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = function () { return argv[++i]; };
    switch (a) {
      case '--races': o.races = Math.max(1, parseInt(next(), 10) || o.races); break;
      case '--distance': o.distance = parseInt(next(), 10) || o.distance; break;
      case '--runners': o.runners = Math.max(2, parseInt(next(), 10) || o.runners); break;
      case '--events': o.events = String(next() || 'normal'); break;
      case '--seed': o.seed = parseInt(next(), 10) || 0; break;
      case '--matrix': o.matrix = true; break;
      case '--dump': o.dump = next(); break;
      case '--streamday': o.streamday = true; break;
      case '--quick': o.quick = true; break;
      case '--help': case '-h':
        console.log('usage: node tools/balance-test.js [--races N] [--distance M] [--runners N] [--events none|low|normal|high|chaos] [--seed S] [--matrix] [--dump SEED] [--streamday]');
        process.exit(0);
        break;
      default:
        console.error('Unknown argument: ' + a);
        process.exit(2);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(SD.CONFIG.RACE.EVENTS.SLIDER, o.events)) {
    console.error('--events must be one of ' + Object.keys(SD.CONFIG.RACE.EVENTS.SLIDER).join(', '));
    process.exit(2);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const pad = function (s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
const lpad = function (s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const pct = function (x) { return (x * 100).toFixed(1) + '%'; };

function rosterRunners() {
  return SD.DATA.ROSTER.map(function (e, i) { return SD.runners.spawnFromRoster(e, i); });
}

function clone(id, name, stats, style, abilityId, extra) {
  return Object.assign({
    id: id, name: name, emoji: '', style: style || 'paceChaser', abilityId: abilityId || null,
    stats: Object.assign({ speed: 40, stamina: 40, power: 40, wisdom: 40, luck: 40 }, stats || {}),
    level: 1, energy: 100, maxEnergy: 100, fatigue: 10, condition: 'Excellent', mood: 'Happy', owner: null
  }, extra || {});
}

function checkRecordSane(rec) {
  for (let t = 0; t < rec.ticks.length; t++) {
    const pos = rec.ticks[t].pos;
    for (let k = 0; k < pos.length; k++) {
      const p = pos[k];
      if (!isFinite(p.d) || !isFinite(p.v) || !isFinite(p.st) || !(p.rank >= 1)) return 'NaN/invalid at tick ' + t + ' runner ' + p.id;
    }
  }
  for (let k = 0; k < rec.results.length; k++) {
    const r = rec.results[k];
    if (!isFinite(r.timeSec) || !isFinite(r.finishTick) || !isFinite(r.margin) || !isFinite(r.xp)) return 'NaN in results for ' + r.runnerId;
  }
  return null;
}

// Global counters across every simulated race (for the NaN / MAX_TICKS assertions).
const GLOBAL = { races: 0, insane: [], timedOut: 0, maxTickRatio: 0 };

/*
 * Run `count` races. fieldFor(i, rng) returns the runner objects for race i.
 * Returns aggregate statistics.
 */
function runBatch(label, count, distance, events, fieldFor, seedBase, extra) {
  extra = extra || {};
  const stats = {};    // runnerId -> aggregates
  const styleWins = {}; const styleEntries = {};
  let evTotal = 0, critTotal = 0, tickSum = 0, tickSq = 0, simMs = 0, photo = 0, upsets = 0, bestForm = 0;
  const nominal = distance / (SD.CONFIG.RACE.BASE_SPEED * SD.CONFIG.RACE.DT);
  const maxTicks = Math.ceil(nominal * SD.CONFIG.RACE.MAX_TICKS_MULT);
  for (let i = 0; i < count; i++) {
    const seed = SD.rng.seedFrom(seedBase, label, distance, events, i);
    const laneRng = SD.rng.create(SD.rng.seedFrom(seed, 'lanes'));
    const field = laneRng.shuffle(fieldFor(i, laneRng).slice());
    const entrants = SD.race.buildEntrants(field, { distance: distance, hypeLevel: extra.hype || 0, dayEvent: null });
    const t0 = process.hrtime.bigint();
    const rec = SD.race.simulate({
      seed: seed, distance: distance, entrants: entrants, eventFrequency: events,
      hypeLevel: extra.hype || 0, dayEvent: null, chatEffects: extra.chatEffects || []
    });
    simMs += Number(process.hrtime.bigint() - t0) / 1e6;
    GLOBAL.races++;
    const bad = checkRecordSane(rec);
    if (bad) GLOBAL.insane.push(label + ' seed ' + seed + ': ' + bad);
    if (rec.summary.timedOut || rec.totalTicks >= maxTicks) GLOBAL.timedOut++;
    GLOBAL.maxTickRatio = Math.max(GLOBAL.maxTickRatio, rec.totalTicks / nominal);
    evTotal += rec.summary.eventsCount;
    critTotal += rec.summary.critsCount;
    tickSum += rec.totalTicks;
    tickSq += rec.totalTicks * rec.totalTicks;
    if (rec.summary.photoFinish) photo++;
    if (rec.summary.upset) upsets++;
    const entrantById = {};
    rec.entrants.forEach(function (e) { entrantById[e.runnerId] = e; });
    const topForm = Math.max.apply(null, rec.entrants.map(function (e) { return e.form; }));
    if (entrantById[rec.results[0].runnerId].form === topForm) bestForm++;
    rec.results.forEach(function (res) {
      const e = entrantById[res.runnerId];
      const s = stats[res.runnerId] || (stats[res.runnerId] = {
        id: res.runnerId, name: e.name, style: e.style, entered: 0, wins: 0, podiums: 0, placeSum: 0, timeSum: 0,
        walls: 0, procs: 0, impliedSum: 0, oddsSum: 0
      });
      s.entered++;
      if (res.place === 1) s.wins++;
      if (res.place <= 3) s.podiums++;
      s.placeSum += res.place;
      s.timeSum += res.timeSec;
      if (res.wallHit) s.walls++;
      s.procs += res.abilityActivations.length;
      s.impliedSum += e.winProb;
      s.oddsSum += e.odds;
      styleEntries[e.style] = (styleEntries[e.style] || 0) + 1;
      if (res.place === 1) styleWins[e.style] = (styleWins[e.style] || 0) + 1;
    });
  }
  const mean = tickSum / count;
  return {
    label: label, count: count, distance: distance, events: events, stats: stats, styleWins: styleWins, styleEntries: styleEntries,
    eventsPerRace: evTotal / count, critsPerRace: critTotal / count, ticksMean: mean,
    ticksStd: Math.sqrt(Math.max(0, tickSq / count - mean * mean)), simMs: simMs, photoRate: photo / count, upsetRate: upsets / count,
    bestFormRate: bestForm / count
  };
}

function winRate(batch, id) {
  const s = batch.stats[id];
  return s && s.entered ? s.wins / s.entered : 0;
}

function printTable(batch, title) {
  console.log('\n' + title);
  console.log(pad('Runner', 14) + pad('Style', 13) + lpad('Races', 6) + lpad('Wins', 6) + lpad('Win%', 7) + lpad('Pod%', 7) +
    lpad('AvgPl', 6) + lpad('AvgT s', 8) + lpad('Wall%', 7) + lpad('Proc/r', 7) + lpad('ImplP', 7) + lpad('AvgOdds', 8));
  const rows = Object.keys(batch.stats).map(function (k) { return batch.stats[k]; })
    .sort(function (a, b) { return b.wins / b.entered - a.wins / a.entered; });
  let absErr = 0;
  rows.forEach(function (s) {
    const wr = s.wins / s.entered;
    const ip = s.impliedSum / s.entered;
    absErr += Math.abs(wr - ip);
    console.log(pad(s.name, 14) + pad(SD.DATA.STYLES[s.style].name, 13) + lpad(s.entered, 6) + lpad(s.wins, 6) + lpad(pct(wr), 7) +
      lpad(pct(s.podiums / s.entered), 7) + lpad((s.placeSum / s.entered).toFixed(2), 6) + lpad((s.timeSum / s.entered).toFixed(1), 8) +
      lpad(pct(s.walls / s.entered), 7) + lpad((s.procs / s.entered).toFixed(2), 7) + lpad(pct(ip), 7) + lpad((s.oddsSum / s.entered).toFixed(1), 8));
  });
  const styles = Object.keys(SD.DATA.STYLES).filter(function (st) { return batch.styleEntries[st]; });
  console.log('Per style (share of wins | win rate per entry): ' + styles.map(function (st) {
    return SD.DATA.STYLES[st].short + ' ' + pct((batch.styleWins[st] || 0) / batch.count) + ' | ' +
      pct((batch.styleWins[st] || 0) / batch.styleEntries[st]);
  }).join('   '));
  console.log('Events/race ' + batch.eventsPerRace.toFixed(2) + '   crits/race ' + batch.critsPerRace.toFixed(2) +
    '   ticks ' + batch.ticksMean.toFixed(1) + ' +/- ' + batch.ticksStd.toFixed(1) + '   photo finishes ' + pct(batch.photoRate) +
    '   upsets ' + pct(batch.upsetRate) + '   odds MAE ' + pct(absErr / rows.length) +
    '   sim ' + batch.simMs.toFixed(0) + ' ms / ' + batch.count + ' races');
  return absErr / rows.length;
}

// -----------------------------------------------------------------------------
// Assertions
// -----------------------------------------------------------------------------
const results = [];
function check(name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail || '' });
}

// Fields
const ROSTER = rosterRunners();
function firstN(n) { return function () { return ROSTER.slice(0, Math.min(n, ROSTER.length)); }; }
function rotated(n) {
  return function (i, rng) { return rng.shuffle(ROSTER.slice()).slice(0, Math.min(n, ROSTER.length)); };
}
function styleClones() {
  const styles = ['frontRunner', 'paceChaser', 'lateSurger', 'wildCard'];
  const field = [];
  styles.forEach(function (st, k) {
    field.push(clone('s' + k + 'a', SD.DATA.STYLES[st].name + ' A', null, st));
    field.push(clone('s' + k + 'b', SD.DATA.STYLES[st].name + ' B', null, st));
  });
  return function () { return field; };
}

function styleShares(batch) {
  const out = {};
  Object.keys(SD.DATA.STYLES).forEach(function (st) { out[st] = (batch.styleWins[st] || 0) / batch.count; });
  return out;
}

function extremes(rates) {
  return {
    lo: rates.reduce(function (a, b) { return b.wr < a.wr ? b : a; }),
    hi: rates.reduce(function (a, b) { return b.wr > a.wr ? b : a; })
  };
}

// Win-rate bounds. A single-distance run checks [5%, 40%] at that distance (floor 3% from
// 2000 m, where M4's stamina pools make distance specialists; see the header). In --matrix
// mode distance specialists are expected (Ember Tail fades at 2400 m, Moonhoof loves it),
// so [5%, 40%] applies to each runner's average across the four distances, and every
// single distance must still keep every runner in [3%, 40%] (nobody hopeless anywhere).
function rosterChecks(batch, distance, matrix) {
  const rates = ROSTER.map(function (r) { return { name: r.name, wr: winRate(batch, r.id) }; });
  const ex = extremes(rates);
  const floor = matrix || distance >= 2000 ? 0.03 : 0.05;
  check('win rates in [' + (floor * 100) + '%, 40%] with 8 runners @' + distance + 'm', ex.lo.wr >= floor && ex.hi.wr <= 0.40,
    'min ' + ex.lo.name + ' ' + pct(ex.lo.wr) + ', max ' + ex.hi.name + ' ' + pct(ex.hi.wr));
  // Odds calibration: implied win probability (from the odds model) vs actual win rate.
  let sumErr = 0, worst = { err: -1 };
  ROSTER.forEach(function (r) {
    const s = batch.stats[r.id];
    if (!s) return;
    const err = Math.abs(s.impliedSum / s.entered - s.wins / s.entered);
    sumErr += err;
    if (err > worst.err) worst = { err: err, name: r.name };
  });
  const mae = sumErr / ROSTER.length;
  // Tolerance allows ~2 sd of sampling noise per runner at 1000 races (~1.3pp each).
  check('odds calibration @' + distance + 'm: mean |implied - actual| <= 3pp, max <= 8pp', mae <= 0.03 && worst.err <= 0.08,
    'mean ' + pct(mae) + ', worst ' + worst.name + ' ' + pct(worst.err));
}

function styleChecks(batch, distance) {
  const sh = styleShares(batch);
  const vals = Object.keys(sh).map(function (k) { return sh[k]; });
  check('style spread 15-35% (style clones) @' + distance + 'm', Math.min.apply(null, vals) >= 0.15 && Math.max.apply(null, vals) <= 0.35,
    Object.keys(sh).map(function (k) { return SD.DATA.STYLES[k].short + ' ' + pct(sh[k]); }).join(', '));
}

// -----------------------------------------------------------------------------
// M4 sensitivity: one modified clone vs 7 base clones (all stats 40, Excellent, Happy)
// -----------------------------------------------------------------------------
const FATIGUE_FOR = { Excellent: 10, Good: 25, Normal: 45, Tired: 70, Exhausted: 95 };

function rosterAt(key, patch) {
  const idx = SD.DATA.ROSTER.findIndex(function (e) { return e.key === key; });
  const r = SD.runners.spawnFromRoster(SD.DATA.ROSTER[idx], idx);
  Object.assign(r, patch || {});
  if (patch && patch.stats) r.stats = Object.assign({}, patch.stats);
  r.maxEnergy = SD.runners.energyMax(r.level);
  r.energy = r.maxEnergy;
  r.fatigue = FATIGUE_FOR[r.condition];
  return r;
}

// The exact case from the M4 brief (1200 m): Velvet Comet and Moss Runner have the better
// stats; before M4 her Sleepy mood + Good condition cut her to ~1% (odds 25x).
function fourRunnerField(cometPatch) {
  return [
    rosterAt('thunderFern', { condition: 'Excellent', mood: 'Happy' }),
    rosterAt('moonhoof', { condition: 'Excellent', mood: 'Happy' }),
    rosterAt('mossRunner', { level: 3, condition: 'Normal', mood: 'Happy', stats: { speed: 45, stamina: 45, power: 42, wisdom: 43, luck: 40 } }),
    rosterAt('velvetComet', Object.assign({ level: 2, condition: 'Good', mood: 'Sleepy', stats: { speed: 58, stamina: 40, power: 35, wisdom: 43, luck: 31 } }, cometPatch || {}))
  ];
}

function sensitivity(N, ev) {
  const sensN = Math.max(N, 2000);
  const d = opts.distance;
  const base = [];
  for (let k = 0; k < 8; k++) base.push(clone('c' + (k + 1), 'Clone ' + (k + 1)));
  const one = function (label, x, dist) {
    const b = runBatch(label, sensN, dist || d, ev, function () { return [x].concat(base.slice(0, 7)); }, opts.seed);
    return { wr: winRate(b, x.id), implied: b.stats[x.id].impliedSum / b.stats[x.id].entered };
  };
  const rows = [];
  const show = function (name, r, target) { rows.push(pad(name, 44) + lpad(pct(r.wr), 7) + lpad(pct(r.implied), 9) + '   ' + target); return r.wr; };

  const ident = runBatch('clones', sensN, d, ev, function () { return base; }, opts.seed);
  const identRates = base.map(function (c) { return winRate(ident, c.id); });
  check('8 identical clones each 12.5% +/- 3 (' + sensN + ' races)', identRates.every(function (w) { return Math.abs(w - 0.125) <= 0.03; }),
    identRates.map(pct).join(' '));
  check('race-level luck: the clone with the best hidden form wins < 60% of identical-clone races', ident.bestFormRate < 0.60,
    pct(ident.bestFormRate) + ' (1 in 8 would be 12.5%)');

  const cond = {};
  ['Good', 'Normal', 'Tired', 'Exhausted'].forEach(function (c) {
    cond[c] = show('one clone ' + c + ' (others Excellent)', one('cond' + c, clone('x', 'X', null, null, null, { condition: c, fatigue: FATIGUE_FOR[c] })),
      { Good: '>= 8%', Normal: '', Tired: '>= 5%', Exhausted: '>= 2.5%' }[c]);
  });
  check('condition: Good clone >= 8%, Tired >= 5%, Exhausted >= 2.5% (others Excellent)',
    cond.Good >= 0.08 && cond.Tired >= 0.05 && cond.Exhausted >= 0.025,
    'Good ' + pct(cond.Good) + ', Tired ' + pct(cond.Tired) + ', Exhausted ' + pct(cond.Exhausted));
  check('condition penalty grows with fatigue (Good >= Tired >= Exhausted)', cond.Good >= cond.Tired && cond.Tired >= cond.Exhausted,
    pct(cond.Good) + ' / ' + pct(cond.Tired) + ' / ' + pct(cond.Exhausted));

  const mood = {};
  Object.keys(SD.DATA.MOODS).filter(function (m) { return m !== 'Happy'; }).forEach(function (m) {
    mood[m] = show('one clone ' + m + ' (others Happy)', one('mood' + m, clone('x', 'X', null, null, null, { mood: m })),
      '12.5 +/- 4' + (m === 'Sleepy' ? ', >= 9%' : m === 'Nervous' ? ', >= 8%' : ''));
  });
  check('mood: Sleepy clone >= 9%, Nervous >= 8% (others Happy)', mood.Sleepy >= 0.09 && mood.Nervous >= 0.08,
    'Sleepy ' + pct(mood.Sleepy) + ', Nervous ' + pct(mood.Nervous));
  check('mood: no mood moves a clone more than 4 points from 12.5%',
    Object.keys(mood).every(function (m) { return Math.abs(mood[m] - 0.125) <= 0.04; }),
    Object.keys(mood).map(function (m) { return m + ' ' + pct(mood[m]); }).join(', '));

  const spd = show('+20 Speed vs 7 base clones', one('fast', clone('x', 'X', { speed: 60 })), '25-45%');
  check('+20 Speed clone wins 25-45% vs 7 base clones', spd >= 0.25 && spd <= 0.45, pct(spd));
  const all8 = show('+8 to every stat vs 7 base clones', one('all8', clone('x', 'X', { speed: 48, stamina: 48, power: 48, wisdom: 48, luck: 48 })), '>= 35%');
  check('+8 to every stat (level-5-ish runner) wins >= 35% vs 7 base clones', all8 >= 0.35, pct(all8));
  const st12 = show('+20 Stamina @1200m', one('stam', clone('x', 'X', { stamina: 60 }), 1200), '');
  const st24 = show('+20 Stamina @2400m', one('stam', clone('x', 'X', { stamina: 60 }), 2400), '> @1200m');
  check('+20 Stamina clone gains more at 2400m than at 1200m', st24 > st12 + 0.02, pct(st12) + ' -> ' + pct(st24));
  ['power', 'wisdom', 'luck'].forEach(function (k) {
    const o = {}; o[k] = 60;
    show('+20 ' + SD.DATA.STAT_LABELS[k] + ' (info)', one('s' + k, clone('x', 'X', o)), '');
  });

  // 4-runner case from the brief
  const fourN = Math.max(N, 3000);
  const four = runBatch('four', fourN, 1200, ev, function () { return fourRunnerField(); }, opts.seed);
  const fourHappy = runBatch('four', fourN, 1200, ev, function () { return fourRunnerField({ condition: 'Excellent', mood: 'Happy' }); }, opts.seed);
  const f = fourRunnerField();
  const cometId = f[3].id, mossId = f[2].id;
  const fline = function (b) {
    return f.map(function (r) { return r.name + ' ' + pct(winRate(b, r.id)) + ' (odds ' + (b.stats[r.id].oddsSum / b.stats[r.id].entered).toFixed(1) + 'x)'; }).join(', ');
  };
  console.log('\nSENSITIVITY (8-runner clone fields, all stats 40, Excellent + Happy unless stated, ' + sensN + ' races @' + d + 'm)');
  console.log(pad('Field', 44) + lpad('Win%', 7) + lpad('Implied', 9) + '   Target');
  rows.forEach(function (r) { console.log(r); });
  console.log('identical clones: ' + identRates.map(pct).join(' ') + ' | best-form clone wins ' + pct(ident.bestFormRate));
  console.log('\n4-RUNNER CASE @1200m (' + fourN + ' races): ' + fline(four));
  console.log('  same, Velvet Comet Happy + Excellent: ' + fline(fourHappy));
  check('4-runner case @1200m: Velvet Comet >= 15% and Moss Runner >= 15% (better stats count)',
    winRate(four, cometId) >= 0.15 && winRate(four, mossId) >= 0.15, 'Velvet Comet ' + pct(winRate(four, cometId)) + ', Moss Runner ' + pct(winRate(four, mossId)));
  check('4-runner case: Happy + Excellent at most doubles Velvet Comet\'s win rate (was 50x before M4)',
    winRate(fourHappy, cometId) <= 2 * winRate(four, cometId), pct(winRate(four, cometId)) + ' -> ' + pct(winRate(fourHappy, cometId)));
}

// Mixed fields: some roster runners plus random species runners, random levels 1-8 (the
// level-ups spread 7 points per level over random stats), any condition / mood, some with
// low energy. Checks the odds model where bettors will actually use it.
function mixedField(i) {
  const rng = SD.rng.create(SD.rng.seedFrom(opts.seed, 'mixed-field', i));
  const n = 4 + rng.int(7);
  const moods = Object.keys(SD.DATA.MOODS);
  const conds = Object.keys(FATIGUE_FOR);
  const field = rng.shuffle(ROSTER.slice()).slice(0, Math.min(n, 6)).map(function (r) { return JSON.parse(JSON.stringify(r)); });
  while (field.length < n) field.push(SD.runners.spawnRandom(rng, { id: 'm' + field.length }));
  return field.map(function (r) {
    const lvl = rng.float() < 0.5 ? 1 : 1 + rng.int(8);
    r.level = lvl;
    r.maxEnergy = SD.runners.energyMax(lvl);
    const cap = SD.runners.statCap(lvl);
    for (let k = 0; k < (lvl - 1) * 7; k++) { const st = rng.pick(SD.CONFIG.STATS); r.stats[st] = Math.min(cap, r.stats[st] + 1); }
    r.condition = rng.float() < 0.45 ? 'Excellent' : rng.pick(conds);
    r.fatigue = FATIGUE_FOR[r.condition];
    r.mood = rng.float() < 0.4 ? 'Happy' : rng.pick(moods);
    r.energy = rng.float() < 0.6 ? r.maxEnergy : 15 + rng.int(85);
    return r;
  });
}

function mixedCalibration(count, ev) {
  const d = opts.distance;
  const buckets = [[0, 0.05], [0.05, 0.10], [0.10, 0.20], [0.20, 0.35], [0.35, 1.01]].map(function (b) { return { lo: b[0], hi: b[1], n: 0, p: 0, w: 0 }; });
  for (let i = 0; i < count; i++) {
    const seed = SD.rng.seedFrom(opts.seed, 'mixed', d, i);
    const entrants = SD.race.buildEntrants(mixedField(i), { distance: d });
    const rec = SD.race.simulate({ seed: seed, distance: d, entrants: entrants, eventFrequency: ev });
    GLOBAL.races++;
    const bad = checkRecordSane(rec);
    if (bad) GLOBAL.insane.push('mixed seed ' + seed + ': ' + bad);
    rec.entrants.forEach(function (e) {
      const b = buckets.filter(function (x) { return e.winProb >= x.lo && e.winProb < x.hi; })[0];
      b.n++; b.p += e.winProb; if (e.runnerId === rec.results[0].runnerId) b.w++;
    });
  }
  const txt = buckets.map(function (b) {
    return Math.round(b.lo * 100) + '-' + Math.round(Math.min(1, b.hi) * 100) + '%: implied ' + pct(b.p / b.n) + ' actual ' + pct(b.w / b.n) + ' (n ' + b.n + ')';
  });
  console.log('\nODDS ON MIXED FIELDS @' + d + 'm (' + count + ' races): ' + txt.join(' | '));
  const worst = buckets.reduce(function (a, b) { return Math.max(a, Math.abs(b.p / b.n - b.w / b.n)); }, 0);
  check('odds calibration on mixed fields (levels 1-8, any condition / mood / energy) @' + d + 'm: every bucket within 4pp', worst <= 0.04,
    'worst bucket off by ' + pct(worst));
}

// -----------------------------------------------------------------------------
// --dump
// -----------------------------------------------------------------------------
function dump(seedArg) {
  const seed = Number(seedArg) >>> 0;
  const field = SD.rng.create(SD.rng.seedFrom(seed, 'lanes')).shuffle(ROSTER.slice(0, opts.runners));
  const entrants = SD.race.buildEntrants(field, { distance: opts.distance, hypeLevel: 0 });
  const rec = SD.race.simulate({ seed: seed, distance: opts.distance, entrants: entrants, eventFrequency: opts.events, hypeLevel: 0 });
  const ticks = rec.ticks;
  const copy = Object.assign({}, rec, { ticks: '[' + ticks.length + ' ticks below]' });
  console.log(JSON.stringify(copy, null, 2));
  console.log('\nTICKS (t phase | id d v st rank fx)');
  ticks.forEach(function (tk) {
    console.log(lpad(tk.t, 4) + ' ' + pad(tk.phase, 13) + '| ' + tk.pos.map(function (p) {
      return p.id + ' ' + p.d.toFixed(1) + ' ' + p.v.toFixed(1) + ' ' + p.st.toFixed(2) + ' #' + p.rank + (p.fx.length ? ' [' + p.fx.join(',') + ']' : '');
    }).join(' | '));
  });
}

// -----------------------------------------------------------------------------
// --streamday
// -----------------------------------------------------------------------------
function streamday() {
  let now = Date.UTC(2026, 0, 1, 18, 0, 0);
  SD.clock.set(function () { return now; });
  SD.state.set(SD.state.create({ seedSalt: opts.seed }));
  SD.game.init();
  const s = SD.state.get();
  const hero = s.runners[0];
  hero.owner = 'tester'; // owned runners are always picked for the field when they have energy
  function rep(x, n) { const a = []; for (let i = 0; i < n; i++) a.push(x); return a; }
  // The plan's story: chat hammers !train 20 times WITHOUT resting, pushing well past energy 30
  // (training resumes as soon as passive regen allows). Once regen reaches race energy the
  // overtrained runner races; then chat finally rests it three times and the next races improve.
  const plan = [].concat(
    rep('train', 20),
    ['waitRace', 'race', 'rest', 'wait3', 'rest', 'wait3', 'rest', 'race', 'wait5', 'race']
  );
  // The UI calls game.tickClock() every 30 s; advance the fake clock the same way.
  function passMinutes(min) {
    for (let k = 0; k < min * 2; k++) { now += 30000; SD.game.tickClock(); }
  }
  const statCycle = ['speed', 'speed', 'stamina', 'speed', 'power', 'speed', 'wisdom', 'luck'];
  console.log('\nSTREAM DAY: ' + hero.name + ' (owned by tester): 20 !train (no rests), race, 3 !rest, 2 more races');
  console.log(pad('#', 4) + pad('Action', 16) + pad('Outcome', 40) + lpad('Energy', 8) + lpad('Fatigue', 9) + '  ' +
    pad('Condition', 11) + pad('Mood', 12) + 'Stats');
  let step = 0, trains = 0, ok = 0, penalty = null;
  const conditionAtRace = [];
  function row(action, outcome) {
    step++;
    console.log(pad(step, 4) + pad(action, 16) + pad(outcome, 40) + lpad(hero.energy.toFixed(1), 8) + lpad(hero.fatigue.toFixed(1), 9) + '  ' +
      pad(hero.condition, 11) + pad(hero.mood, 12) + SD.CONFIG.STATS.map(function (k) { return SD.DATA.STAT_SHORT[k] + hero.stats[k]; }).join(' '));
  }
  plan.forEach(function (action) {
    if (action === 'train') {
      // One chat !train per minute; when the runner is too drained, chat waits for regen.
      let waited = 1;
      passMinutes(1);
      while (hero.energy < SD.CONFIG.TRAINING.MIN_ENERGY && waited < 60) { passMinutes(1); waited++; }
      const stat = statCycle[trains % statCycle.length];
      trains++;
      const r = SD.game.trainRunner(hero.id, stat, 'tester');
      if (r.ok) ok++;
      row('train ' + stat, (waited > 1 ? '(+' + waited + 'm) ' : '') +
        (r.ok ? r.outcome + ' +' + r.gain + (r.levelUps ? ' LEVEL UP' : '') : 'refused: ' + r.message.slice(0, 31)));
    } else if (action === 'rest') {
      passMinutes(1);
      const r = SD.game.restRunner(hero.id, 'tester');
      row('rest', r.ok ? 'rested, energy +' + Math.round(r.energyGain) : 'refused: ' + r.message.slice(0, 31));
    } else if (action === 'waitRace') {
      let min = 0;
      while (hero.energy < SD.CONFIG.RACE.MIN_ENERGY_TO_RACE + 1 && min < 120) { passMinutes(1); min++; }
      row('(' + min + ' min)', 'regen until race-eligible');
    } else if (action.indexOf('wait') === 0) {
      const min = parseInt(action.slice(4), 10);
      passMinutes(min);
      row('(' + min + ' min)', 'passive regen');
    } else {
      const condBefore = hero.condition, energyBefore = hero.energy;
      const st = SD.game.startRace({ runnerCount: 4, distance: 1600 });
      if (!st.ok) { row('race', 'no race: ' + st.message.slice(0, 30)); return; }
      const inRace = st.record.entrants.some(function (e) { return e.runnerId === hero.id; });
      if (inRace && !penalty) {
        // The same field with the hero fresh (Excellent, full energy), for comparison.
        const ents = st.record.entrants.map(function (e) { return Object.assign({}, e); });
        const me = ents.filter(function (e) { return e.runnerId === hero.id; })[0];
        const tiredOdds = me.odds, mult = SD.race.raceStatMult(me);
        me.condition = 'Excellent'; me.energy = me.maxEnergy;
        SD.race.assignOdds(ents, st.record.distance);
        penalty = { condition: condBefore, energy: energyBefore, mult: mult, odds: tiredOdds, freshOdds: me.odds };
      }
      SD.game.endRace();
      const res = st.record.results.filter(function (x) { return x.runnerId === hero.id; })[0];
      if (inRace) conditionAtRace.push(condBefore);
      row('race 1600m', inRace ? 'raced ' + condBefore + ' @' + Math.floor(energyBefore) + ' energy: ' + SD.util.ordinal(res.place) + '/' + st.record.results.length
        : 'sat out (energy ' + Math.floor(energyBefore) + ' < ' + SD.CONFIG.RACE.MIN_ENERGY_TO_RACE + ')');
    }
  });
  console.log('Successful trains: ' + ok + '/20. Level ' + hero.level + ', total XP ' + hero.totalXp + '. Season ' + s.season.number + ' day ' + s.season.day + '.');
  if (penalty) {
    console.log('Race penalty at the first race: ' + penalty.condition + ' with ' + Math.floor(penalty.energy) + ' energy -> race-day stats x' +
      penalty.mult.toFixed(3) + ' (condition x' + SD.runners.conditionRaceMult(penalty.condition) + ', energy x' +
      (penalty.mult / SD.runners.conditionRaceMult(penalty.condition)).toFixed(3) + '); odds ' + penalty.odds + 'x vs ' + penalty.freshOdds + 'x if fresh.');
  }
  check('stream day: 20 trains without rest leave the runner Exhausted for its first race', conditionAtRace[0] === 'Exhausted',
    'condition at first race: ' + (conditionAtRace[0] || 'did not race'));
  check('stream day: the overtrained runner races with a real penalty (stats x0.9 or less, longer odds than fresh)',
    !!penalty && penalty.mult <= 0.9 && penalty.odds > penalty.freshOdds,
    penalty ? 'stats x' + penalty.mult.toFixed(3) + ', odds ' + penalty.odds + 'x vs ' + penalty.freshOdds + 'x fresh' : 'no race');
  SD.clock.reset();
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
(function main() {
  if (opts.dump != null) { dump(opts.dump); return; }
  const N = opts.races;
  const ev = opts.events;
  console.log('Spirit Derby balance test v' + SD.VERSION + ' | races ' + N + ' | events ' + ev + ' | seed ' + opts.seed +
    (opts.matrix ? ' | MATRIX' : ' | distance ' + opts.distance + ' | runners ' + opts.runners));

  // 1. Main table (first N roster runners) + timing
  const main = runBatch('main', N, opts.distance, ev, firstN(opts.runners), opts.seed);
  printTable(main, 'ROSTER: first ' + Math.min(opts.runners, ROSTER.length) + ' runners @ ' + opts.distance + 'm (' + N + ' races)');
  const per1000 = main.simMs / N * 1000;
  check('1000 races < 3 s', per1000 < 3000, (per1000 / 1000).toFixed(2) + ' s per 1000 races (' + opts.distance + 'm, ' + Math.min(opts.runners, 10) + ' runners)');

  // 2. Roster (8-of-10 rotated) and style-clone checks per distance
  const distances = opts.matrix ? SD.CONFIG.RACE.DISTANCES : [opts.distance];
  const rotatedByDist = {};
  const styleN = Math.max(N, opts.quick ? 1000 : 2000);
  distances.forEach(function (d) {
    const rot = runBatch('rot8', N, d, ev, rotated(8), opts.seed);
    rotatedByDist[d] = rot;
    printTable(rot, 'ROSTER 8-of-10 rotated @ ' + d + 'm (' + N + ' races)');
    rosterChecks(rot, d, opts.matrix);
    const sty = runBatch('styles', styleN, d, ev, styleClones(), opts.seed);
    const sh = styleShares(sty);
    console.log('STYLE CLONES @ ' + d + 'm (2 per style, all stats 40): ' +
      Object.keys(sh).map(function (k) { return SD.DATA.STYLES[k].name + ' ' + pct(sh[k]); }).join('   ') +
      '   | wall% ' + pct(Object.keys(sty.stats).reduce(function (a, k) { return a + sty.stats[k].walls; }, 0) / (sty.count * 8)));
    styleChecks(sty, d);
  });

  if (opts.matrix) {
    const avg = ROSTER.map(function (r) {
      let sum = 0;
      distances.forEach(function (d) { sum += winRate(rotatedByDist[d], r.id); });
      return { name: r.name, wr: sum / distances.length };
    });
    console.log('\nAVERAGE WIN RATE ACROSS DISTANCES (8-of-10 fields): ' + avg.map(function (a) { return a.name + ' ' + pct(a.wr); }).join(', '));
    const ex = extremes(avg);
    check('win rates in [5%, 40%] with 8 runners (average over the matrix)', ex.lo.wr >= 0.05 && ex.hi.wr <= 0.40,
      'min ' + ex.lo.name + ' ' + pct(ex.lo.wr) + ', max ' + ex.hi.name + ' ' + pct(ex.hi.wr));
  }

  // 3. Distance preference: Ember Tail (speed, low stamina) vs Moonhoof (stamina)
  [1200, 2400].forEach(function (d) {
    if (!rotatedByDist[d]) rotatedByDist[d] = runBatch('rot8', N, d, ev, rotated(8), opts.seed);
  });
  const e12 = winRate(rotatedByDist[1200], 'r04'), e24 = winRate(rotatedByDist[2400], 'r04');
  const m12 = winRate(rotatedByDist[1200], 'r02'), m24 = winRate(rotatedByDist[2400], 'r02');
  check('Ember Tail wins more at 1200m than 2400m', e12 > e24, pct(e12) + ' vs ' + pct(e24));
  check('Moonhoof wins more at 2400m than 1200m', m24 > m12, pct(m24) + ' vs ' + pct(m12));

  // 4. Clone fairness and sensitivity (M4): stats must matter more than race-day modifiers.
  sensitivity(N, ev);

  // 4b. Odds on realistic mid-season fields (levels, fatigue, moods, low energy).
  mixedCalibration(Math.max(N, 2000), ev);

  // 5. Determinism (with every system switched on: chaos events, hype 100, chat effects)
  const detField = SD.race.buildEntrants(ROSTER.slice(0, 8), { distance: 2000, hypeLevel: 110 });
  const detOpts = function (seed) {
    return {
      seed: seed, distance: 2000, entrants: detField, eventFrequency: 'chaos', hypeLevel: 110,
      dayEvent: 'cryptidSeason', trackName: 'Hollow Glade',
      chatEffects: [{ runnerId: 'r01', type: 'boost', by: 'alice' }, { runnerId: 'r03', type: 'sabotage', by: 'bob' },
        { runnerId: 'r05', type: 'sabotage', by: 'carol' }]
    };
  };
  const a = SD.race.simulate(detOpts(777)), b = SD.race.simulate(detOpts(777)), c = SD.race.simulate(detOpts(778));
  check('determinism: same seed -> identical hash and ticks', a.hash === b.hash && JSON.stringify(a.ticks) === JSON.stringify(b.ticks) &&
    JSON.stringify(a.events) === JSON.stringify(b.events), a.hash + ' / ' + b.hash);
  check('determinism: different seed -> different hash', a.hash !== c.hash, a.hash + ' / ' + c.hash);
  [a, c].forEach(function (rec) { const bad = checkRecordSane(rec); if (bad) GLOBAL.insane.push('determinism: ' + bad); });

  // 6. Global sanity
  check('no NaN in any tick or result (' + GLOBAL.races + ' races)', GLOBAL.insane.length === 0, GLOBAL.insane.slice(0, 3).join('; '));
  check('every race finishes under MAX_TICKS', GLOBAL.timedOut === 0,
    GLOBAL.timedOut + ' timeouts, slowest race ' + GLOBAL.maxTickRatio.toFixed(2) + 'x nominal ticks');

  if (opts.streamday) streamday();

  // Report
  console.log('\nASSERTIONS');
  let failed = 0;
  results.forEach(function (r) {
    if (!r.pass) failed++;
    console.log((r.pass ? '  PASS ' : '  FAIL ') + r.name + (r.detail ? '  (' + r.detail + ')' : ''));
  });
  console.log(failed ? '\n' + failed + ' assertion(s) FAILED' : '\nAll ' + results.length + ' assertions passed.');
  process.exitCode = failed ? 1 : 0;
})();
