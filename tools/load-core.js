/*
 * Spirit Derby - tools/load-core.js
 * Loads the DOM-free core into Node in the same order as index.html and returns SD.
 *   const SD = require('./tools/load-core.js');
 * Files that do not exist yet (later milestones) are skipped.
 * While SD.testing.strictRandom is true, Math.random throws: core code must use SD.rng.
 *
 * Review batch 10 (tools-tests#9): the rest of the determinism contract (docs/ARCHITECTURE.md) is
 * trapped too, in two ways:
 *  1. Static scan. Before loading, every core file is scanned (comments, strings and regex literals
 *     blanked out) for the forbidden globals: Date, timers (setTimeout / setInterval / setImmediate /
 *     requestAnimationFrame ...), window, document, localStorage / sessionStorage, crypto, performance,
 *     navigator, fetch / XMLHttpRequest / WebSocket and Math.random. The few allowed uses are listed
 *     in ALLOWED (namespace.js: the default clock and the Node check; persistence.js: guarded
 *     localStorage and the browser-only save timer). A hit throws, naming file:line, so every suite
 *     fails at once. Guarded code (`typeof window !== 'undefined' && ...`) that never runs in Node
 *     is caught too.
 *  2. Runtime. Date (new Date(), Date(), Date.now()), setTimeout / setInterval / setImmediate and
 *     Math.random are wrapped: when the function that calls them is in a core file (other than an
 *     ALLOWED use), they throw. Test code, js/ui/, js/integrations/ and js/main.js keep using them
 *     (the caller is found from the V8 call site), so harnesses that fake timers or time themselves
 *     still work. Math.random also keeps its old rule: with SD.testing.strictRandom on it throws for
 *     every caller (a suite that loads UI code which uses it switches strictRandom off).
 * SD.testing.scanSource(rel, source) -> [{ file, line, token }] and SD.testing.coreFiles are
 * exported for tools/tooling-test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE_ORDER = [
  'js/namespace.js', 'js/config.js', 'js/rng.js', 'js/data.js', 'js/bus.js', 'js/state.js', 'js/persistence.js',
  'js/runners.js', 'js/training.js', 'js/events.js', 'js/race.js', 'js/hype.js', 'js/players.js', 'js/betting.js',
  'js/achievements.js', 'js/leaderboards.js', 'js/seasons.js', 'js/game.js', 'js/commands.js', 'js/debug.js'
];

// Globals the core must not touch (docs/ARCHITECTURE.md "Contract"), and the uses that are allowed.
const FORBIDDEN = [
  'Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'window', 'document', 'localStorage',
  'sessionStorage', 'crypto', 'performance', 'navigator', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Math.random'
];
const ALLOWED = {
  'js/namespace.js': ['Date', 'window'],                                // defaultNow(); SD.isNode
  'js/persistence.js': ['localStorage', 'setTimeout', 'clearTimeout']   // guarded store; browser-only save timer
};
// Runtime traps: which core files may call the wrapped functions.
const RUNTIME_ALLOWED = {
  Date: ['js/namespace.js'],
  setTimeout: ['js/persistence.js'],
  setInterval: [],
  setImmediate: [],
  'Math.random': []
};

/** Blank out comments, string / template text and regex literals (newlines kept for line numbers). */
function stripCode(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let lastSig = '';          // last significant code character (regex vs division)
  let lastWord = '';
  const tplDepth = [];       // brace depth of each ${ ... } we are inside
  let depth = 0;
  function blank(from, to) { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; }
  function readString(q) {   // i at the opening quote; returns index after the closing quote
    let k = i + 1;
    while (k < n && src[k] !== q) { if (src[k] === '\\') k++; else if (src[k] === '\n' && q !== '`') break; k++; }
    return k + 1;
  }
  function readTemplate() {  // from i (just after ` or }) to the closing ` or to ${ ; returns [end, isExpr]
    let k = i;
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '`') return [k + 1, false];
      if (src[k] === '$' && src[k + 1] === '{') return [k + 2, true];
      k++;
    }
    return [n, false];
  }
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") { const end = readString(c); blank(i + 1, end - 1); i = end; lastSig = 'x'; lastWord = ''; continue; }
    if (c === '`') {
      i++;
      const r = readTemplate();
      blank(i, r[1] ? r[0] - 2 : r[0] - 1);
      i = r[0];
      if (r[1]) { tplDepth.push(depth); depth++; lastSig = '{'; } else { lastSig = 'x'; }
      lastWord = '';
      continue;
    }
    if (c === '}' && tplDepth.length && depth - 1 === tplDepth[tplDepth.length - 1]) {
      depth--; tplDepth.pop();
      i++;
      const r = readTemplate();
      blank(i, r[1] ? r[0] - 2 : r[0] - 1);
      i = r[0];
      if (r[1]) { tplDepth.push(depth); depth++; lastSig = '{'; } else { lastSig = 'x'; }
      continue;
    }
    if (c === '/') {
      const regexCtx = !lastSig || '(,=:[!&|?{};+-*%<>~^'.indexOf(lastSig) >= 0 ||
        /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(lastWord);
      if (regexCtx) {
        let k = i + 1, cls = false;
        while (k < n && src[k] !== '\n') {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === '[') cls = true;
          else if (src[k] === ']') cls = false;
          else if (src[k] === '/' && !cls) break;
          k++;
        }
        blank(i + 1, k);
        i = k + 1;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        lastSig = 'x'; lastWord = '';
        continue;
      }
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (/[A-Za-z0-9_$]/.test(c)) {
      let k = i;
      while (k < n && /[A-Za-z0-9_$]/.test(src[k])) k++;
      lastWord = src.slice(i, k);
      lastSig = 'x';
      i = k;
      continue;
    }
    if (!/\s/.test(c)) { lastSig = c; lastWord = ''; }
    i++;
  }
  return out.join('');
}

