/*
 * Spirit Derby - debug.js (M6)
 * SD.debug: console helpers for the streamer / developers (and bug reports). DOM-free core,
 * loaded after commands.js; nothing here changes the game unless you call SD.game yourself.
 *
 *   SD.debug.state()                  the live state object (read it, don't edit it)
 *   SD.debug.lastRace()               the race on the track, else the last finished one (RaceRecord)
 *   SD.debug.lastRaceJSON(pretty?)    that record as JSON (what admin COPY LAST RACE JSON copies)
 *   SD.debug.simulate(seed, distance, { count, runners }?)
 *                                     simulate a race for the next field (or given runners) with a
 *                                     seed + distance, WITHOUT touching the game; returns the record
 *   SD.debug.replay()                 SD.game.replayLastRace() (same seed + inputs -> same hash?)
 *   SD.debug.bus.wildcard(on?, filter?)  log every bus event to the console (race:frame / race:tick
 *                                     are skipped unless filter matches them); returns true when on
 *   SD.debug.help()                   this list
 */
(function (SD) {
  'use strict';

  function log() {
    if (typeof console !== 'undefined' && console.log) console.log.apply(console, arguments);
  }

  function state() { return SD.state ? SD.state.get() : null; }

  function lastRace() {
    const s = state();
    if (!s) return null;
    if (s.currentRace && s.currentRace.record) return s.currentRace.record;
    const h = s.raceHistory || [];
    return h.length ? h[h.length - 1] : null;
  }

  // The record plus a small header so a pasted bug report says which build / save produced it.
  function lastRaceJSON(pretty) {
    const rec = lastRace();
    if (!rec) return '';
    const s = state();
    const out = {
      spiritDerby: SD.VERSION,
      engineVersion: SD.race ? SD.race.ENGINE_VERSION : null,
      schemaVersion: SD.persistence ? SD.persistence.SCHEMA_VERSION : null,
      status: s && s.currentRace && s.currentRace.record === rec ? s.currentRace.status : 'finished',
      record: rec
    };
    return pretty ? JSON.stringify(out, null, 2) : JSON.stringify(out);
  }

  function toSeed(seed) {
    if (seed == null || seed === '') return SD.game && SD.game.seedForRace ? SD.game.seedForRace() : 1;
    if (typeof seed === 'number' && isFinite(seed)) return seed >>> 0;
    const str = String(seed).trim();
    if (/^0x[0-9a-f]+$/i.test(str)) return parseInt(str, 16) >>> 0;
    if (/^\d+$/.test(str)) return Number(str) >>> 0;
    return SD.rng.hash(str);
  }

  // Simulate one race without changing the game. opts: { count, runners:[Runner] }
  function simulate(seed, distance, opts) {
    opts = opts || {};
    const s = state();
    if (!s || !SD.race || !SD.game) throw new Error('SD.debug.simulate: the game is not loaded.');
    const D = SD.CONFIG.RACE.DISTANCES;
    const dist = D.indexOf(Number(distance)) >= 0 ? Number(distance)
      : (D.indexOf(Number(s.settings.distance)) >= 0 ? Number(s.settings.distance) : D[0]);
    const field = Array.isArray(opts.runners) && opts.runners.length ? opts.runners : SD.game.previewField(opts.count);
    if (!field.length) throw new Error('SD.debug.simulate: no runners to race.');
    const sd = toSeed(seed);
    const dayEvent = SD.events.dayEventById(s.season.activeDayEvent);
    const active = SD.state.activeRunners(s);
    const entrants = SD.race.buildEntrants(field, { distance: dist, hypeLevel: s.hype.value, dayEvent: dayEvent, cheerBonus: {} });
    return SD.race.simulate({
      id: 'debug-' + sd + '-' + dist, seed: sd, distance: dist, entrants: entrants,
      eventFrequency: s.settings.eventFrequency, hypeLevel: s.hype.value, dayEvent: dayEvent, chatEffects: [],
      trackName: 'Debug Glade', season: s.season.number, day: s.season.day, indexInDay: 0,
      rosterAvgLevel: active.reduce(function (a, r) { return a + r.level; }, 0) / Math.max(1, active.length)
    });
  }

  function replay() { return SD.game ? SD.game.replayLastRace() : null; }

  // ---------------------------------------------------------------------------
  // Bus logger
  // ---------------------------------------------------------------------------
  let unsub = null;
  let filterRe = null;
  const NOISY = /^race:(frame|tick)$/;

  function wildcard(on, filter) {
    const want = on === undefined ? !unsub : !!on;
    if (unsub) { unsub(); unsub = null; }
    filterRe = filter ? (filter instanceof RegExp ? filter : new RegExp(String(filter))) : null;
    if (want && SD.bus) {
      unsub = SD.bus.wildcard(function (name, payload) {
        if (filterRe ? !filterRe.test(name) : NOISY.test(name)) return;
        log('[SD.bus] ' + name, payload);
      });
    }
    return !!unsub;
  }

  function help() {
    const lines = [
      'SD.debug.state()                     live state (read-only please)',
      'SD.debug.lastRace()                  current or last RaceRecord',
      'SD.debug.lastRaceJSON(true)          that record as pretty JSON (bug reports)',
      'SD.debug.simulate(seed, distance)    simulate the next field without changing the game',
      'SD.debug.replay()                    re-simulate the last race and compare hashes',
      'SD.debug.bus.wildcard(true, /bet/)   log bus events to the console (false = stop)'
    ];
    log(lines.join('\n'));
    return lines;
  }

  SD.debug = {
    state: state,
    lastRace: lastRace,
    lastRaceJSON: lastRaceJSON,
    simulate: simulate,
    replay: replay,
    toSeed: toSeed,
    help: help,
    bus: { wildcard: wildcard, isOn: function () { return !!unsub; } }
  };
})(globalThis.SD = globalThis.SD || {});
