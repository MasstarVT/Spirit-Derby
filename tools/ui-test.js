#!/usr/bin/env node
/*
 * Spirit Derby - tools/ui-test.js (review batch 9: UI and playback fixes)
 *   A  playback in a hidden page runs at real speed although the browser wakes its timers only once
 *      a second or once a minute; every tick / event / finish is still emitted once, in order (ui-track#1)
 *   B  END while paused in the finish hold resolves the race (ui-track#5); END during the countdown
 *      moves the race to 'running' (ui-track#8)
 *   C  the track keeps the final view while a never-auto-closing results modal is open (ui-track#4)
 *   D  9-10 runner fields: CSS sizes for data-n 9 / 10, the paddock previews up to MAX_RUNNERS (ui-track#6)
 *   E  a season summary queued behind the results never covers the next race or its results
 *      (ui-panels-boot#1)
 *   F  the modals never take focus from an input the streamer types in, and single-key shortcuts
 *      are off while a modal is open (ui-panels-boot#2)
 *   G  Tab / Shift+Tab stay inside an open modal (ui-panels-boot#7)
 *   H  arrow keys / Home / End move between the sidebar tabs (ui-panels-boot#6)
 *   I  prefers-reduced-motion stops every infinite CSS animation (ui-panels-boot#5)
 *   J  '+N to backers' only for runners someone actually backed (ui-panels-boot#8)
 *   K  an important toast on a full strip takes the slot a reply leaves; queue trimming drops replies
 *      first (ui-admin-chat-dom#4)
 *   L  review batch 10 (ui-track#7): the playback state machine - pause in the countdown keeps the
 *      seconds left, pause while running keeps the cursor (no jump, no lost or repeated tick), END while
 *      running, abort in the countdown / running / paused never emits race:playbackDone, and
 *      race:playbackDone fires exactly once per race
 *   M  review batch 11 (R4 / R5): the header's status tags (FIXED SEED, NOT SAVED, DEMO BOTS) sit on
 *      their own line and add no width. Also batch 11: the lock itself in A (R16), a drawer select /
 *      checkbox does not keep focus from a modal in F (R17), paddock__grid--many for 9-10 cards in D
 *      (R19; fix round: the style is left out of those cards, owner before energy, no 1 px overflow at
 *      8 cards), a static glow under reduced motion in I (R18), the real race:finished payload in J (R15)
 *
 *   node tools/ui-test.js [--verbose]
 * Runs the real js/ui/dom.js, playback.js, track.js, results.js, season.js and js/main.js (boot) on a
 * small fake DOM with a fake clock, requestAnimationFrame and timers (throttled like a browser's
 * while the page is hidden).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
let passed = 0;
let failed = 0;
function section(t) { console.log('\n' + t); }
function ok(cond, name, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '')); }
  return !!cond;
}
function eq(a, b, name) { return ok(JSON.stringify(a) === JSON.stringify(b), name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

// =============================================================================
// Fake clock, timers and requestAnimationFrame
// =============================================================================
const BASE = 1767225600000;
let T = 0;                      // ms since the start of the test (performance.now)
let hidden = false;             // document.hidden
let hiddenFloor = 0;            // while hidden: timers wait at least this long, aligned to it (browser throttling)
const queue = [];
let seq = 0;
function schedule(fn, ms, kind, every) {
  const id = ++seq;
  let at = T + Math.max(0, Number(ms) || 0);
  if (kind !== 'raf' && hidden && hiddenFloor) at = Math.ceil(Math.max(at, T + hiddenFloor) / hiddenFloor) * hiddenFloor;
  queue.push({ id: id, at: at, fn: fn, kind: kind, every: every });
  return id;
}
function unschedule(id) { const i = queue.findIndex(function (q) { return q.id === id; }); if (i >= 0) queue.splice(i, 1); }
const FRAME = 1000 / 60;
globalThis.setTimeout = function (fn, ms) { return schedule(fn, ms, 'timeout'); };
globalThis.clearTimeout = unschedule;
globalThis.setInterval = function (fn, ms) { return schedule(fn, Math.max(1, Number(ms) || 1), 'interval', Math.max(1, Number(ms) || 1)); };
globalThis.clearInterval = unschedule;
globalThis.requestAnimationFrame = function (fn) {
  // rAF never runs in a hidden page.
  const id = ++seq;
  queue.push({ id: id, at: hidden ? Infinity : Math.ceil((T + 0.001) / FRAME) * FRAME, fn: function () { fn(T); }, kind: 'raf' });
  return id;
};
globalThis.cancelAnimationFrame = unschedule;
Object.defineProperty(globalThis, 'performance', { value: { now: function () { return T; } }, configurable: true, writable: true });
Date.now = function () { return BASE + T; };

/** Run every timer due within ms (in order), then set the clock to T + ms. stop() ends early. */
function run(ms, stop) {
  const end = T + ms;
  let guard = 0;
  for (;;) {
    if (stop && stop()) return true;
    queue.sort(function (a, b) { return (a.at - b.at) || (a.id - b.id); });
    const q = queue[0];
    if (!q || q.at > end || guard++ > 5e6) break;
    queue.shift();
    T = Math.max(T, q.at);
    if (q.every) { q.at = T + q.every; queue.push(q); }
    q.fn();
  }
  T = end;
  return !!(stop && stop());
}
function setHidden(on, floor) {
  hidden = !!on;
  hiddenFloor = on ? (floor || 0) : 0;
  // A page becoming visible again gets its pending rAF callbacks on the next frame.
  if (!on) queue.forEach(function (q) { if (q.kind === 'raf' && q.at === Infinity) q.at = Math.ceil((T + 0.001) / FRAME) * FRAME; });
}

// =============================================================================
// Core (loaded before `window` exists, so SD.isNode stays true: no save timers, no storage)
// =============================================================================
const SD = require('./load-core.js');
SD.clock.set(function () { return BASE + T; });