/** Forbidden globals used in a core source (rel = 'js/x.js'). -> [{ file, line, token }] */
function scanSource(rel, src) {
  const code = stripCode(String(src));
  const allowed = ALLOWED[rel] || [];
  const hits = [];
  const lines = code.split('\n');
  lines.forEach(function (line, idx) {
    FORBIDDEN.forEach(function (tok) {
      if (allowed.indexOf(tok) >= 0) return;
      const re = tok === 'Math.random' ? /\bMath\s*\.\s*random\b/g
        : new RegExp('(^|[^A-Za-z0-9_$])(' + tok + ')(?![A-Za-z0-9_$])', 'g');
      let m;
      while ((m = re.exec(line))) {
        if (tok !== 'Math.random') {
          // obj.window / obj.Date is a property, not the global - unless obj is globalThis / self / global.
          const before = line.slice(0, m.index + m[1].length);
          if (/\.\s*$/.test(before) && !/(globalThis|self|global)\s*\.\s*$/.test(before)) continue;
          // { window: 1 } is an object key.
          if (/^\s*:/.test(line.slice(m.index + m[0].length)) && /[{,]\s*$/.test(before)) continue;
        }
        hits.push({ file: rel, line: idx + 1, token: tok });
      }
    });
  });
  return hits;
}

const SD = (globalThis.SD = globalThis.SD || {});
SD.testing = SD.testing || {};
if (SD.testing.strictRandom === undefined) SD.testing.strictRandom = true;

// ------------------------------------------------------------------ runtime traps (idempotent)
const CORE_ABS = {};
CORE_ORDER.forEach(function (rel) { CORE_ABS[path.normalize(path.join(ROOT, rel)).toLowerCase()] = rel; });

/** The core file (rel path) of the first caller outside this file, or null. */
function coreCaller() {
  const prep = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  let frames = [];
  try {
    Error.stackTraceLimit = 12;
    Error.prepareStackTrace = function (e, s) { return s; };
    const holder = {};
    Error.captureStackTrace(holder, coreCaller);
    frames = holder.stack || [];
  } catch (e) {
    frames = [];
  } finally {
    Error.prepareStackTrace = prep;
    Error.stackTraceLimit = limit;
  }
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i] && typeof frames[i].getFileName === 'function' ? frames[i].getFileName() : null;
    if (!f) continue;
    if (path.normalize(f).toLowerCase() === path.normalize(__filename).toLowerCase()) continue;
    return CORE_ABS[path.normalize(f).toLowerCase()] || null;
  }
  return null;
}
function trap(name) {
  const rel = coreCaller();
  if (rel && (RUNTIME_ALLOWED[name] || []).indexOf(rel) < 0) {
    throw new Error(name + ' is forbidden in Spirit Derby core (' + rel + '): ' +
      (name === 'Date' ? 'use SD.clock.now()' : name === 'Math.random' ? 'use SD.rng' : 'the core schedules nothing') + '.');
  }
}

if (!SD.testing.realRandom) {
  const realRandom = Math.random;
  SD.testing.realRandom = realRandom;
  Math.random = function guardedRandom() {
    if (globalThis.SD && globalThis.SD.testing && globalThis.SD.testing.strictRandom) {
      throw new Error('Math.random() is forbidden in Spirit Derby core (use SD.rng for determinism).');
    }
    trap('Math.random');
    return realRandom();
  };
}

if (!SD.testing.realDate) {
  const RealDate = Date;
  SD.testing.realDate = RealDate;
  const GuardedDate = function Date() {
    trap('Date');
    if (!new.target) return RealDate();
    return Reflect.construct(RealDate, Array.prototype.slice.call(arguments), new.target);
  };
  Object.setPrototypeOf(GuardedDate, RealDate);
  GuardedDate.prototype = RealDate.prototype;
  GuardedDate.now = function now() { trap('Date'); return RealDate.now(); };
  globalThis.Date = GuardedDate;

  ['setTimeout', 'setInterval', 'setImmediate'].forEach(function (name) {
    const real = globalThis[name];
    if (typeof real !== 'function') return;
    const guarded = function () { trap(name); return real.apply(this, arguments); };
    Object.keys(real).forEach(function (k) { guarded[k] = real[k]; });
    if (real[require('util').promisify.custom]) guarded[require('util').promisify.custom] = real[require('util').promisify.custom];
    globalThis[name] = guarded;
  });
}

// ------------------------------------------------------------------ static scan + load
const violations = [];
const loaded = [];
for (const rel of CORE_ORDER) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  scanSource(rel, fs.readFileSync(file, 'utf8')).forEach(function (h) { violations.push(h); });
}
if (violations.length) {
  throw new Error('Determinism contract: forbidden globals in core files (docs/ARCHITECTURE.md):\n' +
    violations.map(function (v) { return '  ' + v.file + ':' + v.line + '  ' + v.token; }).join('\n'));
}
for (const rel of CORE_ORDER) {
  const file = path.join(ROOT, rel);
  if (fs.existsSync(file)) {
    require(file);
    loaded.push(rel);
  }
}
SD.testing.loadedFiles = loaded;
SD.testing.coreFiles = CORE_ORDER.slice();
SD.testing.scanSource = scanSource;
SD.testing.stripCode = stripCode;
SD.testing.forbiddenGlobals = FORBIDDEN.slice();

module.exports = SD;
