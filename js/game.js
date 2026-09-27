/*
 * Spirit Derby - game.js
 * The director. Every public method changes state through SD.state.mutate (commit). The events a
 * method queues through commit()'s emit (race:started / finished / aborted, runner:*, season:*,
 * event:day ...) go out AFTER the mutation completes, in order, so their listeners see the finished
 * state. Review batch 7 (director-state#10): the hook modules called INSIDE the mutation emit their
 * own events at once, while it is still running - bet:resolved (betting), hype:changed /
 * hype:threshold (hype), player:sp (players), log:entry (SD.state.log), achievement:unlocked from a
 * nested check. Those listeners may see a half-applied state (e.g. currentRace still set during
 * finishRace / abortRace) and arrive before the director's own events (an abort's "bets refunded"
 * chat line comes before "the race was cancelled"). Listeners that need the final state read it on
 * state:changed or on the director's event. This is the documented contract; deferring the hook
 * events would reorder what achievements rely on (bet:resolved is checked during the same finish).
 * UI buttons, the command pipeline and integrations all call these methods.
 *
 * Optional later-milestone modules are called only when present:
 *   SD.betting.lockForRace(state, record) -> { locked, repriced, refunded } (startRace: bets settled at
 *                                         min(quoted, gate odds); non-starters / odds-on refunded)
 *   SD.betting.resolveRace(state, record) -> resolvedBets[]
 *   SD.betting.refundAll(state, reason)   -> refunded[] | count
 *   SD.players.applyRaceResults(state, record) -> payouts[]
 *   SD.players.award(state, username, amount, reason) -> number awarded
 *   SD.achievements.checkRace(state, record) -> unlocked[]
 */
