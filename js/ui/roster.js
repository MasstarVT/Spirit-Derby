/* SPIRIT DERBY — ui/roster.js
 * Horizontally scrollable strip of runner cards: badge, name, species · style, level,
 * five stat bars, energy + XP bars, mood · condition, owner, ability (tooltip) and an
 * M1 local control row (stat select + TRAIN + REST → SD.game.trainRunner / restRunner, by 'streamer').
 * Cards are keyed by runner id: the info block re-renders on state:changed (coalesced via
 * dom.schedule); the control row is created once so selects keep focus/selection.
 * Panel contract: SD.ui.roster = { init(rootEl), render(state), destroy() }.
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const esc = dom.esc;

  const STATS = [
    { key: 'speed', short: 'SPD', label: 'Speed', color: 'var(--stat-speed)' },
    { key: 'stamina', short: 'STA', label: 'Stamina', color: 'var(--stat-stamina)' },
    { key: 'power', short: 'POW', label: 'Power', color: 'var(--stat-power)' },
    { key: 'wisdom', short: 'WIS', label: 'Wisdom', color: 'var(--stat-wisdom)' },
    { key: 'luck', short: 'LUK', label: 'Luck', color: 'var(--stat-luck)' }
  ];
  const BY = 'streamer';

  function pct(v, max) { return (dom.clamp((Number(v) || 0) / (Number(max) || 1), 0, 1) * 100).toFixed(1) + '%'; }
  function condClass(c) { return /^[A-Za-z]+$/.test(String(c || '')) ? String(c) : 'Normal'; }

  const roster = {
    name: 'roster',
    root: null,
    strip: null,
    cards: {},
    chosenStat: {},
    offs: [],
    fxTimers: {},
    pendingRings: {},

    init: function (root) {
      const self = this;
      this.root = root;
      root.innerHTML = '<div class="roster__strip" role="list" aria-label="Runners"></div>';
      this.strip = root.querySelector('.roster__strip');

      // vertical wheel scrolls the strip horizontally (handy on desktop)
      this.strip.addEventListener('wheel', function (e) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && self.strip.scrollWidth > self.strip.clientWidth) {
          self.strip.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }, { passive: false });

      this.strip.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-act]');
        if (!btn || btn.disabled) return;
        const card = btn.closest('.rcard');
        if (!card) return;
        const id = card.getAttribute('data-id');
        if (btn.getAttribute('data-act') === 'train') self.train(id);
        else if (btn.getAttribute('data-act') === 'rest') self.rest(id);
      });
      this.strip.addEventListener('change', function (e) {
        const sel = e.target.closest('select[data-stat]');
        if (!sel) return;
        const card = sel.closest('.rcard');
        if (card) self.chosenStat[card.getAttribute('data-id')] = sel.value;
      });

      const rerender = function () { dom.schedule(self); };
      ['STATE_CHANGED', 'STATE_LOADED', 'SETTINGS_CHANGED', 'RUNNER_SPAWNED', 'RUNNER_TRAINED', 'RUNNER_RESTED',
        'RUNNER_CLAIMED', 'RUNNER_CONDITION', 'RACE_STARTED', 'RACE_FINISHED', 'RACE_ABORTED', 'RACE_PAUSED', 'RACE_RESUMED']
        .forEach(function (k) { self.offs.push(dom.on(k, rerender)); });
      this.offs.push(dom.on('RUNNER_LEVELUP', function (p) { self.onLevelUp(p); }));
      // Race level-ups land just before the results modal opens: their rings play once it closes.
      this.offs.push(dom.on('ui:resultsClosed', function () {
        const ids = Object.keys(self.pendingRings);
        self.pendingRings = {};
        ids.forEach(function (id) { self.pulse(id, 'rcard--levelup', 3300); });
      }));

      const s = dom.state();
      if (s) this.render(s);
    },

    destroy: function () {
      this.offs.forEach(function (off) { off(); });
      this.offs = [];
    },

    // ---------------------------------------------------------------- actions
    train: function (id) {
      const card = this.cards[id];
      const stat = (card && card.select.value) || this.chosenStat[id] || 'speed';
      if (!SD.game || typeof SD.game.trainRunner !== 'function') { dom.toast('Training is not available yet.', 'bad'); return; }
      let res;
      try { res = SD.game.trainRunner(id, stat, BY); } catch (e) { res = { ok: false, message: e && e.message }; }
      res = res || {};
      const sevOf = { crit: 'epic', fail: 'bad', normal: 'good' };
      const severity = res.ok === false ? 'bad' : (sevOf[res.outcome] || 'good');
      dom.toast(res.message || (res.ok === false ? 'Could not train right now.' : 'Training complete.'), severity);
      if (res.outcome === 'crit') this.pulse(id, 'rcard--crit', 900);
    },

    rest: function (id) {
      if (!SD.game || typeof SD.game.restRunner !== 'function') { dom.toast('Resting is not available yet.', 'bad'); return; }
      let res;
      try { res = SD.game.restRunner(id, BY); } catch (e) { res = { ok: false, message: e && e.message }; }
      res = res || {};
      dom.toast(res.message || (res.ok === false ? 'Could not rest right now.' : 'Rested.'), res.ok === false ? 'bad' : 'good');
    },

    onLevelUp: function (p) {
      const id = p && (p.runnerId || (p.runner && p.runner.id) || p.id);
      if (!id) return;
      const self = this;
      // Next tick: race:finished (and the results modal) follow runner:levelup synchronously.
      setTimeout(function () {
        if (SD.ui.results && typeof SD.ui.results.isOpen === 'function' && SD.ui.results.isOpen()) self.pendingRings[id] = true;
        else self.pulse(id, 'rcard--levelup', 3300);
      }, 0);
      const s = dom.state();
      const r = s && (s.runners || []).filter(function (x) { return x.id === id; })[0];
      const level = (p && (p.level || p.newLevel)) || (r && r.level);
      const name = (r && r.name) || (p && p.name);
      if (name) dom.toast('⬆ ' + name + ' reached level ' + level + '!', 'epic');
      dom.schedule(this);
    },

    pulse: function (id, cls, ms) {
      const card = this.cards[id];
      if (!card) return;
      const key = id + cls;
      clearTimeout(this.fxTimers[key]);
      card.el.classList.remove(cls);
      void card.el.offsetWidth;
      card.el.classList.add(cls);
      this.fxTimers[key] = setTimeout(function () { card.el.classList.remove(cls); }, ms);
    },

    // ---------------------------------------------------------------- rendering
    createCard: function (r) {
      const el = dom.el('article', { class: 'rcard', role: 'listitem', 'data-id': r.id });
      const body = dom.el('div', { class: 'rcard__body' });
      const select = dom.el('select', { class: 'field', 'data-stat': '1', 'aria-label': 'Stat to train for ' + (r.name || r.id) },
        STATS.map(function (s) { return dom.el('option', { value: s.key, text: s.label }); }));
      const trainBtn = dom.el('button', { type: 'button', class: 'btn btn--primary', 'data-act': 'train', text: 'TRAIN' });
      const restBtn = dom.el('button', { type: 'button', class: 'btn', 'data-act': 'rest', text: 'REST' });
      const ctrl = dom.el('div', { class: 'rcard__ctrl' }, [select, trainBtn, restBtn]);
      el.appendChild(body);
      el.appendChild(ctrl);
      const pre = this.chosenStat[r.id] || (r.trainStreak && r.trainStreak.stat) || 'speed';
      select.value = pre;
      if (!select.value) select.value = 'speed';
      const card = { el: el, body: body, select: select, trainBtn: trainBtn, restBtn: restBtn, html: '', vars: '' };
      this.cards[r.id] = card;
      return card;
    },

    bodyHTML: function (r, racing) {
      const style = dom.info.style(r.style);
      const species = dom.info.species(r.species);
      const level = Number(r.level) || 1;
      const cap = dom.info.statCap(level);
      const stats = r.stats || {};
      let total = 0;
      const statRows = STATS.map(function (s) {
        const v = Math.round(Number(stats[s.key]) || 0);
        total += v;
        return '<div class="sbar" title="' + s.label + ' ' + v + ' / ' + cap + '">' +
          '<span class="sbar__label">' + s.short + '</span>' +
          '<span class="sbar__track"><i class="sbar__fill" style="width:' + pct(v, cap) + ';--c:' + s.color + '"></i></span>' +
          '<span class="sbar__num">' + v + '</span></div>';
      }).join('');
      const totalRow = '<div class="sbar sbar--total" title="Stat total"><span class="sbar__label">Σ</span><span></span>' +
        '<span class="sbar__num">' + total + '</span></div>';

      const energy = Math.round(Number(r.energy) || 0);
      const maxE = Math.round(Number(r.maxEnergy) || 100);
      const eFrac = energy / (maxE || 1);
      const eColor = eFrac < 0.2 ? 'var(--ember)' : eFrac < 0.5 ? 'var(--gold)' : 'var(--teal)';
      const xp = Math.round(Number(r.xp) || 0);
      const xpNext = Math.round(Number(dom.info.xpToNext(level)) || 1);
      const isMax = level >= (Number(dom.cfg('PROGRESSION.MAX_LEVEL', 20)) || 20);
      const xpRow = isMax
        ? '<div class="sbar sbar--wide sbar--max" title="Max level reached (' + esc(dom.fmt.int(r.totalXp || 0)) + ' XP this season)"><span class="sbar__label">XP</span>' +
            '<span class="sbar__track"><i class="sbar__fill" style="width:100%"></i></span>' +
            '<span class="sbar__num">MAX</span></div>'
        : '<div class="sbar sbar--wide" title="XP ' + xp + ' / ' + xpNext + ' to level ' + (level + 1) + '"><span class="sbar__label">XP</span>' +
            '<span class="sbar__track"><i class="sbar__fill" style="width:' + pct(xp, xpNext) + ';--c:var(--gold)"></i></span>' +
            '<span class="sbar__num">' + xp + '/' + xpNext + '</span></div>';

      const cond = condClass(r.condition);
      const mood = r.mood || 'Happy';
      const ab = dom.info.ability(r);
      const rec = r.record || {};
      const owner = r.owner;
      const sub = [species, style.short].filter(Boolean).join(' · ');

      return '' +
        '<header class="rcard__head">' +
          dom.badgeHTML(r) +
          '<div class="rcard__id">' +
            '<div class="rcard__name" title="' + esc(r.name) + (r.personality ? ' — ' + esc(r.personality) : '') + '">' + esc(r.name) + '</div>' +
            '<div class="rcard__sub" title="' + esc(species) + ' · ' + esc(style.name) + '">' + esc(sub) + '</div>' +
          '</div>' +
          '<div class="rcard__tags"><span class="pill pill--lv' + (isMax ? ' pill--max' : '') + '">Lv ' + level + (isMax ? ' MAX' : '') + '</span>' +
            (racing ? '<span class="pill pill--race">RACING</span>' : '') + '</div>' +
        '</header>' +
        '<div class="rcard__stats">' + statRows + totalRow + '</div>' +
        '<div class="rcard__meters">' +
          '<div class="sbar sbar--wide" title="Energy ' + energy + ' / ' + maxE + '"><span class="sbar__label">EN</span>' +
            '<span class="sbar__track"><i class="sbar__fill" style="width:' + pct(energy, maxE) + ';--c:' + eColor + '"></i></span>' +
            '<span class="sbar__num">' + energy + '/' + maxE + '</span></div>' +
          xpRow +
        '</div>' +
        '<div class="rcard__line">' +
          '<span>' + dom.info.moodEmoji(mood) + ' ' + esc(mood) + '</span><span aria-hidden="true">·</span>' +
          '<span class="cond cond--' + cond + '">' + esc(r.condition || 'Normal') + '</span>' +
          '<span class="rcard__record" title="Wins / races">' + esc(rec.wins || 0) + 'W · ' + esc(rec.races || 0) + 'R</span>' +
        '</div>' +
        '<div class="rcard__line">' +
          (owner ? '<span class="rcard__owner">👤 ' + esc(owner) + '</span>' : '<span class="rcard__owner rcard__owner--none">Unclaimed</span>') +
          (ab ? '<span class="rcard__ability" title="' + esc(ab.name + (ab.desc ? ' — ' + ab.desc : '')) + '">✨ ' + esc(ab.name) + '</span>' : '') +
        '</div>';
    },

    render: function (state) {
      const self = this;
      const runners = (state.runners || []).filter(function (r) { return r && !r.retired; });
      const locked = dom.isRaceLocked(state);
      const racing = {};
      const cr = state.currentRace;
      if (cr && cr.record && Array.isArray(cr.record.entrants)) cr.record.entrants.forEach(function (e) { racing[e.runnerId] = true; });

      const seen = {};
      runners.forEach(function (r, i) {
        seen[r.id] = true;
        const card = self.cards[r.id] || self.createCard(r);
        const html = self.bodyHTML(r, !!racing[r.id]);
        if (html !== card.html) { card.body.innerHTML = html; card.html = html; }
        const vars = dom.runnerVars(r);
        if (vars !== card.vars) { card.el.setAttribute('style', vars); card.vars = vars; }
        card.el.classList.toggle('rcard--racing', !!racing[r.id]);

        const why = locked ? 'Locked while a race is running' : '';
        card.trainBtn.disabled = locked;
        card.restBtn.disabled = locked;
        card.select.disabled = locked;
        card.trainBtn.title = why || ('Train ' + r.name + ' (energy cost applies)');
        card.restBtn.title = why || ('Rest ' + r.name + ' (+energy, −fatigue)');

        if (self.strip.children[i] !== card.el) self.strip.insertBefore(card.el, self.strip.children[i] || null);
      });

      Object.keys(this.cards).forEach(function (id) {
        if (!seen[id]) {
          const c = self.cards[id];
          if (c.el.parentNode) c.el.parentNode.removeChild(c.el);
          delete self.cards[id];
        }
      });

      let empty = this.strip.querySelector('.roster__empty');
      if (!runners.length && !empty) {
        empty = dom.el('p', { class: 'roster__empty', text: 'No runners yet — spawn one from the admin panel.' });
        this.strip.appendChild(empty);
      } else if (runners.length && empty) {
        empty.remove();
      }
    }
  };

  SD.ui.roster = roster;
})(globalThis.SD = globalThis.SD || {});
