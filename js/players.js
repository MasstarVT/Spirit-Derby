/*
 * Spirit Derby - players.js
 * Viewer profiles and the (fictional) Spirit Points ledger (plan sections 2 and 6.4).
 *
 *   join / ensure / touch   profile creation (+JOIN_SP once), daily first-action bonus (+DAILY_SP)
 *   addSp / spendSp / award SP faucets and sinks (never negative, totals tracked, emits player:sp)
 *   refundSp                give back spent SP (bet refunds): reverses spSpentTotal, not "earned"
 *   claim / release         one runner per player; re-claiming releases the old one
 *   ownerKey / ownerName    runner ownership is keyed by the owner's login (runner.ownerKey);
 *                           runner.owner is only the display label shown on cards and in chat
 *   STREAMER_KEY            the streamer console's reserved actor key ('#streamer'): no Twitch
 *                           login can produce it, it never becomes a player and earns nothing
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

  // The streamer's own console (chat panel "Streamer" sender, admin SEND AS, roster TRAIN / REST,
  // admin ADD HYPE) acts as this key. Twitch logins match /^[a-z0-9_]{1,25}$/, so a key that
  // starts with '#' can never collide with a viewer. Every '#' key is reserved for local actors:
  // it is never a player (ensure() refuses it), earns no SP, hype credit or achievements, and
  // SD.commands only accepts it from source 'admin'.
  const STREAMER_KEY = '#streamer';
  const STREAMER_NAME = 'Streamer';
  function isReservedKey(key) { return typeof key === 'string' && key.charAt(0) === '#'; }

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

  // state.players is a plain JSON map keyed by login, and 'constructor' / '__proto__' are valid
  // logins: every lookup is an own-property read (SD.util.own) and every insert an own write
  // (SD.util.setOwn), so those names get their own profile and never reach Object.prototype.
  function get(state, username) {
    if (!state || !state.players || username == null) return null;
    const k = keyOf(username);
    return k ? byKey(state, k) : null;
  }
  // The player stored under exactly this key (no keyOf normalisation), or null.
  function byKey(state, k) {
    const p = state ? U.own(state.players, k) : undefined;
    return p && typeof p === 'object' ? p : null;
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

  // Give back SP that was spent (bet refunds, cancelled chat effects). Reverses the spend in the
  // ledger (spSpentTotal goes down) instead of counting as SP earned. Returns { ok, balance, amount }.
  function refundSp(state, username, amount, reason) {
    const p = get(state, username);
    if (!p) return { ok: false, balance: 0, amount: 0, message: 'No player called "' + cleanName(username) + '".' };
    const amt = Math.floor(Number(amount) || 0);
    if (amt <= 0) return { ok: true, balance: p.spiritPoints, amount: 0 };
    p.spiritPoints += amt;
    p.stats.spSpentTotal = Math.max(0, p.stats.spSpentTotal - amt);
    emit(SD.EVENTS.PLAYER_SP, { username: p.username, displayName: p.displayName, delta: amt, balance: p.spiritPoints, reason: reason || 'refund', refund: true });
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
    if (!key || isReservedKey(key)) return { player: null, created: false };
    let p = get(state, key);
    if (p) return { player: p, created: false };
    p = create(key, displayName || username, opts);
    p.lastDailyDay = dayKey(state);
    U.setOwn(state.players, key, p);
    addSp(state, key, E().JOIN_SP, 'join');
    if (isCurrent(state)) SD.state.log('player', p.displayName + ' joined the Spirit Derby!', 'good', { username: p.username });
    // Emitted once the profile is complete (join SP credited), so listeners such as
    // achievements.js (First Steps) see the finished player.
    emit(SD.EVENTS.PLAYER_JOINED, { username: p.username, displayName: p.displayName, source: opts.source || null });
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
    if (shown && shown.toLowerCase() === p.username && shown !== p.displayName) {
      p.displayName = shown;
      // The owned runner's owner label follows the new casing (ownership itself is the login key).
      const mine = p.runnerId ? SD.state.runnerById(p.runnerId, state) : null;
      if (mine && mine.ownerKey === p.username) mine.owner = shown;
    }
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
  // The owner's login key (runner.ownerKey), or null. runner.owner is only the display label.
  function ownerKey(runner) { return runner && typeof runner.ownerKey === 'string' && runner.ownerKey ? runner.ownerKey : null; }

  // Name to show for a runner's owner: the owner's current display name, else the stored label.
  function ownerName(state, runner) {
    const k = ownerKey(runner);
    if (!k) return null;
    const p = byKey(state, k);
    return (p && p.displayName) || runner.owner || k;
  }

  function setOwner(runner, p) {
    runner.ownerKey = p ? p.username : null;
    runner.owner = p ? p.displayName : null;
    runner.claimedAt = p ? SD.clock.now() : null;
  }

  function freeRunners(state) {
    return state.runners.filter(function (r) { return !r.retired && !ownerKey(r); });
  }

  // The login key of a race result's owner at race time. Entrants carry ownerKeyAtRace (schema 3);
  // older records only have the owner label, which old claims wrote as the display name, so it is
  // read as a login (a case variant of it) - never matched against other players' display names.
  function resultOwnerKey(record, res) {
    if (!res) return null;
    const e = record && Array.isArray(record.entrants)
      ? record.entrants.filter(function (x) { return x && x.runnerId === res.runnerId; })[0] : null;
    if (e && e.ownerKeyAtRace !== undefined) return e.ownerKeyAtRace || null;
    return res.ownerAtRace ? keyOf(res.ownerAtRace) || null : null;
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
      const free = freeRunners(state).slice(0, 3).map(function (r) { return r.name; });
      return {
        ok: false,
        message: runner.name + ' already runs for ' + ownerName(state, runner) + '. ' +
          (free.length ? 'Free runners: ' + free.join(', ') + '.' : 'Every runner is taken right now.')
      };
    }
    // --- commit ---
    let released = null;
    const old = p.runnerId ? SD.state.runnerById(p.runnerId, state) : null;
    if (old && ownerKey(old) === p.username) {
      setOwner(old, null);
      released = old.name;
    }
    setOwner(runner, p);
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
    if (ownerKey(r) === p.username) setOwner(r, null);
    p.runnerId = null;
    if (isCurrent(state)) SD.state.log('claim', p.displayName + ' released ' + r.name + '.', 'info', { username: p.username, runnerId: r.id });
    emit(SD.EVENTS.RUNNER_CLAIMED, { runnerId: r.id, username: null, displayName: null, releasedRunnerId: r.id, releasedBy: p.username });
    return { ok: true, message: p.displayName + ' released ' + r.name + '.', runnerId: r.id };
  }

  // The runner a player owns (validated against runner.ownerKey), or null.
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
    // Backing is decided before the gate: while a race is in progress its result is already fixed,
    // so nothing done then (a mid-race !cheer) may move backing onto a runner in that race.
    if (runnerId && BACKING_KINDS[kind] && !state.currentRace) {
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
    // Keyed by login / runner id: no-prototype maps (a '__proto__' key must be stored, not swallowed).
    const byRunner = U.dict();
    record.results.forEach(function (res) { byRunner[res.runnerId] = res; });
    const participated = U.dict();
    const won = U.dict();

    // Owners (in finishing order), by login key at race time.
    const ownerOf = U.dict();
    record.results.forEach(function (res) {
      const k = resultOwnerKey(record, res);
      ownerOf[res.runnerId] = k;
      if (!k) return;
      const p = byKey(state, k);
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
      if (ownerOf[res.runnerId] !== p.username) {
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

  // Review batch 6: retention. Every !join used to stay in the save forever (~800 characters each, so a
  // 5,000-viewer raid alone filled most of the browser's storage quota). At a day change the director
  // removes drive-by viewers who meet ALL of CONFIG.RETENTION's rules:
  //   - not seen (lastSeen) for INACTIVE_DAYS real days (INACTIVE_DAYS 0 turns pruning off);
  //   - all-time participation <= MAX_PARTICIPATION and no race victory, ever;
  //   - holds nothing: no runner (ownerKey or runnerId), no open bet, no queued chat effect;
  //   - not a mod, at most one achievement (First Steps), at most JOIN_SP + DAILY_SP + ACHIEVEMENT_SP_MAX
  //     Spirit Points (what joining, one daily bonus and one achievement give);
  //   - not named in any past season's summary (champion owner, MVP, top hype, win table).
  // Removed with the player: their achievements.progress counters, hype.contributions entry and the
  // achievements.unlocked entries from earlier seasons (this season's summary keeps its own). If they
  // come back, !join starts them afresh. Returns the removed login keys (sorted).
  function prune(state, now) {
    const R = SD.CONFIG.RETENTION || {};
    const days = Number(R.INACTIVE_DAYS) || 0;
    if (!state || !state.players || days <= 0) return [];
    now = now != null ? now : SD.clock.now();
    const cutoff = now - days * 86400000;
    const maxPart = Number(R.MAX_PARTICIPATION) || 0;
    const maxSp = E().JOIN_SP + E().DAILY_SP + (Number(E().ACHIEVEMENT_SP_MAX) || 0);
    const keep = U.dict();
    (state.runners || []).forEach(function (r) { if (r && r.ownerKey) keep[r.ownerKey] = true; });
    (state.bets || []).forEach(function (b) { if (b && b.username) keep[String(b.username).toLowerCase()] = true; });
    (state.raceEffects || []).forEach(function (e) { if (e && e.by) keep[String(e.by).toLowerCase()] = true; });
    // Past seasons: entries written before mvpKey / championOwnerKey existed name the MVP and the
    // champion's owner by display name only, so those labels are matched against logins and display names.
    const keepName = U.dict();
    ((state.season && state.season.history) || []).forEach(function (h) {
      if (!h || typeof h !== 'object') return;
      [h.championOwnerKey, h.mvpKey, h.topHypeContributor && h.topHypeContributor.username].forEach(function (k) { if (k) keep[String(k)] = true; });
      (Array.isArray(h.runnerTable) ? h.runnerTable : []).forEach(function (r) { if (r && r.ownerKey) keep[r.ownerKey] = true; });
      [h.mvpKey ? null : h.mvpUsername, h.championOwnerKey ? null : h.championOwner].forEach(function (label) {
        if (!label) return;
        keep[keyOf(label)] = true;
        keepName[cleanName(label)] = true;
      });
    });
    const part = SD.leaderboards && SD.leaderboards.participation;
    const removed = Object.keys(state.players).filter(function (k) {
      const p = byKey(state, k);
      if (!p || keep[k] || (p.displayName && keepName[cleanName(p.displayName)]) || p.isMod || p.runnerId != null) return false;
      if (!(Number(p.lastSeen) < cutoff)) return false;
      if ((Number(p.spiritPoints) || 0) > maxSp || (Array.isArray(p.achievements) ? p.achievements.length : 0) > 1) return false;
      const st = p.stats || {}, life = p.lifetime || {};
      if ((Number(st.raceVictories) || 0) + (Number(life.raceVictories) || 0) > 0) return false;
      return (part ? part(p, 'all') : (Number(st.commands) || 0) + (Number(life.commands) || 0)) <= maxPart;
    }).sort();
    if (!removed.length) return removed;
    const gone = U.dict();
    removed.forEach(function (k) { gone[k] = true; delete state.players[k]; });
    const A = state.achievements;
    if (A && typeof A === 'object') {
      if (A.progress && typeof A.progress === 'object') removed.forEach(function (k) { if (U.hasOwn(A.progress, k)) delete A.progress[k]; });
      const season = state.season ? state.season.number : null;
      if (Array.isArray(A.unlocked)) {
        const kept = A.unlocked.filter(function (a) { return !(a && gone[a.username] && a.season !== season); });
        if (kept.length !== A.unlocked.length) A.unlocked = kept;
      }
    }
    const H = state.hype && state.hype.contributions;
    if (H && typeof H === 'object') removed.forEach(function (k) { if (U.hasOwn(H, k)) delete H[k]; });
    return removed;
  }

  SD.players = {
    STAT_KEYS: STAT_KEYS,
    STREAMER_KEY: STREAMER_KEY,
    STREAMER_NAME: STREAMER_NAME,
    isReservedKey: isReservedKey,
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
    refundSp: refundSp,
    award: award,
    claim: claim,
    release: release,
    runnerOf: runnerOf,
    ownerKey: ownerKey,
    ownerName: ownerName,
    resultOwnerKey: resultOwnerKey,
    freeRunners: freeRunners,
    recordAction: recordAction,
    addHypeContribution: addHypeContribution,
    applyRaceResults: applyRaceResults,
    onNewDay: onNewDay,
    onSeasonEnd: onSeasonEnd,
    prune: prune
  };
})(globalThis.SD = globalThis.SD || {});
