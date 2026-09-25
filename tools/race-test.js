#!/usr/bin/env node
/*
 * Spirit Derby - tools/race-test.js
 * M4 verification of the advanced race systems (plan sections 5.1, 6.1, 6.5, 6.6, 12).
 * Everything runs headless on the real engine with fixed seeds, so results are deterministic.
 *
 *   node tools/race-test.js [--verbose]
 *
 * Sections (each prints a short table, then asserts):
 *   A  distances: ticks per distance and the playback duration estimate (CONFIG.PLAYBACK.TPS)
 *   B  abilities: activations per 100 races for all 10, plus the mechanics behind each one
 *      (Thunder Step overtakes, Hedge Hop redirects, Second Wind at 2400 m, Long Night scales
 *      with stamina, Afterglow with runners ahead, Forest's Favor 3rd-5th, Comet Tail, ...)
 *   C  race events: all 16 fire, frequency settings scale monotonically, per-race caps,
 *      min gap, no runner gets two negatives within NEG_COOLDOWN; one sample message each
 *   D  hype tiers: >=25 noise x1.10, >=50 events x1.5 + crits x1.25, >=100 Forest Awakened
 *      exactly once (+ pool restore, last-place lift, SP x1.5)
 *   E  condition / mood: bands, race-day stat multiplier, passive clock, mood after a race
 *      by place, after training crit / fail, after rest
 *   F  chat effects: boost / sabotage / cheer show up as 'chat' events with the viewer's
 *      name and fx tags; backfire chance uses the target's Wisdom; per-race caps
 *   G  photo finish / upset flags and the +15 hype each in SD.game.finishRace
 *   H  replay: SD.game.replayLastRace() and record.inputs reproduce the hash
 *   I  day events: >= 6, and every modifier really changes the race
 * Exit code 1 on failure.
 */
'use strict';

const SD = require('./load-core.js');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;

