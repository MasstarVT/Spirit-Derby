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
  // Injectable entropy (review batch 5). Core code never touches crypto or Math.random: it asks
  // SD.entropy.next(), which returns a uint32 from the installed source, or null when none is
  // installed. The browser boot (js/main.js) installs crypto.getRandomValues; Node and the test
  // suites install nothing, so every seed stays reproducible there. With a source installed the
  // seed salt is drawn from it (state.create), re-drawn on every load / import and at every race
  // start (SD.state.resalt), and each per-action roll (training, !create, day events) mixes in a
  // fresh value, so no race or roll can be predicted from saved or previously seen data.
  // SD.entropy.set(fn) installs fn() -> number (only its low 32 bits are used); set(null) / reset()
  // removes it. A source that throws or returns a non-number counts as "no entropy" for that call.
  let entropyFn = null;
  SD.entropy = {
    next: function () {
      if (!entropyFn) return null;
      let v;
      try { v = entropyFn(); } catch (e) { return null; }
      return typeof v === 'number' && isFinite(v) ? (v >>> 0) : null;
    },
    set: function (fn) { entropyFn = typeof fn === 'function' ? fn : null; },
    reset: function () { entropyFn = null; },
    available: function () { return !!entropyFn; }
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
  // Hides secrets in a URL (or in any text that contains one) before it is shown or exported: the
  // value of a token / key / secret / password / auth query parameter and a URL's user:password@
  // part become "…".  "ws://localhost:8765/?token=abc" -> "ws://localhost:8765/?token=…"
  const SECRET_PARAM_RE = /([?&;](?:token|access_token|auth|key|secret|pass|password)=)[^&#\s'"<>]+/gi;
  const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s\/?#@:]*:)[^\s\/?#@]+@/gi;
  function redactSecrets(text) {
    return String(text == null ? '' : text).replace(SECRET_PARAM_RE, '$1…').replace(URL_USERINFO_RE, '$1…@');
  }

  // Prototype-safe maps. Keys that come from chat, the bridge or a save file ('constructor',
  // '__proto__', 'toString', ...) must never reach Object.prototype: a bare map[key] returns the
  // inherited member, and map['__proto__'] = x on a plain object swaps its prototype instead of
  // storing x. Persisted maps (state.players, hype.contributions, achievements.progress) stay
  // plain JSON objects and go through own / setOwn; module-local and runtime maps use dict().
  const hasOwnProp = Object.prototype.hasOwnProperty;
  function hasOwn(obj, key) { return obj != null && hasOwnProp.call(obj, key); }
  // obj[key] only when it is obj's OWN property, else undefined.
  function own(obj, key) { return obj != null && hasOwnProp.call(obj, key) ? obj[key] : undefined; }
  // obj[key] = value as an own, enumerable data property (also for '__proto__'). Returns value.
  function setOwn(obj, key, value) {
    if (hasOwnProp.call(obj, key)) obj[key] = value;
    else Object.defineProperty(obj, key, { value: value, writable: true, enumerable: true, configurable: true });
    return value;
  }
  // A map with no prototype (no inherited keys), optionally filled from src's own keys.
  function dict(src) {
    const d = Object.create(null);
    if (src && typeof src === 'object') Object.keys(src).forEach(function (k) { d[k] = src[k]; });
    return d;
  }

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
    capitalize: capitalize,
    redactSecrets: redactSecrets,
    hasOwn: hasOwn,
    own: own,
    setOwn: setOwn,
    dict: dict
  };
})(globalThis.SD = globalThis.SD || {});
