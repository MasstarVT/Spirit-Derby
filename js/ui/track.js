/* SPIRIT DERBY — ui/track.js
 * Fixed horizontal lanes with sprites, live positions column, event ticker, countdown,
 * fog, finish flash, photo-finish/winner banners, and the paddock (idle) view.
 * Lanes are built once on race:started; race:frame applies targeted transform/width/text
 * updates only. Panel contract: SD.ui.track = { init(rootEl), render(state), destroy() }.
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const fmt = dom.fmt;
  const esc = dom.esc;

  const PHASE_LABEL = {
    START: 'Start', EARLY: 'Early Pace', MID: 'Mid Race', FINAL_TURN: 'Final Turn',
    FINAL_STRETCH: 'Final Stretch', FINISH: 'Finish', READY: 'Get Ready', IDLE: 'Waiting', PAUSED: 'Paused', DONE: 'Finished'
  };
  // How long an fx class stays on after the fx was last seen in a frame (ms).
  // Engine fx tags: crit, ability, boost, sabotage, awakened, fade, wall, fog, event:<raceEventId>.
  const FX_HOLD = { crit: 700, ability: 1400, boost: 700, sabotage: 900, awakened: 900, event: 900, fade: 260, wall: 420 };
  const FX_KEYS = Object.keys(FX_HOLD);
  const KIND_ICON = { phase: '🏁', crit: '⚡', ability: '🔮', overtake: '💨', chat: '💬', finish: '🏆', awakened: '🌳', wall: '💢' };
  const SEV_ICON = { info: '🍃', good: '✨', bad: '💥', epic: '🌟' };
  const SEVS = { info: 1, good: 1, bad: 1, epic: 1 };
  const FOG_TICKS_DEFAULT = 15;
  const TICKER_MAX = 3;

  function sev(s) { return SEVS[s] ? s : (s === 'warn' || s === 'warning' ? 'bad' : 'info'); }
  /** Race-event catalog id for Mysterious Fog is 'mysteriousFog'; accept any id mentioning fog. */
  function isFogId(id) { return /fog/i.test(String(id || '')); }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function tickSeconds(tick) { return (Number(tick) || 0) * dom.cfg('RACE.DT', 0.5); }
  function condClass(c) { return /^[A-Za-z]+$/.test(String(c || '')) ? String(c) : 'Normal'; }

  const track = {
    name: 'track',
    root: null,
    refs: {},
    offs: [],
    ro: null,
    // per-race
    record: null,
    lanes: {},
    posItems: {},
    finishInfo: {},
    entrantCount: 0,
    travel: 0,
    tickers: [],
    fogOn: false,
    fogUntil: -1,
    started: false,
    allDone: false,
    pausedFlag: false,
    firstFinish: false,
    bannerShown: false,
    phaseShown: null,
    progressText: '',
    lastFrame: null,
    holdFinal: false,
    holdTimer: 0,
    cdTimer: 0,
    // idle
    lastPaddock: '',
    lastIdleTicker: '',

    // ================================================================ lifecycle
    init: function (root) {
      const self = this;
      this.root = root;
      this.refs = dom.refs(root);
      const on = function (k, fn) { self.offs.push(dom.on(k, fn)); };

      on('RACE_STARTED', function (p) { self.onStarted(p); });
      on('RACE_COUNTDOWN', function (p) { self.onCountdown(p); });
      on('RACE_FRAME', function (f) { self.onFrame(f); });
      on('RACE_TICK', function (p) { self.onTick(p); });
      on('RACE_PHASE', function (p) { self.onPhase(p); });
      on('RACE_EVENT', function (e) { self.onEvent(e); });
      on('RACE_RUNNER_FINISHED', function (p) { self.onRunnerFinished(p); });
      on('RACE_PAUSED', function () { self.setPaused(true); });
      on('RACE_RESUMED', function () { self.setPaused(false); });
      on('RACE_PLAYBACK_DONE', function (p) { self.onPlaybackDone(p); });
      on('RACE_FINISHED', function (p) { self.onRaceFinished(p); });
      on('RACE_ABORTED', function () { self.onAborted(); });
      on('ui:resultsClosed', function () { self.releaseFinal(); });
      ['STATE_CHANGED', 'STATE_LOADED', 'SETTINGS_CHANGED', 'EVENT_DAY', 'SEASON_DAY_ADVANCED', 'LOG_ENTRY']
        .forEach(function (k) { on(k, function () { dom.schedule(self); }); });

      this.onResize = function () { self.measure(true); };
      window.addEventListener('resize', this.onResize);
      if (typeof ResizeObserver === 'function' && this.refs.lanes) {
        this.ro = new ResizeObserver(function () { self.measure(true); });
        this.ro.observe(this.refs.lanes);
      }

      const s = dom.state();
      if (s) this.render(s);
    },

    destroy: function () {
      this.offs.forEach(function (off) { off(); });
      this.offs = [];
      window.removeEventListener('resize', this.onResize);
      if (this.ro) this.ro.disconnect();
      clearTimeout(this.holdTimer);
      clearTimeout(this.cdTimer);
    },

    render: function (state) {
      const cr = state.currentRace;
      if (cr && cr.record) {
        if (!this.record || this.record.id !== cr.record.id) this.build(cr.record);
        this.syncStatus(cr.status);
        return;
      }
      if (this.record && this.holdFinal) return;     // keep the final positions behind the results modal
      if (this.record) this.clearRace();
      this.renderPaddock(state);
    },

    // ================================================================ race build
    onStarted: function (p) {
      const rec = (p && p.record) || (function () { const s = dom.state(); return s && s.currentRace && s.currentRace.record; })();
      if (!rec) return;
      this.holdFinal = false;
      clearTimeout(this.holdTimer);
      this.build(rec);
    },

    clearRace: function () {
      this.record = null;
      this.lanes = {};
      this.posItems = {};
      this.finishInfo = {};
      this.entrantCount = 0;
      this.tickers = [];
      this.fogOn = false;
      this.fogUntil = -1;
      this.started = false;
      this.allDone = false;
      this.pausedFlag = false;
      this.firstFinish = false;
      this.bannerShown = false;
      this.phaseShown = null;
      this.progressText = '';
      this.lastFrame = null;
      this.lastIdleTicker = '';
      clearTimeout(this.cdTimer);
      const r = this.refs;
      this.root.classList.remove('track--racing', 'track--running', 'track--paused', 'track--final', 'track--finished', 'track--awakened');
      this.root.removeAttribute('data-n');
      this.travel = 0;
      if (r.lanes) r.lanes.innerHTML = '';
      if (r.posList) r.posList.innerHTML = '';
      if (r.ruler) r.ruler.innerHTML = '';
      if (r.countdown) { r.countdown.hidden = true; r.countdown.innerHTML = ''; }
      if (r.paused) r.paused.hidden = true;
      if (r.fog) r.fog.classList.remove('is-on');
      if (r.positions) r.positions.classList.remove('is-fogged');
      if (r.posFog) r.posFog.hidden = true;
      Array.prototype.slice.call(this.root.querySelectorAll('.track__banner')).forEach(function (n) { n.remove(); });
    },

    build: function (rec) {
      this.clearRace();
      this.record = rec;
      const r = this.refs;
      const distance = Number(rec.distance) || 1200;
      this.root.classList.remove('track--idle');
      this.root.classList.add('track--racing');

      if (r.name) r.name.textContent = rec.trackName || 'Forest Track';
      if (r.dist) r.dist.textContent = fmt.int(distance) + ' m';
      if (r.progress) r.progress.textContent = '0 / ' + fmt.int(distance) + ' m';
      if (r.pbar) r.pbar.style.transform = 'scaleX(0)';
      this.setPhase('READY');

      // distance markers every 200 m (≤1600 m) or 400 m, scaled to the race length
      const step = distance <= 1600 ? 200 : 400;
      const marks = [];
      for (let m = step; m < distance - step / 2; m += step) marks.push(m);
      if (r.ruler) {
        r.ruler.innerHTML = marks.map(function (m) {
          return '<span class="ruler__mark" style="--f:' + (m / distance).toFixed(5) + '">' + m + ' m</span>';
        }).join('') + '<span class="ruler__mark ruler__mark--finish" style="--f:1">FINISH</span>';
      }
      const markHTML = marks.map(function (m) {
        return '<i class="lane__mark" style="--f:' + (m / distance).toFixed(5) + '"></i>';
      }).join('');

      const entrants = (rec.entrants || []).slice().sort(function (a, b) { return (a.lane || 0) - (b.lane || 0); });
      this.entrantCount = entrants.length;
      this.root.setAttribute('data-n', String(entrants.length));   // CSS sizes sprites/lanes by field size

      if (r.lanes) {
        r.lanes.innerHTML = entrants.map(function (e, i) {
          const lane = e.lane || i + 1;
          const style = dom.info.style(e.style);
          const owner = e.ownerAtRace;
          const ownerLine = (owner ? '👤 ' + esc(owner) : 'Unclaimed') +
            ' · Lv ' + esc(e.level || 1) + ' · <span title="' + esc(style.name) + '">' + esc(style.short) + '</span>';
          const url = dom.safeUrl(e.avatarUrl);
          return '' +
            '<div class="lane" role="listitem" data-id="' + esc(e.runnerId) + '" style="' + esc(dom.runnerVars(e)) + '--lane:' + lane + '">' +
              '<div class="lane__info">' +
                '<span class="lane__rank">' + lane + '</span>' +
                dom.badgeHTML(e) +
                '<div class="lane__text">' +
                  '<div class="lane__name">' + esc(e.name) + '</div>' +
                  '<div class="lane__owner' + (owner ? '' : ' lane__owner--none') + '">' + ownerLine + '</div>' +
                  '<div class="stamina" title="Stamina"><i></i></div>' +
                '</div>' +
              '</div>' +
              '<div class="lane__run">' +
                '<div class="lane__bg"></div>' +
                '<i class="lane__start"></i>' + markHTML + '<i class="lane__finish"></i>' +
                '<div class="sprite">' +
                  '<span class="sprite__disc"></span>' +
                  '<span class="sprite__bob"><span class="sprite__emoji">' +
                    (url ? '<img src="' + esc(url) + '" alt="">' : esc(e.emoji || '🐾')) +
                  '</span></span>' +
                '</div>' +
              '</div>' +
            '</div>';
        }).join('');

        const lanes = this.lanes;
        Array.prototype.slice.call(r.lanes.querySelectorAll('.lane')).forEach(function (node, i) {
          lanes[node.getAttribute('data-id')] = {
            el: node,
            lane: (entrants[i] && entrants[i].lane) || i + 1,
            rank: node.querySelector('.lane__rank'),
            stWrap: node.querySelector('.stamina'),
            stam: node.querySelector('.stamina > i'),
            sprite: node.querySelector('.sprite'),
            x: -1, st: -1, stCls: '', rankText: '', fxUntil: {}, fxOn: {}
          };
        });
      }

      if (r.posList) {
        r.posList.style.setProperty('--n', String(entrants.length || 1));
        r.posList.innerHTML = entrants.map(function (e, i) {
          const lane = e.lane || i + 1;
          return '<li class="pos-item" data-id="' + esc(e.runnerId) + '" style="' + esc(dom.runnerVars(e)) + '--r:' + lane + '">' +
            '<span class="pos-item__rank">' + lane + '</span>' + dom.badgeHTML(e, 'badge--sm') +
            '<span class="pos-item__name">' + esc(e.name) + '</span><span class="pos-item__gap">—</span></li>';
        }).join('');
        const items = this.posItems;
        Array.prototype.slice.call(r.posList.querySelectorAll('.pos-item')).forEach(function (node) {
          items[node.getAttribute('data-id')] = {
            el: node, rankEl: node.querySelector('.pos-item__rank'), gapEl: node.querySelector('.pos-item__gap'), r: -1, gap: ''
          };
        });
      }

      this.renderTicker('🏁 The runners take their marks…');
      this.measure(false);
      const f = SD.playback && SD.playback.getFrame && SD.playback.getFrame();
      if (f && (f.recordId == null || f.recordId === rec.id)) this.onFrame(f);
    },

    /** Measure lane run width → sprite travel distance in px. */
    measure: function (reapply) {
      if (!this.record || !this.refs.lanes) return;
      const run = this.refs.lanes.querySelector('.lane__run');
      if (!run) return;
      const w = run.clientWidth;
      if (!w) return;
      const cs = getComputedStyle(this.root);
      const sw = parseFloat(cs.getPropertyValue('--sw')) || 54;
      const over = parseFloat(cs.getPropertyValue('--overrun')) || 30;
      const travel = Math.max(0, w - sw - over);
      if (travel === this.travel) return;
      this.travel = travel;
      if (reapply && this.lastFrame) {
        Object.keys(this.lanes).forEach(function (id) { this.lanes[id].x = -1; }, this);
        this.onFrame(this.lastFrame);
      }
    },

    // ================================================================ per-frame updates
    onFrame: function (f) {
      if (!this.record || !f || !f.runners) return;
      if (f.recordId != null && f.recordId !== this.record.id) return;
      this.lastFrame = f;
      if (!this.travel) this.measure(false);
      if (this.pausedFlag && f.paused === false) this.setPaused(false);

      const t = nowMs();
      const fog = this.fogOn;
      for (let i = 0; i < f.runners.length; i++) {
        const rr = f.runners[i];
        const L = this.lanes[rr.id];
        if (!L) continue;

        const x = Math.round(dom.clamp(rr.progress, 0, 1) * this.travel * 10) / 10;
        if (x !== L.x) { L.sprite.style.transform = 'translate3d(' + x + 'px,0,0)'; L.x = x; }

        const st = Math.round(dom.clamp(rr.st, 0, 1) * 200) / 200;
        if (st !== L.st) {
          L.stam.style.transform = 'scaleX(' + st + ')';
          L.st = st;
          const cls = st < 0.12 ? 'fading' : st < 0.25 ? 'tiring' : '';
          if (cls !== L.stCls) { L.stWrap.className = 'stamina' + (cls ? ' stamina--' + cls : ''); L.stCls = cls; }
        }

        const fin = this.finishInfo[rr.id];
        const rankText = fin ? fmt.medal(fin.place) : fog ? '?' : String(rr.rank);
        if (rankText !== L.rankText) {
          L.rank.textContent = rankText;
          L.rankText = rankText;
          L.rank.classList.toggle('lane__rank--1', fin ? fin.place === 1 : (!fog && rr.rank === 1));
        }

        const fx = rr.fx || [];
        for (let k = 0; k < fx.length; k++) {
          let key = String(fx[k]);
          if (key === 'fog') { this.startFog(f.tick, this.fogOn ? 1 : null); continue; }   // present while fog is active
          if (key.indexOf('event:') === 0) {
            if (isFogId(key.slice(6))) this.startFog(f.tick, this.fogOn ? 1 : null);
            key = 'event';
          }
          if (FX_HOLD[key]) L.fxUntil[key] = t + FX_HOLD[key];
        }
        for (let k = 0; k < FX_KEYS.length; k++) {
          const key = FX_KEYS[k];
          const onNow = (L.fxUntil[key] || 0) > t;
          if (onNow !== !!L.fxOn[key]) { L.el.classList.toggle('fx-' + key, onNow); L.fxOn[key] = onNow; }
        }
      }

      // title bar: phase + leader metres
      const dist = Number(f.distance) || Number(this.record.distance) || 1;
      const lead = Math.min(Number(f.leaderD) || 0, dist);
      const txt = fmt.int(lead) + ' / ' + fmt.int(dist) + ' m';
      if (txt !== this.progressText) {
        this.progressText = txt;
        if (this.refs.progress) this.refs.progress.textContent = txt;
        if (this.refs.pbar) this.refs.pbar.style.transform = 'scaleX(' + (lead / dist).toFixed(4) + ')';
      }
      if (this.started && !this.pausedFlag && f.phase && f.phase !== this.phaseShown && !this.allDone) this.setPhase(f.phase);

      if (this.fogOn && Number(f.tickFloat) >= this.fogUntil) this.endFog();

      if (!this.allDone && f.finished && this.entrantCount && f.finished.length >= this.entrantCount) {
        this.allDone = true;
        this.root.classList.remove('track--running');
      }
    },

    onTick: function (p) {
      if (!this.record || !p || !p.data || !p.data.pos) return;
      const self = this;
      const dist = Number(this.record.distance) || 0;
      const pos = p.data.pos.slice();
      let lead = 0;
      pos.forEach(function (q) { if (q.d > lead) lead = q.d; });
      const laneOf = function (id) { const L = self.lanes[id]; return L ? L.lane : 0; };
      pos.sort(function (a, b) {
        const fa = self.finishInfo[a.id];
        const fb = self.finishInfo[b.id];
        if (fa && fb) return fa.place - fb.place;
        if (fa || fb) return fa ? -1 : 1;
        const ad = a.d >= dist - 1e-6;
        const bd = b.d >= dist - 1e-6;
        if (ad !== bd) return ad ? -1 : 1;
        if (b.d !== a.d) return b.d - a.d;
        return laneOf(a.id) - laneOf(b.id);
      });
      pos.forEach(function (q, i) {
        const fin = self.finishInfo[q.id];
        const rank = i + 1;
        const gap = fin ? fmt.time(fin.timeSec) : rank === 1 ? 'LEAD' : '−' + Math.max(0, Math.round(lead - q.d)) + ' m';
        self.updatePosItem(q.id, rank, gap, !!fin);
      });
    },

    updatePosItem: function (id, rank, gap, done) {
      const item = this.posItems[id];
      if (!item) return;
      if (rank !== item.r) {
        item.r = rank;
        item.el.style.setProperty('--r', String(rank));
        item.rankEl.textContent = String(rank);
        item.el.classList.toggle('pos-item--1', rank === 1);
      }
      if (gap !== item.gap) {
        item.gap = gap;
        item.gapEl.textContent = gap;
        item.el.classList.toggle('pos-item--done', !!done);
      }
    },

    onPhase: function (p) {
      if (!this.record || !p) return;
      this.started = true;
      this.root.classList.toggle('track--final', p.phase === 'FINAL_STRETCH' || p.phase === 'FINISH');
      if (!this.pausedFlag && !this.allDone) this.setPhase(p.phase);
    },

    setPhase: function (phase) {
      const el = this.refs.phase;
      if (phase !== 'PAUSED') this.phaseShown = phase;
      if (!el) return;
      el.setAttribute('data-phase', phase);
      el.textContent = PHASE_LABEL[phase] || String(phase || '').replace(/_/g, ' ');
    },

    // ================================================================ ticker / events
    onEvent: function (ev) {
      if (!this.record || !ev) return;
      const debug = dom.debugOn();
      if (ev.hidden && !debug) return;
      if (this.isFogEvent(ev)) this.startFog(Number(ev.tick) || 0, this.fogDuration(ev));
      if (ev.kind === 'awakened') this.root.classList.add('track--awakened');
      if (!ev.text) return;
      this.tickers.unshift({ text: String(ev.text), severity: sev(ev.severity), kind: ev.kind, hidden: !!ev.hidden, tick: ev.tick });
      if (this.tickers.length > TICKER_MAX) this.tickers.length = TICKER_MAX;
      this.renderTicker();
    },

    renderTicker: function (emptyText) {
      const list = this.refs.ticker;
      if (!list) return;
      if (!this.tickers.length) {
        list.innerHTML = '<li class="ticker__empty">' + esc(emptyText || '') + '</li>';
        return;
      }
      list.innerHTML = this.tickers.map(function (t) {
        const icon = KIND_ICON[t.kind] || SEV_ICON[t.severity] || '🍃';
        return '<li class="ticker__item sev-' + t.severity + (t.hidden ? ' ticker__item--hidden' : '') + '">' +
          '<span class="ticker__icon">' + icon + '</span>' +
          '<span class="ticker__text">' + esc(t.text) + '</span>' +
          '<span class="ticker__time">' + fmt.clockSec(tickSeconds(t.tick)) + '</span></li>';
      }).join('');
    },

    isFogEvent: function (ev) {
      const d = ev.data || {};
      const id = d.eventId || d.id || ev.eventId;
      if (id) return isFogId(id);
      return ev.kind === 'event' && /mysterious fog/i.test(String(ev.text || ''));
    },

    fogDuration: function (ev) {
      const d = ev.data || {};
      const n = Number(d.durationTicks || d.duration || d.ticks);
      return n > 0 ? n : Number(dom.cfg('RACE.FOG_TICKS', FOG_TICKS_DEFAULT)) || FOG_TICKS_DEFAULT;
    },

    startFog: function (tick, dur) {
      tick = Number(tick) || 0;
      if (this.fogOn) {
        this.fogUntil = Math.max(this.fogUntil, tick + (dur || 1));
        return;
      }
      this.fogOn = true;
      this.fogUntil = tick + (dur || FOG_TICKS_DEFAULT);
      if (this.refs.fog) this.refs.fog.classList.add('is-on');
      if (this.refs.positions) this.refs.positions.classList.add('is-fogged');
      if (this.refs.posFog) this.refs.posFog.hidden = false;
      Object.keys(this.lanes).forEach(function (id) { this.lanes[id].rankText = ''; }, this);
    },

    endFog: function () {
      this.fogOn = false;
      this.fogUntil = -1;
      if (this.refs.fog) this.refs.fog.classList.remove('is-on');
      if (this.refs.positions) this.refs.positions.classList.remove('is-fogged');
      if (this.refs.posFog) this.refs.posFog.hidden = true;
      Object.keys(this.lanes).forEach(function (id) { this.lanes[id].rankText = ''; }, this);
    },

    // ================================================================ countdown / pause
    onCountdown: function (p) {
      const c = this.refs.countdown;
      if (!c || !p) return;
      const self = this;
      clearTimeout(this.cdTimer);
      if (p.skipped) {
        c.hidden = true;
        c.innerHTML = '';
        this.started = true;
        return;
      }
      c.hidden = false;
      const n = Number(p.secondsLeft) || 0;
      if (n > 0) {
        c.innerHTML = '<span class="countdown__num">' + n + '</span>';
        this.setPhase('READY');
      } else {
        c.innerHTML = '<span class="countdown__num countdown__num--go">GO!</span>';
        this.started = true;
        if (!this.pausedFlag) this.root.classList.add('track--running');
        this.cdTimer = setTimeout(function () { c.hidden = true; c.innerHTML = ''; }, 950);
        if (self.tickers.length === 0) self.renderTicker('🏁 And they\'re off!');
      }
    },

    setPaused: function (on) {
      if (!this.record) return;
      on = !!on;
      this.pausedFlag = on;
      this.root.classList.toggle('track--paused', on);
      if (this.refs.paused) this.refs.paused.hidden = !on;
      if (on) {
        this.root.classList.remove('track--running');
        const keep = this.phaseShown;
        this.setPhase('PAUSED');
        this.phaseShown = keep;
      } else {
        if (this.started && !this.allDone) this.root.classList.add('track--running');
        this.setPhase(this.phaseShown || 'READY');
      }
    },

    /** State-driven fallback so the track matches currentRace.status even if an event was missed. */
    syncStatus: function (status) {
      const pb = SD.playback;
      if (status === 'paused' && !this.pausedFlag && (!pb || !pb.isPaused || pb.isPaused())) this.setPaused(true);
      else if (status === 'running' && this.pausedFlag && pb && pb.isPaused && !pb.isPaused()) this.setPaused(false);
      if (status === 'running' && this.started && !this.allDone && !this.pausedFlag) this.root.classList.add('track--running');
    },

    // ================================================================ finish
    winnerName: function () {
      const rec = this.record || {};
      const s = rec.summary || {};
      if (s.winnerName) return s.winnerName;
      const win = (rec.results || []).filter(function (r) { return r.place === 1; })[0];
      const id = s.winnerId || (win && win.runnerId);
      const e = (rec.entrants || []).filter(function (x) { return x.runnerId === id; })[0];
      return (e && e.name) || 'The winner';
    },

    onRunnerFinished: function (p) {
      if (!this.record || !p) return;
      this.finishInfo[p.runnerId] = { place: Number(p.place) || 0, timeSec: p.timeSec };
      const L = this.lanes[p.runnerId];
      if (L) { L.el.classList.add('lane--finished'); L.rankText = ''; }
      this.updatePosItem(p.runnerId, Number(p.place) || 0, fmt.time(p.timeSec), true);
      if (!this.firstFinish) {
        this.firstFinish = true;
        this.flash();
        if (L) L.el.classList.add('lane--winner');
        this.showFinishBanner();
      }
      if (this.lastFrame) this.onFrame(this.lastFrame);   // refresh medal immediately
    },

    showFinishBanner: function () {
      if (this.bannerShown || !this.record) return;
      this.bannerShown = true;
      const s = this.record.summary || {};
      const name = this.winnerName();
      if (s.photoFinish) {
        this.showBanner('📸 PHOTO FINISH!', name + ' by a whisker');
      } else if (s.upset) {
        this.showBanner('💥 UPSET! ' + name + ' WINS!', 'at ' + fmt.odds(s.upsetOdds) + ' odds');
      } else {
        this.showBanner('🏆 ' + name + ' WINS!', this.record.trackName ? this.record.trackName + ' · ' + fmt.int(this.record.distance) + ' m' : '');
      }
    },

    showBanner: function (title, sub) {
      Array.prototype.slice.call(this.root.querySelectorAll('.track__banner')).forEach(function (n) { n.remove(); });
      const node = dom.el('div', { class: 'track__banner', role: 'status' }, [title, sub ? dom.el('small', { text: sub }) : null]);
      this.root.appendChild(node);
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 3700);
    },

    flash: function () {
      const f = this.refs.flash;
      if (!f) return;
      f.classList.remove('is-on');
      void f.offsetWidth;      // restart the animation
      f.classList.add('is-on');
    },

    onPlaybackDone: function () {
      if (!this.record) return;
      this.allDone = true;
      this.root.classList.remove('track--running', 'track--final');
      if (this.refs.countdown) this.refs.countdown.hidden = true;
      this.setPhase('DONE');
      this.showFinishBanner();
    },

    onRaceFinished: function () {
      if (!this.record) return;
      const self = this;
      this.holdFinal = true;
      this.allDone = true;
      this.pausedFlag = false;
      this.root.classList.remove('track--running', 'track--paused', 'track--final');
      this.root.classList.add('track--finished');
      if (this.refs.paused) this.refs.paused.hidden = true;
      this.setPhase('DONE');
      if (this.fogOn) this.endFog();
      // Released by the results modal closing (ui:resultsClosed); fallback timer otherwise.
      const hasResults = !!(SD.ui.results && document.getElementById('results'));
      const ms = hasResults ? (Number(dom.settings().resultsAutoCloseMs) || 25000) + 5000 : 5000;
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(function () { self.releaseFinal(); }, ms);
    },

    releaseFinal: function () {
      clearTimeout(this.holdTimer);
      if (!this.holdFinal) return;
      this.holdFinal = false;
      dom.schedule(this);
    },

    onAborted: function () {
      this.holdFinal = false;
      clearTimeout(this.holdTimer);
      this.clearRace();
      dom.schedule(this);
    },

    // ================================================================ paddock (idle)
    previewField: function (state, count) {
      const active = (state.runners || []).filter(function (r) { return !r.retired; });
      let field = null;
      try {
        if (SD.game && typeof SD.game.previewField === 'function') {
          // Same seed + lane draw the real startRace() will use, so the preview matches.
          field = SD.game.previewField(count);
        } else if (SD.race && typeof SD.race.selectField === 'function' && SD.rng && typeof SD.rng.create === 'function') {
          const seed = ((state.meta && Number(state.meta.raceCounter)) || 0) + 1;
          field = SD.race.selectField(state, count, SD.rng.create(seed >>> 0));
        }
      } catch (e) { field = null; }
      if (!Array.isArray(field) || !field.length) field = active.slice(0, count);
      let odds = {};
      try {
        if (SD.race && typeof SD.race.buildEntrants === 'function' && field.length) {
          const ents = SD.race.buildEntrants(field, {
            distance: Number(state.settings && state.settings.distance) || 1200,   // odds depend on distance
            hypeLevel: (state.hype && Number(state.hype.value)) || 0,
            dayEvent: dom.info.dayEvent(state.season && state.season.activeDayEvent),
            cheerBonus: {}
          });
          (ents || []).forEach(function (e) { if (e && e.runnerId) odds[e.runnerId] = e.odds; });
        }
      } catch (e) { odds = {}; }
      return field.map(function (r) { return { runner: r, odds: odds[r.id] }; });
    },

    paddockHTML: function (state) {
      const s = state.settings || {};
      const season = state.season || {};
      const racesPerDay = Number(season.racesPerDay) || 3;
      const idx = Number(season.raceIndexInDay) || 0;
      const dist = Number(s.distance) || 1200;
      const count = dom.clamp(Number(s.runnerCount) || 4, 2, 8);
      const rows = this.previewField(state, count);
      const dayDone = idx >= racesPerDay;
      const status = SD.betting ? 'Bets open' : 'Paddock open';
      const next = dayDone
        ? 'Day complete · advance the day to race again'
        : 'Next race · Race ' + (idx + 1) + '/' + racesPerDay + ' · ' + fmt.int(dist) + ' m · ' + rows.length + ' runners';

      const cards = rows.map(function (row) {
        const r = row.runner;
        const style = dom.info.style(r.style);
        const cond = condClass(r.condition);
        const energy = Math.round(Number(r.energy) || 0);
        const maxE = Math.round(Number(r.maxEnergy) || 100);
        const right = (row.odds != null && isFinite(Number(row.odds)))
          ? '<span class="odds" title="Decimal odds"><small>ODDS</small>' + fmt.odds(row.odds) + '</span>'
          : '<span class="pill pill--lv">Lv ' + esc(r.level || 1) + '</span>';
        return '<div class="paddock__runner" style="' + esc(dom.runnerVars(r)) + '">' +
          dom.badgeHTML(r, 'badge--lg') +
          '<div style="min-width:0">' +
            '<div class="paddock__name">' + esc(r.name) + '</div>' +
            '<div class="paddock__meta">' + esc(style.name) + ' · <span class="cond cond--' + cond + '">' + esc(r.condition || 'Normal') + '</span>' +
              ' · ⚡ ' + energy + '/' + maxE + (r.owner ? ' · 👤 ' + esc(r.owner) : '') + '</div>' +
          '</div>' + right +
        '</div>';
      }).join('');

      const leader = this.leaderLine(state);
      return '' +
        '<div class="paddock__head">' +
          '<div><div class="paddock__title">🌿 The Paddock</div><div class="paddock__sub">' + esc(next) + '</div>' +
            (leader ? '<div class="paddock__leader">' + esc(leader) + '</div>' : '') + '</div>' +
          '<span class="paddock__status">' + esc(status) + '</span>' +
        '</div>' +
        (cards ? '<div class="paddock__grid">' + cards + '</div>' : '<p class="paddock__empty">No runners are ready to race.</p>') +
        '<p class="paddock__hint">Streamer: open controls with <kbd>`</kbd> or ⚙ → <b>START RACE</b>' +
          (SD.commands ? ' · Chat: <b>!join</b> · <b>!claim</b> · <b>!train</b> · <b>!cheer</b>' : ' · Train runners from their cards below') + '</p>';
    },

    /** "👑 Leader: Velvet Comet (3 wins)" — the season's top runner by wins; '' before the first win. */
    leaderLine: function (state) {
      let names = [], wins = 0;
      try {
        if (SD.leaderboards && typeof SD.leaderboards.leader === 'function') {
          const l = SD.leaderboards.leader(state);
          if (l) { names = l.names; wins = l.wins; }
        } else {
          (state.runners || []).forEach(function (r) {
            const w = (r && !r.retired && r.record && Number(r.record.wins)) || 0;
            if (w > wins) { wins = w; names = [r.name]; } else if (w > 0 && w === wins) names.push(r.name);
          });
        }
      } catch (e) { return ''; }
      if (!names.length || !(wins > 0)) return '';
      const max = Number(dom.cfg('LEADERBOARDS.LEADER_NAMES', 2)) || 2;
      const shown = names.slice(0, max).join(' & ') + (names.length > max ? ' +' + (names.length - max) + ' more' : '');
      const unit = wins === 1 ? 'win' : 'wins';
      return '👑 ' + (names.length > 1 ? 'Leaders: ' + shown + ' (' + wins + ' ' + unit + ' each)' : 'Leader: ' + shown + ' (' + wins + ' ' + unit + ')');
    },

    renderPaddock: function (state) {
      const r = this.refs;
      this.root.classList.add('track--idle');
      const dist = Number((state.settings || {}).distance) || 1200;
      if (r.name && r.name.textContent !== 'The Paddock') r.name.textContent = 'The Paddock';
      if (r.dist) r.dist.textContent = fmt.int(dist) + ' m';
      if (r.progress) r.progress.textContent = '';
      if (r.pbar) r.pbar.style.transform = 'scaleX(0)';
      if (this.phaseShown !== 'IDLE') this.setPhase('IDLE');
      if (r.paddock) {
        const html = this.paddockHTML(state);
        if (html !== this.lastPaddock) { r.paddock.innerHTML = html; this.lastPaddock = html; }
      }
      this.renderIdleTicker(state);
    },

    /** While idle the ticker mirrors the three newest log lines (training results etc.). */
    renderIdleTicker: function (state) {
      const list = this.refs.ticker;
      if (!list) return;
      const log = state.log || [];
      const items = [];
      for (let i = log.length - 1; i >= 0 && items.length < TICKER_MAX; i--) items.push(log[i]);
      const html = items.length
        ? items.map(function (e) {
          const sv = sev(e.severity);
          return '<li class="ticker__item sev-' + sv + '"><span class="ticker__icon">' + (SEV_ICON[sv] || '🍃') + '</span>' +
            '<span class="ticker__text">' + esc(e.text) + '</span><span class="ticker__time">' + esc(fmt.hhmm(e.t)) + '</span></li>';
        }).join('')
        : '<li class="ticker__empty">🍃 The forest is quiet… train your runners before the next race.</li>';
      if (html !== this.lastIdleTicker) { list.innerHTML = html; this.lastIdleTicker = html; }
    }
  };

  SD.ui.track = track;
})(globalThis.SD = globalThis.SD || {});
