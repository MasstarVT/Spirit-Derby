#!/usr/bin/env node
/*
 * Spirit Derby - tools/rng-test.js (review batch 5: RNG entropy, seed secrecy and replay safety)
 *   A  SD.entropy (the injected randomness hook, like SD.clock): off by default in Node, a source
 *      that throws / returns junk counts as "none"; state.create draws its seed salt from it
 *   B  race seeds cannot be predicted (gap1 RNG#1 / #2): the salt is not a hash of the creation time,
 *      a leaked race seed (COPY LAST RACE JSON) inverted through FNV-1a predicts the next race only
 *      without an entropy source, the salt is re-drawn at every race start, the paddock preview is
 *      still the real field and races still replay to their hash
 *   C  shared JSON (gap1 RNG#2): EXPORT JSON carries no seed salt and no seed override; COPY LAST
 *      RACE JSON never carries the salt
 *   D  save rollback (gap2 rollback#1): importing an older export or reloading an older save does not
 *      replay the races the audience already watched; without entropy (Node) runs stay reproducible
 *   E  per-action randomness (training, !create, day events) mixes in fresh entropy
 *   F  refused trainings (gap1 RNG#3) draw no action RNG, emit no state:changed and stamp no cooldown
 *   G  the debug seed override is never saved (test-to-live#5): save / export / load / import
 *   H  hashRecord(storedRecord) === record.hash after finishRace (determinism-contract#2)
 *   I  rollStats hands the remainder to the most-favoured stat first (runners-data#7)
 *   J  the paddock lane order does not determine the race (gap1 RNG#1, fix round 1): a brute force of
 *      the field seed from the shown lane order finds it, but the race runs on fresh gate entropy
 *
 *   node tools/rng-test.js [--verbose]
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

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------
let NOW = 1767225600000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }
SD.persistence.setAutoSave(false);
SD.achievements.disable();
const P = SD.persistence;
const HAS_ENTROPY = !!(SD.entropy && typeof SD.entropy.set === 'function');

// A test entropy source: a fixed-seed generator the "attacker" below knows nothing about.
function entropyFrom(seed) {
  const g = SD.rng.create(seed);
  return function () { return Math.floor(g.float() * 4294967296); };
}
function entropyOn(seed) { if (HAS_ENTROPY) SD.entropy.set(entropyFrom(seed)); }
function entropyOff() { if (HAS_ENTROPY) SD.entropy.reset(); }

function resetRuntime() {
  const rt = SD.state.runtime;
  rt.cooldowns = {}; rt.runnerCooldowns = {}; rt.chatFeed = []; rt.nervousCheers = {}; rt.activity = {}; rt.hypeRecent = {};
}
function fresh(opts) {
  resetRuntime();
  SD.state.set(SD.state.create(Object.assign({ dayEventId: 'clearSkies' }, opts || {})));
  SD.game.init();
  if (SD.betting.clearCache) SD.betting.clearCache();
  tick(60000);
  return SD.state.get();
}
function S() { return SD.state.get(); }
function say(user, text, opts) { tick(11000); return SD.processCommand(user, text, Object.assign({ source: 'twitch' }, opts || {})); }
function joinViewers() {
  ['alice', 'bob', 'cara', 'dan'].forEach(function (u) { say(u, '!join'); });
}
// Runs one race start to finish (restores the day when the runners are spent) and returns what the
// audience saw: seed, track, the field in lane order and the podium.
function runRace() {
  let st = SD.game.startRace();
  if (!st.ok) {
    if (S().season.raceIndexInDay >= S().season.racesPerDay) SD.game.nextDay();
    else SD.game.resetDay();
    st = SD.game.startRace();
  }
  if (!st.ok) return { error: st.message };
  const rec = st.record;
  SD.game.endRace();
  tick(120000);
  return {
    id: rec.id, seed: rec.seed, track: rec.trackName,
    lanes: rec.entrants.map(function (e) { return e.runnerId; }).join(','),
    podium: rec.results.slice(0, 3).map(function (r) { return r.runnerId; }).join(',')
  };
}
function runRaces(n) { const out = []; for (let i = 0; i < n; i++) out.push(runRace()); return out; }
function countEvents(name, fn) {
  let n = 0;
  const off = SD.bus.on(name, function () { n++; });
  try { fn(); } finally { off(); }
  return n;
}

// FNV-1a inversion (the verifier's attack): every step is h = (h ^ c) * PRIME mod 2^32, and PRIME is
// odd, so it can be undone. back(seed, suffix) recovers the hash state after the salt string; fwd()
// then computes any other seedFrom(salt, ...) without ever knowing the salt.
const PRIME = 0x01000193;
const PINV = (function (a) { let x = a; for (let i = 0; i < 5; i++) x = Math.imul(x, (2 - Math.imul(a, x)) | 0); return x >>> 0; })(PRIME);
function back(h, suffix) {
  for (let i = suffix.length - 1; i >= 0; i--) h = ((Math.imul(h, PINV) >>> 0) ^ suffix.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
function fwd(h, suffix) {
  for (let i = 0; i < suffix.length; i++) { h ^= suffix.charCodeAt(i); h = Math.imul(h, PRIME); }
  return h >>> 0;
}
// Predict the next race's seed from a leaked RaceRecord (id 's{S}d{D}r{i}-{counter}' + seed).
function predictNextSeed(rec, st) {
  const m = /^s(\d+)d(\d+)r\d+-(\d+)$/.exec(rec.id);
  const X = back(rec.seed >>> 0, ':' + m[1] + ':' + m[2] + ':' + m[3]);
  return fwd(X, ':' + st.season.number + ':' + st.season.day + ':' + (st.meta.raceCounter + 1));
}

// =============================================================================
section('A. SD.entropy: the injected randomness hook');
// =============================================================================
{
  ok(HAS_ENTROPY, 'SD.entropy exists (next / set / reset / available)');
  if (HAS_ENTROPY) {
    eq(SD.entropy.next(), null, 'no source installed in Node: next() is null');
    eq(SD.entropy.available(), false, 'available() is false');
    SD.entropy.set(function () { return 4294967296 + 7; });
    eq(SD.entropy.next(), 7, 'a source value is reduced to its low 32 bits');
    SD.entropy.set(function () { return 'x'; });
    eq(SD.entropy.next(), null, 'a non-number counts as no entropy');
    SD.entropy.set(function () { throw new Error('boom'); });
    eq(SD.entropy.next(), null, 'a throwing source counts as no entropy (never breaks the game)');
    SD.entropy.set(null);
    eq(SD.entropy.available(), false, 'set(null) removes the source');

    entropyOff();
    const a = SD.state.create();
    eq(a.meta.seedSalt, SD.rng.hash('spirit-derby:' + a.meta.createdAt), 'without entropy (Node / tests) the salt is still the reproducible creation-time hash');
    SD.entropy.set(function () { return 0xdeadbeef; });
    const b = SD.state.create();
    eq(b.meta.seedSalt, 0xdeadbeef, 'with a source, state.create draws the salt from it');
    eq(SD.state.create({ seedSalt: 5 }).meta.seedSalt, 5, 'an explicit opts.seedSalt still wins');
    entropyOff();
  }
}

// =============================================================================
section('B. Race seeds cannot be predicted (gap1 RNG#1 / #2)');
// =============================================================================
{
  // Control: without entropy the verifier's inversion works (this is the pre-fix behaviour in the browser).
  entropyOff();
  fresh();
  joinViewers();
  const leaked0 = runRace();
  const predicted0 = predictNextSeed(leaked0, S());
  eq(predicted0, SD.game.seedForRace(), 'control: without entropy one leaked seed + id predicts the next race seed (FNV-1a inverts)');

  entropyOn(1234567);
  fresh();
  const st = S();
  ok(st.meta.seedSalt !== SD.rng.hash('spirit-derby:' + st.meta.createdAt), 'with entropy the salt is not a hash of meta.createdAt');
  joinViewers();
  let predictedHits = 0, previewMatches = 0, gateSeeds = 0, replayed = 0, resalted = 0, total = 0;
  let prev = null, prevState = null;
  for (let i = 0; i < 12; i++) {
    const before = S().meta.seedSalt;
    const preview = SD.game.previewField().map(function (r) { return r.id; }).join(',');
    const again = SD.game.previewField().map(function (r) { return r.id; }).join(',');
    const expectSeed = SD.game.seedForRace();
    const r = runRace();
    if (r.error) { ok(false, 'race ' + i + ' starts', r.error); break; }
    total++;
    if (preview === again && preview === r.lanes) previewMatches++;
    if (r.seed !== expectSeed) gateSeeds++;
    if (S().meta.seedSalt !== before) resalted++;
    if (prev && predictNextSeed(prev, prevState) === r.seed) predictedHits++;
    if (SD.game.replayLastRace().sameHash) replayed++;
    prev = S().raceHistory[S().raceHistory.length - 1];
    prevState = JSON.parse(JSON.stringify({ season: S().season, meta: S().meta }));
  }
  eq(total, 12, '12 races run with an entropy source');
  eq(previewMatches, total, 'the paddock preview is stable and is the real field in lane order');
  eq(gateSeeds, total, 'the race runs on a gate seed with fresh entropy, not on the paddock seed (seedForRace())');
  eq(resalted, total, 'the seed salt is re-drawn at every race start');
  eq(predictedHits, 0, 'a leaked race seed (COPY LAST RACE JSON) never predicts the next race seed');
  eq(replayed, total, 'every race still replays to its stored hash (records keep their own seed)');

  // A debug seed override still wins (and is not re-salted away).
  SD.game.updateSettings({ debug: true, seedOverride: 999 });
  eq(SD.game.seedForRace(), 999, 'a debug seed override still fixes the seed while it is set');
  const o = runRace();
  eq(o.seed, 999, 'and the race uses it');
  SD.game.updateSettings({ debug: false, seedOverride: null });
  entropyOff();
}

// =============================================================================
section('C. Shared JSON never carries the seed salt or the seed override (gap1 RNG#2)');
// =============================================================================
{
  entropyOn(42);
  fresh();
  joinViewers();
  runRaces(2);
  SD.game.updateSettings({ debug: true, seedOverride: 4242 });
  const exp = JSON.parse(P.exportJSON());
  ok(!('seedSalt' in exp.meta), 'EXPORT JSON has no meta.seedSalt');
  eq(exp.settings.seedOverride, null, 'EXPORT JSON has no seed override');
  eq(S().settings.seedOverride, 4242, 'exporting does not change the running game');
  ok(typeof S().meta.seedSalt === 'number', 'the live game keeps its salt');
  const text = SD.debug.lastRaceJSON(true);
  ok(text.indexOf('seedSalt') < 0 && text.indexOf(String(S().meta.seedSalt)) < 0, 'COPY LAST RACE JSON carries no salt');
  ok(JSON.parse(text).record.seed != null, 'it still has the race\'s own seed (replayable bug reports)');
  SD.game.updateSettings({ debug: false, seedOverride: null });
  entropyOff();
}

// =============================================================================
section('D. A rolled-back save does not replay watched races (gap2 rollback#1)');
// =============================================================================
{
  // Control: without entropy (Node) an import replays exactly - that is what kept the suites reproducible
  // and what the browser did before this batch.
  entropyOff();
  fresh({ seedSalt: 777 });
  joinViewers();
  P.save();
  const raw0 = P.readRaw(P.KEY);
  const firstRun = runRaces(3);
  P._memoryStore.setItem(P.KEY, raw0);
  SD.state.set(P.load().state);
  SD.game.init();
  const secondRun = runRaces(3);
  eq(secondRun.map(function (r) { return r.seed; }), firstRun.map(function (r) { return r.seed; }),
    'control: without entropy a reloaded save replays the same races (reproducible tests)');

  // IMPORT of an older export, with entropy (the browser).
  entropyOn(99);
  fresh();
  joinViewers();
  const backup = P.exportJSON();
  const watched = runRaces(3);
  ok(watched.every(function (r) { return !r.error; }), 'three races watched');
  const imp = P.importJSON(backup);
  ok(imp.ok, 'the older export imports');
  const replay = runRaces(3);
  let sameSeed = 0, sameAll = 0;
  replay.forEach(function (r, i) {
    if (r.seed === watched[i].seed) sameSeed++;
    if (r.track === watched[i].track && r.lanes === watched[i].lanes && r.podium === watched[i].podium) sameAll++;
  });
  eq(sameSeed, 0, 'after IMPORT of an older export no race seed repeats');
  ok(sameAll < 3, 'and the watched track / lanes / podium sequence does not come back', sameAll);

  // A reload of an older save (stale second window, failed autosaves).
  fresh();
  joinViewers();
  P.save();
  const oldRaw = P.readRaw(P.KEY);
  const watched2 = runRaces(3);
  P._memoryStore.setItem(P.KEY, oldRaw);
  const loaded = P.load();
  ok(loaded.fromStorage, 'the older save loads');
  SD.state.set(loaded.state);
  SD.game.init();
  const replay2 = runRaces(3);
  eq(replay2.filter(function (r, i) { return r.seed === watched2[i].seed; }).length, 0, 'after reloading an older save no race seed repeats');

  // Two copies of the same save (OBS source + browser tab) diverge too.
  const a = P.load().state.meta.seedSalt;
  const b = P.load().state.meta.seedSalt;
  ok(a !== b, 'two loads of the same save get different salts', [a, b]);
  entropyOff();
}

// =============================================================================
section('E. Per-action randomness mixes in fresh entropy');
// =============================================================================
{
  function trainOutcomes(useEntropy) {
    fresh({ seedSalt: 31337 });
    const snap = JSON.stringify(S());
    const seen = {};
    for (let i = 0; i < 24; i++) {
      SD.state.set(JSON.parse(snap));
      if (useEntropy) entropyOn(1000 + i); else entropyOff();
      const moss = SD.state.findRunner('moss').runner;
      const res = SD.game.trainRunner(moss.id, 'speed', 'tester');
      seen[res.outcome + ':' + res.gain + ':' + S().runners[0].mood] = true;
    }
    entropyOff();
    return Object.keys(seen).length;
  }
  eq(trainOutcomes(false), 1, 'without entropy the same state trains the same way (reproducible tests)');
  ok(trainOutcomes(true) > 1, 'with entropy the same state (e.g. a rolled-back save) does not train the same way');

  function spawnStats(useEntropy) {
    fresh({ seedSalt: 31337 });
    const snap = JSON.stringify(S());
    const seen = {};
    for (let i = 0; i < 8; i++) {
      SD.state.set(JSON.parse(snap));
      if (useEntropy) entropyOn(5000 + i); else entropyOff();
      const r = SD.game.spawnRunner({});
      seen[JSON.stringify(r.stats) + r.species] = true;
    }
    entropyOff();
    return Object.keys(seen).length;
  }
  eq(spawnStats(false), 1, 'without entropy SPAWN RUNNER / !create rolls the same runner from the same state');
  ok(spawnStats(true) > 1, 'with entropy it does not');
}

// =============================================================================
section('F. Refused trainings draw no action RNG (gap1 RNG#3)');
// =============================================================================
{
  entropyOff();
  fresh({ seedSalt: 424242 });
  say('bob', '!join');
  say('bob', '!claim moss');
  const moss = SD.state.findRunner('moss').runner;
  ok(moss.ownerKey === 'bob', 'bob runs Moss Runner');
  moss.stats.luck = SD.runners.statCap(moss.level);
  moss.energy = 100;
  const snap = JSON.stringify(S());

  const ac0 = S().meta.actionCounter;
  let res;
  const changed = countEvents(SD.EVENTS.STATE_CHANGED, function () { res = say('bob', '!train luck'); });
  ok(!res.ok && /maxed/.test(res.message), 'training a maxed stat is refused', res.message);
  eq(S().meta.actionCounter, ac0, 'the refused train does not advance meta.actionCounter');
  eq(changed, 0, 'and emits no state:changed (nothing to save)');
  eq(res.cooldownMs, 0, 'no cooldown is stamped for it');

  const direct = SD.game.trainRunner(moss.id, 'luck', 'bob');
  ok(!direct.ok, 'SD.game.trainRunner refuses it too');
  eq(S().meta.actionCounter, ac0, 'without advancing the counter');

  moss.energy = SD.CONFIG.TRAINING.MIN_ENERGY - 1;
  const tired = SD.game.trainRunner(moss.id, 'speed', 'bob');
  ok(!tired.ok && /exhausted/.test(tired.message), 'a train below MIN_ENERGY is refused', tired.message);
  eq(S().meta.actionCounter, ac0, 'without advancing the counter');

  // The next real train is the same whether or not refused trains were spammed before it.
  function realTrain(burns) {
    resetRuntime();
    SD.state.set(JSON.parse(snap));
    for (let i = 0; i < burns; i++) say('bob', '!train luck');
    const r = say('bob', '!train speed');
    const m = SD.state.findRunner('moss').runner;
    return { ok: r.ok, counter: S().meta.actionCounter, speed: m.stats.speed, mood: m.mood, msg: r.message };
  }
  const plain = realTrain(0);
  ok(plain.ok, 'a real train goes ahead', plain.msg);
  let steered = 0;
  for (let n = 1; n <= 6; n++) if (JSON.stringify(realTrain(n)) !== JSON.stringify(plain)) steered++;
  eq(steered, 0, 'spamming refused trains first cannot change the next real training roll');
}

// =============================================================================
section('G. The debug seed override is never saved (test-to-live#5)');
// =============================================================================
{
  entropyOff();
  fresh({ seedSalt: 55 });
  SD.game.updateSettings({ debug: true, seedOverride: 999 });
  eq(S().settings.seedOverride, 999, 'the override is active in this session');
  ok(P.save() === true, 'save');
  const stored = JSON.parse(P.readRaw(P.KEY));
  eq(stored.settings.seedOverride, null, 'the save does not contain it');
  eq(stored.settings.debug, true, 'debug mode itself is still saved');
  eq(S().settings.seedOverride, 999, 'saving does not clear it from the running session');
  const reloaded = P.load();
  eq(reloaded.state.settings.seedOverride, null, 'a reload comes back with normal seeds');

  // A v1.0.0-era save that stored an override.
  const old = JSON.parse(JSON.stringify(S()));
  old.settings.seedOverride = 999;
  P._memoryStore.setItem(P.KEY, JSON.stringify(old));
  const l2 = P.load();
  eq(l2.state.settings.seedOverride, null, 'an override stored by an older build is cleared on load');
  ok(l2.state.log.some(function (e) { return /seed override \(999\) was cleared/.test(e.text); }), 'with a log line saying so');
  const imp = P.importJSON(JSON.stringify(old));
  ok(imp.ok && S().settings.seedOverride === null, 'and on import');
  SD.game.updateSettings({ debug: false });
}

// =============================================================================
section('H. hashRecord(storedRecord) === record.hash (determinism-contract#2)');
// =============================================================================
{
  entropyOff();
  fresh({ seedSalt: 777 });
  let withLevelUps = 0, match = 0, n = 0;
  for (let i = 0; i < 12; i++) {
    const r = runRace();
    if (r.error) break;
    const rec = S().raceHistory[S().raceHistory.length - 1];
    n++;
    if (rec.results.some(function (x) { return x.levelUps > 0; })) withLevelUps++;
    if (SD.race.hashRecord(rec) === rec.hash) match++;
  }
  ok(withLevelUps > 0, 'some races had level-ups written into results[].levelUps', withLevelUps);
  eq(match, n, 'every stored record re-hashes to its record.hash');
  const rec = S().raceHistory[S().raceHistory.length - 1];
  const copy = JSON.parse(JSON.stringify(rec));
  copy.results[0].levelUps = 3;
  eq(SD.race.hashRecord(copy), rec.hash, 'levelUps (applied after the race) is not part of the hash');
  copy.results[0].timeSec += 1;
  ok(SD.race.hashRecord(copy) !== rec.hash, 'a changed result still changes the hash');
  copy.results[0].timeSec -= 1;
  copy.ticks = [];
  eq(SD.race.hashRecord(copy), rec.hash, 'a record with its ticks stripped still hashes the same');
}

// =============================================================================
section('I. rollStats: the remainder goes to the most-favoured stat first (runners-data#7)');
// =============================================================================
{
  const STATS = SD.CONFIG.STATS;
  const bias = SD.DATA.SPECIES.foxSpirit.statBias;
  const total = SD.CONFIG.PROGRESSION.STAT_TOTAL;
  const cap = SD.runners.statCap(1);
  const got = [0, 0, 0, 0, 0];
  let sums = 0, firstMissed = 0, cases = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    const stats = SD.runners.rollStats(SD.rng.create(seed), bias, total);
    // Rebuild the weights and the floored values with the same draws.
    const g = SD.rng.create(seed);
    const w = STATS.map(function (k) { return (bias[k] || 1) * (0.75 + 0.5 * g.float()); });
    const sumW = w.reduce(function (a, b) { return a + b; }, 0);
    const base = w.map(function (x) { return Math.min(cap, 20 + Math.floor((total - 100) * x / sumW)); });
    const order = STATS.map(function (_, i) { return i; }).sort(function (a, b) { return w[b] - w[a]; });
    const vals = STATS.map(function (k) { return stats[k]; });
    if (vals.reduce(function (a, b) { return a + b; }, 0) === total) sums++;
    const rem = total - base.reduce(function (a, b) { return a + b; }, 0);
    order.forEach(function (idx, rank) { got[rank] += vals[idx] - base[idx]; });
    if (rem > 0) {
      cases++;
      if (vals[order[0]] - base[order[0]] !== 1 && base[order[0]] < cap) firstMissed++;
    }
  }
  eq(sums, 3000, 'stats always sum to STAT_TOTAL');
  ok(cases > 2000, 'most rolls have a remainder to hand out', cases);
  eq(firstMissed, 0, 'whenever there is a remainder, the most-favoured stat gets the first point');
  ok(got[0] >= got[1] && got[1] >= got[2] && got[2] >= got[3] && got[3] >= got[4], 'remainder points fall by weight rank', got);
}

// =============================================================================
section('J. The paddock lane order does not determine the race (gap1 RNG#1, fix round 1)');
// =============================================================================
{
  // The attack: the paddock shows the next field in lane order before bets close. For a big field that
  // pins down the field seed (log2(n!) bits of lane order alone), so a viewer can brute-force it over
  // the seed space (2^32 takes under a minute on a desktop; here a reduced space around the true seed)
  // and simulate the race. The attacker below is generous: besides the state, it gets the real gate
  // entrants, moods, track and chat effects, and only has to supply the seed.
  const SPAN = 4096;
  function attack(useEntropy, races) {
    entropyOff();
    fresh({ seedSalt: 8080 });
    joinViewers();
    SD.game.updateSettings({ runnerCount: 8 });
    if (useEntropy) entropyOn(2024);
    const out = { races: 0, found: 0, candidates: 0, orderHits: 0, hashHits: 0 };
    for (let i = 0; i < races; i++) {
      if (S().season.raceIndexInDay >= S().season.racesPerDay) SD.game.nextDay();
      const view = JSON.parse(JSON.stringify(S()));
      const shownField = SD.game.previewField();
      const shown = shownField.map(function (r) { return r.id; }).join(',');
      const trueFieldSeed = SD.game.seedForRace();
      const cands = [];
      for (let k = -SPAN; k < SPAN; k++) {
        const c = (trueFieldSeed + k) >>> 0;
        const g = SD.rng.create(SD.rng.seedFrom(c, 'field'));
        const lanes = g.shuffle(SD.race.selectField(view, shownField.length, g)).map(function (r) { return r.id; }).join(',');
        if (lanes === shown) cands.push(c);
      }
      const res = SD.game.startRace();
      if (!res.ok) { SD.game.resetDay(); continue; }
      const rec = res.record;
      const order = rec.results.map(function (r) { return r.runnerId; }).join(',');
      out.races++;
      out.candidates += cands.length;
      if (cands.indexOf(trueFieldSeed) >= 0) out.found++;
      let orderHit = false, hashHit = false;
      cands.forEach(function (c) {
        const sim = SD.race.simulate(Object.assign(SD.game.replayInputs(rec), { seed: c }));
        if (sim.results.map(function (r) { return r.runnerId; }).join(',') === order) orderHit = true;
        if (sim.hash === rec.hash) hashHit = true;
      });
      if (orderHit) out.orderHits++;
      if (hashHit) out.hashHits++;
      SD.game.endRace();
      tick(120000);
    }
    entropyOff();
    return out;
  }
  const ctl = attack(false, 6);
  eq(ctl.races, 6, 'control: 6 races run without entropy');
  eq(ctl.found, ctl.races, 'control: the brute force finds the field seed from the paddock lane order');
  eq(ctl.orderHits, ctl.races, 'control: without gate entropy that predicts the whole finish order before bets close');
  eq(ctl.hashHits, ctl.races, 'control: (the exact race, hash and all)');
  const atk = attack(true, 6);
  eq(atk.races, 6, '6 races run with an entropy source');
  eq(atk.found, atk.races, 'with entropy the brute force still finds the field seed (the preview is the real field)');
  ok(atk.candidates <= atk.races * 3, 'the lane order narrows the reduced space to a handful of candidates', atk.candidates);
  eq(atk.hashHits, 0, 'but no candidate reproduces the race: it runs on fresh gate entropy');
  eq(atk.orderHits, 0, 'and no candidate predicts the finish order');

  // The same state and the same paddock with different gate entropy give different races.
  entropyOff();
  fresh({ seedSalt: 9090 });
  joinViewers();
  SD.game.updateSettings({ runnerCount: 8 });
  const snap = JSON.stringify(S());
  const previews = {}, seeds = {}, orders = {}, tracks = {};
  for (let k = 1; k <= 8; k++) {
    resetRuntime();
    SD.state.set(JSON.parse(snap));
    entropyOn(k * 7919);
    previews[SD.game.previewField().map(function (r) { return r.id; }).join(',')] = true;
    const rec = SD.game.startRace().record;
    seeds[rec.seed] = true;
    orders[rec.results.map(function (r) { return r.runnerId; }).join(',')] = true;
    tracks[rec.trackName] = true;
    SD.game.endRace();
  }
  entropyOff();
  eq(Object.keys(previews).length, 1, 'one state shows one paddock');
  eq(Object.keys(seeds).length, 8, 'but every gate draws its own seed');
  ok(Object.keys(orders).length >= 6, 'and the finish order differs', Object.keys(orders).length);
  ok(Object.keys(tracks).length > 1, 'the track name is drawn at the gate too', Object.keys(tracks));

  // A fixed seed (debug override) is never mixed with entropy: fixed races stay reproducible.
  entropyOn(31);
  fresh({ seedSalt: 9090 });
  SD.game.updateSettings({ debug: true, seedOverride: 4321 });
  const f1 = SD.game.startRace().record;
  SD.game.endRace();
  entropyOn(32);
  fresh({ seedSalt: 9090 });
  SD.game.updateSettings({ debug: true, seedOverride: 4321 });
  const f2 = SD.game.startRace().record;
  SD.game.endRace();
  ok(f1.seed === 4321 && f2.seed === 4321 && f1.hash === f2.hash && f1.trackName === f2.trackName,
    'with the debug override the race is fixed whatever the entropy', [f1.seed, f2.seed, f1.hash, f2.hash]);
  SD.game.updateSettings({ debug: false, seedOverride: null });
  entropyOff();
}

// -----------------------------------------------------------------------------
if (HAS_ENTROPY) SD.entropy.reset();
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  console.log('\nFailures:');
  failures.forEach(function (f) { console.log('  - ' + f); });
}
process.exit(failed ? 1 : 0);
