/* SPIRIT DERBY — ui/admin.js
 * Streamer drawer (⚙ button or backtick): RACE, WORLD, TUNING, DEBUG, SAVE, SEND AS sections
 * (+ a placeholder for TWITCH (M7)). SEND AS runs commands through SD.processCommand with
 * source 'admin' / isMod and shows the reply inline. All game changes go through SD.game.*
 * and SD.persistence.*; settings through SD.game.updateSettings(patch).
 * Destructive actions use a two-click "Confirm?" state (never window.confirm).
 * The DOM is built once in init(); render(state) only syncs values/enabled states and
 * never overwrites a control that currently has focus.
 * Panel contract: SD.ui.admin = { init(rootEl), render(state), destroy() }.
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const esc = dom.esc;
  const fmt = dom.fmt;

  const DISTANCES = [1200, 1600, 2000, 2400];
  const COUNTS = [4, 5, 6, 7, 8];
  const FREQS = [
    ['none', 'None'], ['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['chaos', 'Chaos']
  ];
  const BY = 'streamer';

  function opt(v, label) { return '<option value="' + esc(v) + '">' + esc(label) + '</option>'; }

  function rangeField(id, key, label, min, max, step) {
    return '<div class="adm-field"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input id="' + id + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '" data-set="' + key + '" data-type="float">' +
      '<output data-out="' + key + '" for="' + id + '"></output></div>';
  }
  function check(key, label) {
    return '<label class="adm-check"><input type="checkbox" data-set="' + key + '" data-type="bool"> ' + esc(label) + '</label>';
  }

  function template() {
    return '' +
      '<div class="admin__head">' +
        '<h2 class="admin__title">⚙ Streamer Controls</h2>' +
        '<span class="admin__status" data-ref="status">No race</span>' +
        '<button type="button" class="btn btn--sm btn--ghost" data-act="close" title="Close (Esc)" aria-label="Close streamer controls">✕</button>' +
      '</div>' +
      '<div class="admin__body">' +

        // ---------------- RACE
        '<details class="adm-sec" open><summary>🏁 Race</summary><div class="adm-sec__body">' +
          '<div class="adm-row adm-row--2">' +
            '<button type="button" class="btn btn--gold" data-act="start" data-ref="btnStart">▶ START RACE</button>' +
            '<button type="button" class="btn btn--danger" data-act="end" data-ref="btnEnd">⏭ END RACE</button>' +
          '</div>' +
          '<div class="adm-row adm-row--2">' +
            '<button type="button" class="btn" data-act="pause" data-ref="btnPause">⏸ PAUSE</button>' +
            '<button type="button" class="btn" data-act="resume" data-ref="btnResume">⏵ RESUME</button>' +
          '</div>' +
          '<div class="adm-field adm-field--2"><label for="adm-distance">Distance</label>' +
            '<select id="adm-distance" class="field" data-set="distance" data-type="int">' +
              DISTANCES.map(function (d) { return opt(d, d + ' m'); }).join('') + '</select></div>' +
          '<div class="adm-field adm-field--2"><label for="adm-count">Runners</label>' +
            '<select id="adm-count" class="field" data-set="runnerCount" data-type="int">' +
              COUNTS.map(function (c) { return opt(c, c + ' runners'); }).join('') + '</select></div>' +
          '<p class="adm-note"><span class="kbd">Space</span> pauses/resumes · END plays out the result instantly.</p>' +
        '</div></details>' +

        // ---------------- WORLD
        '<details class="adm-sec" open><summary>🌲 World</summary><div class="adm-sec__body">' +
          '<div class="adm-field adm-field--2"><label for="adm-event">Day event</label>' +
            '<select id="adm-event" class="field" data-ref="eventSel"></select></div>' +
          '<div class="adm-row adm-row--2">' +
            '<button type="button" class="btn btn--primary" data-act="trigger" data-ref="btnTrigger">🎲 TRIGGER EVENT</button>' +
            '<button type="button" class="btn" data-act="hype">🔥 ADD HYPE +25</button>' +
          '</div>' +
          '<div class="adm-row">' +
            '<input type="text" class="field" data-ref="spawnName" placeholder="New runner name (optional)" maxlength="24" style="flex:1 1 180px" aria-label="New runner name">' +
            '<button type="button" class="btn" data-act="spawn">✨ SPAWN RUNNER</button>' +
          '</div>' +
          '<div class="adm-row adm-row--2">' +
            '<button type="button" class="btn" data-act="nextday" data-ref="btnNextDay">☀ NEXT DAY</button>' +
            '<button type="button" class="btn btn--danger" data-act="resetday" data-ref="btnResetDay" data-confirm>↺ RESET DAY</button>' +
          '</div>' +
          '<div class="adm-row adm-row--2">' +
            '<button type="button" class="btn btn--danger" data-act="resetseason" data-ref="btnResetSeason" data-confirm>RESET SEASON</button>' +
            '<button type="button" class="btn btn--danger" data-act="resetall" data-ref="btnResetAll" data-confirm>RESET ALL</button>' +
          '</div>' +
          '<p class="adm-note">Resets need a second click to confirm. They are disabled while a race runs.</p>' +
        '</div></details>' +

        // ---------------- TUNING
        '<details class="adm-sec"><summary>🎛 Tuning</summary><div class="adm-sec__body">' +
          '<div class="adm-field adm-field--2"><label for="adm-freq">Event frequency</label>' +
            '<select id="adm-freq" class="field" data-set="eventFrequency">' +
              FREQS.map(function (f) { return opt(f[0], f[1]); }).join('') + '</select></div>' +
          rangeField('adm-hm', 'hypeMultiplier', 'Hype multiplier', 0.5, 3, 0.25) +
          rangeField('adm-ps', 'playbackSpeed', 'Playback speed', 0.5, 3, 0.25) +
          rangeField('adm-fs', 'finalStretchSpeedup', 'Final-stretch speedup', 1, 3, 0.25) +
          '<div class="adm-field adm-field--2"><label for="adm-cd">User cooldown (s)</label>' +
            '<input id="adm-cd" type="number" class="field" min="0" max="600" step="1" data-set="userCooldownS" data-type="int"></div>' +
          check('openTraining', 'Open training (anyone may train any runner)') +
          check('allowCreate', 'Allow !create when no runner is free') +
          check('autoAdvanceDay', 'Auto-advance the day after the last race') +
        '</div></details>' +

        // ---------------- DEBUG
        '<details class="adm-sec"><summary>🐞 Debug</summary><div class="adm-sec__body">' +
          check('debug', 'Debug mode (hidden events, perf table, error toasts)') +
          '<div class="adm-field adm-field--2"><label for="adm-seed">Seed override</label>' +
            '<div class="adm-row"><input id="adm-seed" type="text" class="field" data-ref="seed" placeholder="12345 or 0x3039" style="flex:1 1 120px">' +
            '<button type="button" class="btn btn--sm" data-act="clearseed">Clear</button></div></div>' +
          '<div class="adm-row"><button type="button" class="btn" data-act="replay" data-ref="btnReplay">⟲ REPLAY LAST RACE</button>' +
            '<span class="adm-note" data-ref="replay"></span></div>' +
          '<dl class="adm-kv" data-ref="kv"></dl>' +
          '<div class="adm-table-wrap" data-ref="debugTable"></div>' +
        '</div></details>' +

        // ---------------- SAVE
        '<details class="adm-sec"><summary>💾 Save</summary><div class="adm-sec__body">' +
          '<div class="adm-row adm-row--2">' +
            '<button type="button" class="btn" data-act="export">⬇ EXPORT JSON</button>' +
            '<button type="button" class="btn" data-act="import" data-ref="btnImport">⬆ IMPORT JSON</button>' +
          '</div>' +
          '<input type="file" accept=".json,application/json" data-ref="file" hidden>' +
          '<div class="adm-row"><span class="adm-save" data-ref="saveInd">Autosave on</span>' +
            '<button type="button" class="btn btn--sm" data-act="savenow" style="margin-left:auto">Save now</button></div>' +
          '<p class="adm-note">Stored in this browser (<b>spiritderby.save</b>). Import replaces the current game; a backup copy is kept.</p>' +
        '</div></details>' +

        // ---------------- SEND AS (M2): streamer/mod command through SD.processCommand
        '<details class="adm-sec"><summary>💬 Send as</summary><div class="adm-sec__body">' +
          '<div class="adm-field adm-field--2"><label for="adm-sendas">Sender</label>' +
            '<select id="adm-sendas" class="field" data-ref="sendAs"></select></div>' +
          '<div class="adm-row"><input type="text" class="field" data-ref="sendText" placeholder="!race" maxlength="300" spellcheck="false" ' +
              'style="flex:1 1 180px" aria-label="Command to send">' +
            '<button type="button" class="btn btn--primary" data-act="send" data-ref="btnSend">SEND</button></div>' +
          '<p class="adm-reply" data-ref="sendReply" aria-live="polite"></p>' +
          '<p class="adm-note">Runs through <b>SD.processCommand</b> with streamer/mod rights (source <b>admin</b>: no cooldowns, may train any runner). ' +
            'The sender still needs to have typed <b>!join</b> for player commands.</p>' +
        '</div></details>' +

        // ---------------- TWITCH (M7 placeholder)
        '<!-- M7: TWITCH — anonymous read-only IRC + local bridge -->' +
        '<details class="adm-sec adm-sec--soon"><summary>📡 Twitch <span class="adm-sec__tag">M7</span></summary><div class="adm-sec__body">' +
          '<p class="adm-note">Read-only Twitch chat (anonymous) and a local WebSocket bridge for Mix It Up / Streamer.bot arrive in Milestone 7. Off by default.</p>' +
          '<div class="adm-row"><input type="text" class="field" disabled placeholder="channel" style="flex:1" aria-label="Twitch channel (coming in M7)">' +
            '<button type="button" class="btn" disabled>CONNECT</button></div>' +
        '</div></details>' +
      '</div>';
  }

  const admin = {
    name: 'admin',
    root: null,
    refs: {},
    offs: [],
    replayText: '',
    replayOk: null,
    saveTimer: 0,
    eventListKey: '',
    sendAsKey: '',
    lastKv: null,
    lastTable: '',

    init: function (root) {
      const self = this;
      this.root = root;
      root.innerHTML = template();
      this.refs = dom.refs(root);
      this.fillEventSelect();

      root.addEventListener('click', function (e) { self.onClick(e); });
      root.addEventListener('change', function (e) { self.onChange(e); });
      root.addEventListener('input', function (e) { self.onInput(e); });
      root.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target === self.refs.spawnName) { e.preventDefault(); self.run('spawn'); }
        if (e.key === 'Enter' && e.target === self.refs.sendText) { e.preventDefault(); self.run('send'); }
      });

      const rerender = function () { dom.schedule(self); };
      ['STATE_LOADED', 'SETTINGS_CHANGED', 'RACE_STARTED', 'RACE_PAUSED', 'RACE_RESUMED', 'RACE_FINISHED',
        'RACE_ABORTED', 'RACE_COUNTDOWN', 'EVENT_DAY', 'SEASON_DAY_ADVANCED']
        .forEach(function (k) { self.offs.push(dom.on(k, rerender)); });
      this.offs.push(dom.on('STATE_CHANGED', function () { self.markSaving(); dom.schedule(self); }));

      const s = dom.state();
      if (s) this.render(s);
    },

    destroy: function () {
      this.offs.forEach(function (off) { off(); });
      this.offs = [];
      clearTimeout(this.saveTimer);
    },

    fillEventSelect: function () {
      const sel = this.refs.eventSel;
      if (!sel) return;
      const list = (SD.DATA && SD.DATA.DAY_EVENTS) || [];
      const key = list.map(function (e) { return e.id; }).join('|');
      if (key === this.eventListKey && sel.options.length) return;
      this.eventListKey = key;
      sel.innerHTML = opt('', '🎲 Random event') + list.map(function (e) {
        return opt(e.id, (e.emoji ? e.emoji + ' ' : '') + (e.name || e.id));
      }).join('');
    },

    // ---------------------------------------------------------------- helpers
    /** Call SD.game[method](...args). Toasts failures; returns { ok, res }. */
    call: function (method, args) {
      const fn = SD.game && SD.game[method];
      if (typeof fn !== 'function') { dom.toast('SD.game.' + method + ' is not available yet.', 'bad'); return { ok: false }; }
      let res;
      try { res = fn.apply(SD.game, args || []); } catch (e) {
        console.error('[admin] ' + method + ' failed', e);
        dom.toast((e && e.message) || (method + ' failed.'), 'bad');
        return { ok: false };
      }
      if (res && typeof res === 'object' && res.ok === false) {
        dom.toast(res.message || res.error || 'That action was refused.', 'bad');
        return { ok: false, res: res };
      }
      return { ok: true, res: res };
    },

    parseSeed: function () {
      const input = this.refs.seed;
      const v = input ? input.value.trim() : '';
      if (!v) return null;
      let n = null;
      if (/^0x[0-9a-f]+$/i.test(v)) n = parseInt(v, 16);
      else if (/^\d+$/.test(v)) n = parseInt(v, 10);
      else if (SD.rng && typeof SD.rng.hash === 'function') n = SD.rng.hash(v);
      if (n == null || !isFinite(n)) { dom.toast('Seed override must be a number (or text when SD.rng.hash exists).', 'bad'); return undefined; }
      return n >>> 0;
    },

    lastRecord: function (state) {
      if (state.currentRace && state.currentRace.record) return state.currentRace.record;
      const h = state.raceHistory || [];
      return h.length ? h[h.length - 1] : null;
    },

    // ---------------------------------------------------------------- events
    onClick: function (e) {
      const self = this;
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled || !this.root.contains(btn)) return;
      const act = btn.getAttribute('data-act');
      if (btn.hasAttribute('data-confirm')) {
        dom.confirmClick(btn, function () { self.run(act); });
        return;
      }
      this.run(act);
    },

    run: function (act) {
      const s = dom.state() || {};
      const settings = s.settings || {};
      let r;
      switch (act) {
        case 'close':
          if (SD.ui.setAdmin) SD.ui.setAdmin(false);
          break;
        case 'start': {
          const seed = this.parseSeed();
          if (seed === undefined) return;
          const opts = { distance: Number(settings.distance) || 1200, runnerCount: Number(settings.runnerCount) || 4 };
          if (seed != null) opts.seed = seed;
          this.call('startRace', [opts]);
          break;
        }
        case 'pause': this.call('pauseRace'); break;
        case 'resume': this.call('resumeRace'); break;
        case 'end': this.call('endRace'); break;
        case 'trigger': {
          const id = this.refs.eventSel && this.refs.eventSel.value;
          r = this.call('triggerDayEvent', id ? [id] : []);
          if (r.ok) {
            const ev = r.res && (r.res.event || r.res);
            if (ev && (ev.name || ev.id)) dom.toast('Day event: ' + (ev.name || ev.id), 'epic');
            else dom.toast('Could not trigger that day event.', 'bad');   // core returns null for unknown ids
          }
          break;
        }
        case 'hype':
          r = this.call('addHype', [25, BY]);
          if (r.ok) dom.toast('🔥 Hype +25', 'good');
          break;
        case 'spawn': {
          const input = this.refs.spawnName;
          const name = input ? input.value.trim() : '';
          r = this.call('spawnRunner', [name ? { name: name } : {}]);
          if (r.ok) {
            const runner = r.res && (r.res.runner || r.res);
            if (runner && runner.name) {
              dom.toast(runner.name + ' wandered out of the forest!', 'good');
              if (input) input.value = '';
            } else {
              dom.toast('Could not spawn a runner.', 'bad');
            }
          }
          break;
        }
        case 'nextday':
          r = this.call('nextDay');
          if (r.ok) dom.toast((r.res && r.res.message) || '☀ A new day dawns in the forest.', 'good');
          break;
        case 'resetday':
          r = this.call('resetDay');
          if (r.ok) dom.toast((r.res && r.res.message) || 'Day reset.', 'info');
          break;
        case 'resetseason':
          r = this.call('resetSeason');
          if (r.ok) dom.toast((r.res && r.res.message) || 'Season reset.', 'info');
          break;
        case 'resetall':
          r = this.call('resetAll');
          if (r.ok) {
            if (SD.playback && SD.playback.stop) SD.playback.stop();
            if (SD.ui.renderAll) SD.ui.renderAll();
            dom.toast((r.res && r.res.message) || 'Everything reset. A fresh forest awaits.', 'info');
          }
          break;
        case 'clearseed':
          if (this.refs.seed) this.refs.seed.value = '';
          break;
        case 'replay': this.replay(); break;
        case 'send': this.sendAs(); break;
        case 'export': this.exportSave(); break;
        case 'import':
          if (this.refs.file) this.refs.file.click();
          break;
        case 'savenow':
          if (SD.persistence && typeof SD.persistence.save === 'function') {
            try { SD.persistence.save(true); this.markSaved(); dom.toast('Game saved.', 'good'); } catch (e) { dom.toast('Save failed: ' + e.message, 'bad'); }
          } else dom.toast('Persistence is not available.', 'bad');
          break;
        default: break;
      }
      dom.schedule(this);
    },

    onChange: function (e) {
      const t = e.target;
      if (t === this.refs.file) { this.importFile(t.files && t.files[0]); return; }
      const key = t.getAttribute('data-set');
      if (!key) return;
      const type = t.getAttribute('data-type');
      let v;
      if (type === 'bool') v = !!t.checked;
      else if (type === 'int') v = parseInt(t.value, 10);
      else if (type === 'float') v = parseFloat(t.value);
      else v = t.value;
      if ((type === 'int' || type === 'float') && !isFinite(v)) return;
      const patch = {};
      patch[key] = v;
      this.call('updateSettings', [patch]);
      dom.schedule(this);
    },

    onInput: function (e) {
      const t = e.target;
      if (t.type !== 'range') return;
      const out = this.root.querySelector('output[data-out="' + t.getAttribute('data-set') + '"]');
      if (out) out.textContent = Number(t.value).toFixed(2).replace(/\.?0+$/, '') + '×';
    },

    replay: function () {
      const fn = SD.game && SD.game.replayLastRace;
      if (typeof fn !== 'function') { dom.toast('Replay is not available yet.', 'bad'); return; }
      let res;
      try { res = fn.call(SD.game); } catch (e) { res = { ok: false, message: e.message }; }
      if (!res || res.ok === false) {
        this.replayOk = null;
        this.replayText = (res && (res.message || res.error)) || 'Nothing to replay yet.';
      } else {
        this.replayOk = !!res.sameHash;
        this.replayText = res.sameHash ? '✓ sameHash: true' : '✗ sameHash: false — determinism broken!';
        dom.toast(this.replayText, res.sameHash ? 'good' : 'bad');
      }
      dom.schedule(this);
    },

    // SEND AS: run a command through the real pipeline with streamer/mod rights.
    sendAs: function () {
      const r = this.refs;
      const out = r.sendReply;
      const show = function (text, sv) {
        if (!out) return;
        out.textContent = text;
        out.className = 'adm-reply sev-' + (({ info: 1, good: 1, bad: 1, epic: 1 })[sv] ? sv : 'info');
      };
      if (typeof SD.processCommand !== 'function') { show('The command pipeline (js/commands.js) is not loaded.', 'bad'); return; }
      const text = r.sendText ? r.sendText.value.trim() : '';
      if (!text) { if (r.sendText) r.sendText.focus(); return; }
      const name = (r.sendAs && r.sendAs.value) || 'Streamer';
      let res;
      try {
        res = SD.processCommand(name, text, { source: 'admin', isMod: true, displayName: name });
      } catch (e) {
        console.error('[admin] SEND AS failed', e);
        res = { ok: false, isCommand: true, message: (e && e.message) || 'Command failed.' };
      }
      if (!res) show('↳ No response.', 'bad');
      else if (!res.isCommand) show(res.ok ? '↳ Sent to chat as ' + name + ' (not a command).' : '↳ ' + res.message, res.ok ? 'info' : 'bad');
      else show('↳ @' + name + ' ' + res.message, res.severity || (res.ok ? 'good' : 'bad'));
      if (r.sendText) { r.sendText.value = ''; r.sendText.focus(); }
    },

    // Sender list: Streamer, Mod, then the most recently active viewers.
    fillSendAs: function (state) {
      const sel = this.refs.sendAs;
      if (!sel) return;
      const players = Object.keys(state.players || {}).map(function (k) { return state.players[k]; })
        .sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); })
        .map(function (p) { return p.displayName || p.username; })
        .filter(function (n) { return n && n.toLowerCase() !== 'streamer' && n.toLowerCase() !== 'mod'; })
        .slice(0, 12);
      const names = ['Streamer', 'Mod'].concat(players);
      const key = names.join('|');
      if (key === this.sendAsKey || document.activeElement === sel) return;
      this.sendAsKey = key;
      const prev = sel.value || 'Streamer';
      sel.innerHTML = names.map(function (n) {
        return opt(n, n === 'Streamer' ? '🎙 Streamer' : (n === 'Mod' ? '🛡 Mod' : n));
      }).join('');
      sel.value = names.indexOf(prev) >= 0 ? prev : 'Streamer';
    },

    exportSave: function () {
      if (!SD.persistence || typeof SD.persistence.exportJSON !== 'function') { dom.toast('Export is not available.', 'bad'); return; }
      let text;
      try { text = SD.persistence.exportJSON(); } catch (e) { dom.toast('Export failed: ' + e.message, 'bad'); return; }
      if (typeof text !== 'string') text = JSON.stringify(text, null, 2);
      const s = dom.state() || {};
      const season = s.season || {};
      const name = 'spirit-derby-s' + (season.number || 1) + '-d' + (season.day || 1) + '.json';
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = dom.el('a', { href: url, download: name, style: 'display:none' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      dom.toast('Exported ' + name, 'good');
    },

    importFile: function (file) {
      const self = this;
      if (!file) return;
      if (!SD.persistence || typeof SD.persistence.importJSON !== 'function') { dom.toast('Import is not available.', 'bad'); return; }
      const reader = new FileReader();
      reader.onload = function () {
        let res;
        try { res = SD.persistence.importJSON(String(reader.result || '')); } catch (e) { res = { ok: false, error: e.message }; }
        if (res && res.ok) {
          if (SD.playback && SD.playback.stop) SD.playback.stop();
          if (SD.ui.renderAll) SD.ui.renderAll();
          dom.toast('Save imported — welcome back to the forest.', 'good');
        } else {
          dom.toast('Import failed: ' + ((res && (res.error || res.message)) || 'not a Spirit Derby save'), 'bad');
        }
        if (self.refs.file) self.refs.file.value = '';
      };
      reader.onerror = function () {
        dom.toast('Could not read that file.', 'bad');
        if (self.refs.file) self.refs.file.value = '';
      };
      reader.readAsText(file);
    },

    markSaving: function () {
      const self = this;
      const ind = this.refs.saveInd;
      if (!ind) return;
      if (!SD.persistence) { ind.textContent = 'Autosave unavailable'; return; }
      ind.classList.add('adm-save--pending');
      ind.textContent = 'Saving…';
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(function () { self.markSaved(); }, 800);   // persistence debounces ~500 ms
    },

    markSaved: function () {
      const ind = this.refs.saveInd;
      if (!ind) return;
      clearTimeout(this.saveTimer);
      ind.classList.remove('adm-save--pending');
      ind.textContent = 'Autosaved ' + fmt.hhmmss(Date.now());
    },

    // ---------------------------------------------------------------- render
    render: function (state) {
      const r = this.refs;
      const cr = state.currentRace;
      const status = cr ? cr.status : null;
      const settings = state.settings || {};

      if (r.status) r.status.textContent = status ? 'Race: ' + String(status).toUpperCase() : 'No race running';
      if (r.btnStart) r.btnStart.disabled = !!cr;
      if (r.btnPause) r.btnPause.disabled = !(status === 'running' || status === 'countdown');
      if (r.btnResume) r.btnResume.disabled = status !== 'paused';
      if (r.btnEnd) r.btnEnd.disabled = !cr || status === 'finished';
      ['btnNextDay', 'btnResetDay', 'btnResetSeason', 'btnResetAll', 'btnImport'].forEach(function (k) {
        if (r[k]) r[k].disabled = !!cr;
      });

      this.fillEventSelect();
      this.fillSendAs(state);
      if (r.btnSend) r.btnSend.disabled = typeof SD.processCommand !== 'function';
      if (r.sendText) r.sendText.disabled = typeof SD.processCommand !== 'function';
      this.syncSettings(settings);
      this.renderDebug(state, settings);
    },

    syncSettings: function (settings) {
      const active = document.activeElement;
      Array.prototype.slice.call(this.root.querySelectorAll('[data-set]')).forEach(function (c) {
        if (c === active) return;
        const key = c.getAttribute('data-set');
        const v = settings[key];
        if (v === undefined) return;
        if (c.type === 'checkbox') { c.checked = !!v; return; }
        if (c.tagName === 'SELECT' && !Array.prototype.some.call(c.options, function (o) { return o.value === String(v); })) {
          c.appendChild(dom.el('option', { value: String(v), text: String(v) }));
        }
        if (c.value !== String(v)) c.value = String(v);
      });
      Array.prototype.slice.call(this.root.querySelectorAll('output[data-out]')).forEach(function (o) {
        const v = Number(settings[o.getAttribute('data-out')]);
        o.textContent = isFinite(v) ? v.toFixed(2).replace(/\.?0+$/, '') + '×' : '–';
      });
    },

    renderDebug: function (state, settings) {
      const r = this.refs;
      const rec = this.lastRecord(state);
      const debug = !!settings.debug;

      if (r.btnReplay) r.btnReplay.disabled = !(state.raceHistory && state.raceHistory.length) || !!state.currentRace;
      if (r.replay) {
        r.replay.textContent = this.replayText;
        r.replay.className = 'adm-note' + (this.replayOk === true ? ' adm-ok' : this.replayOk === false ? ' adm-bad' : '');
      }

      if (r.kv) {
        const kv = [];
        kv.push(['Last record', rec ? esc(rec.id) : '—']);
        kv.push(['Seed', rec && rec.seed != null ? esc(rec.seed) : '—']);
        kv.push(['Hash', rec && rec.hash ? '<span class="num">' + esc(rec.hash) + '</span>' : '—']);
        if (rec) kv.push(['Track', esc((rec.trackName || '') + ' · ' + (rec.distance || '') + ' m · ' + (rec.totalTicks || (rec.ticks ? rec.ticks.length : '?')) + ' ticks')]);
        const html = kv.map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>'; }).join('');
        if (this.lastKv !== html) { r.kv.innerHTML = html; this.lastKv = html; }
      }

      if (!r.debugTable) return;
      if (!debug) {
        if (this.lastTable) { r.debugTable.innerHTML = ''; this.lastTable = ''; }
        return;
      }
      const byId = {};
      (state.runners || []).forEach(function (x) { byId[x.id] = x; });
      let html = '';
      if (rec && Array.isArray(rec.entrants) && rec.entrants.length) {
        html += '<table class="adm-table"><thead><tr><th>Entrant</th><th title="Perf START·EARLY·MID·TURN·STRETCH">Perf S·E·M·T·F</th>' +
          '<th>Stam</th><th>Wild</th><th title="Hidden fatigue (live)">Fat</th><th>Odds</th></tr></thead><tbody>' +
          rec.entrants.map(function (e) {
            const p = e.perf || {};
            const perf = ['START', 'EARLY', 'MID', 'FINAL_TURN', 'FINAL_STRETCH'].map(function (k) {
              return p[k] != null ? Math.round(p[k]) : '–';
            }).join('·');
            const live = byId[e.runnerId];
            return '<tr><td>' + esc(e.name) + '</td><td>' + esc(perf) + '</td><td>' + esc(fmtNum(e.stamMax, 0)) + '</td>' +
              '<td>' + esc(fmtWild(e.wildRoll)) + '</td><td>' + esc(live ? fmtNum(live.fatigue, 0) : '–') + '</td>' +
              '<td>' + esc(fmt.odds(e.odds)) + '</td></tr>';
          }).join('') + '</tbody></table>';
      } else {
        html += '<p class="adm-note">No race record yet — start a race to see entrant perf.</p>';
      }
      html += '<table class="adm-table" style="margin-top:8px"><thead><tr><th>Runner</th><th>Fatigue</th><th>Energy</th><th>Condition</th><th>Mood</th></tr></thead><tbody>' +
        (state.runners || []).filter(function (x) { return !x.retired; }).map(function (x) {
          return '<tr><td>' + esc(x.name) + '</td><td>' + esc(fmtNum(x.fatigue, 0)) + '</td><td>' + esc(fmtNum(x.energy, 0)) + '</td>' +
            '<td>' + esc(x.condition || '') + '</td><td>' + esc(x.mood || '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      if (this.lastTable !== html) { r.debugTable.innerHTML = html; this.lastTable = html; }
    }
  };

  function fmtNum(v, d) { v = Number(v); return isFinite(v) ? v.toFixed(d || 0) : '–'; }
  function fmtWild(w) {
    if (w == null) return '—';
    if (typeof w === 'number') return w.toFixed(3);
    if (typeof w === 'string') return w;
    if (typeof w === 'object') {
      const kind = w.kind || w.type || w.label || '';
      const mult = Number(w.mult != null ? w.mult : w.value);
      return (kind ? kind + ' ' : '') + (isFinite(mult) ? '×' + mult.toFixed(3) : '');
    }
    return String(w);
  }

  SD.ui.admin = admin;
})(globalThis.SD = globalThis.SD || {});