// =============================================================================
// A small fake DOM
// =============================================================================
function parseCompound(str) {
  const c = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:not\(([^)]*)\)|::?[\w-]+/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[1] && m.index === 0) c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push([m[4], m[5]]);
    else if (m[6]) c.nots.push(parseCompound(m[6]));
  }
  return c;
}
function attrOf(el, k) {
  if (k === 'hidden') return el.hidden ? '' : null;
  if (k === 'disabled') return el.disabled ? '' : null;
  return el.getAttribute(k);
}
function matchCompound(el, c) {
  if (!el || !el.tagName) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (let i = 0; i < c.classes.length; i++) if (!el.classList.contains(c.classes[i])) return false;
  for (let i = 0; i < c.attrs.length; i++) {
    const v = attrOf(el, c.attrs[i][0]);
    if (v === null || (c.attrs[i][1] !== undefined && v !== c.attrs[i][1])) return false;
  }
  for (let i = 0; i < c.nots.length; i++) if (matchCompound(el, c.nots[i])) return false;
  return true;
}
function matches(el, selector) {
  return String(selector).split(',').some(function (sel) {
    const parts = sel.trim().split(/\s+/).map(parseCompound);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let anc = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (anc && !matchCompound(anc, parts[i])) anc = anc.parentNode;
      if (!anc) return false;
      anc = anc.parentNode;
    }
    return true;
  });
}
class ClassList {
  constructor() { this.set = new Set(); }
  add() { for (let i = 0; i < arguments.length; i++) this.set.add(arguments[i]); }
  remove() { for (let i = 0; i < arguments.length; i++) this.set.delete(arguments[i]); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; if (on) this.set.add(c); else this.set.delete(c); return on; }
}
class El {
  constructor(tag, opts) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.classList = new ClassList();
    this.dataset = {};
    this.style = { setProperty: function () {}, removeProperty: function () {} };
    this.textContent = '';
    this.isContentEditable = false;
    this.nodeType = 1;
    this.value = '';
    this.stubs = {};
    this.autoStub = !!(opts && opts.autoStub);
    this.htmlHook = null;
    this._html = '';
  }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = String(v); }
  get className() { return Array.from(this.classList.set).join(' '); }
  set className(v) { this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get tabIndex() { return this.attrs.tabindex !== undefined ? Number(this.attrs.tabindex) : (this.tagName === 'BUTTON' || this.tagName === 'INPUT' ? 0 : -1); }
  set tabIndex(v) { this.attrs.tabindex = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children.forEach(function (c) { c.parentNode = null; });
    this.children = [];
    this.stubs = {};
    if (this._html && this.htmlHook) this.htmlHook(this, this._html);
  }
  setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { const l = this.listeners[t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n && n.tagName; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  descendants() { const out = []; (function walk(n) { n.children.forEach(function (c) { out.push(c); walk(c); }); })(this); return out; }
  querySelectorAll(sel) { return this.descendants().filter(function (n) { return matches(n, sel); }); }
  querySelector(sel) {
    const hit = this.querySelectorAll(sel)[0];
    if (hit) return hit;
    if (!this.autoStub) return null;
    return this.stubs[sel] || (this.stubs[sel] = new El('span', { autoStub: true }));
  }
  isShown() { for (let n = this; n && n.tagName; n = n.parentNode) if (n.hidden) return false; return true; }
  focus() { if (this.disabled || !this.isShown() || !document.body.contains(this)) return; document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  click() { dispatch(this, { type: 'click', detail: 1 }); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
}
function h(tag, attrs, children) {
  const n = new El(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'disabled' || k === 'hidden') n[k] = !!attrs[k];
    else n.setAttribute(k, attrs[k]);
  });
  (children || []).forEach(function (c) { n.appendChild(c); });
  return n;
}

const docListeners = { capture: {}, bubble: {} };
const body = h('body');
const document = {
  readyState: 'complete',
  visibilityState: 'visible',
  get hidden() { return hidden; },
  body: body,
  documentElement: body,
  activeElement: body,
  createElement: function (tag) { return new El(tag, { autoStub: true }); },
  createTextNode: function (t) { return { nodeType: 3, textContent: String(t), parentNode: null }; },
  getElementById: function (id) { return body.descendants().filter(function (n) { return n.id === id; })[0] || null; },
  querySelector: function (sel) { return body.querySelectorAll(sel)[0] || null; },
  querySelectorAll: function (sel) { return body.querySelectorAll(sel); },
  addEventListener: function (t, f, capture) { const m = capture ? docListeners.capture : docListeners.bubble; (m[t] = m[t] || []).push(f); },
  removeEventListener: function () {}
};
globalThis.document = document;
globalThis.window = {
  location: { search: '', reload: function () {} },
  addEventListener: function () {},
  removeEventListener: function () {},
  dispatchEvent: function () {}
};
globalThis.Event = function (type) { this.type = type; };

/** Dispatch an event: document capture listeners, then target → ancestors, then document bubble listeners. */
function dispatch(target, init) {
  const e = Object.assign({
    target: target, key: '', code: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
    defaultPrevented: false, preventDefault: function () { this.defaultPrevented = true; }, stopPropagation: function () {}
  }, init);
  (docListeners.capture[e.type] || []).slice().forEach(function (f) { f(e); });
  for (let n = target; n && n.listeners; n = n.parentNode) (n.listeners[e.type] || []).slice().forEach(function (f) { f.call(n, e); });
  (docListeners.bubble[e.type] || []).slice().forEach(function (f) { f(e); });
  return e;
}
/** A key press on the focused element, with the browser's default click for Space / Enter on a button. */
function press(key, opts) {
  const target = document.activeElement || body;
  const e = dispatch(target, Object.assign({ type: 'keydown', key: key, code: key === ' ' ? 'Space' : '' }, opts || {}));
  if (!e.defaultPrevented && target.tagName === 'BUTTON' && (key === ' ' || key === 'Enter')) target.click();
  return e;
}
function typeText(text) { for (const ch of text) press(ch); }

// Page skeleton: #app (sidebar tabs + chat input + a drawer button), #results, #season.
function modalHook(root) {
  // Stands in for the modal markup the panels build with innerHTML: backdrop + dialog + footer button.
  const btn = h('button', { class: 'btn btn--gold', 'data-close': '' });
  root.appendChild(h('div', { class: 'modal__backdrop', 'data-close': '' }));
  root.appendChild(h('div', { class: 'modal__dialog' }, [
    h('footer', { class: 'results__foot' }, [h('span', { class: 'results__auto' }), btn])
  ]));
}
const tabChat = h('button', { 'data-tab': 'chat', role: 'tab', 'aria-controls': 'panel-chat', id: 'tab-chat' });
const tabBoards = h('button', { 'data-tab': 'boards', role: 'tab', 'aria-controls': 'panel-boards', id: 'tab-boards' });
const tabLog = h('button', { 'data-tab': 'log', role: 'tab', 'aria-controls': 'panel-log', id: 'tab-log' });
const chatInput = h('input', { id: 'chat-input', type: 'text' });
const drawerBtn = h('button', { id: 'some-button' });
const app = h('div', { id: 'app' }, [
  h('div', { class: 'tabs', role: 'tablist' }, [tabChat, tabBoards, tabLog]),
  h('section', { id: 'panel-chat' }, [chatInput]),
  h('section', { id: 'panel-boards' }),
  h('section', { id: 'panel-log' }),
  drawerBtn
]);
const resultsRoot = h('div', { class: 'modal', id: 'results', role: 'dialog', 'aria-modal': 'true' });
const seasonRoot = h('div', { class: 'modal', id: 'season', role: 'dialog', 'aria-modal': 'true' });
resultsRoot.htmlHook = modalHook;
seasonRoot.htmlHook = modalHook;
body.appendChild(app);
body.appendChild(resultsRoot);
body.appendChild(seasonRoot);

['js/ui/dom.js', 'js/ui/playback.js', 'js/ui/track.js', 'js/ui/results.js', 'js/ui/season.js', 'js/main.js']
  .forEach(function (f) { require(path.join(ROOT, f)); });
const dom = SD.ui.dom;
const results = SD.ui.results;
const season = SD.ui.season;
const pb = SD.playback;
const EV = SD.EVENTS;

function S() { return SD.state.get(); }
function rest() { S().runners.forEach(function (r) { r.energy = r.maxEnergy; r.fatigue = 0; }); }
function closeModals() { if (results.isOpen()) results.close(); if (season.isOpen()) season.close(); }
function settle() { run(40000); closeModals(); run(1000); }
function counter(name) {
  const c = { n: 0, list: [] };
  SD.bus.on(name, function (p) { c.n++; c.list.push(p); });
  return c;
}

section('boot');
ok(SD.ui.booted === true, 'main.js booted on the fake DOM');
ok(SD.entropy.available(), 'main.js installed the entropy source');
ok(!!pb && typeof pb.finish === 'function', 'SD.playback is loaded');

// =============================================================================
section('A. Hidden page: playback at real speed (ui-track#1)');
// =============================================================================
(function () {
  const ticks = counter(EV.RACE_TICK || 'race:tick');
  const evs = counter(EV.RACE_EVENT || 'race:event');
  const fins = counter(EV.RACE_RUNNER_FINISHED || 'race:runnerFinished');
  const done = counter(EV.RACE_PLAYBACK_DONE || 'race:playbackDone');

  function race(mode, floor) {
    settle();
    rest();
    ticks.n = 0; ticks.list = []; evs.n = 0; evs.list = []; fins.n = 0; done.n = 0;
    SD.state.mutate('test', function (st) { st.settings.distance = 1200; st.settings.runnerCount = 6; });
    setHidden(mode !== 'visible', floor);
    const t0 = T;
    const st = SD.game.startRace();
    if (!ok(st.ok, mode + ': race starts', st.message)) return null;
    const rec = S().currentRace.record;
    let lockedAt60 = null, unlockedAt = null;
    run(4 * 3600 * 1000, function () {
      if (lockedAt60 === null && T - t0 > 60000) lockedAt60 = SD.state.isRaceLocked();
      if (unlockedAt === null && T > t0 && !SD.state.isRaceLocked()) unlockedAt = (T - t0) / 1000;
      return done.n > 0;
    });
    if (unlockedAt === null && !SD.state.isRaceLocked()) unlockedAt = (T - t0) / 1000;
    const out = {
      wall: (T - t0) / 1000, lastTick: rec.ticks.length - 1, events: rec.events.length, finishers: rec.results.length,
      ticks: ticks.list.map(function (p) { return p.tick; }), evCount: evs.n, finCount: fins.n,
      evInOrder: evs.list.every(function (e, i) { return i === 0 || Number(e.tick) >= Number(evs.list[i - 1].tick); }),
      finished: !S().currentRace, lockedAt60: lockedAt60, unlockedAt: unlockedAt, est: playSeconds(rec)
    };
    setHidden(false);
    return out;
  }
  // The record's own nominal running time (sum of 1 / ticks-per-second over its ticks, as playback.js
  // paces it): each race here has a fresh entropy seed, so two races differ in length by a second or
  // more. Comparing wall - est keeps the check about the hidden-tab stepping, not the seed.
  function playSeconds(rec) {
    const P = SD.CONFIG.PLAYBACK || {};
    const table = Object.assign({ START: 3, EARLY: 5, MID: 6, FINAL_TURN: 7, FINAL_STRETCH: 9 }, P.TPS || {});
    const set = S().settings || {};
    let secs = 0;
    for (let k = 0; k < rec.ticks.length - 1; k++) {
      const ph = rec.ticks[k].phase;
      let v = Number(table[ph]);
      if (!isFinite(v)) v = ph === 'FINISH' ? Number(table.FINAL_STRETCH) || 14 : 8;
      v *= Number(set.playbackSpeed) || 1;
      if (ph === 'FINAL_STRETCH' || ph === 'FINISH') v *= Number(set.finalStretchSpeedup) || 1;
      secs += 1 / Math.max(0.25, v);
    }
    return secs;
  }

  const vis = race('visible');
  const h1 = race('hidden1000', 1000);
  const h60 = race('hidden60000', 60000);
  if (!vis || !h1 || !h60) return;
  if (VERBOSE) console.log('    visible ' + vis.wall + ' s, hidden (1 s timers) ' + h1.wall + ' s, hidden (1 min timers) ' + h60.wall + ' s');
  ok(vis.wall > 10 && vis.wall < 120, 'a visible 1200 m race takes a normal time', vis.wall);
  [['visible', vis], ['hidden, 1 s timers', h1], ['hidden, 1 min timers', h60]].forEach(function (x) {
    const r = x[1];
    eq(r.ticks, Array.from({ length: r.lastTick + 1 }, function (_, i) { return i; }), x[0] + ': every tick emitted once, in order');
    eq(r.evCount, r.events, x[0] + ': every record event emitted once');
    ok(r.evInOrder, x[0] + ': events in tick order');
    eq(r.finCount, r.finishers, x[0] + ': every runner crosses the line');
    ok(r.finished, x[0] + ': race:playbackDone -> finishRace applied the race');
  });
  // Hidden pages: timers wake about once a second -> the race takes about as long as a visible one
  // (it took 10x longer: every wake-up advanced 100 ms).
  ok(Math.abs((h1.wall - h1.est) - (vis.wall - vis.est)) <= 3, 'hidden with 1 s timers: about the visible duration (not 10x), each measured against its own record',
    { visible: vis.wall, visibleNominal: vis.est, hidden: h1.wall, hiddenNominal: h1.est });
  // Intensive throttling (one wake-up a minute): done at the first or second wake-up, not after hours.
  ok(h60.wall <= 125, 'hidden with 1 min timers: done within two wake-ups', h60.wall);
  // Review batch 11 (R16): the lock itself, measured (the old check could not fail).
  ok(h60.unlockedAt !== null && h60.unlockedAt <= 125 && !SD.state.isRaceLocked(), 'hidden with 1 min timers: training unlocks within minutes',
    { unlockedAt: h60.unlockedAt, lockedAt60: h60.lockedAt60 });

  // A suspend / resume far longer than a race is capped (HIDDEN_MAX_DT_MS) but still finishes the race.
  settle();
  rest();
  setHidden(true, 0);
  done.n = 0;
  const st = SD.game.startRace();
  ok(st.ok, 'suspend: race starts');
  const saved = queue.slice();
  queue.length = 0;              // nothing fires while suspended
  T += 3 * 3600 * 1000;
  saved.forEach(function (q) { if (q.at <= T) q.at = T; queue.push(q); });
  run(1000, function () { return done.n > 0; });
  ok(done.n === 1 && !S().currentRace, 'after a 3 h suspend the hidden race finishes on the next wake-up');
  setHidden(false);
  ok(Number(SD.CONFIG.PLAYBACK.HIDDEN_MAX_DT_MS) >= 60000, 'CONFIG.PLAYBACK.HIDDEN_MAX_DT_MS covers a one-minute wake-up');
})();

// =============================================================================
section('B. END while paused in the finish hold / during the countdown (ui-track#5, ui-track#8)');
// =============================================================================
(function () {
  const done = counter(EV.RACE_PLAYBACK_DONE || 'race:playbackDone');
  const resumed = counter(EV.RACE_RESUMED || 'race:resumed');

  // #5: pause during the 1.5 s finish hold, then END.
  settle();
  rest();
  done.n = 0;
  ok(SD.game.startRace().ok, 'race starts');
  run(300000, function () { return pb.getMode() === 'hold'; });
  eq(pb.getMode(), 'hold', 'playback reached the finish hold');
  eq(SD.game.pauseRace().ok, true, 'pause during the hold is accepted');
  ok(pb.isPaused(), 'playback is paused');
  resumed.n = 0;
  const end = SD.game.endRace();
  ok(end.ok, 'END accepted', end.message);
  ok(!pb.isPaused(), 'END un-pauses playback');
  ok(resumed.n === 1, 'END on a paused race emits race:resumed (the PAUSED overlay goes)');
  ok(!S().currentRace || S().currentRace.status !== 'paused', 'the race is no longer "paused"');
  run(3000);
  eq(done.n, 1, 'race:playbackDone fired after the hold');
  ok(!S().currentRace, 'the race resolved without pressing Space');

  // A direct SD.playback.finish() on a paused race (console) resumes the core too.
  settle();
  rest();
  done.n = 0;
  ok(SD.game.startRace().ok, 'race 2 starts');
  run(300000, function () { return pb.getMode() === 'hold'; });
  SD.game.pauseRace();
  pb.finish();
  ok(!pb.isPaused() && S().currentRace && S().currentRace.status !== 'paused', 'playback.finish() on a paused hold resumes playback and the core');
  run(3000);
  ok(done.n === 1 && !S().currentRace, 'and the race resolves');

  // #8: END during '3-2-1'.
  settle();
  rest();
  ok(SD.game.startRace().ok, 'race 3 starts');
  run(500);
  eq(pb.getMode(), 'countdown', 'in the countdown');
  eq(S().currentRace.status, 'countdown', 'status countdown');
  SD.game.endRace();
  eq(pb.getMode(), 'hold', 'END jumps to the finish hold');
  eq(S().currentRace.status, 'running', 'END during the countdown moves the status to running');
  SD.commands.handleChat({ username: 'viewer1', displayName: 'Viewer1', text: '!race', source: 'twitch', isMod: false });
  const feed = (SD.state.runtime.chatFeed || []).slice(-1)[0];
  const reply = feed && (feed.text || feed.message || '');
  ok(!/about to start/.test(reply), '!race during the hold does not say "about to start"', reply);
  run(3000);
  ok(!S().currentRace, 'race 3 resolves');

  // Paused during the countdown, then END: resumed, running, resolves.
  settle();
  rest();
  ok(SD.game.startRace().ok, 'race 4 starts');
  run(500);
  SD.game.pauseRace();
  SD.game.endRace();
  ok(!pb.isPaused() && S().currentRace.status === 'running', 'END on a race paused in the countdown: running');
  run(3000);
  ok(!S().currentRace, 'race 4 resolves');
})();

// =============================================================================
section('C. Track keeps the final view behind a results modal that never auto-closes (ui-track#4)');
// =============================================================================
(function () {
  settle();
  const t = SD.ui.track;
  const saveRoot = t.root, saveRefs = t.refs, saveRecord = t.record;
  t.root = new El('div');
  t.refs = {};
  t.record = { id: 'final-view-test', entrants: [], results: [] };
  let released = 0;
  const origRelease = t.releaseFinal;
  t.releaseFinal = function () { released++; return origRelease.apply(this, arguments); };
  SD.state.mutate('test', function (st) { st.settings.resultsAutoCloseMs = 0; });
  results.show({ record: { id: 'final-view-test', entrants: [], results: [], events: [] }, results: [] });
  ok(results.isOpen(), 'results modal open');
  t.onRaceFinished({});
  ok(t.holdFinal, 'final view held');
  run(120000);
  ok(results.isOpen(), 'with auto-close 0 the results modal is still open after 2 min');
  ok(t.holdFinal && released === 0, 'the track still holds the final view (no 30 s fallback while the modal is open)');
  results.close();
  t.releaseFinal();             // the ui:resultsClosed listener (track.init wires it)
  ok(!t.holdFinal, 'closing the results releases it');

  // No results modal at all: the fallback still releases it.
  released = 0;
  t.record = { id: 'final-view-test-1', entrants: [], results: [] };
  t.onRaceFinished({});
  run(40000);
  ok(!t.holdFinal && released === 1, 'with no modal open the fallback timer releases the final view');

  // A positive auto-close still uses its own delay + 5 s.
  SD.state.mutate('test', function (st) { st.settings.resultsAutoCloseMs = 10000; });
  released = 0;
  t.record = { id: 'final-view-test-2', entrants: [], results: [] };   // the release above rendered the paddock
  t.onRaceFinished({});
  run(14000);
  ok(t.holdFinal, 'auto-close 10 s: still held at 14 s', { released: released, s: dom.settings().resultsAutoCloseMs });
  run(2000);
  ok(!t.holdFinal, 'auto-close 10 s: released by the fallback at 15 s');
  SD.state.mutate('test', function (st) { st.settings.resultsAutoCloseMs = 25000; });
  t.releaseFinal = origRelease;
  t.root = saveRoot; t.refs = saveRefs; t.record = saveRecord; t.holdFinal = false;
})();

// =============================================================================
section('D. 9-10 runner fields (ui-track#6)');
// =============================================================================
(function () {
  const css = fs.readFileSync(path.join(ROOT, 'css/track.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = fs.readFileSync(path.join(ROOT, 'css/track.css'), 'utf8');
  function posH(n) {
    // the last top-level rule whose selector list names .track[data-n="n"] alone and sets --pos-h
    let v = null;
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const sels = m[1].split(',').map(function (s) { return s.trim(); });
      const pm = /--pos-h:\s*(\d+)px/.exec(m[2]);
      if (pm && sels.indexOf('.track[data-n="' + n + '"]') >= 0) v = Number(pm[1]);
    }
    if (v === null) { const d = /--pos-h:\s*(\d+)px/.exec(tokens); v = d ? Number(d[1]) : null; }
    return v;
  }
  function hidesOwner(n) {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      if (!/display:\s*none/.test(m[2])) continue;
      if (m[1].split(',').map(function (s) { return s.trim(); }).indexOf('.track[data-n="' + n + '"] .lane__owner') >= 0) {
        // not inside a max-height media query: find the enclosing @media, if any
        const before = css.slice(0, m.index);
        const open = before.lastIndexOf('@media');
        const inMedia = open >= 0 && (before.slice(open).split('{').length - before.slice(open).split('}').length) > 0;
        if (!inMedia) return true;
      }
    }
    return false;
  }
  // The positions column has about 410 px for its list at 1920x1080 (checked in the browser).
  [9, 10].forEach(function (n) {
    const ph = posH(n);
    ok(ph !== null && n * ph <= 410, n + ' runners: the positions list fits the column at 1080p', { n: n, posH: ph, list: n * ph });
    ok(hidesOwner(n), n + ' runners: the lane owner line is hidden at any screen height');
  });
  ok(posH(8) * 8 <= 410, '8 runners still fit');

  // The paddock preview is no longer clamped to 8 when it falls back to its own preview.
  settle();
  while (S().runners.filter(function (r) { return !r.retired; }).length < 10) SD.game.spawnRunner({});
  const upd = SD.game.updateSettings({ runnerCount: 10 });
  ok(upd && upd.ok !== false, 'runnerCount 10 accepted');
  const fo = SD.betting.fieldOdds;
  SD.betting.fieldOdds = function () { return { field: [] }; };
  let html = '';
  try { html = SD.ui.track.paddockHTML(S()); } catch (e) { html = 'ERR ' + e.message; }
  SD.betting.fieldOdds = fo;
  eq((html.match(/paddock__runner/g) || []).length >= 10 ? 10 : (html.match(/paddock__runner/g) || []).length, 10, 'the fallback paddock previews all 10 runners');
  // Review batch 11 (R19): 9-10 cards use the narrower columns (4 across a 1920x1080 track: 3 rows, so
  // the paddock fits under the leader line); 8 or fewer keep the old grid.
  ok(/class="paddock__grid paddock__grid--many"/.test(html), '10 runners: the paddock grid gets paddock__grid--many');
  SD.game.updateSettings({ runnerCount: 8 });
  const html8 = SD.ui.track.paddockHTML(S());
  ok(/class="paddock__grid"/.test(html8) && !/paddock__grid--many/.test(html8), '8 runners: the plain grid');
  // 332 px, not 300: roster names clip below 330 px at 20 px, so narrower windows (e.g. 1400x800, 3 x 306 px)
  // must fall back to fewer, wider columns; 4 x 332 + 3 gaps still fits the 1402 px grid at 1920x1080.
  ok(/\.paddock__grid--many\s*\{[^}]*minmax\(332px,\s*1fr\)/.test(css), 'css: .paddock__grid--many columns are at least 332 px (4 across 1402 px, no clipped roster names)');
  // Batch 11 fix round: the narrower cards leave out the running style, the owner comes before the energy
  // (so a cut meta line still shows it), and the leader line has no top margin (the 8-card paddock under
  // it overflowed by 1 px at 1920x1080 and showed a scrollbar).
  ok(/<div class="paddock__meta"><span class="paddock__style">[^<]+ · <\/span><span class="cond /.test(html8), 'the running style is its own span in the meta line');
  ok(/\.paddock__grid--many \.paddock__style\s*\{\s*display:\s*none;?\s*\}/.test(css), 'css: the narrower cards hide the running style');
  const claimed = S().runners.filter(function (r) { return !r.retired; })[0];
  const oldOwner = claimed.owner;
  SD.state.mutate('test', function () { claimed.owner = 'OwnerNine'; });
  const htmlOwned = SD.ui.track.paddockHTML(S());
  ok(/<div class="paddock__meta">(?:(?!<\/div>).)*👤 OwnerNine · ⚡ \d+\/\d+<\/div>/.test(htmlOwned), 'the owner comes before the energy in the meta line');
  SD.state.mutate('test', function () { claimed.owner = oldOwner; });
  ok(/\.paddock__leader\s*\{[^}]*margin-top:\s*0;/.test(css), 'css: the paddock leader line has no top margin');
  SD.game.updateSettings({ runnerCount: 6 });
})();

// =============================================================================
section('E. A queued season summary never covers the next race (ui-panels-boot#1)');
// =============================================================================
(function () {
  settle();
  SD.state.mutate('test', function (st) { st.settings.autoAdvanceDay = true; st.season.day = st.season.daysPerSeason; st.season.raceIndexInDay = 0; });
  const perDay = S().season.racesPerDay;
  let ended = false;
  for (let i = 0; i < perDay; i++) {
    rest();
    const st = SD.game.startRace();
    if (!ok(st.ok, 'day race ' + (i + 1) + ' starts', st.message)) return;
    const f = SD.game.finishRace();
    if (f && f.dayAdvanced && f.dayAdvanced.seasonEnded) ended = true;
    run(10);
    if (i < perDay - 1) { results.close(); run(10); }
  }
  ok(ended, 'the last race of the season ended it');
  ok(results.isOpen(), 'its results are open');
  ok(!season.isOpen() && season.queue.length === 1, 'the season summary waits behind them');

  run(5000);
  rest();
  const next = SD.game.startRace();          // what a mod's !race does from the results
  ok(next.ok, 'the next race starts from the results', next.message);
  ok(!results.isOpen(), 'its start closed the results');
  ok(!season.isOpen(), 'the season summary does not open over the live race');
  eq(season.queue.length, 1, 'it stays queued');
  run(2000);
  ok(!season.isOpen(), 'still not open 2 s into the race');

  SD.game.finishRace();
  run(10);
  ok(results.isOpen(), 'the new race\'s results open');
  ok(!season.isOpen(), 'and are not hidden under the summary');
  dispatch(body, { type: 'keydown', key: 'Escape' });
  ok(!results.isOpen(), 'Esc closes the visible results');
  ok(season.isOpen(), 'then the season summary shows');
  eq(season.queue.length, 0, 'queue drained');

  // results.show() while a summary is showing defers it (no stacked modals) and it comes back after.
  const shown = season.current;
  results.show({ record: { id: 'x', entrants: [], results: [], events: [] }, results: [] });
  ok(results.isOpen() && !season.isOpen(), 'results over a showing summary: the summary steps back');
  ok(season.queue[0] === shown, 'it is back at the front of the queue');
  results.close();
  ok(season.isOpen() && season.current === shown, 'and shows again when the results close');
  season.close();

  // A summary queued during a race that is then aborted shows after the abort.
  rest();
  ok(SD.game.startRace().ok, 'race starts');
  season.enqueue({ number: 99, runnerTable: [] });
  ok(!season.isOpen(), 'a summary queued during a race waits');
  SD.game.abortRace();
  ok(season.isOpen(), 'it shows once the race is aborted');
  season.close();

  // With no results modal (not in the page), race:finished pumps it.
  rest();
  ok(SD.game.startRace().ok, 'race starts (2)');
  season.enqueue({ number: 98, runnerTable: [] });
  const show = results.show;
  results.show = function () {};
  SD.game.finishRace();
  run(10);
  results.show = show;
  ok(season.isOpen(), 'without a results modal the summary shows after race:finished');
  season.close();
})();

// =============================================================================
section('F. Modals never take focus from an input being typed in (ui-panels-boot#2)');
// =============================================================================
(function () {
  settle();
  body.classList.remove('sd-overlay');
  SD.ui.selectTab('chat');          // the chat input is in the Chat tab
  chatInput.focus();
  ok(document.activeElement === chatInput, 'the streamer is typing in the chat input');
  rest();
  ok(SD.game.startRace().ok, 'race starts');
  run(300000, function () { return !S().currentRace; });      // playback ends -> results open by themselves
  ok(results.isOpen(), 'the results modal opened on its own');
  ok(document.activeElement === chatInput, 'focus stayed in the chat input');
  typeText('good race everyone');
  ok(!body.classList.contains('sd-overlay'), "typing 'o' did not toggle overlay mode");
  ok(results.isOpen(), 'typing a space did not press Continue');
  results.close();
  ok(document.activeElement === chatInput, 'closing the results leaves the input focused');

  // Not typing: the modal takes focus (Continue), and the single-key shortcuts are off while it is open.
  document.activeElement = body;
  results.show({ record: { id: 'y', entrants: [], results: [], events: [] }, results: [] });
  const cont = resultsRoot.querySelector('.results__foot .btn');
  ok(document.activeElement === cont, 'not typing: Continue gets focus');
  press('o');
  ok(!body.classList.contains('sd-overlay'), "'o' with a modal open does not toggle overlay mode");
  press('`');
  ok(!body.classList.contains('sd-admin-open'), 'backtick with a modal open does not open the drawer');
  press(' ');
  ok(!results.isOpen(), 'Space on the focused Continue button still presses it');

  // Season summary: same rule.
  chatInput.focus();
  season.enqueue({ number: 97, runnerTable: [] });
  ok(season.isOpen() && document.activeElement === chatInput, 'the season summary does not take focus from the input either');
  season.close();
  ok(document.activeElement === chatInput, 'nor on close');
  // The modal took focus, then closed: focus goes back to where it was.
  drawerBtn.focus();
  season.enqueue({ number: 96, runnerTable: [] });
  ok(document.activeElement === seasonRoot.querySelector('.results__foot .btn'), 'season summary: Continue focused when not typing');
  season.close();
  ok(document.activeElement === drawerBtn, 'closing it gives focus back');

  // Review batch 11 (R17): a drawer <select> or checkbox is not typing. Left focused behind the modal,
  // Space / arrows would change Distance or Runners there instead of pressing Continue.
  const pickSel = h('select', { id: 'adm-test-select' });
  const pickBox = h('input', { id: 'adm-test-check', type: 'checkbox' });
  app.appendChild(pickSel);
  app.appendChild(pickBox);
  [['a drawer <select>', pickSel], ['a checkbox', pickBox]].forEach(function (x) {
    x[1].focus();
    results.show({ record: { id: 'sel', entrants: [], results: [], events: [] }, results: [] });
    ok(document.activeElement === resultsRoot.querySelector('.results__foot .btn'), 'focus on ' + x[0] + ': the results modal takes it (Continue)');
    results.close();
    ok(document.activeElement === x[1], 'closing gives it back to ' + x[0]);
  });
  eq([SD.ui.dom.isEditable(chatInput), SD.ui.dom.isEditable(pickSel), SD.ui.dom.isEditable(pickBox), SD.ui.dom.isEditable(h('textarea', {}))],
    [true, false, false, true], 'isEditable: text input and textarea yes, select and checkbox no');
  app.removeChild(pickSel);
  app.removeChild(pickBox);

  // The overlay shortcut itself still works with no modal.
  document.activeElement = body;
  press('o');
  ok(body.classList.contains('sd-overlay'), "'o' with no modal toggles overlay mode");
  press('o');
  ok(!body.classList.contains('sd-overlay'), "'o' again toggles it back");
})();

// =============================================================================
section('G. Focus stays inside an open modal (ui-panels-boot#7)');
// =============================================================================
(function () {
  settle();
  SD.ui.selectTab('chat');
  document.activeElement = body;
  results.show({ record: { id: 'z', entrants: [], results: [], events: [] }, results: [] });
  const cont = resultsRoot.querySelector('.results__foot .btn');
  ok(document.activeElement === cont, 'Continue focused');
  let e = press('Tab');
  ok(e.defaultPrevented && document.activeElement === cont, 'Tab from the last control wraps inside the dialog');
  e = press('Tab', { shiftKey: true });
  ok(e.defaultPrevented && document.activeElement === cont, 'Shift+Tab from the first control wraps inside the dialog');
  chatInput.focus();             // the streamer was typing when it opened
  e = press('Tab');
  ok(e.defaultPrevented && document.activeElement === cont, 'Tab from an input behind the modal moves into the dialog');
  chatInput.focus();
  e = press('Tab', { shiftKey: true });
  ok(e.defaultPrevented && document.activeElement === cont, 'Shift+Tab from behind the modal moves into the dialog');
  results.close();
  drawerBtn.focus();
  e = press('Tab');
  ok(!e.defaultPrevented, 'with no modal open Tab is left to the browser');
})();

// =============================================================================
section('H. Arrow keys switch the sidebar tabs (ui-panels-boot#6)');
// =============================================================================
(function () {
  settle();
  SD.ui.selectTab('log');
  eq([tabChat.tabIndex, tabBoards.tabIndex, tabLog.tabIndex], [-1, -1, 0], 'roving tabindex: only the selected tab is in the Tab order');
  tabLog.focus();
  press('ArrowLeft');
  ok(tabBoards.getAttribute('aria-selected') === 'true' && document.activeElement === tabBoards, 'ArrowLeft selects and focuses Boards');
  eq([tabChat.tabIndex, tabBoards.tabIndex, tabLog.tabIndex], [-1, 0, -1], 'Boards is now the tab stop');
  press('ArrowLeft');
  ok(tabChat.getAttribute('aria-selected') === 'true' && document.activeElement === tabChat, 'ArrowLeft again: Chat');
  press('ArrowLeft');
  ok(tabLog.getAttribute('aria-selected') === 'true', 'ArrowLeft on the first tab wraps to the last');
  press('ArrowRight');
  ok(tabChat.getAttribute('aria-selected') === 'true', 'ArrowRight on the last tab wraps to the first');
  press('End');
  ok(tabLog.getAttribute('aria-selected') === 'true' && document.activeElement === tabLog, 'End: last tab');
  press('Home');
  ok(tabChat.getAttribute('aria-selected') === 'true' && document.activeElement === tabChat, 'Home: first tab');
  tabBoards.disabled = true;
  press('ArrowRight');
  ok(tabLog.getAttribute('aria-selected') === 'true', 'a disabled tab is skipped');
  tabBoards.disabled = false;
  ok(document.getElementById('panel-log').hidden === false && document.getElementById('panel-chat').hidden === true, 'the selected tab panel shows');
})();

// =============================================================================
section('I. prefers-reduced-motion stops every infinite animation (ui-panels-boot#5)');
// =============================================================================
(function () {
  const files = ['css/tokens.css', 'css/layout.css', 'css/track.css', 'css/panels.css'];
  const loops = [];
  const stopped = new Set();
  const staticOpacity = {};     // selector -> opacity a reduced-motion block gives it
  files.forEach(function (f) {
    let css = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // Pull out the reduced-motion blocks.
    const re = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
    let m;
    const cut = [];
    while ((m = re.exec(css))) {
      let depth = 1, i = re.lastIndex;
      for (; i < css.length && depth; i++) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; }
      const inner = css.slice(re.lastIndex, i - 1);
      const rr = /([^{}]+)\{([^{}]*)\}/g;
      let r;
      while ((r = rr.exec(inner))) {
        if (/animation:\s*none/.test(r[2])) r[1].split(',').forEach(function (s) { stopped.add(s.trim().replace(/\s+/g, ' ')); });
        const op = /(?:^|;)\s*opacity:\s*([\d.]+)/.exec(r[2]);
        if (op) r[1].split(',').forEach(function (s) { staticOpacity[s.trim().replace(/\s+/g, ' ')] = Number(op[1]); });
      }
      cut.push([m.index, i]);
    }
    for (let k = cut.length - 1; k >= 0; k--) css = css.slice(0, cut[k][0]) + css.slice(cut[k][1]);
    css = css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const rr = /([^{}]+)\{([^{}]*)\}/g;
    let r;
    while ((r = rr.exec(css))) {
      if (/animation[^;]*infinite/.test(r[2])) {
        r[1].split(',').forEach(function (s) {
          s = s.trim().replace(/\s+/g, ' ').replace(/^@media[^{]*$/, '');
          if (s) loops.push({ file: f, sel: s });
        });
      }
    }
  });
  ok(loops.length >= 15, 'found the infinite animations', loops.length);
  const missing = loops.filter(function (l) { return !stopped.has(l.sel); });
  eq(missing, [], 'every infinite animation is stopped under prefers-reduced-motion');
  ok(stopped.has('.hype__bar'), 'the hype meter pulse (.hype__bar) is stopped');
  // Review batch 11 (R18): the aura's keyframes fade it in from opacity 0, so a stopped loop must leave
  // a static glow, not nothing.
  ['.lane.fx-ability .sprite::before', '.lane.fx-awakened .sprite::before'].forEach(function (sel) {
    ok(stopped.has(sel) && staticOpacity[sel] > 0, sel + ': stopped, and shown as a static glow', staticOpacity[sel]);
  });
})();

// =============================================================================
section("J. '+N to backers' only when someone backed the runner (ui-panels-boot#8)");
// =============================================================================
(function () {
  settle();
  rest();
  ok(SD.game.startRace().ok, 'race starts');
  const rec = S().currentRace.record;
  // Review batch 11 (R15): the payload the results modal really gets is race:finished's (finishRace()'s
  // return value has no payouts). Two viewers back one runner, so one row is checked end to end.
  const backed = rec.entrants[0].runnerId;
  SD.state.mutate('test', function (st) {
    ['bk1', 'bk2'].forEach(function (u) {
      const p = SD.players.ensure(st, u, u.toUpperCase()).player;
      p.backing = { runnerId: backed, actions: 1 };
    });
  });
  let payload = null;
  const offFin = SD.bus.on(EV.RACE_FINISHED || 'race:finished', function (p) { payload = p; });
  SD.game.finishRace();
  offFin();
  run(10);
  closeModals();
  const html0 = results.html(rec, rec.results, { payouts: [] });
  ok(rec.results.some(function (r) { return Number(r.spBacker) > 0; }), 'every result carries spBacker (the per-backer share)');
  ok(!/backer/.test(html0), 'no backers: no backer line on any row');
  ok(!!payload && Array.isArray(payload.payouts), 'race:finished carries payouts');
  const realBackers = (payload && payload.payouts || []).filter(function (p) { return p.role === 'backer'; });
  const share = rec.results.filter(function (r) { return r.runnerId === backed; })[0].spBacker;
  eq(realBackers.map(function (p) { return [p.username, p.runnerId, p.amount]; }), [['bk1', backed, share], ['bk2', backed, share]], 'the real payload pays both backers the per-backer share');
  const realHtml = payload ? results.html(rec, rec.results, payload) : '';
  eq((realHtml.match(/backer/g) || []).length, 1, 'the real payload renders one backer line');
  ok(realHtml.indexOf('+' + share + ' each to 2 backers') >= 0, 'it reads "+' + share + ' each to 2 backers"', realHtml.slice(0, 300));
  const a = rec.results[0], b = rec.results[1];
  const pay = [
    { username: 'x1', runnerId: a.runnerId, amount: 25, role: 'backer' },
    { username: 'x2', runnerId: a.runnerId, amount: 25, role: 'backer' },
    { username: 'x3', runnerId: b.runnerId, amount: 17, role: 'backer' },
    { username: 'o1', runnerId: b.runnerId, amount: 34, role: 'owner' }
  ];
  const html = results.html(rec, rec.results, { payouts: pay });
  const rows = html.split('<tr class="place-').slice(1);
  const rowOf = function (id) {
    const res = rec.results.filter(function (r) { return r.runnerId === id; })[0];
    return rows.filter(function (r) { return r.indexOf(String(res.place) + '">') === 0; })[0] || '';
  };
  ok(/\+25 each to 2 backers/.test(rowOf(a.runnerId)), 'two backers of the winner: "+25 each to 2 backers"', rowOf(a.runnerId).slice(0, 400));
  ok(/\+17 to 1 backer</.test(rowOf(b.runnerId)), 'one backer: "+17 to 1 backer"');
  eq((html.match(/backer/g) || []).length, 2, 'no backer line on the other rows (owner payouts are not backers)');
})();

// =============================================================================
section('K. Important toasts take the slot a reply leaves (ui-admin-chat-dom#4)');
// =============================================================================
(function () {
  run(30000);
  const root = document.getElementById('toasts') || dom.el('div');
  const visible = function () {
    const r = document.getElementById('toasts');
    return r ? r.children.filter(function (c) { return !c.classList.contains('toast--out'); }) : [];
  };
  ok(dom.toastStats().visible === 0 && dom.toastStats().queued === 0, 'toast strip empty');
  for (let k = 1; k <= 4; k++) { dom.toast('reply ' + k, 'info', { who: '@v' + k, ms: 6500, reply: true }); run(1100); }
  eq(visible().length, 4, 'four replies fill the strip');
  run(600);
  dom.toast('reply 5', 'info', { who: '@v5', ms: 6500, reply: true });
  eq(dom.toastStats().queued, 1, 'a fifth reply waits');
  const imp = dom.toast('ACHIEVEMENT', 'epic', { ms: 6500 });
  const vis = visible();
  ok(vis.indexOf(imp) >= 0, 'the important toast shows at once (the oldest reply made room for it)');
  eq(vis.length, 4, 'the strip stays at TOAST_MAX');
  eq(dom.toastStats().queued, 1, 'reply 5 still waits');
  run(20000);

  // Queue overflow: replies are dropped before an important toast.
  const max = Number(SD.CONFIG.UI.TOAST_QUEUE_MAX) || 12;
  for (let k = 0; k < 4; k++) dom.toast('important ' + k, 'bad', { ms: 60000 });          // fill the strip
  const firstQueued = dom.toast('queued important', 'bad', { ms: 60000 });
  for (let k = 0; k < max + 4; k++) dom.toast('flood ' + k, 'info', { ms: 6500, reply: true });
  // queue: 1 important + REPLY_QUEUE_MAX replies; this many more importants overflow it by one
  const more = max - (Number(SD.CONFIG.UI.REPLY_QUEUE_MAX) || 6);
  const dropped0 = dom.toastStats().dropped;
  for (let k = 0; k < more; k++) dom.toast('more important ' + k, 'bad', { ms: 60000 });
  ok(dom.toastStats().queued <= max, 'queue capped at TOAST_QUEUE_MAX');
  eq(dom.toastStats().dropped - dropped0, 1, 'one toast dropped for the overflow');
  run(250000);
  ok(firstQueued.parentNode !== null || firstQueued.classList.contains('toast--out'), 'the queued important toast was shown, not dropped by the reply flood');
  void root;
})();

// =============================================================================
section('L. Playback state machine: pause / resume / END / abort (review batch 10, ui-track#7)');
// =============================================================================
(function () {
  const ticks = counter(EV.RACE_TICK || 'race:tick');
  const cds = counter(EV.RACE_COUNTDOWN || 'race:countdown');
  const done = counter(EV.RACE_PLAYBACK_DONE || 'race:playbackDone');
  const aborted = counter(EV.RACE_ABORTED || 'race:aborted');
  function fresh() {
    settle();
    rest();
    ticks.n = 0; ticks.list = []; cds.n = 0; cds.list = []; done.n = 0; aborted.n = 0;
    const st = SD.game.startRace();
    ok(st.ok, 'race starts', st.message);
    return st;
  }

  // 1. Pause during the countdown: it stays where it was, then finishes the seconds that were left.
  fresh();
  run(1000);
  eq(pb.getMode(), 'countdown', 'countdown running');
  const cdBefore = cds.n;
  ok(SD.game.pauseRace().ok, 'pause in the countdown');
  run(10000);
  ok(pb.getMode() === 'countdown' && pb.isPaused() && S().currentRace.status === 'paused', 'still in the countdown, paused, after 10 s');
  eq(cds.n, cdBefore, 'no countdown numbers while paused');
  eq(pb.currentTick(), 0, 'the cursor did not move');
  ok(SD.game.resumeRace().ok, 'resume');
  const t0 = T;
  run(10000, function () { return pb.getMode() === 'running'; });
  const left = (T - t0) / 1000;
  ok(left > 1.6 && left < 2.4, 'the countdown finishes the ~2 s that were left (not restarted, not skipped)', left);
  eq(S().currentRace.status, 'running', 'the core status went to running when it ended');
  run(300000, function () { return done.n > 0; });
  run(60000);
  eq(done.n, 1, 'race:playbackDone exactly once');
  ok(!S().currentRace, 'the race was applied');
  const last = ticks.list.length ? ticks.list[ticks.list.length - 1].tick : -1;
  eq(ticks.list.map(function (p) { return p.tick; }), Array.from({ length: last + 1 }, function (_, i) { return i; }), 'every tick emitted once, in order, across the pause');

  // 2. Pause while running: the cursor stays put, and resuming continues from there (no jump).
  fresh();
  run(300000, function () { return pb.getMode() === 'running' && pb.currentTick() > 20; });
  ok(SD.game.pauseRace().ok, 'pause while running');
  const c0 = pb.currentTick();
  const n0 = ticks.n;
  run(15000);
  eq(pb.currentTick(), c0, 'the cursor does not move while paused');
  eq(ticks.n, n0, 'no ticks while paused');
  ok(SD.game.resumeRace().ok, 'resume');
  run(1000);
  const moved = pb.currentTick() - c0;
  ok(moved > 0 && moved < 15, 'after resume it continues from the same place (about 1 s of ticks, not the 15 s paused)', moved);
  run(300000, function () { return done.n > 0; });
  run(60000);
  eq(done.n, 1, 'race:playbackDone exactly once');
  const last2 = ticks.list[ticks.list.length - 1].tick;
  eq(ticks.list.map(function (p) { return p.tick; }), Array.from({ length: last2 + 1 }, function (_, i) { return i; }), 'no tick lost or repeated across the pause');

  // 3. END while running (not paused): straight to the hold, then done once.
  fresh();
  run(300000, function () { return pb.getMode() === 'running' && pb.currentTick() > 10; });
  const recEnd = pb.getRecord();
  const lastRecTick = recEnd.ticks.length - 1;
  ok(pb.currentTick() < lastRecTick - 10, 'END is pressed well before the last tick', pb.currentTick() + ' of ' + lastRecTick);
  ok(SD.game.endRace().ok, 'END while running');
  eq(pb.getMode(), 'hold', 'END jumps to the finish hold');
  run(10000);
  ok(done.n === 1 && !S().currentRace, 'resolved: playbackDone once, race applied');
  eq(ticks.list[ticks.list.length - 1].tick, lastRecTick, "END emitted up to the record's last tick");
  eq(ticks.list.length, lastRecTick + 1, 'END emitted every remaining tick (one per record tick)');
  eq(ticks.list.map(function (p) { return p.tick; }), Array.from({ length: lastRecTick + 1 }, function (_, i) { return i; }), 'END: every tick emitted once, in order');

  // 4. Abort (countdown, running, paused): playback stops and never reports playbackDone.
  [['in the countdown', function () { run(500); }],
    ['while running', function () { run(300000, function () { return pb.getMode() === 'running' && pb.currentTick() > 5; }); }],
    ['while paused', function () { run(300000, function () { return pb.getMode() === 'running'; }); SD.game.pauseRace(); }]
  ].forEach(function (c) {
    fresh();
    c[1]();
    const ab = SD.game.abortRace();
    ok(ab.ok, 'abort ' + c[0], ab.message);
    eq(aborted.n, 1, 'abort ' + c[0] + ': race:aborted once');
    eq(pb.getMode(), 'idle', 'abort ' + c[0] + ': playback stopped');
    ok(!S().currentRace, 'abort ' + c[0] + ': no race left');
    const tn = ticks.n;
    SD.bus.emit(EV.RACE_RESUMED || 'race:resumed', {});      // a stray resume does not restart it
    run(120000);
    eq(done.n, 0, 'abort ' + c[0] + ': no race:playbackDone, ever');
    eq(ticks.n, tn, 'abort ' + c[0] + ': no ticks after the abort');
  });
})();

// =============================================================================
section('M. Header status tags sit on their own line (review batch 11, R4 / R5)');
// =============================================================================
(function () {
  require(path.join(ROOT, 'js/ui/header.js'));
  const hdr = SD.ui.header;
  const season = h('div', { class: 'hdr-season' });
  const race = h('span', { class: 'hdr-season__race' });
  season.appendChild(h('span', { class: 'hdr-season__main' }));
  season.appendChild(race);
  const saved = [hdr.refs, hdr.root];
  hdr.refs = { race: race };
  hdr.root = h('div', {});
  SD.state.mutate('test', function (st) { st.settings.debug = true; st.settings.seedOverride = 999; });
  hdr.render(S());
  ok(/^RACE <b>[^<]*<\/b> · (NEXT UP|LIVE)<span class="hdr-tags"><span class="hdr-fixedseed"[^>]*>FIXED SEED<\/span><\/span>$/.test(race.innerHTML),
    'the seed override shows FIXED SEED in .hdr-tags after the race line', race.innerHTML);
  ok(season.classList.contains('hdr-season--tags'), 'the season block gets hdr-season--tags (tighter lines)');
  SD.ui.chat = SD.ui.chat || {};
  const hadBots = SD.ui.chat.botsOn;
  SD.ui.chat.botsOn = true;
  hdr.render(S());
  ok(/FIXED SEED<\/span> <span class="hdr-tag">· <span class="hdr-demobots"/.test(race.innerHTML), 'a second tag carries its own " · " (it wraps with the tag)', race.innerHTML);
  SD.ui.chat.botsOn = hadBots;
  SD.state.mutate('test', function (st) { st.settings.debug = false; st.settings.seedOverride = null; });
  hdr.render(S());
  ok(race.innerHTML.indexOf('hdr-tags') < 0 && !season.classList.contains('hdr-season--tags'), 'no tags: plain race line, class removed');
  hdr.refs = saved[0];
  hdr.root = saved[1];
  const css = fs.readFileSync(path.join(ROOT, 'css/panels.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.hdr-tags\s*\{([^}]*)\}/.exec(css);
  ok(!!rule && /width:\s*0/.test(rule[1]) && /min-width:\s*100%/.test(rule[1]) && /display:\s*block/.test(rule[1]),
    'css: .hdr-tags is its own line and adds no width to the header (width 0, min-width 100%)');
  ok(!/hdr-fixedseed__more/.test(css), 'css: no width-dependent FIXED / FIXED SEED switch is needed any more');
})();

console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
