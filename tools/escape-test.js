#!/usr/bin/env node
/*
 * Spirit Derby - tools/escape-test.js (review batch 10: tools-tests#4)
 * The UI builds most views as HTML strings (about 40 innerHTML sinks). This suite boots the REAL page -
 * index.html's body, every js/ui module, the integrations and js/main.js - on a fake DOM whose
 * innerHTML setter PARSES the markup, and feeds every viewer-controlled string it can reach with
 * hostile values:
 *   - chat from the bridge (free-form display names and logins) and the console, command arguments,
 *     !create names, bets, cheers, ribbons (colours), a mod's !event;
 *   - an imported save whose runner names / emoji / species / personality / abilities / badge and
 *     ribbon colours / avatar URLs / owner labels / player display names / log lines / season history
 *     / bets were edited by hand;
 *   - the same values put straight into the live state (the UI's own escaping, without normalize);
 *   - integration status texts, a race with those runners (lanes, positions, ticker, results modal),
 *     a season summary, every leaderboard, the event log, the roster, the header and the admin drawer.
 * Every parsed fragment is checked: no element or attribute from a payload (<xss-…>, data-xss,
 * on*= handlers), no url( / expression( / javascript: in a style, no javascript: / vbscript: / non-image
 * data: URL in href / src, and the same for setAttribute / style.setProperty / style.cssText.
 * Sanity checks make sure the payloads really reached each panel (as text).
 *   A  dom.esc / safeColor / safeUrl / runnerVars / badgeHTML on hostile input
 *   B  boot the page; chat, commands and bridge / Twitch-style names
 *   C  a hand-edited imported save
 *   D  hostile values injected straight into the live state (no normalize)
 *   E  a race, the results modal, the season summary, leaderboards, admin drawer (debug on)
 *   F  every HTML builder called directly with every string field hostile (results, season summary, track
 *      lanes / positions / ticker / banners, leaderboard rows / history, roster card, event log, admin pickers /
 *      debug tables, chat rows / SEND AS, header day event)
 *   G  every sink stayed clean; payloads reached every panel as text
 *
 *   node tools/escape-test.js [--verbose]
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
// Payloads. Each one breaks out of a different context if it is not escaped:
//   text  -> an <xss…> element;   "…" / '…' attribute -> an attribute named xss… (or an element);
//   style -> url( ;   href / src -> javascript:
// NAME breaks all three of text, "…" and '…' in 17 characters (display names are cut at 25).
// =============================================================================
const P = {
  tag: '<xss-t onerror=alert(1)>',
  dq: '"><xss-d data-xss="1',
  sq: "'><xss-s data-xss='1",
  attr: '" data-xss="1" onmouseover="alert(2)',
  tick: '`${alert(3)}`',
  js: 'javascript:alert(4)'
};
const NAME = '<xss>\'xss=1"xss=2';
const LONG = NAME + P.tag + P.dq + P.sq + P.attr + P.tick;        // free-form fields
const COLOR = 'red;background:url(https://evil.example/x.png)';
const COLOR2 = '#fff" data-xss="1';
const MARK = 'xss';                                               // every payload element / attribute name starts with it

// =============================================================================
// Fake clock, timers, requestAnimationFrame
// =============================================================================
const BASE = 1767225600000;
let T = 0;
const queue = [];
let seq = 0;
function schedule(fn, ms, every) {
  const id = ++seq;
  queue.push({ id: id, at: T + Math.max(0, Number(ms) || 0), fn: fn, every: every });
  return id;
}
function unschedule(id) { const i = queue.findIndex(function (q) { return q.id === id; }); if (i >= 0) queue.splice(i, 1); }
function run(ms, stop) {
  const end = T + ms;
  let guard = 0;
  for (;;) {
    if (stop && stop()) return true;
    queue.sort(function (a, b) { return (a.at - b.at) || (a.id - b.id); });
    const q = queue[0];
    if (!q || q.at > end || guard++ > 2e6) break;
    queue.shift();
    T = Math.max(T, q.at);
    if (q.every) { q.at = T + q.every; queue.push(q); }
    q.fn(T);
  }
  T = end;
  return !!(stop && stop());
}

// Core first (SD.isNode stays true: no save timers; persistence uses its in-memory store).
const SD = require('./load-core.js');
SD.clock.set(function () { return BASE + T; });

globalThis.setTimeout = function (fn, ms) { return schedule(fn, ms); };
globalThis.clearTimeout = unschedule;
globalThis.setInterval = function (fn, ms) { const m = Math.max(1, Number(ms) || 1); return schedule(fn, m, m); };
globalThis.clearInterval = unschedule;
globalThis.requestAnimationFrame = function (fn) { return schedule(fn, 16); };
globalThis.cancelAnimationFrame = unschedule;
Object.defineProperty(globalThis, 'performance', { value: { now: function () { return T; } }, configurable: true, writable: true });
Date.now = function () { return BASE + T; };

// =============================================================================
// Sink checks
// =============================================================================
const violations = [];
let fragments = 0;
function where(el) {
  const parts = [];
  for (let n = el; n && n.tagName && parts.length < 4; n = n.parentNode) {
    parts.unshift(n.tagName.toLowerCase() + (n.getAttribute('id') ? '#' + n.getAttribute('id') : '') +
      (n.getAttribute('class') ? '.' + n.getAttribute('class').split(/\s+/).slice(0, 2).join('.') : ''));
  }
  return parts.join(' > ');
}
function badStyle(v) { return /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:/i.test(String(v)); }
function badUrl(v) {
  const s = String(v).trim();
  return /^(javascript|vbscript):/i.test(s) || (/^data:/i.test(s) && !/^data:image\//i.test(s));
}
function checkAttr(el, name, value, how) {
  const n = String(name).toLowerCase();
  if (n.indexOf('xss') >= 0) violations.push({ how: how, where: where(el), what: 'attribute ' + n });
  else if (/^on/.test(n)) violations.push({ how: how, where: where(el), what: 'event handler attribute ' + n + '=' + value });
  else if (n === 'style' && badStyle(value)) violations.push({ how: how, where: where(el), what: 'style ' + value });
  else if ((n === 'href' || n === 'src' || n === 'action' || n === 'formaction' || n === 'xlink:href') && badUrl(value)) {
    violations.push({ how: how, where: where(el), what: n + '=' + value });
  }
}
function checkTree(root, how) {
  (function walk(node) {
    node.childNodes.forEach(function (c) {
      if (c.nodeType !== 1) return;
      const tag = c.tagName.toLowerCase();
      if (tag.indexOf(MARK) === 0 || /^(script|iframe|object|embed|frame|frameset|base|meta|link|style)$/.test(tag)) {
        violations.push({ how: how, where: where(c), what: 'element <' + tag + '>' });
      }
      Object.keys(c.attributes).forEach(function (k) { checkAttr(c, k, c.attributes[k], how); });
      walk(c);
    });
  })(root);
}

// =============================================================================
// A small DOM that parses HTML
// =============================================================================
const VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
  });
}
function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

/** Parse an HTML fragment into nodes appended to parent (a browser-like tokenizer, enough for the UI). */
function parseInto(parent, html) {
  const stack = [parent];
  const top = function () { return stack[stack.length - 1]; };
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
      if (html[i + 1] === '/') {
        const m = /^<\/\s*([a-zA-Z][\w-]*)[^>]*>/.exec(html.slice(i));
        if (m) {
          const tag = m[1].toUpperCase();
          for (let k = stack.length - 1; k > 0; k--) if (stack[k].tagName === tag) { stack.length = k; break; }
          i += m[0].length;
          continue;
        }
      }
      const m = /^<([a-zA-Z][\w-]*)/.exec(html.slice(i));
      if (m) {
        const el = new El(m[1]);
        let k = i + m[0].length;
        // attributes
        for (;;) {
          while (k < n && /[\s/]/.test(html[k]) && !(html[k] === '/' && html[k + 1] === '>')) k++;
          if (k >= n || html[k] === '>' || (html[k] === '/' && html[k + 1] === '>')) break;
          const am = /^[^\s"'>\/=]+/.exec(html.slice(k));
          if (!am) { k++; continue; }
          const name = am[0].toLowerCase();
          k += am[0].length;
          while (k < n && /\s/.test(html[k])) k++;
          let value = '';
          if (html[k] === '=') {
            k++;
            while (k < n && /\s/.test(html[k])) k++;
            if (html[k] === '"' || html[k] === "'") {
              const q = html[k];
              const e = html.indexOf(q, k + 1);
              value = html.slice(k + 1, e < 0 ? n : e);
              k = e < 0 ? n : e + 1;
            } else {
              const vm = /^[^\s>]*/.exec(html.slice(k));
              value = vm[0];
              k += vm[0].length;
            }
          }
          if (!Object.prototype.hasOwnProperty.call(el.attributes, name)) el.attributes[name] = decode(value);
        }
        const selfClose = html[k] === '/';
        i = html.indexOf('>', k);
        i = i < 0 ? n : i + 1;
        el.syncFromAttrs();
        top().appendChild(el);
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'textarea') {
          const close = html.toLowerCase().indexOf('</' + tag, i);
          const raw = html.slice(i, close < 0 ? n : close);
          if (raw) el.appendChild(new Text(tag === 'textarea' ? decode(raw) : raw));
          i = close < 0 ? n : html.indexOf('>', close) + 1;
          continue;
        }
        if (!VOID[tag] && !selfClose) stack.push(el);
        continue;
      }
    }
    let e = html.indexOf('<', i + 1);
    if (html[i] !== '<') e = html.indexOf('<', i);
    if (e < 0) e = n;
    const text = html.slice(i, e);
    if (text) top().appendChild(new Text(decode(text)));
    i = e;
  }
}

