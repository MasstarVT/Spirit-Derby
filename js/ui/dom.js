/* SPIRIT DERBY — ui/dom.js
 * Small DOM toolkit shared by every UI panel (browser only).
 * Contract: SD.ui.dom = { $, $$, el, esc, fmt, schedule, toast } (+ helpers below).
 */
(function (SD) {
  'use strict';

  SD.ui = SD.ui || {};

  // ---------------------------------------------------------------- selectors
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** Collect every [data-ref] under root into { name: element }. */
  function refs(root) {
    const out = {};
    $$('[data-ref]', root).forEach(function (n) { out[n.getAttribute('data-ref')] = n; });
    return out;
  }

  // ---------------------------------------------------------------- element builder
  function appendChildren(node, children) {
    if (children == null || children === false) return;
    if (Array.isArray(children)) { children.forEach(function (c) { appendChildren(node, c); }); return; }
    if (typeof children === 'string' || typeof children === 'number') {
      node.appendChild(document.createTextNode(String(children)));
      return;
    }
    if (children && typeof children.nodeType === 'number') node.appendChild(children);
  }

  /**
   * el('button', { class: 'btn', text: 'Go', onclick: fn, dataset: { id: 'r1' }, style: { '--badge': '#fff' } }, [children])
   * `html` sets innerHTML and must only ever receive already-escaped markup.
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class' || k === 'className') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style') {
          if (typeof v === 'string') node.style.cssText = v;
          else Object.keys(v).forEach(function (s) {
            if (s.indexOf('--') === 0) node.style.setProperty(s, v[s]);
            else node.style[s] = v[s];
          });
        } else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      });
    }
    appendChildren(node, children);
    return node;
  }

  // ---------------------------------------------------------------- escaping / sanitising
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"'`]/g, function (c) { return ESC[c]; });
  }

  /** Only allow plain colour syntaxes into inline style (ribbon colours can be chat-supplied). */
  function safeColor(c) {
    if (typeof c !== 'string') return null;
    const s = c.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
    if (/^(rgb|rgba|hsl|hsla)\(\s*[-\d.%\s,/]+\)$/i.test(s)) return s;
    if (/^[a-z]{3,24}$/i.test(s)) return s.toLowerCase();
    return null;
  }

  function safeUrl(u) {
    if (typeof u !== 'string' || !u.trim()) return null;
    const s = u.trim();
    if (/^\s*(javascript|vbscript):/i.test(s)) return null;
    if (/^data:/i.test(s) && !/^data:image\//i.test(s)) return null;
    return s;
  }

  // ---------------------------------------------------------------- numbers / format
  function clamp(v, lo, hi) { v = Number(v); if (!isFinite(v)) v = lo; return v < lo ? lo : v > hi ? hi : v; }
  function num(v, fallback) { v = Number(v); return isFinite(v) ? v : fallback; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  const fmt = {
    int: function (n) {
      n = Number(n);
      if (!isFinite(n)) return '–';
      return Math.round(n).toLocaleString('en-US');
    },
    /** fraction 0..1 → "45%" */
    pct: function (v, digits) {
      v = Number(v);
      if (!isFinite(v)) return '–';
      return (v * 100).toFixed(digits || 0) + '%';
    },
    /** seconds → "1:14.3" */
    time: function (sec) {
      sec = Number(sec);
      if (!isFinite(sec) || sec < 0) return '–';
      const tenths = Math.round(sec * 10);
      const m = Math.floor(tenths / 600);
      const rem = tenths - m * 600;
      return m + ':' + pad2(Math.floor(rem / 10)) + '.' + (rem % 10);
    },
    /** seconds → "1:14" (no tenths) */
    clockSec: function (sec) {
      sec = Math.max(0, Math.floor(Number(sec) || 0));
      return Math.floor(sec / 60) + ':' + pad2(sec % 60);
    },
    /** epoch ms → "14:05" */
    hhmm: function (ts) {
      const d = new Date(Number(ts) || 0);
      if (isNaN(d.getTime())) return '';
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    },
    hhmmss: function (ts) {
      const d = new Date(Number(ts) || 0);
      if (isNaN(d.getTime())) return '';
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    },
    odds: function (x) {
      x = Number(x);
      if (!isFinite(x) || x <= 0) return '–';
      return (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + '×';
    },
    signed: function (n, digits) {
      n = Number(n);
      if (!isFinite(n)) return '–';
      const s = digits ? n.toFixed(digits) : String(Math.round(n));
      return (n > 0 ? '+' : '') + s;
    },
    metres: function (m) { return fmt.int(m) + ' m'; },
    ordinal: function (n) {
      n = Math.round(Number(n) || 0);
      const v = n % 100;
      const suf = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
      return n + suf;
    },
    medal: function (place) {
      return ({ 1: '🥇', 2: '🥈', 3: '🥉' })[place] || fmt.ordinal(place);
    }
  };

  // ---------------------------------------------------------------- bus helpers
  /** 'RACE_RUNNER_FINISHED' → 'race:runnerFinished' (contract naming), unless SD.EVENTS defines it. */
  function ev(key) {
    if (typeof key !== 'string') return key;
    if (key.indexOf(':') !== -1) return key;
    if (SD.EVENTS && SD.EVENTS[key]) return SD.EVENTS[key];
    const parts = key.toLowerCase().split('_');
    const head = parts.shift();
    return head + ':' + parts.map(function (p, i) { return i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1); }).join('');
  }

  /** Subscribe by EVENTS key or literal name; always returns an unsubscribe function. */
  function on(key, fn) {
    if (!SD.bus || typeof SD.bus.on !== 'function') return function () {};
    const name = ev(key);
    const off = SD.bus.on(name, fn);
    if (typeof off === 'function') return off;
    return function () { if (SD.bus.off) SD.bus.off(name, fn); };
  }

  function emit(key, payload) {
    if (SD.bus && typeof SD.bus.emit === 'function') SD.bus.emit(ev(key), payload);
  }

  // ---------------------------------------------------------------- state helpers (read-only)
  function state() {
    try { return (SD.state && SD.state.get && SD.state.get()) || null; } catch (e) { return null; }
  }
  function settings() { const s = state(); return (s && s.settings) || {}; }
  function debugOn() { return !!settings().debug; }
  /** Read a nested SD.CONFIG value by dotted path with a fallback. */
  function cfg(path, fallback) {
    let cur = SD.CONFIG;
    const parts = String(path).split('.');
    for (let i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return fallback;
      cur = cur[parts[i]];
    }
    return cur === undefined ? fallback : cur;
  }
  function isRaceLocked(s) {
    s = s || state();
    try { if (SD.state && typeof SD.state.isRaceLocked === 'function') return !!SD.state.isRaceLocked(); } catch (e) { /* fall through */ }
    const st = s && s.currentRace && s.currentRace.status;
    return st === 'countdown' || st === 'running' || st === 'paused';
  }

  // ---------------------------------------------------------------- catalog lookups (tolerant)
  const STYLE_FALLBACK = {
    frontRunner: { name: 'Front Runner', short: 'FR' },
    paceChaser: { name: 'Pace Chaser', short: 'PC' },
    lateSurger: { name: 'Late Surger', short: 'LS' },
    wildCard: { name: 'Wild Card', short: 'WC' }
  };
  const MOOD_EMOJI = { 'Determined': '😤', 'Happy': '😊', 'Nervous': '😰', 'Fired Up': '🔥', 'Sleepy': '😴', 'Chaotic': '🌀' };
  const DATA = function () { return SD.DATA || {}; };

  const info = {
    style: function (id) {
      const s = (DATA().STYLES && DATA().STYLES[id]) || STYLE_FALLBACK[id];
      return { name: (s && s.name) || String(id || '—'), short: (s && s.short) || String(id || '—').slice(0, 2).toUpperCase(), desc: (s && s.desc) || '' };
    },
    species: function (id) {
      const sp = DATA().SPECIES && DATA().SPECIES[id];
      return (sp && sp.name) || String(id || '');
    },
    ability: function (r) {
      if (!r) return null;
      const id = (r.ability && r.ability.id) || r.abilityId;
      const cat = id && DATA().ABILITIES && DATA().ABILITIES[id];
      const name = (r.ability && r.ability.name) || (cat && cat.name) || '';
      const desc = (r.ability && r.ability.desc) || (cat && cat.desc) || '';
      return name ? { id: id, name: name, desc: desc } : null;
    },
    abilityName: function (id) {
      const cat = id && DATA().ABILITIES && DATA().ABILITIES[id];
      return (cat && cat.name) || String(id || '');
    },
    moodEmoji: function (mood) {
      const m = DATA().MOODS && DATA().MOODS[mood];
      return (m && m.emoji) || MOOD_EMOJI[mood] || '🙂';
    },
    dayEvent: function (x) {
      if (!x) return null;
      if (typeof x === 'object') return x;
      try { if (SD.events && SD.events.dayEventById) { const e = SD.events.dayEventById(x); if (e) return e; } } catch (e) { /* ignore */ }
      const list = DATA().DAY_EVENTS || [];
      for (let i = 0; i < list.length; i++) if (list[i].id === x) return list[i];
      return { id: x, name: String(x) };
    },
    thresholds: function () {
      const t = DATA().HYPE_THRESHOLDS;
      if (Array.isArray(t) && t.length) return t;
      return [
        { value: 25, id: 'loud', text: 'The crowd is getting loud!' },
        { value: 50, id: 'feral', text: 'CHAT HAS ENTERED FERAL MODE.' },
        { value: 100, id: 'awakened', text: 'THE FOREST HAS AWAKENED.' }
      ];
    },
    hypeTier: function (value) {
      value = Number(value) || 0;
      try { if (SD.hype && typeof SD.hype.tier === 'function') { const t = SD.hype.tier(value); if (t != null) return t; } } catch (e) { /* ignore */ }
      const th = info.thresholds();
      let tier = 0;
      th.forEach(function (t, i) { if (value >= t.value) tier = i + 1; });
      return Math.min(3, tier);
    },
    statCap: function (level) {
      try { if (SD.runners && SD.runners.statCap) return SD.runners.statCap(level); } catch (e) { /* ignore */ }
      return 60 + 4 * (Number(level) || 1);
    },
    xpToNext: function (level) {
      try { if (SD.runners && SD.runners.xpToNext) return SD.runners.xpToNext(level); } catch (e) { /* ignore */ }
      return 60 + 20 * ((Number(level) || 1) - 1);
    }
  };

  /** CSS custom properties for a runner-coloured element. */
  function runnerVars(r) {
    const color = safeColor(r && r.badgeColor) || '#5c8a4a';
    const ring = safeColor(r && r.ribbonColor);
    return '--badge:' + color + ';' + (ring ? '--ring:' + ring + ';' : '');
  }

  /** Emoji-on-gradient avatar markup (escaped). */
  function badgeHTML(r, cls) {
    r = r || {};
    const ring = safeColor(r.ribbonColor);
    const url = safeUrl(r.avatarUrl);
    const inner = url ? '<img src="' + esc(url) + '" alt="">' : esc(r.emoji || '🐾');
    return '<span class="badge' + (ring ? ' badge--ribbon' : '') + (cls ? ' ' + cls : '') +
      '" style="' + esc(runnerVars(r)) + '" aria-hidden="true">' + inner + '</span>';
  }

  // ---------------------------------------------------------------- per-frame render scheduler
  const dirty = [];
  let flushPending = false;
  let rafId = 0;
  let timerId = 0;

  function flush() {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (timerId) clearTimeout(timerId);
    rafId = 0; timerId = 0; flushPending = false;
    const list = dirty.splice(0, dirty.length);
    const s = state();
    if (!s) return;
    list.forEach(function (panel) {
      try { panel.render(s); } catch (e) { console.error('[ui] render failed', panel && panel.name, e); }
    });
  }

  /** Mark a panel dirty; every dirty panel renders once on the next animation frame. */
  function schedule(panel) {
    if (!panel || typeof panel.render !== 'function') return;
    if (dirty.indexOf(panel) === -1) dirty.push(panel);
    if (flushPending) return;
    flushPending = true;
    // rAF when visible; a timer backstop keeps panels fresh in hidden tabs.
    if (!document.hidden && typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(flush);
    timerId = setTimeout(flush, document.hidden ? 60 : 200);
  }

  // ---------------------------------------------------------------- toasts
  const TOAST_MAX = 5;
  function toastRoot() {
    let root = document.getElementById('toasts');
    if (!root) {
      root = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
      document.body.appendChild(root);
    }
    return root;
  }

  /**
   * toast(text, severity='info'|'good'|'bad'|'epic', { ms, who })
   * Text is always inserted as textContent (never HTML).
   */
  function toast(text, severity, opts) {
    opts = opts || {};
    const sev = ({ info: 1, good: 1, bad: 1, epic: 1 })[severity] ? severity : 'info';
    const root = toastRoot();
    const node = el('div', { class: 'toast toast--' + sev, role: 'status' }, [
      opts.who ? el('span', { class: 'toast__who', text: opts.who }) : null,
      el('span', { class: 'toast__text', text: String(text == null ? '' : text) })
    ]);
    root.appendChild(node);
    while (root.children.length > TOAST_MAX) root.removeChild(root.firstElementChild);
    const ms = num(opts.ms, sev === 'epic' ? 6000 : 4500);
    setTimeout(function () {
      node.classList.add('toast--out');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 320);
    }, ms);
    return node;
  }

  // ---------------------------------------------------------------- two-click confirm
  /**
   * Arms a button on first click ("Confirm?"), runs fn on the second click within ms.
   * Returns true when the action ran.
   */
  function confirmClick(btn, fn, ms) {
    if (btn.dataset.armed === '1') {
      clearTimeout(Number(btn.dataset.armTimer));
      btn.dataset.armed = '';
      btn.classList.remove('btn--armed');
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      fn();
      return true;
    }
    btn.dataset.label = btn.textContent;
    btn.dataset.armed = '1';
    btn.classList.add('btn--armed');
    btn.textContent = 'Confirm? ' + btn.dataset.label;
    btn.dataset.armTimer = String(setTimeout(function () {
      btn.dataset.armed = '';
      btn.classList.remove('btn--armed');
      btn.textContent = btn.dataset.label;
    }, ms || 4000));
    return false;
  }

  SD.ui.dom = {
    $: $, $$: $$, el: el, esc: esc, fmt: fmt, schedule: schedule, toast: toast,
    refs: refs, ev: ev, on: on, emit: emit, state: state, settings: settings, debugOn: debugOn, cfg: cfg,
    clamp: clamp, num: num, safeColor: safeColor, safeUrl: safeUrl, runnerVars: runnerVars, badgeHTML: badgeHTML,
    isRaceLocked: isRaceLocked, confirmClick: confirmClick, info: info, flush: flush
  };
})(globalThis.SD = globalThis.SD || {});
