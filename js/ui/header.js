/* SPIRIT DERBY — ui/header.js
 * Logo, SEASON · DAY · RACE i/n, day-event badge, hype meter (value, next threshold,
 * tier glow) and hype-threshold banners. Overlay/admin toggle buttons + connection dot
 * (M7: aggregated Twitch + bridge status from integration:status, tooltip lists both).
 * Panel contract: SD.ui.header = { init(rootEl), render(state), destroy() }.
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const NEXT_LABEL = { loud: 'the crowd gets loud', feral: 'FERAL MODE', awakened: 'the forest awakens' };
  const BANNER_MS = 4300;

  const header = {
    name: 'header',
    root: null,
    refs: {},
    offs: [],
    tickMax: null,
    bannerQueue: [],
    bannerBusy: false,

    init: function (root) {
      const self = this;
      this.root = root;
      this.refs = dom.refs(root);

      root.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const act = btn.getAttribute('data-action');
        if (act === 'overlay' && SD.ui.toggleOverlay) SD.ui.toggleOverlay();
        if (act === 'admin' && SD.ui.toggleAdmin) SD.ui.toggleAdmin();
      });

      const rerender = function () { dom.schedule(self); };
      ['STATE_CHANGED', 'STATE_LOADED', 'SETTINGS_CHANGED', 'HYPE_CHANGED', 'EVENT_DAY',
        'SEASON_DAY_ADVANCED', 'SEASON_ENDED', 'RACE_STARTED', 'RACE_FINISHED', 'RACE_ABORTED']
        .forEach(function (k) { self.offs.push(dom.on(k, rerender)); });
      this.offs.push(dom.on('HYPE_THRESHOLD', function (p) { self.onThreshold(p); }));
      this.offs.push(dom.on('INTEGRATION_STATUS', function (p) { self.onIntegration(p); }));
      this.renderConn();

      const s = dom.state();
      if (s) this.render(s);
    },

    destroy: function () {
      this.offs.forEach(function (off) { off(); });
      this.offs = [];
    },

    render: function (state) {
      const r = this.refs;
      const season = state.season || {};
      const racesPerDay = Number(season.racesPerDay) || 3;
      const idx = Number(season.raceIndexInDay) || 0;       // races completed today (assumed)
      const live = !!state.currentRace;

      if (r.season) r.season.textContent = 'SEASON ' + (season.number || 1) + ' · DAY ' + (season.day || 1);
      if (r.race) {
        let html;
        if (!live && idx >= racesPerDay) html = 'RACES <b>' + racesPerDay + '/' + racesPerDay + '</b> · DAY COMPLETE';
        else html = 'RACE <b>' + Math.min(idx + 1, racesPerDay) + '/' + racesPerDay + '</b>' + (live ? ' · LIVE' : ' · NEXT UP');
        if (r.race.innerHTML !== html) r.race.innerHTML = html;
        r.race.classList.toggle('hdr-season__race--live', live);
      }

      // day event badge
      if (r.dayEvent) {
        const de = dom.info.dayEvent(season.activeDayEvent);
        const icon = r.dayEvent.querySelector('.hdr-dayevent__icon');
        const name = r.dayEvent.querySelector('.hdr-dayevent__name');
        if (de) {
          if (icon) icon.textContent = de.emoji || de.icon || '🍂';
          if (name) name.textContent = de.name || de.id;
          r.dayEvent.title = (de.name || '') + (de.desc ? ' — ' + de.desc : '');
          r.dayEvent.classList.remove('hdr-dayevent--none');
        } else {
          if (icon) icon.textContent = '🍃';
          if (name) name.textContent = 'Calm day';
          r.dayEvent.title = 'No day event is active';
          r.dayEvent.classList.add('hdr-dayevent--none');
        }
      }

      this.renderHype(state);

      // toggle button pressed states (source of truth = body classes set by main.js)
      const ov = this.root.querySelector('[data-action="overlay"]');
      const ad = this.root.querySelector('[data-action="admin"]');
      if (ov) ov.setAttribute('aria-pressed', String(document.body.classList.contains('sd-overlay')));
      if (ad) ad.setAttribute('aria-pressed', String(document.body.classList.contains('sd-admin-open')));
    },

    renderHype: function (state) {
      const r = this.refs;
      const hype = state.hype || {};
      const value = Math.max(0, Number(hype.value) || 0);
      const max = Number(hype.max) || 120;
      const thresholds = dom.info.thresholds();

      if (r.hypeValue) r.hypeValue.textContent = String(Math.round(value));
      if (r.hypeMax) r.hypeMax.textContent = '/ ' + max;
      if (r.hypeFill) r.hypeFill.style.width = (dom.clamp(value / max, 0, 1) * 100).toFixed(1) + '%';
      if (r.hype) {
        r.hype.setAttribute('aria-valuenow', String(Math.round(value)));
        r.hype.setAttribute('aria-valuemax', String(max));
      }

      // threshold ticks (built once per max value)
      if (r.hypeBar && this.tickMax !== max) {
        this.tickMax = max;
        Array.prototype.slice.call(r.hypeBar.querySelectorAll('.hype__tick')).forEach(function (n) { n.remove(); });
        thresholds.forEach(function (t) {
          r.hypeBar.appendChild(dom.el('i', {
            class: 'hype__tick', title: t.value + ' — ' + (t.text || t.id),
            style: { '--at': String(dom.clamp(t.value / max, 0, 1)) }, dataset: { v: String(t.value) }
          }));
        });
      }
      if (r.hypeBar) {
        Array.prototype.slice.call(r.hypeBar.querySelectorAll('.hype__tick')).forEach(function (n) {
          n.classList.toggle('hype__tick--hit', value >= Number(n.dataset.v));
        });
      }

      // next threshold label
      if (r.hypeNext) {
        const next = this.nextThreshold(value, thresholds);
        let html;
        if (next) {
          html = 'next: <b>' + dom.esc(next.value) + '</b> · ' + dom.esc(NEXT_LABEL[next.id] || next.text || next.id || '');
        } else {
          html = '<b>MAX TIER</b> · the forest is awake';
        }
        if (r.hypeNext.innerHTML !== html) r.hypeNext.innerHTML = html;
      }
    },

    nextThreshold: function (value, thresholds) {
      try {
        if (SD.hype && typeof SD.hype.nextThreshold === 'function') {
          const n = SD.hype.nextThreshold(value);
          if (n === null) return null;
          if (typeof n === 'number') {
            for (let i = 0; i < thresholds.length; i++) if (thresholds[i].value === n) return thresholds[i];
            return { value: n, id: '', text: '' };
          }
          if (n && typeof n === 'object' && n.value != null) return n;
        }
      } catch (e) { /* fall back */ }
      for (let i = 0; i < thresholds.length; i++) if (value < thresholds[i].value) return thresholds[i];
      return null;
    },

    // ---------------------------------------------------------------- banners
    normalizeThresholds: function (p) {
      const all = dom.info.thresholds();
      const find = function (key) {
        for (let i = 0; i < all.length; i++) if (all[i].id === key || all[i].value === key) return all[i];
        return null;
      };
      if (p == null) return [];
      if (typeof p === 'string' || typeof p === 'number') return [find(p) || { id: String(p), text: String(p) }];
      if (Array.isArray(p)) return p.map(function (x) { return typeof x === 'object' ? x : find(x); }).filter(Boolean);
      if (Array.isArray(p.crossed)) return this.normalizeThresholds(p.crossed);
      if (p.threshold) return this.normalizeThresholds(p.threshold);
      const base = find(p.id) || find(p.value) || {};
      return [{ id: p.id || base.id || '', value: base.value != null ? base.value : p.value, text: p.text || base.text || '' }];
    },

    onThreshold: function (p) {
      const self = this;
      this.normalizeThresholds(p).forEach(function (t) { if (t && (t.text || t.id)) self.bannerQueue.push(t); });
      this.pumpBanners();
    },

    pumpBanners: function () {
      const self = this;
      if (this.bannerBusy || !this.bannerQueue.length) return;
      const layer = document.getElementById('banner-layer');
      if (!layer) { this.bannerQueue = []; return; }
      const t = this.bannerQueue.shift();
      this.bannerBusy = true;
      const s = dom.state();
      const hypeVal = s && s.hype ? Math.round(Number(s.hype.value) || 0) : null;
      const node = dom.el('div', { class: 'hype-banner hype-banner--' + String(t.id || 'loud').replace(/[^a-z0-9_-]/gi, '') }, [
        String(t.text || t.id),
        dom.el('small', { text: 'Hype ' + (t.value != null ? t.value : '') + (hypeVal != null ? ' · now ' + hypeVal : '') })
      ]);
      layer.appendChild(node);
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
        self.bannerBusy = false;
        self.pumpBanners();
      }, BANNER_MS);
    },

    // ---------------------------------------------------------------- connection dot (M7)
    // integration:status { adapter:'twitch'|'bridge', state, ... } → one dot for both adapters:
    // green when either is 'on', amber while connecting/reconnecting, red on error, grey off.
    integ: {},

    onIntegration: function (p) {
      if (p && p.adapter) this.integ[p.adapter] = p;
      this.renderConn();
    },

    renderConn: function () {
      const dot = this.refs.conn;
      if (!dot) return;
      const self = this;
      const I = SD.integrations || {};
      const parts = [];
      const states = [];
      [['twitch', 'Twitch'], ['bridge', 'Bridge']].forEach(function (d) {
        const mod = I[d[0]];
        let s = self.integ[d[0]] || null;
        try { if (mod && typeof mod.status === 'function') s = mod.status(); } catch (e) { /* keep the last event */ }
        if (!mod && !s) return;
        const state = (s && s.state) || 'off';
        states.push(state);
        let text = d[1] + ': ' + state;
        if (s && state === 'on') {
          text += ' (' + (d[0] === 'twitch' ? '#' + s.channel + ', ' : '') + (Number(s.messages) || 0) + ' msgs)';
        } else if (s && (state === 'error' || state === 'reconnecting') && s.lastError) {
          text += ' — ' + s.lastError;
        }
        parts.push(text);
      });
      let agg = 'off';
      if (states.indexOf('on') >= 0) agg = 'on';
      else if (states.indexOf('connecting') >= 0 || states.indexOf('reconnecting') >= 0) agg = 'connecting';
      else if (states.indexOf('error') >= 0) agg = 'error';
      const label = parts.length ? parts.join(' · ') : 'Chat integrations are not loaded';
      if (dot.getAttribute('data-status') !== agg) dot.setAttribute('data-status', agg);
      if (dot.title !== label) dot.title = label;
      dot.setAttribute('aria-label', 'Chat connection ' + agg + '. ' + label);
    }
  };

  SD.ui.header = header;
})(globalThis.SD = globalThis.SD || {});
