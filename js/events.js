/*
 * Spirit Derby - events.js
 * Pure helpers over the day-event and race-event catalogs in SD.DATA.
 */
(function (SD) {
  'use strict';

  // Weighted random day event.
  function rollDayEvent(rng, excludeId) {
    const list = SD.DATA.DAY_EVENTS.filter(function (e) { return e.id !== excludeId; });
    return rng.weighted(list, function (e) { return e.weight == null ? 1 : e.weight; }) || SD.DATA.DAY_EVENTS[0];
  }

  function dayEventById(id) {
    if (!id) return null;
    if (typeof id === 'object') return id.id ? dayEventById(id.id) || id : null;
    const key = String(id).toLowerCase();
    for (let i = 0; i < SD.DATA.DAY_EVENTS.length; i++) {
      const e = SD.DATA.DAY_EVENTS[i];
      if (e.id.toLowerCase() === key || SD.util.nameKey(e.name) === SD.util.nameKey(id)) return e;
    }
    return null;
  }

  // Normalised modifiers for a day event (every key present, neutral defaults).
  function dayModifiers(dayEvent) {
    const ev = dayEventById(dayEvent) || null;
    const m = (ev && ev.modifiers) || {};
    return {
      eventRate: m.eventRate != null ? m.eventRate : 1,
      sigmaMult: m.sigmaMult != null ? m.sigmaMult : 1,
      critMult: m.critMult != null ? m.critMult : 1,
      poolMult: m.poolMult != null ? m.poolMult : 1,
      spMult: m.spMult != null ? m.spMult : 1,
      xpMult: m.xpMult != null ? m.xpMult : 1,
      statWeight: m.statWeight || null,
      eventWeights: m.eventWeights || {}
    };
  }

  function raceEventsForPhase(phase) {
    return SD.DATA.RACE_EVENTS.filter(function (e) { return e.phases.indexOf(phase) >= 0; });
  }

  function raceEventById(id) {
    for (let i = 0; i < SD.DATA.RACE_EVENTS.length; i++) if (SD.DATA.RACE_EVENTS[i].id === id) return SD.DATA.RACE_EVENTS[i];
    return null;
  }

  SD.events = {
    rollDayEvent: rollDayEvent,
    dayEventById: dayEventById,
    dayModifiers: dayModifiers,
    raceEventsForPhase: raceEventsForPhase,
    raceEventById: raceEventById
  };
})(globalThis.SD = globalThis.SD || {});
