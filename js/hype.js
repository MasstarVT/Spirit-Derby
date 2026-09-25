/*
 * Spirit Derby - hype.js
 * The crowd hype meter (0..120). Thresholds 25 / 50 / 100 fire hype:threshold once per
 * crossing; a threshold re-arms only after hype decays back below it.
 */
(function (SD) {
  'use strict';

  const U = SD.util;

  function thresholds() { return SD.DATA.HYPE_THRESHOLDS; }

  // 0 = calm, 1 = loud (>=25), 2 = feral (>=50), 3 = awakened (>=100)
  function tier(value) {
    const th = thresholds();
    let t = 0;
    for (let i = 0; i < th.length; i++) if (value >= th[i].value) t = i + 1;
    return t;
  }

  function nextThreshold(value) {
    const th = thresholds();
    for (let i = 0; i < th.length; i++) if (value < th[i].value) return th[i];
    return null;
  }

  // In-race effect summary for a hype value (used by the UI; the engine reads CONFIG).
  function effects(value) {
    const H = SD.CONFIG.RACE.HYPE;
    return {
      tier: tier(value),
      sigmaMult: value >= H.LOUD ? H.LOUD_SIGMA : 1,
      eventMult: value >= H.FERAL ? H.FERAL_EVENTS : 1,
      critMult: value >= H.FERAL ? H.FERAL_CRIT : 1,
      forestAwakened: value >= H.AWAKENED
    };
  }

  function multiplier(state) {
    const m = state && state.settings ? Number(state.settings.hypeMultiplier) : 1;
    return m >= 0 ? m : 1;
  }

  // Sync thresholdsHit with the current value; emits hype:threshold for new crossings.
  // src (optional) = { by, reason } of the change that crossed it (carried on the event).
  function syncThresholds(state, emit, src) {
    const H = state.hype;
    const crossed = [];
    thresholds().forEach(function (th) {
      const idx = H.thresholdsHit.indexOf(th.id);
      if (H.value >= th.value && idx < 0) {
        H.thresholdsHit.push(th.id);
        crossed.push(th.id);
        if (emit) {
          if (SD.state && SD.state.get() === state) SD.state.log('hype', th.text, 'epic', { threshold: th.id });
          if (SD.bus) {
            SD.bus.emit(SD.EVENTS.HYPE_THRESHOLD, {
              id: th.id, value: H.value, threshold: th.value, text: th.text,
              by: (src && src.by) || null, reason: (src && src.reason) || null
            });
          }
        }
      } else if (H.value < th.value && idx >= 0) {
        H.thresholdsHit.splice(idx, 1);
      }
    });
    return crossed;
  }

  function emitChanged(state, delta, by, reason) {
    if (SD.bus) {
      SD.bus.emit(SD.EVENTS.HYPE_CHANGED, {
        value: state.hype.value, delta: delta, by: by || null, reason: reason || null, tier: tier(state.hype.value)
      });
    }
  }

  // add(state, amount, { by, reason, raw }) -> { value, delta, crossed:[thresholdId] }
  // Positive amounts are scaled by settings.hypeMultiplier unless raw is true.
  function add(state, amount, opts) {
    opts = opts || {};
    const H = state.hype;
    const before = H.value;
    let amt = Number(amount) || 0;
    if (amt > 0 && !opts.raw) amt *= multiplier(state);
    H.value = U.round1(U.clamp(before + amt, 0, H.max || SD.CONFIG.HYPE.MAX));
    const delta = U.round1(H.value - before);
    if (delta !== 0 && !opts.idle) H.lastChangedAt = SD.clock.now();
    if (opts.by && delta > 0) {
      const key = String(opts.by).toLowerCase();
      H.contributions[key] = U.round1((H.contributions[key] || 0) + delta);
    }
    const crossed = syncThresholds(state, true, opts);
    if (delta !== 0) emitChanged(state, delta, opts.by, opts.reason);
    return { value: H.value, delta: delta, crossed: crossed };
  }

  function set(state, value, reason) {
    const before = state.hype.value;
    state.hype.value = U.round1(U.clamp(Number(value) || 0, 0, state.hype.max || SD.CONFIG.HYPE.MAX));
    syncThresholds(state, true, { reason: reason || 'set' });
    const delta = U.round1(state.hype.value - before);
    if (delta !== 0) emitChanged(state, delta, null, reason || 'set');
    return state.hype.value;
  }

  // After every race: hype = floor(hype * AFTER_RACE_KEEP)
  function decayAfterRace(state) {
    const before = state.hype.value;
    state.hype.value = Math.floor(before * SD.CONFIG.HYPE.AFTER_RACE_KEEP);
    syncThresholds(state, false);
    const delta = U.round1(state.hype.value - before);
    if (delta !== 0) emitChanged(state, delta, null, 'afterRace');
    return state.hype.value;
  }

  // Idle decay: after IDLE_AFTER_MS without a hype change, -1 per IDLE_STEP_MS.
  function idleDecay(state, elapsedMs) {
    const C = SD.CONFIG.HYPE;
    const H = state.hype;
    const rt = SD.state.runtime;
    const now = SD.clock.now();
    if (H.value <= 0) { rt.hypeIdleAccumMs = 0; return 0; }
    const idleFor = now - (H.lastChangedAt || now);
    if (idleFor < C.IDLE_AFTER_MS) { rt.hypeIdleAccumMs = 0; return 0; }
    // Only the part of this interval that lies beyond the idle threshold counts.
    rt.hypeIdleAccumMs += Math.min(Math.max(0, elapsedMs || 0), idleFor - C.IDLE_AFTER_MS);
    let steps = 0;
    while (rt.hypeIdleAccumMs >= C.IDLE_STEP_MS) { rt.hypeIdleAccumMs -= C.IDLE_STEP_MS; steps++; }
    if (steps > 0) add(state, -steps, { reason: 'idle', idle: true });
    return steps;
  }

  function reset(state) {
    state.hype.value = 0;
    state.hype.thresholdsHit = [];
    SD.state.runtime.hypeIdleAccumMs = 0;
  }

  SD.hype = {
    add: add,
    set: set,
    tier: tier,
    nextThreshold: nextThreshold,
    effects: effects,
    multiplier: multiplier,
    decayAfterRace: decayAfterRace,
    idleDecay: idleDecay,
    syncThresholds: syncThresholds,
    reset: reset
  };
})(globalThis.SD = globalThis.SD || {});
