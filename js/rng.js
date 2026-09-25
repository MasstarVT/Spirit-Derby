/*
 * Spirit Derby - rng.js
 * Seeded randomness. mulberry32 generator + helpers, FNV-1a string hash.
 * The race engine uses exactly one generator per race, consumed in array order,
 * so the same seed always produces the same race.
 */
(function (SD) {
  'use strict';

  // FNV-1a 32-bit hash of a string -> uint32.
  function hash(str) {
    str = String(str);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // seedFrom('salt', 1, 3, 7) -> hash('salt:1:3:7')
  function seedFrom() {
    const parts = Array.prototype.slice.call(arguments);
    return hash(parts.join(':'));
  }

  function create(seed) {
    let a = (Number(seed) >>> 0);
    const rng = { seed: a, calls: 0 };

    // mulberry32: uniform float in [0, 1)
    rng.float = function () {
      rng.calls++;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.chance = function (p) { return rng.float() < p; };
    rng.range = function (lo, hi) { return lo + (hi - lo) * rng.float(); };
    rng.int = function (n) { return Math.floor(rng.float() * n); }; // 0..n-1
    // Triangular distribution on (-1, 1), peaked at 0 (sum of two uniforms).
    rng.tri = function () { return rng.float() + rng.float() - 1; };
    rng.pick = function (arr) { return arr && arr.length ? arr[Math.floor(rng.float() * arr.length)] : undefined; };
    // Weighted pick. weightOf(item) -> non-negative number. Returns undefined if all weights are 0.
    rng.weighted = function (items, weightOf) {
      if (!items || !items.length) return undefined;
      let total = 0;
      const w = new Array(items.length);
      for (let i = 0; i < items.length; i++) {
        const x = weightOf ? Number(weightOf(items[i], i)) : 1;
        w[i] = x > 0 ? x : 0;
        total += w[i];
      }
      if (total <= 0) return undefined;
      let r = rng.float() * total;
      for (let i = 0; i < items.length; i++) {
        r -= w[i];
        if (r < 0) return items[i];
      }
      return items[items.length - 1];
    };
    // In-place Fisher-Yates shuffle; returns the array.
    rng.shuffle = function (arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng.float() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    };
    return rng;
  }

  SD.rng = { create: create, hash: hash, seedFrom: seedFrom };
})(globalThis.SD = globalThis.SD || {});