// -----------------------------------------------------------------------------
// Assert helper (same output shape as parser-test.js so run-tests.js can tally it)
// -----------------------------------------------------------------------------
let passed = 0, failed = 0, currentSection = '';
const failures = [];
function section(title) { currentSection = title; console.log('\n' + title); }
function ok(cond, name, detail) {
  if (cond) {
    passed++;
    if (VERBOSE) console.log('  PASS ' + name + (detail !== undefined ? '  (' + detail + ')' : ''));
  } else {
    failed++;
    const line = name + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '');
    failures.push(currentSection + ' > ' + line);
    console.log('  FAIL ' + line);
  }
  return !!cond;
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  return ok(a === e, name, 'expected ' + e + ', got ' + a);
}
const pad = function (s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
const lpad = function (s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const pct = function (x) { return (x * 100).toFixed(1) + '%'; };
const line = function (s) { console.log('  ' + s); };

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------
const C = SD.CONFIG.RACE;
const D = C.DISTANCES;
const AB = SD.DATA.ABILITIES;
const ROSTER = SD.DATA.ROSTER.map(function (e, i) { return SD.runners.spawnFromRoster(e, i); });
const byKey = {};
ROSTER.forEach(function (r) { byKey[r.rosterKey] = r; });
const ID = {
  moss: byKey.mossRunner.id, moon: byKey.moonhoof.id, thunder: byKey.thunderFern.id, ember: byKey.emberTail.id,
  comet: byKey.velvetComet.id, misty: byKey.mistyGale.id, copper: byKey.copperBloom.id, lantern: byKey.nightLantern.id,
  bramble: byKey.brambleJack.id, wisp: byKey.glowWisp.id
};

function sim(field, o) {
  o = o || {};
  const distance = o.distance || 1600;
  const entrants = SD.race.buildEntrants(field, { distance: distance, hypeLevel: o.hype || 0, dayEvent: o.dayEvent || null });
  return SD.race.simulate({
    seed: o.seed >>> 0, distance: distance, entrants: entrants, eventFrequency: o.events || 'normal',
    hypeLevel: o.hype || 0, dayEvent: o.dayEvent || null, chatEffects: o.chatEffects || []
  });
}
// 8 of the 10 roster runners, lanes shuffled, reproducible per (tag, i).
function rosterField(tag, i, n) {
  const rng = SD.rng.create(SD.rng.seedFrom('field', tag, i));
  return rng.shuffle(ROSTER.slice()).slice(0, n || 8);
}
function seedOf(tag, i) { return SD.rng.seedFrom('race-test', tag, i); }
function laneIdx(rec, id) {
  for (let k = 0; k < rec.entrants.length; k++) if (rec.entrants[k].runnerId === id) return k;
  return -1;
}
function posAt(rec, t, id) { return rec.ticks[Math.max(0, Math.min(t, rec.ticks.length - 1))].pos[laneIdx(rec, id)]; }
function pctIn(text) { const m = /\+(\d+(?:\.\d+)?)%/.exec(text || ''); return m ? Number(m[1]) : null; }
function nameOf(id) { const r = ROSTER.filter(function (x) { return x.id === id; })[0]; return r ? r.name : id; }

// =============================================================================
section('A. Distances and playback duration');
// =============================================================================
(function () {
  const defaults = SD.state.defaultSettings();
  const TPS = SD.CONFIG.PLAYBACK.TPS;
  function tps(phase) {
    let v = (TPS[phase] || TPS.FINAL_STRETCH || 8) * (defaults.playbackSpeed || 1);
    if (phase === 'FINAL_STRETCH' || phase === 'FINISH') v *= defaults.finalStretchSpeedup || 1;
    return v;
  }
  const extra = (SD.CONFIG.PLAYBACK.COUNTDOWN_S || 3) + (SD.CONFIG.PLAYBACK.FINISH_HOLD_MS || 1500) / 1000;
  const est = {};
  line(pad('Distance', 10) + lpad('ticks', 8) + lpad('sd', 6) + lpad('max', 6) + lpad('nominal', 9) + lpad('running s', 11) + lpad('total s', 9) +
    '   seconds by leader phase');
  D.forEach(function (d) {
    const N = 250;
    let sum = 0, sq = 0, max = 0, secs = 0;
    const byPhase = {};
    for (let i = 0; i < N; i++) {
      const rec = sim(rosterField('dur', i), { distance: d, seed: seedOf('dur' + d, i) });
      sum += rec.totalTicks; sq += rec.totalTicks * rec.totalTicks; max = Math.max(max, rec.totalTicks);
      for (let k = 0; k < rec.totalTicks; k++) {
        const ph = rec.ticks[k].phase;
        const s = 1 / tps(ph);
        secs += s;
        byPhase[ph] = (byPhase[ph] || 0) + s;
      }
    }
    const mean = sum / N, sd = Math.sqrt(Math.max(0, sq / N - mean * mean));
    const nominal = d / (C.BASE_SPEED * C.DT);
    est[d] = { ticks: mean, running: secs / N, total: secs / N + extra, max: max, nominal: nominal };
    line(pad(d + ' m', 10) + lpad(mean.toFixed(1), 8) + lpad(sd.toFixed(1), 6) + lpad(max, 6) + lpad(nominal, 9) +
      lpad((secs / N).toFixed(1), 11) + lpad((secs / N + extra).toFixed(1), 9) + '   ' +
      Object.keys(byPhase).map(function (p) { return p + ' ' + (byPhase[p] / N).toFixed(1); }).join(', '));
    ok(mean >= nominal && mean <= nominal * 1.2, d + ' m: mean ticks within 1.0-1.2x nominal', mean.toFixed(1) + ' vs ' + nominal);
    ok(max < nominal * C.MAX_TICKS_MULT, d + ' m: slowest race well under MAX_TICKS', max + ' ticks');
  });
  ok(Math.abs(est[1200].total - 30) <= 5, '1200 m plays in about 30 s (countdown included)', est[1200].total.toFixed(1) + ' s');
  ok(Math.abs(est[2400].total - 55) <= 8, '2400 m plays in about 55 s (countdown included)', est[2400].total.toFixed(1) + ' s');
  ok(est[1600].running > est[1200].running && est[2000].running > est[1600].running && est[2400].running > est[2000].running,
    'longer races play longer', D.map(function (d) { return est[d].running.toFixed(1); }).join(' < '));
})();

// =============================================================================
section('B. Abilities');
// =============================================================================
(function () {
  const N = 500;
  const procs = {}; // abilityId -> { d: { races, procs, maxPerRace } }
  const recs = {}; // distance -> [records]
  D.forEach(function (d) {
    recs[d] = [];
    for (let i = 0; i < N; i++) {
      const rec = sim(rosterField('ab', i), { distance: d, seed: seedOf('ab' + d, i) });
      recs[d].push(rec);
      rec.results.forEach(function (res) {
        const e = rec.entrants[laneIdx(rec, res.runnerId)];
        if (!e.abilityId) return;
        const a = procs[e.abilityId] || (procs[e.abilityId] = {});
        const s = a[d] || (a[d] = { races: 0, procs: 0, max: 0 });
        s.races++;
        s.procs += res.abilityActivations.length;
        s.max = Math.max(s.max, res.abilityActivations.length);
      });
    }
  });
  line(pad('Ability (runner)', 34) + D.map(function (d) { return lpad(d + 'm', 8); }).join('') + '   (activations per 100 races entered; max in one race)');
  const MAXPROC = { thunderStep: AB.thunderStep.maxProcs, hedgeHop: 6 };
  Object.keys(AB).forEach(function (id) {
    const owner = ROSTER.filter(function (r) { return r.ability && r.ability.id === id; })[0];
    const row = D.map(function (d) {
      const s = procs[id] && procs[id][d];
      return s ? lpad((100 * s.procs / s.races).toFixed(0) + '/' + s.max, 8) : lpad('-', 8);
    }).join('');
    line(pad(AB[id].name + ' (' + (owner ? owner.name : '?') + ')', 34) + row);
    let total = 0, races = 0, max = 0;
    D.forEach(function (d) { const s = procs[id] && procs[id][d]; if (s) { total += s.procs; races += s.races; max = Math.max(max, s.max); } });
    ok(total > 0, AB[id].name + ' activates', total + ' activations in ' + races + ' races');
    ok(max <= (MAXPROC[id] || 1), AB[id].name + ' never activates more than ' + (MAXPROC[id] || 1) + 'x in a race (not every tick)', 'max ' + max);
  });

  // --- Thunder Step: every proc is a real overtake in MID / FINAL_TURN, max 3, 20-tick cooldown
  let tsProcs = 0, tsBad = [], tsCool = 0;
  D.forEach(function (d) {
    recs[d].forEach(function (rec) {
      const res = rec.results.filter(function (x) { return x.runnerId === ID.thunder; })[0];
      if (!res) return;
      let last = -1e9;
      res.abilityActivations.forEach(function (a) {
        tsProcs++;
        if (a.tick - last < AB.thunderStep.cooldown) tsCool++;
        last = a.tick;
        const m = / thunders past (.+)!$/.exec(a.text);
        const passed = m && rec.entrants.filter(function (e) { return e.name === m[1]; })[0];
        if (!passed) { tsBad.push('no passed runner in "' + a.text + '"'); return; }
        const me0 = posAt(rec, a.tick - 1, ID.thunder), me1 = posAt(rec, a.tick, ID.thunder);
        const o0 = posAt(rec, a.tick - 1, passed.runnerId), o1 = posAt(rec, a.tick, passed.runnerId);
        const phase = SD.race.phaseOf(me0.d / d);
        // (positions are stored to 0.01 m, so "behind" can read as level in the record)
        if (!(me0.d <= o0.d && me1.d >= o1.d && me1.d - me0.d > o1.d - o0.d)) tsBad.push('tick ' + a.tick + ': not an overtake');
        if (phase !== 'MID' && phase !== 'FINAL_TURN') tsBad.push('tick ' + a.tick + ': phase ' + phase);
      });
    });
  });
  ok(tsProcs > 0 && tsBad.length === 0, 'Thunder Step fires only on real overtakes in MID / FINAL_TURN', tsProcs + ' procs; ' + tsBad.slice(0, 2).join('; '));
  ok(tsCool === 0, 'Thunder Step respects its ' + AB.thunderStep.cooldown + '-tick cooldown', tsCool + ' early procs');

  // --- Second Wind: fires as Ember Tail fades; much more often at 2400 than 1200; restores the pool
  function swRate(d) {
    let raced = 0, fired = 0, bad = 0;
    recs[d].forEach(function (rec) {
      const res = rec.results.filter(function (x) { return x.runnerId === ID.ember; })[0];
      if (!res) return;
      raced++;
      res.abilityActivations.forEach(function (a) {
        fired++;
        const st0 = posAt(rec, a.tick - 1, ID.ember).st, st1 = posAt(rec, a.tick, ID.ember).st;
        if (!(st0 <= AB.secondWind.threshold + 0.03 && st1 - st0 >= AB.secondWind.restore * 0.6)) bad++;
      });
    });
    return { rate: raced ? fired / raced : 0, bad: bad, fired: fired };
  }
  const sw12 = swRate(1200), sw24 = swRate(2400);
  line('Second Wind (Ember Tail): fires in ' + pct(sw12.rate) + ' of 1200 m races, ' + pct(sw24.rate) + ' at 2400 m');
  ok(sw24.rate >= 0.5 && sw24.rate > sw12.rate + 0.3, 'Second Wind triggers when Ember Tail fades at 2400 m', pct(sw12.rate) + ' -> ' + pct(sw24.rate));
  ok(sw24.fired > 0 && sw24.bad === 0, 'Second Wind fires below ' + pct(AB.secondWind.threshold) + ' stamina and restores the pool', sw24.bad + ' bad of ' + sw24.fired);

  // --- Long Night: bonus = stamina left x perStam; Afterglow: +perAhead per runner ahead (capped)
  let ln = 0, lnBad = 0, lnLo = [], lnHi = [];
  let ag = 0, agBad = 0, agSeen = {};
  let ff = 0, ffMiss = 0, ct = 0, ctBad = 0, mp = { races: 0, bad: 0 }, rw = { raced: 0, fired: 0 }, acorn = 0, acornBad = 0;
  D.forEach(function (d) {
    recs[d].forEach(function (rec) {
      rec.results.forEach(function (res) {
        const id = res.runnerId;
        const e = rec.entrants[laneIdx(rec, id)];
        if (e.abilityId === 'longNight') {
          res.abilityActivations.forEach(function (a) {
            ln++;
            const st = posAt(rec, a.tick - 1, id).st;
            const want = Math.round(st * AB.longNight.perStam * 100);
            if (Math.abs(pctIn(a.text) - want) > 1) lnBad++;
            (st < 0.4 ? lnLo : lnHi).push(pctIn(a.text));
          });
        } else if (e.abilityId === 'afterglow') {
          res.abilityActivations.forEach(function (a) {
            ag++;
            const m = /with (\d+) runners? ahead/.exec(a.text);
            const ahead = m ? Number(m[1]) : -1;
            const want = Math.round(Math.min(AB.afterglow.max, ahead * AB.afterglow.perAhead) * 100);
            if (ahead !== posAt(rec, a.tick - 1, id).rank - 1 || pctIn(a.text) !== want) agBad++;
            agSeen[ahead] = pctIn(a.text);
          });
        } else if (e.abilityId === 'forestsFavor') {
          // Guaranteed when 3rd-5th on entering the final stretch. A runner's phase comes from its
          // position at the start of a tick, so the hook runs on the tick AFTER it crosses 85%,
          // with the ranks of the crossing tick.
          let cross = -1;
          for (let t = 1; t < rec.ticks.length; t++) {
            if (posAt(rec, t - 1, id).d < C.PHASE_BOUNDS[3] * d && posAt(rec, t, id).d >= C.PHASE_BOUNDS[3] * d) { cross = t; break; }
          }
          const rank = cross > 0 && posAt(rec, cross, id).d < d ? posAt(rec, cross, id).rank : 0;
          if (rank >= AB.forestsFavor.guaranteedRanks[0] && rank <= AB.forestsFavor.guaranteedRanks[1]) {
            ff++;
            if (!res.abilityActivations.length) ffMiss++;
          }
        } else if (e.abilityId === 'cometTail') {
          res.abilityActivations.forEach(function (a) {
            ct++;
            const rank = posAt(rec, a.tick - 1, id).rank;
            const want = Math.round((rank <= 5 ? AB.cometTail.burst : AB.cometTail.burstBack) * 100);
            if (rank === 1 || pctIn(a.text) !== want) ctBad++;
          });
        } else if (e.abilityId === 'moonlightPace') {
          mp.races++;
          if (res.abilityActivations.length !== 1) mp.bad++;
        } else if (e.abilityId === 'readingTheWind') {
          rw.raced++;
          rw.fired += res.abilityActivations.length;
        } else if (e.abilityId === 'acornHoard') {
          res.abilityActivations.forEach(function (a) {
            acorn++;
            const earlier = rec.events.filter(function (ev) { return ev.kind === 'crit' && ev.runnerId === id && ev.tick < a.tick; });
            if (earlier.length) acornBad++;
          });
        }
      });
    });
  });
  const avg = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; };
  line('Long Night bonus: +' + avg(lnLo).toFixed(1) + '% with < 40% stamina left, +' + avg(lnHi).toFixed(1) + '% with more (' + ln + ' procs)');
  ok(ln > 0 && lnBad === 0, 'Long Night bonus = remaining stamina x ' + pct(AB.longNight.perStam), lnBad + ' mismatches of ' + ln);
  ok(avg(lnHi) > avg(lnLo), 'Long Night scales with remaining stamina', avg(lnLo).toFixed(1) + '% < ' + avg(lnHi).toFixed(1) + '%');
  line('Afterglow bonus by runners ahead: ' + Object.keys(agSeen).sort().map(function (k) { return k + ' -> +' + agSeen[k] + '%'; }).join(', '));
  ok(ag > 0 && agBad === 0, 'Afterglow = +' + pct(AB.afterglow.perAhead) + ' per runner ahead (max ' + pct(AB.afterglow.max) + ')', agBad + ' mismatches of ' + ag);
  ok(Object.keys(agSeen).length >= 4, 'Afterglow seen with several different field positions', Object.keys(agSeen).join(','));
  ok(ff > 0 && ffMiss === 0, "Forest's Favor always fires when 3rd-5th entering the stretch", ffMiss + ' misses of ' + ff);
  ok(ct > 0 && ctBad === 0, 'Comet Tail: never when leading, +' + pct(AB.cometTail.burst) + ' 2nd-5th, +' + pct(AB.cometTail.burstBack) + ' further back', ctBad + ' bad of ' + ct);
  ok(mp.races > 0 && mp.bad === 0, 'Moonlight Pace announces exactly once per race (mid race)', mp.bad + ' bad of ' + mp.races);
  const rwWant = Math.min(0.95, AB.readingTheWind.chanceBase + AB.readingTheWind.chancePerWis * byKey.mistyGale.stats.wisdom);
  ok(Math.abs(rw.fired / rw.raced - rwWant) < 0.05, 'Reading the Wind succeeds at 50% + Wis/200', pct(rw.fired / rw.raced) + ' vs ' + pct(rwWant));
  ok(acorn > 0 && acornBad === 0, 'Acorn Hoard: the guaranteed stretch crit only comes when she has not crit yet', acornBad + ' bad of ' + acorn);

  // --- Hedge Hop: bounce bad events onto the runner directly ahead (chaos races, Bramble Jack in every field)
  let hops = 0, redirects = 0, dodges = 0, hopBad = 0, negHits = 0;
  for (let i = 0; i < 700; i++) {
    const field = rosterField('hop', i, 7).filter(function (r) { return r.id !== ID.bramble; }).slice(0, 7).concat([byKey.brambleJack]);
    const rec = sim(field, { distance: 1600, seed: seedOf('hop', i), events: 'chaos' });
    rec.events.forEach(function (ev) {
      if (ev.kind !== 'event' || ev.runnerId !== ID.bramble || !ev.data || ev.data.outcome !== 'neg') return;
      negHits++;
      if (ev.data.redirectedTo) {
        hops++; redirects++;
        const me = posAt(rec, ev.tick - 1, ID.bramble), them = posAt(rec, ev.tick - 1, ev.data.redirectedTo);
        if (!(them.d > me.d) || ev.data.targets[0] !== ev.data.redirectedTo) hopBad++;
      } else if (ev.data.dodged) { hops++; dodges++; }
    });
  }
  const hopWant = Math.min(AB.hedgeHop.chanceMax, AB.hedgeHop.chanceBase + AB.hedgeHop.chancePerLuck * byKey.brambleJack.stats.luck);
  line('Hedge Hop: ' + negHits + ' bad events aimed at Bramble Jack -> ' + redirects + ' bounced onto the runner ahead, ' + dodges + ' shrugged off');
  ok(redirects > 0 && hopBad === 0, 'Hedge Hop redirects bad events onto a runner ahead', redirects + ' redirects, ' + hopBad + ' bad');
  ok(Math.abs(hops / negHits - hopWant) < 0.08, 'Hedge Hop chance = 50% + Luck/200', pct(hops / negHits) + ' vs ' + pct(hopWant));
})();

// =============================================================================
section('C. Race events');
// =============================================================================
(function () {
  const E = C.EVENTS;
  const FREQS = ['none', 'low', 'normal', 'high', 'chaos'];
  const out = {};
  const samples = {};
  let gapBad = 0, negBad = [], capBad = 0, negChecked = 0;
  FREQS.forEach(function (fq) {
    const N = fq === 'normal' || fq === 'chaos' ? 2000 : 800;
    const counts = {};
    let total = 0, max = 0;
    for (let i = 0; i < N; i++) {
      const field = rosterField('ev', i);
      // Chaos races also carry two sabotages: they count as negatives for the cooldown rule.
      const chat = fq === 'chaos' ? [{ runnerId: field[i % 8].id, type: 'sabotage', by: 'Imp' }, { runnerId: field[(i + 3) % 8].id, type: 'sabotage', by: 'Gremlin' }] : [];
      const rec = sim(field, { distance: 1600, seed: seedOf('ev' + fq, i), events: fq, chatEffects: chat });
      let k = 0, lastT = -1e9;
      const negTicks = {};
      rec.events.forEach(function (ev) {
        if (ev.kind === 'event' && !ev.hidden) {
          k++;
          counts[ev.data.eventId] = (counts[ev.data.eventId] || 0) + 1;
          if (ev.tick - lastT < E.MIN_GAP) gapBad++;
          lastT = ev.tick;
          const key = ev.data.eventId + (ev.data.outcome === 'neg' && SD.events.raceEventById(ev.data.eventId).polarity === 'mixed' ? ':bad' : '');
          if (!samples[key]) samples[key] = ev.text;
          if (ev.data.outcome === 'neg') (ev.data.targets || []).forEach(function (id) { (negTicks[id] = negTicks[id] || []).push(ev.tick); });
        } else if (ev.kind === 'chat' && ev.data && ev.data.type === 'sabotage' && !ev.data.backfire && !ev.data.fizzled) {
          (negTicks[ev.runnerId] = negTicks[ev.runnerId] || []).push(ev.tick);
        }
      });
      Object.keys(negTicks).forEach(function (id) {
        const ts = negTicks[id].sort(function (a, b) { return a - b; });
        for (let j = 1; j < ts.length; j++) { negChecked++; if (ts[j] - ts[j - 1] < E.NEG_COOLDOWN) negBad.push(fq + ' ' + id + ' @' + ts[j - 1] + '/' + ts[j]); }
      });
      if (k > (fq === 'chaos' ? E.MAX_CHAOS : E.MAX)) capBad++;
      total += k; max = Math.max(max, k);
    }
    out[fq] = { perRace: total / N, max: max, counts: counts, N: N };
  });
  line(pad('Event', 26) + FREQS.map(function (f) { return lpad(f, 8); }).join('') + '   (count per 100 races, 1600 m, 8 runners)');
  SD.DATA.RACE_EVENTS.forEach(function (ev) {
    line(pad(ev.name, 26) + FREQS.map(function (f) { return lpad((100 * (out[f].counts[ev.id] || 0) / out[f].N).toFixed(1), 8); }).join(''));
  });
  line(pad('events per race', 26) + FREQS.map(function (f) { return lpad(out[f].perRace.toFixed(2), 8); }).join(''));
  line(pad('most in one race', 26) + FREQS.map(function (f) { return lpad(out[f].max, 8); }).join(''));
  const missingChaos = SD.DATA.RACE_EVENTS.filter(function (ev) { return !out.chaos.counts[ev.id]; }).map(function (ev) { return ev.id; });
  const missingNormal = SD.DATA.RACE_EVENTS.filter(function (ev) { return !out.normal.counts[ev.id]; }).map(function (ev) { return ev.id; });
  eq(SD.DATA.RACE_EVENTS.length, 16, '16 race events in the catalog');
  ok(missingChaos.length === 0, 'every event fires on chaos (' + out.chaos.N + ' races)', missingChaos.join(', '));
  ok(missingNormal.length === 0, 'every event fires on normal (' + out.normal.N + ' races)', missingNormal.join(', '));
  eq(out.none.perRace, 0, 'frequency none: no events');
  ok(out.low.perRace < out.normal.perRace && out.normal.perRace < out.high.perRace && out.high.perRace < out.chaos.perRace,
    'frequency low < normal < high < chaos', FREQS.map(function (f) { return out[f].perRace.toFixed(2); }).join(' < '));
  ok(capBad === 0 && out.normal.max <= E.MAX && out.chaos.max <= E.MAX_CHAOS, 'per-race caps respected (' + E.MAX + ', chaos ' + E.MAX_CHAOS + ')',
    'normal max ' + out.normal.max + ', chaos max ' + out.chaos.max);
  ok(gapBad === 0, 'random events are at least ' + E.MIN_GAP + ' ticks apart', gapBad + ' violations');
  ok(negChecked > 0 && negBad.length === 0, 'no runner gets two negatives (events or sabotage) within ' + E.NEG_COOLDOWN + ' ticks',
    negChecked + ' pairs checked; ' + negBad.slice(0, 3).join(', '));
  console.log('  Sample messages:');
  Object.keys(samples).sort().forEach(function (k) { console.log('    ' + pad(k, 26) + samples[k]); });
  const allSampled = SD.DATA.RACE_EVENTS.every(function (ev) { return samples[ev.id] || samples[ev.id + ':bad']; });
  ok(allSampled, 'a sample message for every event');
  const badText = Object.keys(samples).filter(function (k) { return /\{r2?\}|undefined|null|NaN/.test(samples[k]); });
  ok(badText.length === 0, 'event messages are fully filled in (no {r} / undefined)', badText.join(', '));
})();

// =============================================================================
section('D. Hype tiers in the race');
// =============================================================================
(function () {
  const H = C.HYPE;
  // Tier boundaries: the same seed only changes when a tier is crossed.
  let sameTier = 0, diff2425 = 0;
  const K = 40;
  for (let i = 0; i < K; i++) {
    const f = rosterField('tier', i), s = seedOf('tier', i);
    const h = function (hype) { return sim(f, { seed: s, hype: hype }).hash; };
    const h0 = h(0), h24 = h(24), h25 = h(25), h49 = h(49), h50 = h(50), h99 = h(99);
    if (h0 === h24 && h25 === h49 && h50 === h99) sameTier++;
    if (h24 !== h25) diff2425++;
  }
  eq(sameTier, K, 'hype only matters by tier: 0 = 24, 25 = 49, 50 = 99 give identical races');
  ok(diff2425 >= K - 1, 'hype 25 (loud: noise x' + H.LOUD_SIGMA + ') changes the race', diff2425 + '/' + K);

  // Feral: events x1.5, crits x1.25 (and the noise tier stays the same between 49 and 50).
  const N = 1000;
  function rates(hype) {
    let ev = 0, cr = 0;
    for (let i = 0; i < N; i++) {
      const rec = sim(rosterField('feral', i), { seed: seedOf('feral', i), hype: hype, events: 'low' });
      ev += rec.summary.eventsCount; cr += rec.summary.critsCount;
    }
    return { ev: ev / N, cr: cr / N };
  }
  const r49 = rates(49), r50 = rates(50);
  line('hype 49 -> 50: events/race ' + r49.ev.toFixed(2) + ' -> ' + r50.ev.toFixed(2) + ' (x' + (r50.ev / r49.ev).toFixed(2) +
    '), crits/race ' + r49.cr.toFixed(2) + ' -> ' + r50.cr.toFixed(2) + ' (x' + (r50.cr / r49.cr).toFixed(2) + ')');
  ok(r50.ev / r49.ev > 1.35 && r50.ev / r49.ev < 1.65, 'feral: event rate x' + H.FERAL_EVENTS, 'x' + (r50.ev / r49.ev).toFixed(2));
  ok(r50.cr / r49.cr > 1.15 && r50.cr / r49.cr < 1.35, 'feral: crit chance x' + H.FERAL_CRIT, 'x' + (r50.cr / r49.cr).toFixed(2));

  // Forest Awakened at 100: exactly once, at the leader's final turn, restores pools, lifts last place, SP x1.5.
  let races = 0, onceBad = 0, poolBad = 0, poolChecked = 0, lastBad = 0, spBad = 0, below = 0;
  for (let i = 0; i < 300; i++) {
    const field = rosterField('awake', i).map(function (r, k) { return Object.assign({}, r, { owner: k % 2 ? 'Owner' + k : null }); });
    const seed = seedOf('awake', i);
    const rec = sim(field, { seed: seed, hype: 100, distance: 2000 });
    const rec99 = sim(field, { seed: seed, hype: 99, distance: 2000 });
    races++;
    const aw = rec.events.filter(function (e) { return e.kind === 'awakened' && !e.runnerId; });
    const awLast = rec.events.filter(function (e) { return e.kind === 'awakened' && e.runnerId; });
    if (aw.length !== 1 || awLast.length !== 1 || !rec.summary.forestAwakened) { onceBad++; continue; }
    if (rec99.events.some(function (e) { return e.kind === 'awakened'; }) || rec99.summary.forestAwakened) below++;
    const t = aw[0].tick;
    const turn = rec.events.filter(function (e) { return e.kind === 'phase' && e.data && e.data.phase === 'FINAL_TURN'; })[0];
    if (!turn || turn.tick !== t) onceBad++;
    rec.ticks[t].pos.forEach(function (p, k) {
      const p0 = rec.ticks[t - 1].pos[k];
      if (p0.d >= rec.distance || p0.st > 0.8) return;
      poolChecked++;
      if (p.st - p0.st < H.AWAKEN_POOL - 0.03) poolBad++;
    });
    const lastId = awLast[0].runnerId;
    if (posAt(rec, t, lastId).rank !== Math.max.apply(null, rec.ticks[t].pos.map(function (p) { return p.rank; }))) lastBad++;
    rec.results.forEach(function (res, k) {
      const want = res.ownerAtRace ? Math.round(SD.CONFIG.RESULTS.OWNER_SP[k] * H.AWAKEN_SP) : 0;
      if (res.spOwner !== want) spBad++;
    });
  }
  ok(onceBad === 0, 'Forest Awakened fires exactly once per race at hype 100, at the leader\'s final turn', onceBad + ' bad of ' + races);
  eq(below, 0, 'Forest Awakened never fires at hype 99');
  ok(poolChecked > 0 && poolBad === 0, 'Forest Awakened restores +' + pct(H.AWAKEN_POOL) + ' stamina to every runner still racing', poolBad + ' bad of ' + poolChecked);
  eq(lastBad, 0, 'the extra Awakened lift goes to the runner in last place');
  eq(spBad, 0, 'Awakened races pay owners SP x' + H.AWAKEN_SP);
})();

// =============================================================================
section('E. Condition and mood');
// =============================================================================
(function () {
  const bands = [[0, 'Excellent'], [15, 'Excellent'], [15.5, 'Good'], [35, 'Good'], [35.5, 'Normal'], [60, 'Normal'],
    [61, 'Tired'], [80, 'Tired'], [80.5, 'Exhausted'], [120, 'Exhausted']];
  eq(bands.map(function (b) { return SD.runners.conditionOf(b[0]); }), bands.map(function (b) { return b[1]; }), 'conditionOf fatigue bands 0-15-35-60-80-120');
  const sm = function (cond, energy) { return Math.round(SD.race.raceStatMult({ condition: cond, energy: energy, maxEnergy: 100 }) * 1000) / 1000; };
  eq([sm('Excellent', 100), sm('Good', 100), sm('Normal', 100), sm('Tired', 100), sm('Exhausted', 100)], [1.03, 1.01, 1, 0.96, 0.9],
    'condition scales race-day stats 1.03 / 1.01 / 1.00 / 0.96 / 0.90');
  eq([sm('Normal', 60), sm('Normal', 20), sm('Normal', 0)], [1, 0.952, 0.92], 'energy below half scales stats down to x' + C.ENERGY.MIN);

  // Passive clock
  let NOW = 1700000000000;
  SD.clock.set(function () { return NOW; });
  SD.state.set(SD.state.create({ seedSalt: 99, dayEventId: 'clearSkies' }));
  const st = SD.state.get();
  const a = st.runners[0], b = st.runners[1], c = st.runners[2];
  a.energy = 50; a.fatigue = 50; a.mood = 'Happy'; a.lastActionAt = NOW;
  b.energy = 50; b.fatigue = 50; b.mood = 'Sleepy'; b.lastActionAt = NOW;
  c.energy = 50; c.fatigue = 50; c.mood = 'Happy'; c.lastActionAt = NOW - 31 * 60000;
  const P = SD.CONFIG.TRAINING.PASSIVE;
  SD.training.tickClock(st, 10 * 60000);
  eq(a.energy, 50 + P.ENERGY_PER_MIN * 10, 'tickClock: energy +' + P.ENERGY_PER_MIN + '/min');
  eq(a.fatigue, 50 - P.FATIGUE_PER_10MIN, 'tickClock: fatigue -' + P.FATIGUE_PER_10MIN + ' per 10 min');
  eq(b.energy, SD.util.round2(50 + P.ENERGY_PER_MIN * 10 * SD.DATA.MOODS.Sleepy.regen), 'tickClock: Sleepy regenerates x' + SD.DATA.MOODS.Sleepy.regen);
  eq([a.mood, c.mood], ['Happy', 'Sleepy'], 'tickClock: 30 idle minutes make a runner Sleepy');

  // Training crit / fail and rest moods (scripted rng)
  function scripted(values) {
    let i = 0;
    const next = function () { return values[Math.min(i++, values.length - 1)]; };
    return { float: next, chance: function (p) { return next() < p; }, range: function (lo, hi) { return lo + (hi - lo) * next(); }, pick: function (arr) { return arr[0]; } };
  }
  const r = st.runners[3];
  r.energy = 100; r.fatigue = 10; r.mood = 'Happy'; r.condition = 'Excellent';
  let res = SD.training.train(st, r, 'speed', { rng: scripted([0.0, 0.0]) }); // fail, then the 40% Nervous roll succeeds
  eq([res.outcome, r.mood], ['fail', 'Nervous'], 'training fail can make a runner Nervous');
  const ch = SD.training.chances(st, r);
  res = SD.training.train(st, r, 'speed', { rng: scripted([ch.failP + 0.001, 0.5, 0.99, 0.5]) }); // crit, Fired Up roll fails
  eq([res.outcome, r.mood], ['crit', 'Happy'], 'a training crit cures Nervous');
  const ch2 = SD.training.chances(st, r);
  res = SD.training.train(st, r, 'power', { rng: scripted([ch2.failP + 0.001, 0.5, 0.0, 0.5]) }); // crit, Fired Up roll succeeds
  eq([res.outcome, r.mood], ['crit', 'Fired Up'], 'a training crit can make a runner Fired Up');
  r.fatigue = 20;
  eq(SD.training.rest(st, r, { now: NOW }).mood, 'Happy', 'rest with low fatigue -> Happy');
  const r2 = st.runners[4];
  r2.fatigue = 90;
  eq(SD.training.rest(st, r2, { now: NOW }).mood, 'Sleepy', 'rest while still tired -> Sleepy');
  SD.clock.reset();

  // Mood after a race by place (no events -> no mushroom / sabotage overrides), through SD.game.
  NOW = 1700000000000;
  SD.clock.set(function () { return NOW; });
  SD.state.set(SD.state.create({ seedSalt: 4242, dayEventId: 'clearSkies' }));
  SD.game.init();
  SD.game.updateSettings({ eventFrequency: 'none', runnerCount: 8, autoAdvanceDay: false });
  let checked = 0, wrong = [];
  for (let k = 0; k < 3; k++) {
    const started = SD.game.startRace({ distance: 1200 });
    if (!started.ok) { ok(false, 'startRace for the mood check', started.message); break; }
    SD.game.endRace();
    started.record.results.forEach(function (x) {
      const want = x.place <= 3 ? 'Happy' : (x.place >= 7 ? 'Nervous' : 'Determined');
      const live = SD.state.runnerById(x.runnerId);
      checked++;
      if (x.moodAfter !== want || live.mood !== want) wrong.push(x.name + ' ' + x.place + ' ' + x.moodAfter + '/' + live.mood);
    });
    SD.game.resetDay();
  }
  ok(checked === 24 && wrong.length === 0, 'after a race: podium -> Happy, 4th-6th -> Determined, 7th-8th -> Nervous', checked + ' checked; ' + wrong.join(', '));
  SD.clock.reset();
})();

// =============================================================================
section('F. Chat effects in the race');
// =============================================================================
(function () {
  const CH = C.CHAT;
  const field = ROSTER.slice(0, 8);
  const chat = [
    { runnerId: ID.moss, type: 'boost', by: 'FoxFan' },
    { runnerId: ID.thunder, type: 'sabotage', by: 'MothMom' },
    { runnerId: ID.ember, type: 'cheer', by: 'LanternLiz', count: 5 },
    { runnerId: ID.ember, type: 'cheer', by: 'AcornAndy', count: 2 }
  ];
  let boostOk = 0, sabOk = 0, cheerOk = 0, fxBad = [], total = 30;
  for (let i = 0; i < total; i++) {
    const rec = sim(field, { seed: seedOf('chat', i), chatEffects: chat });
    const chats = rec.events.filter(function (e) { return e.kind === 'chat'; });
    const b = chats.filter(function (e) { return e.data.type === 'boost' && e.runnerId === ID.moss; })[0];
    const s = chats.filter(function (e) { return e.data.type === 'sabotage' && e.runnerId === ID.thunder; })[0];
    const c = chats.filter(function (e) { return e.data.type === 'cheer' && e.runnerId === ID.ember; })[0];
    if (b && b.data.by === 'FoxFan' && b.text.indexOf('FoxFan') >= 0) {
      boostOk++;
      if (!b.data.fizzled) for (let t = b.tick; t < b.tick + CH.BOOST_TICKS && t <= rec.totalTicks; t++) {
        const p = posAt(rec, t, ID.moss);
        if (p.d < rec.distance && p.fx.indexOf('boost') < 0) { fxBad.push('boost fx missing @' + t); break; }
      }
    }
    if (s && s.data.by === 'MothMom' && s.text.indexOf('MothMom') >= 0) {
      sabOk++;
      const tag = s.data.backfire ? 'boost' : 'sabotage';
      if (!s.data.fizzled) for (let t = s.tick; t < s.tick + CH.SABOTAGE_TICKS && t <= rec.totalTicks; t++) {
        const p = posAt(rec, t, ID.thunder);
        if (p.d < rec.distance && p.fx.indexOf(tag) < 0) { fxBad.push(tag + ' fx missing @' + t); break; }
      }
    }
    if (c && c.data.by === 'LanternLiz' && c.data.count === 7 && c.text.indexOf('LanternLiz') >= 0 && c.text.indexOf('AcornAndy') >= 0 &&
        Math.abs(c.data.bonus - 7 * CH.CHEER_PER) < 1e-6 && posAt(rec, 1, ID.ember).fx.indexOf('boost') >= 0) cheerOk++;
    if (i === 0) chats.forEach(function (e) { line('tick ' + lpad(e.tick, 3) + '  ' + e.text + '  ' + JSON.stringify(e.data)); });
  }
  eq(boostOk, total, 'a queued boost shows up as a chat event with the viewer\'s name');
  eq(sabOk, total, 'a queued sabotage shows up as a chat event with the viewer\'s name');
  eq(cheerOk, total, 'queued cheers show up as one chat event naming the viewers, +0.05% per cheer, boost glow at the gate');
  ok(fxBad.length === 0, 'boost / sabotage fx tags are on the runner while the effect lasts', fxBad.slice(0, 3).join(', '));

  // Backfire chance = BACKFIRE_BASE + target Wisdom / BACKFIRE_WIS_DIV (capped)
  function backfireRate(targetId) {
    let fired = 0, back = 0;
    for (let i = 0; i < 1200; i++) {
      const rec = sim(ROSTER.slice(0, 10).filter(function (r, k) { return k < 8 || r.id === targetId; }).slice(-8),
        { seed: seedOf('bf' + targetId, i), chatEffects: [{ runnerId: targetId, type: 'sabotage', by: 'Imp' }] });
      rec.events.forEach(function (e) { if (e.kind === 'chat' && e.data.type === 'sabotage') { fired++; if (e.data.backfire) back++; } });
    }
    return back / fired;
  }
  [['misty', byKey.mistyGale], ['bramble', byKey.brambleJack]].forEach(function (x) {
    const want = Math.min(CH.BACKFIRE_MAX, CH.BACKFIRE_BASE + x[1].stats.wisdom / CH.BACKFIRE_WIS_DIV);
    const got = backfireRate(x[1].id);
    ok(Math.abs(got - want) < 0.05, 'sabotage backfire uses the target\'s Wisdom: ' + x[1].name + ' (Wis ' + x[1].stats.wisdom + ')', pct(got) + ' vs ' + pct(want));
  });

  // Caps per race
  function count(chatEffects, type) {
    const rec = sim(field, { seed: seedOf('caps', type), chatEffects: chatEffects });
    return rec.events.filter(function (e) { return e.kind === 'chat' && e.data.type === type; });
  }
  const five = []; for (let k = 0; k < 5; k++) five.push({ runnerId: ID.moss, type: 'boost', by: 'V' + k });
  eq(count(five, 'boost').length, CH.MAX_BOOSTS_PER_RUNNER, 'max ' + CH.MAX_BOOSTS_PER_RUNNER + ' boosts per runner per race');
  const three = []; for (let k = 0; k < 3; k++) three.push({ runnerId: ID.moss, type: 'sabotage', by: 'S' + k });
  eq(count(three, 'sabotage').length, CH.MAX_SABOTAGE_PER_TARGET, 'max ' + CH.MAX_SABOTAGE_PER_TARGET + ' sabotages per target per race');
  const six = field.slice(0, 6).map(function (r, k) { return { runnerId: r.id, type: 'sabotage', by: 'T' + k }; });
  eq(count(six, 'sabotage').length, CH.MAX_SABOTAGE_PER_RACE, 'max ' + CH.MAX_SABOTAGE_PER_RACE + ' sabotages per race');
  const lots = count([{ runnerId: ID.moss, type: 'cheer', by: 'Crowd', count: 500 }], 'cheer')[0];
  eq(lots && lots.data.bonus, CH.CHEER_CAP, 'cheer bonus capped at +' + pct(CH.CHEER_CAP));
})();

// =============================================================================
section('G. Photo finish and upset');
// =============================================================================
(function () {
  let photo = 0, upset = 0, bad = 0, N = 3000;
  for (let i = 0; i < N; i++) {
    const rec = sim(rosterField('pf', i), { distance: 1200, seed: seedOf('pf', i) });
    const winOdds = rec.entrants[laneIdx(rec, rec.summary.winnerId)].odds;
    const m = rec.results[0].margin;
    if (rec.summary.photoFinish) photo++;
    if (rec.summary.upset) upset++;
    if (rec.summary.photoFinish !== (m < C.PHOTO_FINISH_M) && Math.abs(m - C.PHOTO_FINISH_M) > 0.01) bad++;
    if (rec.summary.upset !== (winOdds >= C.UPSET_ODDS)) bad++;
    if (rec.summary.photoFinish && rec.events.filter(function (e) { return e.kind === 'finish' && /PHOTO FINISH/.test(e.text); }).length !== 1) bad++;
  }
  line('photo finishes ' + pct(photo / N) + ', upsets (winner at ' + C.UPSET_ODDS + 'x+) ' + pct(upset / N) + ' of ' + N + ' races at 1200 m');
  ok(photo > 0 && upset > 0 && bad === 0, 'summary.photoFinish = winning margin < ' + C.PHOTO_FINISH_M + ' m; summary.upset = winner odds >= ' + C.UPSET_ODDS + 'x',
    photo + ' photos, ' + upset + ' upsets, ' + bad + ' mismatches');

  // finishRace adds +15 for each major moment (before the post-race decay).
  let NOW = 1700000000000;
  SD.clock.set(function () { return NOW; });
  SD.state.set(SD.state.create({ seedSalt: 777, dayEventId: 'clearSkies' }));
  SD.game.init();
  SD.game.updateSettings({ hypeMultiplier: 1, autoAdvanceDay: false });
  function majorDelta(flags) {
    const started = SD.game.startRace({ distance: 1200 });
    const rec = SD.state.get().currentRace.record;
    Object.assign(rec.summary, flags);
    let delta = null, lv = 0;
    const off = SD.bus.on(SD.EVENTS.HYPE_CHANGED, function (p) { if (p.reason === 'raceFinish') delta = p.delta; });
    const off2 = SD.bus.on(SD.EVENTS.RACE_FINISHED, function (p) { lv = p.levelUps.reduce(function (a, l) { return a + l.levelUps; }, 0); });
    SD.hype.set(SD.state.get(), 0);
    SD.game.endRace();
    off(); off2();
    SD.game.resetDay();
    return started.ok ? delta - lv * SD.CONFIG.PROGRESSION.LEVELUP_HYPE : null;
  }
  const MH = SD.CONFIG.RESULTS.MAJOR_HYPE;
  eq(majorDelta({ photoFinish: false, upset: false, forestAwakened: false }), MH.finish, 'finishRace: +' + MH.finish + ' hype for the finish');
  eq(majorDelta({ photoFinish: true, upset: false, forestAwakened: false }), MH.finish + MH.photoFinish, 'finishRace: photo finish +' + MH.photoFinish);
  eq(majorDelta({ photoFinish: true, upset: true, forestAwakened: false }), MH.finish + MH.photoFinish + MH.upset, 'finishRace: upset +' + MH.upset);
  SD.clock.reset();
})();

// =============================================================================
section('H. Replay');
// =============================================================================
(function () {
  let NOW = 1700000000000;
  SD.clock.set(function () { return NOW; });
  SD.state.set(SD.state.create({ seedSalt: 31337, dayEventId: 'clearSkies' }));
  SD.game.init();
  SD.game.updateSettings({ eventFrequency: 'chaos', runnerCount: 8, autoAdvanceDay: false });
  SD.game.triggerDayEvent('cryptidSeason');
  const st = SD.state.get();
  st.players = st.players || {};
  SD.players.join(st, 'foxfan', 'FoxFan', { now: NOW });
  const recs = [];
  for (let k = 0; k < 3; k++) {
    SD.game.addHype(k === 2 ? 110 : 40 * k);
    const r = SD.state.get().runners;
    SD.state.get().raceEffects = [
      { type: 'boost', runnerId: r[k].id, by: 'foxfan', count: 1 },
      { type: 'sabotage', runnerId: r[k + 1].id, by: 'mothmom', count: 1 },
      { type: 'cheer', runnerId: r[k + 2].id, by: 'foxfan', count: 4 }
    ];
    const started = SD.game.startRace({ distance: D[k + 1] });
    if (!started.ok) { ok(false, 'startRace ' + k, started.message); return; }
    SD.game.endRace();
    const rp = SD.game.replayLastRace();
    ok(rp.ok && rp.sameHash, 'replayLastRace() reproduces race ' + (k + 1) + ' (' + started.record.distance + ' m, hype ' + started.record.hypeBefore + ')', rp.hash + ' / ' + rp.replayHash);
    recs.push(started.record);
    SD.game.resetDay();
  }
  const last = recs[2];
  ok(last.summary.forestAwakened, 'the replayed hype-110 race had Forest Awakened');
  const cheerEv = last.events.filter(function (e) { return e.kind === 'chat' && e.data.type === 'cheer'; })[0];
  ok(cheerEv && cheerEv.data.by === 'FoxFan', 'a !cheer queued before the race shows up with the viewer\'s display name', cheerEv ? cheerEv.text : 'none');
  ok(last.inputs.chatEffects.length === 3, 'record.inputs.chatEffects keeps boost, sabotage and cheer', JSON.stringify(last.inputs.chatEffects));
  const copies = recs.map(function (r) { return JSON.parse(JSON.stringify(r)); });
  copies.forEach(function (c) { c.ticks = []; c.ticksStripped = true; });
  const again = copies.map(function (c) { return SD.race.simulate(SD.game.replayInputs(c)).hash; });
  eq(again, recs.map(function (r) { return r.hash; }), 'saved records (JSON round trip, ticks stripped) replay from record.inputs to the same hash');
  eq(last.engineVersion, SD.race.ENGINE_VERSION, 'records carry the race engine version');
  const hist = SD.state.get().raceHistory;
  hist[hist.length - 1].engineVersion = SD.race.ENGINE_VERSION - 1;
  const stale = SD.game.replayLastRace();
  ok(stale.ok === false && stale.stale === true, 'a race saved by an older engine is reported as stale, not as a hash mismatch', stale.message);
  SD.clock.reset();
})();

// =============================================================================
section('I. Day events');
// =============================================================================
(function () {
  const DE = SD.DATA.DAY_EVENTS;
  ok(DE.length >= 6, 'at least 6 day events', DE.length + ': ' + DE.map(function (e) { return e.id; }).join(', '));
  const N = 400;
  function batch(dayEvent, tag) {
    const agg = { ev: 0, crits: 0, spread: 0, stam: 0, sp: 0, xp: 0, byEvent: {}, perf: {} };
    for (let i = 0; i < N; i++) {
      const field = rosterField('day' + tag, i).map(function (r) { return Object.assign({}, r, { owner: 'Owner' }); });
      const rec = sim(field, { seed: seedOf('day' + tag, i), dayEvent: dayEvent });
      agg.ev += rec.summary.eventsCount;
      agg.crits += rec.summary.critsCount;
      const times = rec.results.map(function (r) { return r.timeSec; });
      const m = times.reduce(function (a, b) { return a + b; }, 0) / times.length;
      agg.spread += Math.sqrt(times.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / times.length);
      rec.entrants.forEach(function (e) { agg.stam += e.stamMax; agg.perf[e.runnerId] = e.perf.MID; });
      rec.results.forEach(function (r) { agg.sp += r.spOwner; agg.xp += r.xp; });
      rec.events.forEach(function (e) { if (e.kind === 'event' && !e.hidden) agg.byEvent[e.data.eventId] = (agg.byEvent[e.data.eventId] || 0) + 1; });
    }
    return agg;
  }
  const base = batch(null, 'x');
  DE.forEach(function (ev) {
    const m = SD.events.dayModifiers(ev);
    const keys = Object.keys(ev.modifiers || {});
    if (!keys.length) { ok(true, ev.name + ': no modifiers (the ordinary day)'); return; }
    const got = batch(ev.id, 'x');
    const notes = [];
    keys.forEach(function (k) {
      let pass = false, detail = '';
      if (k === 'eventRate') { const r = got.ev / base.ev; pass = m.eventRate > 1 ? r > 1 + (m.eventRate - 1) * 0.6 : r < 1 - (1 - m.eventRate) * 0.6; detail = 'events x' + r.toFixed(2); }
      else if (k === 'sigmaMult') { const r = got.spread / base.spread; pass = m.sigmaMult < 1 ? r < 0.97 : r > 1.03; detail = 'finish-time spread x' + r.toFixed(2); }
      else if (k === 'critMult') { const r = got.crits / base.crits; pass = Math.abs(r - m.critMult) < 0.15; detail = 'crits x' + r.toFixed(2); }
      else if (k === 'poolMult') { const r = got.stam / base.stam; pass = Math.abs(r - m.poolMult) < 0.005; detail = 'stamina pools x' + r.toFixed(3); }
      else if (k === 'spMult') { const r = got.sp / base.sp; pass = Math.abs(r - m.spMult) < 0.02; detail = 'owner SP x' + r.toFixed(2); }
      else if (k === 'xpMult') { const r = got.xp / base.xp; pass = Math.abs(r - m.xpMult) < 0.02; detail = 'XP x' + r.toFixed(2); }
      else if (k === 'statWeight') {
        const stat = Object.keys(m.statWeight)[0];
        const hi = ROSTER.slice().sort(function (a, b) { return b.stats[stat] - a.stats[stat]; })[0];
        const lo = ROSTER.slice().sort(function (a, b) { return a.stats[stat] - b.stats[stat]; })[0];
        pass = got.perf[hi.id] > base.perf[hi.id] && got.perf[lo.id] < base.perf[lo.id];
        detail = stat + ' x' + m.statWeight[stat] + ': ' + hi.name + ' MID perf ' + base.perf[hi.id].toFixed(1) + ' -> ' + got.perf[hi.id].toFixed(1) +
          ', ' + lo.name + ' ' + base.perf[lo.id].toFixed(1) + ' -> ' + got.perf[lo.id].toFixed(1);
      } else if (k === 'eventWeights') {
        const id = Object.keys(m.eventWeights)[0];
        const share = function (a) { return (a.byEvent[id] || 0) / Math.max(1, a.ev); };
        const r = share(got) / share(base);
        pass = r > 1.4;
        detail = id + ' share x' + r.toFixed(2);
      } else { detail = 'unknown modifier'; }
      notes.push(detail);
      ok(pass, ev.name + ': ' + k + ' changes the race', detail);
    });
    line(pad(ev.name, 20) + notes.join('; '));
  });
})();

// -----------------------------------------------------------------------------
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
