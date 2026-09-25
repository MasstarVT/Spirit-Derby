/*
 * Spirit Derby - namespace.js
 * Creates the global SD namespace plus tiny shared helpers.
 * Every other file is an IIFE that attaches to globalThis.SD (no ES modules, so the
 * game runs straight from file:// and also loads headlessly in Node).
 */
(function (SD) {
  'use strict';

  SD.VERSION = '1.0.0';

  // True when running under Node (tests / balance harness), false in the browser.
  SD.isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node) &&
    typeof window === 'undefined';

  // Test hooks. tools/load-core.js sets strictRandom = true so Math.random throws.
  SD.testing = SD.testing || { strictRandom: false };

  // ---------------------------------------------------------------------------
  // Injectable clock: core code never calls Date directly, it asks SD.clock.now().
  // Tests can freeze or fast-forward time with SD.clock.set(() => fakeMs).
  // ---------------------------------------------------------------------------
  function defaultNow() { return Date.now(); }
  let nowFn = defaultNow;
  SD.clock = {
    now: function () { return nowFn(); },
    set: function (fn) { nowFn = typeof fn === 'function' ? fn : defaultNow; },
    reset: function () { nowFn = defaultNow; }
  };

  // ---------------------------------------------------------------------------
  // Small pure helpers used across core and UI.
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi) {
    v = Number(v);
    if (v !== v) return lo; // NaN guard
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function round1(v) { return Math.round(Number(v) * 10) / 10; }
  function round2(v) { return Math.round(Number(v) * 100) / 100; }
  // 0.125 -> "12.5%"
  function pctString(v, digits) {
    const d = digits == null ? 1 : digits;
    const n = Number(v) * 100;
    return (n === n ? n.toFixed(d) : '0') + '%';
  }
  // "Moss Runner!" -> "mossrunner"
  function nameKey(str) {
    return String(str == null ? '' : str).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function deepClone(obj) { return obj == null ? obj : JSON.parse(JSON.stringify(obj)); }
  // +4 / -12 / +0
  function signed(n) { n = Math.round(Number(n) || 0); return (n >= 0 ? '+' : '') + n; }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  // 125000 -> "2m 05s"
  function fmtDuration(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60), s = total % 60;
    return m > 0 ? m + 'm ' + (s < 10 ? '0' : '') + s + 's' : s + 's';
  }
  function capitalize(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  SD.util = {
    clamp: clamp,
    round1: round1,
    round2: round2,
    pctString: pctString,
    nameKey: nameKey,
    deepClone: deepClone,
    signed: signed,
    ordinal: ordinal,
    fmtDuration: fmtDuration,
    capitalize: capitalize
  };
})(globalThis.SD = globalThis.SD || {});
