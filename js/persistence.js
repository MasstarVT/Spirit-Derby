/*
 * Spirit Derby - persistence.js
 * Save / load / migrate / export / import. The only core file allowed to touch
 * localStorage (guarded, with an in-memory fallback for Node and locked-down browsers).
 *
 *  - Saves are debounced (CONFIG.SAVE_DEBOUNCE_MS) in the browser, immediate in Node
 *    (setAutoSave(false) turns the automatic saves off, e.g. for the fuzz test).
 *    main.js flushes a pending save on beforeunload / pagehide / tab hidden.
 *  - raceHistory keeps full tick data only for the last CONFIG.HISTORY_FULL_LOGS races.
 *  - A race saved mid-playback is treated as interrupted on load: bets refunded,
 *    queued chat effects restored, record dropped, log entry written.
 *  - MIGRATIONS[n] upgrades a save from version n-1 to n. A backup copy of the raw
 *    save is written to BACKUP_KEY before any migration or import.
 *  - normalize(state) (M6) brings a save from ANY milestone up to the current shape: every
 *    field added since M1 gets its default, wrong types are repaired, broken entries dropped.
 *  - reconcileRoster(state) (M6) spawns SD.DATA.ROSTER entries a saved game does not have yet
 *    (the roster is data-driven: add a runner to data.js and existing saves pick it up).
 *  - Every successful save emits state:saved { at, bytes, stats } (admin SAVE indicator).
 */
