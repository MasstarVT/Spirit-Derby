/* SPIRIT DERBY — ui/results.js
 * Results modal shown on race:finished (wired by main.js): placements table, major events,
 * hype before → after, level-ups, bets (winners with payouts, losers, total paid) and achievements (M5).
 * Continue button + auto-close after settings.resultsAutoCloseMs (default 25 s).
 * Emits 'ui:resultsClosed' on close so the track can return to the paddock.
 * Panel contract: SD.ui.results = { init(rootEl), render(state), destroy() } + show(payload), close(), isOpen().
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const fmt = dom.fmt;
  const esc = dom.esc;

  const STAT_SHORT = { speed: 'SPD', stamina: 'STA', power: 'POW', wisdom: 'WIS', luck: 'LUK' };
  // Ability/crit activations already appear in the table; the list shows world events, chat effects and epics.
  const MAJOR_KINDS = { event: 1, awakened: 1, wall: 1, chat: 1 };
  const SEVS = { info: 1, good: 1, bad: 1, epic: 1 };
  const DEFAULT_AUTO_CLOSE_MS = 25000;
  const MAX_EVENTS = 10;

  function sev(s) { return SEVS[s] ? s : (s === 'warn' || s === 'warning' ? 'bad' : 'info'); }
  function isMajor(ev) {
    if (!ev || ev.hidden || !ev.text) return false;
    return ev.severity === 'epic' || !!MAJOR_KINDS[ev.kind];
  }

  const results = {
    name: 'results',
    root: null,
    open: false,
    closeAt: 0,
    autoTimer: 0,
    tickTimer: 0,
    lastFocus: null,

    init: function (root) {
      const self = this;
      this.root = root;
      root.hidden = true;
      root.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) self.close();
      });
    },

    render: function () { /* modal content is built per race in show() */ },

    destroy: function () {
      this.clearTimers();
    },

    isOpen: function () { return this.open; },

    clearTimers: function () {
      clearTimeout(this.autoTimer);
      clearInterval(this.tickTimer);
      this.autoTimer = 0;
      this.tickTimer = 0;
    },

    /** payload = race:finished { record, results, bets, levelUps, achievements } (or a bare RaceRecord). */
    show: function (payload) {
      if (!this.root || !payload) return;
      const self = this;
      const rec = payload.record || payload;
      const res = (Array.isArray(payload.results) && payload.results.length ? payload.results : rec.results) || [];
      this.clearTimers();
      this.lastFocus = document.activeElement;
      this.root.innerHTML = this.html(rec, res, payload);
      this.root.hidden = false;
      this.open = true;

      const btn = this.root.querySelector('.results__foot .btn');
      if (btn) { try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); } }

      const s = dom.settings();
      let ms = Number(s.resultsAutoCloseMs);
      if (!isFinite(ms)) ms = Number(dom.cfg('UI.RESULTS_AUTO_CLOSE_MS', DEFAULT_AUTO_CLOSE_MS));
      if (!isFinite(ms)) ms = DEFAULT_AUTO_CLOSE_MS;
      const auto = this.root.querySelector('.results__auto');
      if (ms > 0) {
        this.closeAt = Date.now() + ms;
        const update = function () {
          const left = Math.max(0, Math.ceil((self.closeAt - Date.now()) / 1000));
          if (auto) auto.textContent = 'Closing automatically in ' + left + ' s';
        };
        update();
        this.tickTimer = setInterval(update, 500);
        this.autoTimer = setTimeout(function () { self.close(); }, ms);
      } else if (auto) {
        auto.textContent = 'Press Continue (or Esc) when ready';
      }
    },

    close: function () {
      if (!this.open) return;
      this.clearTimers();
      this.open = false;
      this.root.hidden = true;
      this.root.innerHTML = '';
      if (this.lastFocus && typeof this.lastFocus.focus === 'function' && document.body.contains(this.lastFocus)) {
        try { this.lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
      dom.emit('ui:resultsClosed', {});
    },

    // ---------------------------------------------------------------- markup
    html: function (rec, res, payload) {
      const entrants = {};
      (rec.entrants || []).forEach(function (e) { entrants[e.runnerId] = e; });
      const summary = rec.summary || {};
      const sorted = res.slice().sort(function (a, b) { return (Number(a.place) || 99) - (Number(b.place) || 99); });
      const winner = sorted[0];
      const winEnt = (winner && entrants[winner.runnerId]) || {};
      const winnerName = summary.winnerName || winEnt.name || 'The winner';

      // chips
      const chips = [];
      if (summary.photoFinish) chips.push('<span class="pill pill--gold">📸 Photo finish</span>');
      if (summary.upset) chips.push('<span class="pill pill--bad">💥 Upset' + (summary.upsetOdds ? ' at ' + esc(fmt.odds(summary.upsetOdds)) : '') + '</span>');
      if (summary.forestAwakened) chips.push('<span class="pill pill--teal">🌳 Forest Awakened</span>');
      if (Number(summary.eventsCount)) chips.push('<span class="pill">🍂 ' + esc(summary.eventsCount) + ' events</span>');
      if (Number(summary.critsCount)) chips.push('<span class="pill">⚡ ' + esc(summary.critsCount) + ' crits</span>');

      const sub = [rec.trackName, rec.distance ? fmt.int(rec.distance) + ' m' : '',
        'Season ' + (rec.season || '?') + ' · Day ' + (rec.day || '?') + (Number(rec.indexInDay) >= 1 ? ' · Race ' + rec.indexInDay : '')]
        .filter(Boolean).join(' · ');

      const rows = sorted.map(function (r) {
        const e = entrants[r.runnerId] || { name: r.runnerId };
        const place = Number(r.place) || 0;
        const owner = e.ownerAtRace;
        const moodAfter = r.moodAfter ? ' · ' + dom.info.moodEmoji(r.moodAfter) + ' ' + esc(r.moodAfter) : '';

        let time = '<span class="c-num">' + esc(fmt.time(r.timeSec)) + '</span>';
        if (place > 1 && isFinite(Number(r.margin))) time += '<div class="c-dim">+' + Number(r.margin).toFixed(1) + ' m</div>';
        if (r.wallHit) time += '<div class="c-dim">💢 hit the wall</div>';

        let xp = '<span class="gain">+' + esc(fmt.int(r.xp || 0)) + '</span>';
        if (Number(r.levelUps) > 0) xp += ' <span class="pill pill--gold">LV UP' + (Number(r.levelUps) > 1 ? ' ×' + esc(r.levelUps) : '') + '</span>';

        let sp;
        if (owner) sp = '<span class="gain">+' + esc(fmt.int(r.spOwner || 0)) + '</span> <span class="c-dim">→ ' + esc(owner) + '</span>';
        else sp = '<span class="c-dim">no owner</span>';
        if (Number(r.spBacker) > 0) sp += '<div class="c-dim">+' + esc(fmt.int(r.spBacker)) + ' to backers</div>';

        const changes = r.statChanges || {};
        const statTxt = Object.keys(changes).filter(function (k) { return Number(changes[k]); }).map(function (k) {
          const d = Number(changes[k]);
          return '<span class="' + (d > 0 ? 'gain' : 'loss') + '">' + esc(fmt.signed(d)) + ' ' + esc(STAT_SHORT[k] || k.toUpperCase()) + '</span>';
        }).join(' ');

        const acts = Array.isArray(r.abilityActivations) ? r.abilityActivations : [];
        let abil = '<span class="c-dim">—</span>';
        if (acts.length) {
          const names = {};
          acts.forEach(function (a) { const n = dom.info.abilityName(a.id) || 'Ability'; names[n] = (names[n] || 0) + 1; });
          const title = acts.map(function (a) { return a.text || ''; }).filter(Boolean).join('\n');
          abil = '<span title="' + esc(title) + '">🔮 ' + Object.keys(names).map(function (n) {
            return esc(n) + (names[n] > 1 ? ' ×' + names[n] : '');
          }).join(', ') + '</span>';
        }

        return '<tr class="place-' + place + '">' +
          '<td class="c-place">' + esc(place <= 3 ? fmt.medal(place) : place) + '</td>' +
          '<td class="c-runner"><div class="runner-cell">' + dom.badgeHTML(e) +
            '<div class="runner-cell__text"><div class="runner-cell__name" title="' + esc(e.name) + '">' + esc(e.name) + '</div>' +
            '<div class="runner-cell__owner">' + (owner ? '👤 ' + esc(owner) : 'Unclaimed') + moodAfter + '</div></div></div></td>' +
          '<td>' + time + '</td>' +
          '<td class="c-num">' + xp + '</td>' +
          '<td class="c-num">' + sp + '</td>' +
          '<td>' + (statTxt || '<span class="c-dim">—</span>') + '</td>' +
          '<td>' + abil + '</td>' +
        '</tr>';
      }).join('');

      // major events
      const dt = Number(dom.cfg('RACE.DT', 0.5)) || 0.5;
      const evs = (rec.events || []).filter(isMajor).slice(0, MAX_EVENTS);
      const evHTML = evs.length
        ? '<ul class="results__events">' + evs.map(function (ev) {
          return '<li class="sev-' + sev(ev.severity) + '"><span class="t">' + esc(fmt.clockSec((Number(ev.tick) || 0) * dt)) + '</span>' +
            '<span class="x">' + esc(ev.text) + '</span></li>';
        }).join('') + '</ul>'
        : '<p class="adm-note">A clean race — no forest mischief today.</p>';

      // hype + extras
      const hb = rec.hypeBefore;
      const ha = rec.hypeAfter;
      let side = '<h3>Hype</h3><div class="results__hype"><span>' + esc(hb != null ? Math.round(hb) : '–') + '</span>' +
        '<span class="arrow">→</span><span>' + esc(ha != null ? Math.round(ha) : '–') + '</span></div>';

      const lvl = this.levelUpLines(payload, sorted, entrants);
      if (lvl.length) side += '<h3 style="margin-top:12px">Level ups</h3><ul class="results__list">' + lvl.join('') + '</ul>';

      // M5: bets (winners with payouts, losers counted) and achievements unlocked by this race.
      const bets = (Array.isArray(payload.bets) && payload.bets.length ? payload.bets : rec.bets) || [];
      if (bets.length) {
        const won = bets.filter(function (b) { return b.won; });
        const lost = bets.filter(function (b) { return !b.won; });
        const paid = won.reduce(function (a, b) { return a + (Number(b.payout) || 0); }, 0);
        const lostSp = lost.reduce(function (a, b) { return a + (Number(b.amount) || 0); }, 0);
        side += '<h3 style="margin-top:12px">Bets</h3>';
        side += won.length
          ? '<ul class="results__list results__bets">' + won.slice(0, 6).map(function (b) {
            const e = entrants[b.runnerId] || {};
            return '<li>🎉 <b>' + esc(b.displayName || b.username) + '</b> · ' + esc(fmt.int(b.amount)) + ' on ' + esc(e.name || b.runnerName || b.runnerId) +
              ' @ ' + esc(fmt.odds(b.odds)) + ' → <span class="gain">+' + esc(fmt.int(b.payout)) + ' SP</span></li>';
          }).join('') + (won.length > 6 ? '<li class="c-dim">+' + esc(won.length - 6) + ' more winners</li>' : '') + '</ul>'
          : '<p class="c-dim">No winning bets this time.</p>';
        side += '<p class="results__betsum">' +
          (lost.length ? esc(lost.length) + ' losing bet' + (lost.length === 1 ? '' : 's') + ' (' + esc(fmt.int(lostSp)) + ' SP)' : 'No losing bets') +
          ' · Paid out <b>' + esc(fmt.int(paid)) + ' SP</b></p>';
      }

      const ach = Array.isArray(payload.achievements) ? payload.achievements : [];
      if (ach.length) {
        side += '<h3 style="margin-top:12px">Achievements unlocked</h3><ul class="results__list results__ach">' + ach.slice(0, 8).map(function (a) {
          return '<li><span class="emoji">' + esc(a.icon || '🏅') + '</span> <b>' + esc(a.displayName || a.username || '') + '</b> · ' +
            esc(a.name || a.id || '') + (a.sp ? ' <span class="gain">+' + esc(fmt.int(a.sp)) + ' SP</span>' : '') + '</li>';
        }).join('') + (ach.length > 8 ? '<li class="c-dim">+' + esc(ach.length - 8) + ' more</li>' : '') + '</ul>';
      }

      return '' +
        '<div class="modal__backdrop" data-close></div>' +
        '<div class="modal__dialog">' +
          '<header class="results__head">' +
            '<div class="results__trophy" aria-hidden="true">🏆</div>' +
            '<div class="results__titles">' +
              '<h2 class="results__title" id="results-title">' + esc(winnerName) + ' wins!</h2>' +
              '<p class="results__sub">' + esc(sub) + '</p>' +
              (chips.length ? '<div class="results__chips">' + chips.join('') + '</div>' : '') +
            '</div>' +
            (winner ? dom.badgeHTML(winEnt, 'badge--lg') : '') +
          '</header>' +
          '<div class="results__body">' +
            '<table class="rtable">' +
              '<thead><tr><th>#</th><th>Runner</th><th>Time</th><th>XP</th><th>SP → owner</th><th>Stat changes</th><th>Abilities</th></tr></thead>' +
              '<tbody>' + (rows || '<tr><td colspan="7">No results.</td></tr>') + '</tbody>' +
            '</table>' +
            '<div class="results__cols">' +
              '<section class="results__box"><h3>Major events</h3>' + evHTML + '</section>' +
              '<section class="results__box">' + side + '</section>' +
            '</div>' +
          '</div>' +
          '<footer class="results__foot">' +
            '<span class="results__auto"></span>' +
            '<button type="button" class="btn btn--gold" data-close>Continue ▸</button>' +
          '</footer>' +
        '</div>';
    },

    levelUpLines: function (payload, sorted, entrants) {
      const lines = [];
      const lu = payload.levelUps;
      if (Array.isArray(lu) && lu.length) {
        lu.forEach(function (x) {
          if (!x) return;
          const id = x.runnerId || (x.runner && x.runner.id);
          const e = entrants[id] || {};
          const name = x.name || (x.runner && x.runner.name) || e.name || id;
          const level = x.level || x.newLevel || (x.runner && x.runner.level);
          lines.push('<li>⬆ ' + esc(name) + (level ? ' reached <b>Lv ' + esc(level) + '</b>' : ' levelled up') + '</li>');
        });
        return lines;
      }
      sorted.forEach(function (r) {
        if (Number(r.levelUps) > 0) {
          const e = entrants[r.runnerId] || {};
          lines.push('<li>⬆ ' + esc(e.name || r.runnerId) + ' levelled up' + (Number(r.levelUps) > 1 ? ' ×' + esc(r.levelUps) : '') + '</li>');
        }
      });
      return lines;
    }
  };

  SD.ui.results = results;
})(globalThis.SD = globalThis.SD || {});
