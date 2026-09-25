/*
 * Spirit Derby - persistence.js
 * Save / load / migrate / export / import. The only core file allowed to touch
 * localStorage (guarded, with an in-memory fallback for Node and locked-down browsers).
 *
 *  - Saves are debounced (CONFIG.SAVE_DEBOUNCE_MS) in the browser, immediate in Node.
 *  - raceHistory keeps full tick data only for the last CONFIG.HISTORY_FULL_LOGS races.
 *  - A race saved mid-playback is treated as interrupted on load: bets refunded,
 *    queued chat effects restored, record dropped, log entry written.
 *  - MIGRATIONS[n] upgrades a save from version n-1 to n. A backup copy of the raw
 *    save is written to BACKUP_KEY before any migration or import.
 */
(function (SD) {
  'use strict';

  const KEY = 'spiritderby.save';
  const BACKUP_KEY = 'spiritderby.backup';
  const SCHEMA_VERSION = 1;

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

  function hasTimers() {
    return !SD.isNode && typeof globalThis.setTimeout === 'function';
  }

  function scheduleSave() {
    dirty = true;
    if (!hasTimers()) { save(true); return; }
    if (timer) return;
    timer = globalThis.setTimeout(function () { timer = null; save(true); }, SD.CONFIG.SAVE_DEBOUNCE_MS);
  }

  function cancelTimer() {
    if (timer && typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(timer);
    timer = null;
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

  // Write the current state now. Returns true on success.
  function save() {
    const st = SD.state && SD.state.get();
    cancelTimer();
    if (!st) return false;
    trimHistory(st);
    try {
      writeRaw(KEY, JSON.stringify(st));
      dirty = false;
      lastError = null;
      lastSavedAt = SD.clock.now();
      return true;
    } catch (e) {
      // Most likely a quota error: keep only 2 full race logs and retry once.
      lastError = e;
      try {
        trimHistory(st, 2);
        writeRaw(KEY, JSON.stringify(st));
        dirty = false;
        lastSavedAt = SD.clock.now();
        return true;
      } catch (e2) {
        lastError = e2;
        if (typeof console !== 'undefined' && console.warn) console.warn('[SD.persistence] save failed:', e2);
        return false;
      }
    }
  }

  function flush() {
    if (dirty || timer) return save(true);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Validation, normalisation, migration
  // ---------------------------------------------------------------------------
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

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

  // Bring a loaded state up to the current shape (missing keys get defaults).
  function normalize(st) {
    const defaults = SD.state.create({ roster: false, seedSalt: st.meta && st.meta.seedSalt });
    // Top-level keys whose contents are user data: only fill when missing entirely.
    ['runners', 'raceHistory', 'log', 'bets', 'raceEffects'].forEach(function (k) {
      if (!Array.isArray(st[k])) st[k] = [];
    });
    if (!isObj(st.players)) st.players = {};
    fillDefaults(st, defaults);
    st.runners.forEach(function (r) { if (SD.runners && SD.runners.normalize) SD.runners.normalize(r); });
    if (SD.players && typeof SD.players.normalize === 'function') {
      Object.keys(st.players).forEach(function (k) { SD.players.normalize(st.players[k]); });
    }
    if (!Array.isArray(st.hype.thresholdsHit)) st.hype.thresholdsHit = [];
    if (!Array.isArray(st.season.history)) st.season.history = [];
    if (!Array.isArray(st.achievements.unlocked)) st.achievements.unlocked = [];
    // Make sure the runner id counter never collides with existing ids.
    let maxId = 0;
    st.runners.forEach(function (r) {
      const n = parseInt(String(r.id).replace(/^r/, ''), 10);
      if (n > maxId) maxId = n;
    });
    if (!(st.meta.runnerCounter >= maxId)) st.meta.runnerCounter = maxId;
    st.schemaVersion = SCHEMA_VERSION;
    return st;
  }

  // Migrations keyed by TARGET version. Each receives the raw object and returns it upgraded.
  const MIGRATIONS = {
    // v0 -> v1: pre-release saves had no schemaVersion; normalize() fills all new keys.
    1: function (raw) { return raw; }
  };

  function migrate(raw) {
    let data = raw;
    let v = data.schemaVersion == null ? 0 : Number(data.schemaVersion);
    while (v < SCHEMA_VERSION) {
      const next = v + 1;
      if (typeof MIGRATIONS[next] === 'function') data = MIGRATIONS[next](data) || data;
      v = next;
      data.schemaVersion = v;
    }
    return normalize(data);
  }

  function pushLog(st, type, text, severity) {
    st.log.push({ t: SD.clock.now(), season: st.season.number, day: st.season.day, type: type, text: text, severity: severity || 'info' });
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

  // Returns { state, fromStorage, migratedFrom }. Never throws.
  function load() {
    const raw = readRaw(KEY);
    if (!raw) return { state: fresh(), fromStorage: false, migratedFrom: null };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      try { writeRaw(BACKUP_KEY, raw); } catch (e2) { /* ignore */ }
      return { state: fresh('Saved data was unreadable, so a new game was started (a backup copy was kept).'), fromStorage: false, migratedFrom: null };
    }
    const v = validate(parsed);
    if (!v.ok) {
      try { writeRaw(BACKUP_KEY, raw); } catch (e2) { /* ignore */ }
      return { state: fresh(v.error + ' A new game was started (a backup copy was kept).'), fromStorage: false, migratedFrom: null };
    }
    if (v.version < SCHEMA_VERSION) {
      try { writeRaw(BACKUP_KEY, raw); } catch (e2) { /* ignore */ }
    }
    let st;
    try {
      st = migrate(parsed);
    } catch (e) {
      return { state: fresh('Saved data could not be upgraded (' + e.message + '). A new game was started.'), fromStorage: false, migratedFrom: null };
    }
    recoverInterruptedRace(st);
    return { state: st, fromStorage: true, migratedFrom: v.version < SCHEMA_VERSION ? v.version : null };
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

  // Replace the whole game with an exported save. Returns { ok, error? }.
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
    if (SD.bus) {
      SD.bus.emit(SD.EVENTS.STATE_LOADED, { source: 'import', migratedFrom: v.version < SCHEMA_VERSION ? v.version : null });
      SD.bus.emit(SD.EVENTS.STATE_CHANGED, { label: 'import' });
    }
    return { ok: true };
  }

  function clear() {
    cancelTimer();
    dirty = false;
    try { getStore().removeItem(KEY); } catch (e) { /* ignore */ }
  }

  function readBackup() { return readRaw(BACKUP_KEY); }

  SD.persistence = {
    KEY: KEY,
    BACKUP_KEY: BACKUP_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MIGRATIONS: MIGRATIONS,
    load: load,
    save: save,
    scheduleSave: scheduleSave,
    flush: flush,
    exportJSON: exportJSON,
    exportFilename: exportFilename,
    importJSON: importJSON,
    clear: clear,
    migrate: migrate,
    normalize: normalize,
    validate: validate,
    trimHistory: trimHistory,
    recoverInterruptedRace: recoverInterruptedRace,
    readBackup: readBackup,
    storageKind: function () { getStore(); return storeKind; },
    lastError: function () { return lastError; },
    lastSavedAt: function () { return lastSavedAt; },
    _memoryStore: memoryStore
  };
})(globalThis.SD = globalThis.SD || {});
