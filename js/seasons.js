/*
 * Spirit Derby - seasons.js
 * Day and season lifecycle (plan sections 6.7 and 8). Pure state mutators: they
 * return info objects and write log entries; SD.game wraps them in mutate() and
 * emits the bus events.
 */
(function (SD) {
  'use strict';

  const U = SD.util;

  // Refund all open bets (delegates to SD.betting when it exists).
  function refundBets(state, reason) {
    if (SD.betting && typeof SD.betting.refundAll === 'function') {
      const r = SD.betting.refundAll(state, reason || 'refund');
      return Array.isArray(r) ? r.length : (r || 0);
    }
    let count = 0;
    (state.bets || []).forEach(function (b) {
      const p = state.players[String(b.username || '').toLowerCase()];
      if (p && b.amount > 0) { p.spiritPoints = (p.spiritPoints || 0) + b.amount; count++; }
    });
    state.bets = [];
    return count;
  }

  function rollDay(state, rng) {
    const ev = SD.events.rollDayEvent(rng, state.season.activeDayEvent);
    state.season.activeDayEvent = ev.id;
    return ev;
  }

  // Everyone wakes up refreshed: energy to max, fatigue -40.
  function refreshRunners(state) {
    const rec = SD.CONFIG.SEASON.DAY_FATIGUE_RECOVERY;
    state.runners.forEach(function (r) {
      r.energy = r.maxEnergy;
      r.fatigue = U.round2(U.clamp(r.fatigue - rec, 0, SD.CONFIG.CONDITION.MAX_FATIGUE));
      r.daily = { snacks: 0 };
      SD.runners.refreshCondition(r);
    });
  }

  // Move to the next day (or roll over into a new season).
  // Returns { seasonEnded, summary?, season, day, dayEvent, refunded }
  function advanceDay(state, rng) {
    const S = state.season;
    if (S.day >= S.daysPerSeason) {
      const summary = endSeason(state);
      const started = startSeason(state, rng);
      return { seasonEnded: true, summary: summary, season: S.number, day: S.day, dayEvent: started.dayEvent, refunded: summary.refundedBets || 0 };
    }
    S.day += 1;
    S.raceIndexInDay = 0;
    refreshRunners(state);
    const refunded = refundBets(state, 'newDay');
    SD.hype.reset(state);
    const ev = rollDay(state, rng);
    if (SD.players && typeof SD.players.onNewDay === 'function') SD.players.onNewDay(state);
    if (SD.state.get() === state) {
      SD.state.log('season', 'A new day dawns in the forest: Season ' + S.number + ', Day ' + S.day + '. Today: ' + ev.name + '.', 'good',
        { dayEventId: ev.id });
    }
    return { seasonEnded: false, season: S.number, day: S.day, dayEvent: ev, refunded: refunded };
  }

  // Admin RESET DAY: same day number and event, race slots and energy restored.
  function resetDay(state) {
    state.season.raceIndexInDay = 0;
    refreshRunners(state);
    const refunded = refundBets(state, 'resetDay');
    if (SD.state.get() === state) SD.state.log('season', 'The day was reset: race slots and runner energy restored.', 'info');
    return { season: state.season.number, day: state.season.day, refunded: refunded };
  }

  // Paid-for chat effects (boost / sabotage) still queued when the season ends never run:
  // their SP goes back to the viewers who paid. Returns the number of entries refunded.
  function refundEffects(state) {
    let count = 0;
    (Array.isArray(state.raceEffects) ? state.raceEffects : []).forEach(function (e) {
      if (!e || !(e.paid > 0) || !e.by) return;
      if (SD.players && typeof SD.players.refundSp === 'function') {
        if (SD.players.refundSp(state, e.by, e.paid, 'effectRefund').ok) count++;
      } else {
        const p = state.players[String(e.by).toLowerCase()];
        if (p) { p.spiritPoints = (p.spiritPoints || 0) + e.paid; count++; }
      }
    });
    return count;
  }

  function displayOf(state, username) {
    const p = state.players && state.players[String(username || '').toLowerCase()];
    return p && p.displayName ? p.displayName : username;
  }

  // Summary of the current season so far (does not change state). Plan section 6.7:
  //   champion runner  = most wins, then most season XP (then podiums, then name)
  //   MVP              = the viewer who earned the most SP this season
  //   biggest upset    = the highest winning odds of the season (upset:true when >= RACE.UPSET_ODDS)
  //   runnerTable      = every runner that raced this season, in champion order
  function summary(state) {
    const S = state.season;
    const table = state.runners.filter(function (r) { return r.record && r.record.races > 0; }).map(function (r) {
      return {
        runnerId: r.id, name: r.name, emoji: r.emoji, badgeColor: r.badgeColor, ribbonColor: r.ribbonColor || null,
        owner: r.owner || null, wins: r.record.wins || 0, races: r.record.races || 0, podiums: r.record.podiums || 0,
        xp: Math.round(r.totalXp || 0), level: r.level, bestTimeSec: r.record.bestTimeSec
      };
    });
    table.sort(function (a, b) {
      return (b.wins - a.wins) || (b.xp - a.xp) || (b.podiums - a.podiums) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
    });
    table.forEach(function (row, i) { row.rank = i + 1; });
    const champ = table[0] || null;

    let mvp = null;
    Object.keys(state.players || {}).sort().forEach(function (k) {
      const p = state.players[k];
      const earned = (p.stats && p.stats.spEarnedTotal) || 0;
      if (earned > 0 && (!mvp || earned > mvp.sp)) mvp = { player: p, sp: earned };
    });

    let topHype = null;
    Object.keys(state.hype.contributions || {}).sort().forEach(function (u) {
      const v = state.hype.contributions[u];
      if (v > 0 && (!topHype || v > topHype.hype)) topHype = { username: u, displayName: displayOf(state, u), hype: v };
    });

    let upset = null;
    (state.raceHistory || []).forEach(function (rec) {
      if (rec.season !== S.number || !rec.results || !rec.results.length) return;
      const w = rec.results.filter(function (r) { return r.place === 1; })[0] || rec.results[0];
      let odds = w.odds;
      if (odds == null) {
        const e = (rec.entrants || []).filter(function (x) { return x.runnerId === w.runnerId; })[0];
        odds = e ? e.odds : null;
      }
      if (odds == null) return;
      if (!upset || odds > upset.odds) {
        upset = {
          recordId: rec.id, winnerId: w.runnerId, winnerName: w.name || (rec.summary && rec.summary.winnerName),
          winnerEmoji: rec.summary ? rec.summary.winnerEmoji : null, odds: odds,
          upset: odds >= SD.CONFIG.RACE.UPSET_ODDS, trackName: rec.trackName, distance: rec.distance, day: rec.day
        };
      }
    });

    const achievements = ((state.achievements && state.achievements.unlocked) || []).filter(function (a) {
      return a.season != null ? a.season === S.number : a.at >= (S.startedAt || 0);
    });
    return {
      number: S.number,
      day: S.day,
      daysPerSeason: S.daysPerSeason,
      startedAt: S.startedAt || null,
      championRunnerId: champ ? champ.runnerId : null,
      championName: champ ? champ.name : null,
      championEmoji: champ ? champ.emoji : null,
      championBadgeColor: champ ? champ.badgeColor : null,
      championWins: champ ? champ.wins : 0,
      championXp: champ ? champ.xp : 0,
      championOwner: champ ? champ.owner : null,
      mvpUsername: mvp ? (mvp.player.displayName || mvp.player.username) : null,
      mvpKey: mvp ? mvp.player.username : null,
      mvpSpEarned: mvp ? mvp.sp : 0,
      totalRaces: S.racesRun || 0,
      biggestUpset: upset,
      topHypeContributor: topHype,
      achievements: achievements,
      achievementsCount: achievements.length,
      runnerTable: table,
      endedAt: null
    };
  }

  // Close the season: archive a summary, reset runners/players for a fresh season.
  function endSeason(state) {
    const CFG = SD.CONFIG;
    // Open bets and paid chat effects that will never run are refunded before the SP carry-over.
    const refundedBets = refundBets(state, 'seasonEnd');
    const refundedEffects = refundEffects(state);
    const sum = summary(state);
    sum.endedAt = SD.clock.now();
    sum.refundedBets = refundedBets;
    sum.refundedEffects = refundedEffects;
    state.season.history.push({
      number: sum.number,
      startedAt: sum.startedAt,
      endedAt: sum.endedAt,
      days: sum.day,
      championRunnerId: sum.championRunnerId,
      championName: sum.championName,
      championEmoji: sum.championEmoji,
      championWins: sum.championWins,
      championOwner: sum.championOwner,
      mvpUsername: sum.mvpUsername,
      mvpSpEarned: sum.mvpSpEarned,
      totalRaces: sum.totalRaces,
      biggestUpset: sum.biggestUpset,
      topHypeContributor: sum.topHypeContributor,
      achievementsCount: sum.achievementsCount,
      runnerTable: sum.runnerTable.slice(0, CFG.SEASON.HISTORY_TABLE_N || 10).map(function (r) {
        return { rank: r.rank, runnerId: r.runnerId, name: r.name, emoji: r.emoji, wins: r.wins, races: r.races, podiums: r.podiums, xp: r.xp, owner: r.owner };
      })
    });

    // Runners: back to level 1 keeping base + 10% of what they gained.
    const cap1 = SD.runners.statCap(1);
    state.runners.forEach(function (r) {
      const stats = {};
      CFG.STATS.forEach(function (k) {
        const base = r.baseStats && r.baseStats[k] != null ? r.baseStats[k] : r.stats[k];
        const gained = Math.max(0, r.stats[k] - base);
        stats[k] = U.clamp(base + Math.floor(gained * CFG.SEASON.STAT_CARRY), 1, cap1);
      });
      r.stats = stats;
      r.baseStats = Object.assign({}, stats);
      r.level = 1;
      r.xp = 0;
      r.totalXp = 0;            // season XP (Runner XP board); lifetime.totalXp keeps the all-time total
      r.maxEnergy = SD.runners.energyMax(1);
      r.energy = r.maxEnergy;
      r.fatigue = CFG.CONDITION.START_FATIGUE;
      r.mood = CFG.MOOD.DEFAULT;
      r.owner = null;
      r.claimedAt = null;
      r.record = SD.runners.freshRecord();
      r.trainStreak = { stat: null, count: 0 };
      r.effects = [];
      SD.runners.refreshCondition(r);
    });

    // Players: seasonal stats roll into lifetime, SP = base + 10% carry.
    if (SD.players && typeof SD.players.onSeasonEnd === 'function') {
      SD.players.onSeasonEnd(state);
    } else {
      Object.keys(state.players || {}).forEach(function (k) {
        const p = state.players[k];
        if (p.stats) {
          p.lifetime = p.lifetime || {};
          Object.keys(p.stats).forEach(function (s) {
            p.lifetime[s] = (p.lifetime[s] || 0) + (p.stats[s] || 0);
            p.stats[s] = 0;
          });
        }
        p.spiritPoints = CFG.ECONOMY.SEASON_BASE_SP + Math.floor((p.spiritPoints || 0) * CFG.ECONOMY.SEASON_CARRY);
        p.runnerId = null;
        p.backing = { runnerId: null, actions: 0 };
      });
    }
    state.bets = [];
    state.raceEffects = [];
    SD.hype.reset(state);
    state.hype.contributions = {};
    if (SD.state.get() === state) {
      SD.state.log('season', 'Season ' + sum.number + ' is over! Champion: ' + (sum.championName ? sum.championName +
        ' (' + sum.championWins + ' win' + (sum.championWins === 1 ? '' : 's') + (sum.championOwner ? ', owned by ' + sum.championOwner : '') + ')' : 'nobody') +
        (sum.mvpUsername ? '. MVP: ' + sum.mvpUsername + ' (' + sum.mvpSpEarned + ' SP earned)' : '') + '.', 'epic');
    }
    return sum;
  }

  function startSeason(state, rng) {
    const S = state.season;
    S.number += 1;
    S.day = 1;
    S.raceIndexInDay = 0;
    S.racesRun = 0;
    S.startedAt = SD.clock.now();
    const ev = rollDay(state, rng || SD.rng.create(SD.rng.seedFrom(state.meta.seedSalt, 'season', S.number)));
    if (SD.state.get() === state) {
      SD.state.log('season', 'Season ' + S.number + ' begins! Day 1: ' + ev.name + '.', 'epic', { dayEventId: ev.id });
    }
    return { season: S.number, day: 1, dayEvent: ev };
  }

  SD.seasons = {
    advanceDay: advanceDay,
    resetDay: resetDay,
    endSeason: endSeason,
    startSeason: startSeason,
    summary: summary,
    refundBets: refundBets,
    refundEffects: refundEffects
  };
})(globalThis.SD = globalThis.SD || {});
