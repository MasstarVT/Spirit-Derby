#!/usr/bin/env node
/*
 * Spirit Derby - tools/import-test.js (review batch 7: import and normalisation hardening, boot robustness)
 *   A  a race saved as 'finished' whose record finishRace cannot apply (no summary, empty results, a
 *      null result, bad numbers) is refunded on import and never crashes a later boot (persistence#4)
 *   B  a well-formed 'finished' race is applied by IMPORT JSON itself, after state:loaded
 *      (lifecycle-concurrency#7); an unknown day event is rolled on import
 *   C  game.applyPending(): a finished race that still cannot be applied is cancelled (bets refunded),
 *      never thrown out of game.init()
 *   D  runner.record.bestTimes of the wrong type is repaired; finishRace is defensive (runners-data#1)
 *   E  a runner id that is not a string gets a new id; findRunner never throws (runners-data#2)
 *   F  track.js: entrant lanes are escaped integers and the distance is bounded; normalize() refuses
 *      a race in progress with bad lanes / a huge distance (ui-track#2)
 *   G  RESET ALL and IMPORT clear the per-game runtime maps (director-state#3)
 *   H  state.set() inside a mutation no longer breaks state:changed / autosave (director-state#8)
 *   I  boot order: game.init({ deferPending }) + applyPending() after achievements and listeners
 *      (ui-panels-boot#4)
 *   J  a retired runner's queued paid effects and open bets are refunded on import, its owner and the
 *      pointers at it cleared (gap1#4)
 *   K  hook events fire mid-mutation, as documented (director-state#10)
 *   L  persistence.bootRecovery('fresh' | 'backup') for the boot error overlay
 *
 *   node tools/import-test.js [--verbose]
 * Uses a fake localStorage (installed before the core loads) so the real storage path runs.
 */
'use strict';

const fakeStorage = {
  data: Object.create(null),
  getItem: function (k) { return k in this.data ? this.data[k] : null; },
  setItem: function (k, v) { this.data[k] = String(v); },
  removeItem: function (k) { delete this.data[k]; },
  clear: function () { this.data = Object.create(null); }
};
globalThis.localStorage = fakeStorage;

