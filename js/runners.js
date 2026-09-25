/*
 * Spirit Derby - runners.js
 * Runner factory and progression rules: spawning (roster / random species template),
 * stat caps, energy max, XP and level-ups, fatigue -> condition, mood, perf score.
 * Pure functions on runner objects; callers wrap changes in SD.state.mutate.
 */
(function (SD) {
  'use strict';

  const U = SD.util;
  const STATS = SD.CONFIG.STATS;

  // ---------------------------------------------------------------------------
  // Progression formulas (plan section 6.3)
  // ---------------------------------------------------------------------------
  function statCap(level) {
    const P = SD.CONFIG.PROGRESSION;
    return P.CAP_BASE + P.CAP_PER_LEVEL * Math.max(1, level | 0);
  }
  function energyMax(level) {
    const P = SD.CONFIG.PROGRESSION;
    return P.ENERGY_BASE + P.ENERGY_PER_LEVEL * (Math.max(1, level | 0) - 1);
  }
  function xpToNext(level) {
    const P = SD.CONFIG.PROGRESSION;
    return P.XP_BASE + P.XP_PER_LEVEL * (Math.max(1, level | 0) - 1);
  }

  // ---------------------------------------------------------------------------
  // Ids: 'r' + zero-padded counter (r01, r02, ... r99, r100)
  // ---------------------------------------------------------------------------
  function makeId(n) { return 'r' + (n < 10 ? '0' + n : String(n)); }

  // Bump state.meta.runnerCounter and return an unused id.
  function nextId(state) {
    const used = {};
    state.runners.forEach(function (r) { used[r.id] = true; });
    let id;
    do {
      state.meta.runnerCounter = (state.meta.runnerCounter || 0) + 1;
      id = makeId(state.meta.runnerCounter);
    } while (used[id]);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Condition & mood
  // ---------------------------------------------------------------------------
  function conditionBand(labelOrFatigue) {
    const bands = SD.CONFIG.CONDITION.BANDS;
    if (typeof labelOrFatigue === 'number') {
      for (let i = 0; i < bands.length; i++) if (labelOrFatigue <= bands[i][0]) return bands[i];
      return bands[bands.length - 1];
    }
    for (let i = 0; i < bands.length; i++) if (bands[i][1] === labelOrFatigue) return bands[i];
    return bands[2]; // Normal
  }
  function conditionOf(fatigue) { return conditionBand(Math.max(0, Number(fatigue) || 0))[1]; }
  function conditionRaceMult(label) { return conditionBand(label)[2]; }
  function conditionTrainMult(label) { return conditionBand(label)[3]; }

  // Sets runner.condition from fatigue. Returns true when the label changed.
  function refreshCondition(runner) {
    const next = conditionOf(runner.fatigue);
    const changed = runner.condition !== next;
    runner.condition = next;
    return changed;
  }

  function setMood(runner, mood) {
    if (!runner || !SD.DATA.MOODS[mood]) return false;
    const changed = runner.mood !== mood;
    runner.mood = mood;
    return changed;
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------
  function freshRecord() {
    return { races: 0, wins: 0, losses: 0, podiums: 0, bestTimeSec: null, winStreak: 0 };
  }

  function abilityInfo(id) {
    const a = SD.DATA.ABILITIES[id];
    return a ? { id: id, name: a.name, desc: a.desc } : { id: null, name: 'None', desc: '' };
  }

  // Build a complete Runner object from partial fields.
  function baseRunner(o) {
    const stats = {};
    STATS.forEach(function (k) { stats[k] = U.clamp(Math.round(Number(o.stats && o.stats[k]) || 30), 1, statCap(1)); });
    const r = {
      id: o.id,
      rosterKey: o.rosterKey || null,
      name: o.name,
      emoji: o.emoji || '\u{1F43E}',
      badgeColor: o.badgeColor || '#5c8a4a',
      ribbonColor: null,
      avatarUrl: o.avatarUrl || null,
      species: o.species || 'Forest Spirit',
      personality: o.personality || '',
      description: o.description || '',
      style: SD.DATA.STYLES[o.style] ? o.style : 'paceChaser',
      stats: stats,
      baseStats: Object.assign({}, stats),
      level: 1,
      xp: 0,
      totalXp: 0,
      energy: energyMax(1),
      maxEnergy: energyMax(1),
      fatigue: SD.CONFIG.CONDITION.START_FATIGUE,
      condition: 'Excellent',
      mood: SD.DATA.MOODS[o.mood] ? o.mood : SD.CONFIG.MOOD.DEFAULT,
      ability: abilityInfo(o.abilityId),
      owner: null,
      claimedAt: null,
      record: freshRecord(),
      lifetime: { races: 0, wins: 0, totalXp: 0 },
      trainStreak: { stat: null, count: 0 },
      effects: [],
      daily: { snacks: 0 },
      custom: !!o.custom,
      retired: false,
      lastActionAt: null,
      createdAt: SD.clock.now()
    };
    refreshCondition(r);
    return r;
  }

  // One of the 10 named runners. idx is the 0-based roster index (id r01..r10).
  function spawnFromRoster(entry, idx) {
    return baseRunner({
      id: makeId((idx | 0) + 1),
      rosterKey: entry.key,
      name: entry.name,
      emoji: entry.emoji,
      badgeColor: entry.badgeColor,
      species: entry.species,
      personality: entry.personality,
      description: entry.description,
      style: entry.style,
      stats: entry.stats,
      abilityId: entry.abilityId,
      mood: entry.mood,
      custom: false
    });
  }

  // Distribute `total` stat points by species bias with some randomness.
  function rollStats(rng, bias, total) {
    const floor = 20;
    const cap = statCap(1);
    const w = STATS.map(function (k) { return (bias && bias[k] || 1) * (0.75 + 0.5 * rng.float()); });
    const sumW = w.reduce(function (a, b) { return a + b; }, 0);
    const pool = total - floor * STATS.length;
    const vals = w.map(function (x) { return Math.min(cap, floor + Math.floor(pool * x / sumW)); });
    // Hand out any remainder to the most-favoured stats that are still under cap.
    const order = STATS.map(function (_, i) { return i; }).sort(function (a, b) { return w[b] - w[a]; });
    let rem = total - vals.reduce(function (a, b) { return a + b; }, 0);
    let guard = 0;
    while (rem > 0 && guard++ < 1000) {
      const i = order[guard % order.length];
      if (vals[i] < cap) { vals[i]++; rem--; }
    }
    const stats = {};
    STATS.forEach(function (k, i) { stats[k] = vals[i]; });
    return stats;
  }

  function sanitizeName(name) {
    const max = SD.CONFIG.NAMES.MAX_LEN;
    return String(name || '').replace(/[^\p{L}\p{N} '\-.]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function randomName(rng) {
    const P = SD.DATA.NAME_PARTS;
    return rng.pick(P.first) + ' ' + U.capitalize(rng.pick(P.second));
  }

  // Random runner from a species template.
  // opts: { name, style, speciesId, id, abilityId }
  function spawnRandom(rng, opts) {
    opts = opts || {};
    const keys = Object.keys(SD.DATA.SPECIES);
    const speciesId = SD.DATA.SPECIES[opts.speciesId] ? opts.speciesId : rng.pick(keys);
    const sp = SD.DATA.SPECIES[speciesId];
    const style = SD.DATA.STYLES[opts.style] ? opts.style : rng.pick(sp.styles);
    const stats = rollStats(rng, sp.statBias, SD.CONFIG.PROGRESSION.STAT_TOTAL);
    const abilityId = SD.DATA.ABILITIES[opts.abilityId] ? opts.abilityId : rng.pick(SD.DATA.STYLE_ABILITIES[style]);
    const name = sanitizeName(opts.name) || randomName(rng);
    let id = opts.id;
    if (!id) {
      const st = SD.state && SD.state.get();
      id = st ? nextId(st) : 'r' + (1000 + rng.int(9000));
    }
    const r = baseRunner({
      id: id,
      name: name,
      emoji: sp.emoji,
      badgeColor: sp.badgeColor,
      species: sp.name,
      personality: rng.pick(SD.DATA.CUSTOM_PERSONALITIES),
      description: 'A ' + sp.name.toLowerCase() + ' who wandered in from the deep woods to try racing. Runs as a ' +
        SD.DATA.STYLES[style].name + '.',
      style: style,
      stats: stats,
      abilityId: abilityId,
      custom: true
    });
    r.speciesId = speciesId;
    return r;
  }

  // ---------------------------------------------------------------------------
  // XP and levels
  // ---------------------------------------------------------------------------
  function applyLevelUp(runner) {
    const P = SD.CONFIG.PROGRESSION;
    const oldMax = runner.maxEnergy;
    runner.maxEnergy = energyMax(runner.level);
    runner.energy = U.clamp(runner.energy + (runner.maxEnergy - oldMax), 0, runner.maxEnergy);
    const cap = statCap(runner.level);
    STATS.forEach(function (k) { runner.stats[k] = U.clamp(runner.stats[k] + P.LEVELUP_STAT_BONUS, 1, cap); });
  }

  // Adds XP and applies any level-ups. Returns { levelUps, level }.
  function addXp(runner, amount) {
    const P = SD.CONFIG.PROGRESSION;
    const amt = Math.max(0, Math.round(Number(amount) || 0));
    runner.xp += amt;
    runner.totalXp += amt;
    if (runner.lifetime) runner.lifetime.totalXp = (runner.lifetime.totalXp || 0) + amt;
    let ups = 0;
    while (runner.level < P.MAX_LEVEL && runner.xp >= xpToNext(runner.level)) {
      runner.xp -= xpToNext(runner.level);
      runner.level++;
      ups++;
      applyLevelUp(runner);
    }
    if (runner.level >= P.MAX_LEVEL) runner.xp = Math.min(runner.xp, xpToNext(runner.level));
    return { levelUps: ups, level: runner.level };
  }

  // Clamp every resource into its legal range.
  function clampRunner(runner) {
    const cap = statCap(runner.level);
    STATS.forEach(function (k) { runner.stats[k] = U.clamp(Math.round(runner.stats[k]), 1, cap); });
    runner.maxEnergy = energyMax(runner.level);
    runner.energy = U.round2(U.clamp(runner.energy, 0, runner.maxEnergy));
    runner.fatigue = U.round2(U.clamp(runner.fatigue, 0, SD.CONFIG.CONDITION.MAX_FATIGUE));
    refreshCondition(runner);
    return runner;
  }

  // Fill missing fields on a loaded runner (persistence migrations).
  function normalize(runner) {
    const tmpl = baseRunner({ id: runner.id, name: runner.name || 'Mystery Runner', stats: runner.stats, style: runner.style });
    Object.keys(tmpl).forEach(function (k) { if (runner[k] === undefined) runner[k] = tmpl[k]; });
    STATS.forEach(function (k) { if (typeof runner.stats[k] !== 'number') runner.stats[k] = 30; });
    ['record', 'lifetime', 'trainStreak'].forEach(function (k) {
      Object.keys(tmpl[k]).forEach(function (kk) { if (runner[k][kk] === undefined) runner[k][kk] = tmpl[k][kk]; });
    });
    if (!Array.isArray(runner.effects)) runner.effects = [];
    return clampRunner(runner);
  }

  // ---------------------------------------------------------------------------
  // Performance score: stats weighted per phase (CONFIG.RACE.WEIGHTS).
  // statWeightMods (optional) multiplies individual weights (day events),
  // then the row is re-normalised so the scale stays comparable.
  // ---------------------------------------------------------------------------
  function perfScore(runnerLike, phase, statWeightMods) {
    const w = SD.CONFIG.RACE.WEIGHTS[phase];
    if (!w || !runnerLike || !runnerLike.stats) return 0;
    let s = 0, sumW = 0;
    for (let i = 0; i < STATS.length; i++) {
      const k = STATS[i];
      const wk = w[k] * (statWeightMods && statWeightMods[k] != null ? statWeightMods[k] : 1);
      s += wk * (Number(runnerLike.stats[k]) || 0);
      sumW += wk;
    }
    return sumW > 0 ? s / sumW : 0;
  }

  function statTotal(runner) {
    return STATS.reduce(function (a, k) { return a + (runner.stats[k] || 0); }, 0);
  }

  function styleName(style) { return SD.DATA.STYLES[style] ? SD.DATA.STYLES[style].name : style; }

  // One-line summary for chat replies.
  function describe(runner) {
    if (!runner) return '';
    const S = SD.DATA.STAT_SHORT;
    const stats = STATS.map(function (k) { return S[k] + ' ' + runner.stats[k]; }).join(' ');
    return runner.emoji + ' ' + runner.name + ' (Lv ' + runner.level + ' ' + styleName(runner.style) + ') ' + stats +
      ' | Energy ' + Math.floor(runner.energy) + '/' + runner.maxEnergy + ' | ' + runner.condition + ' | ' + runner.mood +
      ' | ' + (runner.owner ? 'Owner: ' + runner.owner : 'Unclaimed') +
      ' | ' + runner.record.wins + 'W / ' + runner.record.races + ' races';
  }

  SD.runners = {
    statCap: statCap,
    energyMax: energyMax,
    xpToNext: xpToNext,
    makeId: makeId,
    nextId: nextId,
    spawnFromRoster: spawnFromRoster,
    spawnRandom: spawnRandom,
    rollStats: rollStats,
    sanitizeName: sanitizeName,
    addXp: addXp,
    conditionOf: conditionOf,
    conditionBand: conditionBand,
    conditionRaceMult: conditionRaceMult,
    conditionTrainMult: conditionTrainMult,
    refreshCondition: refreshCondition,
    setMood: setMood,
    clampRunner: clampRunner,
    normalize: normalize,
    perfScore: perfScore,
    statTotal: statTotal,
    styleName: styleName,
    describe: describe,
    freshRecord: freshRecord
  };
})(globalThis.SD = globalThis.SD || {});
