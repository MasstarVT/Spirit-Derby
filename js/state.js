/*
 * Spirit Derby - state.js
 * The single JSON-serialisable game state plus selectors.
 *  - create()  builds a fresh state (10 roster runners, default settings, season 1 day 1)
 *  - mutate()  is the only sanctioned way to change state: it bumps updatedAt, schedules
 *              a save and emits state:changed once (outermost call only).
 *  - runtime   holds non-persisted data (cooldowns, chat feed, connection status).
 */
(function (SD) {
  'use strict';

  const U = SD.util;
  let current = null;
  let depth = 0; // nesting level of mutate()

  // Non-persisted runtime data. Survives state.set() (it is about this browser session).
  // Maps keyed by login or id have no prototype (SD.util.dict); readers still use own reads.
  const runtime = {
    cooldowns: U.dict(),        // username -> { cmd: timestampMs }
    activity: U.dict(),         // username -> last read-only command that counted toward stats.commands
    runnerCooldowns: U.dict(),  // runnerId -> { rest: timestampMs }
    chatFeed: [],
    connected: { twitch: 'off', bridge: 'off' },
    lastClockAt: null,    // last game.tickClock() timestamp
    hypeIdleAccumMs: 0    // hype idle-decay accumulator
  };

  function defaultSettings() {
    return {
      distance: 1200,
      runnerCount: 4,
      eventFrequency: 'normal',     // none | low | normal | high | chaos
      hypeMultiplier: 1,
      playbackSpeed: 1,
      finalStretchSpeedup: 1.25,
      userCooldownS: SD.CONFIG.COOLDOWNS.USER_S,
      openTraining: true,
      allowCreate: true,
      autoAdvanceDay: true,
      debug: false,
      seedOverride: null,           // debug: fixed race seed (uint32) or null
      overlay: false,
      resultsAutoCloseMs: SD.CONFIG.UI.RESULTS_AUTO_CLOSE_MS, // results modal auto-close (0 = never)
      twitch: { channel: '', enabled: false },
      bridge: { url: 'ws://localhost:8765', enabled: false }
    };
  }

  // Fresh game state. opts: { seedSalt, settings, roster:false, dayEventId }
  function create(opts) {
    opts = opts || {};
    const CFG = SD.CONFIG;
    const now = SD.clock.now();
    // Review batch 5: the salt comes from SD.entropy (crypto in the browser) when a source is
    // installed; only Node / the tests (no source) fall back to the old creation-time hash.
    let salt;
    if (opts.seedSalt != null) salt = Number(opts.seedSalt) >>> 0;
    else {
      const e = SD.entropy ? SD.entropy.next() : null;
      salt = e != null ? e : SD.rng.hash('spirit-derby:' + now);
    }
    const st = {
      schemaVersion: SD.persistence ? SD.persistence.SCHEMA_VERSION : 1,
      meta: { createdAt: now, updatedAt: now, raceCounter: 0, seedSalt: salt, runnerCounter: 0, actionCounter: 0, betCounter: 0 },
      season: {
        number: 1, day: 1, daysPerSeason: CFG.SEASON.DAYS, racesPerDay: CFG.SEASON.RACES_PER_DAY,
        raceIndexInDay: 0, racesRun: 0, startedAt: now, activeDayEvent: null, history: []
      },
      hype: { value: 0, max: CFG.HYPE.MAX, thresholdsHit: [], contributions: {}, lastChangedAt: now },
      runners: [],
      players: {},
      bets: [],
      raceEffects: [],
      currentRace: null,
      raceHistory: [],
      settings: defaultSettings(),
      achievements: { unlocked: [], progress: {} }, // progress[username] = counters for count-based achievements (M5)
      log: []
    };
    if (opts.settings && typeof opts.settings === 'object') Object.assign(st.settings, opts.settings);

    if (opts.roster !== false && SD.runners && SD.DATA) {
      SD.DATA.ROSTER.forEach(function (entry, i) { st.runners.push(SD.runners.spawnFromRoster(entry, i)); });
      st.meta.runnerCounter = st.runners.length;
    }
    // Day 1 gets a day event straight away so the header has something to show.
    if (SD.events) {
      const ev = opts.dayEventId ? SD.events.dayEventById(opts.dayEventId)
        : SD.events.rollDayEvent(SD.rng.create(SD.rng.seedFrom(salt, 'day', 1, 1)));
      st.season.activeDayEvent = ev ? ev.id : null;
    }
    return st;
  }

  // Review batch 5: mix a fresh SD.entropy value into st.meta.seedSalt so every later race seed
  // (and the next paddock) is independent of anything seen or saved before: called by
  // persistence.load / importJSON (a rolled-back save cannot replay races the audience watched)
  // and by game.startRace (one race's seed, e.g. in a pasted COPY LAST RACE JSON, says nothing
  // about the next). new = (seedFrom(old, 'resalt', tag) + entropy) >>> 0, uniform when the
  // entropy is. Without an entropy source (Node / tests) nothing changes and it returns false.
  function resalt(st, tag) {
    if (!st || !st.meta || !SD.entropy) return false;
    const e = SD.entropy.next();
    if (e == null) return false;
    st.meta.seedSalt = (SD.rng.seedFrom(Number(st.meta.seedSalt) >>> 0, 'resalt', tag == null ? '' : tag) + e) >>> 0;
    return true;
  }

  function get() { return current; }

  // Replace the whole game. Review batch 7 (director-state#8): the mutate depth is left alone. It
  // used to be reset to 0, so a set() inside a mutation (a listener running resetAll / importJSON)
  // left it at -1 after the outer mutate's finally, and from then on no mutation ever reached depth 0
  // again: no state:changed, no updatedAt, no autosave. A set() inside a mutate now simply takes
  // effect when that mutate ends (its state:changed / save apply to the new state).
  function set(st) {
    current = st;
    return current;
  }

  // Review batch 7 (director-state#3): forget every per-game runtime map. The runtime outlives
  // state.set(), and runner ids restart at r01 in every game, so RESET ALL and IMPORT / RESTORE BACKUP
  // clear what belonged to the old game: command cooldowns, read-only activity, runner rest cooldowns,
  // nervous-cheer counts, recent hype contributors, the running command, the idle-decay accumulator
  // and the clock baseline. The chat feed and the connection status are about this browser session
  // and are kept.
  function resetRuntime() {
    runtime.cooldowns = U.dict();
    runtime.activity = U.dict();
    runtime.runnerCooldowns = U.dict();
    runtime.nervousCheers = U.dict();
    runtime.hypeRecent = U.dict();
    runtime.activeCommand = null;
    runtime.hypeIdleAccumMs = 0;
    runtime.lastClockAt = SD.clock.now();
    return runtime;
  }

  // Run fn(state). Emits state:changed once for the outermost call. If fn throws,
  // nothing is emitted and the error propagates (callers use check-then-commit).
  // Review batch 6: code inside the mutation may call saveHint('lazy' | 'none') to say how much it
  // changed: 'lazy' (only lastSeen / counters, a clock tick) saves within CONFIG.SAVE.LAZY_MS instead
  // of the 500 ms debounce; 'none' (nothing changed) saves nothing and emits no state:changed.
  let hint = null;
  function mutate(label, fn) {
    if (!current) throw new Error('SD.state.mutate("' + label + '") called before SD.state.set()');
    if (depth === 0) hint = null;
    depth++;
    let result;
    try {
      result = fn(current);
    } finally {
      depth--;
    }
    if (depth === 0) {
      const mode = hint;
      hint = null;
      if (mode === 'none') return result;
      current.meta.updatedAt = SD.clock.now();
      if (SD.persistence && typeof SD.persistence.scheduleSave === 'function') SD.persistence.scheduleSave(mode === 'lazy' ? { lazy: true } : undefined);
      if (SD.bus) SD.bus.emit(SD.EVENTS.STATE_CHANGED, { label: label });
    }
    return result;
  }

  // Inside mutate(): how this mutation should be saved ('lazy' | 'none'; see mutate). The last call of
  // the outermost mutation wins; outside a mutation it does nothing.
  function saveHint(mode) {
    if (depth > 0 && (mode === 'lazy' || mode === 'none' || mode == null)) hint = mode || null;
  }

  function isMutating() { return depth > 0; }

  // Append to the game log (cap CONFIG.LOG_CAP) and emit log:entry.
  // severity: info | good | bad | epic | warn
  function log(type, text, severity, extra) {
    if (!current) return null;
    const entry = {
      t: SD.clock.now(),
      season: current.season.number,
      day: current.season.day,
      type: String(type || 'info'),
      text: String(text == null ? '' : text),
      severity: severity || 'info'
    };
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function (k) { if (!(k in entry)) entry[k] = extra[k]; });
    }
    current.log.push(entry);
    const cap = SD.CONFIG.LOG_CAP;
    if (current.log.length > cap) current.log.splice(0, current.log.length - cap);
    if (SD.bus) SD.bus.emit(SD.EVENTS.LOG_ENTRY, entry);
    if (depth === 0 && SD.persistence && SD.persistence.scheduleSave) SD.persistence.scheduleSave();
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Selectors (all accept an optional explicit state, default = current)
  // ---------------------------------------------------------------------------
  function runnerById(id, st) {
    st = st || current;
    if (!st || id == null) return null;
    for (let i = 0; i < st.runners.length; i++) if (st.runners[i].id === id) return st.runners[i];
    return null;
  }

  // Case-insensitive runner lookup: id, exact name key, unique prefix, then word prefix.
  // Returns { runner } | { ambiguous: [runners] } | { none: true }
  function findRunner(query, st) {
    st = st || current;
    if (!st || query == null) return { none: true };
    const raw = String(query).trim().replace(/^@+/, '');
    if (!raw) return { none: true };
    const pool = st.runners.filter(function (r) { return !r.retired; });
    const lower = raw.toLowerCase();
    // String(): a runner id is always a string after persistence.normalize (review batch 7); this
    // keeps one bad id from breaking every name lookup anyway.
    const byId = pool.filter(function (r) { return String(r.id).toLowerCase() === lower; });
    if (byId.length === 1) return { runner: byId[0] };
    const key = U.nameKey(raw);
    if (!key) return { none: true };
    function pick(list) {
      if (list.length === 1) return { runner: list[0] };
      if (list.length > 1) return { ambiguous: list };
      return null;
    }
    return pick(pool.filter(function (r) { return U.nameKey(r.name) === key; })) ||
      pick(pool.filter(function (r) { return U.nameKey(r.name).indexOf(key) === 0; })) ||
      pick(pool.filter(function (r) {
        return r.name.toLowerCase().split(/[^a-z0-9]+/).some(function (w) { return w && w.indexOf(key) === 0; });
      })) ||
      { none: true };
  }

  function player(username, st) {
    st = st || current;
    if (!st || !username) return null;
    const p = U.own(st.players, String(username).toLowerCase().replace(/^@+/, ''));
    return p && typeof p === 'object' ? p : null;
  }

  function activeRunners(st) {
    st = st || current;
    return st ? st.runners.filter(function (r) { return !r.retired; }) : [];
  }

  function runnersOwnedBy(username, st) {
    st = st || current;
    if (!st || !username) return [];
    const u = SD.players ? SD.players.keyOf(username) : String(username).toLowerCase();
    return st.runners.filter(function (r) { return !!r.ownerKey && r.ownerKey === u; });
  }

  function isRaceLocked(st) {
    st = st || current;
    const cr = st && st.currentRace;
    return !!(cr && (cr.status === 'countdown' || cr.status === 'running' || cr.status === 'paused'));
  }

  function dayEvent(st) {
    st = st || current;
    return st && SD.events ? SD.events.dayEventById(st.season.activeDayEvent) : null;
  }

  SD.state = {
    create: create,
    defaultSettings: defaultSettings,
    resalt: resalt,
    get: get,
    set: set,
    resetRuntime: resetRuntime,
    mutate: mutate,
    saveHint: saveHint,
    isMutating: isMutating,
    log: log,
    runtime: runtime,
    runnerById: runnerById,
    findRunner: findRunner,
    player: player,
    activeRunners: activeRunners,
    runnersOwnedBy: runnersOwnedBy,
    isRaceLocked: isRaceLocked,
    dayEvent: dayEvent
  };
})(globalThis.SD = globalThis.SD || {});
