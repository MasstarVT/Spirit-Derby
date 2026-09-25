/* SPIRIT DERBY — ui/eventlog.js
 * Sidebar event log: state.log newest first (severity colours, capped at 100 rows).
 * While a race plays, its non-hidden race events are shown live at the top (ephemeral,
 * cleared when the race finishes/aborts — the core's permanent log takes over).
 * Panel contract: SD.ui.eventlog = { init(rootEl), render(state), destroy() }.
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const esc = dom.esc;
  const fmt = dom.fmt;
  const MAX_ROWS = 100;
  const SEVS = { info: 1, good: 1, bad: 1, epic: 1 };

  function sev(s) { return SEVS[s] ? s : (s === 'warn' || s === 'warning' ? 'bad' : 'info'); }

  const eventlog = {
    name: 'eventlog',
    root: null,
    list: null,
    countEl: null,
    offs: [],
    live: [],
    lastHTML: '',

    init: function (root) {
      const self = this;
      this.root = root;
      root.innerHTML = '' +
        '<div class="eventlog__head"><h2 class="eventlog__title">Forest log</h2><span class="eventlog__count"></span></div>' +
        '<ol class="log" aria-live="polite" aria-label="Event log, newest first"></ol>';
      this.list = root.querySelector('.log');
      this.countEl = root.querySelector('.eventlog__count');

      const rerender = function () { dom.schedule(self); };
      ['STATE_CHANGED', 'STATE_LOADED', 'LOG_ENTRY', 'SETTINGS_CHANGED'].forEach(function (k) { self.offs.push(dom.on(k, rerender)); });
      this.offs.push(dom.on('RACE_STARTED', function () { self.live = []; dom.schedule(self); }));
      this.offs.push(dom.on('RACE_FINISHED', function () { self.live = []; dom.schedule(self); }));
      this.offs.push(dom.on('RACE_ABORTED', function () { self.live = []; dom.schedule(self); }));
      this.offs.push(dom.on('RACE_EVENT', function (ev) { self.onRaceEvent(ev); }));

      const s = dom.state();
      if (s) this.render(s);
    },

    destroy: function () {
      this.offs.forEach(function (off) { off(); });
      this.offs = [];
    },

    onRaceEvent: function (ev) {
      if (!ev || !ev.text) return;
      if (ev.hidden && !dom.debugOn()) return;
      this.live.unshift({ text: ev.text, severity: sev(ev.severity), hidden: !!ev.hidden, tick: ev.tick });
      if (this.live.length > MAX_ROWS) this.live.length = MAX_ROWS;
      dom.schedule(this);
    },

    render: function (state) {
      const log = state.log || [];
      const dt = Number(dom.cfg('RACE.DT', 0.5)) || 0.5;
      const rows = [];

      for (let i = 0; i < this.live.length && rows.length < MAX_ROWS; i++) {
        const e = this.live[i];
        rows.push('<li class="log__row log__row--live sev-' + e.severity + (e.hidden ? ' log__row--hidden' : '') + '">' +
          '<span class="log__time" title="Live race event">' + esc(fmt.clockSec((Number(e.tick) || 0) * dt)) + '</span>' +
          '<span class="log__text">' + esc(e.text) + '</span></li>');   // hidden rows are dimmed/italic via class
      }
      for (let i = log.length - 1; i >= 0 && rows.length < MAX_ROWS; i--) {
        const e = log[i] || {};
        rows.push('<li class="log__row sev-' + sev(e.severity) + '" data-type="' + esc(e.type || '') + '">' +
          '<span class="log__time" title="' + esc(e.season != null ? 'Season ' + e.season + ' · Day ' + e.day : '') + '">' + esc(fmt.hhmm(e.t)) + '</span>' +
          '<span class="log__text">' + esc(e.text) + '</span></li>');
      }

      const html = rows.length ? rows.join('') : '<li class="log__empty">Nothing has happened yet. Train a runner or start a race!</li>';
      if (html !== this.lastHTML) {
        this.list.innerHTML = html;
        this.lastHTML = html;
      }
      if (this.countEl) this.countEl.textContent = log.length ? log.length + ' entries' : '';
    }
  };

  SD.ui.eventlog = eventlog;
})(globalThis.SD = globalThis.SD || {});
