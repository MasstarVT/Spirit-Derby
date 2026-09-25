/*
 * Spirit Derby - players.js
 * Viewer profiles and the (fictional) Spirit Points ledger (plan sections 2 and 6.4).
 *
 *   join / ensure / touch   profile creation (+JOIN_SP once), daily first-action bonus (+DAILY_SP)
 *   addSp / spendSp / award SP faucets and sinks (never negative, totals tracked, emits player:sp)
 *   claim / release         one runner per player; re-claiming releases the old one
 *   recordAction            participation counters + "backing" (the runner you act on most)
 *
 * Hooks called by the rest of the core when this module is loaded:
 *   SD.game.finishRace   -> applyRaceResults(state, record) -> payouts[]
 *   SD.game.trainRunner  -> award(state, username, amount, reason) -> number awarded
 *   SD.seasons           -> onNewDay(state), onSeasonEnd(state)
 *   SD.persistence       -> normalize(player)
 *
 * Every function takes the state explicitly and is meant to run inside SD.state.mutate
 * (the command pipeline or SD.game wraps it). Validation happens before any write, so a
 * refused claim / spend leaves the state untouched.
 */
(function (SD) {
  'use strict';

  const U = SD.util;

  const STAT_KEYS = ['commands', 'trains', 'rests', 'cheers', 'bets', 'betsWon', 'sabotages', 'boosts',
    'racesParticipated', 'raceVictories', 'hypeContributed', 'spEarnedTotal', 'spSpentTotal'];

  // recordAction(kind) -> stats counter it bumps
  const KIND_STAT = { train: 'trains', rest: 'rests', cheer: 'cheers', bet: 'bets', sabotage: 'sabotages', boost: 'boosts' };
  // Supportive actions that make you a runner's backer (sabotage obviously does not).
  const BACKING_KINDS = { train: true, rest: true, cheer: true, boost: true, snack: true };

  function E() { return SD.CONFIG.ECONOMY; }

  // ---------------------------------------------------------------------------
  // Names
  // ---------------------------------------------------------------------------
  // "@FoxFan " -> "FoxFan" (display form: leading @ stripped, whitespace collapsed, max 25 chars)
  function cleanName(name) {
    return String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, '').trim()
      .replace(/^@+/, '').replace(/\s+/g, ' ').slice(0, 25);
  }
  // "@FoxFan" -> "foxfan" (the players map key)
  function keyOf(name) { return cleanName(name).toLowerCase(); }

  function emptyStats() {
    const o = {};
    STAT_KEYS.forEach(function (k) { o[k] = 0; });
    return o;
  }

  // Day key for the daily bonus: changes every in-game day, including across seasons.
  function dayKey(state) {
    const S = state && state.season;
    return S ? 's' + S.number + 'd' + S.day : 's1d1';
  }

  // ---------------------------------------------------------------------------
  // Construction / lookup
  // ---------------------------------------------------------------------------
  // A fresh Player (plan section 2). Pure: does not touch state.
  function create(username, displayName, opts) {
    opts = opts || {};
    const now = opts.now != null ? opts.now : SD.clock.now();
    const shown = cleanName(displayName) || cleanName(username);
    return {
      username: keyOf(username),
      displayName: shown,
      joinedAt: now,
      lastSeen: now,
      lastDailyDay: null,
      spiritPoints: 0,
      runnerId: null,
      isMod: !!opts.isMod,
      stats: emptyStats(),
      lifetime: emptyStats(),
      achievements: [],
      backing: { runnerId: null, actions: 0 }
    };
  }

  // Fill missing keys on a loaded player (persistence.normalize calls this).
  function normalize(p) {
    if (!p || typeof p !== 'object') return p;
    const tmpl = create(p.username || p.displayName || 'viewer', p.displayName || p.username || 'viewer', { now: p.joinedAt || 0 });
    Object.keys(tmpl).forEach(function (k) { if (p[k] === undefined) p[k] = tmpl[k]; });
    p.username = keyOf(p.username);
    if (!p.displayName) p.displayName = p.username;
    ['stats', 'lifetime'].forEach(function (k) {
      if (!p[k] || typeof p[k] !== 'object') p[k] = emptyStats();
      STAT_KEYS.forEach(function (s) { if (typeof p[k][s] !== 'number' || !isFinite(p[k][s])) p[k][s] = 0; });
    });
    if (!Array.isArray(p.achievements)) p.achievements = [];
    if (!p.backing || typeof p.backing !== 'object') p.backing = { runnerId: null, actions: 0 };
    if (typeof p.backing.actions !== 'number') p.backing.actions = 0;
    if (p.backing.runnerId === undefined) p.backing.runnerId = null;
    p.spiritPoints = Math.max(0, Math.floor(Number(p.spiritPoints) || 0));
    return p;
  }

  function get(state, username) {
    if (!state || !state.players || username == null) return null;
    const k = keyOf(username);
    return k ? (state.players[k] || null) : null;
  }

  function all(state) {
    return state && state.players ? Object.keys(state.players).map(function (k) { return state.players[k]; }) : [];
  }

  function emit(name, payload) { if (SD.bus) SD.bus.emit(name, payload); }

  function isCurrent(state) { return SD.state && SD.state.get() === state; }

  // ---------------------------------------------------------------------------
  // Spirit Points
  // ---------------------------------------------------------------------------
  // Credit SP (amount > 0). Returns { ok, balance, amount }.
  function addSp(state, username, amount, reason) {
    const p = get(state, username);
    if (!p) return { ok: false, balance: 0, amount: 0, message: 'No player called "' + cleanName(username) + '".' };
    const amt = Math.floor(Number(amount) || 0);
    if (amt <= 0) return { ok: true, balance: p.spiritPoints, amount: 0 };
    p.spiritPoints += amt;
    p.stats.spEarnedTotal += amt;
    emit(SD.EVENTS.PLAYER_SP, { username: p.username, displayName: p.displayName, delta: amt, balance: p.spiritPoints, reason: reason || null });
    return { ok: true, balance: p.spiritPoints, amount: amt };
  }

  // Debit SP. Refused (no write) when the balance is too low. Returns { ok, balance, amount, message? }.
  function spendSp(state, username, amount, reason) {
    const p = get(state, username);
    if (!p) return { ok: false, balance: 0, amount: 0, message: 'No player called "' + cleanName(username) + '".' };
    const amt = Math.ceil(Number(amount) || 0);
    if (amt <= 0) return { ok: true, balance: p.spiritPoints, amount: 0 };
    if (p.spiritPoints < amt) {
      return { ok: false, balance: p.spiritPoints, amount: 0, message: 'Not enough Spirit Points: that costs ' + amt + ' SP and you have ' + p.spiritPoints + '.' };
    }
    p.spiritPoints -= amt;
    p.stats.spSpentTotal += amt;
    emit(SD.EVENTS.PLAYER_SP, { username: p.username, displayName: p.displayName, delta: -amt, balance: p.spiritPoints, reason: reason || null });
    return { ok: true, balance: p.spiritPoints, amount: amt };
  }

  // Hook for SD.game (training SP etc.): credit if the player exists. Returns the amount awarded.
  function award(state, username, amount, reason) {
    const r = addSp(state, username, amount, reason);
    return r.ok ? r.amount : 0;
  }

  // ---------------------------------------------------------------------------
  // Join / daily bonus
  // ---------------------------------------------------------------------------
  // Get or create a player. New players get JOIN_SP and today's daily slot (no extra bonus).
  // opts: { source, isMod, now } -> { player, created }
  function ensure(state, username, displayName, opts) {
    opts = opts || {};
    const key = keyOf(username);
    if (!key) return { player: null, created: false };
    let p = state.players[key];
    if (p) return { player: p, created: false };
    p = create(key, displayName || username, opts);
    p.lastDailyDay = dayKey(state);
    state.players[key] = p;
    emit(SD.EVENTS.PLAYER_JOINED, { username: p.username, displayName: p.displayName, source: opts.source || null });
    addSp(state, key, E().JOIN_SP, 'join');
    if (isCurrent(state)) SD.state.log('player', p.displayName + ' joined the Spirit Derby!', 'good', { username: p.username });
    return { player: p, created: true };
  }

  // Mark activity: lastSeen, command count, mod flag, display name, and the +DAILY_SP bonus
  // on the first action of each in-game day. opts: { isMod, displayName, now, count:false }
  // -> { player, dailyBonus }
  function touch(state, username, opts) {
    opts = opts || {};
    const p = get(state, username);
    if (!p) return { player: null, dailyBonus: 0 };
    p.lastSeen = opts.now != null ? opts.now : SD.clock.now();
    if (opts.isMod != null) p.isMod = !!opts.isMod;
    const shown = cleanName(opts.displayName);
    if (shown && shown.toLowerCase() === p.username) p.displayName = shown;
    if (opts.count !== false) p.stats.commands += 1;
    let dailyBonus = 0;
    const today = dayKey(state);
    if (p.lastDailyDay !== today) {
      p.lastDailyDay = today;
      dailyBonus = award(state, p.username, E().DAILY_SP, 'daily');
    }
    return { player: p, dailyBonus: dailyBonus };
  }

  // !join: create (idempotent) + touch. opts.count:false skips the stats.commands bump
  // (the pipeline throttles read-only commands). -> { player, created, dailyBonus }
  function join(state, username, displayName, opts) {
    opts = opts || {};
    const res = ensure(state, username, displayName, opts);
    if (!res.player) return { player: null, created: false, dailyBonus: 0 };
    const t = touch(state, username, { isMod: opts.isMod, displayName: displayName, now: opts.now, count: opts.count });
    return { player: res.player, created: res.created, dailyBonus: t.dailyBonus };
  }

  // ---------------------------------------------------------------------------
  // Runner ownership
  // ---------------------------------------------------------------------------
  function ownerKey(runner) { return runner && runner.owner ? keyOf(runner.owner) : null; }

  function freeRunners(state) {
    return state.runners.filter(function (r) { return !r.retired && !r.owner; });
  }

  // Claim runnerId for username. One runner per player: re-claiming releases the old one.
  // -> { ok, message, runner?, released? (runner name) }
  function claim(state, username, runnerId) {
    const p = get(state, username);
    if (!p) return { ok: false, message: "You're not in the derby yet — type !join" };
    const runner = SD.state.runnerById(runnerId, state);
    if (!runner || runner.retired) return { ok: false, message: 'That runner is not racing any more.' };
    const ok = ownerKey(runner);
    if (ok === p.username) return { ok: false, message: runner.name + ' is already yours!' };
    if (ok) {
      const holder = get(state, ok);
      const free = freeRunners(state).slice(0, 3).map(function (r) { return r.name; });
      return {
        ok: false,
        message: runner.name + ' already runs for ' + ((holder && holder.displayName) || runner.owner) + '. ' +
          (free.length ? 'Free runners: ' + free.join(', ') + '.' : 'Every runner is taken right now.')
      };
    }
    // --- commit ---
    let released = null;
    const old = p.runnerId ? SD.state.runnerById(p.runnerId, state) : null;
    if (old && ownerKey(old) === p.username) {
      old.owner = null;
      old.claimedAt = null;
      released = old.name;
    }
    runner.owner = p.displayName;
    runner.claimedAt = SD.clock.now();
    p.runnerId = runner.id;
    if (isCurrent(state)) {
      SD.state.log('claim', p.displayName + ' claimed ' + runner.emoji + ' ' + runner.name + (released ? ' (released ' + released + ')' : '') + '.',
        'good', { username: p.username, runnerId: runner.id });
    }
    emit(SD.EVENTS.RUNNER_CLAIMED, {
      runnerId: runner.id, username: p.username, displayName: p.displayName,
      releasedRunnerId: old && released ? old.id : null
    });
    return { ok: true, message: p.displayName + ' claimed ' + runner.name + '!', runner: runner, released: released };
  }

  // Give up your runner. -> { ok, message, runnerId? }
  function release(state, username) {
    const p = get(state, username);
    if (!p) return { ok: false, message: "You're not in the derby yet — type !join" };
    const r = p.runnerId ? SD.state.runnerById(p.runnerId, state) : null;
    if (!r) {
      p.runnerId = null;
      return { ok: false, message: "You don't have a runner to release." };
    }
    if (ownerKey(r) === p.username) { r.owner = null; r.claimedAt = null; }
    p.runnerId = null;
    if (isCurrent(state)) SD.state.log('claim', p.displayName + ' released ' + r.name + '.', 'info', { username: p.username, runnerId: r.id });
    emit(SD.EVENTS.RUNNER_CLAIMED, { runnerId: r.id, username: null, displayName: null, releasedRunnerId: r.id, releasedBy: p.username });
    return { ok: true, message: p.displayName + ' released ' + r.name + '.', runnerId: r.id };
  }

  // The runner a player owns (validated against runner.owner), or null.
  function runnerOf(state, username) {
    const p = get(state, username);
    if (!p || !p.runnerId) return null;
    const r = SD.state.runnerById(p.runnerId, state);
    return r && !r.retired && ownerKey(r) === p.username ? r : null;
  }

  // ---------------------------------------------------------------------------
  // Participation
  // ---------------------------------------------------------------------------
  // Count an action and update backing. Backing is a majority-vote counter over the
  // supportive actions since the last race: acting on your backed runner adds 1, acting
  // on another runner subtracts 1 and switches when it reaches 0. Whenever one runner got
  // most of your actions it is the one you back (ties go to the most recent).
  function recordAction(state, username, runnerId, kind) {
    const p = get(state, username);
    if (!p) return null;
    const stat = KIND_STAT[kind];
    if (stat) p.stats[stat] += 1;
    if (runnerId && BACKING_KINDS[kind]) {
      const b = p.backing;
      if (!b.runnerId || b.actions <= 0) { b.runnerId = runnerId; b.actions = 1; }
      else if (b.runnerId === runnerId) b.actions += 1;
      else {
        b.actions -= 1;
        if (b.actions <= 0) { b.runnerId = runnerId; b.actions = 1; }
      }
    }
    return p;
  }

  function addHypeContribution(state, username, delta) {
    const p = get(state, username);
    const d = Number(delta) || 0;
    if (!p || d <= 0) return 0;
    p.stats.hypeContributed = U.round1(p.stats.hypeContributed + d);
    return d;
  }

  // ---------------------------------------------------------------------------
  // Race results (SD.game.finishRace hook)
  // ---------------------------------------------------------------------------
  // Owners get result.spOwner (already scaled by Forest Awakened / day event in race.js).
  // Non-owner backers of a runner in the field get result.spBacker (half). A player is
  // counted once per race in racesParticipated, and in raceVictories when their runner
  // (owned or backed) won. Backing resets for everyone whose backed runner raced.
  // Returns payouts: [{ username, displayName, runnerId, runnerName, place, amount, role }]
  function applyRaceResults(state, record) {
    const payouts = [];
    if (!state || !record || !Array.isArray(record.results)) return payouts;
    const byRunner = {};
    record.results.forEach(function (res) { byRunner[res.runnerId] = res; });
    const participated = {};
    const won = {};

    // Owners (in finishing order).
    record.results.forEach(function (res) {
      if (!res.ownerAtRace) return;
      const p = get(state, res.ownerAtRace);
      if (!p) return;
      const amount = award(state, p.username, res.spOwner || 0, 'raceOwner');
      participated[p.username] = true;
      if (res.place === 1) won[p.username] = true;
      payouts.push({ username: p.username, displayName: p.displayName, runnerId: res.runnerId, runnerName: res.name,
        place: res.place, amount: amount, role: 'owner' });
    });

    // Backers (sorted by key so the order is deterministic).
    Object.keys(state.players).sort().forEach(function (k) {
      const p = state.players[k];
      const b = p.backing;
      if (!b || !b.runnerId || !(b.actions > 0)) return;
      const res = byRunner[b.runnerId];
      if (!res) return; // backed runner was not in this race: keep backing for the next one
      if (!res.ownerAtRace || keyOf(res.ownerAtRace) !== p.username) {
        const amount = award(state, p.username, res.spBacker || 0, 'raceBacker');
        payouts.push({ username: p.username, displayName: p.displayName, runnerId: res.runnerId, runnerName: res.name,
          place: res.place, amount: amount, role: 'backer' });
      }
      participated[p.username] = true;
      if (res.place === 1) won[p.username] = true;
      p.backing = { runnerId: null, actions: 0 };
    });

    Object.keys(participated).forEach(function (k) {
      const p = state.players[k];
      p.stats.racesParticipated += 1;
      if (won[k]) p.stats.raceVictories += 1;
    });

    const paid = payouts.filter(function (x) { return x.amount > 0; });
    if (paid.length && isCurrent(state)) {
      const shown = paid.slice(0, 6).map(function (x) {
        return x.displayName + ' +' + x.amount + ' SP (' + (x.role === 'owner' ? '' : 'backing ') + x.runnerName + ' ' + U.ordinal(x.place) + ')';
      });
      SD.state.log('sp', 'Race payouts: ' + shown.join(', ') + (paid.length > 6 ? ' and ' + (paid.length - 6) + ' more' : '') + '.',
        'good', { recordId: record.id });
    }
    return payouts;
  }

  // ---------------------------------------------------------------------------
  // Day / season hooks
  // ---------------------------------------------------------------------------
  // The daily bonus is keyed on lastDailyDay, so a new day needs no bulk write.
  function onNewDay(state) { return state ? Object.keys(state.players || {}).length : 0; }

  // Season rollover: seasonal stats roll into lifetime (lifetime = completed seasons;
  // all-time = lifetime + stats), SP = SEASON_BASE_SP + 10% carry, owners and backing cleared.
  function onSeasonEnd(state) {
    const EC = E();
    all(state).forEach(function (p) {
      normalize(p);
      STAT_KEYS.forEach(function (k) {
        p.lifetime[k] = U.round1((p.lifetime[k] || 0) + (p.stats[k] || 0));
        p.stats[k] = 0;
      });
      p.spiritPoints = EC.SEASON_BASE_SP + Math.floor((p.spiritPoints || 0) * EC.SEASON_CARRY);
      p.runnerId = null;
      p.backing = { runnerId: null, actions: 0 };
    });
  }

  SD.players = {
    STAT_KEYS: STAT_KEYS,
    cleanName: cleanName,
    keyOf: keyOf,
    dayKey: dayKey,
    create: create,
    normalize: normalize,
    get: get,
    all: all,
    ensure: ensure,
    touch: touch,
    join: join,
    addSp: addSp,
    spendSp: spendSp,
    award: award,
    claim: claim,
    release: release,
    runnerOf: runnerOf,
    freeRunners: freeRunners,
    recordAction: recordAction,
    addHypeContribution: addHypeContribution,
    applyRaceResults: applyRaceResults,
    onNewDay: onNewDay,
    onSeasonEnd: onSeasonEnd
  };
})(globalThis.SD = globalThis.SD || {});
