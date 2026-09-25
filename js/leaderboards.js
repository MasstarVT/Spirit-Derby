/*
 * Spirit Derby - leaderboards.js
 * Six independent boards (plan sections 4, 6.3, 6.4 and 7). Each board ranks ONE metric, so
 * no single stat (SP, wins, spam) can dominate every board:
 *
 *   runnerWins        runner  races won                  season: record.wins     all: lifetime.wins
 *   runnerXp          runner  XP earned                  season: totalXp         all: lifetime.totalXp
 *   spiritPoints      player  SP                         season: balance         all: SP earned ever
 *   participation     player  commands + trains x2 + cheers + rests + bets (CONFIG weights, never SP)
 *   raceVictories     player  races won by the runner the viewer owned or backed
 *   hypeContributions player  hype added to the crowd meter
 *
 * Scope 'season' (default) reads the current season; 'all' reads all-time totals:
 * runner.lifetime already includes the current season, player.lifetime holds completed
 * seasons only, so a player's all-time value is lifetime + stats.
 * Ties share a rank (1, 2, 2, 4); entries with a value of 0 are not ranked.
 * Pure read-only functions of the state: safe to call from the UI and from command handlers.
 */
(function (SD) {
  'use strict';

  const U = SD.util;

  function CFG() { return SD.CONFIG.LEADERBOARDS; }

  // Ordered list of boards. `short` is the chat keyword (!lb <short>), `chip` the Boards-tab label,
  // `noun` what !rank says ("#3 in SP"), `unit` [singular, plural] for labels.
  const CATEGORIES = [
    {
      id: 'runnerWins', name: 'Runner wins', short: 'wins', chip: 'Wins', noun: 'wins', icon: '🏆', kind: 'runner',
      unit: ['win', 'wins'],
      desc: 'Races won by each runner.',
      empty: 'no winners yet. The first race is up for grabs!',
      aliases: ['wins', 'win', 'runnerwins', 'winners']
    },
    {
      id: 'runnerXp', name: 'Runner XP', short: 'xp', chip: 'XP', noun: 'XP', icon: '⭐', kind: 'runner',
      unit: ['XP', 'XP'],
      desc: 'Experience each runner earned from races and training.',
      empty: 'no XP earned yet. Train or race to level up!',
      aliases: ['xp', 'exp', 'level', 'levels', 'runnerxp']
    },
    {
      id: 'spiritPoints', name: 'Spirit Points', short: 'sp', chip: 'SP', noun: 'SP', icon: '🍃', kind: 'player',
      unit: ['SP', 'SP'], unitAll: ['SP earned', 'SP earned'],
      desc: 'Viewers with the most Spirit Points (all-time: total SP ever earned).',
      empty: 'nobody has joined yet. Type !join to get 200 SP!',
      aliases: ['sp', 'points', 'spirit', 'spiritpoints', 'rich']
    },
    {
      id: 'participation', name: 'Participation', short: 'part', chip: 'Active', noun: 'participation', icon: '🙌', kind: 'player',
      unit: ['pt', 'pts'],
      desc: 'Most active viewers: commands + trains ×2 + cheers + rests + bets.',
      empty: 'nobody has taken part yet. Type !join, then !train or !cheer!',
      aliases: ['part', 'active', 'participation', 'activity']
    },
    {
      id: 'raceVictories', name: 'Race victories', short: 'victories', chip: 'Victories', noun: 'victories', icon: '🎖️', kind: 'player',
      unit: ['victory', 'victories'],
      desc: 'Races won by the runner a viewer owned or backed.',
      empty: 'no victories yet. Claim or back a runner and win a race!',
      aliases: ['victories', 'wins-player', 'victory', 'vic', 'playerwins']
    },
    {
      id: 'hypeContributions', name: 'Hype', short: 'hype', chip: 'Hype', noun: 'hype', icon: '🔥', kind: 'player',
      unit: ['hype', 'hype'],
      desc: 'Hype each viewer added to the crowd meter.',
      empty: 'no hype yet. !cheer to wake up the forest!',
      aliases: ['hype', 'hypecontributions', 'crowd']
    }
  ];
  const SCOPES = ['season', 'all'];

  const byId = {};
  const aliasIndex = {};
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  CATEGORIES.forEach(function (c) {
    byId[c.id] = c;
    [c.id, c.short].concat(c.aliases).forEach(function (a) { const k = norm(a); if (k && !aliasIndex[k]) aliasIndex[k] = c.id; });
  });
  const SCOPE_WORDS = {
    season: 'season', current: 'season', now: 'season', s: 'season',
    all: 'all', alltime: 'all', ever: 'all', lifetime: 'all', total: 'all', overall: 'all', forever: 'all'
  };

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------
  // 'wins' / 'Wins' / 'runnerWins' / 'wins-player' -> category id, or null.
  function resolve(alias) {
    const k = norm(alias);
    return k ? (aliasIndex[k] || null) : null;
  }
  function get(categoryId) { return byId[categoryId] || byId[resolve(categoryId)] || null; }
  // 'all' / 'all-time' / 'lifetime' -> 'all'; 'season' -> 'season'; anything else -> null.
  function resolveScope(word) {
    if (word && typeof word === 'object') word = word.scope;
    return SCOPE_WORDS[norm(word)] || null;
  }
  function scopeOf(x) { return resolveScope(x) || 'season'; }

  // ---------------------------------------------------------------------------
  // Values
  // ---------------------------------------------------------------------------
  function n0(v) { v = Number(v); return isFinite(v) ? v : 0; }

  function runnerValue(cat, r, scope) {
    const rec = r.record || {};
    const life = r.lifetime || {};
    if (cat.id === 'runnerWins') return scope === 'all' ? Math.max(n0(life.wins), n0(rec.wins)) : n0(rec.wins);
    if (cat.id === 'runnerXp') return scope === 'all' ? Math.max(n0(life.totalXp), n0(r.totalXp)) : n0(r.totalXp);
    return 0;
  }

  // Seasonal stat, or completed seasons + this season for 'all'.
  function playerStat(p, key, scope) {
    const s = n0(p.stats && p.stats[key]);
    return scope === 'all' ? n0(p.lifetime && p.lifetime[key]) + s : s;
  }

  function participation(p, scope) {
    const W = CFG().PARTICIPATION;
    return Object.keys(W).reduce(function (a, k) { return a + playerStat(p, k, scope) * n0(W[k]); }, 0);
  }

  function playerValue(cat, p, scope) {
    switch (cat.id) {
      case 'spiritPoints': return scope === 'all' ? playerStat(p, 'spEarnedTotal', 'all') : n0(p.spiritPoints);
      case 'participation': return participation(p, scope);
      case 'raceVictories': return playerStat(p, 'raceVictories', scope);
      case 'hypeContributions': return playerStat(p, 'hypeContributed', scope);
      default: return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Formatting (core: no toLocaleString, so output is identical everywhere)
  // ---------------------------------------------------------------------------
  function fmtNum(v) {
    v = n0(v);
    const whole = Math.abs(v - Math.round(v)) < 1e-9;
    const s = whole ? String(Math.round(Math.abs(v))) : Math.abs(v).toFixed(1);
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '-' : '') + parts.join('.');
  }

  function labelOf(cat, value, scope) {
    const unit = (scope === 'all' && cat.unitAll) || cat.unit;
    return fmtNum(value) + ' ' + (value === 1 ? unit[0] : unit[1]);
  }

  // ---------------------------------------------------------------------------
  // Ranking
  // ---------------------------------------------------------------------------
  function ownerName(state, r) {
    if (!r.owner) return null;
    const p = SD.players ? SD.players.get(state, r.owner) : null;
    return (p && p.displayName) || r.owner;
  }

  function runnerEntries(state, cat, scope) {
    return (state.runners || []).filter(function (r) { return r && (scope === 'all' || !r.retired); }).map(function (r) {
      const value = U.round1(runnerValue(cat, r, scope));
      return {
        id: r.id, kind: 'runner', name: r.name, emoji: r.emoji, badgeColor: r.badgeColor,
        ribbonColor: r.ribbonColor || null, avatarUrl: r.avatarUrl || null,
        level: r.level, owner: ownerName(state, r), retired: !!r.retired, value: value
      };
    });
  }

  function playerEntries(state, cat, scope) {
    const players = state.players || {};
    return Object.keys(players).map(function (k) {
      const p = players[k];
      const r = SD.players ? SD.players.runnerOf(state, k) : null;
      return {
        id: p.username || k, kind: 'player', name: p.displayName || p.username || k,
        runnerId: r ? r.id : null, runnerName: r ? r.name : null, runnerEmoji: r ? r.emoji : null,
        value: U.round1(playerValue(cat, p, scope))
      };
    });
  }

  // Every entry with value > 0, sorted and ranked (ties share a rank).
  function all(state, categoryId, scope) {
    const cat = get(categoryId);
    if (!state || !cat) return [];
    scope = scopeOf(scope);
    const list = (cat.kind === 'runner' ? runnerEntries(state, cat, scope) : playerEntries(state, cat, scope))
      .filter(function (e) { return e.value > 0; });
    list.sort(function (a, b) {
      if (b.value !== a.value) return b.value - a.value;
      const an = String(a.name).toLowerCase(), bn = String(b.name).toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    let rank = 0, prev = null;
    list.forEach(function (e, i) {
      if (prev === null || e.value !== prev) { rank = i + 1; prev = e.value; }
      e.rank = rank;
      e.label = labelOf(cat, e.value, scope);
      e.category = cat.id;
      e.scope = scope;
    });
    return list;
  }

  // top(state, categoryId, n = CONFIG.LEADERBOARDS.TOP_N, scope = 'season' | { scope })
  // -> [{ rank, id, kind, name, value, label, ... }]
  //    runners: emoji, badgeColor, ribbonColor, avatarUrl, level, owner (display name) | null
  //    players: runnerId, runnerName, runnerEmoji (their claimed runner) | null
  function top(state, categoryId, n, scope) {
    const count = n == null ? CFG().TOP_N : Math.max(0, Math.floor(Number(n) || 0));
    return all(state, categoryId, scope).slice(0, count);
  }

  // Rank of a runner (id or name) or player (username / display name) on a board.
  // -> { rank, value, label, total } | null (not on the board: value 0 or unknown id)
  function rankOf(state, categoryId, id, scope) {
    const cat = get(categoryId);
    if (!state || !cat || id == null) return null;
    let key = String(id);
    if (cat.kind === 'player') key = SD.players ? SD.players.keyOf(key) : key.toLowerCase();
    else {
      const r = SD.state.runnerById(key, state) || SD.state.findRunner(key, state).runner;
      if (!r) return null;
      key = r.id;
    }
    const list = all(state, cat.id, scope);
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === key) return { rank: list[i].rank, value: list[i].value, label: list[i].label, total: list.length };
    }
    return null;
  }

  // One chat-friendly line:
  // "🏆 Runner wins: 1. Velvet Comet (3) · 2. Moss Runner (2) · 3. Ember Tail (1)"
  function format(state, categoryId, n, scope) {
    const cat = get(categoryId);
    if (!cat) return '';
    scope = scopeOf(scope);
    const list = top(state, cat.id, n == null ? CFG().CHAT_TOP_N : n, scope);
    const head = cat.icon + ' ' + cat.name + (scope === 'all' ? ' (all-time)' : '') + ': ';
    if (!list.length) return head + cat.empty;
    return head + list.map(function (e) { return e.rank + '. ' + e.name + ' (' + fmtNum(e.value) + ')'; }).join(' · ');
  }

  // The season's leading runner(s) by wins, for the paddock line. -> { names, wins, count } | null
  function leader(state, scope) {
    const list = all(state, 'runnerWins', scope);
    if (!list.length) return null;
    const firsts = list.filter(function (e) { return e.rank === 1; });
    return { entries: firsts, names: firsts.map(function (e) { return e.name; }), wins: firsts[0].value, count: firsts.length };
  }

  SD.leaderboards = {
    CATEGORIES: CATEGORIES,
    SCOPES: SCOPES,
    get: get,
    resolve: resolve,
    resolveScope: resolveScope,
    top: top,
    all: all,
    rankOf: rankOf,
    format: format,
    leader: leader,
    participation: participation,
    fmtNum: fmtNum
  };
})(globalThis.SD = globalThis.SD || {});
