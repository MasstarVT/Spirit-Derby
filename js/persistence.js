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
 *  - Review batch 5: load() / importJSON() re-salt meta.seedSalt from SD.entropy (no replayed races
 *    after a rollback); exportJSON() leaves the salt out; the debug seed override is never saved.
 *  - Review batch 6 (durability):
 *    * slim history: records past the last HISTORY_FULL_LOGS keep a compact form (slimRecord: no
 *      ticks, compacted chat effects, winning bets + betsSummary, capped cheer names); no history
 *      record keeps inputs.raceEffects. MIGRATIONS[4] slims existing saves.
 *    * size budget: save() keeps the JSON under CONFIG.SAVE.BUDGET_CHARS by dropping the oldest race
 *      records (fitBudget), and on a quota error shrinks further and retries. The trimming is done on a
 *      copy and reaches the live game only with a successful write. A failed save marks the game
 *      dirty, emits state:saveFailed and backs autosave off for CONFIG.SAVE.RETRY_MS.
 *    * pacing: scheduleSave({ lazy }) - read-only chat, clock ticks and mid-race changes wait
 *      CONFIG.SAVE.LAZY_MS (SD.state.saveHint), a mutation that changed nothing saves nothing.
 *    * one writer: spiritderby.lock { id, n, at, released? } names the window that saves. A second window
 *      that finds a live lock loads read-only (no recovery of the race it saw, no writes at all); a writer
 *      that finds another window's lock stops saving (state:readOnly). takeOver() / heartbeat(). On
 *      pagehide release() marks the lock released: a reload claims it back at once, a reader only after
 *      CONFIG.LOCK.RELEASE_GRACE_MS.
 *    * held saves: an unreadable, newer-schema or failed-upgrade save is left untouched in
 *      spiritderby.save (role 'held': nothing is written) until the streamer downloads it or starts a
 *      new game (releaseHeld), which first copies it to spiritderby.rescue (checked).
 *    * checked backups: writeBackup() reads the copy back; importJSON refuses when it cannot keep a
 *      backup of a non-blank game (opts.force overrides), never backs up a blank game over an existing
 *      backup, and rolls back (the game and the backup slot) when the imported game cannot be saved.
 *      restoreBackup() swaps back. discardRescue() deletes spiritderby.rescue.
 *  - Review batch 7 (import hardening): normalize() checks the race in progress in depth (recordProblem:
 *    a 'finished' race finishRace cannot apply is refunded like an interrupted one), bounds record
 *    distances, gives non-string runner ids a new id, and refunds bets / paid effects on runners that are
 *    gone or retired. importJSON() runs boot's post-load routine (SD.game.afterLoad: runtime maps reset,
 *    day event rolled) and applies a 'finished' race (SD.game.applyPending). bootRecovery() backs the
 *    boot error overlay's RESTORE BACKUP / START NEW GAME.
 *  - Review batch 11: recordProblem(record, true) also checks the record's events / ticks lists; a save
 *    that bootRecovery('backup') restored (marked in spiritderby.restored) never replaces a different
 *    rescue copy when it fails too (rescueHeld: inBackup).
 */