const SD = require('./load-core.js');
require('../js/ui/dom.js');
require('../js/ui/track.js');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
let passed = 0;
let failed = 0;
function section(t) { console.log('\n' + t); }
function ok(cond, name, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '')); }
  return !!cond;
}
function eq(a, b, name) { return ok(JSON.stringify(a) === JSON.stringify(b), name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function noThrow(fn, name) {
  try { return { ok: ok(true, name), value: fn() }; } catch (e) { ok(false, name, e && e.message); return { ok: false }; }
}

let NOW = 1767225600000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }
const P = SD.persistence;
const KEY = P.KEY;
const EV = SD.EVENTS;
SD.achievements.init();

function boot(state) {
  SD.state.resetRuntime();
  SD.state.set(state);
  SD.game.init();
  SD.betting.clearCache();
  return SD.state.get();
}
function say(user, text, opts) {
  tick(11000);
  return SD.processCommand(user, text, Object.assign({ source: 'twitch' }, opts || {}));
}
function S() { return SD.state.get(); }
function sp(k) { return S().players[k].spiritPoints; }
function exported() { return JSON.parse(P.exportJSON()); }
function runner(id) { return SD.state.runnerById(id); }
function lastLog(re) { return S().log.some(function (e) { return re.test(e.text); }); }
// Load what is stored and boot it the way a reload does (main.js order); returns the error, if any.
function reboot() {
  try {
    const res = P.load();
    SD.state.resetRuntime();
    SD.state.set(res.state);
    SD.game.init({ deferPending: true });
    SD.game.applyPending();
    return null;
  } catch (e) { return e; }
}

// =============================================================================
section('A. A finished race finishRace cannot apply is refunded, never crashes boot (persistence#4)');
// =============================================================================
(function () {
  const shapes = {
    'empty results, no summary': { id: 'x1', distance: 1200, entrants: [{ runnerId: 'r01', lane: 1 }], results: [] },
    'summary but empty results': { id: 'x2', distance: 1200, entrants: [{ runnerId: 'r01', lane: 1 }], results: [], summary: { winnerName: 'Moss' } },
    'a null result': { id: 'x3', distance: 1200, entrants: [{ runnerId: 'r01', lane: 1 }], results: [null], summary: {} },
    'a result without numbers': { id: 'x4', distance: 1200, entrants: [{ runnerId: 'r01', lane: 1 }], summary: {},
      results: [{ runnerId: 'r01', place: 1, timeSec: 'fast', xp: 10, energyDelta: -10, fatigueDelta: 5 }] },
    'stat changes on a prototype key': { id: 'x5', distance: 1200, entrants: [{ runnerId: 'r01', lane: 1 }], summary: {},
      results: [{ runnerId: 'r01', place: 1, timeSec: 70, xp: 10, energyDelta: -10, fatigueDelta: 5, statChanges: { constructor: 1 } }] }
  };
  Object.keys(shapes).forEach(function (label, i) {
    fakeStorage.clear();
    P.load();
    boot(SD.state.create({ seedSalt: 700 + i, dayEventId: 'clearSkies' }));
    say('FoxFan', '!join');
    const target = SD.betting.fieldOdds(S()).entrants[0].runnerId;
    ok(say('FoxFan', '!bet ' + target + ' 50').ok, label + ': FoxFan bets 50');
    const before = sp('foxfan');
    const exp = exported();
    exp.currentRace = { status: 'finished', startedAt: NOW, record: shapes[label] };
    const imp = P.importJSON(JSON.stringify(exp));
    ok(imp.ok, label + ': the import itself succeeds', imp.error);
    eq(S().currentRace, null, label + ': the race is not kept (it is treated as interrupted)');
    eq([sp('foxfan'), S().bets.length], [before + 50, 0], label + ': its open bet is refunded');
    ok(lastLog(/could not be used/), label + ': the log says why the race was cancelled');
    const st = SD.game.startRace();
    ok(st.ok, label + ': START works right away', st.message);
    SD.game.endRace();
    P.save();
    ok(reboot() === null && reboot() === null, label + ': reloading boots cleanly (twice)');
  });

  // Straight into storage (not through import): load() refunds it too.
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 710, dayEventId: 'clearSkies' }));
  P.save();
  const raw = JSON.parse(fakeStorage.getItem(KEY));
  raw.currentRace = { status: 'finished', startedAt: NOW, record: shapes['a null result'] };
  fakeStorage.setItem(KEY, JSON.stringify(raw));
  const err = reboot();
  ok(err === null, 'a stored save with a broken finished race boots', err && err.message);
  eq(S().currentRace, null, 'and the broken race is gone');
})();

// =============================================================================
section('B. IMPORT JSON applies a well-formed finished race at once (lifecycle-concurrency#7)');
// =============================================================================
(function () {
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 720, dayEventId: 'clearSkies' }));
  say('FoxFan', '!join');
  const start = SD.game.startRace();
  ok(start.ok, 'race started');
  SD.game.setRaceStatus('finished');
  const exp = exported();
  exp.season.activeDayEvent = 'noSuchDayEvent';
  SD.game.abortRace();
  const order = [];
  const offs = [EV.STATE_LOADED, EV.RACE_FINISHED].map(function (n) { return SD.bus.on(n, function () { order.push(n); }); });
  const imp = P.importJSON(JSON.stringify(exp));
  offs.forEach(function (off) { off(); });
  ok(imp.ok, 'import ok', imp.error);
  eq(imp.pendingRace, 'applied', 'importJSON reports the finished race as applied');
  const s = S();
  ok(s.currentRace === null && s.raceHistory.length === 1 && s.raceHistory[0].id === start.record.id, 'the race is applied during the import (history +1, no race left)');
  eq(order, [EV.STATE_LOADED, EV.RACE_FINISHED], 'state:loaded first (panels show the new game), then race:finished (results modal)');
  ok(!!SD.events.dayEventById(s.season.activeDayEvent), 'an unknown day event is re-rolled on import (not left empty until the next day)', s.season.activeDayEvent);
  const next = SD.game.startRace();
  ok(next.ok, 'START works right after the import', next.message);
  SD.game.endRace();
  eq(JSON.parse(fakeStorage.getItem(KEY)).currentRace, null, 'the stored game has no race left either');

  // A plain save (no race) reports nothing pending.
  eq(P.importJSON(P.exportJSON()).pendingRace, null, 'a save without a finished race: pendingRace null');
})();

