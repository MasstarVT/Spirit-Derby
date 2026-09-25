/*
 * Spirit Derby - betting.js
 * Fixed-odds betting on the NEXT race with fictional Spirit Points only
 * (plan section 6.4). There is no real money anywhere in this game: SP cannot be bought,
 * sold or withdrawn.
 *
 *   fieldOdds(state)            the next race's field (SD.game.previewField) with odds and win
 *                               probabilities from SD.race.buildEntrants (queued cheers included,
 *                               exactly like startRace); cached per race number + settings + field
 *   odds(state, runnerId)       -> { odds, winProb } | null
 *   place(state, user, runnerId, amount|'all', now)
 *                               -> { ok, message, bet, replaced?, refunded?, balance }
 *                               10 <= amount <= min(250, balance); one open bet per player (a new
 *                               bet refunds and replaces the old one); SP is taken immediately;
 *                               the odds are locked at placement; hype +1; emits bet:placed
 *   cancel(state, user)         refund your open bet
 *   lockForRace(state, record)  (SD.game.startRace hook) refunds bets on runners that did not make
 *                               the field and stamps the rest with the race id
 *   resolve(state, record)      (SD.game.finishRace hook, alias resolveRace) winners are paid
 *                               floor(amount x locked odds); losers lose the stake; emits bet:resolved
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
  function P() { return SD.players; }
  function keyOf(name) {
    return P() ? P().keyOf(name) : String(name == null ? '' : name).trim().replace(/^@+/, '').toLowerCase();
  }
  function fail(message, extra) { return Object.assign({ ok: false, message: message }, extra || {}); }
  function isCurrent(state) { return SD.state && SD.state.get() === state; }
  function emit(name, payload) { if (SD.bus) SD.bus.emit(name, payload); }
  function fmtOdds(x) {
    x = Number(x);
    if (!isFinite(x) || x <= 0) return '?';
    return (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + 'x';
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
    const out = {};
    (Array.isArray(state.raceEffects) ? state.raceEffects : []).forEach(function (e) {
      if (e && e.type === 'cheer' && ids.indexOf(e.runnerId) >= 0) out[e.runnerId] = (out[e.runnerId] || 0) + Math.max(1, e.count || 1);
    });
    return out;
  }

  function fieldKey(state, field, cheers) {
    const s = state.settings || {};
    const parts = [state.meta.seedSalt, state.meta.raceCounter, state.season.number, state.season.day, raceDistance(state),
      s.runnerCount, state.hype.value, state.season.activeDayEvent, s.debug ? s.seedOverride : ''];
    field.forEach(function (r) {
      parts.push(r.id, r.level, r.style, r.mood, r.condition, U.round2(r.energy), r.maxEnergy, r.owner || '',
        r.ability && r.ability.id, cheers[r.id] || 0);
      SD.CONFIG.STATS.forEach(function (k) { parts.push(r.stats[k]); });
    });
    return parts.join('|');
  }

  // -> { key, distance, field:[Runner], entrants:[Entrant], byId:{ runnerId: Entrant }, favourite:Entrant|null }
  function fieldOdds(state) {
    state = state || (SD.state && SD.state.get());
    const empty = { key: '', distance: 0, field: [], entrants: [], byId: {}, favourite: null };
    if (!state || !SD.game || typeof SD.game.previewField !== 'function' || !SD.race) return empty;
    let field;
    try { field = SD.game.previewField(); } catch (e) { return empty; }
    if (!Array.isArray(field) || !field.length) return empty;
    const ids = field.map(function (r) { return r.id; });
    const cheers = queuedCheers(state, ids);
    const key = fieldKey(state, field, cheers);
    if (cache.key === key && cache.state === state) return cache.value;
    const distance = raceDistance(state);
    const entrants = SD.race.buildEntrants(field, {
      distance: distance, hypeLevel: state.hype.value,
      dayEvent: SD.events.dayEventById(state.season.activeDayEvent), cheerBonus: cheers
    });
    const byId = {};
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
    let hype = 0;
    if (!old || BC().COUNT_REPLACEMENTS) {
      P().recordAction(state, p.username, runner.id, 'bet');
      if (SD.hype) {
        hype = SD.hype.add(state, SD.CONFIG.HYPE.GAINS.bet, { by: p.username, reason: 'bet' }).delta;
        P().addHypeContribution(state, p.username, hype);
      }
    }
    const pays = payoutFor(amt, ent.odds);
    if (isCurrent(state)) {
      SD.state.log('bet', p.displayName + ' bet ' + amt + ' SP on ' + runner.name + ' at ' + fmtOdds(ent.odds) +
        (old ? ' (replacing ' + old.amount + ' SP on ' + old.runnerName + ')' : '') + '.', 'info',
        { username: p.username, runnerId: runner.id, betId: bet.id });
    }
    emit(SD.EVENTS.BET_PLACED, {
      bet: bet, username: p.username, displayName: p.displayName,
      replaced: old ? Object.assign({}, old) : null, refunded: refunded, balance: p.spiritPoints
    });
    const message = (old ? 'Bet changed! ' : '') + p.displayName + ' bets ' + amt + ' SP on ' + runner.name + ' at ' +
      fmtOdds(ent.odds) + ' — pays ' + pays + ' SP if ' + runner.name + ' wins!' +
      (old ? ' (Your ' + old.amount + ' SP on ' + old.runnerName + ' was refunded.)' : '') +
      ' · ' + p.spiritPoints + ' SP left';
    return { ok: true, message: message, bet: bet, replaced: old || null, refunded: refunded, balance: p.spiritPoints, pays: pays, hype: hype };
  }

  function cancel(state, username) {
    const b = betOf(state, username);
    if (!b) return fail("You don't have an open bet.");
    if (state.currentRace) return fail('Bets are locked while a race is running.');
    removeBet(state, b);
    const amt = refundBet(state, b, 'betCancelled');
    const p = P().get(state, b.username);
    if (isCurrent(state)) SD.state.log('bet', b.displayName + ' cancelled a ' + b.amount + ' SP bet on ' + b.runnerName + '.', 'info', { username: b.username });
    return { ok: true, message: 'Bet cancelled: ' + amt + ' SP on ' + b.runnerName + ' refunded · ' + (p ? p.spiritPoints : 0) + ' SP', bet: b, refunded: amt };
  }

  // ---------------------------------------------------------------------------
  // Race hooks
  // ---------------------------------------------------------------------------
  // SD.game.startRace: refund bets on runners that did not make the field (the paddock preview
  // can change between the bet and the gate, e.g. a runner dropped below race energy).
  function lockForRace(state, record) {
    const ids = {};
    (record && record.entrants || []).forEach(function (e) { ids[e.runnerId] = true; });
    const refunded = [];
    list(state).slice().forEach(function (b) {
      if (ids[b.runnerId]) { b.recordId = record.id; return; }
      removeBet(state, b);
      refundBet(state, b, 'betNonStarter');
      refunded.push(b);
    });
    if (refunded.length && isCurrent(state)) {
      SD.state.log('bet', plural(refunded.length, 'bet') + ' refunded: ' + refunded.map(function (b) {
        return b.displayName + ' (' + b.runnerName + ' is not in this race)';
      }).join(', ') + '.', 'info', { recordId: record.id });
    }
    return refunded;
  }

  // SD.game.finishRace: pay the winners at their locked odds. Returns
  // [{ id, username, displayName, runnerId, runnerName, amount, odds, payout, won, net }]
  function resolve(state, record) {
    const out = [];
    if (!state || !record || !Array.isArray(record.results) || !record.results.length) return out;
    const bets = list(state).slice();
    if (!bets.length) return out;
    const inField = {};
    (record.entrants || []).forEach(function (e) { inField[e.runnerId] = e; });
    const winner = record.results.filter(function (r) { return r.place === 1; })[0] || record.results[0];
    const leftovers = [];
    bets.forEach(function (b) {
      if (!inField[b.runnerId]) { leftovers.push(b); return; }
      const won = b.runnerId === winner.runnerId;
      const payout = won ? payoutFor(b.amount, b.odds) : 0;
      const p = P() ? P().get(state, b.username) : null;
      if (won && p) {
        P().addSp(state, b.username, payout, 'betWin');
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
        winners.length ? 'good' : 'info', { recordId: record.id });
    }
    emit(SD.EVENTS.BET_RESOLVED, {
      recordId: record.id, bets: out, winners: winners.length, losers: losers.length,
      totalPaid: totalPaid, totalStaked: totalStaked, refunded: leftovers.length
    });
    return out;
  }

  // Refund every open bet. Returns the refunded bets.
  const REASON_TEXT = {
    abort: 'the race was cancelled', newDay: 'a new day began', resetDay: 'the day was reset',
    seasonEnd: 'the season ended', interrupted: 'the last race was interrupted'
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
    refundAll: refundAll,
    payoutFor: payoutFor,
    fmtOdds: fmtOdds,
    clearCache: clearCache
  };
})(globalThis.SD = globalThis.SD || {});
