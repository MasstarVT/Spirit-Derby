/* SPIRIT DERBY — main.js (browser boot)
 * persistence.load → state.set → game.init → init every panel whose root exists →
 * race:finished → results modal → keyboard shortcuts → ?overlay=1 → 30 s clock →
 * beforeunload flush → body[data-hype-tier] sync → debug error toasts.
 * Optional modules (commands, chat, leaderboards, integrations) are guarded.
 * M7: integrations init + auto-connect (settings.twitch/bridge.enabled or ?twitch= / ?bridge=).
 * M5: SD.achievements.init() after game.init, season summary panel, gold achievement toasts.
 * M6: shared UI prefs (SD.ui.dom.prefs), save flush on beforeunload / pagehide / hidden tab, roster
 *     reconciliation toast. SD.debug (js/debug.js) is the console toolbox.
 * Review batch 6: the save banner (a read-only second window with TAKE OVER, a held save that could not
 *     be loaded with DOWNLOAD / START NEW GAME), the writer-lock heartbeat + 'storage' listener, lock
 *     release on pagehide, save-failure / history-trim toasts, no auto-connect in a read-only window,
 *     and hidden panels re-rendered when a tab is selected or the overlay is turned off.
 */
(function (SD) {
  'use strict';

  SD.ui = SD.ui || {};
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
  // UI prefs (spiritderby.ui) via SD.ui.dom.prefs; chat.js and leaderboards.js share the same object.
  function readPrefs() { return SD.ui.dom && SD.ui.dom.prefs ? SD.ui.dom.prefs.read() : {}; }
  function writePrefs(patch) { if (SD.ui.dom && SD.ui.dom.prefs) SD.ui.dom.prefs.write(patch); }

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
    renderAll();                                    // panels skipped while hidden catch up
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
    renderAll();                                    // a panel that was hidden (Boards) renders now
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
    // Review batch 6: a window that does not save the game (another window does, or the stored save
    // could not be loaded) never connects to chat on its own: every command would run twice.
    if (SD.persistence && SD.persistence.role && SD.persistence.role() !== 'writer') return;
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

  // ------------------------------------------------------------------ entropy (review batch 5)
  // The core never touches crypto: it asks SD.entropy.next() for fresh randomness (the seed salt of
  // a new game, a new salt on every load / import and race start, and each training / !create / day
  // roll). Installed here, before boot creates or loads the game. crypto.getRandomValues works on
  // file:// and in OBS; the Math.random fallback (very old browsers only) is weaker but still keeps
  // the salt from being a hash of the creation time.
  function installEntropy() {
    if (!SD.entropy || typeof SD.entropy.set !== 'function') return;
    const c = typeof crypto !== 'undefined' ? crypto : (window.crypto || window.msCrypto);
    if (c && typeof c.getRandomValues === 'function') {
      const buf = new Uint32Array(1);
      SD.entropy.set(function () { c.getRandomValues(buf); return buf[0]; });
    } else {
      SD.entropy.set(function () { return ((Math.random() * 4294967296) ^ Date.now()) >>> 0; });
    }
  }
  installEntropy();

  // ------------------------------------------------------------------ save banner + writer lock (review batch 6)
  let bootParams = null;
  let bar = null;
  let forceNewGame = false;

  function saveBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'savebar';
    bar.setAttribute('role', 'alert');
    bar.hidden = true;
    bar.innerHTML = '<span class="savebar__text" data-ref="text"></span><span class="savebar__actions" data-ref="actions"></span>';
    bar.addEventListener('click', function (e) {
      const b = e.target.closest('button[data-bar]');
      if (b) barAction(b.getAttribute('data-bar'), b);
    });
    document.body.appendChild(bar);
    return bar;
  }

  function agoText(t) {
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 90 ? s + ' s ago' : Math.round(s / 60) + ' min ago';
  }

  // Show / hide the banner for the persistence role: reader (another window saves) or held.
  function renderSaveBar(status) {
    const P = SD.persistence;
    if (!P || typeof P.lockStatus !== 'function') return;
    status = status || P.lockStatus();
    const el = saveBar();
    const esc = SD.ui.dom.esc;
    let text = '', actions = '';
    if (status.role === 'reader') {
      text = '<b>👀 Read-only window.</b> ' + esc(status.message || 'Another Spirit Derby window is saving this game.') +
        (status.otherAt ? ' (It last checked in ' + esc(agoText(status.otherAt)) + '.)' : '') +
        ' Close this one, or take over if the other window is gone.';
      actions = '<button type="button" class="btn btn--sm" data-bar="takeover">TAKE OVER</button>';
    } else if (status.role === 'held') {
      text = '<b>⚠ Your saved game could not be loaded.</b> ' + esc(status.message || '') +
        ' It is kept untouched and this window saves nothing. Download it (a newer build of Spirit Derby can import it), or start a new game here' +
        (forceNewGame ? ': <b>there is no room to keep a copy in this browser, so download it first, or click START NEW GAME again to lose it.</b>' : ' (a copy is kept in spiritderby.rescue).');
      actions = '<button type="button" class="btn btn--sm" data-bar="download">⬇ DOWNLOAD SAVED GAME</button>' +
        '<button type="button" class="btn btn--sm" data-bar="newgame">START NEW GAME</button>';
    }
    // Text and buttons update separately: the "last checked" age changes every heartbeat, and
    // re-creating the buttons would disarm a TAKE OVER / START NEW GAME waiting for its confirm click.
    if (el.dataset.text !== text) { el.dataset.text = text; el.querySelector('[data-ref="text"]').innerHTML = text; }
    if (el.dataset.actions !== actions) { el.dataset.actions = actions; el.querySelector('[data-ref="actions"]').innerHTML = actions; }
    el.hidden = !text;
  }

  // Adopt a game loaded from storage (TAKE OVER), like an import does.
  function adopt(res, source) {
    SD.state.set(res.state);
    SD.game.init();
    if (SD.playback && SD.playback.stop) SD.playback.stop();
    SD.bus.emit(SD.EVENTS.STATE_LOADED, { source: source });
    SD.bus.emit(SD.EVENTS.STATE_CHANGED, { label: source });
  }

  function takeOver(auto) {
    const P = SD.persistence;
    let res = null;
    try { res = P.takeOver(); } catch (e) { console.error('[boot] take over failed', e); }
    if (!res || res.ok === false || !res.state) {
      SD.ui.dom.toast('Could not take over: ' + ((res && res.error) || 'see the console'), 'bad');
      return;
    }
    adopt(res, 'takeover');
    renderSaveBar();
    SD.ui.dom.toast(auto ? 'The other Spirit Derby window closed: this window saves the game now (reloaded from its last save).'
      : 'This window saves the game now (reloaded from the last save).', 'good', { ms: 7000 });
    autoConnect(bootParams);
  }

  function barAction(act, btn) {
    const P = SD.persistence;
    const dom = SD.ui.dom;
    if (act === 'takeover') {
      dom.confirmClick(btn, function () { takeOver(false); });
    } else if (act === 'download') {
      const text = (P.heldText && P.heldText()) || (P.readRescue && P.readRescue());
      if (text) { dom.download('spirit-derby-unreadable-save.json', text); dom.toast('Downloaded spirit-derby-unreadable-save.json', 'good'); }
      else dom.toast('There is no stored save to download.', 'info');
    } else if (act === 'newgame') {
      dom.confirmClick(btn, function () {
        const r = P.releaseHeld({ force: forceNewGame });
        if (!r.ok) {
          forceNewGame = true;
          renderSaveBar();
          dom.toast(r.error || 'Could not keep a copy of the old save.', 'bad', { ms: 9000 });
          return;
        }
        forceNewGame = false;
        renderSaveBar();
        dom.toast('New game started.' + (r.rescued ? ' The old save is kept in spiritderby.rescue (admin Save: RESCUE COPY).' : ''), 'good', { ms: 8000 });
        autoConnect(bootParams);
      });
    }
  }

  function installSaveGuards() {
    const P = SD.persistence;
    const dom = SD.ui.dom;
    if (!P || typeof P.heartbeat !== 'function') return;
    // A released lock (the saving window closed or is reloading) becomes free only after
    // CONFIG.LOCK.RELEASE_GRACE_MS: a reloading window claims it back first and stays the saving
    // window. st.freeIn says when to look again (before the next heartbeat).
    let recheck = null;
    const check = function () {
      let st;
      try { st = P.heartbeat(); } catch (e) { return; }
      if (st.role === 'reader' && st.free) { takeOver(true); return; }
      renderSaveBar(st);
      if (st.role === 'reader' && st.freeIn > 0 && !recheck) {
        recheck = setTimeout(function () { recheck = null; check(); }, st.freeIn + 250);
      }
    };
    const beat = Number(SD.CONFIG.LOCK && SD.CONFIG.LOCK.HEARTBEAT_MS) || 10000;
    setInterval(check, beat);
    // Another window wrote the save or the lock: react at once instead of at the next heartbeat.
    window.addEventListener('storage', function (e) {
      if (e.key === null || e.key === P.KEY || e.key === P.LOCK_KEY) check();
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) check(); });

    dom.on('STATE_READ_ONLY', function (st) {
      renderSaveBar();
      if (st && st.role === 'reader' && st.reason === 'other-window') {
        // This window stepped down: stop answering chat here (the other window does).
        const I = SD.integrations || {};
        ['twitch', 'bridge'].forEach(function (k) {
          try { if (I[k] && typeof I[k].disconnect === 'function') I[k].disconnect(); } catch (x) { /* ignore */ }
        });
      }
    });
    let lastFailToast = 0;
    dom.on('STATE_SAVE_FAILED', function (p) {
      const now = Date.now();
      if (now - lastFailToast < 60000) return;      // the header shows NOT SAVED meanwhile
      lastFailToast = now;
      dom.toast('⚠ The game could not be saved (' + String((p && p.error) || 'storage refused it').slice(0, 120) +
        '). Progress since the last save lives only in this window: use EXPORT JSON.', 'bad', { ms: 12000 });
    });
    let trimToasted = false;
    dom.on('STATE_SAVED', function (p) {
      lastFailToast = 0;
      const t = p && p.trimmed;
      // Once per session, and not for a routine trim (a long career at its steady size: the oldest
      // records go like HISTORY_MAX drops them). The game log keeps a line for every trim.
      if (t && t.races && !t.routine && !trimToasted) {
        trimToasted = true;
        dom.toast('The save was getting too big for browser storage: the oldest ' + t.races + ' race records were dropped to make room.', 'info', { ms: 8000 });
      }
    });
    renderSaveBar();
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
    bootParams = params;
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

    // 9. flush a pending (debounced) save when the page goes away. beforeunload alone is not enough:
    //    OBS / mobile browsers may skip it, so pagehide and the tab becoming hidden flush too
    //    (persistence.flush() only writes when something is pending).
    const flushSave = function () {
      try { if (SD.persistence && SD.persistence.flush) SD.persistence.flush(); } catch (e) { /* ignore */ }
    };
    window.addEventListener('beforeunload', flushSave);
    window.addEventListener('pagehide', function () {
      flushSave();
      // Review batch 6: the lock is marked released, so the next window (this one reloading, OBS
      // restarting the source) saves straight away; a read-only window waits RELEASE_GRACE_MS first.
      try { if (SD.persistence && SD.persistence.release) SD.persistence.release(); } catch (e) { /* ignore */ }
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushSave(); });

    // 10. body[data-hype-tier] + debug class
    ['HYPE_CHANGED', 'STATE_CHANGED', 'STATE_LOADED', 'SETTINGS_CHANGED'].forEach(function (k) { dom.on(k, syncBodyState); });
    syncBodyState();

    // 11. debug error toasts
    installErrorToasts();

    // 11b. review batch 6: writer lock heartbeat, save banner, save-failure toasts
    installSaveGuards();

    // 12. optional modules (later milestones) — guarded so M1 boots without them.
    // The chat panel (M2) enables its own tab in init(); open it by default unless the
    // streamer last picked another tab. Roster TRAIN/REST buttons keep calling SD.game
    // directly (by SD.players.STREAMER_KEY, the console's reserved actor); chat commands go
    // through SD.commands.handleChat.
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

    if (loaded && loaded.migratedFrom != null && !loaded.readOnly) {   // a read-only window upgrades in memory only
      dom.toast('Save upgraded from schema v' + loaded.migratedFrom + ' to v' + (SD.persistence ? SD.persistence.SCHEMA_VERSION : '?') +
        (loaded.backupFailed ? '. There was no room to keep a backup of the old save: EXPORT JSON keeps a copy.' : ' (a backup of the old save was kept).'),
        loaded.backupFailed ? 'bad' : 'info', { ms: 9000 });
    }
    // M6: runners added to SD.DATA.ROSTER since this save was made join the roster on load.
    if (loaded && loaded.rosterAdded && loaded.rosterAdded.length) {
      dom.toast('New in the roster: ' + loaded.rosterAdded.map(function (r) { return r.emoji + ' ' + r.name; }).join(', '), 'good', { ms: 7000 });
    }
    SD.ui.booted = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(globalThis.SD = globalThis.SD || {});