// =============================================================================
section('C. game.applyPending(): a race that still cannot be applied is cancelled, not thrown');
// =============================================================================
(function () {
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 730, dayEventId: 'clearSkies' }));
  say('FoxFan', '!join');
  const target = SD.betting.fieldOdds(S()).entrants[0].runnerId;
  ok(say('FoxFan', '!bet ' + target + ' 40').ok, 'FoxFan bets 40');
  const before = sp('foxfan');
  ok(SD.game.startRace().ok, 'race started');
  SD.game.setRaceStatus('finished');
  // The live game (normalize() never saw it): a record without its summary.
  delete S().currentRace.record.summary;
  const r = noThrow(function () { return SD.game.init(); }, 'game.init() does not throw on a finished race it cannot apply');
  ok(r.value && r.value.pending && r.value.pending.cancelled === true, 'init() reports the pending race as cancelled', r.value);
  eq([S().currentRace, sp('foxfan')], [null, before + 40], 'the race is gone and the bet refunded');
  ok(lastLog(/could not be applied/), 'the log says why');

  // A runner the record needs is broken in the live game: finishRace throws half-way; applyPending
  // catches it and cancels the race instead of leaving it stuck.
  boot(SD.state.create({ seedSalt: 731, dayEventId: 'clearSkies' }));
  const st2 = SD.game.startRace();
  SD.game.setRaceStatus('finished');
  runner(st2.record.results[0].runnerId).lifetime = null;
  const errs = [];
  const origErr = console.error;
  console.error = function () { errs.push(Array.prototype.slice.call(arguments).join(' ')); };
  let res;
  try { res = SD.game.applyPending(); } finally { console.error = origErr; }
  ok(res && res.cancelled === true && S().currentRace === null, 'a throw inside finishRace cancels the race', res);
  ok(errs.some(function (x) { return /could not be applied/.test(x); }), 'and is reported on the console');
  ok(SD.game.startRace().ok, 'the next race starts');
  SD.game.endRace();
  eq(SD.game.applyPending(), null, 'applyPending() with nothing pending returns null');
})();

// =============================================================================
section('D. runner.record.bestTimes of the wrong type (runners-data#1)');
// =============================================================================
(function () {
  ['n/a', 0.5, true, [1200, 70]].forEach(function (bad) {
    fakeStorage.clear();
    P.load();
    boot(SD.state.create({ seedSalt: 740, dayEventId: 'clearSkies' }));
    const exp = exported();
    exp.runners[0].record.bestTimes = bad;
    ok(P.importJSON(JSON.stringify(exp)).ok, 'import with bestTimes = ' + JSON.stringify(bad));
    ok(!('bestTimes' in runner('r01').record), 'bestTimes ' + JSON.stringify(bad) + ' is removed on import');
    const st = SD.game.startRace({ runnerCount: SD.CONFIG.RACE.MAX_RUNNERS });
    ok(st.ok && st.record.entrants.some(function (e) { return e.runnerId === 'r01'; }), 'r01 races');
    const fin = noThrow(function () { return SD.game.endRace(); }, 'the race finishes (no TypeError half-way)');
    ok(fin.value && fin.value.ok && S().currentRace === null, 'currentRace is cleared');
    const bt = runner('r01').record.bestTimes;
    ok(bt && typeof bt === 'object' && bt[st.record.distance] > 0, 'finishRace wrote a real bestTimes map', bt);
  });
  // An object: only positive integer distances with a positive time are kept.
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 741, dayEventId: 'clearSkies' }));
  const exp = exported();
  exp.runners[0].record.bestTimes = { 1200: 70.5, 1600: 'fast', abc: 3, 2000: -1, 2400: null };
  P.importJSON(JSON.stringify(exp));
  eq(runner('r01').record.bestTimes, { 1200: 70.5 }, 'a bestTimes object keeps only valid entries');
  // finishRace is defensive even when the live game holds a primitive.
  runner('r01').record.bestTimes = 'n/a';
  ok(SD.game.startRace({ runnerCount: SD.CONFIG.RACE.MAX_RUNNERS }).ok, 'race with a live primitive bestTimes');
  const fin = noThrow(function () { return SD.game.endRace(); }, 'finishRace repairs a primitive bestTimes instead of throwing');
  ok(fin.value && fin.value.ok && typeof runner('r01').record.bestTimes === 'object', 'bestTimes is an object afterwards');
})();

