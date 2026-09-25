/* SPIRIT DERBY — ui/playback.js
 * RaceRecord → animation frames. No DOM access: it only reads SD.state / SD.CONFIG,
 * drives a requestAnimationFrame loop (timer fallback while the tab is hidden) and
 * emits race:* events on SD.bus. It never mutates game state except the contracted
 * SD.game.setRaceStatus('running') call when the countdown ends.
 *
 * Emits: race:countdown { secondsLeft }            3, 2, 1 then 0 (= GO)
 *        race:frame { tickFloat, tick, phase, distance, totalTicks, runners:[{ id, lane, d, progress, rank, v, st, fx }], finished:[ids], leaderD, recordId }
 *        race:tick { tick, data }                  on every integer tick crossed
 *        race:phase { phase, tick }                when the leader phase changes
 *        race:event <record event>                 each record event whose tick was crossed (hidden ones too)
 *        race:runnerFinished { runnerId, place, timeSec, finishTick }
 *        race:playbackDone { recordId }            after the finish hold
 * Listens: race:started → load+play, race:paused → pause, race:resumed → resume,
 *          race:endRequested → finish, race:aborted → stop, race:finished → stop (if still running).
 */
(function (SD) {
  'use strict';

  function evName(key, fallback) { return (SD.EVENTS && SD.EVENTS[key]) || fallback; }
  const N = {
    started: evName('RACE_STARTED', 'race:started'),
    countdown: evName('RACE_COUNTDOWN', 'race:countdown'),
    frame: evName('RACE_FRAME', 'race:frame'),
    tick: evName('RACE_TICK', 'race:tick'),
    phase: evName('RACE_PHASE', 'race:phase'),
    event: evName('RACE_EVENT', 'race:event'),
    runnerFinished: evName('RACE_RUNNER_FINISHED', 'race:runnerFinished'),
    paused: evName('RACE_PAUSED', 'race:paused'),
    resumed: evName('RACE_RESUMED', 'race:resumed'),
    endRequested: evName('RACE_END_REQUESTED', 'race:endRequested'),
    playbackDone: evName('RACE_PLAYBACK_DONE', 'race:playbackDone'),
    finished: evName('RACE_FINISHED', 'race:finished'),
    aborted: evName('RACE_ABORTED', 'race:aborted')
  };

  const DEFAULT_TPS = { START: 3, EARLY: 5, MID: 6, FINAL_TURN: 7, FINAL_STRETCH: 9 };
  const DEFAULT_COUNTDOWN_S = 3;
  const DEFAULT_HOLD_MS = 1500;

  // ------------------------------------------------------------------ helpers
  function pcfg() { return (SD.CONFIG && SD.CONFIG.PLAYBACK) || {}; }
  function settings() {
    try { return (SD.state && SD.state.get && SD.state.get().settings) || {}; } catch (e) { return {}; }
  }
  function num(v, fb) { v = Number(v); return isFinite(v) ? v : fb; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, f) { a = num(a, 0); b = num(b, a); return a + (b - a) * f; }
  function emit(name, payload) { if (SD.bus && typeof SD.bus.emit === 'function') SD.bus.emit(name, payload); }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  // Reading visibility only (no DOM manipulation): hidden tabs throttle rAF, so fall back to timers.
  function isHidden() { return typeof document !== 'undefined' && !!document.hidden; }
  const hasRaf = typeof requestAnimationFrame === 'function';

  // ------------------------------------------------------------------ playback state
  let rec = null;            // RaceRecord
  let mode = 'idle';         // idle | loaded | countdown | running | hold | done
  let paused = false;
  let cursor = 0;            // float tick
  let lastInt = -1;          // last integer tick processed (crossings emitted)
  let events = [];           // record.events stably sorted by tick
  let evIdx = 0;
  let finishOrder = [];      // record.results sorted by place
  let finishedSet = {};
  let finishedIds = [];
  let lastPhase = null;
  let laneOf = {};
  let placeOf = {};
  let distance = 0;
  let cdLeft = 0;
  let cdShown = null;
  let holdLeft = 0;
  let speedMult = 1;
  let lastTs = 0;
  let rafId = 0;
  let timerId = 0;
  let frame = null;

  function lastTick() { return rec && rec.ticks && rec.ticks.length ? rec.ticks.length - 1 : 0; }
  function tickAt(i) { return rec.ticks[clamp(i, 0, lastTick())]; }

  // ------------------------------------------------------------------ loop
  function cancelLoop() {
    if (rafId && hasRaf) cancelAnimationFrame(rafId);
    if (timerId) clearTimeout(timerId);
    rafId = 0; timerId = 0;
  }
  function active() { return !paused && (mode === 'countdown' || mode === 'running' || mode === 'hold'); }
  function scheduleNext() {
    if (rafId || timerId || !active()) return;
    if (hasRaf && !isHidden()) {
      rafId = requestAnimationFrame(onRaf);
      timerId = setTimeout(onTimer, 250);   // backstop if the tab gets hidden mid-wait
    } else {
      timerId = setTimeout(onTimer, 100);
    }
  }
  function onRaf() { rafId = 0; if (timerId) { clearTimeout(timerId); timerId = 0; } step(); }
  function onTimer() { timerId = 0; if (rafId && hasRaf) { cancelAnimationFrame(rafId); rafId = 0; } step(); }

  function step() {
    const t = now();
    let dt = (t - lastTs) / 1000;
    lastTs = t;
    if (!(dt > 0)) dt = 0;
    // Clamp: CONFIG.PLAYBACK.MAX_FRAME_DT_MS (100 ms) while hidden (timer-driven),
    // 250 ms otherwise (absorbs a janky frame without teleporting runners).
    dt = Math.min(dt, isHidden() ? num(pcfg().MAX_FRAME_DT_MS, 100) / 1000 : 0.25);
    if (active()) {
      try { advance(dt); } catch (e) { console.error('[playback] step failed', e); }
    }
    scheduleNext();
  }

  function tps(phase) {
    const table = Object.assign({}, DEFAULT_TPS, pcfg().TPS || {});
    const s = settings();
    let v = num(table[phase], NaN);
    if (!isFinite(v)) v = phase === 'FINISH' ? num(table.FINAL_STRETCH, 14) : 8;
    v *= num(s.playbackSpeed, 1) || 1;
    // FINISH = leader already home, rest still in their final stretch → keep the stretch speed.
    if (phase === 'FINAL_STRETCH' || phase === 'FINISH') v *= num(s.finalStretchSpeedup, num(pcfg().FINAL_STRETCH_SPEEDUP, 1.25)) || 1;
    v *= speedMult;
    return Math.max(0.25, v);
  }

  function advance(dt) {
    if (mode === 'countdown') {
      if (cdShown === null) {                   // first frame: show "3" and the start line
        cdShown = Math.max(1, Math.ceil(cdLeft));
        emit(N.countdown, { secondsLeft: cdShown });
        emitFrame();
        return;
      }
      cdLeft -= dt;
      if (cdLeft <= 0) {
        emit(N.countdown, { secondsLeft: 0 });
        goRunning();
        return;
      }
      const n = Math.ceil(cdLeft);
      if (n < cdShown) { cdShown = n; emit(N.countdown, { secondsLeft: n }); }
      return;
    }
    if (mode === 'running') {
      const L = lastTick();
      const phase = tickAt(Math.floor(cursor)).phase;
      cursor = Math.min(L, cursor + dt * tps(phase));
      processTo(Math.floor(cursor));
      emitFrame();
      if (cursor >= L) enterHold();
      return;
    }
    if (mode === 'hold') {
      holdLeft -= dt;
      emitFrame();
      if (holdLeft <= 0) {
        mode = 'done';
        cancelLoop();
        emit(N.playbackDone, { recordId: rec && rec.id });
      }
    }
  }

  function setStatusRunning() {
    try {
      const s = SD.state && SD.state.get && SD.state.get();
      const st = s && s.currentRace && s.currentRace.status;
      if (st === 'countdown' && SD.game && typeof SD.game.setRaceStatus === 'function') SD.game.setRaceStatus('running');
    } catch (e) { console.error('[playback] setRaceStatus failed', e); }
  }

  function goRunning() {
    mode = 'running';
    setStatusRunning();
    processTo(0);           // tick 0 = starting line: emits START phase + tick-0 events
    emitFrame();
  }

  /** Emit every integer-tick crossing up to target (inclusive), in order. */
  function processTo(target) {
    if (!rec) return;
    target = Math.min(target, lastTick());
    while (lastInt < target) {
      lastInt++;
      const tk = rec.ticks[lastInt];
      emit(N.tick, { tick: lastInt, data: tk });
      if (tk && tk.phase !== lastPhase) {
        lastPhase = tk.phase;
        emit(N.phase, { phase: tk.phase, tick: lastInt });
      }
      while (evIdx < events.length && num(events[evIdx].tick, 0) <= lastInt) {
        emit(N.event, events[evIdx]);
        evIdx++;
      }
      for (let k = 0; k < finishOrder.length; k++) {
        const r = finishOrder[k];
        if (!finishedSet[r.runnerId] && isFinite(Number(r.finishTick)) && Number(r.finishTick) <= lastInt) markFinished(r);
      }
    }
  }

  function markFinished(r) {
    finishedSet[r.runnerId] = true;
    finishedIds.push(r.runnerId);
    emit(N.runnerFinished, { runnerId: r.runnerId, place: r.place, timeSec: r.timeSec, finishTick: r.finishTick });
  }

  function enterHold() {
    processTo(lastTick());
    while (evIdx < events.length) { emit(N.event, events[evIdx]); evIdx++; }   // anything stamped past the last tick
    finishOrder.forEach(function (r) { if (!finishedSet[r.runnerId]) markFinished(r); });
    mode = 'hold';
    holdLeft = num(pcfg().FINISH_HOLD_MS, DEFAULT_HOLD_MS) / 1000;
    emitFrame();
  }

  // ------------------------------------------------------------------ frames
  function findPos(tk, id) {
    const arr = (tk && tk.pos) || [];
    for (let i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function computeFrame() {
    if (!rec || !rec.ticks || !rec.ticks.length) return null;
    const L = lastTick();
    const i0 = Math.min(Math.floor(cursor), L);
    const i1 = Math.min(i0 + 1, L);
    const f = clamp(cursor - i0, 0, 1);
    const t0 = rec.ticks[i0];
    const t1 = rec.ticks[i1];
    let leaderD = 0;
    const runners = (t0.pos || []).map(function (p0, k) {
      let p1 = t1.pos && t1.pos[k];
      if (!p1 || p1.id !== p0.id) p1 = findPos(t1, p0.id) || p0;
      const d = Math.min(distance, lerp(p0.d, p1.d, f));
      if (d > leaderD) leaderD = d;
      return {
        id: p0.id,
        lane: laneOf[p0.id] || k + 1,
        d: d,
        progress: distance > 0 ? clamp(d / distance, 0, 1) : 0,
        rank: p0.rank,
        v: lerp(p0.v, p1.v, f),
        st: clamp(lerp(p0.st, p1.st, f), 0, 1),
        fx: p0.fx || []
      };
    });
    // Live rank from interpolated distance: finished runners by place, others by d (ties by lane).
    const eps = 1e-6;
    runners.slice().sort(function (a, b) {
      const ad = a.d >= distance - eps;
      const bd = b.d >= distance - eps;
      if (ad && bd) return (placeOf[a.id] || 99) - (placeOf[b.id] || 99);
      if (ad !== bd) return ad ? -1 : 1;
      if (b.d !== a.d) return b.d - a.d;
      return a.lane - b.lane;
    }).forEach(function (r, i) { r.rank = i + 1; });

    return {
      recordId: rec.id,
      tickFloat: cursor,
      tick: i0,
      phase: t0.phase,
      distance: distance,
      totalTicks: L,
      leaderD: leaderD,
      runners: runners,
      finished: finishedIds.slice(),
      mode: mode,
      paused: paused
    };
  }

  function emitFrame() {
    frame = computeFrame();
    if (frame) emit(N.frame, frame);
  }

  // ------------------------------------------------------------------ public API
  function load(record, opts) {
    stop();
    if (!record || !Array.isArray(record.ticks) || !record.ticks.length) {
      console.error('[playback] record has no ticks', record);
      return false;
    }
    opts = opts || {};
    rec = record;
    distance = num(rec.distance, 0);
    if (!(distance > 0)) {
      rec.ticks.forEach(function (tk) { (tk.pos || []).forEach(function (p) { if (p.d > distance) distance = p.d; }); });
    }
    events = (rec.events || []).map(function (e, i) { return { e: e, i: i }; })
      .sort(function (a, b) { return (num(a.e.tick, 0) - num(b.e.tick, 0)) || (a.i - b.i); })
      .map(function (x) { return x.e; });
    laneOf = {};
    (rec.entrants || []).forEach(function (en) { laneOf[en.runnerId] = en.lane; });
    finishOrder = (rec.results || []).slice().sort(function (a, b) { return num(a.place, 99) - num(b.place, 99); });
    placeOf = {};
    finishOrder.forEach(function (r) { placeOf[r.runnerId] = r.place; });
    cursor = 0; lastInt = -1; evIdx = 0;
    finishedSet = {}; finishedIds = []; lastPhase = null;
    paused = false; holdLeft = 0;
    cdLeft = num(opts.countdownS, num(pcfg().COUNTDOWN_S, DEFAULT_COUNTDOWN_S));
    cdShown = null;
    mode = 'loaded';
    frame = computeFrame();
    return true;
  }

  function play() {
    if (!rec) return;
    if (mode === 'loaded') {
      mode = cdLeft > 0 ? 'countdown' : 'running';
      paused = false;
      lastTs = now();
      if (mode === 'running') goRunning();
      scheduleNext();
      return;
    }
    if (paused) resume();
  }

  function pause() {
    if (!rec || paused) return;
    paused = true;
    cancelLoop();
  }

  function resume() {
    if (!rec || !paused) return;
    paused = false;
    lastTs = now();
    scheduleNext();
  }

  /** Jump to the last tick, emit everything not yet emitted, then playbackDone after the hold. */
  function finish() {
    if (!rec || mode === 'idle' || mode === 'hold' || mode === 'done') return;
    paused = false;
    if (mode === 'loaded' || mode === 'countdown') {
      emit(N.countdown, { secondsLeft: 0, skipped: true });
      mode = 'running';
    }
    cursor = lastTick();
    enterHold();
    lastTs = now();
    cancelLoop();
    scheduleNext();
  }

  function stop() {
    cancelLoop();
    rec = null;
    mode = 'idle';
    paused = false;
    frame = null;
    cursor = 0;
  }

  /** Debug seek. Forward seeks emit the crossed ticks/events; backward seeks rewind silently. */
  function seek(tick) {
    if (!rec || mode === 'idle' || mode === 'done') return;
    const L = lastTick();
    const target = clamp(num(tick, 0), 0, L);
    if (mode === 'loaded' || mode === 'countdown') {
      emit(N.countdown, { secondsLeft: 0, skipped: true });
      mode = 'running';
      setStatusRunning();
    }
    if (target >= cursor) {
      cursor = target;
      processTo(Math.floor(cursor));
    } else {
      cursor = target;
      lastInt = Math.floor(target);
      evIdx = 0;
      while (evIdx < events.length && num(events[evIdx].tick, 0) <= lastInt) evIdx++;
      finishedSet = {}; finishedIds = [];
      finishOrder.forEach(function (r) {
        if (isFinite(Number(r.finishTick)) && Number(r.finishTick) <= lastInt) { finishedSet[r.runnerId] = true; finishedIds.push(r.runnerId); }
      });
      lastPhase = tickAt(lastInt).phase;
      if (mode === 'hold') mode = 'running';
    }
    emitFrame();
    if (mode === 'running' && cursor >= L) enterHold();
    lastTs = now();
    scheduleNext();
  }

  function setSpeed(mult) { speedMult = clamp(num(mult, 1), 0.1, 10); }
  function getFrame() { if (!frame && rec) frame = computeFrame(); return frame; }
  function isPlaying() { return !!rec && !paused && (mode === 'countdown' || mode === 'running' || mode === 'hold'); }
  function currentTick() { return cursor; }
  function getMode() { return mode; }
  function isPaused() { return paused; }
  function getRecord() { return rec; }

  SD.playback = {
    load: load, play: play, pause: pause, resume: resume, finish: finish, stop: stop, seek: seek,
    setSpeed: setSpeed, getFrame: getFrame, isPlaying: isPlaying, currentTick: currentTick,
    getMode: getMode, isPaused: isPaused, getRecord: getRecord
  };

  // ------------------------------------------------------------------ bus wiring
  if (SD.bus && typeof SD.bus.on === 'function') {
    SD.bus.on(N.started, function (p) {
      let r = p && p.record;
      if (!r) {
        try { const s = SD.state.get(); r = s && s.currentRace && s.currentRace.record; } catch (e) { r = null; }
      }
      // play() defers its first emission to the next frame, so every race:started listener
      // (track build, panels) runs before countdown/frame events arrive.
      if (r && load(r)) play();
    });
    SD.bus.on(N.paused, function () { pause(); });
    SD.bus.on(N.resumed, function () { resume(); });
    SD.bus.on(N.endRequested, function () { finish(); });
    SD.bus.on(N.aborted, function () { stop(); });
    SD.bus.on(N.finished, function () {
      // Normal path: finishRace() runs inside our playbackDone emit (mode already 'done').
      // If the core finished the race some other way, stop animating a race that no longer exists.
      if (mode !== 'done') stop();
    });
  }
})(globalThis.SD = globalThis.SD || {});