(function (SD) {
  'use strict';

  const U = SD.util;
  let unsubs = [];

  function fail(message, extra) { return Object.assign({ ok: false, message: message }, extra || {}); }
  function cur() { return SD.state.get(); }

  // Run fn(state, emit) inside one mutate; queued bus events fire afterwards in order.
  function commit(label, fn) {
    const queue = [];
    const emit = function (name, payload) { queue.push([name, payload]); };
    const result = SD.state.mutate(label, function (s) { return fn(s, emit); });
    for (let i = 0; i < queue.length; i++) SD.bus.emit(queue[i][0], queue[i][1]);
    return result;
  }

  // Per-action randomness (seedSalt + action counter): no Math.random. Review batch 5: when an
  // SD.entropy source is installed (the browser), a fresh value is added to the seed, so training
  // crits / fails, !create rolls and day events can be neither predicted from the counter nor
  // replayed by a rolled-back save. Without one (Node / tests) it is deterministic as before.
  // Call it only once the action is certain to happen (refusals must not advance the counter).
  function actionRng(s, tag) {
    s.meta.actionCounter = (s.meta.actionCounter || 0) + 1;
    const seed = SD.rng.seedFrom(s.meta.seedSalt, tag, s.meta.actionCounter);
    const e = SD.entropy ? SD.entropy.next() : null;
    return SD.rng.create(e == null ? seed : (seed + e) >>> 0);
  }

  // Accepts a runner id ('r03') or a name query ('moss').
  function resolveRunner(idOrName) {
    if (idOrName == null) return null;
    if (typeof idOrName === 'object' && idOrName.id) idOrName = idOrName.id;
    const r = SD.state.runnerById(idOrName);
    if (r) return r;
    const f = SD.state.findRunner(idOrName);
    return f.runner || null;
  }

  function saveNow() { if (SD.persistence) SD.persistence.save(true); }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  // Boot (main.js), TAKE OVER and the tests: subscribe to race:playbackDone, then afterLoad(opts).
  // opts.deferPending: leave a race saved as 'finished' for a later applyPending() call (main.js
  // applies it once achievements, the panels and the results modal listen). -> { ok, pending }
  function init(opts) {
    unsubs.forEach(function (u) { u(); });
    unsubs = [];
    if (!cur()) SD.state.set(SD.state.create());
    unsubs.push(SD.bus.on(SD.EVENTS.RACE_PLAYBACK_DONE, function (p) {
      const cr = cur() && cur().currentRace;
      if (!cr) return;
      if (p && p.recordId && cr.record && p.recordId !== cr.record.id) return;
      finishRace();
    }));
    const res = afterLoad(opts);
    return { ok: true, pending: res.pending };
  }

  // Review batch 7: THE post-load routine, shared by boot / TAKE OVER (init), IMPORT JSON / RESTORE
  // BACKUP (persistence.importJSON) and RESET ALL. The game that was just SD.state.set() gets:
  //   - opts.resetRuntime: SD.state.resetRuntime() and a fresh betting odds cache (import / restore /
  //     reset: the runtime maps are keyed by login and runner id, and ids restart at r01 in every game);
  //   - a race saved as 'finished' applied (applyPending), unless opts.deferPending;
  //   - a day event rolled when it has none (normalize() drops ids this build does not know);
  //   - the clock baseline set to now.
  // -> { ok, pending: applyPending()'s result | null (deferred / nothing pending), dayEventRolled }
  function afterLoad(opts) {
    opts = opts || {};
    const s = cur();
    if (!s) return { ok: false, pending: null, dayEventRolled: false };
    if (opts.resetRuntime) {
      SD.state.resetRuntime();
      if (SD.betting && typeof SD.betting.clearCache === 'function') SD.betting.clearCache();
    }
    let pending = null;
    if (!opts.deferPending) pending = applyPending();
    // Review batch 8: demo bots never survive a load (they only run in the chat panel of this page), so
    // '~' demo players in a loaded or imported save are leftovers: removed (after a race, see purgeDemo).
    let purged = null;
    try { purged = purgeDemo(); } catch (e) { purged = null; }
    let rolled = false;
    if (!cur().season.activeDayEvent) {
      commit('game:init', function (st) {
        st.season.activeDayEvent = SD.events.rollDayEvent(actionRng(st, 'day')).id;
      });
      rolled = true;
    }
    SD.state.runtime.lastClockAt = SD.clock.now();
    return { ok: true, pending: pending, dayEventRolled: rolled, demoPurged: purged && purged.ok ? purged.removed.length : 0 };
  }

  // Apply a race saved as 'finished' before its results were applied (review batch 7: shared by boot
  // and import, and safe). persistence.normalize() already turns a 'finished' race whose record lacks
  // what finishRace needs into an interrupted one (refunded on load / import); if applying still fails,
  // the race is cancelled like END / abort (bets refunded, paid effects queued again) and logged, so a
  // bad record can never stop the game from booting or leave the drawer locked.
  // -> { ok, applied: true, result } | { ok, applied: false, cancelled?, reason? } (null: nothing pending)
  // Review batch 8 (fix round 1): once the race is settled, the demo clean-up that afterLoad had to put
  // off (a race existed: IMPORT / TAKE OVER defer this call until after state:loaded) runs.
  function applyPending() {
    const res = applyPendingRace();
    if (res) { try { purgeDemo(); } catch (e) { /* retried on the next load */ } }
    return res;
  }
  function applyPendingRace() {
    const s = cur();
    const cr = s && s.currentRace;
    if (!cr || cr.status !== 'finished') return null;
    let reason = SD.persistence && typeof SD.persistence.recordProblem === 'function'
      ? SD.persistence.recordProblem(cr.record, true) : (cr.record ? null : 'no race record');
    if (!reason) {
      try {
        return { ok: true, applied: true, result: finishRace() };
      } catch (e) {
        reason = String((e && e.message) || e);
        if (typeof console !== 'undefined' && console.error) console.error('[SD.game] a finished race could not be applied:', e);
      }
    }
    const after = cur();
    if (!after || !after.currentRace) return { ok: true, applied: false, reason: reason };
    let refunded = 0;
    if (after.currentRace.record) {
      refunded = abortRace().refunded || 0;
    } else {
      commit('race:abort', function (st, emit) {
        refunded = SD.seasons.refundBets(st, 'abort');
        st.currentRace = null;
        emit(SD.EVENTS.RACE_ABORTED, { recordId: null, refunded: refunded });
      });
    }
    SD.state.log('race', 'A race saved as finished could not be applied (' + reason + '), so it was cancelled' +
      (refunded ? ' and ' + refunded + ' bet' + (refunded === 1 ? ' was' : 's were') + ' refunded.' : '.'), 'warn');
    return { ok: true, applied: false, cancelled: true, reason: reason, refunded: refunded };
  }

  // A fixed seed: an explicit startRace({ seed }) or the debug override (settings.debug &&
  // settings.seedOverride); null when the race seed is the normal salted one.
  function fixedSeed(s, override) {
    if (override != null && override !== '' && isFinite(Number(override))) return Number(override) >>> 0;
    if (s.settings.debug && s.settings.seedOverride != null && s.settings.seedOverride !== '' &&
        isFinite(Number(s.settings.seedOverride))) {
      return Number(s.settings.seedOverride) >>> 0;
    }
    return null;
  }

  // Field seed for a race number: seedFrom(seedSalt, season, day, raceCounter), or a fixed seed.
  // It draws the field and the lane order, which the paddock shows before bets close. The race
  // itself runs on the gate seed (see startRace), which adds fresh entropy when a source exists.
  function resolveSeed(s, override, counter) {
    const fixed = fixedSeed(s, override);
    return fixed != null ? fixed : SD.rng.seedFrom(s.meta.seedSalt, s.season.number, s.season.day, counter);
  }

  // The next race's field seed (what the paddock preview draws from). With an SD.entropy source the
  // race itself runs on a gate seed that adds fresh entropy at startRace, so this is not record.seed.
  function seedForRace() {
    const s = cur();
    return s ? resolveSeed(s, null, s.meta.raceCounter + 1) : 0;
  }

  /**
   * The exact field (in lane order) the NEXT startRace() would draw with the
   * current settings, so the paddock preview and odds match the real race.
   * Pure: does not mutate state or advance the race counter.
   */
  function previewField(count) {
    const s = cur();
    if (!s) return [];
    const C = SD.CONFIG.RACE;
    const n = U.clamp(Math.round(Number(count) || Number(s.settings.runnerCount) || 4), C.MIN_RUNNERS, C.MAX_RUNNERS);
    const seed = resolveSeed(s, null, s.meta.raceCounter + 1);
    const fieldRng = SD.rng.create(SD.rng.seedFrom(seed, 'field'));
    return fieldRng.shuffle(SD.race.selectField(s, n, fieldRng));
  }

  /**
   * Which queued chat effects (state.raceEffects) a race on this field uses: every effect on a runner
   * in the field, except sabotages beyond CONFIG.RACE.CHAT.MAX_SABOTAGE_PER_RACE (queue order), which
   * stay queued for that runner's next race, so a paid pebble never fizzles against the engine's cap.
   * Pure: returns { used, rest } (an entry straddling the cap is split, its `paid` shared by count).
   * betting.fieldOdds prices the next race with the same split.
   */
  function raceEffectsFor(queued, ids) {
    const cap = Math.max(0, Number(SD.CONFIG.RACE.CHAT.MAX_SABOTAGE_PER_RACE) || 0);
    const used = [], rest = [];
    let sab = 0;
    (Array.isArray(queued) ? queued : []).forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      if (ids.indexOf(e.runnerId) < 0) { rest.push(e); return; }
      if (e.type !== 'sabotage') { used.push(e); return; }
      const n = Math.max(1, Math.round(Number(e.count) || 1));
      const take = Math.max(0, Math.min(n, cap - sab));
      sab += take;
      if (take === n) { used.push(e); return; }
      if (take === 0) { rest.push(e); return; }
      const paid = Number(e.paid) || 0;
      const paidUsed = Math.round(paid * take / n);
      used.push(Object.assign({}, e, { count: take, paid: paidUsed }));
      rest.push(Object.assign({}, e, { count: n - take, paid: paid - paidUsed }));
    });
    return { used: used, rest: rest };
  }

  // ---------------------------------------------------------------------------
  // Races
  // ---------------------------------------------------------------------------
  function startRace(opts) {
    opts = opts || {};
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    if (s.currentRace) return fail('A race is already in progress. Let it finish (or END / abort it) first.');
    // M6 (fuzz): with auto-advance off the day used to run a 4th, 5th ... race ("Race 4/3").
    if (s.season.raceIndexInDay >= s.season.racesPerDay) {
      return fail("Today's " + s.season.racesPerDay + ' races are done. Start the next day (NEXT DAY) to race again.', { dayDone: true });
    }
    const C = SD.CONFIG.RACE;
    const distance = C.DISTANCES.indexOf(Number(opts.distance)) >= 0 ? Number(opts.distance)
      : (C.DISTANCES.indexOf(Number(s.settings.distance)) >= 0 ? Number(s.settings.distance) : C.DISTANCES[0]);
    const count = U.clamp(Math.round(Number(opts.runnerCount) || Number(s.settings.runnerCount) || 4), C.MIN_RUNNERS, C.MAX_RUNNERS);
    const eligible = SD.state.activeRunners().filter(function (r) { return r.energy >= C.MIN_ENERGY_TO_RACE; });
    if (eligible.length < C.MIN_RUNNERS) {
      return fail('Not enough rested runners to race: need at least ' + C.MIN_RUNNERS + ' with ' + C.MIN_ENERGY_TO_RACE +
        '+ energy (only ' + eligible.length + ' ready). Rest some runners or start the next day.');
    }

    return commit('race:start', function (st, emit) {
      st.meta.raceCounter += 1;
      const fixed = fixedSeed(st, opts.seed) != null;
      const fieldSeed = resolveSeed(st, opts.seed, st.meta.raceCounter);
      const fieldRng = SD.rng.create(SD.rng.seedFrom(fieldSeed, 'field'));
      const field = fieldRng.shuffle(SD.race.selectField(st, count, fieldRng)); // shuffle = lane draw
      // Review batch 5 (fix round 1): the paddock shows this field and lane order before bets close,
      // and for a big field that is enough to brute-force fieldSeed over all 2^32 values. So the race
      // does not run on fieldSeed: the gate seed adds a fresh SD.entropy value drawn now, after bets
      // have closed, and the gate moods, the track name and the simulation all come from it. The
      // record stores the gate seed, so REPLAY LAST RACE and COPY LAST RACE JSON still reproduce the
      // race. Without an entropy source (Node / tests), or with a fixed seed (debug override, explicit
      // opts.seed), the gate seed is fieldSeed and every draw is exactly as before.
      const gateEntropy = fixed || !SD.entropy ? null : SD.entropy.next();
      const seed = gateEntropy == null ? fieldSeed : (fieldSeed + gateEntropy) >>> 0;
      const gateRng = gateEntropy == null ? fieldRng : SD.rng.create(SD.rng.seedFrom(seed, 'gate'));
      const hype = st.hype.value;

      // Crowd energy rubs off on the runners before the gates open. The gate mood lives on the race
      // snapshot only (the entrants): the live runner keeps its mood until finishRace sets the result's
      // moodAfter, so an aborted or interrupted race leaves no Chaotic / Fired Up behind.
      const H = C.HYPE, M = SD.CONFIG.MOOD;
      const gateField = field.map(function (r) {
        let mood = null;
        if (hype >= H.AWAKENED && gateRng.chance(M.CHAOTIC_RACE_CHANCE)) mood = 'Chaotic';
        else if (hype >= H.FERAL && gateRng.chance(M.FIRED_UP_RACE_CHANCE)) mood = 'Fired Up';
        return mood && mood !== r.mood ? Object.assign({}, r, { mood: mood }) : r;
      });

      // Queued chat effects for runners in this field are consumed (sabotages only up to the per-race
      // cap); the others stay queued.
      const ids = field.map(function (r) { return r.id; });
      const split = raceEffectsFor(st.raceEffects, ids);
      const used = split.used;
      st.raceEffects = split.rest;
      const chatEffects = [];
      const cheerBonus = {};
      // Viewers are stored by username key; the race shows their display names.
      const shownName = function (by) {
        const p = by ? U.own(st.players, String(by).toLowerCase()) : null;
        return p && p.displayName ? p.displayName : (by || 'chat');
      };
      used.forEach(function (e) {
        if (e.type === 'cheer') {
          cheerBonus[e.runnerId] = (cheerBonus[e.runnerId] || 0) + Math.max(1, e.count || 1);
          // Also passed to the engine so the cheer shows up as a 'chat' line with the viewer's name.
          chatEffects.push({ runnerId: e.runnerId, type: 'cheer', by: shownName(e.by), count: Math.max(1, e.count || 1) });
        } else if (e.type === 'boost' || e.type === 'sabotage') {
          // by = the display name the race commentary shows; byKey = the viewer's login (Karma, etc.)
          for (let k = 0; k < Math.max(1, e.count || 1); k++) chatEffects.push({ runnerId: e.runnerId, type: e.type, by: shownName(e.by), byKey: e.by || null });
        }
      });

      const dayEvent = SD.events.dayEventById(st.season.activeDayEvent);
      // The gate's own odds see everything the engine will: gate moods, hype tier, cheers, boosts and
      // sabotages. lockForRace settles every open bet at min(its quoted odds, these).
      const entrants = SD.race.buildEntrants(gateField, {
        distance: distance, hypeLevel: hype, dayEvent: dayEvent, cheerBonus: cheerBonus, chatEffects: chatEffects
      });
      const active = SD.state.activeRunners(st);
      const rosterAvgLevel = active.reduce(function (a, r) { return a + r.level; }, 0) / Math.max(1, active.length);
      const trackName = gateRng.pick(SD.DATA.TRACK_NAMES);
      const indexInDay = st.season.raceIndexInDay + 1;
      const record = SD.race.simulate({
        id: 's' + st.season.number + 'd' + st.season.day + 'r' + indexInDay + '-' + st.meta.raceCounter,
        seed: seed,
        distance: distance,
        entrants: entrants,
        eventFrequency: st.settings.eventFrequency,
        hypeLevel: hype,
        dayEvent: dayEvent,
        chatEffects: chatEffects,
        raceEffects: used,
        trackName: trackName,
        season: st.season.number,
        day: st.season.day,
        indexInDay: indexInDay,
        rosterAvgLevel: rosterAvgLevel
      });
      st.currentRace = { record: record, status: 'countdown', startedAt: SD.clock.now() };
      // Review batch 5: fresh entropy for every later race (no-op without an SD.entropy source), so
      // this record's seed - shown in debug and COPY LAST RACE JSON - predicts nothing after it.
      SD.state.resalt(st, 'race:' + st.meta.raceCounter);
      // Bets on runners that did not make the field (or that are odds-on at the gate) are refunded; the
      // rest are locked in at min(quoted, gate odds). They count (stats, hype, High Roller) only when the
      // race finishes and they are settled, so an aborted or interrupted race counts nothing.
      let bets = null;
      if (SD.betting && typeof SD.betting.lockForRace === 'function') bets = SD.betting.lockForRace(st, record) || null;

      const fav = record.entrants.slice().sort(function (a, b) { return a.odds - b.odds; })[0];
      const message = 'Race ' + indexInDay + '/' + st.season.racesPerDay + ' at ' + trackName + ' (' + distance + ' m): ' +
        record.entrants.map(function (e) { return e.name; }).join(', ') + '. Favourite: ' + fav.name + ' at ' + Number(fav.odds).toFixed(1) + 'x.';
      SD.state.log('race', message, 'info', SD.state.listTags(record.entrants, { recordId: record.id }));
      emit(SD.EVENTS.RACE_STARTED, { record: record });
      return { ok: true, message: message, record: record, bets: bets };
    });
  }

  // Used by playback: countdown -> running (-> finished).
  function setRaceStatus(status) {
    const valid = ['countdown', 'running', 'paused', 'finished'];
    if (valid.indexOf(status) < 0) return fail('Unknown race status "' + status + '".');
    const s = cur();
    if (!s || !s.currentRace) return fail('No race in progress.');
    if (s.currentRace.status === status) return { ok: true, status: status };
    commit('race:status', function (st) { st.currentRace.status = status; });
    return { ok: true, status: status };
  }

  function pauseRace() {
    const s = cur();
    const cr = s && s.currentRace;
    if (!cr) return fail('No race is running.');
    if (cr.status === 'paused') return fail('The race is already paused.');
    if (cr.status === 'finished') return fail('The race has already finished.');
    commit('race:pause', function (st, emit) {
      st.currentRace.prevStatus = st.currentRace.status;
      st.currentRace.status = 'paused';
      emit(SD.EVENTS.RACE_PAUSED, { recordId: st.currentRace.record.id });
    });
    return { ok: true, message: 'Race paused.' };
  }

  function resumeRace() {
    const s = cur();
    const cr = s && s.currentRace;
    if (!cr) return fail('No race is running.');
    if (cr.status !== 'paused') return fail('The race is not paused.');
    commit('race:resume', function (st, emit) {
      st.currentRace.status = st.currentRace.prevStatus && st.currentRace.prevStatus !== 'paused' ? st.currentRace.prevStatus : 'running';
      delete st.currentRace.prevStatus;
      emit(SD.EVENTS.RACE_RESUMED, { recordId: st.currentRace.record.id });
    });
    return { ok: true, message: 'Race resumed.' };
  }

  // Skip to the end. Playback (browser) jumps to the last tick and emits
  // race:playbackDone -> finishRace(). Without playback (Node) we finish directly.
  function endRace() {
    const s = cur();
    if (!s || !s.currentRace) return fail('No race to end.');
    const recordId = s.currentRace.record.id;
    SD.bus.emit(SD.EVENTS.RACE_END_REQUESTED, { recordId: recordId });
    if (!SD.playback) {
      const after = cur();
      if (after && after.currentRace && after.currentRace.record.id === recordId) return finishRace();
    }
    return { ok: true, message: 'Skipping to the finish line...' };
  }

  // Apply the simulated results to the persistent world.
  function finishRace() {
    const s = cur();
    if (!s || !s.currentRace) return fail('No race to finish.');
    const record = s.currentRace.record;
    const levelUps = [];
    let bets = [], payouts = [], achievements = [], dayInfo = null;

    commit('race:finish', function (st, emit) {
      const CFG = SD.CONFIG;
      const now = SD.clock.now();
      const summary = record.summary;

      record.results.forEach(function (res) {
        const r = SD.state.runnerById(res.runnerId, st);
        if (!r) return; // runner deleted meanwhile
        const condBefore = r.condition;
        const xpRes = SD.runners.addXp(r, res.xp);
        res.levelUps = xpRes.levelUps;
        if (xpRes.levelUps > 0) levelUps.push({ runnerId: r.id, name: r.name, level: r.level, levelUps: xpRes.levelUps });
        const cap = SD.runners.statCap(r.level);
        Object.keys(res.statChanges || {}).forEach(function (k) {
          if (k in r.stats) r.stats[k] = U.clamp(r.stats[k] + res.statChanges[k], 1, cap);
        });
        r.energy = U.round2(U.clamp(r.energy + res.energyDelta, 0, r.maxEnergy));
        r.fatigue = U.round2(U.clamp(r.fatigue + res.fatigueDelta, 0, CFG.CONDITION.MAX_FATIGUE));
        SD.runners.refreshCondition(r);
        SD.runners.setMood(r, res.moodAfter);
        const rec = r.record;
        rec.races++;
        if (res.place === 1) { rec.wins++; rec.winStreak++; } else { rec.losses++; rec.winStreak = 0; }
        if (res.place <= 3) rec.podiums++;
        if (rec.bestTimeSec == null || res.timeSec < rec.bestTimeSec) rec.bestTimeSec = res.timeSec;
        if (!rec.bestTimes || typeof rec.bestTimes !== 'object' || Array.isArray(rec.bestTimes)) rec.bestTimes = {};
        if (rec.bestTimes[record.distance] == null || res.timeSec < rec.bestTimes[record.distance]) rec.bestTimes[record.distance] = res.timeSec;
        r.lifetime.races++;
        if (res.place === 1) r.lifetime.wins++;
        r.lastActionAt = now;
        if (condBefore !== r.condition) emit(SD.EVENTS.RUNNER_CONDITION, { runnerId: r.id, from: condBefore, to: r.condition });
      });

      // Later-milestone modules, only if loaded.
      if (SD.betting && typeof SD.betting.resolveRace === 'function') bets = SD.betting.resolveRace(st, record) || [];
      record.bets = bets;
      if (SD.players && typeof SD.players.applyRaceResults === 'function') payouts = SD.players.applyRaceResults(st, record) || [];

      // Hype: big moments first (they can trip a threshold banner), then post-race decay.
      const MH = CFG.RESULTS.MAJOR_HYPE;
      let major = MH.finish + (summary.photoFinish ? MH.photoFinish : 0) + (summary.upset ? MH.upset : 0) +
        (summary.forestAwakened ? MH.awakened : 0);
      levelUps.forEach(function (l) { major += l.levelUps * CFG.PROGRESSION.LEVELUP_HYPE; });
      SD.hype.add(st, major, { reason: 'raceFinish' });
      SD.hype.decayAfterRace(st);
      // Settled bets add their hype now, after the decay: it builds toward the NEXT race (the one that
      // just ran was simulated with the hype it had at the gate, so it never claims a tier it lacked).
      if (SD.betting && typeof SD.betting.creditBetHype === 'function') SD.betting.creditBetHype(st, bets);
      record.hypeAfter = st.hype.value;

      if (SD.achievements && typeof SD.achievements.checkRace === 'function') achievements = SD.achievements.checkRace(st, record) || [];

      st.raceHistory.push(record);
      if (SD.persistence) SD.persistence.trimHistory(st);
      st.currentRace = null;
      st.season.raceIndexInDay += 1;
      st.season.racesRun = (st.season.racesRun || 0) + 1;

      const win = record.results[0];
      SD.state.log('race', summary.winnerName + ' wins at ' + record.trackName + ' (' + record.distance + ' m) in ' +
        win.timeSec.toFixed(1) + 's' + (summary.photoFinish ? ' in a PHOTO FINISH' : '') +
        (summary.upset ? ', a ' + summary.upsetOdds + 'x upset' : '') + '!', 'epic', { recordId: record.id, winnerId: win.runnerId });
      levelUps.forEach(function (l) {
        SD.state.log('levelup', l.name + ' reached level ' + l.level + '!', 'good', { runnerId: l.runnerId });
      });

      if (st.settings.autoAdvanceDay && st.season.raceIndexInDay >= st.season.racesPerDay) {
        dayInfo = SD.seasons.advanceDay(st, actionRng(st, 'day'));
      }

      // Emission order: level-ups, race finished, then any day / season change.
      levelUps.forEach(function (l) { emit(SD.EVENTS.RUNNER_LEVELUP, l); });
      emit(SD.EVENTS.RACE_FINISHED, {
        record: record, results: record.results, bets: bets, levelUps: levelUps,
        achievements: achievements, payouts: payouts, dayAdvanced: dayInfo
      });
      if (dayInfo) emitDayInfo(st, dayInfo, emit);
    });
    saveNow();
    return { ok: true, message: record.summary.winnerName + ' wins!', record: record, levelUps: levelUps, bets: bets, achievements: achievements, dayAdvanced: dayInfo };
  }

  // Cancel the current race: bets refunded, queued chat effects restored.
  function abortRace() {
    const s = cur();
    if (!s || !s.currentRace) return fail('No race to abort.');
    const record = s.currentRace.record;
    let refunded = 0;
    commit('race:abort', function (st, emit) {
      refunded = SD.seasons.refundBets(st, 'abort');
      const inputs = record.inputs || {};
      if (Array.isArray(inputs.raceEffects) && inputs.raceEffects.length) {
        st.raceEffects = inputs.raceEffects.concat(st.raceEffects || []);
      }
      st.currentRace = null;
      SD.state.log('race', 'The race at ' + (record.trackName || 'the forest track') + ' was cancelled' +
        (refunded ? '; ' + refunded + ' bet' + (refunded === 1 ? ' was' : 's were') + ' refunded.' : '.'), 'warn', { recordId: record.id });
      emit(SD.EVENTS.RACE_ABORTED, { recordId: record.id, refunded: refunded });
    });
    saveNow();
    return { ok: true, message: 'Race cancelled.', refunded: refunded };
  }

  // Re-simulate the last race from its stored inputs and compare hashes.
  function replayInputs(rec) {
    const snap = rec.settingsSnapshot || {};
    const inputs = rec.inputs || {};
    return {
      id: rec.id, seed: rec.seed, distance: rec.distance, entrants: rec.entrants,
      eventFrequency: snap.eventFrequency, hypeLevel: snap.hypeLevel, dayEvent: snap.dayEventId,
      chatEffects: inputs.chatEffects || [], raceEffects: inputs.raceEffects, trackName: rec.trackName,
      season: rec.season, day: rec.day, indexInDay: rec.indexInDay, rosterAvgLevel: inputs.rosterAvgLevel
    };
  }

  function replayLastRace() {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    const rec = s.raceHistory.length ? s.raceHistory[s.raceHistory.length - 1] : (s.currentRace && s.currentRace.record);
    if (!rec) return fail('No race to replay yet.');
    if ((rec.engineVersion || 1) !== SD.race.ENGINE_VERSION) {
      return fail('The last race was run by an older version of the race engine (v' + (rec.engineVersion || 1) +
        '), so it cannot be replayed exactly. Run a new race first.', { stale: true, recordId: rec.id });
    }
    const again = SD.race.simulate(replayInputs(rec));
    const same = again.hash === rec.hash;
    return {
      ok: true, sameHash: same, hash: rec.hash, replayHash: again.hash, recordId: rec.id, record: again,
      message: same ? 'Replay matches (hash ' + rec.hash + ').' : 'Replay MISMATCH: ' + rec.hash + ' vs ' + again.hash
    };
  }

  // ---------------------------------------------------------------------------
  // Training
  // ---------------------------------------------------------------------------
  function trainRunner(runnerId, stat, by) {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    const runner = resolveRunner(runnerId);
    if (!runner) return fail('No runner called "' + runnerId + '".');
    if (SD.state.isRaceLocked()) return fail('Training is closed while a race is running. Cheer instead!');
    if (!SD.training.normalizeStat(stat)) {
      return fail('Unknown stat "' + (stat == null ? '' : stat) + '". Try speed, stamina, power, wisdom or luck.');
    }
    // Review batch 5: every refusal (too tired, stat maxed) is decided before the commit, so a refused
    // train draws no action RNG (a spammed refusal cannot steer the next roll) and emits nothing.
    const refused = SD.training.refusal(runner, stat);
    if (refused) return refused;
    let res;
    commit('runner:train', function (st, emit) {
      res = SD.training.train(st, runner, stat, { rng: actionRng(st, 'train'), by: by });
      if (!res.ok) return;
      if (res.hype) SD.hype.add(st, res.hype, { by: by, reason: 'train' });
      if (res.levelUps) {
        SD.hype.add(st, res.levelUps * SD.CONFIG.PROGRESSION.LEVELUP_HYPE, { by: by, reason: 'levelUp' });
        SD.state.log('levelup', runner.name + ' reached level ' + runner.level + '!', 'good', { runnerId: runner.id });
        emit(SD.EVENTS.RUNNER_LEVELUP, { runnerId: runner.id, name: runner.name, level: runner.level, levelUps: res.levelUps });
      }
      if (by && res.sp && SD.players && typeof SD.players.award === 'function') {
        const spMult = SD.events.dayModifiers(st.season.activeDayEvent).spMult;
        res.spAwarded = SD.players.award(st, by, Math.round(res.sp * spMult), 'train');
      }
      SD.state.log('train', res.message.split('\n').join(' | '),
        res.outcome === 'crit' ? 'epic' : (res.outcome === 'fail' ? 'bad' : 'info'),
        { runnerId: runner.id, by: by || null, outcome: res.outcome });
      emit(SD.EVENTS.RUNNER_TRAINED, { runnerId: runner.id, stat: res.stat, by: by || null, result: res });
      if (res.conditionChanged) emit(SD.EVENTS.RUNNER_CONDITION, { runnerId: runner.id, from: res.conditionBefore, to: res.condition });
    });
    return res;
  }

  function restRunner(runnerId, by) {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    const runner = resolveRunner(runnerId);
    if (!runner) return fail('No runner called "' + runnerId + '".');
    if (SD.state.isRaceLocked()) return fail('Resting is closed while a race is running.');
    const left = SD.training.restCooldownLeft(runner);
    if (left > 0) return fail(runner.name + ' is still resting. Try again in ' + U.fmtDuration(left) + '.', { cooldownMs: left });
    let res;
    commit('runner:rest', function (st, emit) {
      res = SD.training.rest(st, runner, { by: by, now: SD.clock.now() });
      if (!res.ok) return;
      if (res.hype) SD.hype.add(st, res.hype, { by: by, reason: 'rest', raw: true });
      SD.state.log('rest', res.message.split('\n').join(' | '), 'info', { runnerId: runner.id, by: by || null });
      emit(SD.EVENTS.RUNNER_RESTED, { runnerId: runner.id, by: by || null, result: res });
      if (res.conditionChanged) emit(SD.EVENTS.RUNNER_CONDITION, { runnerId: runner.id, from: res.conditionBefore, to: res.condition });
    });
    return res;
  }

  // ---------------------------------------------------------------------------
  // World
  // ---------------------------------------------------------------------------
  // Set today's day event (by id / name) or roll a random different one.
  function triggerDayEvent(id) {
    const s = cur();
    if (!s) return null;
    let ev = null;
    if (id != null && id !== '') {
      ev = SD.events.dayEventById(id);
      if (!ev) return null;
    }
    commit('event:day', function (st, emit) {
      if (!ev) ev = SD.events.rollDayEvent(actionRng(st, 'day'), st.season.activeDayEvent);
      st.season.activeDayEvent = ev.id;
      SD.state.log('event', 'Day event: ' + ev.name + '. ' + ev.desc, 'good', { dayEventId: ev.id });
      emit(SD.EVENTS.EVENT_DAY, { event: ev, manual: true });
    });
    return ev;
  }

  // Admin / debug hype. Exact amount (no hype multiplier).
  function addHype(n, by) {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    const amount = Number(n);
    if (!isFinite(amount)) return fail('Hype amount must be a number.');
    return commit('hype:add', function (st) {
      const r = SD.hype.add(st, amount, { by: by, reason: 'admin', raw: true });
      return { ok: true, value: r.value, delta: r.delta, crossed: r.crossed };
    });
  }

  function maxActiveRunners() {
    const R = SD.CONFIG.RUNNERS || {};
    return Number(R.MAX_ACTIVE) > 0 ? Number(R.MAX_ACTIVE) : 24;
  }

  // Spawn a random runner from a species template: random species (unless speciesId), a style that
  // species runs, stats summing to PROGRESSION.STAT_TOTAL (200) and a style-suited ability from the
  // catalog. Admin SPAWN RUNNER and !create <name> both come through here.
  // opts: { name, speciesId, style, abilityId, owner, by, byName }  (`by` = username key of the viewer
  // who created it: Creator achievement; `byName` = their display name for the log; `owner` = the
  // login of a viewer to own it straight away without SD.players.claim: runner.ownerKey is that
  // login's key and runner.owner the player's display name, or the login when nobody has joined).
  // Returns the new Runner, or { ok:false, message } when refused (CONFIG.RUNNERS.MAX_ACTIVE reached).
  function spawnRunner(opts) {
    opts = opts || {};
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    const max = maxActiveRunners();
    const active = SD.state.activeRunners(s).length;
    if (active >= max) {
      return fail('The paddock is full: ' + active + ' runners already (the limit is ' + max + ', CONFIG.RUNNERS.MAX_ACTIVE). ' +
        'Claim one of them instead.', { full: true });
    }
    let runner = null;
    commit('runner:spawn', function (st, emit) {
      const rng = actionRng(st, 'spawn');
      runner = SD.runners.spawnRandom(rng, {
        name: opts.name, speciesId: opts.speciesId, style: opts.style, abilityId: opts.abilityId, id: SD.runners.nextId(st)
      });
      // Names must be unique (case / punctuation-insensitive): "Moss Runner 2".
      runner.name = SD.runners.uniqueName(st, runner.name);
      const ownerKey = opts.owner && SD.players ? SD.players.keyOf(opts.owner) : (opts.owner ? String(opts.owner).toLowerCase() : '');
      if (ownerKey && !(SD.players && SD.players.isReservedKey(ownerKey))) {
        const holder = st.players && Object.prototype.hasOwnProperty.call(st.players, ownerKey) ? st.players[ownerKey] : null;
        runner.ownerKey = ownerKey;
        runner.owner = (holder && holder.displayName) || (SD.players ? SD.players.cleanName(opts.owner) : String(opts.owner));
        runner.claimedAt = SD.clock.now();
      }
      st.runners.push(runner);
      // Review batch 8: a runner a demo bot created is deleted again when the bots are cleaned up.
      const byKey = opts.by && SD.players ? SD.players.keyOf(opts.by) : '';
      if (byKey && SD.players.isDemoKey(byKey)) {
        const rt = SD.state.runtime;
        if (!rt.demoRunners || typeof rt.demoRunners !== 'object') rt.demoRunners = U.dict();
        U.setOwn(rt.demoRunners, runner.id, true);
        // Saved too (fix round 1, gap1#2): after a reload or an import the runtime map is empty, and a
        // bot-made runner must still leave with the bots. Only bot-made runners carry the flag.
        runner.demo = true;
      }
      SD.state.log('runner', 'A new runner joins the derby: ' + runner.emoji + ' ' + runner.name + ', a ' + runner.species + ' (' +
        SD.runners.styleName(runner.style) + ')' + (opts.by ? ', created by ' + (opts.byName || opts.by) : '') + '.', 'good',
        Object.assign({ runnerId: runner.id }, byKey ? { by: byKey } : {}));
      emit(SD.EVENTS.RUNNER_SPAWNED, { runner: runner, by: opts.by || runner.ownerKey || null });
    });
    return runner;
  }

  // ---------------------------------------------------------------------------
  // Moderation (review batch 8): admin RETIRE / RENAME / DELETE a runner, REMOVE PLAYER, and the demo
  // bots' clean-up. A viewer's !create name used to stay on the overlay, in replies and in the bridge's
  // race frames until RESET ALL. All of these are refused while a race exists (its record, bets and
  // effects are locked to the field), and they work on ids / login keys, not on name queries.
  // ---------------------------------------------------------------------------
  const REMOVED_RUNNER = '(removed runner)';
  const REMOVED_VIEWER = '(removed viewer)';

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // `from` as a whole name in text (not inside a longer word) replaced by `to`. notAtStart: a match at
  // the very start of the text is left alone (a line about several viewers / runners starts with fixed
  // words such as "Bets paid:", "Race payouts:" or "Season 3 is over!", never with a name).
  function swapName(text, from, to, notAtStart) {
    if (!from || typeof text !== 'string' || text.indexOf(from) < 0) return text;
    const re = new RegExp((notAtStart ? '([^\\p{L}\\p{N}_])' : '(^|[^\\p{L}\\p{N}_])') + escapeRe(from) + '(?=$|[^\\p{L}\\p{N}_])', 'gu');
    return text.replace(re, function (m, pre) { return pre + to; });
  }
  function tagged(list, x) { return Array.isArray(list) && list.indexOf(x) >= 0; }
  function recordOf(st, id) {
    const hist = Array.isArray(st.raceHistory) ? st.raceHistory : [];
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i] && hist[i].id === id) return hist[i];
    const cr = st.currentRace && st.currentRace.record;
    return cr && cr.id === id ? cr : null;
  }
  function inRecord(rec, id) {
    return ['entrants', 'results'].some(function (k) {
      return Array.isArray(rec[k]) && rec[k].some(function (x) { return x && x.runnerId === id; });
    });
  }

  // Review batch 8 (fix round 1): which log lines name a runner. Only lines tagged with it are
  // rewritten, so a runner called "Season" or "Day" never touches "A new day dawns: Season 2, Day 3".
  //   'all'    - a line about this runner (runnerId): every whole-word match;
  //   'inner'  - a line naming several runners (runnerIds: race start, bets, payouts, a claim that
  //              released it, a season end's champion; before those tags, the bet / sp / race-start
  //              lines of a race it ran in, found by recordId): not a match at the start of the line;
  //   'winner' - "<name> wins at <track> ..." (winnerId, or the record's winner): only that name.
  function runnerMention(st, e, id) {
    if (e.runnerId === id) return 'all';
    if (tagged(e.runnerIds, id)) return 'inner';
    if (e.runnerId != null || Array.isArray(e.runnerIds) || !e.recordId) return null;
    const rec = recordOf(st, e.recordId);
    if (e.type === 'race' && (e.winnerId != null ? e.winnerId === id
      : !!(rec && Array.isArray(rec.results) && rec.results[0] && rec.results[0].runnerId === id))) return 'winner';
    if (e.winnerId != null) return null;
    if (e.type === 'bet' || e.type === 'sp' || (e.type === 'race' && /^Race \d/.test(e.text))) {
      return !rec || inRecord(rec, id) ? 'inner' : null;
    }
    return null;
  }

  // A runner's old name out of the game log and the archived season summaries. Race records keep it:
  // their results are hashed (REPLAY LAST RACE compares the hash). When another runner's name contains
  // the old name ("Moss Runner 2"), only log entries about this runner alone (runnerId) are rewritten.
  function scrubRunnerName(st, runner, from, to) {
    const shared = st.runners.some(function (r) { return r !== runner && swapName(r.name, from, '\u0000') !== r.name; });
    (st.log || []).forEach(function (e) {
      if (!e || typeof e.text !== 'string' || e.text.indexOf(from) < 0) return;
      const how = runnerMention(st, e, runner.id);
      if (!how || (shared && how !== 'all')) return;
      if (how === 'winner') {
        if (e.text.indexOf(from + ' wins at ') === 0) e.text = to + e.text.slice(from.length);
      } else e.text = swapName(e.text, from, to, how === 'inner');
    });
    ((st.season && st.season.history) || []).forEach(function (h) {
      if (!h || typeof h !== 'object') return;
      (Array.isArray(h.runnerTable) ? h.runnerTable : []).forEach(function (row) { if (row && row.runnerId === runner.id) row.name = to; });
      if (h.championRunnerId === runner.id) h.championName = to;
      if (h.biggestUpset && h.biggestUpset.winnerId === runner.id) h.biggestUpset.winnerName = to;
    });
    (Array.isArray(st.bets) ? st.bets : []).forEach(function (b) { if (b && b.runnerId === runner.id) b.runnerName = to; });
  }

  function findRunnerById(s, id) {
    if (id == null) return null;
    if (typeof id === 'object' && id.id) id = id.id;
    for (let i = 0; i < s.runners.length; i++) if (String(s.runners[i].id) === String(id)) return s.runners[i];
    return null;
  }

  // Everything that points at a runner that is leaving the derby: open bets on it refunded, queued
  // boosts / sabotages on it refunded to whoever paid (cheers dropped), its owner released, every
  // player's runnerId / backing on it cleared, its runtime rest cooldown and nervous-cheer count dropped.
  // Runs inside a mutation. -> { bets: refunded bets, effects: refunded paid effects, owner: login | null }
  function detachRunner(st, runner) {
    const id = runner.id;
    const bets = SD.betting && typeof SD.betting.refundWhere === 'function'
      ? SD.betting.refundWhere(st, function (b) { return b.runnerId === id; }, 'runnerRetired').length : 0;
    let effects = 0;
    const keep = [];
    (Array.isArray(st.raceEffects) ? st.raceEffects : []).forEach(function (e) {
      if (!e || e.runnerId !== id) { keep.push(e); return; }
      if (e.paid > 0 && e.by && SD.players && SD.players.refundSp(st, e.by, e.paid, 'effectRefund').ok) effects++;
    });
    st.raceEffects = keep;
    const owner = SD.players ? SD.players.ownerKey(runner) : runner.ownerKey || null;
    runner.owner = null;
    runner.ownerKey = null;
    runner.claimedAt = null;
    Object.keys(st.players || {}).forEach(function (k) {
      const p = U.own(st.players, k);
      if (!p || typeof p !== 'object') return;
      if (p.runnerId === id) p.runnerId = null;
      if (p.backing && p.backing.runnerId === id) p.backing = { runnerId: null, actions: 0 };
    });
    const rt = SD.state.runtime;
    ['runnerCooldowns', 'nervousCheers', 'demoRunners'].forEach(function (m) {
      if (rt[m] && U.hasOwn(rt[m], id)) delete rt[m][id];
    });
    return { bets: bets, effects: effects, owner: owner };
  }

  function raceGuard(s, what) {
    if (!s) return fail('The game has not been initialised yet.');
    if (s.currentRace) return fail('Finish the current race before you ' + what + '.');
    return null;
  }

  // RETIRE: the runner leaves the paddock, the field, the season boards and chat lookups for good. It
  // stays in race records, the all-time boards and past season summaries, and its name stays taken.
  // -> { ok, message, runner, refunded: { bets, effects } }
  function retireRunner(id, opts) {
    opts = opts || {};
    const s = cur();
    const refused = raceGuard(s, 'retire a runner');
    if (refused) return refused;
    const runner = findRunnerById(s, id);
    if (!runner) return fail('No runner with id "' + id + '".');
    if (runner.retired) return fail(runner.name + ' is already retired.');
    let info;
    commit('runner:retire', function (st, emit) {
      info = detachRunner(st, runner);
      runner.retired = true;
      // A created runner is named by id only: its name may be the reason it was retired.
      SD.state.log('runner', (runner.custom ? 'The streamer retired a created runner (' + runner.id + ')' : runner.emoji + ' ' + runner.name + ' was retired by the streamer') +
        (info.bets || info.effects ? ' (' + plural(info.bets, 'bet') + ' and ' + plural(info.effects, 'queued effect') + ' refunded).' : '.'), 'info', { runnerId: runner.id });
      emit(SD.EVENTS.RUNNER_RETIRED, { runnerId: runner.id, name: runner.name, deleted: false, refunded: info, by: opts.by || null });
      if (info.owner) emit(SD.EVENTS.RUNNER_CLAIMED, { runnerId: runner.id, username: null, displayName: null, releasedRunnerId: runner.id, releasedBy: info.owner });
    });
    saveNow();
    return { ok: true, message: runner.name + ' was retired.', runner: runner, refunded: { bets: info.bets, effects: info.effects } };
  }

  // DELETE (runners made by !create or SPAWN RUNNER only; roster runners can be retired): like RETIRE,
  // then the runner is removed from the game, so it leaves the all-time boards too and its name is free
  // again. Its name becomes "(removed runner)" in the log and in past season summaries; race records
  // keep their own (hashed) copy. -> { ok, message, runnerId, refunded }
  function deleteRunner(id, opts) {
    opts = opts || {};
    const s = cur();
    const refused = raceGuard(s, 'delete a runner');
    if (refused) return refused;
    const runner = findRunnerById(s, id);
    if (!runner) return fail('No runner with id "' + id + '".');
    if (!runner.custom) return fail(runner.name + ' is one of the original roster runners: retire it instead.');
    let info;
    const name = runner.name;
    commit('runner:delete', function (st, emit) {
      info = detachRunner(st, runner);
      scrubRunnerName(st, runner, name, REMOVED_RUNNER);
      st.runners = st.runners.filter(function (r) { return r !== runner; });
      SD.state.log('runner', 'A runner was deleted by the streamer' +
        (info.bets || info.effects ? ' (' + plural(info.bets, 'bet') + ' and ' + plural(info.effects, 'queued effect') + ' refunded).' : '.'), 'info');
      emit(SD.EVENTS.RUNNER_RETIRED, { runnerId: runner.id, name: REMOVED_RUNNER, deleted: true, refunded: info, by: opts.by || null });
      if (info.owner) emit(SD.EVENTS.RUNNER_CLAIMED, { runnerId: runner.id, username: null, displayName: null, releasedRunnerId: runner.id, releasedBy: info.owner });
    });
    saveNow();
    return { ok: true, message: name + ' was deleted.', runnerId: runner.id, refunded: { bets: info.bets, effects: info.effects } };
  }

  // RENAME: the new name must pass the !create rules (SD.runners.checkName, ignoring the runner itself).
  // The old name is replaced in the log, open bets and past season summaries (not in race records).
  // -> { ok, message, runner, from, to }
  function renameRunner(id, name, opts) {
    opts = opts || {};
    const s = cur();
    const refused = raceGuard(s, 'rename a runner');
    if (refused) return refused;
    const runner = findRunnerById(s, id);
    if (!runner) return fail('No runner with id "' + id + '".');
    const check = SD.runners.checkName(s, name, { exclude: runner.id });
    if (!check.ok) return fail(check.message.replace(/!create <name>/g, 'a new name'), { invalidName: true });
    const from = runner.name, to = check.name;
    if (from === to) return fail(runner.name + ' already has that name.');
    commit('runner:rename', function (st, emit) {
      scrubRunnerName(st, runner, from, to);
      runner.name = to;
      SD.state.log('runner', 'The streamer renamed a runner to ' + runner.emoji + ' ' + to + '.', 'info', { runnerId: runner.id });
      emit(SD.EVENTS.RUNNER_RENAMED, { runnerId: runner.id, from: from, to: to, by: opts.by || null });
    });
    saveNow();
    return { ok: true, message: 'Renamed to ' + to + '.', runner: runner, from: from, to: to };
  }

  // A removed viewer's name out of the log lines that name them: lines about them (username / by),
  // lines naming several viewers (usernames: bets, payouts, a season end's MVP / champion owner; not a
  // match at the start of the line) and, in lines logged before those tags existed, the runner-created
  // line (", created by <name>.") and the bet / payout lines of a race (bet / sp with a recordId).
  function scrubViewerName(st, key, name) {
    const created = ', created by ' + name + '.';
    (st.log || []).forEach(function (e) {
      if (!e || typeof e.text !== 'string' || e.text.indexOf(name) < 0) return;
      if (e.username === key || e.by === key) e.text = swapName(e.text, name, REMOVED_VIEWER);
      else if (tagged(e.usernames, key)) e.text = swapName(e.text, name, REMOVED_VIEWER, true);
      else if (Array.isArray(e.usernames) || e.by != null || e.username != null) return;
      else if (e.type === 'runner' && e.text.indexOf(created) >= 0) e.text = e.text.split(created).join(', created by ' + REMOVED_VIEWER + '.');
      else if (e.recordId && (e.type === 'bet' || e.type === 'sp')) e.text = swapName(e.text, name, REMOVED_VIEWER, true);
    });
  }

  function removeOne(st, key, opts, emit) {
    const res = SD.players.remove(st, key);
    if (!res) return null;
    const rt = SD.state.runtime;
    ['cooldowns', 'activity', 'hypeRecent'].forEach(function (m) { if (rt[m] && U.hasOwn(rt[m], key)) delete rt[m][key]; });
    if (opts.scrub && res.player.displayName) scrubViewerName(st, key, res.player.displayName);
    emit(SD.EVENTS.PLAYER_REMOVED, { username: key, displayName: opts.scrub ? REMOVED_VIEWER : res.player.displayName, demo: !!opts.demo, released: res.released });
    res.released.forEach(function (rid) {
      emit(SD.EVENTS.RUNNER_CLAIMED, { runnerId: rid, username: null, displayName: null, releasedRunnerId: rid, releasedBy: key });
    });
    return res;
  }

  // REMOVE PLAYER: the viewer's profile leaves the save (SD.players.remove: runner released, open bets and
  // queued effects dropped, achievements / hype credit gone); their name becomes "(removed viewer)" in
  // log lines about them. Past season summaries keep it. If they !join again they start afresh.
  // -> { ok, message, username, released }
  function removePlayer(username) {
    const s = cur();
    const refused = raceGuard(s, 'remove a viewer');
    if (refused) return refused;
    const key = SD.players ? SD.players.keyOf(username) : '';
    const p = key && SD.players.get(s, key);
    if (!p) return fail('No viewer called "' + String(username == null ? '' : username).slice(0, 30) + '" has joined.');
    let res;
    const shown = p.displayName || key;
    commit('player:remove', function (st, emit) {
      res = removeOne(st, key, { scrub: true }, emit);
      SD.state.log('player', 'The streamer removed a viewer from the derby' + (res.released.length ? ' (their runner is free again).' : '.'), 'info');
    });
    saveNow();
    return { ok: true, message: shown + ' was removed from the derby.', username: key, released: res.released };
  }

  // The demo bots' clean-up (review batch 8, gap1#2/#3): every '~' player (SD.players.isDemoKey) is
  // removed and the runners the bots created (runtime.demoRunners this session; runner.demo, which is
  // saved, after a reload or an import) are deleted unless a real viewer owns them now. Called when the bots stop and by afterLoad (the bots never survive a reload,
  // so a '~' player in a loaded save is a leftover). Refused while a race exists: the chat panel
  // calls it again when the race ends. -> { ok, removed: [keys], runners: [ids], pending? }
  function purgeDemo() {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    const keys = Object.keys(s.players || {}).filter(function (k) { return SD.players && SD.players.isDemoKey(k); });
    const made = SD.state.runtime.demoRunners || {};
    const botMade = function (r) { return r.custom && (U.hasOwn(made, r.id) || r.demo === true); };
    const realOwner = function (r) { return !!(r.ownerKey && !SD.players.isDemoKey(r.ownerKey)); };
    const runners = s.runners.filter(function (r) { return botMade(r) && !realOwner(r); });
    // A bot-made runner a real viewer owns now stays in the game for good: it loses the bot mark.
    const adopted = s.runners.filter(function (r) { return r.demo === true && realOwner(r); });
    if (!keys.length && !runners.length && !adopted.length) return { ok: true, removed: [], runners: [] };
    if (s.currentRace && (keys.length || runners.length)) return fail('The demo bots are cleaned up after the current race.', { pending: true });
    const removed = [], deleted = [];
    commit('demo:purge', function (st, emit) {
      adopted.forEach(function (r) { delete r.demo; });
      if (!keys.length && !runners.length) return;
      keys.sort().forEach(function (k) { if (removeOne(st, k, { demo: true }, emit)) removed.push(k); });
      runners.forEach(function (r) {
        detachRunner(st, r);
        st.runners = st.runners.filter(function (x) { return x !== r; });
        deleted.push(r.id);
        emit(SD.EVENTS.RUNNER_RETIRED, { runnerId: r.id, name: r.name, deleted: true, refunded: null, demo: true });
      });
      SD.state.log('system', 'The demo bots left: ' + plural(removed.length, 'bot profile') + ' removed' +
        (deleted.length ? ' and ' + plural(deleted.length, 'bot-made runner') + ' deleted' : '') + '. Their runners are free again.', 'info');
    });
    saveNow();
    return { ok: true, removed: removed, runners: deleted };
  }

  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  // A season rollover's events. Season Champion is awarded here, inside the commit and before
  // season:ended goes out, so the summary (and its season.history entry) already count it when the
  // summary modal renders on season:ended; its achievement:unlocked is announced after season:started.
  function emitSeasonEnd(st, summary, season, emit) {
    const later = SD.achievements && typeof SD.achievements.awardSeasonChampion === 'function'
      ? SD.achievements.awardSeasonChampion(st, summary) : [];
    emit(SD.EVENTS.SEASON_ENDED, { summary: summary });
    emit(SD.EVENTS.SEASON_STARTED, { season: season });
    later.forEach(function (a) { emit(SD.EVENTS.ACHIEVEMENT_UNLOCKED, a); });
  }

  function emitDayInfo(st, info, emit) {
    if (info.seasonEnded) emitSeasonEnd(st, info.summary, info.season, emit);
    emit(SD.EVENTS.SEASON_DAY_ADVANCED, info);
    if (info.dayEvent) emit(SD.EVENTS.EVENT_DAY, { event: info.dayEvent, manual: false });
  }

  function nextDay() {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    if (s.currentRace) return fail('Finish the current race before starting a new day.');
    let info;
    commit('season:nextDay', function (st, emit) {
      info = SD.seasons.advanceDay(st, actionRng(st, 'day'));
      emitDayInfo(st, info, emit);
    });
    saveNow();
    return Object.assign({ ok: true, message: info.seasonEnded ? 'Season ' + (info.season - 1) + ' ended. Season ' + info.season + ' begins!'
      : 'Day ' + info.day + ' begins: ' + info.dayEvent.name + '.' }, info);
  }

  function resetDay() {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    if (s.currentRace) return fail('Finish the current race before resetting the day.');
    let info;
    commit('season:resetDay', function (st, emit) {
      info = SD.seasons.resetDay(st);
      emit(SD.EVENTS.SEASON_DAY_ADVANCED, Object.assign({ reset: true, seasonEnded: false }, info));
    });
    saveNow();
    return Object.assign({ ok: true, message: 'Day reset: race slots and energy restored.' }, info);
  }

  function resetSeason() {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    if (s.currentRace) return fail('Finish the current race before resetting the season.');
    let summary, started;
    commit('season:reset', function (st, emit) {
      summary = SD.seasons.endSeason(st);
      started = SD.seasons.startSeason(st, actionRng(st, 'season'));
      emitSeasonEnd(st, summary, started.season, emit);
      emit(SD.EVENTS.EVENT_DAY, { event: started.dayEvent, manual: false });
    });
    saveNow();
    return { ok: true, message: 'Season ' + summary.number + ' archived. Season ' + started.season + ' begins!', summary: summary };
  }

  // Wipe everything and start a brand-new game. Review batch 8 (ui-admin-chat-dom#1): the game being
  // wiped is first copied to spiritderby.backup (SD.persistence.backupCurrent, unless it is blank), so a
  // mistaken RESET ALL can be undone with RESTORE BACKUP. -> { ok, message, backedUp }
  function resetAll() {
    const s = cur();
    if (s && s.currentRace) SD.bus.emit(SD.EVENTS.RACE_ABORTED, { recordId: s.currentRace.record.id, refunded: 0, reset: true });
    const backedUp = !!(SD.persistence && typeof SD.persistence.backupCurrent === 'function' && SD.persistence.backupCurrent());
    if (SD.persistence) SD.persistence.clear();
    SD.state.set(SD.state.create());
    // Review batch 7 (director-state#3): every per-game runtime map is cleared (nervous cheers, rest
    // cooldowns, activity, recent hype ... used to carry over to the new game's r01, r02 ...).
    afterLoad({ resetRuntime: true });
    SD.state.log('system', 'A brand new Spirit Derby begins!', 'epic');
    saveNow();
    SD.bus.emit(SD.EVENTS.STATE_LOADED, { source: 'reset' });
    SD.bus.emit(SD.EVENTS.STATE_CHANGED, { label: 'resetAll' });
    return {
      ok: true, backedUp: backedUp,
      message: 'Everything was reset. Welcome to a brand new Spirit Derby!' + (backedUp ? ' (The old game was kept as the backup: RESTORE BACKUP brings it back.)' : '')
    };
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  function num(v, lo, hi, integer) {
    const n = Number(v);
    if (v === '' || v === null || !isFinite(n)) return undefined;
    const c = U.clamp(n, lo, hi);
    return integer ? Math.round(c) : c;
  }
  function bool(v) {
    if (v === true || v === false) return v;
    if (v === 'true' || v === 1 || v === '1' || v === 'on') return true;
    if (v === 'false' || v === 0 || v === '0' || v === 'off') return false;
    return undefined;
  }
  // No prototype (SD.util.dict): 'constructor' / 'toString' / '__proto__' are unknown keys, not validators.
  const SETTING_VALIDATORS = U.dict({
    distance: function (v) { return SD.CONFIG.RACE.DISTANCES.indexOf(Number(v)) >= 0 ? Number(v) : undefined; },
    runnerCount: function (v) { return num(v, SD.CONFIG.RACE.MIN_RUNNERS, SD.CONFIG.RACE.MAX_RUNNERS, true); },
    eventFrequency: function (v) { return Object.prototype.hasOwnProperty.call(SD.CONFIG.RACE.EVENTS.SLIDER, v) ? v : undefined; },
    hypeMultiplier: function (v) { return num(v, 0, 5); },
    playbackSpeed: function (v) { return num(v, 0.25, 8); },
    finalStretchSpeedup: function (v) { return num(v, 1, 4); },
    userCooldownS: function (v) { return num(v, 0, 3600, true); },
    resultsAutoCloseMs: function (v) { return num(v, 0, 600000, true); },
    openTraining: bool,
    allowCreate: bool,
    autoAdvanceDay: bool,
    debug: bool,
    overlay: bool,
    seedOverride: function (v) {
      if (v === null || v === '' || v === undefined) return null;
      const n = Number(v);
      return isFinite(n) ? (n >>> 0) : undefined;
    },
    twitch: function (v, prev) {
      if (!v || typeof v !== 'object') return undefined;
      const out = Object.assign({}, prev);
      if ('channel' in v) out.channel = String(v.channel || '').toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_]/g, '').slice(0, 25);
      if ('enabled' in v && bool(v.enabled) !== undefined) out.enabled = bool(v.enabled);
      return out;
    },
    bridge: function (v, prev) {
      if (!v || typeof v !== 'object') return undefined;
      const out = Object.assign({}, prev);
      if ('url' in v) {
        const url = String(v.url || '').trim();
        if (url && !/^wss?:\/\//i.test(url)) return undefined;
        out.url = url;
      }
      if ('enabled' in v && bool(v.enabled) !== undefined) out.enabled = bool(v.enabled);
      return out;
    }
  });

  // Validates each key; unknown / invalid keys are rejected (and reported).
  function updateSettings(patch) {
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    if (!patch || typeof patch !== 'object') return fail('Settings patch must be an object.');
    const applied = {}, rejected = [];
    Object.keys(patch).forEach(function (k) {
      const vfn = SETTING_VALIDATORS[k];
      const val = vfn ? vfn(patch[k], s.settings[k]) : undefined;
      if (val === undefined) rejected.push(k); else applied[k] = val;
    });
    if (Object.keys(applied).length) {
      commit('settings', function (st, emit) {
        Object.assign(st.settings, applied);
        emit(SD.EVENTS.SETTINGS_CHANGED, { patch: applied, settings: st.settings });
      });
    }
    return {
      ok: rejected.length === 0, settings: s.settings, applied: applied, rejected: rejected,
      message: rejected.length ? 'Invalid setting(s): ' + rejected.join(', ') : 'Settings saved.'
    };
  }

  // ---------------------------------------------------------------------------
  // Clock (UI calls every CONFIG.CLOCK_INTERVAL_MS)
  // ---------------------------------------------------------------------------
  function tickClock() {
    const s = cur();
    if (!s) return { changed: [], elapsedMs: 0 };
    const rt = SD.state.runtime;
    const now = SD.clock.now();
    const last = rt.lastClockAt == null ? now - SD.CONFIG.CLOCK_INTERVAL_MS : rt.lastClockAt;
    const elapsed = U.clamp(now - last, 0, SD.CONFIG.CLOCK_MAX_ELAPSED_MS);
    rt.lastClockAt = now;
    if (elapsed <= 0) return { changed: [], elapsedMs: 0 };
    let changed = [];
    commit('clock', function (st, emit) {
      const condBefore = {};
      st.runners.forEach(function (r) { condBefore[r.id] = r.condition; });
      const hypeBefore = st.hype.value;
      changed = SD.training.tickClock(st, elapsed);
      SD.hype.idleDecay(st, elapsed);
      // Review batch 6: a tick that changed nothing saves nothing (a window left open "just to look"
      // used to rewrite the whole save every 30 s); energy regen / hype decay is saved lazily.
      SD.state.saveHint(changed.length || st.hype.value !== hypeBefore ? 'lazy' : 'none');
      changed.forEach(function (id) {
        const r = SD.state.runnerById(id, st);
        if (r && r.condition !== condBefore[id]) emit(SD.EVENTS.RUNNER_CONDITION, { runnerId: id, from: condBefore[id], to: r.condition });
      });
    });
    return { changed: changed, elapsedMs: elapsed };
  }

  SD.game = {
    init: init,
    afterLoad: afterLoad,
    applyPending: applyPending,
    startRace: startRace,
    setRaceStatus: setRaceStatus,
    pauseRace: pauseRace,
    resumeRace: resumeRace,
    endRace: endRace,
    finishRace: finishRace,
    abortRace: abortRace,
    trainRunner: trainRunner,
    restRunner: restRunner,
    triggerDayEvent: triggerDayEvent,
    addHype: addHype,
    spawnRunner: spawnRunner,
    retireRunner: retireRunner,
    deleteRunner: deleteRunner,
    renameRunner: renameRunner,
    removePlayer: removePlayer,
    purgeDemo: purgeDemo,
    nextDay: nextDay,
    resetDay: resetDay,
    resetSeason: resetSeason,
    resetAll: resetAll,
    updateSettings: updateSettings,
    tickClock: tickClock,
    seedForRace: seedForRace,
    previewField: previewField,
    raceEffectsFor: raceEffectsFor,
    replayLastRace: replayLastRace,
    replayInputs: replayInputs,
    resolveRunner: resolveRunner,
    commit: commit
  };
})(globalThis.SD = globalThis.SD || {});