// =============================================================================
section('E. A runner id that is not a string (runners-data#2)');
// =============================================================================
(function () {
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 750, dayEventId: 'clearSkies' }));
  say('alice', '!join');
  const exp = exported();
  exp.runners[9].id = 10;
  exp.runners[8].id = ['r09'];
  exp.runners[7].id = { id: 'r08' };
  ok(P.importJSON(JSON.stringify(exp)).ok, 'import ok');
  const ids = S().runners.map(function (r) { return r.id; });
  ok(ids.every(function (id) { return typeof id === 'string' && id; }), 'every runner id is a non-empty string', ids);
  eq(ids.filter(function (x, i) { return ids.indexOf(x) === i; }).length, ids.length, 'and unique');
  const names = S().runners.map(function (r) { return r.name; });
  eq(names.length, exp.runners.length, 'no runner was lost');
  ok(noThrow(function () { return SD.state.findRunner('moss'); }, 'findRunner by name does not throw').value.runner, 'findRunner("moss") finds Moss Runner');
  ['!inspect moss', '!claim moss', '!cheer ember', '!train speed'].forEach(function (cmd) {
    const r = say('alice', cmd);
    ok(r.ok, cmd + ' works after the import', r.message);
  });
  // findRunner itself tolerates a bad id in a live state (defence in depth).
  S().runners[5].id = 12345;
  ok(noThrow(function () { return SD.state.findRunner('ember'); }, 'findRunner with a numeric id in the live game does not throw').value, 'and still answers');
  ok(SD.state.findRunner('12345').runner === S().runners[5], 'a numeric id still matches its text form');
})();

