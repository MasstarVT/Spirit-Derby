/*
 * Spirit Derby - achievements.js
 * Achievements (plan section 6.7): catalog in SD.DATA.ACHIEVEMENTS, unlocked once per viewer,
 * kept across seasons, each worth 25-100 fictional Spirit Points.
 *
 *   init()                       subscribe to the bus (main.js calls it at boot; headless tests call
 *                                it when they want achievements). Until init() runs, check() and
 *                                checkRace() do nothing, so suites that predate M5 are unaffected.
 *   check(state, trigger, ctx)   run one trigger's checks -> unlocked entries[]
 *   checkRace(state, record)     SD.game.finishRace hook -> every unlock tagged with this race
 *                                (owner results, sabotage backfires, winning bets)
 *   unlock(state, user, id, extra)  award once: player.achievements (ids), state.achievements.unlocked
 *                                ({ id, name, username, displayName, sp, at, season, day, recordId? }),
 *                                +sp via SD.players.addSp, an epic log line, achievement:unlocked
 *   listFor(state, user)         a viewer's unlocks in order, with name / desc / icon
 *
 * Bus triggers: player:joined, runner:claimed, runner:trained, runner:rested, hype:changed (who
 * added hype recently), hype:threshold, bet:placed, bet:resolved, race:finished, season:ended/started,
 * runner:levelup, player:sp, runner:spawned and command:result (!cheer, !snack, !sabotage).
 * Listeners that fire outside a mutation wrap their writes in SD.state.mutate.
 * Count-based progress lives in state.achievements.progress[username] (trains, rests, snacks, podiums);
 * state.achievements.lastRaceChecked keeps the race checks to once per record.
 */
