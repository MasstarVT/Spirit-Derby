#!/usr/bin/env node
/*
 * Spirit Derby - tools/durability-test.js (review batch 6: persistence durability)
 *   A  slim history (perf-robustness#1): records past HISTORY_FULL_LOGS drop their ticks, keep a
 *      compacted chat-effect list, the biggest winning bets + betsSummary and capped cheer names; no
 *      history record keeps inputs.raceEffects; every slim record still replays to its hash, chat
 *      included; SD.race.compactChatEffects is exact; MIGRATIONS[4] slims a schema-3 save losslessly
 *   B  size budget and a per-origin quota (perf-robustness#1): a long chatty career under a Chrome-like
 *      shared quota never stops saving (the oldest records are dropped instead, logged, reported in
 *      state:saved.trimmed); a failed save emits state:saveFailed and stays dirty so flush() retries;
 *      a save the browser keeps refusing trims nothing in the live game (quota retries shrink a copy)
 *   C  save pacing (perf-robustness#5): read-only commands and idle clock ticks do not write the save
 *      (lazy / none), a race in progress defers autosaves to finishRace, real changes still save
 *   D  two windows on one storage (persistence#1): the second window opens read-only, does not cancel
 *      or refund the race it sees, never writes (clock ticks, commands, save, reset); it takes over
 *      when the first window closes or goes stale, or on TAKE OVER, and the first window then stops
 *   E  held saves and checked backups (persistence#3, lifecycle-concurrency#12, persistence#6): an
 *      unreadable / newer save is never overwritten; import / restore refuse without a checked backup,
 *      a blank game never replaces a backup, RESTORE BACKUP swaps, an import that cannot be saved
 *      keeps the current game
 *   F  retention (perf-robustness#4): drive-by viewers are pruned at a day change per CONFIG.RETENTION,
 *      everyone holding or having won something is kept; rankOf() matches the full ranking
 *
 * Each window is its own copy of the core in a node:vm context, all sharing one fake localStorage
 * with a per-origin quota (keys + values, like Chrome / OBS), so the real storage paths run.
 *   node tools/durability-test.js [--verbose]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
let passed = 0;
let failed = 0;
function section(t) { console.log('\n' + t); }
function ok(cond, name, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '')); }
  return !!cond;
}
function eq(a, b, name) { return ok(JSON.stringify(a) === JSON.stringify(b), name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function info(line) { if (VERBOSE) console.log('    ' + line); }

// -----------------------------------------------------------------------------
// Harness: shared clock, per-origin storage, one core per "window"
// -----------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const CORE_ORDER = [
  'js/namespace.js', 'js/config.js', 'js/rng.js', 'js/data.js', 'js/bus.js', 'js/state.js', 'js/persistence.js',
  'js/runners.js', 'js/training.js', 'js/events.js', 'js/race.js', 'js/hype.js', 'js/players.js', 'js/betting.js',
  'js/achievements.js', 'js/leaderboards.js', 'js/seasons.js', 'js/game.js', 'js/commands.js', 'js/debug.js'
];
const SOURCES = CORE_ORDER.map(function (f) { return [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]; });
const clock = { now: 1767225600000 };
const DAY = 86400000;

// A Chrome-like localStorage: one quota shared by every key (key + value lengths, UTF-16 units).
function makeStorage(quota) {
  const data = new Map();
  let used = 0;
  return {
    quota: quota == null ? Infinity : quota,
    writes: Object.create(null),
    refuse: null,                      // (key) -> true: throw QuotaExceededError for that write
    getItem: function (k) { return data.has(k) ? data.get(k) : null; },
    setItem: function (k, v) {
      v = String(v);
      const old = data.has(k) ? k.length + data.get(k).length : 0;
      const add = k.length + v.length;
      if ((this.refuse && this.refuse(k)) || used - old + add > this.quota) {
        const e = new Error('QuotaExceededError (fake, per origin)');
        e.name = 'QuotaExceededError';
        throw e;
      }
      used += add - old;
      data.set(k, v);
      this.writes[k] = (this.writes[k] || 0) + 1;
    },
    removeItem: function (k) { if (data.has(k)) { used -= k.length + data.get(k).length; data.delete(k); } },
    used: function () { return used; },
    count: function (k) { return this.writes[k] || 0; }
  };
}

// Manual timers on the shared clock (the browser debounce path).
function makeTimers() {
  const q = [];
  let id = 0;
  return {
    setTimeout: function (fn, ms) { q.push({ id: ++id, at: clock.now + (Number(ms) || 0), fn: fn }); return id; },
    clearTimeout: function (i) { const k = q.findIndex(function (t) { return t.id === i; }); if (k >= 0) q.splice(k, 1); },
    advance: function (ms) {
      const end = clock.now + ms;
      for (;;) {
        q.sort(function (a, b) { return a.at - b.at; });
        const t = q[0];
        if (!t || t.at > end) break;
        q.shift();
        clock.now = t.at;
        t.fn();
      }
      clock.now = end;
    },
    pending: function () { return q.length; }
  };
}

// A fresh copy of the core in its own global (a browser window). opts: { timers, id }
function makeCore(storage, opts) {
  opts = opts || {};
  // console.warn is quiet unless --verbose (failed saves are expected in B / C / E).
  const ctx = { console: { log: console.log, error: console.error, warn: VERBOSE ? console.warn : function () {} } };
  if (storage) ctx.localStorage = storage;
  if (opts.timers) { ctx.setTimeout = opts.timers.setTimeout; ctx.clearTimeout = opts.timers.clearTimeout; }
  vm.createContext(ctx);
  vm.runInContext('Math.random = function () { throw new Error("Math.random() is forbidden in the core"); };', ctx);
  SOURCES.forEach(function (s) { vm.runInContext(s[1], ctx, { filename: s[0] }); });
  const SD = ctx.SD;
  SD.clock.set(function () { return clock.now; });
  if (opts.id) SD.persistence._setInstanceId(opts.id);
  return SD;
}

// persistence.load() -> state.set -> game.init -> achievements.init, like main.js boot.
function boot(SD) {
  const res = SD.persistence.load();
  SD.state.set(res.state);
  SD.game.init();
  SD.achievements.init();
  return res;
}
function fresh(SD, seedSalt) {
  SD.state.set(SD.state.create({ seedSalt: seedSalt || 7, dayEventId: 'clearSkies' }));
  SD.game.init();
  SD.achievements.init();
  return SD.state.get();
}
function say(SD, user, text, opts) {
  clock.now += 11000;
  return SD.processCommand(user, text, Object.assign({ source: 'twitch' }, opts || {}));
}
function startRace(SD) {
  let s = SD.game.startRace();
  if (!s.ok && s.dayDone) { SD.game.nextDay(); s = SD.game.startRace(); }
  return s;
}
// One chatty race: every viewer joins (once), bets 10 and cheers; a few boost / sabotage.
function chattyRace(SD, viewers, opts) {
  opts = opts || {};
  const st = SD.state.get();
  if (st.season.raceIndexInDay >= st.season.racesPerDay) SD.game.nextDay();
  const fo = SD.betting.fieldOdds(SD.state.get());
  const ids = fo.entrants.map(function (e) { return e.runnerId; });
  viewers.forEach(function (v, i) {
    if (!SD.players.get(SD.state.get(), v)) SD.processCommand(v, '!join', { source: 'twitch' });
    const r = ids[i % ids.length];
    if (opts.bets !== false) SD.processCommand(v, '!bet ' + r + ' 10', { source: 'twitch' });
    SD.processCommand(v, '!cheer ' + r, { source: 'twitch' });
    if (opts.effects && i < 6) SD.processCommand(v, (i % 2 ? '!sabotage ' : '!boost ') + ids[(i + 1) % ids.length], { source: 'twitch' });
  });
  clock.now += 60000;
  const s = startRace(SD);
  if (!s.ok) return s;
  const done = SD.game.endRace();
  clock.now += 60000;
  return done;
}
function viewers(n, prefix) { const out = []; for (let i = 0; i < n; i++) out.push((prefix || 'viewer') + i); return out; }
function stored(storage, SD) { const raw = storage.getItem(SD.persistence.KEY); return raw ? JSON.parse(raw) : null; }

// =============================================================================
section('A. Slim history records (perf-robustness#1)');
// =============================================================================
(function () {
  const storage = makeStorage();
  const SD = makeCore(storage, { id: 'A' });
  SD.persistence.setAutoSave(false);
  fresh(SD, 101);
  const crowd = viewers(40, 'fan');
  const H = SD.CONFIG.HISTORY_FULL_LOGS;
  for (let i = 0; i < H + 4; i++) {
    const r = chattyRace(SD, crowd, { effects: true });
    if (!ok(r && r.ok, 'chatty race ' + (i + 1) + ' runs', r && r.message)) return;
  }
  const hist = SD.state.get().raceHistory;
  const old = hist.slice(0, hist.length - H), recent = hist.slice(hist.length - H);
  ok(old.length === 4 && old.every(function (r) { return r.slim === true && r.ticksStripped === true && r.ticks.length === 0; }), 'records past HISTORY_FULL_LOGS are slim');
  ok(recent.every(function (r) { return r.slim !== true && r.ticks.length > 0; }), 'the last HISTORY_FULL_LOGS records stay whole');
  ok(hist.every(function (r) { return !('raceEffects' in r.inputs); }), 'no history record keeps inputs.raceEffects (only an unfinished race needs it)');
  const s0 = old[0];
  ok(s0.bets.length <= SD.CONFIG.SAVE.BETS_KEPT && s0.bets.every(function (b) { return b.won; }), 'a slim record keeps at most BETS_KEPT winning bets', s0.bets.length);
  ok(s0.betsSummary && s0.betsSummary.count === crowd.length && s0.betsSummary.staked === crowd.length * 10, 'betsSummary counts every bet and the SP staked', s0.betsSummary);
  const cheerEv = s0.events.filter(function (e) { return e.data && e.data.type === 'cheer'; });
  ok(cheerEv.length > 0 && cheerEv.every(function (e) { return e.data.names.length <= SD.CONFIG.SAVE.NAMES_MAX; }), 'cheer events keep at most NAMES_MAX names');
  ok(cheerEv.some(function (e) { return e.data.namesMore > 0; }), 'and count the rest in namesMore');
  const cheersIn = s0.inputs.chatEffects.filter(function (c) { return c.type === 'cheer'; });
  eq(cheersIn.length, new Set(cheersIn.map(function (c) { return c.runnerId; })).size, 'one merged cheer entry per runner in the slim chat effects');
  // Every record, slim or whole, still replays to its stored hash (chat effects included).
  const replays = hist.map(function (rec) { return SD.race.simulate(SD.game.replayInputs(JSON.parse(JSON.stringify(rec)))).hash === rec.hash; });
  ok(replays.every(Boolean), 'every history record (slim ones too) replays to its hash', replays);
  ok(SD.game.replayLastRace().sameHash, 'REPLAY LAST RACE still matches');
  // The per-viewer parts (bets, chat effects, cheer names) no longer grow with the crowd.
  const chatPart = function (r) {
    return JSON.stringify(r.bets).length + JSON.stringify(r.inputs).length + JSON.stringify(r.betsSummary || null).length +
      JSON.stringify(r.events.filter(function (e) { return e.data && e.data.type === 'cheer'; })).length;
  };
  info('per-viewer parts: slim ' + chatPart(old[0]) + ' chars, whole ' + chatPart(recent[0]) + ' chars; slim record ' + JSON.stringify(old[0]).length + ' chars (40 viewers)');
  ok(chatPart(old[0]) < 3000 && chatPart(recent[0]) > 8000, 'a slim record\'s per-viewer data stays small (40 viewers: ' + chatPart(old[0]) + ' vs ' + chatPart(recent[0]) + ' chars)');

  // compactChatEffects is exact: random chat lists simulate to the same hash compacted.
  const rec = recent[recent.length - 1];
  const ids = rec.entrants.map(function (e) { return e.runnerId; });
  const rng = SD.rng.create(4242);
  let same = 0;
  for (let t = 0; t < 30; t++) {
    const list = [];
    const n = 5 + rng.int(40);
    for (let k = 0; k < n; k++) {
      const type = ['cheer', 'cheer', 'boost', 'sabotage'][rng.int(4)];
      const runnerId = k % 7 === 6 ? 'r99' : ids[rng.int(ids.length)];
      list.push(type === 'cheer' ? { runnerId: runnerId, type: type, by: 'v' + rng.int(9), count: 1 + rng.int(3) } : { runnerId: runnerId, type: type, by: 'v' + rng.int(9), byKey: 'v' + rng.int(9) });
    }
    const base = SD.game.replayInputs(rec);
    const a = SD.race.simulate(Object.assign({}, base, { chatEffects: list })).hash;
    const b = SD.race.simulate(Object.assign({}, base, { chatEffects: SD.race.compactChatEffects(list, ids) })).hash;
    if (a === b) same++;
  }
  eq(same, 30, 'compactChatEffects(list) simulates exactly like list (30 random chat lists)');

  // MIGRATIONS[4]: a schema-3 save (whole records with raceEffects copies) is slimmed on load, losslessly.
  const v3 = JSON.parse(JSON.stringify(SD.state.get()));
  v3.schemaVersion = 3;
  v3.raceHistory.forEach(function (r, i) {
    r.inputs.raceEffects = [{ type: 'cheer', runnerId: r.entrants[0].runnerId, by: 'fan1', count: 1 }];
    if (i < 4) { delete r.slim; delete r.betsSummary; }
  });
  v3.raceHistory[0].bets = hist[hist.length - 1].bets.slice();
  storage.setItem(SD.persistence.KEY, JSON.stringify(v3));
  const res = SD.persistence.load();
  ok(res.fromStorage && res.migratedFrom === 3 && res.state.schemaVersion === 4, 'a schema-3 save migrates to schema 4');
  ok(res.state.raceHistory.every(function (r) { return !('raceEffects' in r.inputs); }) && res.state.raceHistory[0].slim === true && res.state.raceHistory[0].betsSummary,
    'MIGRATIONS[4] slims its old records and drops the raceEffects copies');
  ok(res.state.log.some(function (e) { return /schema v4/.test(e.text); }), 'the upgrade is logged');
  eq(Object.keys(res.state.players).map(function (k) { return res.state.players[k].spiritPoints; }),
    Object.keys(v3.players).map(function (k) { return v3.players[k].spiritPoints; }), 'players and balances are untouched by the upgrade');
  eq(res.state.raceHistory.map(function (r) { return r.hash; }), v3.raceHistory.map(function (r) { return r.hash; }), 'every record (and its hash) is kept');
  eq(storage.getItem(SD.persistence.BACKUP_KEY), JSON.stringify(v3), 'the schema-3 save was backed up first (and checked)');
})();

// =============================================================================
section('B. Size budget under a per-origin quota (perf-robustness#1)');
// =============================================================================
(function () {
  // A small quota and budget so the test is quick: the shape of the problem is the same as 200
  // races x 100 viewers against Chrome's 5,242,880-unit quota.
  const storage = makeStorage(800000);
  const SD = makeCore(storage, { id: 'B' });
  SD.CONFIG.SAVE.BUDGET_CHARS = 350000;
  SD.CONFIG.SAVE.MIN_HISTORY = 5;
  fresh(SD, 202);
  const trims = [], fails = [];
  SD.bus.on(SD.EVENTS.STATE_SAVED, function (p) { if (p.trimmed && p.trimmed.races) trims.push(p.trimmed.races); });
  SD.bus.on(SD.EVENTS.STATE_SAVE_FAILED, function (p) { fails.push(p.error); });
  const crowd = viewers(25, 'raider');
  let lagging = 0, maxUsed = 0;
  for (let i = 0; i < 40; i++) {
    const r = chattyRace(SD, crowd, { effects: i % 3 === 0 });
    if (!r || !r.ok) { ok(false, 'race ' + (i + 1), r && r.message); return; }
    const s = stored(storage, SD);
    if (!s || s.meta.raceCounter !== SD.state.get().meta.raceCounter) lagging++;
    maxUsed = Math.max(maxUsed, storage.used());
  }
  const st = SD.state.get();
  info('history kept ' + st.raceHistory.length + ', trims ' + trims.join(',') + ', max storage used ' + maxUsed + ', save ' + SD.persistence.stats().bytes);
  eq(fails, [], 'no save ever failed');
  eq(lagging, 0, 'the stored save always matches the live game (no silent rollback on reload)');
  ok(SD.persistence.stats().bytes <= SD.CONFIG.SAVE.BUDGET_CHARS, 'the save stays under CONFIG.SAVE.BUDGET_CHARS', SD.persistence.stats().bytes);
  ok(st.raceHistory.length < 40 && st.raceHistory.length >= SD.CONFIG.SAVE.MIN_HISTORY, 'the oldest race records were dropped to fit (kept ' + st.raceHistory.length + ')');
  ok(trims.length > 0, 'state:saved reports what was trimmed');
  ok(st.log.some(function (e) { return /too big for browser storage/.test(e.text); }), 'and the game log says so');
  eq(Object.keys(st.players).length, crowd.length, 'players are never trimmed');
  ok(SD.game.replayLastRace().sameHash, 'the last race still replays');

  // A quota the save cannot fit at all: save() fails loudly, stays dirty, and flush() retries later.
  storage.refuse = function (k) { return k === SD.persistence.KEY; };
  const before = stored(storage, SD).meta.raceCounter;
  SD.persistence.setAutoSave(false);
  say(SD, 'raider1', '!train speed');
  const r1 = SD.persistence.save();
  ok(r1 === false && fails.length === 1 && /Quota/.test(fails[0]), 'a refused save returns false and emits state:saveFailed { error }', fails);
  ok(SD.persistence.stats().dirty && SD.persistence.stats().error, 'the game stays dirty with the error in stats()');
  storage.refuse = null;
  ok(SD.persistence.flush() === true && stored(storage, SD).meta.updatedAt === SD.state.get().meta.updatedAt, 'flush() retries once storage accepts it again (persistence#6)');
  ok(stored(storage, SD).meta.raceCounter >= before && !SD.persistence.stats().error, 'and the error clears');
  SD.persistence.setAutoSave(true);
})();

// A long, quiet career past the budget (fix round): the budget trim slims the recent tick logs once and
// they stay slim, so the save then grows by one slim record per race and trims are rare (every ~7 races
// at this small budget, about every 20 at the real one). Before, the last HISTORY_FULL_LOGS records grew
// back to full size and the 10 % headroom was gone within 1-3 races.
(function () {
  const storage = makeStorage();
  const SD = makeCore(storage, { id: 'B2' });
  SD.CONFIG.SAVE.BUDGET_CHARS = 500000;
  SD.CONFIG.SAVE.MIN_HISTORY = 5;
  SD.CONFIG.SAVE.ROUTINE_HISTORY = 20;
  fresh(SD, 212);
  const trimAt = [], routine = [];
  let overBudget = 0, lagging = 0, fullAfter = 0;
  SD.bus.on(SD.EVENTS.STATE_SAVED, function (p) {
    if (p.bytes > SD.CONFIG.SAVE.BUDGET_CHARS) overBudget++;
    if (p.trimmed && p.trimmed.races) { trimAt.push(SD.state.get().meta.raceCounter); routine.push(p.trimmed.routine); }
  });
  for (let i = 0; i < 120; i++) {
    clock.now += 120000;
    if (!startRace(SD).ok) { ok(false, 'quiet race ' + (i + 1)); return; }
    SD.game.endRace();
    const s = stored(storage, SD);
    if (!s || s.meta.raceCounter !== SD.state.get().meta.raceCounter) lagging++;
    if (trimAt.length) {
      const h = SD.state.get().raceHistory;
      fullAfter = Math.max(fullAfter, h.filter(function (r) { return r.slim !== true; }).length);
    }
  }
  const gaps = trimAt.slice(1).map(function (t, i) { return t - trimAt[i]; });
  info('quiet career: trims at races ' + trimAt.join(',') + ' (history ' + SD.state.get().raceHistory.length + ')');
  ok(trimAt.length >= 3, 'the career outgrew the budget and was trimmed', trimAt);
  ok(gaps.every(function (g) { return g >= 5; }), 'trims are infrequent: at least 5 races apart at this budget', gaps);
  ok(trimAt.length <= 16, 'at most 16 trims in 120 races', trimAt.length);
  ok(fullAfter <= 2, 'after a budget trim only the last 2 records keep their tick logs (they do not grow back)', fullAfter);
  eq([overBudget, lagging], [0, 0], 'every save fits the budget and matches the live game');
  const trimLines = SD.state.get().log.filter(function (e) { return /too big for browser storage/.test(e.text); });
  ok(routine.every(Boolean) && trimLines.length > 0 && trimLines.every(function (e) { return e.severity === 'info'; }),
    'these trims are routine: info log lines, trimmed.routine (no toast)');
  ok(SD.game.replayLastRace().sameHash, 'the last race still replays');
})();

// A save the browser keeps refusing (fix round 2): the quota retries shrink a working copy, never the
// live game. Before, each of the 3 retries (and each RETRY_MS retry after them) trimmed the live history
// and log a little deeper; 30 s of refused writes cut a 15-record game to 1 record, EXPORT JSON then had
// only that one, and the first save that worked again wrote it over the stored 15.
(function () {
  const timers = makeTimers();
  const storage = makeStorage();
  const SD = makeCore(storage, { id: 'B3', timers: timers });
  fresh(SD, 222);
  const crowd = viewers(6, 'regular');
  for (let i = 0; i < 15; i++) {
    const r = chattyRace(SD, crowd);
    if (!ok(r && r.ok, 'setup race ' + (i + 1), r && r.message)) return;
  }
  timers.advance(SD.CONFIG.SAVE.LAZY_MS + 1000);
  const K = SD.persistence.KEY;
  const st = SD.state.get();
  const hashes = st.raceHistory.map(function (r) { return r.hash; });
  eq(stored(storage, SD).raceHistory.length, 15, 'setup: 15 race records stored');
  const logBefore = JSON.stringify(st.log), logLen = st.log.length, logEntries = [];
  SD.bus.on(SD.EVENTS.LOG_ENTRY, function (e) { logEntries.push(e.text); });
  const fails = [];
  SD.bus.on(SD.EVENTS.STATE_SAVE_FAILED, function (p) { fails.push(p.error); });

  // Two retry cycles of refused writes (QuotaExceededError on every spiritderby.save write).
  let tries = 0;
  storage.refuse = function (k) { if (k === K) { tries++; return true; } return false; };
  SD.processCommand('newcomer', '!join', { source: 'twitch' });
  timers.advance(SD.CONFIG.SAVE_DEBOUNCE_MS + 10);
  timers.advance(SD.CONFIG.SAVE.RETRY_MS + 10);
  timers.advance(SD.CONFIG.SAVE.RETRY_MS + 10);
  info('refused saves: ' + fails.length + ', setItem tries: ' + tries);
  ok(fails.length >= 3 && tries >= 3 * 4, 'the save failed 3 times (each with its 3 smaller quota retries)', [fails.length, tries]);
  eq(st.raceHistory.map(function (r) { return r.hash; }), hashes, 'the live game still has all 15 race records');
  ok(st.raceHistory.slice(-SD.CONFIG.HISTORY_FULL_LOGS).every(function (r) { return r.ticks.length > 0; }), 'and their tick logs');
  eq(JSON.stringify(st.log.slice(0, logLen)), logBefore, 'the live log lost nothing (every earlier line is still there)');
  ok(!st.log.some(function (e) { return /too big for browser storage/.test(e.text); }) && !logEntries.some(function (t) { return /too big/.test(t); }),
    'no "too big" line in the live log or on log:entry for trims that were never saved');
  eq(JSON.parse(SD.persistence.exportJSON()).raceHistory.length, 15, 'EXPORT JSON (what the toast suggests) still has all 15 records');
  ok(SD.persistence.stats().dirty && SD.persistence.stats().error, 'the game stays dirty with the error in stats()');

  // Storage accepts writes again: the automatic retry writes the whole game.
  storage.refuse = null;
  timers.advance(SD.CONFIG.SAVE.RETRY_MS + 10);
  const s = stored(storage, SD);
  ok(!SD.persistence.stats().error && s && s.players.newcomer, 'the automatic retry saves once storage accepts writes again');
  eq(s.raceHistory.map(function (r) { return r.hash; }), hashes, 'the stored save keeps all 15 pre-failure race records');
  eq(s.log.length, st.log.length, 'and the whole log');

  // A write refused for another reason (SecurityError, a broken backend) is not retried smaller.
  tries = 0;
  storage.refuse = null;
  const realSet = storage.setItem;
  storage.setItem = function (k, v) {
    if (k === K) { tries++; const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; e.code = 18; throw e; }
    return realSet.call(this, k, v);
  };
  SD.persistence.setAutoSave(false);
  SD.processCommand('newcomer2', '!join', { source: 'twitch' });
  ok(SD.persistence.save() === false && tries === 1, 'a SecurityError fails at once, without the quota retries', tries);
  eq(st.raceHistory.length, 15, 'and trims nothing');
  storage.setItem = realSet;

  // A real quota the whole game does not fit: the retry that fits is written, and only then does the
  // live game take the trimmed history, so the stored save and the live game match.
  // First a budget trim (just under the whole game) slims every record but the last 2, so the quota
  // retry below has to drop records. Then room for that game minus about 3.5 records.
  const budgetWas = SD.CONFIG.SAVE.BUDGET_CHARS;
  SD.CONFIG.SAVE.BUDGET_CHARS = JSON.stringify(st).length - 1;
  ok(SD.persistence.save() && st.raceHistory.length === 15 && st.raceHistory.slice(0, 13).every(function (r) { return r.slim === true; }),
    'a budget trim that only slims keeps all 15 records (slimmed in the live game once written)');
  SD.CONFIG.SAVE.BUDGET_CHARS = budgetWas;
  const slimSize = storage.getItem(K).length;
  const recSize = JSON.stringify(st.raceHistory[0]).length;
  storage.quota = storage.used() - slimSize + slimSize - Math.floor(3.5 * recSize);
  logEntries.length = 0;
  let lastTrim = null;
  SD.bus.on(SD.EVENTS.STATE_SAVED, function (p) { lastTrim = p.trimmed; });
  const logBeforeQuota = st.log.length;
  ok(SD.persistence.save() === true, 'a save over quota succeeds with a smaller retry', SD.persistence.lastError() && SD.persistence.lastError().message);
  const s2 = stored(storage, SD);
  const t = lastTrim;
  info('quota retry trimmed ' + JSON.stringify(t) + '; live history ' + st.raceHistory.length + ', log ' + st.log.length + ' lines (was ' + logBeforeQuota + ')');
  ok(t && (t.races || t.log) && st.raceHistory.length === 15 - t.races && st.log.length < logBeforeQuota,
    'the live game took exactly the saved trim (below MIN_HISTORY records the log is cut first)', t);
  eq(JSON.stringify(s2.raceHistory), JSON.stringify(st.raceHistory), 'the stored history equals the live one');
  eq(JSON.stringify(s2.log), JSON.stringify(st.log), 'the stored log equals the live one');
  ok(/too big for browser storage/.test(st.log[st.log.length - 1].text) && logEntries.some(function (t) { return /too big/.test(t); }),
    'the trim is logged in the live game and on log:entry once it is saved');
  ok(!('__newLogs' in s2), 'no bookkeeping leaks into the save');
  ok(SD.game.replayLastRace().sameHash, 'the last race still replays');
  storage.quota = Infinity;
  SD.persistence.setAutoSave(true);
})();

// =============================================================================
section('C. Save pacing: read-only chat, idle clock, races (perf-robustness#5)');
// =============================================================================
(function () {
  // Node path (no timers): a normal mutation saves at once, a lazy one only marks the game dirty.
  const storage = makeStorage();
  const SD = makeCore(storage, { id: 'C' });
  fresh(SD, 303);
  say(SD, 'owl', '!join');
  say(SD, 'owl', '!claim moss');
  const w0 = storage.count(SD.persistence.KEY);
  let changed = 0;
  SD.bus.on(SD.EVENTS.STATE_CHANGED, function () { changed++; });
  ['!status', '!odds', '!lb', '!help', '!rank', '!hype', '!bets', '!achievements', '!inspect moss'].forEach(function (c) { say(SD, 'owl', c); });
  eq(storage.count(SD.persistence.KEY), w0, 'read-only commands from a player write nothing at once');
  ok(SD.persistence.stats().dirty, 'but the game is dirty (lastSeen / command count are saved lazily)');
  const c0 = changed;
  say(SD, 'stranger', '!status');
  say(SD, 'stranger', '!lb');
  eq(changed, c0, 'a read-only command from a non-player changes nothing: no state:changed');
  say(SD, 'owl', '!train speed');
  eq(storage.count(SD.persistence.KEY), w0 + 1, 'a real change (training) saves at once');
  // Idle clock: nothing changes once runners are rested and hype is 0.
  const st = SD.state.get();
  st.runners.forEach(function (r) { r.energy = r.maxEnergy; r.fatigue = 0; r.lastActionAt = clock.now; });
  st.hype.value = 0;
  SD.persistence.save();
  const w1 = storage.count(SD.persistence.KEY), c1 = changed;
  clock.now += 30000;
  SD.game.tickClock();
  eq([storage.count(SD.persistence.KEY), changed], [w1, c1], 'a clock tick that changed nothing writes nothing and emits no state:changed');
  st.runners[0].energy = 10;
  clock.now += 30000;
  const t = SD.game.tickClock();
  ok(t.changed.length === 1 && storage.count(SD.persistence.KEY) === w1 && changed === c1 + 1, 'energy regen is a lazy change (state:changed, save deferred)');

  // Browser path (timers): 20 read-only commands / s during a running race.
  const timers = makeTimers();
  const storage2 = makeStorage();
  const SD2 = makeCore(storage2, { id: 'C2', timers: timers });
  fresh(SD2, 304);
  ['owl', 'fox', 'moth'].forEach(function (u) { SD2.processCommand(u, '!join', { source: 'twitch' }); });
  SD2.processCommand('owl', '!claim moss', { source: 'twitch' });
  SD2.processCommand('fox', '!claim ember', { source: 'twitch' });
  timers.advance(1000);
  const k = SD2.persistence.KEY;
  const base = storage2.count(k);
  ok(base >= 1, 'joins were autosaved after the debounce');
  const s = SD2.game.startRace();
  timers.advance(1000);
  const atStart = storage2.count(k);
  ok(s.ok && atStart === base, 'a race start is not saved at once either (a race cut short is cancelled on load anyway)');
  SD2.game.setRaceStatus('running');
  const cmds = ['!status', '!odds', '!lb', '!help', '!cheer'];
  for (let i = 0; i < 100; i++) {
    SD2.processCommand(['owl', 'fox', 'moth'][i % 3], cmds[i % cmds.length], { source: 'twitch' });
    timers.advance(50);
  }
  const during = storage2.count(k) - atStart;
  info('saves during 5 s of 20 commands/s in a running race: ' + during + ' (before review batch 6: 10)');
  eq(during, 0, 'no save during 5 s of 20 commands / s in a running race (cheers wait for the finish)');
  SD2.game.endRace();
  const afterFinish = storage2.count(k);
  ok(afterFinish === atStart + 1 && stored(storage2, SD2).raceHistory.length === 1, 'finishRace saves at once');
  ok(stored(storage2, SD2).players.moth.stats.cheers > 0, 'the mid-race cheers are in that save');
  for (let i = 0; i < 100; i++) { SD2.processCommand('owl', '!status', { source: 'twitch' }); timers.advance(50); }
  eq(storage2.count(k), afterFinish, 'idle-time !status spam does not save within 5 s');
  timers.advance(SD2.CONFIG.SAVE.LAZY_MS);
  eq(storage2.count(k), afterFinish + 1, 'it is saved once, CONFIG.SAVE.LAZY_MS later');
  SD2.processCommand('owl', '!train speed', { source: 'twitch' });
  timers.advance(SD2.CONFIG.SAVE_DEBOUNCE_MS + 10);
  eq(storage2.count(k), afterFinish + 2, 'a real change still saves within SAVE_DEBOUNCE_MS');
  // A failed save backs autosave off (no stringify every 500 ms while the quota is full).
  storage2.refuse = function (key) { return key === k; };
  const fails = [];
  SD2.bus.on(SD2.EVENTS.STATE_SAVE_FAILED, function () { fails.push(clock.now); });
  for (let i = 0; i < 40; i++) { SD2.processCommand('fox', '!rest', { source: 'twitch' }); SD2.game.addHype(1); timers.advance(500); clock.now += 11000; }
  storage2.refuse = null;
  info('failed saves while the quota was full: ' + fails.length);
  ok(fails.length >= 1 && fails.length <= Math.ceil(40 * 11.5 / (SD2.CONFIG.SAVE.RETRY_MS / 1000)) + 1, 'failed saves back off by CONFIG.SAVE.RETRY_MS', fails.length);
  timers.advance(SD2.CONFIG.SAVE.RETRY_MS + 1000);
  ok(!SD2.persistence.stats().error && stored(storage2, SD2).meta.updatedAt === SD2.state.get().meta.updatedAt, 'the retry saves once storage accepts it again');
})();

// =============================================================================
section('D. Two windows on one storage (persistence#1)');
// =============================================================================
(function () {
  const storage = makeStorage();
  const A = makeCore(storage, { id: 'tabA' });
  boot(A);
  ['FoxFan', 'MothMom'].forEach(function (u) { say(A, u, '!join'); });
  const target = A.betting.fieldOdds(A.state.get()).entrants[0].runnerId;
  ok(say(A, 'FoxFan', '!bet ' + target + ' 100').ok, 'tab A: FoxFan bets 100 SP');
  ok(A.game.startRace().ok && A.persistence.save(), 'tab A: a race is running, saved');
  const spAfterBet = A.state.get().players.foxfan.spiritPoints;
  eq(A.persistence.role(), 'writer', 'tab A is the writer');

  // Tab B opens while A is live (e.g. a second copy "just to look", or index.html double-clicked twice).
  clock.now += 5000;
  const B = makeCore(storage, { id: 'tabB' });
  const readOnlyEvents = [];
  B.bus.on(B.EVENTS.STATE_READ_ONLY, function (p) { readOnlyEvents.push(p); });
  const w0 = storage.count(A.persistence.KEY);
  const rb = boot(B);
  ok(rb.readOnly === true && B.persistence.role() === 'reader', 'tab B opens read-only (a live lock from tab A)');
  const bs = B.state.get();
  ok(bs.currentRace && bs.currentRace.status === 'countdown' && bs.bets.length === 1 && bs.players.foxfan.spiritPoints === spAfterBet,
    'tab B does not cancel or refund the race it sees');
  ok(!bs.log.some(function (e) { return /interrupted/.test(e.text); }), 'no "race interrupted" line in tab B');
  // Tab A plays on.
  A.game.endRace();
  for (let i = 0; i < 2; i++) { clock.now += 30000; A.game.startRace(); A.game.endRace(); }
  eq(stored(storage, A).meta.raceCounter, 3, 'tab A: 3 races, saved');
  // Tab B idles: clock ticks (energy regen), a command, SAVE NOW, RESET ALL: nothing reaches storage.
  const wB = storage.count(A.persistence.KEY);
  for (let i = 0; i < 4; i++) { clock.now += 30000; B.game.tickClock(); A.persistence.heartbeat(); }
  say(B, 'MothMom', '!train speed');
  ok(B.persistence.save() === false && B.persistence.flush() === false, 'tab B: save() / flush() refuse');
  eq(B.persistence.clear(), false, 'tab B: clear() (RESET ALL) refuses');
  B.game.resetAll();
  eq(storage.count(A.persistence.KEY), wB, 'tab B never writes spiritderby.save');
  eq(stored(storage, A).meta.raceCounter, 3, "tab A's game is intact");
  ok(B.persistence.importJSON(A.persistence.exportJSON()).readOnly === true, 'tab B: IMPORT is refused');
  ok(!B.persistence.heartbeat().free, 'tab B: tab A is still live');
  info('writes by tab A boot->3 races: ' + (wB - w0));

  // Tab A reloads (F5, OBS refreshing the source: pagehide = flush + release, then a new page loads).
  // The released lock is not free for tab B during CONFIG.LOCK.RELEASE_GRACE_MS, so the reloaded tab A
  // claims it back and stays the saving window (fix round: B used to take over within milliseconds and
  // the reloaded window came back read-only and off chat).
  A.persistence.flush();
  ok(A.persistence.release(), 'tab A releases the lock on pagehide');
  const hb0 = B.persistence.heartbeat();
  ok(hb0.role === 'reader' && !hb0.free && hb0.freeIn > 0 && hb0.freeIn <= B.CONFIG.LOCK.RELEASE_GRACE_MS,
    'right after the release tab B does not take over yet (freeIn: the grace period)', hb0);
  clock.now += 1500;
  const A2 = makeCore(storage, { id: 'tabA-reloaded' });
  const ra2 = boot(A2);
  ok(!ra2.readOnly && A2.persistence.role() === 'writer' && A2.state.get().meta.raceCounter === 3, 'the reloaded tab A loads as the saving window, with its game');
  clock.now += B.CONFIG.LOCK.RELEASE_GRACE_MS + 1000;
  const hb1 = B.persistence.heartbeat();
  ok(hb1.role === 'reader' && !hb1.free && B.persistence.role() === 'reader', 'tab B stays read-only after the grace period (the reloaded tab holds the lock)');
  say(A2, 'MothMom', '!train stamina');
  ok(A2.persistence.role() === 'writer' && stored(storage, A2).meta.updatedAt === A2.state.get().meta.updatedAt, 'the reloaded tab A keeps saving');
  const trainsBefore = stored(storage, A2).players.mothmom.stats.trains;

  // Tab A closes for good: once the grace period has passed tab B takes over with the latest save.
  A2.persistence.flush();
  ok(A2.persistence.release(), 'tab A (reloaded) releases the lock when it closes');
  ok(!B.persistence.heartbeat().free, 'tab B waits for the grace period');
  clock.now += B.CONFIG.LOCK.RELEASE_GRACE_MS + 1;
  const hb = B.persistence.heartbeat();
  ok(hb.role === 'reader' && hb.free, 'tab B sees the other window is gone');
  const tk = B.persistence.takeOver();
  eq(tk.state && tk.state.players.mothmom.stats.trains, trainsBefore, "tab B's game includes the reloaded tab's last change");
  ok(tk.ok && B.persistence.role() === 'writer' && tk.state.meta.raceCounter === 3 && tk.state.currentRace === null, 'tab B takes over with tab A\'s latest game');
  ok(readOnlyEvents.length >= 1 && readOnlyEvents[readOnlyEvents.length - 1].readOnly === false, 'state:readOnly tells the UI');

  // A crashed window (no release) goes stale after CONFIG.LOCK.STALE_MS.
  B.state.set(tk.state); B.game.init();
  clock.now += 1000;
  const C = makeCore(storage, { id: 'tabC' });
  ok(boot(C).readOnly, 'tab C opens read-only while tab B is live');
  clock.now += C.CONFIG.LOCK.STALE_MS + 1000;           // tab B "crashed": no heartbeat
  ok(C.persistence.heartbeat().free, 'after CONFIG.LOCK.STALE_MS the stale lock counts as free');
  ok(C.persistence.takeOver().ok && C.persistence.role() === 'writer', 'tab C takes over');
  // The frozen tab B wakes up: its next save sees tab C's lock and stops instead of overwriting.
  const demoted = [];
  B.bus.on(B.EVENTS.STATE_READ_ONLY, function (p) { demoted.push(p); });
  const cRaces = stored(storage, C).meta.raceCounter;
  B.game.addHype(5);
  ok(B.persistence.role() === 'reader' && demoted.length === 1 && demoted[0].reason === 'other-window', 'the old writer steps down (state:readOnly, reason other-window)');
  eq(stored(storage, C).meta.raceCounter, cRaces, 'and did not overwrite the newer game');
  // TAKE OVER while the other window is live (the streamer knows it is gone).
  const D = makeCore(storage, { id: 'tabD' });
  ok(boot(D).readOnly && !D.persistence.heartbeat().free, 'tab D opens read-only, tab C is live');
  ok(D.persistence.takeOver().ok, 'TAKE OVER anyway');
  C.persistence.heartbeat();
  eq(C.persistence.role(), 'reader', "tab C's next heartbeat steps it down");
})();

// =============================================================================
section('E. Held saves and checked backups (persistence#3, lifecycle-concurrency#12, persistence#6)');
// =============================================================================
(function () {
  // A save from a newer build: kept untouched, nothing written, rescued before a new game replaces it.
  const storage = makeStorage();
  const SD = makeCore(storage, { id: 'E' });
  const newer = JSON.stringify({ schemaVersion: 99, runners: [], meta: { raceCounter: 180 }, marker: 'REAL_GAME' });
  storage.setItem(SD.persistence.KEY, newer);
  const r = boot(SD);
  ok(!r.fromStorage && r.held && /newer version/.test(r.error), 'load() reports the newer save as held { held, error }');
  ok(SD.persistence.lockStatus().role === 'held' && SD.persistence.lockStatus().readOnly, 'role "held": this window does not save');
  say(SD, 'bob', '!join');
  clock.now += 30000; SD.game.tickClock();
  SD.persistence.save(); SD.persistence.flush();
  SD.game.resetAll();
  eq(storage.getItem(SD.persistence.KEY), newer, 'commands, clock ticks, SAVE NOW and RESET ALL leave the newer save untouched');
  eq(SD.persistence.heldText(), newer, 'heldText() gives the banner its DOWNLOAD');
  // No room to rescue it: START NEW GAME refuses unless forced.
  storage.refuse = function (k) { return k === SD.persistence.RESCUE_KEY; };
  const rel = SD.persistence.releaseHeld();
  ok(!rel.ok && rel.rescueFailed, 'START NEW GAME refuses when the rescue copy cannot be written');
  storage.refuse = null;
  const rel2 = SD.persistence.releaseHeld();
  ok(rel2.ok && rel2.rescued && rel2.saved && storage.getItem(SD.persistence.RESCUE_KEY) === newer, 'with room: rescued to spiritderby.rescue, then the new game saves');
  ok(JSON.parse(storage.getItem(SD.persistence.KEY)).schemaVersion === 4, 'spiritderby.save now holds the new game');

  // An IMPORT while a save is held rescues it too (it used to overwrite the only copy's backup slot).
  const storage2 = makeStorage();
  const S2 = makeCore(storage2, { id: 'E2' });
  storage2.setItem(S2.persistence.KEY, '{ broken');
  ok(boot(S2).held, 'an unreadable save is held');
  const other = makeCore(makeStorage(), { id: 'E2x' });
  fresh(other, 55);
  say(other, 'fox', '!join');
  const imp = S2.persistence.importJSON(other.persistence.exportJSON());
  ok(imp.ok && storage2.getItem(S2.persistence.RESCUE_KEY) === '{ broken' && S2.persistence.role() === 'writer', 'IMPORT rescues the held save, then imports');

  // A big game, a quota with no room for a second copy: IMPORT refuses instead of losing it.
  const storage3 = makeStorage(260000);
  const S3 = makeCore(storage3, { id: 'E3' });
  fresh(S3, 66);
  const crowd = viewers(12, 'reg');
  for (let i = 0; i < 12; i++) chattyRace(S3, crowd);
  const bigSave = storage3.getItem(S3.persistence.KEY);
  info('big save ' + bigSave.length + ' chars, quota ' + storage3.quota);
  ok(bigSave.length > storage3.quota / 2, 'the stored game is more than half the quota');
  const small = makeCore(makeStorage(), { id: 'E3x' });
  fresh(small, 67);
  const smallText = small.persistence.exportJSON();
  const r3 = S3.persistence.importJSON(smallText);
  ok(!r3.ok && r3.backupFailed, 'IMPORT without room for a checked backup is refused { backupFailed }', r3);
  eq(storage3.getItem(S3.persistence.KEY), bigSave, 'and the current game is still stored');
  eq(S3.state.get().meta.raceCounter, 12, 'and still running');
  const r4 = S3.persistence.importJSON(smallText, { force: true });
  ok(r4.ok && S3.state.get().meta.raceCounter === 0, 'with force (the drawer downloaded the current game first) it imports');

  // A blank game never replaces a backup; RESTORE BACKUP swaps back.
  const storage5 = makeStorage();
  const S5 = makeCore(storage5, { id: 'E5' });
  fresh(S5, 77);
  say(S5, 'fox', '!join');
  S5.game.startRace(); S5.game.endRace();
  const played = S5.persistence.exportJSON();
  const blank = makeCore(makeStorage(), { id: 'E5x' });
  fresh(blank, 78);
  ok(S5.persistence.importJSON(blank.persistence.exportJSON()).ok, 'import a blank game over a played one');
  const backup1 = storage5.getItem(S5.persistence.BACKUP_KEY);
  eq(JSON.parse(backup1).meta.raceCounter, 1, 'the played game is the backup');
  ok(S5.persistence.importJSON(blank.persistence.exportJSON()).ok, 'import again over the blank game');
  eq(storage5.getItem(S5.persistence.BACKUP_KEY), backup1, 'the blank game did not replace the backup');
  const rs = S5.persistence.restoreBackup();
  ok(rs.ok && S5.state.get().meta.raceCounter === 1 && S5.state.get().players.fox, 'RESTORE BACKUP brings the played game back');
  ok(S5.state.get().log.some(function (e) { return e.text === 'Backup restored.'; }), 'logged as "Backup restored."');
  ok(played && S5.persistence.stats().backup > 0, 'stats().backup reports the backup size');

  // importJSON reports failure when the imported game cannot be saved, and keeps the current game.
  const storage6 = makeStorage();
  const S6 = makeCore(storage6, { id: 'E6' });
  fresh(S6, 88);
  say(S6, 'fox', '!join');
  const before = storage6.getItem(S6.persistence.KEY);
  storage6.refuse = function (k) { return k === S6.persistence.KEY; };
  const r6 = S6.persistence.importJSON(blank.persistence.exportJSON());
  storage6.refuse = null;
  ok(!r6.ok && r6.saveFailed && /could not be saved/.test(r6.error), 'IMPORT that cannot be saved reports { ok:false, saveFailed }', r6);
  ok(S6.state.get().players.fox && storage6.getItem(S6.persistence.KEY) === before, 'the current game is kept, in memory and in storage');

  // RESTORE BACKUP that cannot be saved leaves spiritderby.backup as it was (fix round: the backup slot
  // was overwritten with the current game first, so the game being restored existed nowhere any more).
  const storage8 = makeStorage();
  const S8 = makeCore(storage8, { id: 'E8' });
  fresh(S8, 91);
  say(S8, 'fox', '!join');
  S8.game.startRace(); S8.game.endRace();                   // game X: fox, 1 race
  const gameY = makeCore(makeStorage(), { id: 'E8y' });
  fresh(gameY, 92);
  say(gameY, 'owl', '!join'); say(gameY, 'moth', '!join');
  ok(S8.persistence.importJSON(gameY.persistence.exportJSON()).ok, 'import game Y over game X');
  const backupX = storage8.getItem(S8.persistence.BACKUP_KEY), savedY = storage8.getItem(S8.persistence.KEY);
  ok(JSON.parse(backupX).players.fox && !JSON.parse(savedY).players.fox, 'X is the backup, Y is stored');
  storage8.refuse = function (k) { return k === S8.persistence.KEY; };
  const r8 = S8.persistence.restoreBackup();
  storage8.refuse = null;
  ok(!r8.ok && r8.saveFailed, 'RESTORE BACKUP whose save is refused fails { saveFailed }', r8);
  ok(storage8.getItem(S8.persistence.BACKUP_KEY) === backupX, 'spiritderby.backup still holds game X, byte for byte');
  ok(storage8.getItem(S8.persistence.KEY) === savedY && S8.state.get().players.owl && !S8.state.get().players.fox, 'game Y is kept, stored and running');
  ok(S8.persistence.restoreBackup().ok && S8.state.get().players.fox, 'RESTORE BACKUP works once storage accepts it');
  // An import that cannot be saved, with no backup before it, leaves no backup behind either.
  const storage9 = makeStorage();
  const S9 = makeCore(storage9, { id: 'E9' });
  fresh(S9, 93);
  say(S9, 'fox', '!join');
  storage9.refuse = function (k) { return k === S9.persistence.KEY; };
  const r9 = S9.persistence.importJSON(gameY.persistence.exportJSON());
  storage9.refuse = null;
  ok(!r9.ok && r9.saveFailed && storage9.getItem(S9.persistence.BACKUP_KEY) === null, 'a failed import with no earlier backup leaves the backup slot empty');

  // A writer another window just took over from (TAKE OVER, its 'storage' event not handled yet)
  // refuses an import instead of writing over the new writer's backup.
  const storage10 = makeStorage();
  const W1 = makeCore(storage10, { id: 'E10a' });
  boot(W1);
  say(W1, 'fox', '!join');
  W1.game.startRace(); W1.game.endRace();
  const W2 = makeCore(storage10, { id: 'E10b' });
  ok(boot(W2).readOnly && W2.persistence.takeOver().ok, 'a second window takes over');
  W2.state.set(W2.persistence.load().state); W2.game.init();
  say(W2, 'owl', '!join');
  ok(W2.persistence.importJSON(gameY.persistence.exportJSON()).ok, 'the new writer imports (its game becomes its backup)');
  const backupW2 = storage10.getItem(W1.persistence.BACKUP_KEY), savedW2 = storage10.getItem(W1.persistence.KEY);
  eq(W1.persistence.role(), 'writer', 'the old window has not noticed yet');
  const r10 = W1.persistence.importJSON(gameY.persistence.exportJSON());
  ok(!r10.ok && r10.readOnly && W1.persistence.role() === 'reader', 'its IMPORT is refused { readOnly } and it steps down', r10);
  ok(storage10.getItem(W1.persistence.BACKUP_KEY) === backupW2 && storage10.getItem(W1.persistence.KEY) === savedW2, "the new window's save and backup are untouched");

  // The pre-upgrade backup is checked too.
  const storage7 = makeStorage();
  const S7 = makeCore(storage7, { id: 'E7' });
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'save-m1.json'), 'utf8');
  storage7.setItem(S7.persistence.KEY, fixture);
  storage7.refuse = function (k) { return k === S7.persistence.BACKUP_KEY; };
  const r7 = S7.persistence.load();
  storage7.refuse = null;
  ok(r7.fromStorage && r7.migratedFrom === 1 && r7.backupFailed === true, 'a failed pre-upgrade backup is reported { backupFailed }');
  ok(r7.state.log.some(function (e) { return /no room in browser storage to keep a backup/.test(e.text); }), 'and logged');
})();

// =============================================================================
section('F. Retention and ranking (perf-robustness#4)');
// =============================================================================
(function () {
  const storage = makeStorage();
  const SD = makeCore(storage, { id: 'F' });
  SD.persistence.setAutoSave(false);
  fresh(SD, 404);
  const raid = viewers(300, 'raider');
  raid.forEach(function (v) { SD.processCommand(v, '!join', { source: 'twitch' }); });
  say(SD, 'owner', '!join'); say(SD, 'owner', '!claim moss');
  say(SD, 'bettor', '!join');
  say(SD, 'modjo', '!join', { isMod: true });
  say(SD, 'regular', '!join');
  SD.state.get().players.regular.stats.commands = 60;     // a regular: lots of chat, no runner
  const st = SD.state.get();
  eq(Object.keys(st.players).length, 304, '304 players');
  const unlocked0 = st.achievements.unlocked.length;
  // 44 days later nothing is pruned; the bettor places a bet on day 46.
  clock.now += 44 * DAY;
  SD.game.nextDay();
  eq(Object.keys(SD.state.get().players).length, 304, 'nobody is pruned before CONFIG.RETENTION.INACTIVE_DAYS');
  clock.now += 2 * DAY;
  const fo = SD.betting.fieldOdds(SD.state.get());
  say(SD, 'bettor', '!bet ' + fo.entrants[0].runnerId + ' 10');
  SD.state.get().players.bettor.lastSeen = clock.now - 50 * DAY;   // bet placed, then gone for long
  let dayInfo = null;
  SD.bus.on(SD.EVENTS.SEASON_DAY_ADVANCED, function (p) { dayInfo = p; });
  SD.game.nextDay();
  const after = SD.state.get();
  const left = Object.keys(after.players).sort();
  eq(left, ['modjo', 'owner', 'regular'], 'the 300 drive-by raiders and the refunded bettor are pruned; owner, mod and regular stay');
  ok(dayInfo && dayInfo.pruned === 301, 'season:dayAdvanced reports pruned', dayInfo && dayInfo.pruned);
  ok(after.log.some(function (e) { return /301 inactive viewers were removed/.test(e.text); }), 'the log says so');
  ok(after.achievements.unlocked.every(function (a) { return left.indexOf(a.username) >= 0 || a.season === after.season.number; }), 'their achievement entries from earlier seasons are gone');
  ok(after.achievements.unlocked.length <= unlocked0, 'no achievement entries were added');
  ok(Object.keys(after.achievements.progress).every(function (k) { return left.indexOf(k) >= 0; }), 'their achievement progress is gone');
  // A bettor with an open bet is kept.
  say(SD, 'bettor', '!join');
  const fo2 = SD.betting.fieldOdds(SD.state.get());
  say(SD, 'bettor', '!bet ' + fo2.entrants[0].runnerId + ' 10');
  SD.state.get().players.bettor.lastSeen = clock.now - 50 * DAY;
  SD.state.get().season.raceIndexInDay = 0;
  SD.players.prune(SD.state.get());
  ok(!!SD.state.get().players.bettor, 'a viewer with an open bet is never pruned');
  // INACTIVE_DAYS 0 turns pruning off.
  SD.CONFIG.RETENTION.INACTIVE_DAYS = 0;
  SD.processCommand('late', '!join', { source: 'twitch' });
  SD.state.get().players.late.lastSeen = 0;
  eq(SD.players.prune(SD.state.get()), [], 'CONFIG.RETENTION.INACTIVE_DAYS = 0: never prune');
  SD.CONFIG.RETENTION.INACTIVE_DAYS = 45;

  // A past season's MVP is never pruned (fix round: season.history entries had no mvpKey, so the MVP of
  // a quiet season - low SP, no runner after the season reset - was pruned like a drive-by viewer).
  const SM = makeCore(makeStorage(), { id: 'F3' });
  SM.persistence.setAutoSave(false);
  fresh(SM, 406);
  say(SM, 'FoxFan', '!join');
  say(SM, 'drifter', '!join');
  const fs0 = SM.state.get();
  fs0.players.foxfan.stats.spEarnedTotal = 40;                     // the season's top earner (MVP)
  fs0.players.drifter.stats.spEarnedTotal = 5;
  const sum = SM.seasons.endSeason(fs0);
  ok(sum && sum.mvpKey === 'foxfan', 'foxfan is the season MVP', sum && sum.mvpKey);
  const hEntry = fs0.season.history[fs0.season.history.length - 1];
  eq(hEntry.mvpKey, 'foxfan', 'the season.history entry stores mvpKey');
  ['foxfan', 'drifter'].forEach(function (k) { const p = fs0.players[k]; p.lastSeen = clock.now - 50 * DAY; p.spiritPoints = 100; });
  const gone = SM.players.prune(fs0, clock.now);
  ok(gone.indexOf('foxfan') < 0 && !!fs0.players.foxfan, 'the past MVP is kept', gone);
  ok(gone.indexOf('drifter') >= 0, 'an unnamed drive-by viewer of that season is pruned', gone);
  // An entry from before mvpKey existed names the MVP by display name only.
  delete hEntry.mvpKey;
  eq(SM.players.prune(fs0, clock.now), [], 'an older entry (mvpUsername only) still protects its MVP');
  hEntry.mvpUsername = 'Fox Fan Club';                              // a display name that is not the login
  fs0.players.foxfan.displayName = 'Fox Fan Club';
  eq(SM.players.prune(fs0, clock.now), [], 'matched by display name too');
  hEntry.mvpUsername = 'someone else';
  eq(SM.players.prune(fs0, clock.now), ['foxfan'], 'and only the named viewer is protected');

  // rankOf (one pass, no sort) agrees with the full ranking, ties included.
  const S2 = makeCore(makeStorage(), { id: 'F2' });
  S2.persistence.setAutoSave(false);
  fresh(S2, 405);
  const rng = S2.rng.create(99);
  viewers(120, 'p').forEach(function (v) {
    S2.processCommand(v, '!join', { source: 'twitch' });
    const p = S2.players.get(S2.state.get(), v);
    p.spiritPoints = 100 * rng.int(6);
    p.stats.raceVictories = rng.int(3);
    p.stats.hypeContributed = rng.int(4) * 2.5;
  });
  let agree = 0, total = 0;
  S2.leaderboards.CATEGORIES.forEach(function (c) {
    ['season', 'all'].forEach(function (scope) {
      const list = S2.leaderboards.all(S2.state.get(), c.id, scope);
      const ids = c.kind === 'player' ? Object.keys(S2.state.get().players) : S2.state.get().runners.map(function (r) { return r.id; });
      ids.forEach(function (id) {
        total++;
        const e = list.filter(function (x) { return x.id === id; })[0];
        const r = S2.leaderboards.rankOf(S2.state.get(), c.id, id, scope);
        const want = e ? { rank: e.rank, value: e.value, label: e.label, total: list.length } : null;
        if (JSON.stringify(r) === JSON.stringify(want)) agree++;
      });
    });
  });
  eq(agree, total, 'rankOf() equals the full ranking for every player / runner on every board and scope (' + total + ' checks)');
})();

console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