// =============================================================================
section('F. Track lanes / distance from a record (ui-track#2)');
// =============================================================================
(function () {
  const evil = '1"><img src=x onerror=alert(1)>';
  // normalize(): a race in progress with a bad lane or a huge distance is not kept.
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 760, dayEventId: 'clearSkies' }));
  const st = SD.game.startRace();
  SD.game.setRaceStatus('finished');
  const exp = exported();
  SD.game.abortRace();
  const bad = JSON.parse(JSON.stringify(exp));
  bad.currentRace.record.entrants[0].lane = evil;
  const imp = P.importJSON(JSON.stringify(bad));
  ok(imp.ok && S().currentRace === null && imp.pendingRace === null, 'a finished race whose entrant lane is not an integer is refunded, not kept');
  const far = JSON.parse(JSON.stringify(exp));
  far.currentRace.record.distance = 1e15;
  P.importJSON(JSON.stringify(far));
  eq(S().currentRace, null, 'a race in progress with a distance of 1e15 m is not kept');
  ok(P.recordProblem(st.record, true) === null, 'a real engine record passes recordProblem');
  ok(/lane/.test(P.recordProblem(bad.currentRace.record, false)), 'recordProblem names the lane', P.recordProblem(bad.currentRace.record, false));
  // History: a record with an absurd distance is dropped (REPLAY would simulate it).
  ok(SD.game.startRace().ok, 'a race for the history');
  SD.game.endRace();
  const h2 = exported();
  h2.raceHistory.push(Object.assign(JSON.parse(JSON.stringify(h2.raceHistory[0])), { id: 'huge', distance: 1e15 }));
  P.importJSON(JSON.stringify(h2));
  ok(S().raceHistory.every(function (r) { return r.id !== 'huge'; }), 'a history record with distance 1e15 is dropped');
  ok(SD.game.replayLastRace().ok, 'REPLAY LAST RACE still works');

  // track.build(): escape + bound, whatever the record holds.
  function el() {
    return {
      innerHTML: '', textContent: '', style: { setProperty: function () {}, transform: '' },
      classList: { add: function () {}, remove: function () {}, toggle: function () {} },
      setAttribute: function () {}, removeAttribute: function () {},
      querySelectorAll: function () { return []; }, querySelector: function () { return null; }
    };
  }
  const t = Object.create(SD.ui.track);
  t.root = el();
  t.refs = { lanes: el(), posList: el(), ruler: el() };
  t.setPhase = function () {};
  t.renderTicker = function () {};
  t.measure = function () {};
  const rec = { id: 'evil', distance: 1e7, trackName: 'x', results: [],
    entrants: [{ runnerId: 'r01', name: 'Moss', lane: evil }, { runnerId: 'r02', name: 'Fern', lane: 2 }] };
  const t0 = Date.now();
  noThrow(function () { t.build(rec); }, 'track.build() on a crafted record does not throw');
  const html = t.refs.lanes.innerHTML + t.refs.posList.innerHTML;
  ok(html.indexOf('<img src=x') < 0 && html.indexOf('onerror') < 0, 'the lane value never reaches the HTML raw');
  ok(/--lane:1"/.test(t.refs.lanes.innerHTML) && /--lane:2"/.test(t.refs.lanes.innerHTML), 'lanes are small integers (a bad one falls back to its position)');
  const marks = (t.refs.ruler.innerHTML.match(/ruler__mark"/g) || []).length;
  ok(marks <= 60 && Date.now() - t0 < 2000, 'a huge distance builds a bounded ruler at once', marks);
  t.build({ id: 'ok', distance: 1600, trackName: 'y', results: [], entrants: [{ runnerId: 'r01', name: 'Moss', lane: 1 }] });
  eq((t.refs.ruler.innerHTML.match(/ruler__mark"/g) || []).length, 7, 'a normal 1600 m race still gets its 7 marks (200 m apart)');
})();

// =============================================================================
section('G. RESET ALL and IMPORT clear the per-game runtime maps (director-state#3)');
// =============================================================================
(function () {
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 770, dayEventId: 'clearSkies' }));
  const rt = SD.state.runtime;
  rt.nervousCheers = SD.util.dict({ r01: 9 });
  rt.hypeRecent = SD.util.dict({ carol: NOW });
  rt.activity = SD.util.dict({ carol: NOW });
  rt.chatFeed.push({ text: 'hello' });
  const feedLen = rt.chatFeed.length;
  SD.game.resetAll();
  eq([Object.keys(rt.nervousCheers).length, Object.keys(rt.hypeRecent).length, Object.keys(rt.activity).length], [0, 0, 0],
    'RESET ALL clears nervous cheers, recent hype and activity');
  eq(rt.chatFeed.length, feedLen, 'the chat feed (this session) is kept');
  // The failure scenario: a Nervous r01 in the new game needs all its cheers again.
  SD.state.mutate('test', function (s) { SD.state.runnerById('r01', s).mood = 'Nervous'; });
  say('carol', '!join');
  say('carol', '!cheer r01');
  eq(runner('r01').mood, 'Nervous', "one cheer does not cure the new game's Nervous r01");

  // A rest cooldown from game A does not follow r01 into imported game B.
  boot(SD.state.create({ seedSalt: 771, dayEventId: 'clearSkies' }));
  const B = P.exportJSON();
  boot(SD.state.create({ seedSalt: 772, dayEventId: 'clearSkies' }));
  SD.state.mutate('tired', function (s) { SD.state.runnerById('r01', s).energy = 10; });
  ok(SD.game.restRunner('r01').ok, 'r01 rests in game A');
  ok(!SD.game.restRunner('r01').ok, 'and is on its rest cooldown');
  ok(P.importJSON(B).ok, 'import game B');
  SD.state.mutate('tired', function (s) { SD.state.runnerById('r01', s).energy = 10; });
  const r = SD.game.restRunner('r01');
  ok(r.ok, "game B's r01 is not held by game A's rest cooldown", r.message);
  say('dave', '!join');
  tick(1000);
  ok(say('dave', '!cheer r02').ok, 'chat cooldowns start clean after an import');
})();

// =============================================================================
section('H. state.set() inside a mutation (director-state#8)');
// =============================================================================
(function () {
  boot(SD.state.create({ seedSalt: 780, dayEventId: 'clearSkies' }));
  let changed = 0;
  const off = SD.bus.on(EV.STATE_CHANGED, function () { changed++; });
  SD.state.mutate('x', function () { SD.state.set(SD.state.get()); });
  eq(changed, 1, 'the mutation that called set() still emits state:changed');
  let inside = null;
  SD.state.mutate('y', function () { inside = SD.state.isMutating(); });
  SD.game.addHype(5);
  SD.game.addHype(5);
  off();
  eq(changed, 4, 'later mutations keep emitting state:changed (autosave keeps running)');
  eq([inside, SD.state.isMutating()], [true, false], 'isMutating() is right inside and outside');
  // A set() to a new game inside a mutation: the outer mutation ends on the new game.
  const other = SD.state.create({ seedSalt: 781, dayEventId: 'clearSkies' });
  SD.state.mutate('swap', function () { SD.state.set(other); });
  ok(S() === other && !SD.state.isMutating(), 'set() to another game inside a mutation takes effect when it ends');
})();