(function (SD) {
  'use strict';

  let enabled = false;
  let unsubs = [];

  function CFG() { return SD.CONFIG.ACHIEVEMENTS || {}; }
  function catalog() { return (SD.DATA && SD.DATA.ACHIEVEMENTS) || []; }
  function def(id) {
    const c = catalog();
    for (let i = 0; i < c.length; i++) if (c[i].id === id) return c[i];
    return null;
  }
  function trig(id) { const d = def(id); return (d && d.trigger) || {}; }
  function P() { return SD.players; }
  function cur() { return SD.state && SD.state.get(); }
  function isCurrent(state) { return SD.state && SD.state.get() === state; }
  function keyOf(name) {
    return P() ? P().keyOf(name) : String(name == null ? '' : name).trim().replace(/^@+/, '').toLowerCase();
  }

  // A player by username key or display name (runner.owner and race-event names store display names).
  function playerByName(state, name) {
    if (!P() || name == null || name === '') return null;
    const p = P().get(state, name);
    if (p) return p;
    const all = P().all(state);
    for (let i = 0; i < all.length; i++) if (all[i].displayName === name) return all[i];
    return null;
  }

  function store(state) {
    if (!state.achievements || typeof state.achievements !== 'object') state.achievements = { unlocked: [], progress: {} };
    if (!Array.isArray(state.achievements.unlocked)) state.achievements.unlocked = [];
    if (!state.achievements.progress || typeof state.achievements.progress !== 'object') state.achievements.progress = {};
    return state.achievements;
  }
  function progress(state, username) {
    const pr = store(state).progress;
    const k = keyOf(username);
    return pr[k] || (pr[k] = {});
  }
  function allTime(p, key) { return ((p.stats && p.stats[key]) || 0) + ((p.lifetime && p.lifetime[key]) || 0); }

  function has(state, username, id) {
    const p = P() && P().get(state, username);
    return !!p && Array.isArray(p.achievements) && p.achievements.indexOf(id) >= 0;
  }

  // ---------------------------------------------------------------------------
  // Unlock
  // ---------------------------------------------------------------------------
  function unlock(state, username, id, extra) {
    if (!enabled || !state || !P()) return null;
    const d = def(id);
    if (!d) return null;
    const p = playerByName(state, username);
    if (!p) return null;
    if (!Array.isArray(p.achievements)) p.achievements = [];
    if (p.achievements.indexOf(id) >= 0) return null;
    p.achievements.push(id); // marked before the SP award: player:sp re-enters check()
    const entry = {
      id: id, name: d.name, username: p.username, displayName: p.displayName, sp: d.sp || 0,
      at: SD.clock.now(), season: state.season.number, day: state.season.day
    };
    if (extra && extra.recordId) entry.recordId = extra.recordId;
    store(state).unlocked.push(entry);
    P().addSp(state, p.username, entry.sp, 'achievement');
    if (isCurrent(state)) {
      SD.state.log('achievement', '\u{1F3C5} ' + p.displayName + ' unlocked ' + d.name + ' (+' + entry.sp + ' SP): ' + d.desc, 'epic',
        { username: p.username, achievementId: id });
    }
    const rt = SD.state && SD.state.runtime;
    const ac = rt && rt.activeCommand;
    if (SD.bus) {
      SD.bus.emit(SD.EVENTS.ACHIEVEMENT_UNLOCKED, Object.assign({}, entry, {
        desc: d.desc, icon: d.icon || '\u{1F3C5}', count: p.achievements.length, total: catalog().length,
        // true when the viewer's own command caused it (the command reply already says so)
        duringCommand: !!(ac && ac.username === p.username)
      }));
    }
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Race helpers
  // ---------------------------------------------------------------------------
  // Was runnerId in last place when the leader entered the final turn?
  function wasLastAtFinalTurn(rec, runnerId) {
    const n = (rec.entrants || []).length;
    if (n < (CFG().MIN_FIELD_COMEBACK || 3) || !Array.isArray(rec.ticks) || !rec.ticks.length) return false;
    const ph = (rec.events || []).filter(function (e) { return e.kind === 'phase' && e.data && e.data.phase === 'FINAL_TURN'; })[0];
    if (!ph) return false;
    let tk = rec.ticks[ph.tick];
    if (!tk || tk.t !== ph.tick) tk = rec.ticks.filter(function (t) { return t.t === ph.tick; })[0];
    if (!tk || !Array.isArray(tk.pos)) return false;
    const pos = tk.pos.filter(function (q) { return q.id === runnerId; })[0];
    return !!pos && pos.rank === n;
  }

  function metCryptid(rec, runnerId) {
    const ids = trig('cryptidWhisperer').eventIds || [];
    return (rec.events || []).some(function (e) {
      if (e.kind !== 'event' || !e.data || ids.indexOf(e.data.eventId) < 0) return false;
      return e.runnerId === runnerId || (Array.isArray(e.data.targets) && e.data.targets.indexOf(runnerId) >= 0);
    });
  }

  // ---------------------------------------------------------------------------
  // Checks per trigger: (state, ctx) -> unlocked entries (nulls are filtered by check())
  // ---------------------------------------------------------------------------
  function countUp(state, p, key, statKey) {
    const pr = progress(state, p.username);
    pr[key] = Math.max(pr[key] || 0, statKey ? allTime(p, statKey) : 0) + 1;
    return pr[key];
  }

  const CHECKS = {
    join: function (state, c) { return [unlock(state, c.username, 'firstSteps')]; },
    claim: function (state, c) { return [unlock(state, c.username, 'stableHand')]; },
    create: function (state, c) { return [unlock(state, c.username, 'creator')]; },

    // runner:trained fires before the command records the action, so the count is kept in
    // progress (seeded from the all-time stat) and also counts the roster TRAIN buttons.
    train: function (state, c) {
      const p = playerByName(state, c.username);
      if (!p) return [];
      const out = [];
      if (countUp(state, p, 'trains', 'trains') >= (trig('trainer').min || 10)) out.push(unlock(state, p.username, 'trainer'));
      const r = c.result || {};
      if (r.outcome === 'crit') out.push(unlock(state, p.username, 'criticalHit'));
      if (r.condition === 'Exhausted' && r.conditionBefore !== 'Exhausted') out.push(unlock(state, p.username, 'overtrainer'));
      return out;
    },
    rest: function (state, c) {
      const p = playerByName(state, c.username);
      if (!p) return [];
      return countUp(state, p, 'rests', 'rests') >= (trig('wellRested').min || 5) ? [unlock(state, p.username, 'wellRested')] : [];
    },
    // command:result (after the command recorded the cheer): the all-time stat is exact.
    cheer: function (state, c) {
      const p = playerByName(state, c.username);
      return p && allTime(p, 'cheers') >= (trig('cheerleader').min || 25) ? [unlock(state, p.username, 'cheerleader')] : [];
    },
    snack: function (state, c) {
      const p = playerByName(state, c.username);
      if (!p) return [];
      return countUp(state, p, 'snacks') >= (trig('snackDealer').min || 10) ? [unlock(state, p.username, 'snackDealer')] : [];
    },
    sabotage: function (state, c) { return [unlock(state, c.username, 'saboteur')]; },

    // Everyone who added hype in the last CONFIG.ACHIEVEMENTS.HYPE_WINDOW_MS, plus the action that crossed it.
    hype: function (state, c) {
      const id = c.threshold === trig('hypeTrain').threshold ? 'hypeTrain'
        : (c.threshold === trig('forestAwakened').threshold ? 'forestAwakened' : null);
      if (!id) return [];
      return recentContributors(state, c.by).map(function (u) { return unlock(state, u, id); });
    },

    bet: function (state, c) {
      const b = c.bet;
      return b && b.amount >= (trig('highRoller').amountMin || 200) ? [unlock(state, b.username, 'highRoller')] : [];
    },
    betResolved: function (state, c) {
      const out = [];
      const x = c.recordId ? { recordId: c.recordId } : null;
      (c.bets || []).forEach(function (b) {
        if (!b || !b.won) return;
        if (b.odds >= (trig('sharpEye').oddsMin || 5)) out.push(unlock(state, b.username, 'sharpEye', x));
        if (b.odds >= (trig('longshot').oddsMin || 10)) out.push(unlock(state, b.username, 'longshot', x));
      });
      return out;
    },

    race: function (state, c) {
      const rec = c.record;
      // Race checks run once per record. Race ids are unique within one game state (they carry
      // the race counter), so the guard lives in the state, not in this module.
      const A0 = store(state);
      if (!rec || !Array.isArray(rec.results) || A0.lastRaceChecked === rec.id) return [];
      A0.lastRaceChecked = rec.id;
      const out = [];
      const x = { recordId: rec.id };
      const photo = !!(rec.summary && rec.summary.photoFinish);
      rec.results.forEach(function (res) {
        const owner = res.ownerAtRace ? playerByName(state, res.ownerAtRace) : null;
        if (!owner) return;
        const u = owner.username;
        if (res.place === 1) {
          out.push(unlock(state, u, 'ownersPride', x));
          if (rec.distance >= (trig('marathonMind').distanceMin || 2400)) out.push(unlock(state, u, 'marathonMind', x));
          if (wasLastAtFinalTurn(rec, res.runnerId)) out.push(unlock(state, u, 'comebackKid', x));
        }
        if (res.place <= 3) {
          const pr = progress(state, u);
          pr.podiums = (pr.podiums || 0) + 1;
          if (pr.podiums >= (trig('podiumRegular').podiums || 3)) out.push(unlock(state, u, 'podiumRegular', x));
          if (metCryptid(rec, res.runnerId)) out.push(unlock(state, u, 'cryptidWhisperer', x));
        }
        if (photo && res.place <= 2) out.push(unlock(state, u, 'photoFinish', x));
      });
      (rec.events || []).forEach(function (ev) {
        if (ev.kind === 'chat' && ev.data && ev.data.type === 'sabotage' && ev.data.backfire && ev.data.by) {
          out.push(unlock(state, ev.data.by, 'karma', x));
        }
      });
      return out.concat(CHECKS.betResolved(state, { bets: rec.bets, recordId: rec.id }));
    },

    season: function (state, c) {
      const s = c.summary;
      if (!s || !s.championOwner) return [];
      return [unlock(state, s.championOwner, 'seasonChampion')];
    },

    levelup: function (state, c) {
      const r = c && c.runnerId ? SD.state.runnerById(c.runnerId, state) : null;
      if (!r || !r.owner || r.level < (trig('doubleDigits').levelMin || 10)) return [];
      return [unlock(state, r.owner, 'doubleDigits')];
    },

    sp: function (state, c) {
      const p = playerByName(state, c.username);
      return p && p.spiritPoints >= (trig('spiritHoarder').balanceMin || 1000) ? [unlock(state, p.username, 'spiritHoarder')] : [];
    }
  };

  // Recent hype contributors (runtime only: SD.state.runtime.hypeRecent[username] = ts).
  function noteHype(p) {
    if (!p || !p.by || !(p.delta > 0)) return;
    const rt = SD.state.runtime;
    if (!rt.hypeRecent) rt.hypeRecent = {};
    rt.hypeRecent[keyOf(p.by)] = SD.clock.now();
  }
  function recentContributors(state, by) {
    const rt = SD.state.runtime;
    const map = rt.hypeRecent || {};
    const now = SD.clock.now();
    const win = CFG().HYPE_WINDOW_MS != null ? CFG().HYPE_WINDOW_MS : 180000;
    const users = Object.keys(map).filter(function (k) { return now - map[k] <= win; });
    if (by && users.indexOf(keyOf(by)) < 0) users.push(keyOf(by));
    return users.sort().filter(function (u) { return !!playerByName(state, u); });
  }

  function check(state, trigger, ctx) {
    if (!enabled || !state || !CHECKS[trigger]) return [];
    return (CHECKS[trigger](state, ctx || {}) || []).filter(Boolean);
  }

  // Run a trigger for the live state; wraps writes in a mutate when no mutation is in progress.
  function run(trigger, ctx) {
    const state = cur();
    if (!enabled || !state || !CHECKS[trigger]) return [];
    try {
      if (SD.state.isMutating && SD.state.isMutating()) return check(state, trigger, ctx);
      return SD.state.mutate('achievements:' + trigger, function (st) { return check(st, trigger, ctx); });
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[SD.achievements] ' + trigger + ' check failed:', e);
      return [];
    }
  }

  // SD.game.finishRace hook: race checks, then every unlock tagged with this race (winning bets
  // were already checked on bet:resolved during the same finish).
  function checkRace(state, record) {
    if (!enabled || !state || !record) return [];
    check(state, 'race', { record: record });
    return store(state).unlocked.filter(function (a) { return a.recordId === record.id; }).map(decorate);
  }

  function decorate(a) {
    const d = def(a.id) || {};
    return Object.assign({}, a, { name: a.name || d.name || a.id, desc: d.desc || '', icon: d.icon || '\u{1F3C5}' });
  }

  // A viewer's unlocks in unlock order.
  function listFor(state, username) {
    const p = playerByName(state, username);
    if (!p) return [];
    const entries = store(state).unlocked.filter(function (a) { return a.username === p.username; });
    const seen = {};
    const out = entries.map(function (a) { seen[a.id] = true; return decorate(a); });
    (p.achievements || []).forEach(function (id) {
      if (!seen[id] && def(id)) out.push(decorate({ id: id, username: p.username, displayName: p.displayName, sp: def(id).sp, at: null }));
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  function init() {
    unsubs.forEach(function (u) { u(); });
    unsubs = [];
    enabled = true;
    if (!SD.bus) return { ok: true, count: catalog().length };
    const E = SD.EVENTS;
    const on = function (name, fn) { unsubs.push(SD.bus.on(name, fn)); };
    on(E.PLAYER_JOINED, function (p) { if (p && p.username) run('join', { username: p.username }); });
    on(E.RUNNER_CLAIMED, function (p) { if (p && p.username) run('claim', { username: p.username }); });
    on(E.RUNNER_SPAWNED, function (p) { if (p && p.by) run('create', { username: p.by }); });
    on(E.RUNNER_TRAINED, function (p) { if (p && p.by) run('train', { username: p.by, result: p.result, runnerId: p.runnerId }); });
    on(E.RUNNER_RESTED, function (p) { if (p && p.by) run('rest', { username: p.by }); });
    on(E.HYPE_CHANGED, noteHype);
    on(E.HYPE_THRESHOLD, function (p) { if (p && p.id) run('hype', { threshold: p.id, by: p.by }); });
    on(E.BET_PLACED, function (p) { if (p && p.bet) run('bet', { bet: p.bet }); });
    on(E.BET_RESOLVED, function (p) {
      if (p && !p.refunded && Array.isArray(p.bets) && p.bets.some(function (b) { return b.won; })) run('betResolved', { bets: p.bets, recordId: p.recordId });
    });
    on(E.RACE_FINISHED, function (p) {
      const st = cur();
      if (p && p.record && st && store(st).lastRaceChecked !== p.record.id) run('race', { record: p.record });
    });
    // Season Champion is awarded on season:started (emitted right after season:ended) so the UI's
    // own season:ended handlers (summary modal, chat line) run before the unlock is announced.
    let endedSummary = null;
    on(E.SEASON_ENDED, function (p) { endedSummary = p && p.summary ? p.summary : null; });
    on(E.SEASON_STARTED, function () {
      const sum = endedSummary;
      endedSummary = null;
      if (sum && sum.championOwner) run('season', { summary: sum });
    });
    on(E.RUNNER_LEVELUP, function (p) { if (p && p.level >= (trig('doubleDigits').levelMin || 10)) run('levelup', p); });
    // The listeners below pre-check so a no-op never opens a mutation (no extra state:changed / save).
    on(E.PLAYER_SP, function (p) {
      const st = cur();
      if (p && st && p.balance >= (trig('spiritHoarder').balanceMin || 1000) && !has(st, p.username, 'spiritHoarder')) run('sp', { username: p.username });
    });
    on(E.COMMAND_RESULT, function (p) {
      if (!p || !p.ok || !p.username) return;
      const st = cur();
      if (!st) return;
      if (p.command === 'cheer') {
        const pl = playerByName(st, p.username);
        if (pl && !has(st, pl.username, 'cheerleader') && allTime(pl, 'cheers') >= (trig('cheerleader').min || 25)) run('cheer', { username: p.username });
      } else if (p.command === 'sabotage') {
        if (!has(st, p.username, 'saboteur')) run('sabotage', { username: p.username });
      } else if (p.command === 'snack') {
        run('snack', { username: p.username }); // counts progress
      }
    });
    return { ok: true, count: catalog().length };
  }

  function disable() {
    unsubs.forEach(function (u) { u(); });
    unsubs = [];
    enabled = false;
  }

  function isEnabled() { return enabled; }

  SD.achievements = {
    init: init,
    disable: disable,
    isEnabled: isEnabled,
    catalog: catalog,
    get: def,
    has: has,
    check: check,
    checkRace: checkRace,
    unlock: unlock,
    listFor: listFor,
    progress: progress,
    CHECKS: CHECKS
  };
})(globalThis.SD = globalThis.SD || {});