// ---- selectors: compound (tag #id .class [a] [a="v"] :not()), descendant ' ' and child '>' combinators, ','
function splitTop(sel, ch) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (const c of sel) {
    if (q) { if (c === q) q = null; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ch && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function parseCompound(str) {
  const c = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:not\(((?:[^()]|\([^()]*\))*)\)|::?[\w-]+(?:\([^)]*\))?/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (m[1] && m[1] !== '*') c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push([m[4].toLowerCase(), m[5] !== undefined ? m[5] : m[6] !== undefined ? m[6] : m[7]]);
    else if (m[8] !== undefined) c.nots.push(parseSelector(m[8]));
  }
  return c;
}
function parseSelector(sel) {
  return splitTop(String(sel), ',').map(function (one) {
    const toks = one.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const parts = [];
    let comb = ' ';
    toks.forEach(function (t) {
      if (t === '>') { comb = '>'; return; }
      parts.push({ comb: comb, c: parseCompound(t) });
      comb = ' ';
    });
    return parts;
  });
}
function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (let i = 0; i < c.classes.length; i++) if (!el.classList.contains(c.classes[i])) return false;
  for (let i = 0; i < c.attrs.length; i++) {
    const v = el.getAttribute(c.attrs[i][0]);
    if (v === null || (c.attrs[i][1] !== undefined && v !== c.attrs[i][1])) return false;
  }
  for (let i = 0; i < c.nots.length; i++) if (matchList(el, c.nots[i])) return false;
  return true;
}
function matchParts(el, parts, idx) {
  if (!matchCompound(el, parts[idx].c)) return false;
  if (idx === 0) return true;
  const comb = parts[idx].comb;
  if (comb === '>') return matchParts(el.parentNode, parts, idx - 1);
  for (let a = el.parentNode; a && a.nodeType === 1; a = a.parentNode) if (matchParts(a, parts, idx - 1)) return true;
  return false;
}
function matchList(el, list) { return list.some(function (parts) { return matchParts(el, parts, parts.length - 1); }); }

