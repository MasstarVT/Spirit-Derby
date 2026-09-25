/*
 * Spirit Derby - training.js
 * Train / rest rules (plan section 6.2) and the passive clock (energy regen, fatigue decay).
 *
 * train() applies runner-local effects (stat gain, energy, fatigue, condition, mood,
 * streak, XP + level-ups) and RETURNS hype / SP amounts for the caller (SD.game) to
 * apply, because hype and Spirit Points belong to other modules.
 */
(function (SD) {
  'use strict';

  const U = SD.util;
  const DOT = ' · '; // " · " separator used in chat replies

  function T() { return SD.CONFIG.TRAINING; }

  // Accepts 'speed', 'SPD', 'luk', ... -> canonical stat or null.
  function normalizeStat(stat) {
    if (stat == null) return null;
    const k = String(stat).toLowerCase().replace(/[^a-z]/g, '');
    return SD.DATA.STAT_ALIASES[k] || null;
  }

  function fill(template, name) { return String(template).replace(/\{r\}/g, name); }

  // Energy factor uses energy BEFORE the training cost.
  function energyFactor(energyBefore) {
    const table = T().ENERGY_F;
    for (let i = 0; i < table.length; i++) if (energyBefore >= table[i][0]) return table[i][1];
    return table[table.length - 1][1];
  }

  // Integer gain with the fractional part rolled (keeps the expected value exact).
  function stochasticRound(x, rng) {
    const f = Math.floor(x);
    return f + (rng.float() < x - f ? 1 : 0);
  }

  // Chances for a given runner right now (exported for UI tooltips / tests).
  function chances(state, runner) {
    const TR = T();
    const mood = SD.DATA.MOODS[runner.mood] || {};
    const hype = state && state.hype ? state.hype.value : 0;
    const e = runner.energy;
    const critP = Math.min(TR.CRIT.MAX, TR.CRIT.BASE + TR.CRIT.PER_LUCK * runner.stats.luck +
      TR.CRIT.PER_WIS * runner.stats.wisdom + (mood.trainCrit || 0) +
      (hype >= SD.CONFIG.RACE.HYPE.AWAKENED ? TR.CRIT.AWAKENED : 0));
    const failP = Math.min(TR.FAIL.MAX, TR.FAIL.BASE + (e < 30 ? TR.FAIL.LOW30 : 0) + (e < 15 ? TR.FAIL.LOW15 : 0) +
      (runner.condition === 'Tired' ? TR.FAIL.TIRED : 0) + (runner.condition === 'Exhausted' ? TR.FAIL.EXHAUSTED : 0) +
      (mood.trainFail || 0));
    return { critP: critP, failP: failP };
  }

  // ---------------------------------------------------------------------------
  // train(state, runner, stat, { rng, by })
  // -> { ok, outcome, stat, gain, energyCost, message, hype, sp, xp, levelUps, conditionChanged, moodChanged }
  // ---------------------------------------------------------------------------
  function train(state, runner, stat, opts) {
    opts = opts || {};
    const TR = T();
    const CFG = SD.CONFIG;
    if (!runner) return { ok: false, message: 'That runner does not exist.' };
    if (runner.retired) return { ok: false, message: runner.name + ' has retired from racing.' };
    const key = normalizeStat(stat);
    if (!key) return { ok: false, message: 'Unknown stat "' + (stat == null ? '' : stat) + '". Try speed, stamina, power, wisdom or luck.' };
    const rng = opts.rng;
    if (!rng || typeof rng.float !== 'function') return { ok: false, message: 'Training needs a random source (internal error).' };
    const label = SD.DATA.STAT_LABELS[key];
    const name = runner.name;
    const energyBefore = runner.energy;
    if (energyBefore < TR.MIN_ENERGY) {
      return { ok: false, message: name + ' is too exhausted to train (energy ' + Math.floor(energyBefore) + '). Try !rest ' + name + '.' };
    }
    const cap = SD.runners.statCap(runner.level);
    const cur = runner.stats[key];
    if (cur >= cap) {
      return { ok: false, message: name + "'s " + label + ' is maxed at ' + cap + ' for level ' + runner.level + '. Race to level up and raise the cap!' };
    }

    const hype = state && state.hype ? state.hype.value : 0;
    const mood = SD.DATA.MOODS[runner.mood] || {};
    const condBefore = runner.condition;
    const moodBefore = runner.mood;
    const ch = chances(state, runner);

    // One roll partitions fail / crit / normal.
    const roll = rng.float();
    const outcome = roll < ch.failP ? 'fail' : (roll < ch.failP + ch.critP ? 'crit' : 'normal');

    // --- stat gain ---
    let gain = 0;
    if (outcome !== 'fail') {
      const base = TR.BASE + TR.PER_LEVEL * runner.level;
      const capFactor = U.clamp((cap - cur) / (TR.CAP_ZONE * cap), 0, 1);
      const condF = SD.runners.conditionTrainMult(runner.condition);
      const hypeF = hype >= CFG.RACE.HYPE.FERAL ? TR.FERAL_MULT : 1;
      let moodF = mood.trainGain || 1;
      if (mood.trainGainRange) moodF = rng.range(mood.trainGainRange[0], mood.trainGainRange[1]);
      const raw = base * capFactor * energyFactor(energyBefore) * condF * hypeF * moodF *
        (outcome === 'crit' ? TR.CRIT.GAIN_MULT : 1);
      gain = stochasticRound(raw, rng);
      if (gain < 1) gain = 1; // a successful session always teaches something
      gain = Math.min(gain, cap - cur);
      runner.stats[key] = cur + gain;
    }

    // --- energy / fatigue ---
    const energyCost = Math.min(TR.ENERGY_COST, energyBefore);
    runner.energy = U.round2(U.clamp(energyBefore - TR.ENERGY_COST, 0, runner.maxEnergy));
    let fatigueGain = energyBefore < TR.FATIGUE_LOW_BELOW ? TR.FATIGUE_LOW : TR.FATIGUE;
    if (outcome === 'fail') fatigueGain += TR.FAIL.EXTRA_FATIGUE;
    runner.fatigue = U.round2(U.clamp(runner.fatigue + fatigueGain, 0, CFG.CONDITION.MAX_FATIGUE));
    SD.runners.refreshCondition(runner);

    // --- mood + streak ---
    if (outcome === 'fail') {
      runner.trainStreak = { stat: null, count: 0 };
      if (rng.chance(TR.FAIL.NERVOUS_P)) SD.runners.setMood(runner, 'Nervous');
    } else {
      if (runner.trainStreak && runner.trainStreak.stat === key) runner.trainStreak.count++;
      else runner.trainStreak = { stat: key, count: 1 };
      if (outcome === 'crit') {
        if (rng.chance(TR.FIRED_UP_ON_CRIT)) SD.runners.setMood(runner, 'Fired Up');
        else if (runner.mood === 'Nervous') SD.runners.setMood(runner, 'Happy'); // a crit cures nerves
      }
      if (runner.trainStreak.count >= TR.STREAK_FOR_DETERMINED && runner.mood !== 'Fired Up' &&
          runner.mood !== 'Chaotic' && runner.mood !== 'Determined') {
        SD.runners.setMood(runner, 'Determined');
      }
    }

    // --- rewards ---
    const rw = TR.REWARDS[outcome];
    const moodHype = (SD.DATA.MOODS[moodBefore] && SD.DATA.MOODS[moodBefore].hypeMult) || 1;
    const hypeGain = rw.hype * moodHype;
    const xpRes = SD.runners.addXp(runner, rw.xp);
    runner.lastActionAt = SD.clock.now();

    // --- message ---
    const hypeMult = state && state.settings ? (state.settings.hypeMultiplier == null ? 1 : state.settings.hypeMultiplier) : 1;
    const hypeShown = Math.round(hypeGain * hypeMult);
    const F = SD.DATA.TRAINING_FLAVOUR;
    let message;
    if (outcome === 'fail') {
      message = fill(rng.pick(F.fail), name) + '\nNo gain' + DOT + 'Energy -' + Math.round(energyCost) +
        (runner.mood === 'Nervous' && moodBefore !== 'Nervous' ? DOT + name + ' looks rattled' : '');
    } else {
      const flavour = fill(rng.pick(outcome === 'crit' ? F.crit : (F.normal[key] || F.crit)), name);
      message = (outcome === 'crit' ? 'CRITICAL TRAINING! ' : '') + flavour + '\n' + label + ' ' + U.signed(gain) +
        DOT + 'Energy -' + Math.round(energyCost) + DOT + 'Hype ' + U.signed(hypeShown);
    }
    if (xpRes.levelUps > 0) message += '\nLEVEL UP! ' + name + ' is now level ' + runner.level + '.';
    const conditionChanged = runner.condition !== condBefore;
    if (conditionChanged && (runner.condition === 'Tired' || runner.condition === 'Exhausted')) {
      message += '\n' + name + ' is now ' + runner.condition + '. Maybe let them !rest?';
    }

    return {
      ok: true,
      outcome: outcome,
      stat: key,
      gain: gain,
      energyCost: energyCost,
      fatigueGain: fatigueGain,
      message: message,
      hype: hypeGain,
      sp: rw.sp,
      xp: rw.xp,
      levelUps: xpRes.levelUps,
      level: runner.level,
      conditionBefore: condBefore,
      condition: runner.condition,
      conditionChanged: conditionChanged,
      moodBefore: moodBefore,
      mood: runner.mood,
      moodChanged: runner.mood !== moodBefore,
      by: opts.by || null
    };
  }

  // ---------------------------------------------------------------------------
  // rest(state, runner, { by, now }) -> { ok, message, energyGain, fatigueDrop, hype, cooldownMs? }
  // Per-runner cooldown lives in SD.state.runtime.runnerCooldowns (not persisted).
  // ---------------------------------------------------------------------------
  function rest(state, runner, opts) {
    opts = opts || {};
    const R = T().REST;
    if (!runner) return { ok: false, message: 'That runner does not exist.' };
    if (runner.retired) return { ok: false, message: runner.name + ' has retired from racing.' };
    const now = opts.now != null ? opts.now : SD.clock.now();
    const cds = SD.state.runtime.runnerCooldowns;
    const last = cds[runner.id] && cds[runner.id].rest;
    if (last != null && now - last < R.COOLDOWN_MS) {
      const left = R.COOLDOWN_MS - (now - last);
      return { ok: false, message: runner.name + ' is still resting. Try again in ' + U.fmtDuration(left) + '.', cooldownMs: left };
    }
    const energyBefore = runner.energy;
    const fatigueBefore = runner.fatigue;
    const condBefore = runner.condition;
    runner.energy = U.round2(U.clamp(runner.energy + R.ENERGY, 0, runner.maxEnergy));
    runner.fatigue = U.round2(U.clamp(runner.fatigue - R.FATIGUE, 0, SD.CONFIG.CONDITION.MAX_FATIGUE));
    SD.runners.refreshCondition(runner);
    const moodBefore = runner.mood;
    SD.runners.setMood(runner, runner.fatigue < R.HAPPY_BELOW ? 'Happy' : 'Sleepy');
    runner.trainStreak = { stat: null, count: 0 };
    runner.lastActionAt = now;
    cds[runner.id] = Object.assign({}, cds[runner.id], { rest: now });

    const energyGain = U.round2(runner.energy - energyBefore);
    const fl = SD.DATA.REST_FLAVOUR;
    const flavour = fill(fl[SD.rng.hash(runner.id + ':' + now) % fl.length], runner.name);
    const message = flavour + '\nEnergy ' + U.signed(energyGain) + DOT + 'Hype ' + R.HYPE + DOT +
      'Feeling ' + runner.condition + (runner.mood === 'Sleepy' ? ' (and very Sleepy)' : '');
    return {
      ok: true,
      message: message,
      energyGain: energyGain,
      fatigueDrop: U.round2(fatigueBefore - runner.fatigue),
      hype: R.HYPE,
      conditionBefore: condBefore,
      condition: runner.condition,
      conditionChanged: condBefore !== runner.condition,
      moodBefore: moodBefore,
      mood: runner.mood,
      by: opts.by || null
    };
  }

  // Remaining rest cooldown for a runner in ms (0 = ready).
  function restCooldownLeft(runner, now) {
    if (!runner) return 0;
    now = now != null ? now : SD.clock.now();
    const c = SD.state.runtime.runnerCooldowns[runner.id];
    if (!c || c.rest == null) return 0;
    return Math.max(0, T().REST.COOLDOWN_MS - (now - c.rest));
  }

  // ---------------------------------------------------------------------------
  // Passive clock: energy +0.75/min (x mood regen), fatigue -1 per 10 min,
  // runners idle for 30 min get Sleepy. Returns ids of runners that changed.
  // ---------------------------------------------------------------------------
  function tickClock(state, elapsedMs) {
    const P = T().PASSIVE;
    const ms = Math.max(0, Number(elapsedMs) || 0);
    const changed = [];
    if (!state || ms <= 0) return changed;
    const mins = ms / 60000;
    const now = SD.clock.now();
    state.runners.forEach(function (r) {
      if (r.retired) return;
      const e0 = r.energy, f0 = r.fatigue, m0 = r.mood, c0 = r.condition;
      const regen = (SD.DATA.MOODS[r.mood] && SD.DATA.MOODS[r.mood].regen) || 1;
      r.energy = U.round2(U.clamp(r.energy + P.ENERGY_PER_MIN * mins * regen, 0, r.maxEnergy));
      r.fatigue = U.round2(U.clamp(r.fatigue - P.FATIGUE_PER_10MIN * mins / 10, 0, SD.CONFIG.CONDITION.MAX_FATIGUE));
      SD.runners.refreshCondition(r);
      if (r.lastActionAt != null && now - r.lastActionAt >= P.SLEEPY_IDLE_MS && r.mood !== 'Sleepy') {
        SD.runners.setMood(r, 'Sleepy');
      }
      if (r.energy !== e0 || r.fatigue !== f0 || r.mood !== m0 || r.condition !== c0) changed.push(r.id);
    });
    return changed;
  }

  SD.training = {
    train: train,
    rest: rest,
    tickClock: tickClock,
    chances: chances,
    normalizeStat: normalizeStat,
    restCooldownLeft: restCooldownLeft
  };
})(globalThis.SD = globalThis.SD || {});