(function (SD) {
  'use strict';

  const KEY = 'spiritderby.save';
  const BACKUP_KEY = 'spiritderby.backup';
  const RESCUE_KEY = 'spiritderby.rescue';   // review batch 6: a save load() could not read, kept on START NEW GAME
  const LOCK_KEY = 'spiritderby.lock';       // review batch 6: { id, n, at } of the window that saves
  // Review batch 11 (R8 fix round): "<length>:<FNV-1a hash>" of the text bootRecovery('backup') put in
  // spiritderby.save, so the next rescue knows that save is the restored backup (see rescueHeld).
  const RESTORED_KEY = 'spiritderby.restored';
  // 3 (review batch 2): runner.ownerKey (owner's login key) + entrant.ownerKeyAtRace; see MIGRATIONS[3].
  // 4 (review batch 6): slim history records (betsSummary, slim, compacted chatEffects); see MIGRATIONS[4].
  const SCHEMA_VERSION = 4;

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
  function removeRaw(key) {
    try { getStore().removeItem(key); } catch (e) { /* ignore */ }
  }
  // Only a real localStorage is shared with other windows (the memory fallback is per page).
  function shared() { getStore(); return storeKind === 'localStorage'; }

  // ---------------------------------------------------------------------------
  // Save scheduling
  // ---------------------------------------------------------------------------
  let timer = null;
  let timerDue = 0;
  let dirty = false;
  let lastError = null;
  let lastSavedAt = null;
  let lastBytes = null;
  let lastFailAt = null;
  let lastTrimmed = null;
  let autoSave = true;
  let saveCount = 0;
  let lastRosterAdded = [];
  let backupLen = null;        // length of spiritderby.backup (null: not read yet)
  let rescueLen = null;        // length of spiritderby.rescue (null: not read yet)

  function hasTimers() {
    return !SD.isNode && typeof globalThis.setTimeout === 'function';
  }

  // Mark the game dirty and schedule an autosave. opts.lazy (read-only chat, clock ticks: see
  // SD.state.saveHint) and a race in progress wait CONFIG.SAVE.LAZY_MS instead of SAVE_DEBOUNCE_MS
  // (finishRace / abortRace save at once anyway); a pending later save is pulled forward, never pushed
  // back. After a failed save the next try waits CONFIG.SAVE.RETRY_MS. Node has no timers: a normal
  // save is written at once, a lazy one only marks the game dirty. Nothing is written in a window that
  // is not the writer (read-only / held), and nothing at all with setAutoSave(false).
  function scheduleSave(opts) {
    dirty = true;
    if (!autoSave || role !== 'writer') return;
    const lazy = !!(opts && opts.lazy);
    if (!hasTimers()) { if (!lazy) save(); return; }
    const S = SD.CONFIG.SAVE || {};
    const now = SD.clock.now();
    const raceOn = !!(SD.state && SD.state.isRaceLocked && SD.state.isRaceLocked());
    let delay = lazy || raceOn ? (Number(S.LAZY_MS) || 60000) : SD.CONFIG.SAVE_DEBOUNCE_MS;
    if (lastFailAt != null) delay = Math.max(delay, (Number(S.RETRY_MS) || 15000) - (now - lastFailAt));
    const due = now + delay;
    if (timer && timerDue <= due) return;
    cancelTimer();
    timerDue = due;
    timer = globalThis.setTimeout(function () { timer = null; save(); }, Math.max(0, delay));
  }

  function cancelTimer() {
    if (timer && typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(timer);
    timer = null;
    timerDue = 0;
  }

  // ---------------------------------------------------------------------------
  // One writer per storage (review batch 6)
  // ---------------------------------------------------------------------------
  // role: 'writer' (this window saves), 'reader' (another window saves this game: nothing is written
  // here) or 'held' (the stored save could not be loaded and is kept untouched until the streamer
  // chooses). roleInfo: { reason: 'other-window' | 'unreadable' | 'newer' | 'upgrade', message, otherAt }.
  let role = 'writer';
  let roleInfo = null;
  let instanceId = null;
  let lockN = 0;

  function myId() {
    if (!instanceId) {
      const e = SD.entropy ? SD.entropy.next() : null;
      instanceId = 'w' + ((e != null ? e : SD.rng.hash('instance:' + SD.clock.now())) >>> 0).toString(36);
    }
    return instanceId;
  }

  function readLock() {
    const raw = readRaw(LOCK_KEY);
    if (!raw) return null;
    try {
      const l = JSON.parse(raw);
      return isObj(l) && typeof l.id === 'string' ? l : null;
    } catch (e) { return null; }
  }
  function lockLive(l) {
    return !!l && isNum(l.at) && SD.clock.now() - l.at < ((SD.CONFIG.LOCK && SD.CONFIG.LOCK.STALE_MS) || 90000);
  }
  // Another window's lock that is live and not released: that window saves, this one must not.
  function lockHeldElsewhere(l) {
    return !!l && l.id !== myId() && lockLive(l) && l.released !== true;
  }
  // ms left before a released lock may be taken over by a reader (0: now). See release().
  function graceLeft(l) {
    if (!l || l.released !== true || !isNum(l.at)) return 0;
    const g = Number(SD.CONFIG.LOCK && SD.CONFIG.LOCK.RELEASE_GRACE_MS);
    return Math.max(0, (g >= 0 ? g : 8000) - (SD.clock.now() - l.at));
  }
  // Stamp the lock as this window's (every successful save and every heartbeat).
  function writeLock() {
    if (!shared()) return true;
    try {
      lockN++;
      writeRaw(LOCK_KEY, JSON.stringify({ id: myId(), n: lockN, at: SD.clock.now() }));
      return true;
    } catch (e) { return false; }
  }

  function setRole(next, info) {
    const was = role;
    role = next;
    roleInfo = next === 'writer' ? null : (info || roleInfo);
    if (next !== 'writer') cancelTimer();
    if (was !== next && SD.bus && SD.EVENTS.STATE_READ_ONLY) {
      try { SD.bus.emit(SD.EVENTS.STATE_READ_ONLY, lockStatus()); } catch (e) { /* never break a save */ }
    }
  }

  // Is this window still the one that saves? A lock written by another window means it took over:
  // this window stops saving (role 'reader') instead of overwriting the newer game.
  function stillWriter() {
    if (role !== 'writer') return false;
    if (!shared()) return true;
    const l = readLock();
    if (l && l.id !== myId()) {
      setRole('reader', {
        reason: 'other-window', otherAt: isNum(l.at) ? l.at : null,
        message: 'Another Spirit Derby window took over saving this game, so this window stopped saving. Changes made here are not kept.'
      });
      return false;
    }
    return true;
  }

  // -> { role, readOnly, reason, message, otherAt, free, freeIn } (free: a reader whose other window
  // is gone: its lock went stale, or it was released more than CONFIG.LOCK.RELEASE_GRACE_MS ago and
  // no window claimed it since, so takeOver() is safe. freeIn: ms until a released lock becomes free,
  // 0 otherwise; main.js checks again then).
  function lockStatus() {
    const out = { role: role, readOnly: role !== 'writer', reason: roleInfo ? roleInfo.reason : null, message: roleInfo ? roleInfo.message : null, otherAt: null, free: false, freeIn: 0 };
    if (role === 'reader') {
      const l = shared() ? readLock() : null;
      out.otherAt = l && isNum(l.at) ? l.at : (roleInfo && roleInfo.otherAt) || null;
      const wait = lockLive(l) && l.id !== myId() ? graceLeft(l) : 0;
      out.free = !l || l.id === myId() || !lockLive(l) || (l.released === true && wait === 0);
      out.freeIn = out.free ? 0 : wait;
    }
    return out;
  }

  // main.js calls this every CONFIG.LOCK.HEARTBEAT_MS and on 'storage' events. A writer checks the
  // lock (stepping down if another window took over) and refreshes it; a reader reports whether the
  // other window is gone (status.free), and main.js then takes over.
  function heartbeat() {
    if (role === 'writer' && stillWriter()) writeLock();
    return lockStatus();
  }

  // Become the writer: claim the lock and load the game from storage again (the other window's latest
  // save; a race it had running is treated as interrupted). Returns load()'s result, which the caller
  // adopts (SD.state.set + game.init). Not for a held save (see releaseHeld).
  function takeOver() {
    if (role === 'held') return { ok: false, error: 'The stored save could not be loaded here; download it or start a new game first.' };
    role = 'writer';
    roleInfo = null;
    writeLock();
    const res = load();
    if (SD.bus && SD.EVENTS.STATE_READ_ONLY) {
      try { SD.bus.emit(SD.EVENTS.STATE_READ_ONLY, lockStatus()); } catch (e) { /* ignore */ }
    }
    return Object.assign({ ok: role === 'writer' }, res);
  }

  // pagehide: mark this window's lock released ({ ..., released: true }), so the next window that
  // loads starts as the writer straight away - above all this same window reloading (F5, OBS refreshing
  // the source). A read-only window waits CONFIG.LOCK.RELEASE_GRACE_MS before it takes a released lock
  // (lockStatus().free), so the reload claims it first and the saving role stays where the streamer
  // left it. A crashed window's lock simply goes stale after CONFIG.LOCK.STALE_MS. Only this window's
  // own lock is released.
  function release() {
    if (role !== 'writer' || !shared()) return false;
    return releaseLock();
  }
  // Mark this window's own lock released (any role; bootRecovery uses it from a held window too).
  function releaseLock() {
    if (!shared()) return false;
    const l = readLock();
    if (l && l.id !== myId()) return false;
    try {
      lockN++;
      writeRaw(LOCK_KEY, JSON.stringify({ id: myId(), n: lockN, at: SD.clock.now(), released: true }));
    } catch (e) { removeRaw(LOCK_KEY); }
    return true;
  }

  // Automatic saves on/off (default on). Off: mutations only mark the game dirty; save() / flush()
  // still write. Returns the previous value.
  function setAutoSave(on) {
    const was = autoSave;
    autoSave = on !== false;
    if (!autoSave) cancelTimer();
    return was;
  }

  // The last records a size-budget trim keeps whole (fitBudget step 1).
  const BUDGET_FULL = 2;

  // Keep the last HISTORY_FULL_LOGS races whole and store every older one slim (slimRecord), drop
  // records beyond HISTORY_MAX, and drop inputs.raceEffects from every history record (a copy of the
  // queued effects the race used: only a race still in progress needs it, to re-queue them on an abort
  // or interruption). Mutates state in place.
  // Once a size-budget trim has slimmed records inside that window (fitBudget step 1: a slim record
  // among the last HISTORY_FULL_LOGS, older than the last BUDGET_FULL), only the last BUDGET_FULL stay
  // whole from then on. Letting the window grow back to full size would eat the headroom the trim made
  // (a whole 1600 m record is ~90K characters, a slim one ~11K) and trim again every few races.
  function trimHistory(st, keepFull) {
    if (!st || !Array.isArray(st.raceHistory)) return;
    const CFG = SD.CONFIG;
    const hist = st.raceHistory;
    if (hist.length > CFG.HISTORY_MAX) hist.splice(0, hist.length - CFG.HISTORY_MAX);
    let full = keepFull == null ? CFG.HISTORY_FULL_LOGS : keepFull;
    if (keepFull == null && full > BUDGET_FULL) {
      for (let i = Math.max(0, hist.length - full); i < hist.length - BUDGET_FULL; i++) {
        if (isObj(hist[i]) && hist[i].slim === true) { full = BUDGET_FULL; break; }
      }
    }
    for (let i = 0; i < hist.length; i++) {
      const rec = hist[i];
      if (!isObj(rec)) continue;
      if (isObj(rec.inputs) && rec.inputs.raceEffects !== undefined) delete rec.inputs.raceEffects;
      if (i < hist.length - full) slimRecord(rec);
    }
  }

  // The compact form of a past race (review batch 6; a finished race with 100 viewers betting and
  // cheering weighed ~39 KB and 200 of them overflowed the browser's storage quota). Idempotent;
  // rec.slim marks it. Kept: everything the history, season summary and replay read (entrants,
  // results, events, summary, seed, settingsSnapshot, hash). Changed:
  //   ticks                 [] (ticksStripped: true) - playback data, not needed to replay the hash
  //   inputs.chatEffects    SD.race.compactChatEffects: the same simulation (same hash), one merged
  //                         cheer entry per runner, no boost / sabotage the engine would skip
  //   bets                  the CONFIG.SAVE.BETS_KEPT biggest winning bets; when any are left out,
  //                         betsSummary { count, won, staked, paid } describes all of them
  //   events[].data.names   the first CONFIG.SAVE.NAMES_MAX cheering viewers (+ namesMore: the rest)
  function slimRecord(rec) {
    if (!isObj(rec)) return rec;
    if (Array.isArray(rec.ticks) && rec.ticks.length) {
      rec.ticks = [];
      rec.ticksStripped = true;
    }
    if (rec.slim === true) return rec;
    const S = SD.CONFIG.SAVE || {};
    if (isObj(rec.inputs) && Array.isArray(rec.inputs.chatEffects) && rec.inputs.chatEffects.length && SD.race && SD.race.compactChatEffects) {
      const ids = Array.isArray(rec.entrants) ? rec.entrants.map(function (e) { return e && e.runnerId; }) : null;
      rec.inputs.chatEffects = SD.race.compactChatEffects(rec.inputs.chatEffects, ids);
    }
    if (Array.isArray(rec.bets) && rec.bets.length) {
      const bets = rec.bets.filter(isObj);
      const kept = bets.filter(function (b) { return b.won; })
        .sort(function (a, b) { return (Number(b.payout) || 0) - (Number(a.payout) || 0); })
        .slice(0, Math.max(0, int(S.BETS_KEPT, 5, 0)));
      if (kept.length < rec.bets.length) {
        rec.betsSummary = {
          count: bets.length,
          won: bets.filter(function (b) { return b.won; }).length,
          staked: bets.reduce(function (a, b) { return a + (Number(b.amount) || 0); }, 0),
          paid: bets.reduce(function (a, b) { return a + (b.won ? Number(b.payout) || 0 : 0); }, 0)
        };
        rec.bets = kept;
      }
    }
    const maxNames = Math.max(0, int(S.NAMES_MAX, 5, 0));
    (Array.isArray(rec.events) ? rec.events : []).forEach(function (ev) {
      const d = ev && ev.data;
      if (!isObj(d) || !Array.isArray(d.names) || d.names.length <= maxNames) return;
      d.namesMore = (Number(d.namesMore) || 0) + d.names.length - maxNames;
      d.names = d.names.slice(0, maxNames);
    });
    rec.slim = true;
    return rec;
  }

  // Shrink st until its JSON is about `excess` characters smaller (review batch 6), cheapest loss first:
  //   1. every race but the last 2 (BUDGET_FULL) stored slim (tick logs are playback data; always done
  //      in full, and it sticks: trimHistory keeps only the last 2 whole from then on)
  //   2. the oldest race records dropped, down to CONFIG.SAVE.MIN_HISTORY
  //   3. the game log cut to its last 50 lines
  //   4. the oldest race records dropped, down to the last one (REPLAY LAST RACE still works)
  // Returns { races, logs, log } (records dropped, records slimmed, log lines cut). Players, runners,
  // balances, bets and the season are never touched. Mutates st.raceHistory / st.log and slims their
  // records in place; with opts.copy (save() on its working copy, see workingCopy) a record is cloned
  // before it is slimmed, so the objects the live game holds are left as they were.
  function fitBudget(st, excess, opts) {
    const out = { races: 0, logs: 0, log: 0 };
    const hist = Array.isArray(st.raceHistory) ? st.raceHistory : [];
    const size = function (x) { try { return JSON.stringify(x).length + 1; } catch (e) { return 0; } };
    if (!(excess > 0)) return out;
    for (let i = 0; i < hist.length - BUDGET_FULL; i++) {
      let rec = hist[i];
      if (!isObj(rec) || (rec.slim === true && !(rec.ticks && rec.ticks.length))) continue;
      const before = size(rec);
      if (opts && opts.copy) hist[i] = rec = JSON.parse(JSON.stringify(rec));
      slimRecord(rec);
      excess -= before - size(rec);
      out.logs++;
    }
    const dropTo = function (floor) {
      while (excess > 0 && hist.length > floor) {
        excess -= size(hist[0]);
        hist.shift();
        out.races++;
      }
    };
    dropTo(Math.max(1, int((SD.CONFIG.SAVE || {}).MIN_HISTORY, 20, 1)));
    if (excess > 0 && Array.isArray(st.log) && st.log.length > 50) {
      const cut = st.log.length - 50;
      excess -= size(st.log.slice(0, cut));
      st.log.splice(0, cut);
      out.log = cut;
    }
    dropTo(1);
    return out;
  }

  function emitSaved() {
    if (!SD.bus || !SD.EVENTS.STATE_SAVED) return;
    try { SD.bus.emit(SD.EVENTS.STATE_SAVED, { at: lastSavedAt, bytes: lastBytes, stats: stats(), trimmed: lastTrimmed }); } catch (e) { /* never break a save */ }
  }

  // What save() writes (review batch 5): the state without the debug seed override. A fixed seed
  // is a testing tool for this browser session only; saved, it came back on every reload and kept
  // replaying the same races on stream. Returns st itself when there is nothing to leave out.
  function forStorage(st) {
    if (!isObj(st.settings) || st.settings.seedOverride == null) return st;
    return Object.assign({}, st, { settings: Object.assign({}, st.settings, { seedOverride: null }) });
  }

  function addTrim(a, b) {
    if (!a) return b;
    return { races: a.races + b.races, logs: a.logs + b.logs, log: a.log + b.log };
  }

  // A trim that only dropped old race records and still left CONFIG.SAVE.ROUTINE_HISTORY of them is
  // routine (a long career at its steady size): an info log line, and main.js shows no toast
  // (trimmed.routine). Anything deeper is a warning.
  function isRoutine(st, t) {
    const min = int((SD.CONFIG.SAVE || {}).ROUTINE_HISTORY, 100, 0);
    return !t.log && Array.isArray(st.raceHistory) && st.raceHistory.length >= min;
  }

  // A log line written by save() itself into its working copy (SD.state.log would schedule another save
  // from inside this one). It reaches the live game, with a log:entry for the event log panel, only
  // when that save is written (adoptTrim).
  function saveLog(w, text, severity) {
    pushLog(w, 'system', text, severity || 'warn');
    if (!w.__newLogs) Object.defineProperty(w, '__newLogs', { value: [], enumerable: false }); // not saved
    w.__newLogs.push(w.log[w.log.length - 1]);
  }

  // What save() trims (fitBudget, saveLog) is a working copy of the live state (review batch 6, fix
  // round 2): its own raceHistory and log arrays, records cloned before they are slimmed. The live game
  // takes the trimmed history and log (adoptTrim) only once that copy is written; a save the browser
  // keeps refusing loses nothing in memory, so EXPORT JSON still has everything and a later save (once
  // storage accepts it again) writes the whole game rather than one shrunk by every failed attempt.
  function workingCopy(st) {
    return Object.assign({}, st, {
      raceHistory: Array.isArray(st.raceHistory) ? st.raceHistory.slice() : st.raceHistory,
      log: Array.isArray(st.log) ? st.log.slice() : st.log
    });
  }
  function adoptTrim(st, w) {
    const put = function (to, from) { to.length = 0; Array.prototype.push.apply(to, from); };
    if (Array.isArray(st.raceHistory) && Array.isArray(w.raceHistory)) put(st.raceHistory, w.raceHistory);
    if (Array.isArray(st.log) && Array.isArray(w.log)) put(st.log, w.log);
    else if (Array.isArray(w.log)) st.log = w.log.slice();
    (w.__newLogs || []).forEach(function (entry) {
      if (SD.bus && SD.state && SD.state.get() === st) {
        try { SD.bus.emit(SD.EVENTS.LOG_ENTRY, entry); } catch (e) { /* ignore */ }
      }
    });
  }

  // A write the browser refused for lack of room (worth retrying smaller). Any other error (security,
  // a broken storage backend) is not helped by dropping race records.
  function isQuotaError(e) {
    if (!e) return false;
    return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014;
  }
  function trimText(t) {
    const parts = [];
    if (t.races) parts.push('the oldest ' + t.races + ' race record' + (t.races === 1 ? ' was' : 's were') + ' dropped');
    if (t.log) parts.push(t.log + ' old log lines were cut');
    return 'The save was getting too big for browser storage, so ' + parts.join(' and ') + '. Players, runners and balances are untouched.';
  }

  // Write the current state now. Returns true on success. Review batch 6:
  //  - nothing is written unless this window is the writer (see stillWriter / role);
  //  - a JSON over CONFIG.SAVE.BUDGET_CHARS is shrunk first (fitBudget), and a write the browser
  //    refuses for lack of room (isQuotaError; any other error fails at once) is retried up to 3 times,
  //    shrinking by 10 %, 30 % and 60 %. The shrinking is done on a working copy (workingCopy) and the
  //    live game takes the trimmed history / log only when that copy was written (adoptTrim);
  //  - a failure keeps the game dirty (flush() / the next autosave try again, backing off
  //    CONFIG.SAVE.RETRY_MS) and emits state:saveFailed { at, error, bytes, stats }.
  function save() { return doSave(false); }
  function doSave(quiet) {
    const st = SD.state && SD.state.get();
    cancelTimer();
    if (!st) return false;
    if (!stillWriter()) { dirty = true; return false; }
    trimHistory(st);
    const budget = int((SD.CONFIG.SAVE || {}).BUDGET_CHARS, 2400000, 1000);
    let json = null, trimmed = null, err = null, w = st;
    try {
      json = JSON.stringify(forStorage(st));
      if (json.length > budget) {
        // Down to 90 % of the budget. The tick logs slimmed here stay slim (trimHistory), so the save
        // then grows by one slim record per race (~11K) and a long career trims about every 20 races.
        w = workingCopy(st);
        trimmed = fitBudget(w, json.length - Math.floor(budget * 0.9), { copy: true });
        trimmed.routine = isRoutine(w, trimmed);
        if (trimmed.races || trimmed.log) saveLog(w, trimText(trimmed), trimmed.routine ? 'info' : 'warn');
        json = JSON.stringify(forStorage(w));
      }
      writeRaw(KEY, json);
    } catch (e) {
      err = e;
      // Only a quota error is worth a smaller try. Each try shrinks the working copy further; none of
      // it reaches the live game unless a write succeeds (a failed save loses nothing in memory).
      const shrink = [0.1, 0.3, 0.6];
      const first = json ? json.length : 0;
      if (json && isQuotaError(e) && w === st) w = workingCopy(st);
      for (let k = 0; k < shrink.length && err && json && isQuotaError(err); k++) {
        try {
          const t = fitBudget(w, json.length - Math.floor(first * (1 - shrink[k])), { copy: true });
          trimmed = addTrim(trimmed, t);
          trimmed.routine = false;                     // the browser refused the write: always a warning
          if (t.races || t.log) saveLog(w, trimText(t));
          json = JSON.stringify(forStorage(w));
          writeRaw(KEY, json);
          err = null;
        } catch (e2) { err = e2; }
      }
    }
    if (err) return saveFailed(err, json, quiet);
    if (w !== st) adoptTrim(st, w);
    dirty = false;
    lastError = null;
    lastFailAt = null;
    lastTrimmed = trimmed;
    lastSavedAt = SD.clock.now();
    lastBytes = json.length;
    saveCount++;
    writeLock();
    emitSaved();
    return true;
  }

  function saveFailed(err, json, quiet) {
    lastError = err;
    dirty = true;
    lastFailAt = SD.clock.now();
    if (typeof console !== 'undefined' && console.warn) console.warn('[SD.persistence] save failed:', err);
    if (!quiet && SD.bus && SD.EVENTS.STATE_SAVE_FAILED) {
      try {
        SD.bus.emit(SD.EVENTS.STATE_SAVE_FAILED, { at: lastFailAt, error: String((err && err.message) || err), bytes: json ? json.length : null, stats: stats() });
      } catch (e) { /* never break a save */ }
    }
    // Try again by itself (after CONFIG.SAVE.RETRY_MS), even if nothing else changes meanwhile.
    if (autoSave && role === 'writer' && hasTimers()) scheduleSave();
    return false;
  }

  // Write a pending save right now (beforeunload / pagehide / tab hidden). Safe to call any time.
  function flush() {
    if (dirty || timer) return save();
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
    if (backupLen == null) { const b = readRaw(BACKUP_KEY); backupLen = b ? b.length : 0; }
    if (rescueLen == null) { const b = readRaw(RESCUE_KEY); rescueLen = b ? b.length : 0; }
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
      error: lastError ? String(lastError.message || lastError) : null,
      // review batch 6
      failedAt: lastError ? lastFailAt : null,
      role: role,
      readOnly: role !== 'writer',
      reason: roleInfo ? roleInfo.reason : null,
      backup: backupLen || 0,
      rescue: rescueLen || 0,
      budget: int((SD.CONFIG.SAVE || {}).BUDGET_CHARS, 2400000, 1000)
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
  // reset to their default. Unknown keys are kept (a newer build may know them), except keys named
  // like Object.prototype members (see below).
  function normalizeSettings(s, d) {
    const C = SD.CONFIG.RACE;
    // Own keys named like Object.prototype members ('toString', 'constructor', '__proto__' ...) are
    // never settings: builds before review batch 3 let updateSettings store them. They are dropped.
    Object.keys(s).forEach(function (k) { if (k in Object.prototype) delete s[k]; });
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

  // Review batch 7: a race distance a record may carry (the engine only runs CONFIG.RACE.DISTANCES;
  // a huge one hung the track ruler and REPLAY).
  function goodDistance(d) {
    const max = Number(SD.CONFIG.RACE.MAX_RECORD_DISTANCE) || 10000;
    return isNum(d) && d >= 100 && d <= max;
  }

  // A race record worth keeping (history). Review batch 7: entrants and results must be objects and
  // the distance bounded (goodDistance).
  function isValidRecord(rec) {
    return isObj(rec) && rec.id != null && Array.isArray(rec.entrants) && rec.entrants.length > 0 && Array.isArray(rec.results) &&
      rec.entrants.every(isObj) && rec.results.every(isObj) && goodDistance(rec.distance);
  }

  // Review batch 7 (persistence#4, ui-track#2): why a record cannot be the race in progress, or null
  // when it can. Stricter than isValidRecord: a string id, entrants with unique string runner ids and
  // integer lanes (the track and playback read them), a bounded distance. With `finished` (a race saved
  // as 'finished' that game.applyPending() will apply) also everything finishRace reads: a summary
  // object and non-empty results, each for an entrant, with numeric place / timeSec / xp / energyDelta /
  // fatigueDelta, statChanges only on known stats, and non-negative SP shares.
  // Review batch 11 (R6): also the lists finishRace's hooks iterate (achievements.checkRace): events
  // absent or a list of objects, and ticks absent or a list of objects whose pos (when a list) holds
  // objects. A record that passes can be applied without finishRace throwing half-way.
  function recordProblem(rec, finished) {
    if (!isValidRecord(rec)) return 'malformed race record';
    if (typeof rec.id !== 'string' || !rec.id) return 'bad race id';
    const maxLane = Math.max(Number(SD.CONFIG.RACE.MAX_RUNNERS) || 10, rec.entrants.length);
    const inRace = SD.util.dict();
    for (let i = 0; i < rec.entrants.length; i++) {
      const e = rec.entrants[i];
      if (typeof e.runnerId !== 'string' || !e.runnerId || inRace[e.runnerId]) return 'bad entrant runner id';
      inRace[e.runnerId] = true;
      if (!(Number.isInteger(e.lane) && e.lane >= 1 && e.lane <= maxLane)) return 'bad entrant lane';
    }
    if (!finished) return null;
    if (!isObj(rec.summary)) return 'no race summary';
    if (!rec.results.length) return 'no results';
    const STATS = SD.CONFIG.STATS;
    for (let i = 0; i < rec.results.length; i++) {
      const res = rec.results[i];
      if (typeof res.runnerId !== 'string' || !inRace[res.runnerId]) return 'bad result runner id';
      if (!['place', 'timeSec', 'xp', 'energyDelta', 'fatigueDelta'].every(function (k) { return isNum(res[k]); })) return 'bad result numbers';
      if (!(Number.isInteger(res.place) && res.place >= 1) || !(res.timeSec > 0) || !(res.xp >= 0)) return 'bad result numbers';
      if (!['spOwner', 'spBacker'].every(function (k) { return res[k] == null || (isNum(res[k]) && res[k] >= 0); })) return 'bad result SP';
      if (res.statChanges != null && !(isObj(res.statChanges) && Object.keys(res.statChanges).every(function (k) {
        return STATS.indexOf(k) >= 0 && isNum(res.statChanges[k]);
      }))) return 'bad result stat changes';
    }
    if (rec.events != null && !(Array.isArray(rec.events) && rec.events.every(isObj))) return 'bad race events';
    if (rec.ticks != null && !(Array.isArray(rec.ticks) && rec.ticks.every(function (t) {
      return isObj(t) && (!Array.isArray(t.pos) || t.pos.every(isObj));
    }))) return 'bad race ticks';
    return null;
  }

  // Credit SP back to a player of a state that is being normalized (not live yet: no bus events).
  // Like players.refundSp, the spend is reversed too. Returns the amount refunded.
  function refundRaw(st, username, amount) {
    const p = SD.util.own(st.players, String(username == null ? '' : username).toLowerCase());
    const amt = Math.floor(Number(amount) || 0);
    if (!isObj(p) || !(amt > 0)) return 0;
    p.spiritPoints = (Number(p.spiritPoints) || 0) + amt;
    if (isObj(p.stats) && isNum(p.stats.spSpentTotal)) p.stats.spSpentTotal = Math.max(0, p.stats.spSpentTotal - amt);
    return amt;
  }

  // Ids of the runners that can still race (not retired), as a dict.
  function liveIds(st) {
    const live = SD.util.dict();
    (Array.isArray(st.runners) ? st.runners : []).forEach(function (r) {
      if (isObj(r) && typeof r.id === 'string' && !r.retired) live[r.id] = true;
    });
    return live;
  }

  // Queued chat effects: well-formed ones on a runner that can still race are kept (count / paid
  // repaired). Review batch 7 (gap1#4): a paid boost / sabotage on a runner that is gone or retired
  // (a hand-edited import) can never be used, so its SP goes back to the viewer now instead of at the
  // end of the season, and it stops counting toward the per-race sabotage cap. -> the kept list
  function cleanEffects(st, list, live) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (!isObj(e) || typeof e.type !== 'string' || !/^(boost|sabotage|cheer)$/.test(e.type)) return;
      if (typeof e.runnerId !== 'string' || !live[e.runnerId]) {
        if (isNum(e.paid) && e.paid > 0 && e.by != null) refundRaw(st, e.by, e.paid);
        return;
      }
      if (!(isNum(e.count) && e.count >= 1)) e.count = 1;
      if (e.paid != null && !(isNum(e.paid) && e.paid >= 0)) e.paid = 0;
      out.push(e);
    });
    return out;
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
    const U = SD.util;
    const seenIds = U.dict();
    st.runners.forEach(function (r) {
      // Review batch 7 (runners-data#2): an id that is not a non-empty string (a number from a hand
      // edit or another tool) broke every runner lookup by name; it gets a new id like a duplicate.
      if (typeof r.id !== 'string' || r.id === '' || seenIds[r.id]) r.id = SD.runners ? SD.runners.nextId(st) : 'r' + (++M.runnerCounter);
      seenIds[r.id] = true;
    });
    // Review batch 7 (gap1#4): a retired runner (only a hand-edited import retires one) has no owner,
    // and nothing may point at it: player.runnerId / backing are cleared, its open bets and queued paid
    // effects refunded (below). Past races keep who owned it (entrant.ownerAtRace / ownerKeyAtRace).
    st.runners.forEach(function (r) {
      if (r.retired && (r.ownerKey || r.owner)) { r.ownerKey = null; r.owner = null; r.claimedAt = null; }
    });
    const live = liveIds(st);

    // players (keyed by username key). Keys come from the save ('constructor' / '__proto__' are
    // valid logins, and JSON.parse stores '__proto__' as an own key): own reads / writes only.
    const players = {};
    Object.keys(st.players).forEach(function (k) {
      const p = st.players[k];
      if (!isObj(p)) return;
      if (!p.username) p.username = k;
      if (SD.players && typeof SD.players.normalize === 'function') SD.players.normalize(p);
      const key = p.username || String(k).toLowerCase();
      if (!hasOwn(players, key)) U.setOwn(players, key, p);
    });
    if (Object.keys(players).length !== Object.keys(st.players).length ||
        Object.keys(players).some(function (k) { return U.own(st.players, k) !== players[k]; })) {
      st.players = players;
    }
    Object.keys(st.players).forEach(function (k) {
      const p = st.players[k];
      if (p.runnerId != null && !live[p.runnerId]) p.runnerId = null;
      if (p.backing && p.backing.runnerId != null && !live[p.backing.runnerId]) p.backing = { runnerId: null, actions: 0 };
    });
    resolveOwners(st);

    // open bets: well-formed, one per player (older duplicates are refunded), known player + runner.
    // Review batch 7: a bet on a runner that is gone or retired is refunded (it used to be dropped
    // with its stake; a retired runner never races, so the bet could never settle).
    const betBy = U.dict();
    const bets = [];
    st.bets.forEach(function (b) {
      if (!isObj(b) || !b.username || !(isNum(b.amount) && b.amount > 0) || !(isNum(b.odds) && b.odds > 0)) return;
      const p = U.own(st.players, String(b.username).toLowerCase());
      if (!isObj(p)) return;
      if (typeof b.runnerId !== 'string' || !live[b.runnerId]) { refundRaw(st, p.username, b.amount); return; }
      if (betBy[p.username]) {
        const old = betBy[p.username];
        refundRaw(st, p.username, old.amount);               // keep the newest bet, refund the older one
        bets.splice(bets.indexOf(old), 1);
      }
      betBy[p.username] = b;
      bets.push(b);
    });
    if (bets.length !== st.bets.length) st.bets = bets;

    // queued chat effects (cleanEffects: on a gone / retired runner, refunded and dropped)
    const effects = cleanEffects(st, st.raceEffects, live);
    if (effects.length !== st.raceEffects.length) st.raceEffects = effects;

    // race history + the race in progress
    st.raceHistory = st.raceHistory.filter(isValidRecord).length === st.raceHistory.length ? st.raceHistory : st.raceHistory.filter(isValidRecord);
    // A malformed race in progress becomes an interrupted one (recoverInterruptedRace, which runs
    // right after migrate(), refunds its bets and clears it); record:null never reaches the game.
    // Review batch 7 (persistence#4): the record is checked in depth (recordProblem). A race saved as
    // 'finished' is kept only when finishRace can apply it; otherwise it is refunded like any
    // interrupted race (it used to crash game.init() on every boot). `malformed` (the reason) is only
    // read by recoverInterruptedRace, which clears the race.
    const cr = st.currentRace;
    if (cr != null) {
      const shaped = isObj(cr) && /^(countdown|running|paused|finished)$/.test(cr.status);
      const problem = shaped ? recordProblem(cr.record, cr.status === 'finished') : 'malformed race';
      if (problem) {
        st.currentRace = {
          record: isObj(cr) && isValidRecord(cr.record) ? cr.record : null, status: 'running',
          startedAt: isObj(cr) ? num(cr.startedAt, 0, 0) : 0,
          malformed: (isObj(cr) && typeof cr.malformed === 'string' && cr.malformed) || problem
        };
      }
    }
    st.log = st.log.filter(isObj).length === st.log.length ? st.log : st.log.filter(isObj);
    if (st.log.length > SD.CONFIG.LOG_CAP) st.log.splice(0, st.log.length - SD.CONFIG.LOG_CAP);

    st.schemaVersion = SCHEMA_VERSION;
    return st;
  }

  // Runner ownership (schema 3). runner.ownerKey is the owner's login key and runner.owner only its
  // display label. Saves from before schema 3 stored the claimer's DISPLAY name in runner.owner, so a
  // viewer whose display name was not a case variant of their login (Twitch localized names, bridge
  // display names) never owned the runner they claimed, and each !claim locked another runner.
  // A runner with a label but no key is paired with a player like this:
  //   1. the player whose runnerId points at it, when the label is that player's login (any case)
  //      or display name - the runner that player really claimed last;
  //   2. else the player whose login the label is, when that player holds no other runner;
  //   3. else nobody can use it (old runnerOf() refused everyone): it is released.
  // Then every player.runnerId that does not point at a runner owned by that player is cleared, and
  // the race in progress gets entrant.ownerKeyAtRace (a 'finished' race is applied on boot).
  // Runners that already carry an ownerKey are kept as they are (export -> import stays lossless).
  let ownerRepair = { paired: 0, released: 0 };
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function resolveOwners(st) {
    const PL = SD.players;
    const keyOf = PL ? PL.keyOf : function (n) { return String(n == null ? '' : n).trim().replace(/^@+/, '').toLowerCase(); };
    const players = st.players;
    const player = function (k) { return k && hasOwn(players, k) ? players[k] : null; };
    const byId = SD.util.dict();
    st.runners.forEach(function (r) { byId[r.id] = r; });
    const holds = SD.util.dict();  // player key -> runner id it owns
    const legacy = [];
    st.runners.forEach(function (r) {
      if (r.ownerKey) {
        const k = keyOf(r.ownerKey);
        if (!k || (PL && PL.isReservedKey(k))) { r.ownerKey = null; r.owner = null; r.claimedAt = null; return; }
        r.ownerKey = k;
        if (!r.owner) r.owner = k;
        if (!holds[k]) holds[k] = r.id;
      } else if (r.owner) {
        legacy.push(r);
      } else {
        r.ownerKey = null;
      }
    });
    const pair = function (r, p) {
      r.ownerKey = p.username;
      r.owner = p.displayName || p.username;
      holds[p.username] = r.id;
      p.runnerId = r.id;
      ownerRepair.paired++;
    };
    const rest = legacy.filter(function (r) {
      const label = String(r.owner);
      const p = Object.keys(players).map(function (k) { return players[k]; }).filter(function (x) {
        return x && x.runnerId === r.id && !holds[x.username] && (keyOf(label) === x.username || (PL ? PL.cleanName(label) : label) === x.displayName);
      })[0];
      if (p) { pair(r, p); return false; }
      return true;
    });
    rest.forEach(function (r) {
      const p = player(keyOf(r.owner));
      if (p && !holds[p.username] && (p.runnerId == null || p.runnerId === r.id || !byId[p.runnerId])) { pair(r, p); return; }
      r.owner = null;
      r.ownerKey = null;
      r.claimedAt = null;
      ownerRepair.released++;
    });
    Object.keys(players).forEach(function (k) {
      const p = players[k];
      if (p.runnerId != null && !(byId[p.runnerId] && byId[p.runnerId].ownerKey === p.username)) p.runnerId = null;
    });
    // The race in progress (schema 3 entrants carry ownerKeyAtRace; stored history is left as it
    // is: its results are hashed, and readers fall back to the owner label for old records).
    const cr = st.currentRace;
    const ents = cr && isObj(cr.record) && Array.isArray(cr.record.entrants) ? cr.record.entrants : [];
    ents.forEach(function (e) {
      if (!isObj(e) || e.ownerKeyAtRace !== undefined) return;
      let k = null;
      if (e.ownerAtRace) {
        const r = byId[e.runnerId];
        const label = String(e.ownerAtRace);
        // Only the runner's own (just resolved) owner, or a login the label spells: a runner that was
        // released above paid nobody before and pays nobody now.
        if (r && r.ownerKey && (r.owner === label || keyOf(label) === r.ownerKey)) k = r.ownerKey;
        else if (player(keyOf(label))) k = keyOf(label);
      }
      e.ownerKeyAtRace = k;
    });
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
    },
    // v2 -> v3 (review batch 2): runner ownership keyed by login. normalize() -> resolveOwners()
    // backfills runner.ownerKey from the old display-name owner labels (and the race in progress's
    // entrant.ownerKeyAtRace); runners no player can own are released. The log line says how many.
    // Before schema 3 the streamer's console (roster TRAIN / REST, ADD HYPE) credited season hype to
    // the plain key 'streamer', which a console "!join" also made a player - so that credit could
    // win the season's Top hype card. It is dropped here (once, v2 -> v3 only): the console's share
    // cannot be told apart from a real viewer 'streamer', who loses at most this season's credit.
    // New credit under 'streamer' (the Twitch viewer; the console is '#streamer') is kept as usual.
    3: function (raw, ctx) {
      normalize(raw);
      if (hasOwn(raw.hype.contributions, 'streamer')) delete raw.hype.contributions.streamer;
      raw.meta.migratedFrom = ctx && ctx.from != null ? ctx.from : 2;
      raw.meta.migratedAt = SD.clock.now();
      pushLog(raw, 'system', 'Save upgraded to schema v3: runner owners are now keyed by login' +
        (ownerRepair.released ? '; ' + ownerRepair.released + ' runner' + (ownerRepair.released === 1 ? '' : 's') +
          ' held under a display name no viewer could use ' + (ownerRepair.released === 1 ? 'was' : 'were') + ' released' : '') + '.', 'info');
      return raw;
    },
    // v3 -> v4 (review batch 6): race records past the last HISTORY_FULL_LOGS are stored slim
    // (slimRecord: compacted chat effects, winning bets + betsSummary, capped cheer names) and no history
    // record keeps inputs.raceEffects. Results, events, hashes and replays are unchanged.
    4: function (raw, ctx) {
      normalize(raw);
      const before = raw.raceHistory.filter(function (r) { return r.slim === true; }).length;
      trimHistory(raw);
      const slimmed = raw.raceHistory.filter(function (r) { return r.slim === true; }).length - before;
      raw.meta.migratedFrom = ctx && ctx.from != null ? ctx.from : 3;
      raw.meta.migratedAt = SD.clock.now();
      pushLog(raw, 'system', 'Save upgraded to schema v4: older race records are stored in a compact form' +
        (slimmed ? ' (' + slimmed + ' record' + (slimmed === 1 ? '' : 's') + ')' : '') + ', so long careers fit in browser storage.', 'info');
      return raw;
    }
  };

  function migrate(raw) {
    ownerRepair = { paired: 0, released: 0 };
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
      const p = SD.util.own(st.players, String(b.username || '').toLowerCase());
      if (isObj(p) && b.amount > 0) { p.spiritPoints = (p.spiritPoints || 0) + b.amount; count++; }
    });
    st.bets = [];
    return count;
  }

  // A race that was mid-playback when the page closed cannot be resumed.
  function recoverInterruptedRace(st) {
    const cr = st.currentRace;
    if (!cr) return false;
    if (cr.status === 'finished' && cr.record) return false; // game.applyPending() applies it (boot, import)
    let refunded = 0;
    if (SD.betting && typeof SD.betting.refundAll === 'function') {
      const r = SD.betting.refundAll(st, 'interrupted');
      refunded = Array.isArray(r) ? r.length : (r || 0);
    } else {
      refunded = refundBetsRaw(st);
    }
    // Paid-for chat effects go back into the queue for the next race.
    // Review batch 7: the same checks as the queue itself (cleanEffects: a record read from a save is
    // not trusted; an effect on a runner that is gone or retired is refunded instead).
    const inputs = isObj(cr.record) && cr.record.inputs;
    if (isObj(inputs) && Array.isArray(inputs.raceEffects) && inputs.raceEffects.length) {
      st.raceEffects = cleanEffects(st, inputs.raceEffects, liveIds(st)).concat(Array.isArray(st.raceEffects) ? st.raceEffects : []);
    }
    const malformed = typeof cr.malformed === 'string' ? cr.malformed : null;
    st.currentRace = null;
    pushLog(st, 'race', (malformed
      ? 'The race saved in progress could not be used (' + malformed + '). It was cancelled'
      : 'The last race was interrupted (the page closed mid-race). It was cancelled') +
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

  // Returns { state, fromStorage, migratedFrom, rosterAdded, readOnly, held, error, backupFailed }.
  // Never throws. Review batch 6:
  //  - Another window holding a live lock (CONFIG.LOCK.STALE_MS) makes this one a reader: the game is
  //    loaded as stored - a race that window has running is NOT cancelled or refunded here - and this
  //    window writes nothing (readOnly: true).
  //  - A save that cannot be loaded (unreadable JSON, a newer schema, a failed upgrade) is no longer
  //    replaced by the fresh game's first autosave: it stays untouched in spiritderby.save (role 'held',
  //    held: true, error: why) until the streamer downloads it or starts a new game (releaseHeld).
  //  - The pre-upgrade backup write is checked (backupFailed: true when there was no room for it).
  function load() {
    const raw = readRaw(KEY);
    const l = shared() ? readLock() : null;
    if (lockHeldElsewhere(l)) {
      setRole('reader', {
        reason: 'other-window', otherAt: l.at,
        message: 'Another Spirit Derby window is already running this game and saving it. This window only shows it: nothing here is saved.'
      });
    } else {
      setRole('writer');
      writeLock();
    }
    const reading = role === 'reader';
    const base = { fromStorage: false, migratedFrom: null, rosterAdded: [], readOnly: reading, held: false, error: null, backupFailed: false };
    if (!raw) return Object.assign(base, { state: fresh() });
    const hold = function (reason, error) {
      if (!reading) setRole('held', { reason: reason, message: error });
      return Object.assign(base, {
        held: !reading, error: error,
        state: fresh(error + (reading ? ' (The other window has it open.)'
          : ' Your saved game was left untouched: this window saves nothing until you download it or start a new game (see the banner).'))
      });
    };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return hold('unreadable', 'The saved game in this browser is unreadable (not valid JSON).');
    }
    const v = validate(parsed);
    if (!v.ok) return hold(Number(parsed && parsed.schemaVersion) > SCHEMA_VERSION ? 'newer' : 'unreadable', v.error);
    let backupFailed = false;
    if (v.version < SCHEMA_VERSION && !reading) backupFailed = !writeBackup(raw);
    let st;
    try {
      st = migrate(parsed);
    } catch (e) {
      return hold('upgrade', 'The saved game could not be upgraded (' + e.message + ').');
    }
    const rosterAdded = lastRosterAdded.slice();
    if (!reading) recoverInterruptedRace(st);
    freshSeeds(st, 'load');
    if (backupFailed) {
      pushLog(st, 'system', 'There was no room in browser storage to keep a backup of the save from before this upgrade. EXPORT JSON keeps a copy.', 'warn');
    }
    return Object.assign(base, { state: st, fromStorage: true, migratedFrom: v.version < SCHEMA_VERSION ? v.version : null, rosterAdded: rosterAdded, backupFailed: backupFailed });
  }

  // Copy text to spiritderby.backup and read it back (review batch 6: a backup the browser refused used
  // to be ignored silently, while the log and the admin drawer said a backup was kept). If the write is
  // refused the previous backup stays as it was.
  function writeBackup(text) {
    try { writeRaw(BACKUP_KEY, text); } catch (e) { return false; }
    const ok = readRaw(BACKUP_KEY) === text;
    backupLen = null;
    return ok;
  }

  // A game nobody has played yet (no race run, no viewer joined): not worth a backup, and never
  // written over an existing one.
  function isBlank(st) {
    return !isObj(st) || (!(isObj(st.meta) && Number(st.meta.raceCounter) > 0) && !(isObj(st.players) && Object.keys(st.players).length));
  }

  // Fingerprint of a save text for spiritderby.restored (length + FNV-1a; compared together with the
  // full text of spiritderby.backup, so a collision alone never matches).
  function fingerprint(text) {
    return String(text).length + ':' + SD.rng.hash(text);
  }

  // Held save (role 'held'): copy the stored text to spiritderby.rescue and check it. Without room for
  // the copy it refuses, unless force (the streamer downloaded it, or chose to lose it).
  // Review batch 11 (R8, fix round): a stored save that the boot error overlay's RESTORE BACKUP put there
  // (spiritderby.restored holds its fingerprint) and that is still the very text of spiritderby.backup
  // failed too: it is kept in the backup, so it does not replace a different rescue copy - that one is
  // the newer game the first recovery kept. Only that marker counts: a save that merely equals the
  // backup (load() backs up every save before upgrading it) is copied to the rescue slot as always.
  // The marker is used up here either way. -> { ok, rescued, inBackup? }
  function rescueHeld(force) {
    const raw = readRaw(KEY);
    const marker = readRaw(RESTORED_KEY);
    if (marker != null) removeRaw(RESTORED_KEY);
    if (!raw) return { ok: true, rescued: false };
    if (marker === fingerprint(raw) && raw === readRaw(BACKUP_KEY)) {
      const prev = readRaw(RESCUE_KEY);
      if (prev && prev !== raw) return { ok: true, rescued: false, inBackup: true };
    }
    let ok = false;
    try { writeRaw(RESCUE_KEY, raw); ok = readRaw(RESCUE_KEY) === raw; } catch (e) { ok = false; }
    rescueLen = null;
    if (!ok && !force) {
      return { ok: false, rescueFailed: true, error: 'There is no room in this browser to keep a copy of the saved game that could not be loaded. Download it first, then try again.' };
    }
    return { ok: true, rescued: ok };
  }

  // START NEW GAME from the held-save banner: the stored save is copied to spiritderby.rescue (checked;
  // refused without room unless opts.force), then this window becomes the writer and saves the game it
  // is running. -> { ok, rescued, inBackup?, saved } | { ok:false, rescueFailed, error }
  function releaseHeld(opts) {
    if (role !== 'held') return { ok: true, rescued: false, saved: false };
    const r = rescueHeld(!!(opts && opts.force));
    if (!r.ok) return r;
    setRole('writer');
    writeLock();
    return r.inBackup ? { ok: true, rescued: false, inBackup: true, saved: save() } : { ok: true, rescued: r.rescued, saved: save() };
  }

  // The text of the save this window is holding untouched (role 'held'), for DOWNLOAD; else null.
  function heldText() { return role === 'held' ? readRaw(KEY) : null; }

  // Review batch 5, on every load and import: new entropy in the seed salt (SD.state.resalt; a no-op
  // without an SD.entropy source), so a save that was rolled back - an older export imported, a
  // stale second window, a reload after failed autosaves - never replays races or rolls the audience
  // already saw. Past RaceRecords keep their own seeds, so they still replay exactly. A debug seed
  // override stored by an older build (v1.0.0 saved it) is dropped, with a log line.
  function freshSeeds(st, tag) {
    SD.state.resalt(st, tag);
    if (isObj(st.settings) && st.settings.seedOverride != null) {
      pushLog(st, 'system', 'The debug seed override (' + st.settings.seedOverride + ') was cleared: a fixed seed only lasts until the page reloads.', 'warn');
      st.settings.seedOverride = null;
    }
  }

  // The bridge URL is exported with any relay token hidden (?token=…): an import never applies it
  // (see keepLocalConnections), and a shared export must not leak the streamer's relay token.
  // Review batch 5: an export never carries meta.seedSalt (the secret every upcoming race seed is
  // drawn from; importJSON gives the game a new one) or the debug seed override, so sharing an
  // export (a bug report, a backup posted in Discord) reveals nothing about future races.
  function exportJSON() {
    const st = SD.state && SD.state.get();
    if (!st) return '';
    const out = Object.assign({}, forStorage(st));
    if (isObj(st.meta)) {
      out.meta = Object.assign({}, st.meta);
      delete out.meta.seedSalt;
    }
    const br = isObj(out.settings) && isObj(out.settings.bridge) ? out.settings.bridge : null;
    if (br && typeof br.url === 'string') {
      const url = SD.util.redactSecrets(br.url);
      if (url !== br.url) out.settings = Object.assign({}, out.settings, { bridge: Object.assign({}, br, { url: url }) });
    }
    return JSON.stringify(out);
  }

  // Suggested download name, e.g. spirit-derby-s1-d3.json
  function exportFilename() {
    const st = SD.state && SD.state.get();
    if (!st) return 'spirit-derby.json';
    return 'spirit-derby-s' + st.season.number + '-d' + st.season.day + '.json';
  }

  // Replace the whole game with an exported save.
  // -> { ok:true, migratedFrom, ignoredConnection, backedUp, pendingRace: 'applied' | 'cancelled' | null }
  //  | { ok:false, error, readOnly? | backupFailed? | rescueFailed? | saveFailed? }
  // Review batch 6: nothing changes unless all of this works -
  //  - this window is the writer (a read-only window refuses: readOnly);
  //  - a non-blank current game was copied to spiritderby.backup and read back (backupFailed without
  //    room; opts.force imports anyway, e.g. after the admin drawer downloaded the current game). A
  //    blank current game is not backed up, so it never replaces an existing backup;
  //  - a held save (role 'held') was copied to spiritderby.rescue first (rescueFailed; opts.force);
  //  - the imported game was saved. If the browser refuses it, the current game is kept and
  //    spiritderby.backup is put back as it was (saveFailed);
  //  - checked first: a writer another window just took over from refuses (readOnly) before any write.
  // opts.restore: the file is spiritderby.backup (RESTORE BACKUP): logged as 'Backup restored.'.
  function importJSON(text, opts) {
    opts = opts || {};
    // stillWriter(): a window another one just took over from (TAKE OVER, before its 'storage' event
    // ran) must not write the backup slot either - it now belongs to the other window's game.
    if (role === 'reader' || (role === 'writer' && !stillWriter())) return readOnlyRefusal();
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
    const cur = SD.state.get();
    const wasHeld = role === 'held';
    const heldInfo = roleInfo;
    let backedUp = false;
    // The backup slot as it was: if the imported game then cannot be saved, the slot is put back, so a
    // failed import or RESTORE BACKUP never costs the game that was in it (review batch 6 fix round).
    let oldBackup = null, backupTried = false;
    if (wasHeld) {
      // The current game is the fresh one started over a save this build could not load: that save is
      // what must survive (spiritderby.rescue), not the fresh game.
      const r = rescueHeld(!!opts.force);
      if (!r.ok) return r;
    } else if (cur && !isBlank(cur)) {
      oldBackup = readRaw(BACKUP_KEY);
      backupTried = true;
      backedUp = writeBackup(JSON.stringify(cur));
      if (!backedUp && !opts.force) {
        return {
          ok: false, backupFailed: true,
          error: 'There is no room in this browser to keep a backup of the current game, so nothing was imported. EXPORT JSON it first (or import with force).'
        };
      }
    }
    const ignoredConnection = keepLocalConnections(st, cur, parsed);
    recoverInterruptedRace(st);
    freshSeeds(st, 'import');
    pushLog(st, 'system', opts.restore ? 'Backup restored.' : 'Save imported.', 'info');
    if (wasHeld) { setRole('writer'); writeLock(); }
    SD.state.set(st);
    if (!doSave(true)) {
      const lostRole = role === 'reader';
      const why = String((lastError && lastError.message) || lastError || 'storage refused it');
      SD.state.set(cur);
      if (wasHeld) setRole('held', heldInfo);
      const kept = backupTried ? putBackupBack(oldBackup) : true;
      if (lostRole) return readOnlyRefusal();
      return {
        ok: false, saveFailed: true,
        error: 'The imported game could not be saved (' + why + '), so the current game was kept' +
          (kept ? '.' : ', but the backup slot could not be put back: EXPORT JSON the current game.')
      };
    }
    const migratedFrom = v.version < SCHEMA_VERSION ? v.version : null;
    // Review batch 7 (lifecycle-concurrency#7, director-state#3): the post-load routine boot runs
    // (SD.game.afterLoad): the old game's runtime maps are cleared, a missing day event is rolled, and
    // after state:loaded (the panels show the new game) a race saved as 'finished' is applied - it used
    // to sit in currentRace until a reload, with START refused and the drawer's controls locked.
    const post = function (fn) {
      try { return fn(); } catch (e) {
        if (typeof console !== 'undefined' && console.error) console.error('[SD.persistence] post-import step failed:', e);
        return null;
      }
    };
    if (SD.game && typeof SD.game.afterLoad === 'function') post(function () { return SD.game.afterLoad({ resetRuntime: true, deferPending: true }); });
    else if (typeof SD.state.resetRuntime === 'function') SD.state.resetRuntime();
    if (SD.bus) {
      SD.bus.emit(SD.EVENTS.STATE_LOADED, { source: opts.restore ? 'restore' : 'import', migratedFrom: migratedFrom });
      SD.bus.emit(SD.EVENTS.STATE_CHANGED, { label: 'import' });
    }
    const pending = SD.game && typeof SD.game.applyPending === 'function' ? post(SD.game.applyPending) : null;
    return {
      ok: true, migratedFrom: migratedFrom, ignoredConnection: ignoredConnection, backedUp: backedUp,
      pendingRace: pending ? (pending.applied ? 'applied' : 'cancelled') : null
    };
  }

  function readOnlyRefusal() {
    return { ok: false, readOnly: true, error: 'This window is read-only (another window is saving this game). Import there, or TAKE OVER first.' };
  }

  // After a failed import: spiritderby.backup gets its previous text back (or is removed when there was
  // none). Returns false when the browser refused that write.
  function putBackupBack(text) {
    backupLen = null;
    if (readRaw(BACKUP_KEY) === text) return true;
    if (text == null) { removeRaw(BACKUP_KEY); return readRaw(BACKUP_KEY) == null; }
    return writeBackup(text);
  }

  // RESTORE BACKUP (admin Save section): import spiritderby.backup. The game it replaces becomes the
  // new backup (unless it is blank), so a restore can itself be undone.
  function restoreBackup(opts) {
    const text = readRaw(BACKUP_KEY);
    if (!text) return { ok: false, error: 'There is no backup in this browser yet.' };
    return importJSON(text, Object.assign({}, opts || {}, { restore: true }));
  }

  // settings.twitch / settings.bridge are per-install: an imported file never brings its own
  // Twitch channel, bridge URL or auto-connect flags (a shared save could otherwise make this PC
  // connect to someone else's relay, which is trusted with isMod, on the next load). This PC's
  // current values are kept (the defaults - off - when there is no current game).
  // Returns true only when the FILE itself (raw, before migration fills in defaults) carried a
  // connection value that differs from the kept one and is not just the default: an M1 file with
  // no twitch / bridge keys, a fresh install's export (default values) or your own export (token
  // hidden by exportJSON) reports nothing ignored.
  function keepLocalConnections(st, cur, raw) {
    const defaults = SD.state.create({ roster: false }).settings;
    const local = cur && isObj(cur.settings) ? cur.settings : defaults;
    const theirs = isObj(raw) && isObj(raw.settings) ? raw.settings : {};
    const same = function (a, b) {
      return typeof a === 'string' && typeof b === 'string' ? SD.util.redactSecrets(a) === SD.util.redactSecrets(b) : a === b;
    };
    let differs = false;
    ['twitch', 'bridge'].forEach(function (k) {
      const keep = SD.util.deepClone(isObj(local[k]) ? local[k] : defaults[k]);
      if (isObj(theirs[k])) {
        Object.keys(defaults[k]).forEach(function (f) {
          const v = theirs[k][f];
          if (v === undefined || same(v, keep[f]) || same(v, defaults[k][f])) return;
          differs = true;
        });
      }
      st.settings[k] = keep;
    });
    return differs;
  }

  // Review batch 8 (ui-admin-chat-dom#1): RESET ALL (SD.game.resetAll) first copies the game it is about
  // to wipe to spiritderby.backup and reads it back, like an import does, so RESTORE BACKUP can undo a
  // mistaken reset. A blank game (no race run, no viewer) is not backed up, so it never replaces an
  // existing backup; a window that is not the writer copies nothing. -> true when a backup was written.
  function backupCurrent() {
    if (role !== 'writer' || !stillWriter()) return false;
    const cur = SD.state && SD.state.get();
    if (!cur || isBlank(cur)) return false;
    return writeBackup(JSON.stringify(cur));
  }

  // RESET ALL: forget the stored game. Review batch 6: refused (false) in a read-only window (that is
  // another window's game) and while a save is held (it would be lost without a copy).
  function clear() {
    if (role !== 'writer') return false;
    cancelTimer();
    dirty = false;
    lastBytes = null;
    removeRaw(KEY);
    return true;
  }

  function readBackup() { return readRaw(BACKUP_KEY); }
  function readRescue() { return readRaw(RESCUE_KEY); }
  // DELETE RESCUE COPY (admin Save section, after downloading it): spiritderby.rescue shares the
  // browser's storage quota with the save and its backup, so it should not stay forever. Refused (false)
  // in a read-only window. Returns true when there is no rescue copy afterwards.
  function discardRescue() {
    if (role === 'reader') return false;
    removeRaw(RESCUE_KEY);
    rescueLen = null;
    return readRaw(RESCUE_KEY) == null;
  }
  function storageKind() { getStore(); return storeKind; }

  // Review batch 7: the recovery buttons main.js shows when boot fails (a stored save that loads but
  // breaks the game, so the page would fail the same way on every reload).
  //   'fresh'  - START NEW GAME: the stored save is copied to spiritderby.rescue (checked; refused
  //              without room unless opts.force) and removed, so the next load starts a new game;
  //   'backup' - RESTORE BACKUP: the same, then spiritderby.backup (the game before the last import or
  //              upgrade) becomes the stored save.
  // Afterwards this window writes nothing more (a later flush would put the broken game back) and its
  // lock is released, so the reload the caller does next saves straight away. Refused in a read-only
  // window (the save belongs to the other one). -> { ok, rescued, inBackup? } | { ok:false, error, rescueFailed? }
  // Review batch 11 (R8): 'backup' marks the restored save (spiritderby.restored); if that save fails too,
  // the next recovery keeps an existing, different rescue copy (inBackup: true, see rescueHeld), so
  // RESTORE BACKUP then START NEW GAME never loses the newer game.
  function bootRecovery(action, opts) {
    if (role === 'reader') return readOnlyRefusal();
    if (action !== 'fresh' && action !== 'backup') return { ok: false, error: 'Unknown recovery action "' + action + '".' };
    const backup = action === 'backup' ? readRaw(BACKUP_KEY) : null;
    if (action === 'backup' && !backup) return { ok: false, error: 'There is no backup in this browser.' };
    const r = rescueHeld(!!(opts && opts.force));
    if (!r.ok) return r;
    try {
      if (backup) writeRaw(KEY, backup);
      else removeRaw(KEY);
    } catch (e) {
      return { ok: false, error: 'Browser storage refused the change (' + String((e && e.message) || e) + ').' };
    }
    if (backup) {
      try { writeRaw(RESTORED_KEY, fingerprint(backup)); } catch (e) { /* no room: the next rescue copies it, as before */ }
    }
    releaseLock();
    cancelTimer();
    dirty = false;
    lastBytes = null;
    role = 'held';
    roleInfo = { reason: 'recovery', message: 'The page is reloading after a failed start.' };
    return r.inBackup ? { ok: true, rescued: false, inBackup: true } : { ok: true, rescued: r.rescued };
  }

  SD.persistence = {
    KEY: KEY,
    BACKUP_KEY: BACKUP_KEY,
    RESCUE_KEY: RESCUE_KEY,
    RESTORED_KEY: RESTORED_KEY,
    LOCK_KEY: LOCK_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MIGRATIONS: MIGRATIONS,
    load: load,
    save: save,
    backupCurrent: backupCurrent,
    scheduleSave: scheduleSave,
    flush: flush,
    setAutoSave: setAutoSave,
    stats: stats,
    exportJSON: exportJSON,
    exportFilename: exportFilename,
    importJSON: importJSON,
    restoreBackup: restoreBackup,
    clear: clear,
    migrate: migrate,
    normalize: normalize,
    reconcileRoster: reconcileRoster,
    validate: validate,
    trimHistory: trimHistory,
    slimRecord: slimRecord,
    fitBudget: fitBudget,
    recoverInterruptedRace: recoverInterruptedRace,
    // review batch 7
    isValidRecord: isValidRecord,
    recordProblem: recordProblem,
    bootRecovery: bootRecovery,
    readBackup: readBackup,
    readRescue: readRescue,
    discardRescue: discardRescue,
    readRaw: readRaw,
    storageKind: storageKind,
    // review batch 6: one writer per storage, held saves
    role: function () { return role; },
    lockStatus: lockStatus,
    heartbeat: heartbeat,
    takeOver: takeOver,
    release: release,
    releaseHeld: releaseHeld,
    heldText: heldText,
    instanceId: myId,
    _setInstanceId: function (id) { instanceId = String(id); },
    lastError: function () { return lastError; },
    lastSavedAt: function () { return lastSavedAt; },
    _memoryStore: memoryStore
  };
})(globalThis.SD = globalThis.SD || {});