class Text {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get nodeValue() { return this.data; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}
function kebab(k) { return k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }
function camel(k) { return k.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); }

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this.isContentEditable = false;
    const self = this;
    const styleProps = {};
    this.styleProps = styleProps;
    this.style = new Proxy({
      setProperty: function (k, v) { if (badStyle(v)) violations.push({ how: 'style.setProperty', where: where(self), what: k + ':' + v }); styleProps[k] = String(v); },
      removeProperty: function (k) { delete styleProps[k]; },
      getPropertyValue: function (k) { return styleProps[k] || ''; }
    }, {
      get: function (t, k) { return k in t ? t[k] : (styleProps[k] || ''); },
      set: function (t, k, v) {
        if (k === 'cssText' && badStyle(v)) violations.push({ how: 'style.cssText', where: where(self), what: String(v) });
        styleProps[k] = String(v);
        return true;
      }
    });
    this.dataset = new Proxy({}, {
      get: function (t, k) { if (typeof k !== 'string') return undefined; const v = self.getAttribute('data-' + kebab(k)); return v === null ? undefined : v; },
      set: function (t, k, v) { self.setAttribute('data-' + kebab(k), String(v)); return true; },
      deleteProperty: function (t, k) { self.removeAttribute('data-' + kebab(k)); return true; },
      has: function (t, k) { return self.getAttribute('data-' + kebab(k)) !== null; },
      ownKeys: function () { return Object.keys(self.attributes).filter(function (a) { return a.indexOf('data-') === 0; }).map(function (a) { return camel(a.slice(5)); }); },
      getOwnPropertyDescriptor: function (t, k) { const v = self.getAttribute('data-' + kebab(k)); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; }
    });
    this.classList = {
      list: function () { return (self.getAttribute('class') || '').split(/\s+/).filter(Boolean); },
      write: function (arr) { self.attributes.class = arr.join(' '); },
      add: function () { const l = this.list(); for (let i = 0; i < arguments.length; i++) if (l.indexOf(arguments[i]) < 0) l.push(arguments[i]); this.write(l); },
      remove: function () { const rm = Array.prototype.slice.call(arguments); this.write(this.list().filter(function (c) { return rm.indexOf(c) < 0; })); },
      contains: function (c) { return this.list().indexOf(c) >= 0; },
      toggle: function (c, force) { const on = force === undefined ? !this.contains(c) : !!force; if (on) this.add(c); else this.remove(c); return on; }
    };
  }
  syncFromAttrs() {
    if (this.tagName === 'INPUT' || this.tagName === 'OPTION' || this.tagName === 'BUTTON') this.value = this.attributes.value || '';
    if (this.tagName === 'INPUT' && this.attributes.checked !== undefined) this.checked = true;
  }
  // attributes
  setAttribute(k, v) {
    k = String(k).toLowerCase();
    v = String(v);
    checkAttr(this, k, v, 'setAttribute');
    this.attributes[k] = v;
    if (k === 'value') this.value = v;
  }
  getAttribute(k) { k = String(k).toLowerCase(); return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[String(k).toLowerCase()]; }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : !!force; if (on) this.attributes[k] = ''; else this.removeAttribute(k); return on; }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.attributes.id = String(v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.attributes.class = String(v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.attributes.hidden = ''; else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.attributes.disabled = ''; else this.removeAttribute('disabled'); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.attributes.type = String(v); }
  get href() { return this.getAttribute('href') || ''; }
  set href(v) { this.setAttribute('href', v); }
  get src() { return this.getAttribute('src') || ''; }
  set src(v) { this.setAttribute('src', v); }
  get tabIndex() { const t = this.getAttribute('tabindex'); return t !== null ? Number(t) : (/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(this.tagName) ? 0 : -1); }
  set tabIndex(v) { this.attributes.tabindex = String(v); }
  // tree
  get children() { return this.childNodes.filter(function (c) { return c.nodeType === 1; }); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get options() { return this.querySelectorAll('option'); }
  get selectedIndex() { return this.options.findIndex(function (o) { return o.selected; }); }
  appendChild(c) {
    if (c && c.isFragment) { c.childNodes.slice().forEach((x) => this.appendChild(x)); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  append() { for (let i = 0; i < arguments.length; i++) { const a = arguments[i]; this.appendChild(typeof a === 'string' ? new Text(a) : a); } }
  prepend() { for (let i = arguments.length - 1; i >= 0; i--) { const a = arguments[i]; this.insertBefore(typeof a === 'string' ? new Text(a) : a, this.childNodes[0] || null); } }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = this.childNodes.indexOf(ref);
    c.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  replaceChildren() { this.childNodes.slice().forEach((c) => this.removeChild(c)); this.append.apply(this, arguments); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  descendants() { const out = []; (function walk(n) { n.childNodes.forEach(function (c) { if (c.nodeType === 1) { out.push(c); walk(c); } }); })(this); return out; }
  querySelectorAll(sel) { const list = parseSelector(sel); return this.descendants().filter(function (n) { return matchList(n, list); }); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return matchList(this, parseSelector(sel)); }
  closest(sel) { const list = parseSelector(sel); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchList(n, list)) return n; return null; }
  // content
  get textContent() { return this.childNodes.map(function (c) { return c.textContent; }).join(''); }
  set textContent(v) { this.childNodes.slice().forEach((c) => this.removeChild(c)); if (String(v)) this.appendChild(new Text(v)); }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(v) {
    this.childNodes.slice().forEach((c) => this.removeChild(c));
    const html = String(v == null ? '' : v);
    if (!html) return;
    fragments++;
    parseInto(this, html);
    checkTree(this, 'innerHTML');
  }
  insertAdjacentHTML(pos, html) {
    const tmp = new El('div');
    tmp.innerHTML = html;
    tmp.childNodes.slice().forEach((c) => this.appendChild(c));
  }
  // events / focus / layout
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { const l = this.listeners[t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
  dispatchEvent(e) { (this.listeners[e.type] || []).slice().forEach((f) => f.call(this, e)); return true; }
  click() { dispatch(this, { type: 'click', detail: 1 }); }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  select() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 40, right: 800, bottom: 40 }; }
  get offsetWidth() { return 800; }
  get offsetHeight() { return 40; }
  get clientWidth() { return 800; }
  get clientHeight() { return 400; }
  get scrollHeight() { return 400; }
  get isFragment() { return false; }
}
class Fragment extends El {
  constructor() { super('#fragment'); }
  get isFragment() { return true; }
}
function serialize(n) {
  if (n.nodeType === 3) return escText(n.data);
  const tag = n.tagName.toLowerCase();
  const attrs = Object.keys(n.attributes).map(function (k) { return ' ' + k + '="' + escAttr(n.attributes[k]) + '"'; }).join('');
  if (VOID[tag]) return '<' + tag + attrs + '>';
  return '<' + tag + attrs + '>' + n.childNodes.map(serialize).join('') + '</' + tag + '>';
}
function dispatch(target, init) {
  const e = Object.assign({
    target: target, key: '', code: '', detail: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
    defaultPrevented: false, preventDefault: function () { this.defaultPrevented = true; }, stopPropagation: function () {}
  }, init);
  for (let n = target; n && n.listeners; n = n.parentNode) (n.listeners[e.type] || []).slice().forEach(function (f) { f.call(n, e); });
  (docListeners[e.type] || []).slice().forEach(function (f) { f(e); });
  return e;
}

const docListeners = {};
const html = new El('html');
const body = new El('body');
html.appendChild(body);
const document = {
  nodeType: 9,
  readyState: 'complete',
  visibilityState: 'visible',
  hidden: false,
  body: body,
  documentElement: html,
  activeElement: body,
  title: 'Spirit Derby',
  createElement: function (tag) { return new El(tag); },
  createTextNode: function (t) { return new Text(t); },
  createDocumentFragment: function () { return new Fragment(); },
  getElementById: function (id) { return body.descendants().filter(function (n) { return n.getAttribute('id') === id; })[0] || null; },
  querySelector: function (sel) { return html.querySelector(sel); },
  querySelectorAll: function (sel) { return html.querySelectorAll(sel); },
  addEventListener: function (t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
  removeEventListener: function () {}
};
globalThis.document = document;
globalThis.window = {
  location: { search: '', reload: function () {}, href: 'file:///index.html', protocol: 'file:' },
  addEventListener: function () {},
  removeEventListener: function () {},
  dispatchEvent: function () {},
  innerWidth: 1920,
  innerHeight: 1080
};
globalThis.Event = function (type) { this.type = type; };
globalThis.getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: null, userAgent: 'node' }, configurable: true, writable: true });

// The page: index.html's <body> (scripts are not run by the parser; they are required below).
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/i.exec(indexHtml)[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
parseInto(body, bodyHtml);
const bootViolations = violations.length;

// Load the UI in index.html's order (after the core, which load-core already loaded).
const scripts = [];
indexHtml.replace(/<script src="([^"]+)"><\/script>/g, function (m, src) { scripts.push(src); return m; });
const uiScripts = scripts.filter(function (s) { return !/^js\/[^/]+\.js$/.test(s) || s === 'js/main.js'; });
SD.testing.strictRandom = false;            // UI code (the demo bots) may use Math.random
SD.CONFIG.HYPE.GAINS.admin = 7;             // runners-data#6: the drawer's ADD HYPE reads it (checked in B)
uiScripts.forEach(function (f) { require(path.join(ROOT, f)); });

const dom = SD.ui.dom;
function S() { return SD.state.get(); }
function flush() { run(400); }
function textOf(sel) { const n = document.querySelector(sel); return n ? n.textContent : ''; }
function allText() { return body.textContent; }
function say(user, text, opts) {
  T += 11000;
  return SD.commands.handleChat(Object.assign({ username: user, displayName: user, text: text, source: 'bridge', isMod: false }, opts || {}));
}

// =============================================================================
section('A. dom.esc / safeColor / safeUrl / runnerVars / badgeHTML');
// =============================================================================
(function () {
  eq(dom.esc('<img src=x onerror=alert(1)>"\'`&'), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&#96;&amp;', 'esc encodes & < > " \' `');
  eq(dom.esc(null), '', 'esc(null) is empty');
  eq(dom.esc(12), '12', 'esc(number)');
  [COLOR, COLOR2, 'url(x)', 'expression(alert(1))', 'red !important', '#ff0000;x:y', 'rgb(1,2,3);background:url(x)', 'var(--x)', ' ', '', 5, null]
    .forEach(function (c) { eq(dom.safeColor(c), null, 'safeColor rejects ' + JSON.stringify(c)); });
  eq(dom.safeColor('#FF0000'), '#FF0000', 'safeColor keeps a hex colour');
  eq(dom.safeColor(' rgb(1, 2, 3) '), 'rgb(1, 2, 3)', 'safeColor keeps rgb()');
  eq(dom.safeColor('hsla(120, 50%, 50%, 0.5)'), 'hsla(120, 50%, 50%, 0.5)', 'safeColor keeps hsla()');
  eq(dom.safeColor('Teal'), 'teal', 'safeColor keeps a colour name');
  ['javascript:alert(1)', ' JavaScript:alert(1)', 'vbscript:x', 'data:text/html,<script>', '', '  ', null, 7]
    .forEach(function (u) { eq(dom.safeUrl(u), null, 'safeUrl rejects ' + JSON.stringify(u)); });
  eq(dom.safeUrl('img/moss.png'), 'img/moss.png', 'safeUrl keeps a relative image');
  eq(dom.safeUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA', 'safeUrl keeps a data:image URL');
  const vars = dom.runnerVars({ badgeColor: COLOR, ribbonColor: COLOR2 });
  eq(vars, '--badge:#5c8a4a;', 'runnerVars drops unsafe badge / ribbon colours');
  const tmp = new El('div');
  tmp.innerHTML = dom.badgeHTML({ emoji: P.tag + P.dq, badgeColor: COLOR, ribbonColor: 'gold', avatarUrl: P.js }, P.attr);
  const b = tmp.firstElementChild;
  ok(b && b.tagName === 'SPAN' && b.childNodes.length === 1 && b.childNodes[0].nodeType === 3, 'badgeHTML: one span with only text inside (the emoji)');
  eq(b && b.textContent, P.tag + P.dq, 'badgeHTML: the emoji is text');
  ok(b && b.getAttribute('class').indexOf(P.attr) >= 0 && b.getAttribute('data-xss') === null, 'badgeHTML: the class argument stays inside the attribute');
  ok(b && !/url\(/.test(b.getAttribute('style')), 'badgeHTML: no url( in its style');
})();

// =============================================================================
section('B. Boot the real page; hostile chat');
// =============================================================================
(function () {
  eq(bootViolations, 0, 'index.html itself parses clean');
  ok(SD.ui.booted === true, 'main.js booted every panel on the fake DOM');
  ['header', 'track', 'results', 'season', 'roster', 'chat', 'leaderboards', 'eventlog', 'admin'].forEach(function (p) {
    ok(SD.ui.panels.indexOf(SD.ui[p]) >= 0, 'panel ' + p + ' initialised');
  });
  flush();

  // Review batch 10 (runners-data#6): ADD HYPE is CONFIG.HYPE.GAINS.admin, not a hard-coded 25.
  const hypeBtn = document.querySelector('#admin [data-act="hype"]');
  ok(hypeBtn && hypeBtn.textContent.trim().slice(-11) === 'ADD HYPE +7', 'the ADD HYPE button shows CONFIG.HYPE.GAINS.admin', hypeBtn && hypeBtn.textContent);
  const h0 = S().hype.value;
  if (hypeBtn) hypeBtn.click();
  eq(Math.round((S().hype.value - h0) * 10) / 10, 7, 'ADD HYPE adds CONFIG.HYPE.GAINS.admin');
  SD.game.addHype(-h0 - 7, 'test');
  // A live CONFIG edit: the label follows on the next render, and 0 turns the button off (no +25 fallback).
  const bodyOpen = document.body.classList.contains('sd-admin-open');
  document.body.classList.add('sd-admin-open');
  SD.CONFIG.HYPE.GAINS.admin = 0;
  SD.ui.admin.render(S());
  ok(hypeBtn && hypeBtn.textContent.trim().slice(-11) === 'ADD HYPE +0' && hypeBtn.disabled === true,
    'GAINS.admin = 0: the button says +0 and is disabled', hypeBtn && hypeBtn.textContent);
  run(2000);
  const h1 = S().hype.value;
  if (hypeBtn) SD.ui.admin.run('hype');
  eq(S().hype.value, h1, 'GAINS.admin = 0: ADD HYPE adds nothing (no fallback to 25)');
  SD.CONFIG.HYPE.GAINS.admin = 11;
  SD.ui.admin.render(S());
  ok(hypeBtn && hypeBtn.textContent.trim().slice(-12) === 'ADD HYPE +11' && hypeBtn.disabled === false,
    'a live GAINS.admin edit reaches the label on the next render', hypeBtn && hypeBtn.textContent);
  run(2000);
  if (hypeBtn) hypeBtn.click();
  eq(Math.round((S().hype.value - h1) * 10) / 10, 11, 'label and amount agree after the edit');
  SD.game.addHype(-(S().hype.value - h1), 'test');
  SD.CONFIG.HYPE.GAINS.admin = 7;
  SD.ui.admin.render(S());
  if (!bodyOpen) document.body.classList.remove('sd-admin-open');

  // Bridge chat: free-form display names; logins stay what the bridge sends.
  const users = [
    ['evil1', NAME],
    ['evil2', NAME],
    ['evil3', NAME],
    ['evil4', NAME],
    ['evil5', NAME]
  ];
  users.forEach(function (u) {
    say(u[0], '!join', { displayName: u[1] });
    say(u[0], 'hello ' + LONG, { displayName: u[1] });
  });
  say('evil1', '!claim', { displayName: NAME });
  say('evil2', '!claim', { displayName: NAME });
  say('evil3', '!create ' + NAME, { displayName: NAME });
  say('evil4', '!create Moss' + NAME, { displayName: NAME });
  say('evil1', '!inspect ' + NAME, { displayName: NAME });
  say('evil1', '!train ' + NAME, { displayName: NAME });
  say('evil1', '!ribbon ' + COLOR, { displayName: NAME });
  say('evil1', '!ribbon ' + COLOR2, { displayName: NAME });
  say('evil2', '!bet ' + NAME + ' 10', { displayName: NAME });
  say('evil2', '!cheer ' + NAME, { displayName: NAME });
  say('evil5', '!help ' + NAME, { displayName: NAME });
  say('evil5', NAME + ' ' + P.js, { displayName: NAME });
  say('modx', '!event ' + NAME, { displayName: NAME, isMod: true });
  // The console (SEND AS) with a made-up viewer.
  SD.commands.handleChat({ username: 'consolefan', displayName: NAME, text: '!join', source: 'admin', isMod: false });
  flush();
  const feed = document.querySelector('#chat') ? document.querySelector('#chat').textContent : '';
  ok(feed.indexOf(NAME) >= 0 && feed.indexOf(NAME) >= 0, 'chat feed shows the payloads as text');
})();

// =============================================================================
section('C. A hand-edited imported save');
// =============================================================================
function hostileSave(base) {
  const st = JSON.parse(JSON.stringify(base));
  st.runners.forEach(function (r, i) {
    r.name = i % 2 ? NAME + i : NAME + i;
    r.emoji = i % 3 ? NAME : NAME;
    r.species = NAME;
    r.personality = LONG;
    r.description = LONG;
    r.badgeColor = i % 2 ? COLOR : COLOR2;
    r.ribbonColor = i % 2 ? COLOR2 : COLOR;
    r.avatarUrl = i % 2 ? P.js : 'data:text/html,<xss-u>';
    r.owner = NAME;
    if (r.ability) { r.ability.name = NAME; r.ability.desc = NAME; }
    r.mood = r.mood;                      // kept valid (moods are catalogue ids)
  });
  Object.keys(st.players).forEach(function (k) { st.players[k].displayName = NAME; });
  st.log = (st.log || []).concat([
    { at: BASE, text: LONG, severity: 'info', kind: 'system' },
    { at: BASE, text: NAME, severity: NAME, kind: NAME }
  ]);
  if (st.season) {
    st.season.history = (st.season.history || []).concat([{
      number: 0, championName: NAME, championOwner: NAME, championOwnerKey: 'evil1', mvpUsername: NAME, endedAt: BASE,
      runnerTable: [{ runnerId: st.runners[0].id, name: NAME, emoji: NAME, owner: NAME, wins: 1, races: 1, points: 3 }]
    }]);
  }
  return st;
}
(function () {
  flush();
  const json = SD.persistence.exportJSON ? SD.persistence.exportJSON(S()) : JSON.stringify(S());
  const edited = hostileSave(JSON.parse(json));
  const res = SD.persistence.importJSON(JSON.stringify(edited));
  ok(res && res.ok, 'the edited save imports', res && res.error);
  flush();
  ok(allText().indexOf(MARK) >= 0, 'imported payloads are on the page (as text)');
})();

// =============================================================================
section('D. Hostile values straight into the live state (no normalize)');
// =============================================================================
(function () {
  SD.state.mutate('escape-test', function (st) {
    st.runners.forEach(function (r, i) {
      r.name = i % 2 ? NAME + ' ' + i : NAME + ' ' + i;
      r.emoji = NAME;
      r.species = NAME;
      r.personality = LONG;
      r.description = LONG;
      r.badgeColor = COLOR;
      r.ribbonColor = COLOR2;
      r.avatarUrl = i % 2 ? P.js : 'data:text/html,<xss-u>';
      r.owner = NAME;
      r.condition = NAME;
      r.style = i % 2 ? r.style : NAME;
      r.ability = { id: NAME, name: NAME, desc: NAME };
    });
    Object.keys(st.players).forEach(function (k) { st.players[k].displayName = LONG; });
    st.season.activeDayEvent = NAME;
    st.log.push({ at: BASE + T, text: LONG, severity: NAME });
    st.settings.bridge = Object.assign({}, st.settings.bridge, { url: 'ws://x' + NAME });
    st.settings.twitch = Object.assign({}, st.settings.twitch, { channel: NAME });
  });
  SD.bus.emit(SD.EVENTS.STATE_LOADED, { source: 'escape-test' });
  SD.bus.emit(SD.EVENTS.STATE_CHANGED, { label: 'escape-test' });
  SD.bus.emit(SD.EVENTS.INTEGRATION_STATUS || 'integration:status', { id: 'bridge', status: 'error', message: LONG, lastError: LONG, url: P.js });
  SD.bus.emit(SD.EVENTS.INTEGRATION_STATUS || 'integration:status', { id: 'twitch', status: 'error', message: LONG, channel: NAME });
  SD.ui.setAdmin(true, { persist: false });
  ['chat', 'boards', 'log'].forEach(function (t) { SD.ui.selectTab(t, { persist: false }); flush(); });
  flush();
  ok(textOf('#roster').indexOf(MARK) >= 0, 'roster shows hostile runner names as text');
  ok(textOf('#track').indexOf(MARK) >= 0, 'the paddock shows them as text');
})();

// =============================================================================
section('E. A race, results, season summary, leaderboards, admin drawer');
// =============================================================================
(function () {
  SD.state.mutate('escape-test', function (st) {
    st.settings.debug = true;
    st.runners.forEach(function (r) { r.energy = r.maxEnergy; r.fatigue = 0; r.retired = false; });
  });
  flush();
  const st = SD.game.startRace();
  ok(st.ok, 'a race with the hostile runners starts', st.message);
  say('evil1', '!cheer ' + NAME, { displayName: NAME });
  run(300000, function () { return !S().currentRace; });
  ok(!S().currentRace, 'it finished through playback');
  flush();
  ok(SD.ui.results.isOpen(), 'the results modal is open');
  ok(textOf('#results').indexOf(MARK) >= 0, 'results show the hostile names as text');
  SD.ui.results.close();

  // A season summary with hostile names.
  SD.ui.season.enqueue({
    number: 9, championName: NAME, championOwner: NAME, championOwnerKey: 'evil1', mvpUsername: NAME, mvpDisplayName: NAME,
    runnerTable: S().runners.slice(0, 5).map(function (r, i) { return { runnerId: r.id, name: r.name, emoji: NAME, owner: NAME, wins: 5 - i, races: 5, points: 10 - i }; }),
    topPlayers: [{ username: 'evil1', displayName: NAME, sp: 10 }], achievements: [{ name: NAME, displayName: NAME }]
  });
  flush();
  ok(SD.ui.season.isOpen() && textOf('#season').indexOf(MARK) >= 0, 'the season summary shows them as text');
  SD.ui.season.close();

  // Every leaderboard, both scopes.
  const lb = SD.ui.leaderboards;
  SD.ui.selectTab('boards', { persist: false });
  (SD.leaderboards.CATEGORIES || []).forEach(function (c) {
    ['season', 'all'].forEach(function (scope) { if (typeof lb.select === 'function') lb.select(c.id || c.key || c, scope); flush(); });
  });
  ok(textOf('#boards').indexOf(MARK) >= 0, 'leaderboards show them as text');
  SD.ui.selectTab('log', { persist: false });
  flush();
  ok(textOf('#eventlog').indexOf(MARK) >= 0, 'the event log shows them as text');
  ok(textOf('#admin').length > 0, 'the admin drawer rendered');
  // A second race so the track re-renders lanes / positions with the ribbons on.
  SD.state.mutate('escape-test', function (s) { s.runners.forEach(function (r) { r.energy = r.maxEnergy; }); s.season.raceIndexInDay = 0; });
  const st2 = SD.game.startRace();
  if (ok(st2.ok, 'second race starts', st2.message)) {
    run(2500);
    ok(textOf('#track').indexOf(MARK) >= 0, 'lanes / positions show the names as text mid-race');
    SD.game.endRace();
    run(5000);
  }
  flush();
})();

// =============================================================================
section('F. Every HTML builder with every string field hostile');
// =============================================================================
// Values a save, the bridge or a future code path could put anywhere: the builders must escape them
// all, not only the ones the game happens to produce today.
(function () {
  const H = NAME;
  const HU = 'img/x.png" onerror="alert(1)';     // passes safeUrl (not javascript:), so esc() must hold it
  function html(s) { const d = new El('div'); d.innerHTML = s; return d; }
  const ent = function (i) {
    return { runnerId: H + i, name: H + i, emoji: H, avatarUrl: i ? HU : null, badgeColor: COLOR, ribbonColor: i ? COLOR2 : 'gold', ownerAtRace: H,
      style: H, level: H, lane: i + 1, odds: 2.5, perf: { START: 1 }, stamMax: H, wildRoll: H };
  };
  const rec = {
    id: H, seed: H, hash: H, engineVersion: H, trackName: H, distance: 1200, totalTicks: H, season: H, day: H, indexInDay: 1,
    hypeBefore: 10, hypeAfter: 20, entrants: [ent(0), ent(1), ent(2)],
    results: [0, 1, 2].map(function (i) {
      const s = {}; s[H] = 1; s.speed = 2;
      return { runnerId: H + i, place: i + 1, timeSec: 60 + i, margin: i, xp: 5, levelUps: 2, spOwner: 3, moodAfter: H, statChanges: s,
        abilityActivations: [{ id: H, text: H }] };
    }),
    events: [{ kind: 'finish', tick: 5, text: H, severity: 'epic' }, { kind: 'event', tick: 6, text: LONG, severity: H }],
    summary: { winnerName: H, upset: true, upsetOdds: 3, photoFinish: true, forestAwakened: true, eventsCount: 2, critsCount: 1 }
  };
  const payload = {
    record: rec, results: rec.results,
    bets: [{ won: true, displayName: H, username: H, amount: 5, runnerId: H + '0', runnerName: H, odds: 2, payout: 10 },
      { won: true, username: H, amount: 5, runnerId: 'nope', runnerName: H, odds: 2, payout: 10 }, { won: false, amount: 3 }],
    achievements: [{ icon: H, displayName: H, username: H, name: H, id: H, sp: 5 }],
    levelUps: [{ runnerId: H + '0', name: H, level: H }],
    payouts: [{ role: 'backer', runnerId: H + '0', amount: 5 }, { role: 'backer', runnerId: H + '1', amount: 7 }]
  };
  const before = violations.length;

  // results (show + the fallback level-up lines)
  SD.ui.results.show(payload);
  ok(textOf('#results').indexOf(H) >= 0, 'results: synthetic payload rendered');
  SD.ui.results.close();
  html(SD.ui.results.html(rec, rec.results, { payouts: [] }));

  // season summary
  const sum = {
    number: H, day: 3, championName: H, championRunnerId: H + '0', championOwner: H, championWins: 1, championXp: 5, mvpUsername: H, mvpSpEarned: 4,
    biggestUpset: { winnerEmoji: H, winnerName: H, odds: 3, upset: true, trackName: H, day: H },
    topHypeContributor: { displayName: H, username: H, hype: 4 }, achievementsCount: 1, totalRaces: 3, refundedBets: 1, refundedEffects: 2,
    runnerTable: [0, 1].map(function (i) {
      return { rank: i + 1, runnerId: H + i, name: H, emoji: H, avatarUrl: HU, owner: H, level: H, wins: 1, races: 1, podiums: 1, xp: 1,
        badgeColor: COLOR, ribbonColor: COLOR2 };
    })
  };
  html(SD.ui.season.html(sum));
  SD.ui.season.enqueue(sum);
  flush();
  ok(SD.ui.season.isOpen() && textOf('#season').indexOf(H) >= 0, 'season summary: synthetic summary rendered');
  SD.ui.season.close();

  // track: lanes, positions, sprites, ticker, idle ticker, banners
  const track = SD.ui.track;
  track.build(rec);
  track.onEvent({ kind: 'event', tick: 3, text: H, severity: H, runnerId: H + '0' });
  track.renderTicker(H);
  track.showBanner(H, H);
  ok(textOf('#track').indexOf(H) >= 0, 'track: synthetic record rendered');
  track.clearRace();
  track.renderTicker(H);
  track.renderIdleTicker({ log: [{ text: H, severity: H, t: H }, { text: LONG, severity: 'info', t: BASE }] });
  track.lastPaddock = '';
  flush();

  // leaderboards: rows of both kinds and the season history
  const lb = SD.ui.leaderboards;
  html(lb.rowHTML({ kind: 'runner', rank: 1, id: H, name: H, emoji: H, avatarUrl: HU, badgeColor: COLOR, ribbonColor: COLOR2, level: H, owner: H, value: 3, label: '3 ' + H }, { name: H }));
  html(lb.rowHTML({ kind: 'player', rank: 7, id: H, name: H, runnerName: H, runnerEmoji: H, value: 3, label: '3 ' + H }, { name: H }));
  lb.lastHistory = '';
  lb.renderHistory({ season: { history: [{ number: H, championEmoji: H, championName: H, championWins: H, championOwner: H, mvpUsername: H }] } });
  ok(textOf('#boards').indexOf(H) >= 0, 'leaderboards: synthetic history rendered');

  // roster card
  const r0 = JSON.parse(JSON.stringify(S().runners[0]));
  Object.assign(r0, { name: H, emoji: H, avatarUrl: HU, species: H, style: H, mood: H, condition: H, owner: H, personality: H,
    ability: { id: H, name: H, desc: H }, badgeColor: COLOR, ribbonColor: COLOR2, record: { wins: H, races: H }, totalXp: H });
  html(SD.ui.roster.bodyHTML(r0, true));
  r0.level = 20;
  html(SD.ui.roster.bodyHTML(r0, false));

  // event log: live rows and log rows
  const log = SD.ui.eventlog;
  log.onRaceEvent({ text: H, severity: H, tick: 2 });
  log.lastHTML = '';
  log.render({ log: [{ type: H, season: H, day: H, t: H, text: H, severity: H }] });
  ok(textOf('#eventlog').indexOf(H) >= 0, 'event log: synthetic rows rendered');

  // admin drawer: pickers, debug key/values and tables
  const adm = SD.ui.admin;
  const fake = {
    runners: [{ id: H, name: H, emoji: H, custom: true, retired: false, fatigue: H, energy: H, condition: H, mood: H }],
    players: {}, raceHistory: [rec], currentRace: null, settings: { debug: true }
  };
  fake.players[H] = { displayName: H, lastSeen: 5 };
  fake.players.plain = { displayName: 'Plain', lastSeen: 4 };
  adm.modRunnerKey = ''; adm.modPlayerKey = ''; adm.lastKv = ''; adm.lastTable = '';
  adm.renderModeration(fake);
  adm.renderDebug(fake, { debug: true, seedOverride: null });
  ok(textOf('#admin').indexOf(H) >= 0, 'admin: synthetic pickers / debug table rendered');

  // chat: user / reply / system rows and the SEND AS picker with a hostile login
  const chat = SD.ui.chat;
  chat.append({ kind: 'user', username: H, displayName: H, text: LONG, source: H, isMod: true });
  chat.append({ kind: 'reply', username: H, displayName: H, text: LONG, severity: H, ok: false });
  chat.append({ kind: 'system', text: LONG, severity: H });
  chat.noteSender(H, H);
  chat.senderKey = '';
  chat.fillSenders();
  ok(textOf('#chat').indexOf(H) >= 0, 'chat: synthetic rows and senders rendered');

  // header: an unknown day event id and hype thresholds with hostile text
  SD.state.mutate('escape-test', function (st) { st.season.activeDayEvent = H; });
  flush();
  ok(textOf('#header').indexOf(H) >= 0, 'header: an unknown day event id shows as text');

  eq(violations.slice(before), [], 'no sink let a synthetic hostile value through');
})();

// =============================================================================
section('G. Every sink stayed clean');
// =============================================================================
(function () {
  ok(fragments > 150, 'many HTML fragments were parsed and checked', fragments);
  const seen = {};
  const uniq = violations.filter(function (v) { const k = v.how + v.where + v.what; if (seen[k]) return false; seen[k] = true; return true; });
  eq(uniq.slice(0, 12), [], 'no payload became markup, an attribute, a handler, a style url( or a javascript: URL');
  if (uniq.length > 12) console.log('    … and ' + (uniq.length - 12) + ' more');
  // The payloads must have reached every panel, as text (otherwise the checks above prove nothing).
  ['#header', '#track', '#roster', '#chat', '#boards', '#eventlog', '#admin'].forEach(function (sel) {
    const t = textOf(sel);
    ok(t.indexOf(MARK) >= 0 || t.indexOf('data-xss') >= 0 || t.indexOf('url(') >= 0, sel + ' received payload text', t.slice(0, 120));
  });
})();

console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
