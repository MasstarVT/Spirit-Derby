/*
 * Spirit Derby - game.js
 * The director. Every public method changes state through SD.state.mutate and emits
 * bus events AFTER the mutation completes (so listeners always see consistent state).
 * UI buttons, the command pipeline and integrations all call these methods.
 *
 * Optional later-milestone modules are called only when present:
 *   SD.betting.lockForRace(state, record) -> refunded[] (startRace: bets on non-starters refunded)
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

  // Deterministic per-action randomness (seedSalt + action counter): no Math.random.
  function actionRng(s, tag) {
    s.meta.actionCounter = (s.meta.actionCounter || 0) + 1;
    return SD.rng.create(SD.rng.seedFrom(s.meta.seedSalt, tag, s.meta.actionCounter));
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
  function init() {
    unsubs.forEach(function (u) { u(); });
    unsubs = [];
    if (!cur()) SD.state.set(SD.state.create());
    unsubs.push(SD.bus.on(SD.EVENTS.RACE_PLAYBACK_DONE, function (p) {
      const cr = cur() && cur().currentRace;
      if (!cr) return;
      if (p && p.recordId && p.recordId !== cr.record.id) return;
      finishRace();
    }));
    const s = cur();
    // A race saved as 'finished' before its results were applied is applied now.
    if (s.currentRace && s.currentRace.status === 'finished') finishRace();
    if (!s.season.activeDayEvent) {
      commit('game:init', function (st) {
        st.season.activeDayEvent = SD.events.rollDayEvent(actionRng(st, 'day')).id;
      });
    }
    SD.state.runtime.lastClockAt = SD.clock.now();
    return { ok: true };
  }

  // Seed for a race number: seedFrom(seedSalt, season, day, raceCounter), or the
  // debug override when settings.debug && settings.seedOverride is set.
  function resolveSeed(s, override, counter) {
    if (override != null && override !== '' && isFinite(Number(override))) return Number(override) >>> 0;
    if (s.settings.debug && s.settings.seedOverride != null && s.settings.seedOverride !== '' &&
        isFinite(Number(s.settings.seedOverride))) {
      return Number(s.settings.seedOverride) >>> 0;
    }
    return SD.rng.seedFrom(s.meta.seedSalt, s.season.number, s.season.day, counter);
  }

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

  // ---------------------------------------------------------------------------
  // Races
  // ---------------------------------------------------------------------------
  function startRace(opts) {
    opts = opts || {};
    const s = cur();
    if (!s) return fail('The game has not been initialised yet.');
    if (s.currentRace) return fail('A race is already in progress. Let it finish (or END / abort it) first.');
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
      const seed = resolveSeed(st, opts.seed, st.meta.raceCounter);
      const fieldRng = SD.rng.create(SD.rng.seedFrom(seed, 'field'));
      const field = fieldRng.shuffle(SD.race.selectField(st, count, fieldRng)); // shuffle = lane draw
      const hype = st.hype.value;

      // Crowd energy rubs off on the runners before the gates open.
      const H = C.HYPE, M = SD.CONFIG.MOOD;
      field.forEach(function (r) {
        if (hype >= H.AWAKENED && fieldRng.chance(M.CHAOTIC_RACE_CHANCE)) SD.runners.setMood(r, 'Chaotic');
        else if (hype >= H.FERAL && fieldRng.chance(M.FIRED_UP_RACE_CHANCE)) SD.runners.setMood(r, 'Fired Up');
      });

      // Queued chat effects for runners in this field are consumed; others stay queued.
      const ids = field.map(function (r) { return r.id; });
      const queued = Array.isArray(st.raceEffects) ? st.raceEffects : [];
      const used = queued.filter(function (e) { return ids.indexOf(e.runnerId) >= 0; });
      st.raceEffects = queued.filter(function (e) { return ids.indexOf(e.runnerId) < 0; });
      const chatEffects = [];
      const cheerBonus = {};
      // Viewers are stored by username key; the race shows their display names.
      const shownName = function (by) {
        const p = by && st.players ? st.players[String(by).toLowerCase()] : null;
        return p && p.displayName ? p.displayName : (by || 'chat');
      };
      used.forEach(function (e) {
        if (e.type === 'cheer') {
          cheerBonus[e.runnerId] = (cheerBonus[e.runnerId] || 0) + Math.max(1, e.count || 1);
          // Also passed to the engine so the cheer shows up as a 'chat' line with the viewer's name.
          chatEffects.push({ runnerId: e.runnerId, type: 'cheer', by: shownName(e.by), count: Math.max(1, e.count || 1) });
        } else if (e.type === 'boost' || e.type === 'sabotage') {
          for (let k = 0; k < Math.max(1, e.count || 1); k++) chatEffects.push({ runnerId: e.runnerId, type: e.type, by: shownName(e.by) });
        }
      });

      const dayEvent = SD.events.dayEventById(st.season.activeDayEvent);
      const entrants = SD.race.buildEntrants(field, { distance: distance, hypeLevel: hype, dayEvent: dayEvent, cheerBonus: cheerBonus });
      const active = SD.state.activeRunners(st);
      const rosterAvgLevel = active.reduce(function (a, r) { return a + r.level; }, 0) / Math.max(1, active.length);
      const trackName = fieldRng.pick(SD.DATA.TRACK_NAMES);
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
      // Bets on runners that did not make the field are refunded at the gate; the rest are locked in.
      if (SD.betting && typeof SD.betting.lockForRace === 'function') SD.betting.lockForRace(st, record);

      const fav = record.entrants.slice().sort(function (a, b) { return a.odds - b.odds; })[0];
      const message = 'Race ' + indexInDay + '/' + st.season.racesPerDay + ' at ' + trackName + ' (' + distance + ' m): ' +
        record.entrants.map(function (e) { return e.name; }).join(', ') + '. Favourite: ' + fav.name + ' at ' + fav.odds + 'x.';
      SD.state.log('race', message, 'info', { recordId: record.id });
      emit(SD.EVENTS.RACE_STARTED, { record: record });
      return { ok: true, message: message, record: record };
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
        rec.bestTimes = rec.bestTimes || {};
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
        (summary.upset ? ', a ' + summary.upsetOdds + 'x upset' : '') + '!', 'epic', { recordId: record.id });
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
      if (dayInfo) emitDayInfo(dayInfo, emit);
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
      SD.state.log('race', 'The race at ' + record.trackName + ' was cancelled' +
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

  // Spawn a random runner from a species template. opts: { name, speciesId, style, owner }
  function spawnRunner(opts) {
    opts = opts || {};
    const s = cur();
    if (!s) return null;
    let runner = null;
    commit('runner:spawn', function (st, emit) {
      const rng = actionRng(st, 'spawn');
      runner = SD.runners.spawnRandom(rng, {
        name: opts.name, speciesId: opts.speciesId, style: opts.style, abilityId: opts.abilityId, id: SD.runners.nextId(st)
      });
      // Names must be unique (case / punctuation-insensitive).
      const baseName = runner.name.slice(0, SD.CONFIG.NAMES.MAX_LEN - 3);
      let k = 2;
      while (st.runners.some(function (r) { return U.nameKey(r.name) === U.nameKey(runner.name); })) runner.name = baseName + ' ' + (k++);
      if (opts.owner) {
        runner.owner = String(opts.owner);
        runner.claimedAt = SD.clock.now();
      }
      st.runners.push(runner);
      SD.state.log('runner', 'A new runner joins the derby: ' + runner.emoji + ' ' + runner.name + ', a ' + runner.species + ' (' +
        SD.runners.styleName(runner.style) + ').', 'good', { runnerId: runner.id });
      emit(SD.EVENTS.RUNNER_SPAWNED, { runner: runner, by: opts.owner || null });
    });
    return runner;
  }

  function emitDayInfo(info, emit) {
    if (info.seasonEnded) {
      emit(SD.EVENTS.SEASON_ENDED, { summary: info.summary });
      emit(SD.EVENTS.SEASON_STARTED, { season: info.season });
    }
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
      emitDayInfo(info, emit);
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
      emit(SD.EVENTS.SEASON_ENDED, { summary: summary });
      emit(SD.EVENTS.SEASON_STARTED, { season: started.season });
      emit(SD.EVENTS.EVENT_DAY, { event: started.dayEvent, manual: false });
    });
    saveNow();
    return { ok: true, message: 'Season ' + summary.number + ' archived. Season ' + started.season + ' begins!', summary: summary };
  }

  // Wipe everything and start a brand-new game.
  function resetAll() {
    const s = cur();
    if (s && s.currentRace) SD.bus.emit(SD.EVENTS.RACE_ABORTED, { recordId: s.currentRace.record.id, refunded: 0, reset: true });
    if (SD.persistence) SD.persistence.clear();
    SD.state.set(SD.state.create());
    const rt = SD.state.runtime;
    rt.cooldowns = {};
    rt.runnerCooldowns = {};
    rt.hypeIdleAccumMs = 0;
    rt.lastClockAt = SD.clock.now();
    SD.state.log('system', 'A brand new Spirit Derby begins!', 'epic');
    saveNow();
    SD.bus.emit(SD.EVENTS.STATE_LOADED, { source: 'reset' });
    SD.bus.emit(SD.EVENTS.STATE_CHANGED, { label: 'resetAll' });
    return { ok: true, message: 'Everything was reset. Welcome to a brand new Spirit Derby!' };
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
  const SETTING_VALIDATORS = {
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
  };

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
      changed = SD.training.tickClock(st, elapsed);
      SD.hype.idleDecay(st, elapsed);
      changed.forEach(function (id) {
        const r = SD.state.runnerById(id, st);
        if (r && r.condition !== condBefore[id]) emit(SD.EVENTS.RUNNER_CONDITION, { runnerId: id, from: condBefore[id], to: r.condition });
      });
    });
    return { changed: changed, elapsedMs: elapsed };
  }

  SD.game = {
    init: init,
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
    nextDay: nextDay,
    resetDay: resetDay,
    resetSeason: resetSeason,
    resetAll: resetAll,
    updateSettings: updateSettings,
    tickClock: tickClock,
    seedForRace: seedForRace,
    previewField: previewField,
    replayLastRace: replayLastRace,
    replayInputs: replayInputs,
    resolveRunner: resolveRunner,
    commit: commit
  };
})(globalThis.SD = globalThis.SD || {});
