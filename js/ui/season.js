/* SPIRIT DERBY — ui/season.js
 * Season summary modal (M5): shown on season:ended (automatic after the last day, or admin
 * RESET SEASON). If the race results modal is open (the season ended with that race), the
 * summary waits for 'ui:resultsClosed'. Styled like the results modal: champion runner, MVP
 * (most SP earned), biggest upset, top hype contributor, achievements unlocked and the
 * per-runner win table, plus what the new season resets. Continue / Esc / backdrop close it.
 * Auto-close after 2 × settings.resultsAutoCloseMs (0 = never).
 * Panel contract: SD.ui.season = { init(rootEl), render(state), destroy() } + show(summary), close(), isOpen().
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const fmt = dom.fmt;
  const esc = dom.esc;
  const DEFAULT_AUTO_CLOSE_MS = 25000;

  function plural(n, w) { return fmt.int(n) + ' ' + w + (Number(n) === 1 ? '' : 's'); }

  const season = {
    name: 'season',
    root: null,
    open: false,
    queue: [],
    offs: [],
    autoTimer: 0,
    tickTimer: 0,
    closeAt: 0,
    lastFocus: null,

    init: function (root) {
      const self = this;
      this.root = root;
      root.hidden = true;
      root.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) self.close();
      });
      this.offs.push(dom.on('SEASON_ENDED', function (p) { self.enqueue(p && p.summary); }));
      this.offs.push(dom.on('ui:resultsClosed', function () { self.pump(); }));
    },

    render: function () { /* built per season in show() */ },

    destroy: function () {
      this.offs.forEach(function (off) { off(); });
      this.offs = [];
      this.clearTimers();
    },

    isOpen: function () { return this.open; },

    clearTimers: function () {
      clearTimeout(this.autoTimer);
      clearInterval(this.tickTimer);
      this.autoTimer = 0;
      this.tickTimer = 0;
    },

    enqueue: function (summary) {
      if (!summary) return;
      this.queue.push(summary);
      this.pump();
    },

    /** Show the next queued summary unless a modal is already up (race results first). */
    pump: function () {
      if (this.open || !this.queue.length) return;
      if (SD.ui.results && typeof SD.ui.results.isOpen === 'function' && SD.ui.results.isOpen()) return;
      this.show(this.queue.shift());
    },

    show: function (summary) {
      if (!this.root || !summary) return;
      const self = this;
      this.clearTimers();
      this.lastFocus = document.activeElement;
      this.root.innerHTML = this.html(summary);
      this.root.hidden = false;
      this.open = true;
      const btn = this.root.querySelector('.results__foot .btn');
      if (btn) { try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); } }

      const s = dom.settings();
      let base = Number(s.resultsAutoCloseMs);
      if (!isFinite(base)) base = Number(dom.cfg('UI.RESULTS_AUTO_CLOSE_MS', DEFAULT_AUTO_CLOSE_MS));
      const ms = isFinite(base) ? base * 2 : DEFAULT_AUTO_CLOSE_MS * 2;
      const auto = this.root.querySelector('.results__auto');
      if (ms > 0) {
        this.closeAt = Date.now() + ms;
        const update = function () {
          if (auto) auto.textContent = 'Closing automatically in ' + Math.max(0, Math.ceil((self.closeAt - Date.now()) / 1000)) + ' s';
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
      dom.emit('ui:seasonClosed', {});
      this.pump();
    },

    // ---------------------------------------------------------------- markup
    card: function (icon, label, main, sub, cls) {
      return '<section class="season__card' + (cls ? ' ' + cls : '') + '">' +
        '<div class="season__label"><span class="emoji" aria-hidden="true">' + icon + '</span> ' + esc(label) + '</div>' +
        '<div class="season__main">' + main + '</div>' +
        (sub ? '<div class="season__sub">' + sub + '</div>' : '') +
      '</section>';
    },

    html: function (sum) {
      const table = Array.isArray(sum.runnerTable) ? sum.runnerTable : [];
      const champRow = table.filter(function (r) { return r.runnerId === sum.championRunnerId; })[0] || null;
      const champBadge = champRow ? dom.badgeHTML(champRow, 'badge--lg') : '';
      const next = (Number(sum.number) || 1) + 1;
      const days = Number(sum.day) || Number(sum.daysPerSeason) || 0;

      const cards = [];
      cards.push(this.card('\u{1F3C6}', 'Champion',
        sum.championName ? (champRow ? dom.badgeHTML(champRow, 'badge--sm') + ' ' : '') + '<b>' + esc(sum.championName) + '</b>' : '<span class="c-dim">No races this season</span>',
        sum.championName ? plural(sum.championWins || 0, 'win') + ' · ' + fmt.int(sum.championXp || 0) + ' XP' +
          (sum.championOwner ? ' · 👤 ' + esc(sum.championOwner) : ' · unclaimed') : '', 'season__card--champ'));
      cards.push(this.card('\u{2B50}', 'MVP',
        sum.mvpUsername ? '<b>' + esc(sum.mvpUsername) + '</b>' : '<span class="c-dim">Nobody joined</span>',
        sum.mvpUsername ? fmt.int(sum.mvpSpEarned || 0) + ' Spirit Points earned' : ''));
      const up = sum.biggestUpset;
      cards.push(this.card('\u{1F4A5}', 'Biggest upset',
        up ? (up.winnerEmoji ? '<span class="emoji">' + esc(up.winnerEmoji) + '</span> ' : '') + '<b>' + esc(up.winnerName || '?') + '</b> at ' + esc(fmt.odds(up.odds)) : '<span class="c-dim">No races</span>',
        up ? (up.upset ? 'A true upset' : 'The favourites mostly held') + (up.trackName ? ' · ' + esc(up.trackName) : '') + (up.day ? ' · Day ' + esc(up.day) : '') : ''));
      const th = sum.topHypeContributor;
      cards.push(this.card('\u{1F525}', 'Top hype',
        th ? '<b>' + esc(th.displayName || th.username) + '</b>' : '<span class="c-dim">A quiet crowd</span>',
        th ? fmt.int(Math.round(th.hype)) + ' hype added' : ''));
      cards.push(this.card('\u{1F3C5}', 'Achievements',
        '<b>' + fmt.int(sum.achievementsCount != null ? sum.achievementsCount : (sum.achievements || []).length) + '</b> unlocked',
        plural(sum.totalRaces || 0, 'race') + ' over ' + plural(days, 'day')));

      const rows = table.map(function (r) {
        return '<tr class="place-' + r.rank + '">' +
          '<td class="c-place">' + esc(r.rank <= 3 ? fmt.medal(r.rank) : r.rank) + '</td>' +
          '<td class="c-runner"><div class="runner-cell">' + dom.badgeHTML(r) +
            '<div><div class="runner-cell__name">' + esc(r.name) + '</div>' +
            '<div class="runner-cell__owner">' + (r.owner ? '👤 ' + esc(r.owner) : 'Unclaimed') + ' · Lv ' + esc(r.level || 1) + '</div></div></div></td>' +
          '<td class="c-num"><b>' + esc(fmt.int(r.wins)) + '</b></td>' +
          '<td class="c-num">' + esc(fmt.int(r.races)) + '</td>' +
          '<td class="c-num">' + esc(fmt.int(r.podiums)) + '</td>' +
          '<td class="c-num">' + esc(fmt.int(r.xp)) + '</td>' +
        '</tr>';
      }).join('');

      const carry = Math.round(Number(dom.cfg('SEASON.STAT_CARRY', 0.1)) * 100);
      const baseSp = Number(dom.cfg('ECONOMY.SEASON_BASE_SP', 200));
      const spCarry = Math.round(Number(dom.cfg('ECONOMY.SEASON_CARRY', 0.1)) * 100);
      const refunds = [];
      if (Number(sum.refundedBets)) refunds.push(plural(sum.refundedBets, 'open bet') + ' refunded');
      if (Number(sum.refundedEffects)) refunds.push(plural(sum.refundedEffects, 'queued boost/sabotage') + ' refunded');

      return '' +
        '<div class="modal__backdrop" data-close></div>' +
        '<div class="modal__dialog season">' +
          '<header class="results__head season__head">' +
            '<div class="results__trophy" aria-hidden="true">\u{1F451}</div>' +
            '<div class="results__titles">' +
              '<h2 class="results__title" id="season-title">Season ' + esc(sum.number) + ' complete!</h2>' +
              '<p class="results__sub">' + esc(plural(days, 'day') + ' · ' + plural(sum.totalRaces || 0, 'race') + ' · Season ' + next + ' begins now') + '</p>' +
            '</div>' +
            champBadge +
          '</header>' +
          '<div class="results__body">' +
            '<div class="season__cards">' + cards.join('') + '</div>' +
            (rows
              ? '<section class="results__box"><h3>Runner standings</h3><table class="rtable season__table">' +
                  '<thead><tr><th>#</th><th>Runner</th><th>Wins</th><th>Races</th><th>Podiums</th><th>XP</th></tr></thead>' +
                  '<tbody>' + rows + '</tbody></table></section>'
              : '') +
            '<p class="season__note">Season ' + next + ': every runner returns to level 1 keeping its base stats + ' + carry + '% of what it gained, ' +
              'owners are cleared (<b>!claim</b> again), everyone starts on ' + baseSp + ' SP + ' + spCarry + '% of their balance, and achievements are kept.' +
              (refunds.length ? ' ' + esc(refunds.join(', ')) + '.' : '') + '</p>' +
          '</div>' +
          '<footer class="results__foot">' +
            '<span class="results__auto"></span>' +
            '<button type="button" class="btn btn--gold" data-close>Continue ▸</button>' +
          '</footer>' +
        '</div>';
    }
  };

  SD.ui.season = season;
})(globalThis.SD = globalThis.SD || {});