// =============================================================================
section('I. Boot order: the finished race is applied once everything listens (ui-panels-boot#4)');
// =============================================================================
(function () {
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 790, dayEventId: 'clearSkies' }));
  say('AcornAndy', '!join');
  const st = SD.game.startRace();
  const winId = st.record.results[0].runnerId;
  SD.state.mutate('owner', function (s) {
    const e = s.currentRace.record.entrants.filter(function (x) { return x.runnerId === winId; })[0];
    e.ownerAtRace = 'AcornAndy';
    e.ownerKeyAtRace = 'acornandy';
  });
  SD.game.setRaceStatus('finished');
  P.save();
  // main.js order: achievements.init, game.init({ deferPending }), the panels and listeners, applyPending.
  SD.achievements.disable();
  const res = P.load();
  SD.state.resetRuntime();
  SD.state.set(res.state);
  SD.achievements.init();
  SD.game.init({ deferPending: true });
  ok(S().currentRace && S().currentRace.status === 'finished', 'game.init({ deferPending: true }) leaves the finished race for later');
  let shown = null;
  const off = SD.bus.on(EV.RACE_FINISHED, function (p) { shown = p; });
  const pending = SD.game.applyPending();
  off();
  ok(pending && pending.applied === true && S().currentRace === null, 'applyPending() applies it');
  ok(shown && shown.record.id === st.record.id, 'the results modal listener (registered after init) gets race:finished');
  ok(SD.achievements.has(S(), 'acornandy', 'ownersPride'), "the winner's owner gets Owner's Pride (achievements were listening)");
})();

// =============================================================================
section('J. A retired runner holds no paid effects, bets or owner (gap1#4)');
// =============================================================================
(function () {
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 800, dayEventId: 'clearSkies' }));
  ['troll', 'carol', 'dave', 'erin'].forEach(function (u) { say(u, '!join'); });
  const x = SD.betting.fieldOdds(S()).entrants[0].runnerId;
  ok(say('troll', '!claim ' + x).ok, 'troll claims ' + x);
  ok(say('carol', '!boost ' + x).ok, 'carol boosts it');
  ok(say('dave', '!sabotage ' + x).ok, 'dave sabotages it');
  ok(say('erin', '!bet ' + x + ' 30').ok, 'erin bets on it');
  ok(say('troll', '!cheer ' + x).ok, 'troll cheers it (backing)');
  const paid = {};
  S().raceEffects.forEach(function (e) { if (e.paid > 0) paid[e.by] = (paid[e.by] || 0) + e.paid; });
  ok(paid.carol > 0 && paid.dave > 0, 'both effects were paid', paid);
  const before = { carol: sp('carol'), dave: sp('dave'), erin: sp('erin') };
  const spent = S().players.carol.stats.spSpentTotal;
  const exp = exported();
  exp.runners.filter(function (r) { return r.id === x; })[0].retired = true;
  ok(P.importJSON(JSON.stringify(exp)).ok, 'import with the runner retired');
  const s = S();
  ok(s.raceEffects.every(function (e) { return e.runnerId !== x; }), 'no queued effect is left on the retired runner');
  eq([sp('carol'), sp('dave'), sp('erin')], [before.carol + paid.carol, before.dave + paid.dave, before.erin + 30],
    'the boost, the sabotage and the bet are refunded at once (not at the end of the season)');
  eq(s.players.carol.stats.spSpentTotal, spent - paid.carol, 'a refund reverses the spend');
  eq(s.bets.length, 0, 'the bet is gone');
  const rx = runner(x);
  eq([rx.ownerKey, rx.owner, s.players.troll.runnerId, s.players.troll.backing.runnerId], [null, null, null, null],
    "the retired runner has no owner, and troll's runnerId / backing no longer point at it");
  // Four pebbles fit again (the orphan no longer counts toward the per-race cap).
  const others = SD.betting.fieldOdds(s).entrants.map(function (e) { return e.runnerId; }).filter(function (id) { return id !== x; });
  ['f1', 'f2', 'f3', 'f4'].forEach(function (u, i) {
    say(u, '!join');
    ok(say(u, '!sabotage ' + others[i % others.length]).ok, u + ' can queue a sabotage');
  });
})();

