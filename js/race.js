/*
 * Spirit Derby - race.js
 * The deterministic race engine (plan section 5.1). PURE: never touches SD.state.
 *
 *   entrants = SD.race.buildEntrants(runners, { distance, hypeLevel, dayEvent, cheerBonus })
 *   record   = SD.race.simulate({ id, seed, distance, entrants, eventFrequency, hypeLevel,
 *                                 dayEvent, chatEffects, trackName, season, day, indexInDay,
 *                                 rosterAvgLevel })
 *
 * The whole race is simulated up front into a RaceRecord (ticks + events + results);
 * the UI only plays it back. All randomness comes from ONE SD.rng generator seeded by
 * `seed` and consumed in lane order, so the same inputs always give the same race.
 * Rules: never Math.random, never Math.pow/Math.exp inside the tick loop.
 *
 * Sections:
 *   1. Phase + lookup helpers
 *   2. Entrants, ratings and odds
 *   3. Field selection
 *   4. simulate(): setup
 *   5. simulate(): per-runner mechanics (abilities, crits, events, chat effects)
 *   6. simulate(): tick loop
 *   7. simulate(): finish order, results, summary, hash
 */
(function (SD) {
  'use strict';

  const U = SD.util;
  const PHASES = ['START', 'EARLY', 'MID', 'FINAL_TURN', 'FINAL_STRETCH', 'FINISH'];
  const P_START = 0, P_EARLY = 1, P_MID = 2, P_TURN = 3, P_STRETCH = 4, P_FINISH = 5;
  const RUN_PHASES = 5; // phases a runner can actually be running in
  const EMPTY_FX = Object.freeze([]);
  const PHASE_SEVERITY = ['epic', 'info', 'info', 'good', 'epic', 'epic'];
  // Bumped whenever the same inputs would simulate differently (M4 rebalance = 2), so a
  // replay of a race saved by an older build is reported as stale, not as broken determinism.
  const ENGINE_VERSION = 2;

  // ===========================================================================
  // 1. Phase + lookup helpers
  // ===========================================================================

  // Runner phase index from own position fraction (0..1+).
  function phaseIndexOf(fraction) {
    if (!(fraction < 1)) return P_FINISH;
    const b = SD.CONFIG.RACE.PHASE_BOUNDS;
    if (fraction < b[0]) return P_START;
    if (fraction < b[1]) return P_EARLY;
    if (fraction < b[2]) return P_MID;
    if (fraction < b[3]) return P_TURN;
    return P_STRETCH;
  }
  function phaseOf(fraction) { return PHASES[phaseIndexOf(fraction)]; }

  // Table keyed by distance ({1200: x, 1600: y, ...}) with linear inter/extrapolation.
  function interpByDistance(table, distance) {
    if (table[distance] != null) return table[distance];
    const keys = Object.keys(table).map(Number).sort(function (a, b) { return a - b; });
    if (!keys.length) return 0;
    if (keys.length === 1) return table[keys[0]];
    let i = 0;
    while (i < keys.length - 2 && distance > keys[i + 1]) i++;
    const k0 = keys[i], k1 = keys[i + 1];
    const f = (distance - k0) / (k1 - k0);
    return table[k0] + (table[k1] - table[k0]) * f;
  }
  // Positive multipliers by distance (never below 0.1).
  function lookupByDistance(table, distance) { return Math.max(0.1, interpByDistance(table, distance)); }
  function distFactor(distance) { return lookupByDistance(SD.CONFIG.RACE.STAMINA.DIST_FACTOR, distance); }

  // Odds style correction (perf points), per distance: CONFIG.RACE.ODDS.STYLE_PTS[distance][style].
  function stylePts(style, distance) {
    const table = SD.CONFIG.RACE.ODDS.STYLE_PTS;
    if (!table) return 0;
    const byDist = {};
    Object.keys(table).forEach(function (d) {
      if (table[d] && typeof table[d] === 'object' && table[d][style] != null) byDist[d] = table[d][style];
    });
    return Object.keys(byDist).length ? interpByDistance(byDist, distance) : 0;
  }

  // Ability magnitude at a level: base + <key>PerLevel * (level - 1)
  function scaled(ab, key, level) {
    return (ab[key] || 0) + (ab[key + 'PerLevel'] || 0) * (Math.max(1, level || 1) - 1);
  }

  function energyMult(energy, maxEnergy) {
    const E = SD.CONFIG.RACE.ENERGY;
    const e = maxEnergy > 0 ? energy / maxEnergy : 1;
    if (e >= E.LOW) return 1;
    return Math.max(E.MIN, 1 - (E.LOW - e) * E.SLOPE);
  }

  // Race-day stat multiplier: condition x energy. Both scale a runner's EFFECTIVE STATS
  // (its perf score), not its raw velocity, so a well-trained Tired runner can still beat
  // a weak fresh one: Exhausted = stats count 90%, Excellent = 103% (CONFIG.CONDITION.BANDS).
  function raceStatMult(e) {
    return SD.runners.conditionRaceMult(e.condition) * energyMult(e.energy, e.maxEnergy);
  }
  // Velocity multiplier from an (effective) perf score.
  function coreOf(perf) {
    const C = SD.CONFIG.RACE;
    return 1 + C.PERF_SLOPE * (perf - C.PERF_PIVOT) / 100;
  }

  // Mood velocity multiplier per running phase.
  function moodVelArray(moodName) {
    const m = SD.DATA.MOODS[moodName];
    const arr = [1, 1, 1, 1, 1];
    if (!m || !m.vel) return arr;
    for (let i = 0; i < RUN_PHASES; i++) {
      if (!m.velPhases || m.velPhases.indexOf(PHASES[i]) >= 0) arr[i] = 1 + m.vel;
    }
    return arr;
  }

  function at(arr, idx) { return arr[Math.min(idx, arr.length - 1)]; }
  function fill(tpl, name, name2) {
    return String(tpl).replace(/\{r\}/g, name).replace(/\{r2\}/g, name2 == null ? 'the pack' : name2);
  }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function round3(x) { return Math.round(x * 1000) / 1000; }

  // ===========================================================================
  // 2. Entrants, ratings and odds
  // ===========================================================================

  function abilityIdOf(r) {
    if (r.abilityId !== undefined) return r.abilityId;
    return r.ability && r.ability.id ? r.ability.id : null;
  }

  // Snapshot runners into race entrants (lane = order given, 1-based).
  // ctx: { distance, hypeLevel, dayEvent, cheerBonus: { runnerId: cheerCount } }
  function buildEntrants(runners, ctx) {
    ctx = ctx || {};
    const C = SD.CONFIG.RACE;
    const S = C.STAMINA;
    const distance = Number(ctx.distance) || 1200;
    const dm = SD.events.dayModifiers(ctx.dayEvent);
    const cheer = ctx.cheerBonus || {};
    const list = (runners || []).map(function (r, i) {
      const abilityId = abilityIdOf(r);
      const ab = abilityId ? SD.DATA.ABILITIES[abilityId] : null;
      const stats = {};
      SD.CONFIG.STATS.forEach(function (k) { stats[k] = Number(r.stats[k]) || 0; });
      const perf = {};
      for (let p = 0; p < RUN_PHASES; p++) perf[PHASES[p]] = U.round2(SD.runners.perfScore({ stats: stats }, PHASES[p], dm.statWeight));
      let pool = (S.BASE + stats.stamina / S.STA_DIV) * S.POOL_SCALE * distFactor(distance) * dm.poolMult;
      if (ab && ab.poolMult && distance >= (ab.poolMinDistance || 0)) pool *= ab.poolMult;
      const maxEnergy = r.maxEnergy || SD.runners.energyMax(r.level || 1);
      const cheers = Math.max(0, Number(cheer[r.id]) || 0);
      return {
        runnerId: r.id,
        name: r.name,
        emoji: r.emoji || '',
        badgeColor: r.badgeColor || '#5c8a4a',
        ribbonColor: r.ribbonColor || null,
        lane: i + 1,
        style: SD.CONFIG.STYLES[r.style] ? r.style : 'paceChaser',
        abilityId: ab ? abilityId : null,
        ownerAtRace: r.owner || null,
        level: r.level || 1,
        stats: stats,
        condition: r.condition || SD.runners.conditionOf(r.fatigue || 0),
        mood: SD.DATA.MOODS[r.mood] ? r.mood : SD.CONFIG.MOOD.DEFAULT,
        energy: U.round2(r.energy == null ? maxEnergy : r.energy),
        maxEnergy: maxEnergy,
        fatigue: r.fatigue == null ? 0 : U.round2(r.fatigue),
        perf: perf,
        stamMax: U.round1(pool),
        cheerBonus: Math.min(C.CHAT.CHEER_CAP, cheers * C.CHAT.CHEER_PER),
        wildRoll: null,
        form: null,
        rating: 0,
        winProb: 0,
        odds: 0
      };
    });
    assignOdds(list, distance);
    return list;
  }

  // Odds features for an entrant (all in "perf points": 1 point ~ PERF_SLOPE % speed).
  // Exposed so tools/balance-test.js can calibrate CONFIG.RACE.ODDS against real results.
  function oddsFeatures(e, distance) {
    const C = SD.CONFIG.RACE;
    const share = C.PHASE_SHARE;
    const style = SD.CONFIG.STYLES[e.style] || SD.CONFIG.STYLES.paceChaser;
    const ptsPerVel = 100 / C.PERF_SLOPE;
    const moodVel = moodVelArray(e.mood);
    const mood = SD.DATA.MOODS[e.mood] || {};
    const statMult = raceStatMult(e);
    let perfAvg = 0, moodAvg = 0, drainPerM = 0;
    const ab = e.abilityId ? SD.DATA.ABILITIES[e.abilityId] : null;
    for (let i = 0; i < RUN_PHASES; i++) {
      const perf = e.perf[PHASES[i]];
      perfAvg += share[i] * perf;
      moodAvg += share[i] * moodVel[i];
      // Rough stamina use per phase: speed^2.5 x style drain (ignores drafting and events).
      let drain = style.drain[i];
      if (ab && ab.drainMult && ab.phase === PHASES[i] && ab.hook === 'tick') drain *= ab.drainMult; // Moonlight Pace
      const speedRel = coreOf(perf * statMult) * style.vel[i] * moodVel[i];
      drainPerM += share[i] * drain * Math.pow(Math.max(0.5, speedRel), 2.5);
    }
    // Wild Cards: expected value of the hidden roll (luck lowers the collapse chance).
    let wildMean = 1;
    if (e.style === 'wildCard') {
      const W = SD.CONFIG.WILD;
      const cp = U.clamp(W.COLLAPSE_P - ((e.stats.luck || 0) - 40) * (W.LUCK_TILT || 0), W.COLLAPSE_MIN, W.COLLAPSE_MAX);
      wildMean = cp * W.COLLAPSE_VEL + W.GREAT_P * W.GREAT_VEL + (1 - cp - W.GREAT_P);
    }
    // Race-day modifiers in perf points: condition + energy scale the stats directly; mood,
    // cheers and the wild roll are velocity multipliers converted to perf points.
    const formPts = perfAvg * (statMult - 1) + ((moodAvg - 1) + (e.cheerBonus || 0) + (wildMean - 1)) * ptsPerVel;
    // Expected stamina fraction left at the line.
    const expectedDrain = distance * drainPerM * C.STAMINA.DRAIN_SCALE * (mood.drain || 1);
    const remain = 1 - expectedDrain / Math.max(1, e.stamMax);
    return { perfAvg: perfAvg, formPts: formPts, remain: remain, style: e.style, abilityId: e.abilityId || null };
  }

  // Pre-race strength rating in perf points. Used for odds only; the engine never reads it.
  // The stamina reserve only counts up to REMAIN_CAP (beyond that nobody is short anyway).
  function ratingOf(e, distance) {
    const O = SD.CONFIG.RACE.ODDS;
    const f = oddsFeatures(e, distance);
    let rating = f.perfAvg + f.formPts + stylePts(f.style, distance);
    rating += O.REMAIN_PTS * Math.min(f.remain, O.REMAIN_CAP == null ? 1 : O.REMAIN_CAP);
    if (f.remain < O.SAFE_REMAIN) rating -= (O.SAFE_REMAIN - f.remain) * O.SHORTFALL_PTS;
    const ab = f.abilityId ? SD.DATA.ABILITIES[f.abilityId] : null;
    if (ab && ab.rating) rating += ab.rating;
    return rating;
  }

  // In-race swing segment length: a number or a per-distance table. Scaling it with the
  // distance keeps the number of independent swings per race (and so the race-level luck)
  // about the same at 1200 and 2400 m.
  function segmentTicks(distance) {
    const s = SD.CONFIG.RACE.NOISE.SEGMENT_TICKS;
    return Math.max(1, Math.round(typeof s === 'number' ? s : interpByDistance(s, distance)));
  }

  // Softmax temperature (perf points): a number or a per-distance table. Longer races
  // average out more of the in-race swing, so the favourite is surer at 2400 m.
  function oddsTemp(distance) {
    const T = SD.CONFIG.RACE.ODDS.TEMP;
    return Math.max(0.5, typeof T === 'number' ? T : interpByDistance(T, distance));
  }

  // Softmax over ratings -> win probability -> decimal odds with house edge.
  function assignOdds(list, distance) {
    const O = SD.CONFIG.RACE.ODDS;
    if (!list.length) return list;
    const ratings = list.map(function (e) { return ratingOf(e, distance); });
    const maxR = Math.max.apply(null, ratings);
    const temp = oddsTemp(distance);
    const ex = ratings.map(function (r) { return Math.exp((r - maxR) / temp); });
    const sum = ex.reduce(function (a, b) { return a + b; }, 0);
    list.forEach(function (e, i) {
      const p = ex[i] / sum;
      e.rating = U.round2(ratings[i]);
      e.winProb = Math.round(p * 10000) / 10000;
      e.odds = U.clamp(U.round1(O.HOUSE / p), O.MIN, O.MAX);
    });
    return list;
  }

  // ===========================================================================
  // 3. Field selection
  // ===========================================================================

  // Owned runners first, then the healthiest (energy - fatigue/2, with a little seeded
  // jitter so the same runners do not always race). Skips energy < MIN_ENERGY_TO_RACE
  // unless that would leave fewer than MIN_RUNNERS.
  function selectField(state, count, rng) {
    const C = SD.CONFIG.RACE;
    const want = U.clamp(Math.round(Number(count) || C.MIN_RUNNERS), 1, C.MAX_RUNNERS);
    const active = (state.runners || []).filter(function (r) { return !r.retired; });
    const scored = active.map(function (r) {
      return {
        r: r,
        s: r.energy - r.fatigue * 0.5 + (rng ? rng.float() * 12 : 0),
        owned: r.owner ? 1 : 0,
        ok: r.energy >= C.MIN_ENERGY_TO_RACE
      };
    });
    const byPriority = function (a, b) { return (b.owned - a.owned) || (b.s - a.s); };
    const eligible = scored.filter(function (x) { return x.ok; }).sort(byPriority);
    const field = eligible.slice(0, want);
    if (field.length < Math.min(want, C.MIN_RUNNERS)) {
      const rest = scored.filter(function (x) { return !x.ok; }).sort(function (a, b) { return b.s - a.s; });
      while (field.length < Math.min(want, C.MIN_RUNNERS) && rest.length) field.push(rest.shift());
    }
    return field.map(function (x) { return x.r; });
  }

  // ===========================================================================
  // 4-7. simulate()
  // ===========================================================================

  function simulate(opts) {
    if (!opts || !Array.isArray(opts.entrants) || !opts.entrants.length) {
      throw new Error('SD.race.simulate: at least one entrant is required');
    }
    const CFG = SD.CONFIG;
    const C = CFG.RACE;
    const S = C.STAMINA;
    const E = C.EVENTS;
    const H = C.HYPE;
    const OV = C.OVERTAKE;
    const CH = C.CHAT;
    const D = SD.DATA;
    const TXT = D.RACE_TEXT;

    // ---------------------------------------------------------------- 4. setup
    const seed = Number(opts.seed) >>> 0;
    const rng = SD.rng.create(seed);
    const distance = Math.max(100, Math.round(Number(opts.distance) || 1200));
    const DT = C.DT;
    const BASE = C.BASE_SPEED;
    const maxTicks = Math.ceil(distance / (BASE * DT) * C.MAX_TICKS_MULT);
    const SEG = segmentTicks(distance);
    const RHO = U.clamp(Number(C.NOISE.RHO) || 0, 0, 0.99);
    const RHO_Q = Math.sqrt(1 - RHO * RHO); // keeps the stationary spread equal to sigma
    const dayEvent = SD.events.dayEventById(opts.dayEvent);
    const dm = SD.events.dayModifiers(dayEvent);
    const hype = Math.max(0, Number(opts.hypeLevel) || 0);
    const loud = hype >= H.LOUD;
    const feral = hype >= H.FERAL;
    const awakenOn = hype >= H.AWAKENED;
    const freq = Object.prototype.hasOwnProperty.call(E.SLIDER, opts.eventFrequency) ? opts.eventFrequency : 'normal';
    const eventP = E.BASE_P * E.SLIDER[freq] * (feral ? H.FERAL_EVENTS : 1) * dm.eventRate;
    const maxEvents = freq === 'chaos' ? E.MAX_CHAOS : E.MAX;
    const trackName = opts.trackName || D.TRACK_NAMES[seed % D.TRACK_NAMES.length];
    const FADE_AT = S.FADE_AT, FADE_MULT = S.FADE_MULT;

    const entrants = opts.entrants.map(function (e) { return U.deepClone(e); })
      .sort(function (a, b) { return a.lane - b.lane; });
    const n = entrants.length;
    const rosterAvgLevel = opts.rosterAvgLevel != null ? Number(opts.rosterAvgLevel)
      : entrants.reduce(function (a, e) { return a + (e.level || 1); }, 0) / n;

    const events = [];
    const ticks = [];
    const R = new Array(n);
    const byId = Object.create(null);

    // Event catalog per race phase (index), respecting day-event weights.
    const phaseEvents = [];
    for (let p = 0; p < RUN_PHASES; p++) phaseEvents.push(p === P_START ? [] : SD.events.raceEventsForPhase(PHASES[p]));

    function addEvent(tick, kind, runnerId, text, severity, data, hidden) {
      const ev = { tick: tick, kind: kind, runnerId: runnerId || null, text: text, severity: severity || 'info' };
      if (hidden) ev.hidden = true;
      if (data) ev.data = data;
      events.push(ev);
      return ev;
    }

    // Timed modifier active for ticks [start, start + ticks - 1].
    function addMod(r, vel, drain, start, ticksLen, fx, noFade) {
      r.mods.push({ vel: vel, drain: drain, until: start + ticksLen - 1, fx: fx || null, noFade: !!noFade });
    }

    // --- per-runner simulation state (rng consumed in lane order) ---
    for (let i = 0; i < n; i++) {
      const e = entrants[i];
      const st = e.stats;
      const style = CFG.STYLES[e.style] || CFG.STYLES.paceChaser;
      const mood = D.MOODS[e.mood] || {};
      const ab = e.abilityId ? (D.ABILITIES[e.abilityId] || null) : null;
      const level = e.level || 1;
      if (!e.perf) {
        e.perf = {};
        for (let p = 0; p < RUN_PHASES; p++) e.perf[PHASES[p]] = SD.runners.perfScore(e, PHASES[p], dm.statWeight);
      }
      const r = {
        i: i, e: e, id: e.runnerId, name: e.name, lane: e.lane, st: st, level: level,
        abilityId: ab ? e.abilityId : null, ab: ab,
        d: 0, v: 0, pool: e.stamMax, poolMax: Math.max(1, e.stamMax),
        phaseIdx: P_START, phaseTick: 0, rank: i + 1,
        core: new Array(RUN_PHASES),
        styleVel: style.vel, styleDrain: style.drain,
        moodVel: moodVelArray(e.mood),
        phaseVel: [1, 1, 1, 1, 1], phaseDrain: [1, 1, 1, 1, 1],
        persistVel: 1, persistDrain: 1,
        wildVel: 1, wildDrain: 1, formMul: 1, seg: 0, segOffset: 0,
        sigma: C.NOISE.SIGMA * (1 - st.wisdom / C.NOISE.WIS_DIV) * (mood.sigma || 1) * (style.sigma || 1) *
          (loud ? H.LOUD_SIGMA : 1) * dm.sigmaMult,
        statMult: raceStatMult(e),
        energyFrac: e.maxEnergy > 0 ? e.energy / e.maxEnergy : 1,
        moodDrain: mood.drain || 1,
        moodEventW: mood.eventW || 1,
        cheerMult: 1 + Math.min(C.CHAT.CHEER_CAP, e.cheerBonus || 0),
        pushAmt: st.power / 100 * OV.PUSH,
        critP: (C.CRIT.BASE + C.CRIT.PER_LUCK * st.luck) * (feral ? H.FERAL_CRIT : 1) * (mood.critMult || 1) *
          dm.critMult * (ab && ab.critMult ? ab.critMult : 1),
        critBoost: C.CRIT.BOOST, critTicks: C.CRIT.TICKS, critReadyAt: 1, crits: 0,
        mods: [], fx: null,
        fadeLevel: 0, wallHit: false, wallTick: null,
        lastNegTick: -1e9,
        finished: false, finishTick: null, finalV: 0, timedOut: false,
        abil: { used: false, procs: 0, readyAt: 0 },
        activations: [], majorEvents: [], chat: [], overtakes: 0,
        moodOverride: null, sabotaged: false, tieRoll: 0
      };
      for (let p = 0; p < RUN_PHASES; p++) r.core[p] = coreOf(e.perf[PHASES[p]] * r.statMult);

      // Static ability setup
      if (r.abilityId === 'acornHoard') {
        r.critBoost = scaled(ab, 'critBoost', level);
        r.critTicks = ab.critTicks;
      } else if (r.abilityId === 'moonlightPace') {
        r.phaseVel[P_MID] = 1 + scaled(ab, 'vel', level);
        r.phaseDrain[P_MID] = ab.drainMult;
      }

      // Wild Card hidden per-race roll
      if (e.style === 'wildCard') {
        const W = CFG.WILD;
        // Luck keeps the wheels on: every point above 40 shaves the collapse chance.
        const collapseP = U.clamp(W.COLLAPSE_P - (st.luck - 40) * (W.LUCK_TILT || 0), W.COLLAPSE_MIN, W.COLLAPSE_MAX);
        const x = rng.float();
        let kind, vel, drain = 1;
        if (x < collapseP) { kind = 'collapse'; vel = W.COLLAPSE_VEL; drain = W.COLLAPSE_DRAIN; }
        else if (x < collapseP + W.GREAT_P) { kind = 'great'; vel = W.GREAT_VEL; }
        else { kind = 'steady'; vel = 1 + rng.range(-W.STEADY_RANGE, W.STEADY_RANGE); }
        r.wildVel = vel;
        r.wildDrain = drain;
        e.wildRoll = { kind: kind, vel: Math.round(vel * 10000) / 10000, drain: drain };
        addEvent(0, 'event', r.id, '[debug] ' + r.name + ' wild roll: ' + kind + ' (x' + e.wildRoll.vel + ')', 'info',
          { debug: true, wildRoll: e.wildRoll }, true);
      } else {
        e.wildRoll = null;
      }
      // Per-race form and the first noise segment
      r.formMul = 1 + C.FORM.AMP * (1 - st.wisdom / C.FORM.WIS_DIV) * rng.tri();
      e.form = Math.round((r.formMul - 1) * 10000) / 10000;
      r.segOffset = rng.int(SEG);
      r.seg = r.sigma * rng.tri();

      R[i] = r;
      byId[r.id] = r;
    }

    // --- chat effects (boost / sabotage / cheer) pre-queued into seeded phases ---
    const chatIn = Array.isArray(opts.chatEffects) ? opts.chatEffects : [];
    const boostCount = Object.create(null), sabCount = Object.create(null);
    const cheers = Object.create(null); // runnerId -> { count, names[] }
    let sabTotal = 0;
    chatIn.forEach(function (ce) {
      const r = ce && byId[ce.runnerId];
      if (!r) return;
      if (ce.type === 'boost') {
        boostCount[r.id] = (boostCount[r.id] || 0) + 1;
        if (boostCount[r.id] > CH.MAX_BOOSTS_PER_RUNNER) return;
        r.chat.push({ type: 'boost', by: ce.by || 'chat', phaseIdx: P_EARLY + rng.int(4), delay: rng.int(CH.DELAY_MAX), fired: false });
      } else if (ce.type === 'sabotage') {
        sabCount[r.id] = (sabCount[r.id] || 0) + 1;
        if (sabCount[r.id] > CH.MAX_SABOTAGE_PER_TARGET || sabTotal >= CH.MAX_SABOTAGE_PER_RACE) return;
        sabTotal++;
        const pBack = Math.min(CH.BACKFIRE_MAX, CH.BACKFIRE_BASE + r.st.wisdom / CH.BACKFIRE_WIS_DIV);
        r.chat.push({
          type: 'sabotage', by: ce.by || 'someone', phaseIdx: P_EARLY + rng.int(4), delay: rng.int(CH.DELAY_MAX),
          backfire: rng.float() < pBack, fired: false
        });
      } else if (ce.type === 'cheer') {
        const c = cheers[r.id] || (cheers[r.id] = { count: 0, names: [] });
        c.count += Math.max(1, Math.round(Number(ce.count) || 1));
        const who = String(ce.by || 'chat');
        if (c.names.indexOf(who) < 0) c.names.push(who);
      }
    });
    // Cheers: the entrant's pre-race cheerBonus (buildEntrants) and cheer chat effects are the
    // same crowd, so the larger of the two counts (never both), capped at CHEER_CAP. A cheered
    // runner gets a 'chat' line at the gate and a short 'boost' glow; no randomness is used.
    for (let i = 0; i < n; i++) {
      const r = R[i];
      const c = cheers[r.id];
      const bonus = Math.min(CH.CHEER_CAP, Math.max(r.e.cheerBonus || 0, c ? c.count * CH.CHEER_PER : 0));
      r.cheerMult = 1 + bonus;
      if (!c || bonus <= 0) continue;
      const shown = c.names.slice(0, 2).join(' & ') + (c.names.length > 2 ? ' and ' + (c.names.length - 2) + ' more' : '');
      const bonus4 = Math.round(bonus * 10000) / 10000;
      addEvent(1, 'chat', r.id, shown + (c.names.length === 1 ? ' cheers ' : ' cheer ') + r.name + ' on! The crowd lifts them (+' +
        (Math.round(bonus * 10000) / 100) + '%).', 'good', { type: 'cheer', by: c.names[0], names: c.names.slice(), count: c.count, bonus: bonus4 });
      addMod(r, 1, 1, 1, CH.CHEER_GLOW_TICKS || 6, 'boost');
    }

    // ------------------------------------------- 5. per-runner mechanics
    let critsTotal = 0;
    let eventCount = 0;
    let lastEventTick = -1e9;
    let fogUntil = -1;
    let awakened = false;
    let racePhase = P_START;
    let lastLeadLog = -1e9, lastPassLog = -1e9;
    const pairLog = Object.create(null); // "idA|idB" -> tick last announced

    function activate(r, t, text, severity) {
      r.activations.push({ tick: t, id: r.abilityId, text: text });
      addEvent(t, 'ability', r.id, text, severity || 'good', { abilityId: r.abilityId });
    }

    function doCrit(r, t) {
      addMod(r, 1 + r.critBoost, 1, t, r.critTicks, 'crit');
      r.critReadyAt = t + C.CRIT.COOLDOWN;
      r.crits++;
      critsTotal++;
      addEvent(t, 'crit', r.id, fill(TXT.crit[(t + r.i) % TXT.crit.length], r.name), 'good');
    }

    function fadeLevelOf(r) {
      const frac = r.pool / r.poolMax;
      return frac > FADE_AT[0] ? 0 : (frac > FADE_AT[1] ? 1 : (frac > FADE_AT[2] ? 2 : 3));
    }

    function updateFade(r, t) {
      const lvl = fadeLevelOf(r);
      if (lvl === 3 && !r.wallHit) {
        r.wallHit = true;
        r.wallTick = t;
        addEvent(t, 'wall', r.id, fill(TXT.wall[(t + r.i) % TXT.wall.length], r.name), 'bad');
      }
      r.fadeLevel = lvl;
    }

    function runnerAtRank(rank) {
      for (let i = 0; i < n; i++) if (R[i].rank === rank) return R[i];
      return null;
    }

    // Nearest unfinished runner strictly ahead.
    function runnerDirectlyAhead(r) {
      let best = null, bestGap = Infinity;
      for (let j = 0; j < n; j++) {
        const o = R[j];
        if (o === r || o.finished) continue;
        const g = o.d - r.d;
        if (g > 0 && g < bestGap) { bestGap = g; best = o; }
      }
      return best;
    }

    // Ability hooks that fire when a runner enters a new phase.
    function onPhaseEntry(r, p, t) {
      const ab = r.ab;
      if (!ab) return;
      const L = r.level;
      switch (r.abilityId) {
        case 'forestsFavor':
          if (p === P_STRETCH) {
            const chance = U.clamp(ab.chanceBase + ab.chancePerLuck * r.st.luck, ab.chanceMin, ab.chanceMax);
            const roll = rng.float();
            const guaranteed = r.rank >= ab.guaranteedRanks[0] && r.rank <= ab.guaranteedRanks[1];
            if (guaranteed || roll < chance) {
              const b = scaled(ab, 'burst', L);
              addMod(r, 1 + b, 1, t, ab.ticks, 'ability');
              activate(r, t, "FOREST'S FAVOR! The old trees push " + r.name + ' forward (+' + pct(b) + ')!', 'epic');
            }
          }
          break;
        case 'moonlightPace':
          if (p === P_MID) {
            addMod(r, 1, 1, t, 4, 'ability');
            activate(r, t, 'MOONLIGHT PACE: ' + r.name + ' settles into a silver rhythm.', 'good');
          }
          break;
        case 'cometTail':
          if (p === P_STRETCH && r.rank >= 2) {
            const b = r.rank <= 5 ? scaled(ab, 'burst', L) : ab.burstBack;
            addMod(r, 1 + b, 1, t, ab.ticks, 'ability');
            activate(r, t, 'COMET TAIL! ' + r.name + ' streaks out of the pack (+' + pct(b) + ')!', 'epic');
          }
          break;
        case 'readingTheWind':
          if (p === P_TURN) {
            const chance = Math.min(0.95, ab.chanceBase + ab.chancePerWis * r.st.wisdom);
            if (rng.float() < chance) {
              r.phaseVel[P_TURN] *= 1 + scaled(ab, 'vel', L);
              r.phaseDrain[P_TURN] *= ab.drainMult;
              r.phaseDrain[P_STRETCH] *= ab.drainMult;
              addMod(r, 1, 1, t, 4, 'ability');
              activate(r, t, 'READING THE WIND: ' + r.name + ' finds the perfect line through the turn.', 'good');
            }
          }
          break;
        case 'acornHoard':
          if (p === P_STRETCH && r.crits === 0) {
            doCrit(r, t);
            activate(r, t, 'ACORN HOARD! ' + r.name + ' cracks open the lucky acorn stash!', 'epic');
          }
          break;
        case 'longNight':
          if (p === P_STRETCH) {
            const b = (r.pool / r.poolMax) * scaled(ab, 'perStam', L);
            if (b > 0.005) {
              r.persistVel *= 1 + b;
              addMod(r, 1, 1, t, 6, 'ability');
              activate(r, t, 'LONG NIGHT! ' + r.name + "'s lantern blazes down the stretch (+" + pct(b) + ')!', b >= 0.1 ? 'epic' : 'good');
            }
          }
          break;
        case 'afterglow':
          if (p === P_STRETCH) {
            const ahead = r.rank - 1;
            const b = Math.min(scaled(ab, 'max', L), ahead * scaled(ab, 'perAhead', L));
            if (b > 0) {
              r.persistVel *= 1 + b;
              addMod(r, 1, 1, t, 6, 'ability');
              activate(r, t, 'AFTERGLOW! ' + r.name + ' glows brighter with ' + ahead + ' runner' + (ahead === 1 ? '' : 's') +
                ' ahead (+' + pct(b) + ')!', b >= 0.08 ? 'epic' : 'good');
            }
          }
          break;
        default:
          break;
      }
    }

    // Once per race when the pool drops below the threshold.
    function secondWind(r, t) {
      const ab = r.ab;
      r.abil.used = true;
      r.pool = Math.min(r.poolMax, r.pool + scaled(ab, 'restore', r.level) * r.poolMax);
      addMod(r, 1, 1, t + 1, ab.noFadeTicks, 'ability', true);
      activate(r, t, 'SECOND WIND! ' + r.name + ' refuses to fade!', 'epic');
    }

    function onOvertake(a, b, t, state) {
      a.overtakes++;
      if (a.abilityId === 'thunderStep' && !a.finished) {
        const ab = a.ab;
        if ((a.phaseIdx === P_MID || a.phaseIdx === P_TURN) && a.abil.procs < ab.maxProcs && t >= a.abil.readyAt) {
          a.abil.procs++;
          a.abil.readyAt = t + ab.cooldown;
          const burst = scaled(ab, 'burst', a.level);
          addMod(a, 1 + burst, 1, t + 1, ab.ticks, 'ability');
          activate(a, t, 'THUNDER STEP! ' + a.name + ' thunders past ' + b.name + '!', 'good');
        }
      }
      // Commentary: only top-3 passes, throttled so it never spams (global gaps plus a
      // per-pair gap so two runners swapping back and forth are not re-announced).
      if (state.logged || a.finished || racePhase < P_EARLY || a.rank > 3) return;
      const pairKey = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
      if (pairLog[pairKey] != null && t - pairLog[pairKey] < OV.PAIR_GAP) return;
      if (a.rank === 1) {
        if (t - lastLeadLog >= OV.LOG_GAP_LEAD) {
          addEvent(t, 'overtake', a.id, fill(TXT.lead, a.name, b.name), 'good', { passed: b.id, place: 1 });
          lastLeadLog = t;
          pairLog[pairKey] = t;
          state.logged = true;
        }
      } else if (t - lastPassLog >= OV.LOG_GAP) {
        addEvent(t, 'overtake', a.id, fill(TXT.pass, a.name, b.name).replace('{place}', U.ordinal(a.rank)), 'info',
          { passed: b.id, place: a.rank });
        lastPassLog = t;
        pairLog[pairKey] = t;
        state.logged = true;
      }
    }

    // --- random events ---
    function negOk(r, t) { return t - r.lastNegTick >= E.NEG_COOLDOWN; }
    function negWeight(r) {
      return 1 / (1 + r.st.wisdom / E.NEG_WIS_DIV) * r.moodEventW * (r.energyFrac < 0.5 ? E.LOW_ENERGY_NEG : 1) *
        (r.ab && r.ab.negEventWeight ? r.ab.negEventWeight : 1);
    }
    function posWeightFor(ev) {
      const stat = ev.weightStat || 'luck';
      return function (r) {
        return (1 + (r.st[stat] || 0) / E.POS_LUCK_DIV) * (r.ab && r.ab.posEventWeight ? r.ab.posEventWeight : 1);
      };
    }

    function applyEffect(r, eff, ev, t) {
      if (eff.vel != null || eff.drain != null) {
        let vel = eff.vel != null ? eff.vel : 1;
        if (eff.wisdomResist && vel < 1) vel = 1 - (1 - vel) * Math.max(0.2, 1 - r.st.wisdom / E.WIS_RESIST_DIV);
        addMod(r, vel, eff.drain != null ? eff.drain : 1, t, eff.ticks || 1, 'event:' + ev.id);
      }
      if (eff.stamina) r.pool = U.clamp(r.pool + eff.stamina * r.poolMax, 0, r.poolMax);
      if (eff.mood) r.moodOverride = eff.mood;
      if (r.majorEvents.indexOf(ev.id) < 0) r.majorEvents.push(ev.id);
    }

    function applyAll(ev, alive, t) {
      const eff = ev.effect || {};
      if (eff.fog) fogUntil = t + eff.fog - 1;
      for (let k = 0; k < alive.length; k++) applyEffect(alive[k], eff, ev, t);
      addEvent(t, 'event', null, ev.message, ev.severity, {
        eventId: ev.id, targets: alive.map(function (r) { return r.id; }), durationTicks: eff.fog || eff.ticks || 0
      });
      return true;
    }

    function applySingle(ev, target, t, polarity) {
      let eff = ev.effect || {};
      let text = ev.message;
      let sev = ev.severity;
      if (polarity === 'mixed') {
        const roll = eff.roll;
        const pGood = U.clamp(roll.base + roll.per * (target.st[roll.stat] || 0), 0.05, 0.95);
        if (rng.float() < pGood) { eff = ev.effect.good; sev = 'good'; polarity = 'pos'; }
        else { eff = ev.effect.bad; text = ev.messageBad || text; sev = 'bad'; polarity = 'neg'; }
      }
      let final = target;
      let hopText = null;
      // Bramble Jack's Hedge Hop: shrug off a bad event, bounce it to the runner ahead.
      if (polarity === 'neg' && target.abilityId === 'hedgeHop') {
        const hop = target.ab;
        const p = Math.min(hop.chanceMax, hop.chanceBase + hop.chancePerLuck * target.st.luck + hop.chancePerLevel * (target.level - 1));
        if (rng.float() < p) {
          const ahead = runnerDirectlyAhead(target);
          if (ahead && negOk(ahead, t)) {
            final = ahead;
            hopText = 'HEDGE HOP! ' + target.name + ' bounces the ' + ev.name + ' straight onto ' + ahead.name + '!';
          } else {
            final = null;
            hopText = 'HEDGE HOP! ' + target.name + ' shrugs it off like nothing happened.';
          }
        }
      }
      addEvent(t, 'event', target.id, fill(text, target.name), sev, {
        eventId: ev.id,
        targets: final ? [final.id] : [],
        outcome: polarity,
        redirectedTo: final && final !== target ? final.id : undefined,
        dodged: final ? undefined : true
      });
      if (hopText) {
        activate(target, t, hopText, 'epic');
        // The hop itself springs Bramble Jack forward (optional ability magnitude).
        const hopAb = target.ab;
        if (hopAb.bounceBoost) addMod(target, 1 + scaled(hopAb, 'bounceBoost', target.level), 1, t, hopAb.bounceTicks || 5, 'ability');
      }
      if (final) {
        applyEffect(final, eff, ev, t);
        if (polarity === 'neg') final.lastNegTick = t;
      }
      return true;
    }

    function fireRandomEvent(t) {
      const pool = phaseEvents[racePhase];
      if (!pool || !pool.length) return false;
      const ev = rng.weighted(pool, function (x) { return x.weight * (dm.eventWeights[x.id] != null ? dm.eventWeights[x.id] : 1); });
      if (!ev) return false;
      const alive = R.filter(function (r) { return !r.finished; });
      if (!alive.length) return false;
      let target = null;
      switch (ev.target) {
        case 'ALL':
          return applyAll(ev, alive, t);
        case 'ONE_POS':
          target = rng.weighted(alive, posWeightFor(ev));
          return target ? applySingle(ev, target, t, 'pos') : false;
        case 'ONE_NEG': {
          const cand = alive.filter(function (r) { return negOk(r, t); });
          target = rng.weighted(cand, negWeight);
          return target ? applySingle(ev, target, t, 'neg') : false;
        }
        case 'ONE': {
          const cand = alive.filter(function (r) { return negOk(r, t); });
          target = rng.pick(cand);
          return target ? applySingle(ev, target, t, ev.polarity === 'mixed' ? 'mixed' : ev.polarity) : false;
        }
        case 'LEADER':
        case 'LAST': {
          target = alive[0];
          for (let k = 1; k < alive.length; k++) {
            if (ev.target === 'LEADER' ? alive[k].rank < target.rank : alive[k].rank > target.rank) target = alive[k];
          }
          if (ev.polarity === 'neg' && !negOk(target, t)) return false;
          return applySingle(ev, target, t, ev.polarity);
        }
        default:
          return false;
      }
    }

    // --- chat effects fire when the runner reaches its seeded phase ---
    function fireChat(r, t) {
      for (let k = 0; k < r.chat.length; k++) {
        const c = r.chat[k];
        if (c.fired) continue;
        if (r.phaseIdx > c.phaseIdx || (r.phaseIdx === c.phaseIdx && t - r.phaseTick >= c.delay)) {
          c.fired = true;
          if (c.type === 'boost') {
            addMod(r, 1 + CH.BOOST, 1, t, CH.BOOST_TICKS, 'boost');
            addEvent(t, 'chat', r.id, c.by + "'s BOOST kicks in! " + r.name + ' surges forward!', 'good', { type: 'boost', by: c.by });
          } else if (c.backfire) {
            addMod(r, CH.BACKFIRE_BONUS, 1, t, CH.SABOTAGE_TICKS, 'boost');
            addEvent(t, 'chat', r.id, c.by + "'s sabotage BACKFIRES! " + r.name + ' kicks the pebble away and speeds up!', 'good',
              { type: 'sabotage', by: c.by, backfire: true });
          } else if (!negOk(r, t)) {
            c.fired = false; // a sabotage waits until the target is clear of its last bad luck
          } else {
            addMod(r, CH.SABOTAGE, 1, t, CH.SABOTAGE_TICKS, 'sabotage');
            r.sabotaged = true;
            r.lastNegTick = t;
            addEvent(t, 'chat', r.id, 'Pebble in the Shoe! ' + c.by + "'s sabotage slows " + r.name + '!', 'bad',
              { type: 'sabotage', by: c.by, backfire: false });
          }
        }
      }
    }

    function awaken(t) {
      awakened = true;
      let last = null;
      for (let i = 0; i < n; i++) {
        const r = R[i];
        if (r.finished) continue;
        r.pool = Math.min(r.poolMax, r.pool + H.AWAKEN_POOL * r.poolMax);
        r.persistVel *= H.AWAKEN_VEL;
        r.fadeLevel = fadeLevelOf(r);
        addMod(r, 1, 1, t + 1, 6, 'awakened');
        if (!last || r.rank > last.rank) last = r;
      }
      addEvent(t, 'awakened', null, TXT.awakened, 'epic', { phase: 'FINAL_TURN' });
      if (last) {
        addMod(last, H.AWAKEN_LAST, 1, t + 1, H.AWAKEN_LAST_TICKS, 'awakened');
        addEvent(t, 'awakened', last.id, fill(TXT.awakenedLast, last.name), 'epic');
      }
    }

    function announcePhase(p, t) {
      const leader = runnerAtRank(1);
      const second = runnerAtRank(2);
      let text;
      if (p === P_STRETCH && second && leader.d - second.d >= 8) {
        text = fill(TXT.phase.FINAL_STRETCH_CLEAR, leader.name).replace('{gap}', String(Math.round(leader.d - second.d)));
      } else {
        text = fill(TXT.phase[PHASES[p]], leader.name, second ? second.name : null);
      }
      addEvent(t, 'phase', leader.id, text, PHASE_SEVERITY[p], { phase: PHASES[p] });
    }

    function addFx(fx, tag) {
      if (!fx) return [tag];
      if (fx.indexOf(tag) < 0) fx.push(tag);
      return fx;
    }

    function makeTick(t, phaseIdx) {
      const pos = new Array(n);
      for (let i = 0; i < n; i++) {
        const r = R[i];
        pos[i] = {
          id: r.id,
          d: Math.round(r.d * 100) / 100,
          v: Math.round(r.v * 10) / 10,          // m/s, 0.1 precision (keeps saves small)
          st: Math.round(r.pool / r.poolMax * 100) / 100, // stamina fraction, 0.01 precision
          rank: r.rank,
          fx: r.fx || EMPTY_FX
        };
      }
      return { t: t, phase: PHASES[phaseIdx], pos: pos };
    }

    // One tick of movement for one runner.
    function stepRunner(r, t, fogActive, gap) {
      const p = phaseIndexOf(r.d / distance);
      if (p !== r.phaseIdx) {
        r.phaseIdx = p;
        r.phaseTick = t;
        onPhaseEntry(r, p, t);
      }
      if (r.chat.length) fireChat(r, t);
      // Luck crit
      if (t >= r.critReadyAt && rng.float() < r.critP) doCrit(r, t);
      // Segment noise, re-rolled every SEG ticks (offset per runner)
      // AR(1): each new segment keeps RHO of the old swing, so good and bad spells last a while.
      if ((t + r.segOffset) % SEG === 0) r.seg = RHO * r.seg + RHO_Q * r.sigma * rng.tri();

      // Timed modifiers (events, abilities, crits, chat)
      let modVel = 1, modDrain = 1, noFade = false, fx = null;
      const mods = r.mods;
      for (let k = mods.length - 1; k >= 0; k--) {
        const m = mods[k];
        if (m.until < t) { mods.splice(k, 1); continue; }
        modVel *= m.vel;
        modDrain *= m.drain;
        if (m.noFade) noFade = true;
        if (m.fx) fx = addFx(fx, m.fx);
      }
      if (fogActive) fx = addFx(fx, 'fog');

      // Stamina fade
      let fade = 1;
      if (!noFade) {
        fade = FADE_MULT[r.fadeLevel];
        if (r.fadeLevel >= 2) fx = addFx(fx, r.fadeLevel === 3 ? 'wall' : 'fade');
      }

      // Overtaking push (within RANGE behind someone) and drafting
      const push = gap <= OV.RANGE ? r.pushAmt : 0;
      const draft = gap >= S.DRAFT_MIN && gap <= S.DRAFT_MAX ? S.DRAFT_MULT : 1;

      const noise = 1 + r.seg * (fogActive ? E.FOG_SIGMA : 1);
      const mult = r.core[p] * r.styleVel[p] * r.wildVel * r.formMul * noise * fade *
        r.moodVel[p] * r.phaseVel[p] * r.persistVel * r.cheerMult * modVel * (1 + push);
      let v = BASE * mult;
      if (v < 1) v = 1;
      const dd = v * DT;

      // Drain ~ metres * (v/BASE)^2.5 (computed as x*x*sqrt(x): no Math.pow in the loop)
      const rr = v / BASE;
      const drain = dd * rr * rr * Math.sqrt(rr) * S.DRAIN_SCALE * r.styleDrain[p] * r.wildDrain * r.moodDrain *
        r.phaseDrain[p] * r.persistDrain * modDrain * draft;
      r.pool -= drain;
      if (r.pool < 0) r.pool = 0;
      if (r.abilityId === 'secondWind' && !r.abil.used && r.pool < r.ab.threshold * r.poolMax) secondWind(r, t);
      updateFade(r, t);

      // Move; sub-tick interpolated finish
      const nd = r.d + dd;
      if (nd >= distance) {
        r.finishTick = (t - 1) + (distance - r.d) / dd;
        r.d = distance;
        r.finished = true;
        r.finalV = v;
      } else {
        r.d = nd;
      }
      r.v = v;
      r.fx = fx;
    }

    // ------------------------------------------------------- 6. tick loop
    ticks.push(makeTick(0, P_START));
    addEvent(0, 'phase', null, TXT.start[seed % TXT.start.length].replace('{track}', trackName), 'epic', { phase: 'START' });

    const prevD = new Float64Array(n);
    const prevFinished = new Uint8Array(n);
    const gapAhead = new Float64Array(n);
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    const rankCmp = function (x, y) {
      const a = R[x], b = R[y];
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return (a.finishTick - b.finishTick) || (a.lane - b.lane);
      return (b.d - a.d) || (a.lane - b.lane);
    };
    const logState = { logged: false };

    let finishedCount = 0;
    let t = 0;
    while (finishedCount < n && t < maxTicks) {
      t++;

      // (a) random event roll, based on the leader's phase
      if (eventP > 0 && racePhase >= P_EARLY && racePhase <= P_STRETCH && eventCount < maxEvents &&
          t - lastEventTick >= E.MIN_GAP) {
        if (rng.float() < eventP && fireRandomEvent(t)) {
          lastEventTick = t;
          eventCount++;
        }
      }
      const fogActive = t <= fogUntil;

      // (b) snapshot positions and gap to the nearest runner ahead
      for (let i = 0; i < n; i++) { prevD[i] = R[i].d; prevFinished[i] = R[i].finished ? 1 : 0; }
      for (let i = 0; i < n; i++) {
        if (prevFinished[i]) { gapAhead[i] = Infinity; continue; }
        let best = Infinity;
        const di = prevD[i];
        for (let j = 0; j < n; j++) {
          if (j === i || prevFinished[j]) continue;
          const g = prevD[j] - di;
          if (g > 0 && g < best) best = g;
        }
        gapAhead[i] = best;
      }

      // (c) move everyone (lane order)
      for (let i = 0; i < n; i++) {
        const r = R[i];
        if (prevFinished[i]) { r.v = 0; r.fx = null; continue; }
        stepRunner(r, t, fogActive, gapAhead[i]);
        if (r.finished) finishedCount++;
      }

      // (d) ranks (finished by finish time, others by distance; ties by lane)
      order.sort(rankCmp);
      for (let k = 0; k < n; k++) R[order[k]].rank = k + 1;

      // (e) overtakes: was behind at the start of the tick, level or ahead now
      logState.logged = false;
      for (let i = 0; i < n; i++) {
        if (prevFinished[i]) continue;
        const a = R[i];
        for (let j = 0; j < n; j++) {
          if (j === i || prevFinished[j]) continue;
          const b = R[j];
          if (prevD[i] < prevD[j] && a.d >= b.d && !(a.finished && b.finished)) onOvertake(a, b, t, logState);
        }
      }

      // (f) race phase = leader's phase; announce each new phase once
      const leader = R[order[0]];
      const lp = leader.finished ? P_FINISH : phaseIndexOf(leader.d / distance);
      while (racePhase < lp && racePhase < P_STRETCH) {
        racePhase++;
        announcePhase(racePhase, t);
        if (racePhase === P_TURN && awakenOn && !awakened) awaken(t);
      }
      if (lp === P_FINISH) racePhase = P_FINISH;

      // (g) record the tick
      ticks.push(makeTick(t, racePhase));
    }
    const totalTicks = t;

    // Safety net: anyone still running at MAX_TICKS gets an extrapolated finish.
    let timedOut = false;
    for (let i = 0; i < n; i++) {
      const r = R[i];
      if (!r.finished) {
        timedOut = true;
        const vEst = Math.max(1, r.v);
        r.finishTick = totalTicks + (distance - r.d) / (vEst * DT);
        r.finalV = vEst;
        r.finished = true;
        r.timedOut = true;
      }
    }

    // Chat effects that never fired (runner finished first, or a sabotage was still waiting
    // out the negative cooldown) are reported so every queued effect appears in the record.
    for (let i = 0; i < n; i++) {
      const r = R[i];
      for (let k = 0; k < r.chat.length; k++) {
        const c = r.chat[k];
        if (c.fired) continue;
        c.fired = true;
        addEvent(Math.min(totalTicks, Math.max(1, Math.ceil(r.finishTick))), 'chat', r.id,
          c.by + "'s " + (c.type === 'boost' ? 'boost' : 'sabotage') + ' never caught up with ' + r.name + '.', 'info',
          { type: c.type, by: c.by, fizzled: true });
      }
    }

    // ------------------------------------ 7. finish order, results, summary
    for (let i = 0; i < n; i++) R[i].tieRoll = rng.float();
    const finishOrder = R.slice().sort(function (a, b) {
      const dt = a.finishTick - b.finishTick;
      if (Math.abs(dt) > 1e-9) return dt;
      return (b.st.luck - a.st.luck) || (a.tieRoll - b.tieRoll);
    });

    const RS = CFG.RESULTS;
    const distMult = lookupByDistance(RS.DIST_MULT, distance);
    const spMult = (awakened ? H.AWAKEN_SP : 1) * dm.spMult;
    const winner = finishOrder[0];
    const gapMetres = function (behind, ahead) { return Math.max(0, (behind.finishTick - ahead.finishTick) * behind.finalV * DT); };
    const winMargin = finishOrder.length > 1 ? gapMetres(finishOrder[1], winner) : 0;
    const photoFinish = n > 1 && winMargin < C.PHOTO_FINISH_M;
    const upset = n > 1 && winner.e.odds >= C.UPSET_ODDS;

    function rollStatChanges(style, place) {
      const growth = RS.STAT_GROWTH[style] || RS.STAT_GROWTH.paceChaser;
      const stats = CFG.STATS;
      const changes = {};
      const first = rng.weighted(stats, function (k) { return growth[k]; });
      changes[first] = 1;
      if (rng.float() < (place === 1 ? RS.SECOND_STAT_P_WIN : RS.SECOND_STAT_P)) {
        const second = rng.weighted(stats.filter(function (k) { return k !== first; }), function (k) { return growth[k]; });
        if (second) changes[second] = 1;
      }
      return changes;
    }
    function moodForPlace(place) {
      if (place <= 3) return 'Happy';
      if (place >= 7) return 'Nervous';
      return 'Determined';
    }

    const results = finishOrder.map(function (r, k) {
      const place = k + 1;
      const e = r.e;
      const margin = k === 0 ? winMargin : gapMetres(r, finishOrder[k - 1]);
      const xp = Math.round((at(RS.PLACE_XP, k) + RS.XP_BONUS) * distMult *
        ((e.level || 1) < rosterAvgLevel ? RS.UNDERDOG_XP : 1) * dm.xpMult);
      const baseSp = at(RS.OWNER_SP, k) * spMult;
      let moodAfter = moodForPlace(place);
      if (r.sabotaged && place > 3) moodAfter = 'Nervous';
      if (r.moodOverride && place > 1) moodAfter = r.moodOverride;
      return {
        runnerId: r.id,
        name: r.name,
        place: place,
        finishTick: round3(r.finishTick),
        timeSec: U.round2(r.finishTick * DT),
        margin: U.round2(margin),
        wallHit: r.wallHit,
        xp: xp,
        spOwner: e.ownerAtRace ? Math.round(baseSp) : 0,
        spBacker: Math.floor(baseSp * RS.BACKER_SHARE),
        statChanges: rollStatChanges(e.style, place),
        energyDelta: -RS.ENERGY_COST,
        fatigueDelta: RS.FATIGUE + (distance >= RS.LONG_DISTANCE ? RS.FATIGUE_LONG_EXTRA : 0),
        moodAfter: moodAfter,
        abilityActivations: r.activations,
        majorEvents: r.majorEvents,
        levelUps: 0,
        crits: r.crits,
        overtakes: r.overtakes,
        odds: e.odds,
        ownerAtRace: e.ownerAtRace || null,
        timedOut: r.timedOut || undefined
      };
    });

    // Finish commentary
    results.forEach(function (res) {
      const tick = Math.min(totalTicks, Math.max(1, Math.ceil(res.finishTick)));
      let text, sev;
      if (res.place === 1) {
        text = res.name + ' WINS at ' + trackName + ' in ' + res.timeSec.toFixed(1) + 's!' +
          (photoFinish ? ' PHOTO FINISH!' : '') + (upset ? ' A ' + res.odds + 'x UPSET!' : '');
        sev = 'epic';
      } else if (res.place <= 3) {
        text = res.name + ' takes ' + U.ordinal(res.place) +
          (res.place === 2 && photoFinish ? ', beaten by a whisker (' + res.margin.toFixed(2) + ' m)!' : '.');
        sev = 'good';
      } else {
        text = res.name + ' finishes ' + U.ordinal(res.place) + '.';
        sev = 'info';
      }
      addEvent(tick, 'finish', res.runnerId, text, sev, { place: res.place, timeSec: res.timeSec, margin: res.margin });
    });

    // Stable sort of events by tick
    const sortedEvents = events.map(function (ev, i) { return { ev: ev, i: i }; })
      .sort(function (a, b) { return (a.ev.tick - b.ev.tick) || (a.i - b.i); })
      .map(function (x) { return x.ev; });

    const record = {
      id: opts.id || ('race-' + seed.toString(16)),
      season: opts.season != null ? opts.season : null,
      day: opts.day != null ? opts.day : null,
      indexInDay: opts.indexInDay != null ? opts.indexInDay : null,
      seed: seed,
      engineVersion: ENGINE_VERSION,
      distance: distance,
      trackName: trackName,
      settingsSnapshot: { eventFrequency: freq, hypeLevel: hype, dayEventId: dayEvent ? dayEvent.id : null },
      inputs: {
        chatEffects: U.deepClone(chatIn),
        raceEffects: opts.raceEffects ? U.deepClone(opts.raceEffects) : undefined,
        rosterAvgLevel: rosterAvgLevel
      },
      entrants: entrants,
      ticks: ticks,
      events: sortedEvents,
      results: results,
      bets: [],
      hypeBefore: hype,
      hypeAfter: null,
      totalTicks: totalTicks,
      summary: {
        winnerId: winner.id,
        winnerName: winner.name,
        winnerEmoji: winner.e.emoji,
        photoFinish: photoFinish,
        forestAwakened: awakened,
        eventsCount: eventCount,
        critsCount: critsTotal,
        upset: upset,
        upsetOdds: upset ? winner.e.odds : null,
        margin: U.round2(winMargin),
        wallHits: R.filter(function (r) { return r.wallHit; }).length,
        timedOut: timedOut
      },
      hash: ''
    };
    record.hash = hashRecord(record);
    return record;
  }
  // Hex FNV-1a over results + total ticks + event digest. Robust to tick stripping.
  function hashRecord(record) {
    const res = JSON.stringify(record.results || []);
    const ev = (record.events || []).map(function (e) { return e.tick + e.kind + (e.runnerId || ''); }).join(',');
    const h = SD.rng.hash(res + '|' + record.totalTicks + '|' + ev);
    return ('00000000' + h.toString(16)).slice(-8);
  }

  SD.race = {
    ENGINE_VERSION: ENGINE_VERSION,
    PHASES: PHASES,
    phaseOf: phaseOf,
    phaseIndexOf: phaseIndexOf,
    distFactor: distFactor,
    lookupByDistance: lookupByDistance,
    interpByDistance: interpByDistance,
    stylePts: stylePts,
    energyMult: energyMult,
    raceStatMult: raceStatMult,
    oddsTemp: oddsTemp,
    segmentTicks: segmentTicks,
    coreOf: coreOf,
    buildEntrants: buildEntrants,
    ratingOf: ratingOf,
    oddsFeatures: oddsFeatures,
    assignOdds: assignOdds,
    selectField: selectField,
    simulate: simulate,
    hashRecord: hashRecord
  };
})(globalThis.SD = globalThis.SD || {});
