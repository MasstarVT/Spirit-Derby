/*
 * Spirit Derby - betting.js
 * Fixed-odds betting on the NEXT race with fictional Spirit Points only
 * (plan section 6.4). There is no real money anywhere in this game: SP cannot be bought,
 * sold or withdrawn.
 *
 *   fieldOdds(state)            the next race's field (SD.game.previewField) with odds and win
 *                               probabilities from SD.race.buildEntrants (queued cheers, boosts and
 *                               sabotages and the hype level included, like startRace); cached per race
 *                               number + settings + field + queued effects
 *   odds(state, runnerId)       -> { odds, winProb } | null
 *   place(state, user, runnerId, amount|'all', now)
 *                               -> { ok, message, bet, replaced?, refunded?, balance, pays }
 *                               10 <= amount <= min(250, balance); one open bet per player (a new
 *                               bet refunds and replaces the old one); SP is taken immediately; the
 *                               bet is QUOTED the current odds (no bets on a runner priced under
 *                               RACE.ODDS.MIN); emits bet:placed. Nothing is counted yet.
 *   cancel(state, user)         refund your open bet
 *   lockForRace(state, record)  (SD.game.startRace hook) refunds bets on runners that did not make
 *                               the field, settles every other bet at min(quoted odds, the gate odds
 *                               in record.entrants) - refunded when that is under RACE.ODDS.MIN - and
 *                               stamps it with the race id; emits bet:locked. Nothing is counted yet
 *   resolve(state, record)      (SD.game.finishRace hook, alias resolveRace) winners get their stake
 *                               back (refundSp) plus the profit floor(amount x odds) - amount as SP
 *                               earned; losers lose the stake. Only a settled bet counts: stats.bets
 *                               (participation) here, bet:resolved (High Roller, Sharp Eye, Longshot)
 *   creditBetHype(state, settled)  (SD.game.finishRace, after the post-race hype decay) hype +GAINS.bet
 *                               with credit per settled bet: it builds toward the next race
 *   refundAll(state, reason)    abort / new day / reset day / season end / interrupted race
 *   open(state)                 -> { count, total, byRunner: { runnerId: { count, total, name } } }
 *
 * Every write happens inside the caller's SD.state.mutate (the command pipeline or SD.game).
 * Validation happens before any write, so a refused bet leaves the state untouched.
 */