(function (SD) {
  'use strict';

  const KEY = 'spiritderby.save';
  const BACKUP_KEY = 'spiritderby.backup';
  const SCHEMA_VERSION = 2;

  // ---------------------------------------------------------------------------
  // Storage backend
  // ---------------------------------------------------------------------------
  const memoryStore = {
    data: Object.create(null),
    getItem: function (k) { return k in this.data ? this.data[k] : null; },
    setItem: function (k, v) { this.data[k] = String(v); },
    removeItem: function (k) { delete this.data[k]; }
  };
  let store = null;
  let storeKind = 'memory';

  function getStore() {
    if (store) return store;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        const probe = '__spiritderby_probe__';
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);
        store = localStorage;
        storeKind = 'localStorage';
        return store;
      }
    } catch (e) { /* file:// in some browsers, private mode, disabled storage */ }
    store = memoryStore;
    storeKind = 'memory';
    return store;
  }

  function readRaw(key) {
    try { return getStore().getItem(key); } catch (e) { return null; }
  }
  function writeRaw(key, value) {
    getStore().setItem(key, value); // may throw (quota) - callers handle
  }

  // ---------------------------------------------------------------------------
  // Save scheduling
  // ---------------------------------------------------------------------------
  let timer = null;
  let dirty = false;
  let lastError = null;
  let lastSavedAt = null;
  let lastBytes = null;
  let autoSave = true;
  let saveCount = 0;
  let lastRosterAdded = [];

  function hasTimers() {
    return !SD.isNode && typeof globalThis.setTimeout === 'function';
  }

  function scheduleSave() {
    dirty = true;
    if (!autoSave) return;
    if (!hasTimers()) { save(true); return; }
    if (timer) return;
    timer = globalThis.setTimeout(function () { timer = null; save(true); }, SD.CONFIG.SAVE_DEBOUNCE_MS);
  }

  function cancelTimer() {
    if (timer && typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(timer);
    timer = null;
  }

  // Automatic saves on/off (default on). Off: mutations only mark the game dirty; save() / flush()
  // still write. Returns the previous value.
  function setAutoSave(on) {
    const was = autoSave;
    autoSave = on !== false;
    if (!autoSave) cancelTimer();
    return was;
  }

  // Strip tick data from all but the last HISTORY_FULL_LOGS races, and drop
  // records beyond HISTORY_MAX. Mutates state in place (old records only).
  function trimHistory(st, keepFull) {
    if (!st || !Array.isArray(st.raceHistory)) return;
    const CFG = SD.CONFIG;
    const hist = st.raceHistory;
    if (hist.length > CFG.HISTORY_MAX) hist.splice(0, hist.length - CFG.HISTORY_MAX);
    const full = keepFull == null ? CFG.HISTORY_FULL_LOGS : keepFull;
    for (let i = 0; i < hist.length - full; i++) {
      const rec = hist[i];
      if (rec && rec.ticks && rec.ticks.length) {
        rec.ticks = [];
        rec.ticksStripped = true;
      }
    }
  }

  function emitSaved() {
    if (!SD.bus || !SD.EVENTS.STATE_SAVED) return;
    try { SD.bus.emit(SD.EVENTS.STATE_SAVED, { at: lastSavedAt, bytes: lastBytes, stats: stats() }); } catch (e) { /* never break a save */ }
  }

  // Write the current state now. Returns true on success.
  function save() {
    const st = SD.state && SD.state.get();
    cancelTimer();
    if (!st) return false;
    trimHistory(st);
    let json;
    try {
      json = JSON.stringify(st);
      writeRaw(KEY, json);
    } catch (e) {
      // Most likely a quota error: keep only 2 full race logs and retry once.
      lastError = e;
      try {
        trimHistory(st, 2);
        json = JSON.stringify(st);
        writeRaw(KEY, json);
      } catch (e2) {
        lastError = e2;
        if (typeof console !== 'undefined' && console.warn) console.warn('[SD.persistence] save failed:', e2);
        return false;
      }
    }
    dirty = false;
    lastError = null;
    lastSavedAt = SD.clock.now();
    lastBytes = json.length;
    saveCount++;
    emitSaved();
    return true;
  }

  // Write a pending save right now (beforeunload / pagehide / tab hidden). Safe to call any time.
  function flush() {
    if (dirty || timer) return save(true);
    return true;
  }

  // Numbers for the admin SAVE section: { bytes, races, players, runners, savedAt, storage, dirty, ... }
  function stats(st) {
    st = st || (SD.state && SD.state.get());
    let bytes = lastBytes;
    if (bytes == null && st) {
      try { bytes = JSON.stringify(st).length; } catch (e) { bytes = 0; }
    }
    const runners = st && Array.isArray(st.runners) ? st.runners.filter(function (r) { return r && !r.retired; }).length : 0;
    return {
      bytes: bytes || 0,
      races: st && Array.isArray(st.raceHistory) ? st.raceHistory.length : 0,
      racesTotal: st && st.meta ? Number(st.meta.raceCounter) || 0 : 0,
      players: st && st.players ? Object.keys(st.players).length : 0,
      runners: runners,
      savedAt: lastSavedAt,
      saves: saveCount,
      dirty: dirty || !!timer,
      autoSave: autoSave,
      storage: storageKind(),
      schema: SCHEMA_VERSION,
      error: lastError ? String(lastError.message || lastError) : null
    };
  }

  // ---------------------------------------------------------------------------
  // Validation, normalisation, migration
  // ---------------------------------------------------------------------------
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(v, dflt, lo, hi) {
    let n = Number(v);
    if (v === null || v === '' || typeof v === 'boolean' || !isFinite(n)) n = dflt;
    if (lo != null && n < lo) n = lo;
    if (hi != null && n > hi) n = hi;
    return n;
  }
  function int(v, dflt, lo, hi) { return Math.round(num(v, dflt, lo, hi)); }

  function validate(raw) {
    if (!isObj(raw)) return { ok: false, error: 'Save data is not an object.' };
    if (!Array.isArray(raw.runners)) return { ok: false, error: 'Save data has no runners list.' };
    if (raw.settings != null && !isObj(raw.settings)) return { ok: false, error: 'Save data has invalid settings.' };
    if (raw.season != null && !isObj(raw.season)) return { ok: false, error: 'Save data has an invalid season.' };
    const v = raw.schemaVersion == null ? 0 : Number(raw.schemaVersion);
    if (!(v >= 0)) return { ok: false, error: 'Save data has an invalid schemaVersion.' };
    if (v > SCHEMA_VERSION) {
      return { ok: false, error: 'This save is from a newer version of Spirit Derby (schema ' + v + ', this build reads up to ' + SCHEMA_VERSION + ').' };
    }
    return { ok: true, version: v };
  }

  // Fill any missing keys in `target` from `defaults` (recursively for plain objects).
  function fillDefaults(target, defaults) {
    Object.keys(defaults).forEach(function (k) {
      if (!(k in target) || target[k] === undefined) {
        target[k] = SD.util.deepClone(defaults[k]);
      } else if (isObj(defaults[k]) && isObj(target[k])) {
        fillDefaults(target[k], defaults[k]);
      }
    });
    return target;
  }

  // Settings: missing keys get defaults (fillDefaults); keys of the wrong type or out of range are
  // reset to their default. Unknown keys are kept (a newer build may know them).
  function normalizeSettings(s, d) {
    const C = SD.CONFIG.RACE;
    Object.keys(d).forEach(function (k) {
      const dv = d[k];
      if (dv === null) return;                                  // seedOverride: checked below
      if (isObj(dv)) { if (!isObj(s[k])) s[k] = SD.util.deepClone(dv); else fillDefaults(s[k], dv); return; }
      if (typeof s[k] !== typeof dv || (typeof dv === 'number' && !isFinite(s[k]))) s[k] = dv;
    });
    if (C.DISTANCES.indexOf(s.distance) < 0) s.distance = d.distance;
    s.runnerCount = int(s.runnerCount, d.runnerCount, C.MIN_RUNNERS, C.MAX_RUNNERS);
    if (!Object.prototype.hasOwnProperty.call(C.EVENTS.SLIDER, s.eventFrequency)) s.eventFrequency = d.eventFrequency;
    s.hypeMultiplier = num(s.hypeMultiplier, d.hypeMultiplier, 0, 5);
    s.playbackSpeed = num(s.playbackSpeed, d.playbackSpeed, 0.25, 8);
    s.finalStretchSpeedup = num(s.finalStretchSpeedup, d.finalStretchSpeedup, 1, 4);
    s.userCooldownS = int(s.userCooldownS, d.userCooldownS, 0, 3600);
    s.resultsAutoCloseMs = int(s.resultsAutoCloseMs, d.resultsAutoCloseMs, 0, 600000);
    if (s.seedOverride !== null && !(isNum(s.seedOverride) && s.seedOverride >= 0)) s.seedOverride = null;
    ['channel'].forEach(function (k) { if (typeof s.twitch[k] !== 'string') s.twitch[k] = d.twitch[k]; });
    ['url'].forEach(function (k) { if (typeof s.bridge[k] !== 'string') s.bridge[k] = d.bridge[k]; });
    ['enabled'].forEach(function (k) {
      if (typeof s.twitch[k] !== 'boolean') s.twitch[k] = d.twitch[k];
      if (typeof s.bridge[k] !== 'boolean') s.bridge[k] = d.bridge[k];
    });
  }

  function isValidRecord(rec) {
    return isObj(rec) && rec.id != null && Array.isArray(rec.entrants) && rec.entrants.length > 0 && Array.isArray(rec.results);
  }

  // Bring a loaded state up to the current shape (saves from any milestone load cleanly).
  // Fills every field added since M1 - players, bets, raceEffects, achievements (+ progress),
  // season.history / racesRun / startedAt, meta counters, settings (twitch, bridge, openTraining,
  // allowCreate, resultsAutoCloseMs, seedOverride ...), runner.lifetime / effects / ribbonColor /
  // trainStreak / daily, player.lifetime / backing / achievements - and repairs wrong types.
  // A state that is already well-formed comes out unchanged (export -> import is lossless).
  function normalize(st) {
    ['meta', 'season', 'hype', 'settings', 'achievements'].forEach(function (k) { if (!isObj(st[k])) st[k] = {}; });
    const defaults = SD.state.create({ roster: false, seedSalt: isNum(st.meta.seedSalt) ? st.meta.seedSalt : undefined });
    // Top-level keys whose contents are user data: only fill when missing entirely.
    ['runners', 'raceHistory', 'log', 'bets', 'raceEffects'].forEach(function (k) {
      if (!Array.isArray(st[k])) st[k] = [];
    });
    if (!isObj(st.players)) st.players = {};
    fillDefaults(st, defaults);

    // meta
    const M = st.meta;
    M.seedSalt = isNum(M.seedSalt) ? (M.seedSalt >>> 0) : defaults.meta.seedSalt;
    ['raceCounter', 'runnerCounter', 'actionCounter', 'betCounter'].forEach(function (k) { M[k] = int(M[k], 0, 0); });
    ['createdAt', 'updatedAt'].forEach(function (k) { M[k] = num(M[k], defaults.meta[k], 0); });

    // settings
    normalizeSettings(st.settings, defaults.settings);

    // season
    const S = st.season;
    S.number = int(S.number, 1, 1);
    S.daysPerSeason = int(S.daysPerSeason, SD.CONFIG.SEASON.DAYS, 1);
    S.racesPerDay = int(S.racesPerDay, SD.CONFIG.SEASON.RACES_PER_DAY, 1);
    S.day = int(S.day, 1, 1, S.daysPerSeason);
    S.raceIndexInDay = int(S.raceIndexInDay, 0, 0, S.racesPerDay);
    S.racesRun = int(S.racesRun, 0, 0);
    S.startedAt = num(S.startedAt, M.createdAt, 0);
    if (!Array.isArray(S.history)) S.history = [];
    S.history = S.history.filter(isObj);
    if (S.activeDayEvent != null && !(SD.events && SD.events.dayEventById(S.activeDayEvent))) S.activeDayEvent = null;

    // hype
    const H = st.hype;
    H.max = num(H.max, SD.CONFIG.HYPE.MAX, 1);
    H.value = num(H.value, 0, 0, H.max);
    if (!Array.isArray(H.thresholdsHit)) H.thresholdsHit = [];
    if (!isObj(H.contributions)) H.contributions = {};
    Object.keys(H.contributions).forEach(function (k) { if (!isNum(H.contributions[k])) delete H.contributions[k]; });
    H.lastChangedAt = num(H.lastChangedAt, M.updatedAt, 0);

    // achievements
    const A = st.achievements;
    if (!Array.isArray(A.unlocked)) A.unlocked = [];
    A.unlocked = A.unlocked.filter(function (a) { return isObj(a) && a.id; });
    if (!isObj(A.progress)) A.progress = {};

    // runners: complete shape, unique ids, counter past the highest id
    st.runners = st.runners.filter(isObj);
    st.runners.forEach(function (r) { if (SD.runners && SD.runners.normalize) SD.runners.normalize(r); });
    let maxId = 0;
    st.runners.forEach(function (r) {
      const n = parseInt(String(r.id).replace(/^r/, ''), 10);
      if (n > maxId) maxId = n;
    });
    if (!(M.runnerCounter >= maxId)) M.runnerCounter = maxId;
    const seenIds = {};
    st.runners.forEach(function (r) {
      if (r.id == null || r.id === '' || seenIds[r.id]) r.id = SD.runners ? SD.runners.nextId(st) : 'r' + (++M.runnerCounter);
      seenIds[r.id] = true;
    });

    // players (keyed by username key)
    const players = {};
    Object.keys(st.players).forEach(function (k) {
      const p = st.players[k];
      if (!isObj(p)) return;
      if (!p.username) p.username = k;
      if (SD.players && typeof SD.players.normalize === 'function') SD.players.normalize(p);
      const key = p.username || String(k).toLowerCase();
      if (!players[key]) players[key] = p;
    });
    if (Object.keys(players).length !== Object.keys(st.players).length ||
        Object.keys(players).some(function (k) { return st.players[k] !== players[k]; })) {
      st.players = players;
    }
    Object.keys(st.players).forEach(function (k) {
      const p = st.players[k];
      if (p.runnerId != null && !seenIds[p.runnerId]) p.runnerId = null;
      if (p.backing && p.backing.runnerId != null && !seenIds[p.backing.runnerId]) p.backing = { runnerId: null, actions: 0 };
    });

    // open bets: well-formed, one per player (older duplicates are refunded), known player + runner
    const betBy = {};
    const bets = [];
    st.bets.forEach(function (b) {
      if (!isObj(b) || !b.username || !seenIds[b.runnerId] || !(isNum(b.amount) && b.amount > 0) || !(isNum(b.odds) && b.odds > 0)) return;
      const p = st.players[String(b.username).toLowerCase()];
      if (!p) return;
      if (betBy[p.username]) {
        const old = betBy[p.username];
        p.spiritPoints += old.amount;                        // keep the newest bet, refund the older one
        bets.splice(bets.indexOf(old), 1);
      }
      betBy[p.username] = b;
      bets.push(b);
    });
    if (bets.length !== st.bets.length) st.bets = bets;

    // queued chat effects
    const effects = st.raceEffects.filter(function (e) {
      return isObj(e) && /^(boost|sabotage|cheer)$/.test(e.type) && seenIds[e.runnerId];
    });
    effects.forEach(function (e) {
      if (!(isNum(e.count) && e.count >= 1)) e.count = 1;
      if (e.paid != null && !(isNum(e.paid) && e.paid >= 0)) e.paid = 0;
    });
    if (effects.length !== st.raceEffects.length) st.raceEffects = effects;

    // race history + the race in progress
    st.raceHistory = st.raceHistory.filter(isValidRecord).length === st.raceHistory.length ? st.raceHistory : st.raceHistory.filter(isValidRecord);
    // A malformed race in progress becomes an interrupted one (recoverInterruptedRace, which runs
    // right after migrate(), refunds its bets and clears it); record:null never reaches the game.
    const cr = st.currentRace;
    if (cr != null && !(isObj(cr) && isValidRecord(cr.record) && /^(countdown|running|paused|finished)$/.test(cr.status))) {
      st.currentRace = { record: isObj(cr) && isValidRecord(cr.record) ? cr.record : null, status: 'running', startedAt: isObj(cr) ? num(cr.startedAt, 0, 0) : 0 };
    }
    st.log = st.log.filter(isObj).length === st.log.length ? st.log : st.log.filter(isObj);
    if (st.log.length > SD.CONFIG.LOG_CAP) st.log.splice(0, st.log.length - SD.CONFIG.LOG_CAP);

    st.schemaVersion = SCHEMA_VERSION;
    return st;
  }

  // Spawn every SD.DATA.ROSTER entry the saved game does not have yet. Matching is by rosterKey,
  // or (saves from before rosterKey) by name among non-custom runners, which backfills rosterKey.
  // Never duplicates a runner. Returns the runners it added.
  function reconcileRoster(st) {
    const added = [];
    if (!st || !Array.isArray(st.runners) || !SD.DATA || !Array.isArray(SD.DATA.ROSTER) || !SD.runners) return added;
    const U = SD.util;
    SD.DATA.ROSTER.forEach(function (entry, idx) {
      if (!entry || !entry.key) return;
      if (st.runners.some(function (r) { return r.rosterKey === entry.key; })) return;
      const legacy = st.runners.filter(function (r) {
        return !r.rosterKey && !r.custom && U.nameKey(r.name) === U.nameKey(entry.name);
      })[0];
      if (legacy) { legacy.rosterKey = entry.key; return; }
      const runner = SD.runners.spawnFromRoster(entry, idx);
      const n = parseInt(String(runner.id).replace(/^r/, ''), 10);
      if (st.runners.some(function (r) { return r.id === runner.id; })) runner.id = SD.runners.nextId(st);
      else if (n > (st.meta.runnerCounter || 0)) st.meta.runnerCounter = n;
      runner.name = SD.runners.uniqueName(st, runner.name);
      st.runners.push(runner);
      added.push(runner);
    });
    if (added.length) {
      pushLog(st, 'runner', 'New to the roster: ' + added.map(function (r) { return r.emoji + ' ' + r.name; }).join(', ') + '.', 'good');
    }
    return added;
  }

  // Migrations keyed by TARGET version. Each receives (raw, ctx = { from }) and returns it upgraded.
  const MIGRATIONS = {
    // v0 -> v1: pre-release saves had no schemaVersion; normalize() fills all new keys.
    1: function (raw) { return raw; },
    // v1 -> v2 (M6): saves from M1-M5 lack players / bets / raceEffects / achievements.progress /
    // newer settings and runner / player fields. normalize() fills them; the original version is
    // recorded in meta.migratedFrom and a log line says so.
    2: function (raw, ctx) {
      normalize(raw);
      raw.meta.migratedFrom = ctx && ctx.from != null ? ctx.from : 1;
      raw.meta.migratedAt = SD.clock.now();
      pushLog(raw, 'system', 'Save upgraded from schema v' + raw.meta.migratedFrom + ' to v2 (Spirit Derby ' + SD.VERSION + ').', 'info');
      return raw;
    }
  };

  function migrate(raw) {
    let data = raw;
    const from = data.schemaVersion == null ? 0 : Number(data.schemaVersion);
    let v = from;
    while (v < SCHEMA_VERSION) {
      const next = v + 1;
      if (typeof MIGRATIONS[next] === 'function') data = MIGRATIONS[next](data, { from: from }) || data;
      v = next;
      data.schemaVersion = v;
    }
    normalize(data);
    lastRosterAdded = reconcileRoster(data);
    return data;
  }

  function pushLog(st, type, text, severity) {
    if (!Array.isArray(st.log)) st.log = [];
    const season = isObj(st.season) ? st.season : {};
    st.log.push({ t: SD.clock.now(), season: season.number || 1, day: season.day || 1, type: type, text: text, severity: severity || 'info' });
    if (st.log.length > SD.CONFIG.LOG_CAP) st.log.splice(0, st.log.length - SD.CONFIG.LOG_CAP);
  }

  // Refund open bets straight to player balances (used when no betting module exists).
  function refundBetsRaw(st) {
    let count = 0;
    (st.bets || []).forEach(function (b) {
      const p = st.players[String(b.username || '').toLowerCase()];
      if (p && b.amount > 0) { p.spiritPoints = (p.spiritPoints || 0) + b.amount; count++; }
    });
    st.bets = [];
    return count;
  }

  // A race that was mid-playback when the page closed cannot be resumed.
  function recoverInterruptedRace(st) {
    const cr = st.currentRace;
    if (!cr) return false;
    if (cr.status === 'finished' && cr.record) return false; // game.init() applies it
    let refunded = 0;
    if (SD.betting && typeof SD.betting.refundAll === 'function') {
      const r = SD.betting.refundAll(st, 'interrupted');
      refunded = Array.isArray(r) ? r.length : (r || 0);
    } else {
      refunded = refundBetsRaw(st);
    }
    // Paid-for chat effects go back into the queue for the next race.
    const inputs = cr.record && cr.record.inputs;
    if (inputs && Array.isArray(inputs.raceEffects) && inputs.raceEffects.length) {
      st.raceEffects = inputs.raceEffects.concat(st.raceEffects || []);
    }
    st.currentRace = null;
    pushLog(st, 'race', 'The last race was interrupted (the page closed mid-race). It was cancelled' +
      (refunded ? ' and ' + refunded + ' bet' + (refunded === 1 ? ' was' : 's were') + ' refunded.' : '.'), 'warn');
    return true;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  function fresh(reason) {
    const st = SD.state.create();
    if (reason) pushLog(st, 'system', reason, 'warn');
    return st;
  }

  // Returns { state, fromStorage, migratedFrom, rosterAdded }. Never throws.
  function load() {
    const raw = readRaw(KEY);
    if (!raw) return { state: fresh(), fromStorage: false, migratedFrom: null, rosterAdded: [] };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      try { writeRaw(BACKUP_KEY, raw); } catch (e2) { /* ignore */ }
      return { state: fresh('Saved data was unreadable, so a new game was started (a backup copy was kept).'), fromStorage: false, migratedFrom: null, rosterAdded: [] };
    }
    const v = validate(parsed);
    if (!v.ok) {
      try { writeRaw(BACKUP_KEY, raw); } catch (e2) { /* ignore */ }
      return { state: fresh(v.error + ' A new game was started (a backup copy was kept).'), fromStorage: false, migratedFrom: null, rosterAdded: [] };
    }
    if (v.version < SCHEMA_VERSION) {
      try { writeRaw(BACKUP_KEY, raw); } catch (e2) { /* ignore */ }
    }
    let st;
    try {
      st = migrate(parsed);
    } catch (e) {
      try { writeRaw(BACKUP_KEY, raw); } catch (e2) { /* ignore */ }
      return { state: fresh('Saved data could not be upgraded (' + e.message + '). A new game was started (a backup copy was kept).'), fromStorage: false, migratedFrom: null, rosterAdded: [] };
    }
    const rosterAdded = lastRosterAdded.slice();
    recoverInterruptedRace(st);
    return { state: st, fromStorage: true, migratedFrom: v.version < SCHEMA_VERSION ? v.version : null, rosterAdded: rosterAdded };
  }

  function exportJSON() {
    const st = SD.state && SD.state.get();
    return st ? JSON.stringify(st) : '';
  }

  // Suggested download name, e.g. spirit-derby-s1-d3.json
  function exportFilename() {
    const st = SD.state && SD.state.get();
    if (!st) return 'spirit-derby.json';
    return 'spirit-derby-s' + st.season.number + '-d' + st.season.day + '.json';
  }

  // Replace the whole game with an exported save. Returns { ok, error?, migratedFrom? }.
  function importJSON(text) {
    let parsed;
    try {
      parsed = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (e) {
      return { ok: false, error: 'That file is not valid JSON.' };
    }
    const v = validate(parsed);
    if (!v.ok) return { ok: false, error: v.error };
    let st;
    try {
      st = migrate(SD.util.deepClone(parsed));
    } catch (e) {
      return { ok: false, error: 'Could not upgrade that save: ' + e.message };
    }
    // Keep a copy of what we are about to overwrite.
    try {
      const cur = SD.state.get();
      if (cur) writeRaw(BACKUP_KEY, JSON.stringify(cur));
    } catch (e) { /* ignore */ }
    recoverInterruptedRace(st);
    pushLog(st, 'system', 'Save imported.', 'info');
    SD.state.set(st);
    save(true);
    const migratedFrom = v.version < SCHEMA_VERSION ? v.version : null;
    if (SD.bus) {
      SD.bus.emit(SD.EVENTS.STATE_LOADED, { source: 'import', migratedFrom: migratedFrom });
      SD.bus.emit(SD.EVENTS.STATE_CHANGED, { label: 'import' });
    }
    return { ok: true, migratedFrom: migratedFrom };
  }

  function clear() {
    cancelTimer();
    dirty = false;
    lastBytes = null;
    try { getStore().removeItem(KEY); } catch (e) { /* ignore */ }
  }

  function readBackup() { return readRaw(BACKUP_KEY); }
  function storageKind() { getStore(); return storeKind; }

  SD.persistence = {
    KEY: KEY,
    BACKUP_KEY: BACKUP_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MIGRATIONS: MIGRATIONS,
    load: load,
    save: save,
    scheduleSave: scheduleSave,
    flush: flush,
    setAutoSave: setAutoSave,
    stats: stats,
    exportJSON: exportJSON,
    exportFilename: exportFilename,
    importJSON: importJSON,
    clear: clear,
    migrate: migrate,
    normalize: normalize,
    reconcileRoster: reconcileRoster,
    validate: validate,
    trimHistory: trimHistory,
    recoverInterruptedRace: recoverInterruptedRace,
    readBackup: readBackup,
    readRaw: readRaw,
    storageKind: storageKind,
    lastError: function () { return lastError; },
    lastSavedAt: function () { return lastSavedAt; },
    _memoryStore: memoryStore
  };
})(globalThis.SD = globalThis.SD || {});
