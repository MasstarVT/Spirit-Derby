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
      return { seasonEnded: true, summary: summary, season: S.number, day: S.day, dayEvent: started.dayEvent, refunded: 0 };
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

  function playerScore(p) {
    const s = p.stats || {};
    return (s.raceVictories || 0) * 20 + (s.hypeContributed || 0) + (s.trains || 0) * 2 + (s.cheers || 0) + (s.racesParticipated || 0) * 3;
  }

  // Summary of the current season so far (does not change state).
  function summary(state) {
    const S = state.season;
    const runners = state.runners.filter(function (r) { return !r.retired; });
    let champ = null;
    runners.forEach(function (r) {
      if (!r.record || r.record.races === 0) return;
      if (!champ || r.record.wins > champ.record.wins ||
          (r.record.wins === champ.record.wins && (r.record.podiums > champ.record.podiums ||
            (r.record.podiums === champ.record.podiums && r.totalXp > champ.totalXp)))) champ = r;
    });
    let mvp = null, mvpScore = -1;
    Object.keys(state.players || {}).forEach(function (k) {
      const p = state.players[k];
      const sc = playerScore(p);
      if (sc > mvpScore) { mvpScore = sc; mvp = p; }
    });
    let topHype = null;
    Object.keys(state.hype.contributions || {}).forEach(function (u) {
      const v = state.hype.contributions[u];
      if (!topHype || v > topHype.hype) topHype = { username: u, hype: v };
    });
    let upset = null;
    (state.raceHistory || []).forEach(function (rec) {
      if (rec.season !== S.number || !rec.summary || !rec.summary.upset) return;
      if (!upset || rec.summary.upsetOdds > upset.odds) {
        upset = { recordId: rec.id, winnerId: rec.summary.winnerId, winnerName: rec.summary.winnerName, odds: rec.summary.upsetOdds };
      }
    });
    const achievements = ((state.achievements && state.achievements.unlocked) || []).filter(function (a) {
      return a.at >= (S.startedAt || 0);
    });
    return {
      number: S.number,
      day: S.day,
      championRunnerId: champ ? champ.id : null,
      championName: champ ? champ.name : null,
      championEmoji: champ ? champ.emoji : null,
      championWins: champ ? champ.record.wins : 0,
      mvpUsername: mvp && mvpScore > 0 ? (mvp.displayName || mvp.username) : null,
      totalRaces: S.racesRun || 0,
      biggestUpset: upset,
      topHypeContributor: topHype,
      achievements: achievements,
      endedAt: null
    };
  }

  // Close the season: archive a summary, reset runners/players for a fresh season.
  function endSeason(state) {
    const CFG = SD.CONFIG;
    const sum = summary(state);
    sum.endedAt = SD.clock.now();
    state.season.history.push({
      number: sum.number,
      championRunnerId: sum.championRunnerId,
      championName: sum.championName,
      mvpUsername: sum.mvpUsername,
      totalRaces: sum.totalRaces,
      biggestUpset: sum.biggestUpset,
      topHypeContributor: sum.topHypeContributor,
      achievementsCount: sum.achievements.length,
      endedAt: sum.endedAt
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
      SD.state.log('season', 'Season ' + sum.number + ' is over! Champion: ' + (sum.championName || 'nobody') +
        (sum.mvpUsername ? '. MVP: ' + sum.mvpUsername : '') + '.', 'epic');
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
    refundBets: refundBets
  };
})(globalThis.SD = globalThis.SD || {});