(function (SD) {
  'use strict';

  const U = SD.util;
  let cache = { key: null, state: null, value: null };

  function EC() { return SD.CONFIG.ECONOMY; }
  function BC() { return SD.CONFIG.BETTING || {}; }
  // Shortest odds a bet is taken and settled at (CONFIG.RACE.ODDS.MIN).
  function minOdds() {
    const m = Number(SD.CONFIG.RACE.ODDS.MIN);
    return isFinite(m) && m > 0 ? m : 1.1;
  }
  function P() { return SD.players; }
  function keyOf(name) {
    return P() ? P().keyOf(name) : String(name == null ? '' : name).trim().replace(/^@+/, '').toLowerCase();
  }
  function fail(message, extra) { return Object.assign({ ok: false, message: message }, extra || {}); }
  function isCurrent(state) { return SD.state && SD.state.get() === state; }
  // A log line about several bets names their viewers and runners: tagged with them (usernames /
  // runnerIds) so REMOVE VIEWER, DELETE and RENAME find it (SD.game, review batch 8).
  function logTags(record, items) { return SD.state.listTags(items, { recordId: record.id }); }
  function emit(name, payload) { if (SD.bus) SD.bus.emit(name, payload); }
  function fmtOdds(x) {
    x = Number(x);
    if (!isFinite(x) || x <= 0) return '?';
    return x.toFixed(1) + 'x'; // odds are stored to 0.1 and paid exactly: always show that decimal
  }
  function orList(names) {
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  // floor(amount x odds) without float dust (10 x 2.3 = 22.999999999999996 must pay 23).
  function payoutFor(amount, odds) {
    const digits = BC().PAYOUT_ROUND != null ? BC().PAYOUT_ROUND : 2;
    const f = Math.pow(10, digits);
    return Math.floor(Math.round(Number(amount) * Number(odds) * f) / f);
  }

  // ---------------------------------------------------------------------------
  // Odds for the next race
  // ---------------------------------------------------------------------------
  function raceDistance(state) {
    const D = SD.CONFIG.RACE.DISTANCES;
    const d = Number(state.settings && state.settings.distance);
    return D.indexOf(d) >= 0 ? d : D[0];
  }

  // Queued cheers per runner in the field (the same cheerBonus input startRace uses).
  function queuedCheers(state, ids) {
    const out = U.dict();
    (Array.isArray(state.raceEffects) ? state.raceEffects : []).forEach(function (e) {
      if (e && e.type === 'cheer' && ids.indexOf(e.runnerId) >= 0) out[e.runnerId] = (out[e.runnerId] || 0) + Math.max(1, e.count || 1);
    });
    return out;
  }

  // Queued boosts / sabotages the next race on this field would use (SD.game.raceEffectsFor: the same
  // split startRace makes), as buildEntrants chatEffects.
  function queuedChat(state, ids) {
    const queued = Array.isArray(state.raceEffects) ? state.raceEffects : [];
    const used = SD.game && typeof SD.game.raceEffectsFor === 'function' ? SD.game.raceEffectsFor(queued, ids).used
      : queued.filter(function (e) { return e && ids.indexOf(e.runnerId) >= 0; });
    return used.filter(function (e) { return e.type === 'boost' || e.type === 'sabotage'; })
      .map(function (e) { return { runnerId: e.runnerId, type: e.type, count: Math.max(1, e.count || 1) }; });
  }

  function fieldKey(state, field, cheers, chat) {
    const s = state.settings || {};
    const parts = [state.meta.seedSalt, state.meta.raceCounter, state.season.number, state.season.day, raceDistance(state),
      s.runnerCount, state.hype.value, state.season.activeDayEvent, s.debug ? s.seedOverride : '',
      chat.map(function (c) { return c.type + ':' + c.runnerId + ':' + c.count; }).join(',')];
    field.forEach(function (r) {
      parts.push(r.id, r.level, r.style, r.mood, r.condition, U.round2(r.energy), r.maxEnergy, r.ownerKey || '', r.owner || '',
        r.ability && r.ability.id, cheers[r.id] || 0);
      SD.CONFIG.STATS.forEach(function (k) { parts.push(r.stats[k]); });
    });
    return parts.join('|');
  }

  // -> { key, distance, field:[Runner], entrants:[Entrant], byId:{ runnerId: Entrant }, favourite:Entrant|null }
  function fieldOdds(state) {
    state = state || (SD.state && SD.state.get());
    const empty = { key: '', distance: 0, field: [], entrants: [], byId: U.dict(), favourite: null };
    if (!state || !SD.game || typeof SD.game.previewField !== 'function' || !SD.race) return empty;
    let field;
    try { field = SD.game.previewField(); } catch (e) { return empty; }
    if (!Array.isArray(field) || !field.length) return empty;
    const ids = field.map(function (r) { return r.id; });
    const cheers = queuedCheers(state, ids);
    const chat = queuedChat(state, ids);
    const key = fieldKey(state, field, cheers, chat);
    if (cache.key === key && cache.state === state) return cache.value;
    const distance = raceDistance(state);
    const entrants = SD.race.buildEntrants(field, {
      distance: distance, hypeLevel: state.hype.value,
      dayEvent: SD.events.dayEventById(state.season.activeDayEvent), cheerBonus: cheers, chatEffects: chat
    });
    const byId = U.dict();
    entrants.forEach(function (e) { byId[e.runnerId] = e; });
    const favourite = entrants.slice().sort(function (a, b) { return a.odds - b.odds; })[0] || null;
    const value = { key: key, distance: distance, field: field, entrants: entrants, byId: byId, favourite: favourite };
    cache = { key: key, state: state, value: value };
    return value;
  }

  function odds(state, runnerId) {
    const fo = fieldOdds(state);
    const e = fo.byId[runnerId];
    return e ? { odds: e.odds, winProb: e.winProb } : null;
  }

  // ---------------------------------------------------------------------------
  // Open bets
  // ---------------------------------------------------------------------------
  function list(state) { return state && Array.isArray(state.bets) ? state.bets : []; }

  function betOf(state, username) {
    const k = keyOf(username);
    return list(state).filter(function (b) { return b.username === k; })[0] || null;
  }

  function open(state) {
    const out = { count: 0, total: 0, byRunner: {} };
    list(state).forEach(function (b) {
      out.count++;
      out.total += b.amount;
      const r = out.byRunner[b.runnerId] || (out.byRunner[b.runnerId] = { count: 0, total: 0, name: b.runnerName });
      r.count++;
      r.total += b.amount;
    });
    return out;
  }

  function removeBet(state, bet) {
    const i = list(state).indexOf(bet);
    if (i >= 0) state.bets.splice(i, 1);
  }

  // Credit the stake back (a refund reverses the spend; it is not "SP earned").
  function refundBet(state, bet, reason) {
    if (!P() || !(bet.amount > 0)) return 0;
    const r = P().refundSp(state, bet.username, bet.amount, reason || 'betRefund');
    return r.ok ? r.amount : 0;
  }

  // ---------------------------------------------------------------------------
  // Place / cancel
  // ---------------------------------------------------------------------------
  // amount: a number, a numeric string or 'all' (= min(BET_MAX, balance incl. your open bet)).
  function place(state, username, runnerId, amount, now) {
    const E = EC();
    if (!P()) return fail('Player profiles are not available right now.');
    const p = P().get(state, username);
    if (!p) return fail("You're not in the derby yet — type !join");
    if (state.currentRace) return fail('Betting is closed while a race is running. Wait for the results!');
    // M6: after the day's last race (auto-advance off) a bet could only ever be refunded at NEXT DAY.
    if (state.season && state.season.raceIndexInDay >= state.season.racesPerDay) {
      return fail("Today's races are done. Betting opens again when the next day starts.");
    }
    const runner = SD.state.runnerById(runnerId, state);
    if (!runner || runner.retired) return fail('That runner is not racing any more.');
    const fo = fieldOdds(state);
    const ent = fo.byId[runner.id];
    if (!ent) {
      const names = fo.entrants.map(function (e) { return e.name; });
      return fail(runner.name + " isn't in the next race." + (names.length ? ' Bet on ' + orList(names) + '.' : ''));
    }
    // An odds-on runner (priced under RACE.ODDS.MIN) takes no bets: paying more would give up the house edge.
    if (!(ent.odds >= minOdds())) {
      return fail(runner.name + ' is the odds-on favourite (' + fmtOdds(ent.odds) + ') — no bets on it this race. Try another runner (!odds).',
        { oddsOn: true });
    }
    const old = betOf(state, p.username);
    const available = p.spiritPoints + (old ? old.amount : 0);
    const allIn = String(amount).toLowerCase() === 'all';
    let amt = allIn ? Math.min(E.BET_MAX, available) : Math.floor(Number(amount));
    if (!isFinite(amt) || amt <= 0) return fail('Bet a number of Spirit Points between ' + E.BET_MIN + ' and ' + E.BET_MAX + ', e.g. !bet ' + runner.name.split(' ')[0].toLowerCase() + ' 50');
    if (amt < E.BET_MIN) {
      return fail(allIn ? 'You need at least ' + E.BET_MIN + ' SP to bet (you have ' + available + ').'
        : 'The minimum bet is ' + E.BET_MIN + ' SP.');
    }
    if (amt > E.BET_MAX) return fail('The maximum bet is ' + E.BET_MAX + ' SP.');
    if (amt > available) {
      return fail('Not enough Spirit Points: you have ' + p.spiritPoints + ' SP' +
        (old ? ' (+' + old.amount + ' back from your current bet)' : '') + '.');
    }
    if (old && old.runnerId === runner.id && old.amount === amt) {
      return fail('You already have ' + amt + ' SP on ' + runner.name + ' at ' + fmtOdds(old.odds) + '.');
    }

    // --- commit ---
    let refunded = 0;
    if (old) {
      removeBet(state, old);
      refunded = refundBet(state, old, 'betReplaced');
    }
    const spend = P().spendSp(state, p.username, amt, 'bet');
    if (!spend.ok) return fail(spend.message); // unreachable: the balance was checked above
    state.meta.betCounter = (state.meta.betCounter || 0) + 1;
    const bet = {
      id: 'b' + state.meta.betCounter,
      username: p.username,
      displayName: p.displayName,
      runnerId: runner.id,
      runnerName: runner.name,
      amount: amt,
      odds: ent.odds,
      winProb: ent.winProb,
      placedAt: now != null ? now : SD.clock.now(),
      raceNumber: state.meta.raceCounter + 1,
      season: state.season.number,
      day: state.season.day
    };
    state.bets.push(bet);
    // Nothing is counted here (stats.bets, hype, participation, High Roller): a bet counts once, when
    // it is settled in a finished race, so placing, replacing and cancelling bets farms nothing.
    const pays = payoutFor(amt, ent.odds);
    if (isCurrent(state)) {
      SD.state.log('bet', p.displayName + ' bet ' + amt + ' SP on ' + runner.name + ' at ' + fmtOdds(ent.odds) +
        (old ? ' (replacing ' + old.amount + ' SP on ' + old.runnerName + ')' : '') + '.', 'info',
        Object.assign({ username: p.username, runnerId: runner.id, betId: bet.id }, old ? { runnerIds: [runner.id, old.runnerId] } : {}));
    }
    emit(SD.EVENTS.BET_PLACED, {
      bet: bet, username: p.username, displayName: p.displayName,
      replaced: old ? Object.assign({}, old) : null, refunded: refunded, balance: p.spiritPoints
    });
    const message = (old ? 'Bet changed! ' : '') + p.displayName + ' bets ' + amt + ' SP on ' + runner.name + ' at ' +
      fmtOdds(ent.odds) + ' — pays ' + pays + ' SP if ' + runner.name + ' wins!' +
      (old ? ' (Your ' + old.amount + ' SP on ' + old.runnerName + ' was refunded.)' : '') +
      ' · ' + p.spiritPoints + ' SP left';
    return { ok: true, message: message, bet: bet, replaced: old || null, refunded: refunded, balance: p.spiritPoints, pays: pays };
  }

  function cancel(state, username) {
    const b = betOf(state, username);
    if (!b) return fail("You don't have an open bet.");
    if (state.currentRace) return fail('Bets are locked while a race is running.');
    removeBet(state, b);
    const amt = refundBet(state, b, 'betCancelled');
    const p = P().get(state, b.username);
    if (isCurrent(state)) SD.state.log('bet', b.displayName + ' cancelled a ' + b.amount + ' SP bet on ' + b.runnerName + '.', 'info', { username: b.username, runnerId: b.runnerId });
    return { ok: true, message: 'Bet cancelled: ' + amt + ' SP on ' + b.runnerName + ' refunded · ' + (p ? p.spiritPoints : 0) + ' SP', bet: b, refunded: amt };
  }

  // ---------------------------------------------------------------------------
  // Race hooks
  // ---------------------------------------------------------------------------
  // SD.game.startRace, right after the race is simulated. Between a bet and the gate the race can
  // change (!rest / !snack / !boost / !cheer on a runner, hype, the gate's mood roll, the field size or
  // distance, the streamer's settings), so every bet is settled at min(its quoted odds, the race's own
  // odds for that runner in record.entrants): it can only get shorter, never +EV.
  //   - runner not in the field -> refunded ('betNonStarter');
  //   - settled price under RACE.ODDS.MIN (the runner became odds-on) -> refunded ('betOddsOn');
  //   - otherwise b.odds = the settled price and b.recordId = the race id.
  // Nothing is counted here: the race can still be aborted or interrupted (every bet refunded), and
  // hype added now would come after the race was simulated. A bet counts when resolve() settles it.
  // Emits bet:locked { recordId, bets:[copies], repriced:[{ ..., quoted, odds }], refunded:[copies] }
  // (the chat's re-pricing notice) and returns { locked, repriced, refunded }.
  function lockForRace(state, record) {
    const gate = U.dict();
    (record && record.entrants || []).forEach(function (e) { gate[e.runnerId] = e; });
    const locked = [], repriced = [], refunded = [], oddsOn = [];
    list(state).slice().forEach(function (b) {
      const ent = gate[b.runnerId];
      if (!ent) {
        removeBet(state, b);
        refundBet(state, b, 'betNonStarter');
        refunded.push(Object.assign({}, b, { reason: 'nonStarter' }));
        return;
      }
      const quoted = Number(b.odds) || 0;
      const settled = Math.min(quoted, Number(ent.odds) || 0);
      if (!(settled >= minOdds())) {
        removeBet(state, b);
        refundBet(state, b, 'betOddsOn');
        const x = Object.assign({}, b, { reason: 'oddsOn', gateOdds: ent.odds });
        refunded.push(x);
        oddsOn.push(x);
        return;
      }
      if (settled < quoted) {
        b.odds = settled;
        b.winProb = ent.winProb;
        repriced.push(Object.assign({}, b, { quoted: quoted }));
      }
      b.recordId = record.id;
      locked.push(b);
    });
    if (isCurrent(state)) {
      const nonStarters = refunded.filter(function (b) { return b.reason === 'nonStarter'; });
      if (nonStarters.length) {
        SD.state.log('bet', plural(nonStarters.length, 'bet') + ' refunded: ' + nonStarters.map(function (b) {
          return b.displayName + ' (' + b.runnerName + ' is not in this race)';
        }).join(', ') + '.', 'info', logTags(record, nonStarters));
      }
      if (oddsOn.length) {
        SD.state.log('bet', plural(oddsOn.length, 'bet') + ' refunded: ' + oddsOn.map(function (b) {
          return b.displayName + ' (' + b.runnerName + ' is odds-on at the gate, ' + fmtOdds(b.gateOdds) + ')';
        }).join(', ') + '.', 'info', logTags(record, oddsOn));
      }
      if (repriced.length) {
        SD.state.log('bet', 'Odds shortened at the gate: ' + repriced.map(function (b) {
          return b.displayName + "'s " + b.amount + ' SP on ' + b.runnerName + ' now pays ' + fmtOdds(b.odds) + ' (was ' + fmtOdds(b.quoted) + ')';
        }).join(', ') + '.', 'info', logTags(record, repriced));
      }
    }
    emit(SD.EVENTS.BET_LOCKED, {
      recordId: record.id,
      bets: locked.map(function (b) { return Object.assign({}, b); }),
      repriced: repriced,
      refunded: refunded
    });
    return { locked: locked, repriced: repriced, refunded: refunded };
  }

  // SD.game.finishRace: pay the winners at their settled odds (lockForRace). The stake comes back as a
  // refund (it reverses the spend) and only the profit counts as SP earned, so betting turnover never
  // inflates stats.spEarnedTotal (season MVP, the all-time SP board). Every settled bet counts once
  // here (stats.bets / participation); bet:resolved awards High Roller / Sharp Eye / Longshot. Returns
  // [{ id, username, displayName, runnerId, runnerName, amount, odds, payout, won, net }]
  function resolve(state, record) {
    const out = [];
    if (!state || !record || !Array.isArray(record.results) || !record.results.length) return out;
    const bets = list(state).slice();
    if (!bets.length) return out;
    const inField = U.dict();
    (record.entrants || []).forEach(function (e) { inField[e.runnerId] = e; });
    const winner = record.results.filter(function (r) { return r.place === 1; })[0] || record.results[0];
    const leftovers = [];
    bets.forEach(function (b) {
      if (!inField[b.runnerId]) { leftovers.push(b); return; }
      const won = b.runnerId === winner.runnerId;
      const payout = won ? payoutFor(b.amount, b.odds) : 0;
      const p = P() ? P().get(state, b.username) : null;
      if (p) P().recordAction(state, b.username, b.runnerId, 'bet');
      if (won && p) {
        const back = Math.min(b.amount, payout);
        P().refundSp(state, b.username, back, 'betStake');
        P().addSp(state, b.username, payout - back, 'betWin');
        p.stats.betsWon += 1;
      }
      out.push({
        id: b.id, username: b.username, displayName: b.displayName, runnerId: b.runnerId, runnerName: b.runnerName,
        amount: b.amount, odds: b.odds, payout: payout, won: won, net: payout - b.amount
      });
    });
    state.bets = [];
    leftovers.forEach(function (b) { refundBet(state, b, 'betNonStarter'); });

    const winners = out.filter(function (x) { return x.won; });
    const losers = out.filter(function (x) { return !x.won; });
    const totalPaid = winners.reduce(function (a, x) { return a + x.payout; }, 0);
    const totalStaked = out.reduce(function (a, x) { return a + x.amount; }, 0);
    if (isCurrent(state) && out.length) {
      const n = BC().LOG_WINNERS || 6;
      const named = winners.slice(0, n).map(function (x) {
        return x.displayName + ' +' + x.payout + ' SP (' + x.runnerName + ' ' + fmtOdds(x.odds) + ')';
      });
      SD.state.log('bet', (winners.length ? 'Bets paid: ' + named.join(', ') + (winners.length > n ? ' and ' + (winners.length - n) + ' more' : '') : 'No winning bets') +
        (losers.length ? ' · ' + plural(losers.length, 'bet') + ' lost (' + losers.reduce(function (a, x) { return a + x.amount; }, 0) + ' SP)' : '') + '.',
        winners.length ? 'good' : 'info', logTags(record, winners.slice(0, n)));
    }
    emit(SD.EVENTS.BET_RESOLVED, {
      recordId: record.id, bets: out, winners: winners.length, losers: losers.length,
      totalPaid: totalPaid, totalStaked: totalStaked, refunded: leftovers.length
    });
    return out;
  }

  // SD.game.finishRace, after the post-race hype decay: each settled bet (resolve's result) adds
  // HYPE.GAINS.bet with hype credit to its bettor. Added after the race, it builds toward the next race
  // instead of announcing a hype tier the race that just ran never had. Returns the hype added.
  function creditBetHype(state, settled) {
    if (!state || !SD.hype || !Array.isArray(settled)) return 0;
    let total = 0;
    settled.forEach(function (b) {
      if (!b || !b.username || (P() && !P().get(state, b.username))) return;
      const h = SD.hype.add(state, SD.CONFIG.HYPE.GAINS.bet, { by: b.username, reason: 'bet' }).delta;
      if (P()) P().addHypeContribution(state, b.username, h);
      total += Number(h) || 0;
    });
    return U.round1(total);
  }

  // Refund every open bet. Returns the refunded bets.
  const REASON_TEXT = {
    abort: 'the race was cancelled', newDay: 'a new day began', resetDay: 'the day was reset',
    seasonEnd: 'the season ended', interrupted: 'the last race was interrupted', runnerRetired: 'the runner left the derby'
  };
  function refundAll(state, reason) {
    const bets = list(state).slice();
    if (!bets.length) { if (state) state.bets = []; return []; }
    state.bets = [];
    bets.forEach(function (b) { refundBet(state, b, 'betRefund'); });
    if (isCurrent(state)) {
      SD.state.log('bet', plural(bets.length, 'open bet') + ' refunded (' + (REASON_TEXT[reason] || reason || 'refund') + ').', 'info');
    }
    emit(SD.EVENTS.BET_RESOLVED, {
      recordId: null, refunded: true, reason: reason || 'refund',
      bets: bets.map(function (b) {
        return { id: b.id, username: b.username, displayName: b.displayName, runnerId: b.runnerId, runnerName: b.runnerName,
          amount: b.amount, odds: b.odds, payout: 0, won: false, refunded: true };
      })
    });
    return bets;
  }

  // Review batch 8: refund and drop only the open bets pred(bet) picks (a runner retired or deleted by
  // the streamer). Same ledger, log line and bet:resolved {refunded:true} as refundAll. -> refunded bets
  function refundWhere(state, pred, reason) {
    const bets = list(state).filter(function (b) { return b && pred(b); });
    if (!bets.length) return [];
    state.bets = list(state).filter(function (b) { return bets.indexOf(b) < 0; });
    bets.forEach(function (b) { refundBet(state, b, 'betRefund'); });
    if (isCurrent(state)) {
      SD.state.log('bet', plural(bets.length, 'open bet') + ' refunded (' + (REASON_TEXT[reason] || reason || 'refund') + ').', 'info');
    }
    emit(SD.EVENTS.BET_RESOLVED, {
      recordId: null, refunded: true, reason: reason || 'refund',
      bets: bets.map(function (b) {
        return { id: b.id, username: b.username, displayName: b.displayName, runnerId: b.runnerId, runnerName: b.runnerName,
          amount: b.amount, odds: b.odds, payout: 0, won: false, refunded: true };
      })
    });
    return bets;
  }

  function clearCache() { cache = { key: null, state: null, value: null }; }

  SD.betting = {
    fieldOdds: fieldOdds,
    odds: odds,
    open: open,
    list: list,
    betOf: betOf,
    place: place,
    cancel: cancel,
    lockForRace: lockForRace,
    resolve: resolve,
    resolveRace: resolve,       // the name SD.game.finishRace calls
    creditBetHype: creditBetHype,
    refundAll: refundAll,
    refundWhere: refundWhere,
    payoutFor: payoutFor,
    fmtOdds: fmtOdds,
    clearCache: clearCache
  };
})(globalThis.SD = globalThis.SD || {});
