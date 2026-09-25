/* SPIRIT DERBY — ui/leaderboards.js
 * The Boards sidebar tab (M3): six category chips (runner wins, runner XP, Spirit Points,
 * participation, race victories, hype), a Season / All-time toggle and a top-10 list with
 * 🥇🥈🥉 for ranks 1–3 (ties share a rank), runner badges or viewer initials, and the value
 * on the right. The chosen board and scope are remembered in spiritderby.ui (`boards`).
 * All numbers come from SD.leaderboards (core); this panel only renders them.
 * Re-renders on state:changed (coalesced with dom.schedule).
 * Panel contract: SD.ui.leaderboards = { init(rootEl), render(state), destroy() }.
 */
(function (SD) {
  'use strict';

  const dom = SD.ui.dom;
  const esc = dom.esc;

  const DEFAULT_CATEGORY = 'spiritPoints';
  const NAME_COLORS = ['#e6c65e', '#9fd67a', '#e0875f', '#8fb5e6', '#c69be6', '#7fe0c0', '#f0a3b5', '#d9b38c', '#b5d98f', '#f2c38a'];

  function L() { return SD.leaderboards || null; }

  // UI prefs live in spiritderby.ui (SD.ui.dom.prefs, shared with main.js and the chat panel).
  function readPrefs() { return dom && dom.prefs ? dom.prefs.read() : {}; }
  function writePrefs(patch) { if (dom && dom.prefs) dom.prefs.write(patch); }

  function hashStr(s) {
    if (SD.rng && typeof SD.rng.hash === 'function') return SD.rng.hash(String(s));
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function nameColor(key) { return NAME_COLORS[hashStr(String(key || '').toLowerCase()) % NAME_COLORS.length]; }
  function initial(name) {
    const m = /[\p{L}\p{N}]/u.exec(String(name || ''));
    return m ? m[0].toUpperCase() : '?';
  }
  function capFirst(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  function template(cats) {
    const chips = cats.map(function (c) {
      return '<button type="button" class="lbchip" data-cat="' + esc(c.id) + '" aria-pressed="false" title="' + esc(c.name + ' — ' + c.desc) + '">' +
        '<span class="lbchip__icon emoji" aria-hidden="true">' + esc(c.icon) + '</span>' +
        '<span class="lbchip__label">' + esc(c.chip) + '</span></button>';
    }).join('');
    return '' +
      '<div class="boards__head">' +
        '<h2 class="boards__title">Leaderboards</h2>' +
        '<div class="boards__scope" role="group" aria-label="Time range">' +
          '<button type="button" class="boards__scopebtn" data-scope="season" aria-pressed="true">Season</button>' +
          '<button type="button" class="boards__scopebtn" data-scope="all" aria-pressed="false">All-time</button>' +
        '</div>' +
      '</div>' +
      '<div class="boards__chips" data-ref="chips" role="group" aria-label="Board">' + chips + '</div>' +
      '<p class="boards__desc" data-ref="desc"></p>' +
      '<ol class="boards__list" data-ref="list" aria-live="polite" aria-label="Leaderboard, best first"></ol>' +
      '<section class="boards__history" data-ref="history" hidden></section>' +
      '<p class="boards__foot" data-ref="foot">Chat: <b>!lb</b> · <b>!lb wins</b> · <b>!lb xp all</b> · <b>!rank</b></p>';
  }

  const leaderboards = {
    name: 'leaderboards',
    root: null,
    refs: {},
    offs: [],
    category: DEFAULT_CATEGORY,
    scope: 'season',
    lastHTML: '',
    lastDesc: '',
    lastHistory: null,

    init: function (root) {
      const self = this;
      this.root = root;

      // Enable the sidebar tab (disabled in index.html until this module loads) and drop the placeholder.
      const tab = document.getElementById('tab-boards');
      if (tab) {
        tab.disabled = false;
        const soon = tab.querySelector('.tab__soon');
        if (soon && soon.parentNode) soon.parentNode.removeChild(soon);
      }
      const panel = document.getElementById('panel-boards');
      const ph = panel && panel.querySelector('.tabpanel__placeholder');
      if (ph && ph.parentNode) ph.parentNode.removeChild(ph);

      if (!L()) {
        root.innerHTML = '<p class="boards__empty">The leaderboards module (js/leaderboards.js) did not load.</p>';
        return;
      }
      root.innerHTML = template(L().CATEGORIES);
      this.refs = dom.refs(root);

      const prefs = readPrefs().boards || {};
      this.category = (prefs.category && L().get(prefs.category) && L().get(prefs.category).id) || DEFAULT_CATEGORY;
      this.scope = L().resolveScope(prefs.scope) || 'season';

      root.addEventListener('click', function (e) {
        const chip = e.target.closest('[data-cat]');
        if (chip) { self.select(chip.getAttribute('data-cat'), null); return; }
        const sc = e.target.closest('[data-scope]');
        if (sc) self.select(null, sc.getAttribute('data-scope'));
      });

      const rerender = function () { dom.schedule(self); };
      ['STATE_CHANGED', 'STATE_LOADED', 'RACE_FINISHED', 'SEASON_ENDED', 'PLAYER_JOINED', 'RUNNER_CLAIMED']
        .forEach(function (k) { self.offs.push(dom.on(k, rerender)); });

      const s = dom.state();
      if (s) this.render(s);
    },

    destroy: function () {
      this.offs.forEach(function (off) { off(); });
      this.offs = [];
    },

    /** Switch board and/or scope (null keeps the current one); remembered in spiritderby.ui. */
    select: function (category, scope) {
      if (!L()) return;
      if (category) { const c = L().get(category); if (c) this.category = c.id; }
      if (scope) this.scope = L().resolveScope(scope) || this.scope;
      writePrefs({ boards: { category: this.category, scope: this.scope } });
      const s = dom.state();
      if (s) this.render(s);
    },

    rowHTML: function (e, cat) {
      const top3 = e.rank <= 3;
      const rank = top3
        ? '<span class="lbrow__rank lbrow__rank--medal emoji" title="' + esc(dom.fmt.ordinal(e.rank)) + '">' + dom.fmt.medal(e.rank) + '</span>'
        : '<span class="lbrow__rank num">' + esc(e.rank) + '</span>';
      let avatar, sub;
      if (e.kind === 'runner') {
        avatar = dom.badgeHTML(e, 'badge--sm');
        sub = 'Lv ' + esc(e.level || 1) + (e.owner ? ' · 👤 ' + esc(e.owner) : ' · <i>unclaimed</i>') + (e.retired ? ' · retired' : '');
      } else {
        avatar = '<span class="lbrow__avatar" style="--chip:' + esc(nameColor(e.id)) + '" aria-hidden="true">' + esc(initial(e.name)) + '</span>';
        sub = e.runnerName ? '<span class="emoji">' + esc(e.runnerEmoji || '🐾') + '</span> ' + esc(e.runnerName) : '<i>no runner</i>';
      }
      const num = L().fmtNum(e.value);
      const unit = String(e.label || '').slice(num.length + 1);
      return '<li class="lbrow' + (top3 ? ' lbrow--top lbrow--r' + e.rank : '') + '" data-id="' + esc(e.id) + '">' +
        rank + avatar +
        '<div class="lbrow__who"><div class="lbrow__name" title="' + esc(e.name) + '">' + esc(e.name) + '</div>' +
          '<div class="lbrow__sub">' + sub + '</div></div>' +
        '<span class="lbrow__value num" title="' + esc(e.label + ' · ' + cat.name) + '">' + esc(num) +
          (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span>' +
      '</li>';
    },

    render: function (state) {
      const LB = L();
      if (!LB || !this.refs.list) return;
      const self = this;
      const cat = LB.get(this.category) || LB.get(DEFAULT_CATEGORY);
      const scope = this.scope;

      dom.$$('[data-cat]', this.refs.chips).forEach(function (b) {
        const on = b.getAttribute('data-cat') === cat.id;
        if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
      });
      dom.$$('[data-scope]', this.root).forEach(function (b) {
        const on = b.getAttribute('data-scope') === scope;
        if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
      });

      const season = state.season || {};
      const desc = '<span class="boards__kind">' + (cat.kind === 'runner' ? 'Runners' : 'Viewers') + '</span>' +
        esc(cat.desc) + ' <span class="boards__when">' +
        (scope === 'all' ? 'All seasons' : 'Season ' + esc(season.number || 1) + ' · Day ' + esc(season.day || 1)) + '</span>';
      if (desc !== this.lastDesc) { this.refs.desc.innerHTML = desc; this.lastDesc = desc; }

      const ranked = LB.all(state, cat.id, scope);
      const n = Number(dom.cfg('LEADERBOARDS.TOP_N', 10)) || 10;
      const rows = ranked.slice(0, n);
      let html = rows.length
        ? rows.map(function (e) { return self.rowHTML(e, cat); }).join('')
        : '<li class="boards__empty">🌱 ' + esc(capFirst(cat.empty)) + '</li>';
      if (ranked.length > rows.length) {
        html += '<li class="boards__more">+' + esc(ranked.length - rows.length) + ' more on this board</li>';
      }
      if (html !== this.lastHTML) { this.refs.list.innerHTML = html; this.lastHTML = html; }
      this.renderHistory(state);
    },

    /** M5: past seasons' champions (newest first, last 5) under the board. */
    renderHistory: function (state) {
      const box = this.refs.history;
      if (!box) return;
      const hist = (state.season && Array.isArray(state.season.history)) ? state.season.history : [];
      const html = hist.length
        ? '<h3 class="boards__htitle">Season history</h3><ol class="boards__hlist">' + hist.slice(-5).reverse().map(function (h) {
          return '<li class="boards__hrow"><span class="boards__hnum num">S' + esc(h.number) + '</span>' +
            '<span class="boards__hchamp"><span class="emoji" aria-hidden="true">' + esc(h.championEmoji || '🏆') + '</span> ' +
            '<b>' + esc(h.championName || 'No champion') + '</b>' + (h.championWins ? ' · ' + esc(h.championWins) + ' win' + (h.championWins === 1 ? '' : 's') : '') +
            (h.championOwner ? ' · 👤 ' + esc(h.championOwner) : '') + '</span>' +
            (h.mvpUsername ? '<span class="boards__hmvp">MVP ' + esc(h.mvpUsername) + '</span>' : '') + '</li>';
        }).join('') + '</ol>'
        : '';
      if (html !== this.lastHistory) {
        box.innerHTML = html;
        box.hidden = !html;
        this.lastHistory = html;
      }
    }
  };

  SD.ui.leaderboards = leaderboards;
})(globalThis.SD = globalThis.SD || {});
