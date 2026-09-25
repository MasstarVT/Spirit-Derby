/* SPIRIT DERBY — main.js (browser boot)
 * persistence.load → state.set → game.init → init every panel whose root exists →
 * race:finished → results modal → keyboard shortcuts → ?overlay=1 → 30 s clock →
 * beforeunload flush → body[data-hype-tier] sync → debug error toasts.
 * Optional modules (commands, chat, leaderboards, integrations) are guarded.
 * M7: integrations init + auto-connect (settings.twitch/bridge.enabled or ?twitch= / ?bridge=).
 * M5: SD.achievements.init() after game.init, season summary panel, gold achievement toasts.
 */
(function (SD) {
  'use strict';

  SD.ui = SD.ui || {};
  const UI_KEY = 'spiritderby.ui';
  const CLOCK_MS = 30000;
  // [SD.ui panel name, root selector] — panels whose root is missing (or module absent) are skipped.
  const PANELS = [
    ['header', '#header'],
    ['track', '#track'],
    ['results', '#results'],
    ['season', '#season'],             // M5: season summary modal (listens to season:ended itself)
    ['roster', '#roster'],
    ['chat', '#chat'],                 // M2
    ['leaderboards', '#boards'],       // M3 (enables the Boards tab in init)
    ['eventlog', '#eventlog'],
    ['admin', '#admin']
  ];
  const panels = [];

  // ------------------------------------------------------------------ UI prefs (spiritderby.ui)
  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writePrefs(patch) {
    try { localStorage.setItem(UI_KEY, JSON.stringify(Object.assign(readPrefs(), patch))); } catch (e) { /* private mode etc. */ }
  }

  // ------------------------------------------------------------------ boot error overlay
  function bootError(err) {
    console.error('[boot]', err);
    const box = document.createElement('div');
    box.className = 'boot-error';
    const inner = document.createElement('div');
    const title = document.createElement('p');
    title.textContent = '🌲 Spirit Derby could not start.';
    const pre = document.createElement('pre');
    pre.textContent = String((err && (err.stack || err.message)) || err);
    inner.appendChild(title);
    inner.appendChild(pre);
    box.appendChild(inner);
    document.body.appendChild(box);
  }

  // ------------------------------------------------------------------ overlay / admin drawer / tabs
  function setOverlay(on, opts) {
    on = !!on;
    document.body.classList.toggle('sd-overlay', on);
    if (on) setAdmin(false, { persist: !(opts && opts.persist === false) });
    const btn = document.querySelector('[data-action="overlay"]');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    if (!opts || opts.persist !== false) writePrefs({ overlay: on });
    window.dispatchEvent(new Event('resize'));     // track re-measures lane width
  }
  function toggleOverlay() { setOverlay(!document.body.classList.contains('sd-overlay')); }

  function setAdmin(open, opts) {
    open = !!open && !document.body.classList.contains('sd-overlay');
    document.body.classList.toggle('sd-admin-open', open);
    const drawer = document.getElementById('admin');
    if (drawer) drawer.setAttribute('aria-hidden', String(!open));
    const btn = document.querySelector('[data-action="admin"]');
    if (btn) btn.setAttribute('aria-pressed', String(open));
    if (!opts || opts.persist !== false) writePrefs({ adminOpen: open });
    if (open && SD.ui.admin && SD.ui.dom) SD.ui.dom.schedule(SD.ui.admin);
  }
  function toggleAdmin() { setAdmin(!document.body.classList.contains('sd-admin-open')); }

  function selectTab(name, opts) {
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs [data-tab]'));
    const target = tabs.filter(function (t) { return t.getAttribute('data-tab') === name && !t.disabled; })[0];
    if (!target) return false;
    tabs.forEach(function (t) {
      const on = t === target;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    if (!opts || opts.persist !== false) writePrefs({ tab: name });
    return true;
  }

  function renderAll() {
    if (!SD.ui.dom) return;
    panels.forEach(function (p) { SD.ui.dom.schedule(p); });
  }

  SD.ui.setOverlay = setOverlay;
  SD.ui.toggleOverlay = toggleOverlay;
  SD.ui.setAdmin = setAdmin;
  SD.ui.toggleAdmin = toggleAdmin;
  SD.ui.selectTab = selectTab;
  SD.ui.renderAll = renderAll;
  SD.ui.panels = panels;

  // ------------------------------------------------------------------ hype tier + debug class
  function syncBodyState() {
    const dom = SD.ui.dom;
    const s = dom && dom.state();
    if (!s) return;
    const tier = dom.info.hypeTier((s.hype && s.hype.value) || 0);
    const t = String(Math.max(0, Math.min(3, Number(tier) || 0)));
    if (document.body.getAttribute('data-hype-tier') !== t) document.body.setAttribute('data-hype-tier', t);
    document.body.classList.toggle('sd-debug', !!(s.settings && s.settings.debug));
  }

  // ------------------------------------------------------------------ keyboard
  function onKey(e) {
    if (e.defaultPrevented) return;
    const t = e.target;
    const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

    if (e.key === 'Escape') {
      if (SD.ui.results && SD.ui.results.isOpen && SD.ui.results.isOpen()) { SD.ui.results.close(); e.preventDefault(); return; }
      if (SD.ui.season && SD.ui.season.isOpen && SD.ui.season.isOpen()) { SD.ui.season.close(); e.preventDefault(); return; }
      if (document.body.classList.contains('sd-admin-open')) { setAdmin(false); e.preventDefault(); return; }
      if (typing && t.blur) t.blur();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === '`' || e.code === 'Backquote') {
      e.preventDefault();
      toggleAdmin();
    } else if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      toggleOverlay();
    } else if (e.key === ' ' || e.code === 'Space') {
      const s = SD.state.get();
      const cr = s && s.currentRace;
      if (!cr || !SD.game) return;
      e.preventDefault();
      if (cr.status === 'paused' && SD.game.resumeRace) SD.game.resumeRace();
      else if ((cr.status === 'running' || cr.status === 'countdown') && SD.game.pauseRace) SD.game.pauseRace();
    }
  }

  // ------------------------------------------------------------------ debug error toasts
  function installErrorToasts() {
    const dom = SD.ui.dom;
    let lastToast = 0;
    const report = function (msg) {
      if (!dom.debugOn()) return;
      const now = Date.now();
      if (now - lastToast < 800) return;       // don't flood the stream
      lastToast = now;
      dom.toast('⚠ ' + String(msg).slice(0, 220), 'bad', { ms: 7000 });
    };
    window.addEventListener('error', function (e) {
      report((e && e.message) || 'Script error');
    });
    window.addEventListener('unhandledrejection', function (e) {
      const r = e && e.reason;
      report((r && (r.message || r)) || 'Unhandled promise rejection');
    });
    // The bus catches listener exceptions and console.error()s them; surface those in debug too.
    const origError = console.error;
    console.error = function () {
      try {
        const first = arguments[0];
        const err = Array.prototype.slice.call(arguments).filter(function (a) { return a instanceof Error; })[0];
        report(err ? (typeof first === 'string' ? first + ' ' : '') + err.message : first);
      } catch (x) { /* never break logging */ }
      return origError.apply(console, arguments);
    };
  }

  // ------------------------------------------------------------------ M7 integrations: auto-connect
  // Saved flags: settings.twitch.enabled (+ .channel) and settings.bridge.enabled (+ .url), set by
  // the admin "Auto-connect on load" boxes. URL parameters override them for this window only
  // (nothing is saved), which is handy for an OBS browser source with its own storage:
  //   ?twitch=<channel>          read that channel's chat          ?twitch=0  never Twitch here
  //   ?bridge=1 | ?bridge=ws://… connect the bridge (saved URL)    ?bridge=0  never the bridge here
  //   ?connect=0                 no auto-connect at all in this window (e.g. a second tab)
  function autoConnect(params) {
    const I = SD.integrations;
    if (!I) return;
    const get = function (k) { try { return params ? params.get(k) : null; } catch (e) { return null; } };
    if (get('connect') === '0') return;
    const s = (SD.state.get() || {}).settings || {};
    const tw = s.twitch || {};
    const br = s.bridge || {};

    const twParam = get('twitch');
    const channel = twParam && twParam !== '0' ? twParam : (twParam !== '0' && tw.enabled ? tw.channel : '');
    if (I.twitch && channel) run('twitch', function () { return I.twitch.connect(channel, { auto: true }); });

    const brParam = get('bridge');
    let url = null;
    if (brParam && brParam !== '0') url = /^wss?:\/\//i.test(brParam) ? brParam : (br.url || '');
    else if (brParam !== '0' && br.enabled) url = br.url || '';
    if (I.bridge && url !== null) run('bridge', function () { return I.bridge.connect(url, { auto: true }); });

    function run(name, fn) {
      try {
        const res = fn();
        if (res && res.ok === false && SD.ui.dom) SD.ui.dom.toast('Auto-connect (' + name + '): ' + res.message, 'bad');
      } catch (e) {
        console.error('[boot] auto-connect ' + name + ' failed', e);
      }
    }
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    if (!SD.ui.dom) { bootError(new Error('js/ui/dom.js did not load.')); return; }
    if (!SD.state || !SD.game || !SD.bus) {
      bootError(new Error('Core modules failed to load (need SD.state, SD.game, SD.bus). Check the browser console for the first error.'));
      return;
    }
    const dom = SD.ui.dom;

    // 1. load saved (or fresh) state
    let loaded = null;
    try { loaded = SD.persistence && SD.persistence.load ? SD.persistence.load() : null; } catch (e) { console.error('[boot] load failed', e); }
    let state = loaded && typeof loaded === 'object' ? (loaded.state || (loaded.schemaVersion != null ? loaded : null)) : null;
    if (!state) state = SD.state.create();
    SD.state.set(state);

    // 2. game director (subscribes to race:playbackDone → finishRace) + achievements (M5, bus-driven)
    SD.game.init();
    if (SD.achievements && typeof SD.achievements.init === 'function') {
      try { SD.achievements.init(); } catch (e) { console.error('[boot] achievements failed to init', e); }
    }

    // 3. panels
    PANELS.forEach(function (pair) {
      const panel = SD.ui[pair[0]];
      const root = document.querySelector(pair[1]);
      if (!panel || !root || typeof panel.init !== 'function') return;
      try {
        panel.init(root);
        panels.push(panel);
      } catch (e) {
        console.error('[boot] panel "' + pair[0] + '" failed to init', e);
      }
    });

    // 4. results modal on race:finished
    dom.on('RACE_FINISHED', function (p) {
      if (SD.ui.results && typeof SD.ui.results.show === 'function') SD.ui.results.show(p);
    });
    // Starting the next race while the previous results are still up closes them.
    // A season summary that was already showing closes too; one still queued behind the results
    // modal appears when the results close, so it is never lost.
    dom.on('RACE_STARTED', function () {
      const seasonOpen = !!(SD.ui.season && SD.ui.season.isOpen && SD.ui.season.isOpen());
      if (SD.ui.results && SD.ui.results.isOpen && SD.ui.results.isOpen()) SD.ui.results.close();
      if (seasonOpen) SD.ui.season.close();
    });
    dom.on('STATE_LOADED', renderAll);
    // M5: gold toast for every achievement (race achievements also appear in the results modal).
    dom.on('ACHIEVEMENT_UNLOCKED', function (a) {
      if (!a) return;
      const node = dom.toast((a.icon || '🏅') + ' ' + (a.displayName || a.username) + ' unlocked ' + a.name + ' (+' + (a.sp || 0) + ' SP)', 'epic', { ms: 6500 });
      if (node && node.classList) node.classList.add('toast--achievement');
    });

    // 5. sidebar tabs
    const tablist = document.querySelector('.tabs');
    if (tablist) {
      tablist.addEventListener('click', function (e) {
        const tab = e.target.closest('[data-tab]');
        if (tab && !tab.disabled) selectTab(tab.getAttribute('data-tab'));
      });
    }

    // 6. keyboard shortcuts
    document.addEventListener('keydown', onKey);

    // 7. overlay (?overlay=1 wins over the saved pref) + drawer + tab prefs
    const prefs = readPrefs();
    let params = null;
    try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }
    const urlOverlay = params && params.get('overlay');
    if (urlOverlay === '1' || urlOverlay === 'true') setOverlay(true, { persist: false });
    else if (urlOverlay !== '0' && prefs.overlay) setOverlay(true, { persist: false });
    if (prefs.adminOpen && !document.body.classList.contains('sd-overlay')) setAdmin(true, { persist: false });
    if (!(prefs.tab && selectTab(prefs.tab, { persist: false }))) selectTab('log', { persist: false });

    // 8. passive clock (energy regen, fatigue decay, idle hype decay)
    const clockMs = Number(SD.CONFIG && SD.CONFIG.CLOCK_INTERVAL_MS) > 0 ? Number(SD.CONFIG.CLOCK_INTERVAL_MS) : CLOCK_MS;
    setInterval(function () {
      try { if (SD.game.tickClock) SD.game.tickClock(); } catch (e) { console.error('[clock] tickClock failed', e); }
    }, clockMs);

    // 9. flush pending save on unload
    window.addEventListener('beforeunload', function () {
      try { if (SD.persistence && SD.persistence.flush) SD.persistence.flush(); } catch (e) { /* ignore */ }
    });

    // 10. body[data-hype-tier] + debug class
    ['HYPE_CHANGED', 'STATE_CHANGED', 'STATE_LOADED', 'SETTINGS_CHANGED'].forEach(function (k) { dom.on(k, syncBodyState); });
    syncBodyState();

    // 11. debug error toasts
    installErrorToasts();

    // 12. optional modules (later milestones) — guarded so M1 boots without them.
    // The chat panel (M2) enables its own tab in init(); open it by default unless the
    // streamer last picked another tab. Roster TRAIN/REST buttons keep calling SD.game
    // directly (by 'streamer'); chat commands go through SD.commands.handleChat.
    if (SD.commands && SD.ui.chat && !(document.getElementById('tab-chat') || {}).disabled) {
      selectTab(prefs.tab || 'chat', { persist: false });
    }
    if (SD.integrations) {
      ['twitch', 'bridge'].forEach(function (k) {
        const mod = SD.integrations[k];
        if (mod && typeof mod.init === 'function') {
          try { mod.init(); } catch (e) { console.error('[boot] integration ' + k + ' failed', e); }
        }
      });
      // M7: auto-connect after the panels exist (the header dot and admin pills listen to
      // integration:status themselves).
      autoConnect(params);
    }

    if (loaded && loaded.migratedFrom != null) dom.toast('Save upgraded from version ' + loaded.migratedFrom + '.', 'info');
    SD.ui.booted = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(globalThis.SD = globalThis.SD || {});