// =============================================================================
section('K. Hook events fire mid-mutation, as documented (director-state#10)');
// =============================================================================
(function () {
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 810, dayEventId: 'clearSkies' }));
  ['alice', 'bob'].forEach(function (u) { say(u, '!join'); });
  const fo = SD.betting.fieldOdds(S());
  ok(say('alice', '!bet ' + fo.entrants[0].runnerId + ' 50').ok && say('bob', '!bet ' + fo.entrants[1].runnerId + ' 50').ok, 'two bets');
  ok(SD.game.startRace().ok, 'race started');
  const seen = [];
  const rec = function (name) { return SD.bus.on(name, function () { seen.push([name, SD.state.isMutating(), !!S().currentRace]); }); };
  const offs = [EV.BET_RESOLVED, EV.RACE_ABORTED].map(rec);
  SD.game.abortRace();
  offs.forEach(function (off) { off(); });
  const bet = seen.filter(function (x) { return x[0] === EV.BET_RESOLVED; })[0];
  const ab = seen.filter(function (x) { return x[0] === EV.RACE_ABORTED; })[0];
  ok(bet && bet[1] === true, 'bet:resolved (a hook event) fires while the mutation is still running');
  ok(ab && ab[1] === false && ab[2] === false, 'race:aborted (a director event) fires after it, on the finished state');
  ok(seen.indexOf(bet) < seen.indexOf(ab), 'so the hook event arrives first (the order game.js documents)');
})();

// =============================================================================
section('L. persistence.bootRecovery() for the boot error overlay');
// =============================================================================
(function () {
  fakeStorage.clear();
  P.load();
  boot(SD.state.create({ seedSalt: 820, dayEventId: 'clearSkies' }));
  say('FoxFan', '!join');
  P.save();
  const saved = fakeStorage.getItem(KEY);
  const backupGame = SD.state.create({ seedSalt: 821, dayEventId: 'clearSkies' });
  backupGame.players = {};
  const backupText = JSON.stringify(backupGame);
  fakeStorage.setItem(P.BACKUP_KEY, backupText);

  const r = P.bootRecovery('backup');
  ok(r.ok && r.rescued, 'RESTORE BACKUP from the overlay works', r);
  eq(fakeStorage.getItem(KEY), backupText, 'the backup is now the stored save');
  eq(fakeStorage.getItem(P.RESCUE_KEY), saved, 'the save that failed is kept in spiritderby.rescue');
  ok(JSON.parse(fakeStorage.getItem(P.LOCK_KEY)).released === true, 'the lock is released (the reload saves at once)');
  P.flush();
  ok(P.save() === false && fakeStorage.getItem(KEY) === backupText, 'this window writes nothing more (a flush on unload cannot put the broken game back)');
  const res = P.load();
  ok(res.fromStorage && P.role() === 'writer' && Object.keys(res.state.players).length === 0, 'the reload loads the backup and saves again');

  SD.state.set(res.state);
  P.save();
  const r2 = P.bootRecovery('fresh');
  ok(r2.ok && fakeStorage.getItem(KEY) === null, 'START NEW GAME removes the stored save');
  ok(fakeStorage.getItem(P.RESCUE_KEY) !== null, 'after keeping a rescue copy');
  const res2 = P.load();
  ok(!res2.fromStorage && P.role() === 'writer', 'the reload starts a new game as the writer');
  eq(P.bootRecovery('nope').ok, false, 'an unknown action is refused');
  fakeStorage.removeItem(P.BACKUP_KEY);
  eq(P.bootRecovery('backup').ok, false, 'RESTORE BACKUP without a backup is refused');

  // A read-only window (another window holds the lock) changes nothing.
  P.save();
  fakeStorage.setItem(P.LOCK_KEY, JSON.stringify({ id: 'other-window', n: 1, at: NOW }));
  P.load();
  eq(P.role(), 'reader', 'a second window is read-only');
  const before = fakeStorage.getItem(KEY);
  const r3 = P.bootRecovery('fresh');
  ok(!r3.ok && r3.readOnly && fakeStorage.getItem(KEY) === before, 'bootRecovery is refused there');
  fakeStorage.clear();
  P.load();
})();

console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
