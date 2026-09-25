#!/usr/bin/env node
/*
 * Spirit Derby - tools/persistence-test.js (M6)
 * Persistence hardening (plan section 8):
 *   A  the M1 fixture (tools/fixtures/save-m1.json: schema 1, 4 roster runners without rosterKey /
 *      lifetime / effects / ribbonColor / trainStreak / daily, no players / bets / raceEffects /
 *      achievements, M1 settings only, a race interrupted mid-playback) loads through
 *      persistence.load(): backup written, MIGRATIONS[2] + normalize fill every newer field,
 *      meta.migratedFrom = 1, the interrupted race is cancelled, the roster is reconciled
 *      (6 missing roster runners spawned, the 4 legacy ones get their rosterKey, nothing
 *      duplicated); then viewers join / claim / bet and a race is played; export -> import is
 *      lossless; save -> load is lossless
 *   B  normalize(): idempotent on a fresh state, fills an M2-era player, repairs wrong types
 *      (settings, runner fields set to null, duplicate ids, duplicate bets, broken effects, a
 *      malformed race in progress)
 *   C  roster reconciliation: a runner added to SD.DATA.ROSTER shows up in state.create() and in
 *      existing saves on load, exactly once, with a unique id and name
 *   D  interrupted-race recovery: bets refunded (SP back, spent total reversed), paid effects
 *      queued again, log line; a race saved as 'finished' is applied by game.init()
 *   E  backup key: written before a migration, before an import, and for unreadable saves
 *   F  raceHistory: ticks kept for the last HISTORY_FULL_LOGS races only, HISTORY_MAX cap, quota
 *      fallback keeps 2 full logs
 *   G  stats() + state:saved, setAutoSave / flush (beforeunload), clear()
 *   H  spiritderby.ui prefs (SD.ui.dom.prefs): merge, corrupt JSON, survives RESET ALL
 *
 *   node tools/persistence-test.js [--verbose]
 * Uses a fake localStorage (installed before the core loads) so the real storage path runs.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// Fake localStorage (with an optional quota) - must exist before persistence.js probes it
// -----------------------------------------------------------------------------
const fakeStorage = {
  data: Object.create(null),
  quota: Infinity,
  writes: 0,
  getItem: function (k) { return k in this.data ? this.data[k] : null; },
  setItem: function (k, v) {
    v = String(v);
    if (v.length > this.quota) { const e = new Error('QuotaExceededError (fake)'); e.name = 'QuotaExceededError'; throw e; }
    this.writes++;
    this.data[k] = v;
  },
  removeItem: function (k) { delete this.data[k]; },
  clear: function () { this.data = Object.create(null); }
};
globalThis.localStorage = fakeStorage;

const SD = require('./load-core.js');
require('../js/ui/dom.js');               // SD.ui.dom.prefs (spiritderby.ui) - DOM-free helpers only

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

function diff(a, b, p) {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return p + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return p + '.length';
    for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], p + '[' + i + ']'); if (d) return d; }
    return null;
  }
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return p + ' keys ' + ka.join() + ' / ' + kb.join();
  for (let i = 0; i < ka.length; i++) { const d = diff(a[ka[i]], b[ka[i]], p + '.' + ka[i]); if (d) return d; }
  return null;
}
function sameState(a, b) {
  a = JSON.parse(JSON.stringify(a)); b = JSON.parse(JSON.stringify(b));
  delete a.log; delete b.log; delete a.meta.updatedAt; delete b.meta.updatedAt;
  return diff(a, b, 'state');
}

let NOW = 1767225600000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }
const P = SD.persistence;
const KEY = P.KEY;
SD.achievements.init();

function resetRuntime() {
  const rt = SD.state.runtime;
  rt.cooldowns = {}; rt.runnerCooldowns = {}; rt.activity = {}; rt.chatFeed = []; rt.hypeRecent = {};
}
function boot(state) {
  resetRuntime();
  SD.state.set(state);
  SD.game.init();
  SD.betting.clearCache();
  return SD.state.get();
}
function say(user, text, opts) {
  tick(11000);
  return SD.processCommand(user, text, Object.assign({ source: 'twitch' }, opts || {}));
}

const FIXTURE = path.join(__dirname, 'fixtures', 'save-m1.json');
const fixtureText = fs.readFileSync(FIXTURE, 'utf8');
const fixture = JSON.parse(fixtureText);

// =============================================================================
section('A. M1 fixture: load, migrate, play, round trip');
// =============================================================================
(function () {
  eq(fixture.schemaVersion, 1, 'the fixture is a schema-1 (M1) save');
  ok(!('players' in fixture) && !('bets' in fixture) && !('raceEffects' in fixture) && !('achievements' in fixture), 'the fixture predates players / bets / effects / achievements');
  ok(fixture.runners.length === 4 && fixture.runners.every(function (r) { return !r.rosterKey && !r.lifetime && !r.effects && !('ribbonColor' in r) && !r.trainStreak; }),
    'the fixture has 4 M1-shaped runners');
  ok(fixture.currentRace && fixture.currentRace.status === 'running', 'the fixture was saved mid-race');
  eq(P.SCHEMA_VERSION, 2, 'SCHEMA_VERSION is 2');
  ok(typeof P.MIGRATIONS[2] === 'function', 'MIGRATIONS[2] exists');
  eq(P.storageKind(), 'localStorage', 'persistence uses (fake) localStorage when it exists');

  fakeStorage.clear();
  fakeStorage.setItem(KEY, fixtureText);
  const res = P.load();
  ok(res.fromStorage, 'load() reads the M1 save');
  eq(res.migratedFrom, 1, 'load() reports migratedFrom 1');
  eq(fakeStorage.getItem(P.BACKUP_KEY), fixtureText, 'the raw M1 save was copied to spiritderby.backup before migrating');
  const st = res.state;
  eq(st.schemaVersion, 2, 'migrated state is schema 2');
  eq(st.meta.migratedFrom, 1, 'MIGRATIONS[2] records meta.migratedFrom');
  ok(st.log.some(function (e) { return /Save upgraded from schema v1 to v2/.test(e.text); }), 'the upgrade is logged');
  ok(st.currentRace === null, 'the interrupted race was cancelled');
  ok(st.log.some(function (e) { return /interrupted/.test(e.text); }), 'the interruption is logged');

  // every field added since M1
  ok(st.players && typeof st.players === 'object' && Array.isArray(st.bets) && Array.isArray(st.raceEffects), 'players / bets / raceEffects exist');
  ok(Array.isArray(st.achievements.unlocked) && st.achievements.progress && typeof st.achievements.progress === 'object', 'achievements.unlocked + progress exist');
  ok(Array.isArray(st.season.history) && typeof st.season.racesRun === 'number' && typeof st.season.startedAt === 'number', 'season.history / racesRun / startedAt');
  ok(typeof st.meta.actionCounter === 'number' && typeof st.meta.betCounter === 'number', 'meta.actionCounter / betCounter');
  const s = st.settings;
  ok(s.twitch && s.twitch.channel === '' && s.twitch.enabled === false && s.bridge && s.bridge.url === 'ws://localhost:8765' && s.bridge.enabled === false,
    'settings.twitch / settings.bridge defaults');
  ok(s.openTraining === true && s.allowCreate === true && s.resultsAutoCloseMs === SD.CONFIG.UI.RESULTS_AUTO_CLOSE_MS && s.userCooldownS === SD.CONFIG.COOLDOWNS.USER_S &&
    s.seedOverride === null, 'settings.openTraining / allowCreate / resultsAutoCloseMs / userCooldownS / seedOverride defaults');
  eq(s.finalStretchSpeedup, 1.75, 'saved settings are kept (finalStretchSpeedup 1.75)');
  const legacy = st.runners.slice(0, 4);
  ok(legacy.every(function (r) {
    return r.lifetime && typeof r.lifetime.races === 'number' && Array.isArray(r.effects) && r.ribbonColor === null &&
      r.trainStreak && r.trainStreak.count === 0 && r.daily && r.daily.snacks === 0 && typeof r.createdAt === 'number';
  }), 'runner.lifetime / effects / ribbonColor / trainStreak / daily / createdAt filled');
  ok(legacy[3].baseStats && legacy[3].baseStats.speed === legacy[3].stats.speed, 'a runner without baseStats gets its current stats as base');
  eq(legacy.map(function (r) { return r.record.races; }), [2, 2, 2, 2], 'saved runner records are kept');

  // roster reconciliation
  eq(st.runners.length, SD.DATA.ROSTER.length, 'the 6 roster runners missing from the M1 save were spawned');
  eq(st.runners.map(function (r) { return r.rosterKey; }), SD.DATA.ROSTER.map(function (e) { return e.key; }), 'every roster entry exactly once, legacy runners got their rosterKey');
  const ids = st.runners.map(function (r) { return r.id; });
  eq(ids.filter(function (x, i) { return ids.indexOf(x) === i; }).length, ids.length, 'runner ids are unique');
  ok(st.meta.runnerCounter >= st.runners.length, 'runnerCounter is past every id');
  ok(res.rosterAdded.length === 6, 'load() lists the reconciled runners', res.rosterAdded.length);
  ok(st.log.some(function (e) { return /New to the roster/.test(e.text); }), 'the new roster runners are logged');

  // play on the migrated save
  boot(st);
  eq(SD.game.replayLastRace().stale, true, 'an M1 race (no engineVersion) is reported as stale by REPLAY');
  ok(say('FoxFan', '!join').ok && say('FoxFan', '!claim moss').ok, 'a viewer joins and claims on the migrated save');
  ok(say('MothMom', '!join').ok, 'a second viewer joins');
  const fo = SD.betting.fieldOdds(SD.state.get());
  const target = fo.entrants[0];
  const bet = say('MothMom', '!bet ' + target.runnerId + ' 50');
  ok(bet.ok, 'a bet on the migrated save', bet.message);
  const train = say('FoxFan', '!train speed');
  ok(train.ok, '!train on a migrated runner', train.message);
  const started = SD.game.startRace();
  ok(started.ok, 'a race starts on the migrated save', started.message);
  const done = SD.game.endRace();
  ok(done.ok && done.record && done.record.results.length === started.record.entrants.length, 'and finishes');
  const after = SD.state.get();
  eq(after.raceHistory.length, 3, 'the new race joins the M1 history');
  eq(after.bets.length, 0, 'the bet was resolved');
  ok(SD.game.replayLastRace().sameHash === true, 'the new race replays to the same hash');
  ok(after.season.day === 2, 'the 3rd race of the day advanced the day (M1 raceIndexInDay 2 was kept)', after.season.day);

  // export -> import
  const json = P.exportJSON();
  const imp = P.importJSON(json);
  ok(imp.ok, 'importJSON of the export succeeds');
  const d1 = sameState(JSON.parse(json), SD.state.get());
  ok(!d1, 'export -> import is lossless (except the "Save imported." log line)', d1);
  // save -> load
  P.save();
  const again = P.load();
  ok(again.fromStorage && again.migratedFrom === null && again.rosterAdded.length === 0, 'the upgraded save loads again without migrating or respawning');
  const d2 = sameState(SD.state.get(), again.state);
  ok(!d2, 'save -> load is lossless', d2);
  // importing the raw M1 fixture works too
  const imp2 = P.importJSON(fixtureText);
  ok(imp2.ok && imp2.migratedFrom === 1 && SD.state.get().schemaVersion === 2 && SD.state.get().currentRace === null, 'IMPORT JSON of the M1 save migrates it as well');
})();

// =============================================================================
section('B. normalize()');
// =============================================================================
(function () {
  const fresh = SD.state.create({ seedSalt: 99 });
  const copy = JSON.parse(JSON.stringify(fresh));
  P.normalize(copy);
  const d = sameState(fresh, copy);
  ok(!d, 'normalize() leaves a fresh state unchanged', d);
  const twice = JSON.parse(JSON.stringify(copy));
  P.normalize(twice);
  ok(!sameState(copy, twice), 'normalize() is idempotent');

  // An M2-era player (no lifetime / backing / achievements) and a v1 state around it.
  const st = JSON.parse(JSON.stringify(fresh));
  st.schemaVersion = 1;
  st.players = { foxfan: { username: 'foxfan', displayName: 'FoxFan', joinedAt: 1, lastSeen: 2, lastDailyDay: 's1d1', spiritPoints: 180.7, runnerId: 'r02', isMod: false,
    stats: { commands: 4, trains: 2 } } };
  st.runners[1].owner = 'FoxFan';
  const m = P.migrate(st);
  const p = m.players.foxfan;
  ok(p.lifetime && p.lifetime.trains === 0 && p.backing && p.backing.runnerId === null && Array.isArray(p.achievements), 'player.lifetime / backing / achievements filled');
  ok(p.stats.commands === 4 && p.stats.betsWon === 0 && p.spiritPoints === 180, 'player stats kept, missing counters 0, SP floored to an integer');
  eq(m.meta.migratedFrom, 1, 'meta.migratedFrom on a migrated v1 state');

  // Broken types everywhere.
  const bad = JSON.parse(JSON.stringify(fresh));
  bad.schemaVersion = 2;
  bad.settings.distance = '1600';
  bad.settings.runnerCount = 99;
  bad.settings.eventFrequency = 'mayhem';
  bad.settings.twitch = 'fox';
  bad.settings.hypeMultiplier = null;
  bad.settings.seedOverride = 'abc';
  bad.meta.raceCounter = null;
  bad.season.day = 42;
  bad.season.activeDayEvent = 'noSuchEvent';
  bad.hype.value = 999;
  bad.runners[0].record = null;
  bad.runners[0].lifetime = null;
  bad.runners[0].level = 'x';
  bad.runners[0].energy = null;
  bad.runners[1].stats = null;
  bad.runners[2].id = bad.runners[3].id;              // duplicate id
  bad.runners[4].mood = 'Grumpy';
  bad.runners.push(null);
  bad.players = {
    a: { username: 'a', displayName: 'A', spiritPoints: 100, stats: {}, lifetime: {} },
    b: { username: 'b', displayName: 'B', spiritPoints: 10, stats: {}, lifetime: {} }
  };
  bad.bets = [
    { id: 'b1', username: 'a', runnerId: 'r05', amount: 20, odds: 3 },
    { id: 'b2', username: 'a', runnerId: 'r06', amount: 30, odds: 2 },   // a second open bet from the same viewer
    { id: 'b3', username: 'b', runnerId: 'nope', amount: 10, odds: 2 },  // unknown runner
    null
  ];
  bad.raceEffects = [{ type: 'boost', runnerId: 'r05', by: 'a', count: 0 }, { type: 'teleport', runnerId: 'r05' }, 'x'];
  bad.currentRace = { status: 'running', record: { id: 'x' } };           // malformed record
  bad.log = [null, { t: 1, text: 'ok' }];
  const n = P.migrate(bad);
  eq([n.settings.distance, n.settings.runnerCount, n.settings.eventFrequency, n.settings.hypeMultiplier, n.settings.seedOverride],
    [1200, SD.CONFIG.RACE.MAX_RUNNERS, 'normal', 1, null], 'settings of the wrong type / out of range are repaired');
  ok(n.settings.twitch && n.settings.twitch.channel === '' && n.settings.twitch.enabled === false, 'a non-object settings.twitch is replaced');
  ok(n.meta.raceCounter === 0 && n.season.day === n.season.daysPerSeason && n.season.activeDayEvent === null && n.hype.value === n.hype.max, 'meta / season / hype numbers clamped');
  const r0 = n.runners[0];
  ok(r0.record && r0.record.races === 0 && r0.lifetime && r0.lifetime.races === 0 && r0.level === 1 && r0.energy === SD.runners.energyMax(1),
    'runner fields saved as null are rebuilt (record, lifetime, level, energy)');
  ok(SD.CONFIG.STATS.every(function (k) { return n.runners[1].stats[k] === 30; }), 'a runner with stats:null gets default stats');
  eq(n.runners[4].mood, SD.CONFIG.MOOD.DEFAULT, 'an unknown mood becomes the default mood');
  eq(n.runners.length, fresh.runners.length, 'null runner entries are dropped');
  const rids = n.runners.map(function (r) { return r.id; });
  eq(rids.filter(function (x, i) { return rids.indexOf(x) === i; }).length, rids.length, 'duplicate runner ids get new ids');
  eq(n.bets.map(function (b) { return b.id; }), ['b2'], 'one open bet per viewer (the newest), bets on unknown runners dropped');
  eq(n.players.a.spiritPoints, 120, 'the older duplicate bet was refunded');
  eq(n.raceEffects.length, 1, 'broken queued effects dropped');
  eq(n.raceEffects[0].count, 1, 'effect count repaired');
  ok(n.currentRace && n.currentRace.record === null, 'a malformed race in progress is marked for recovery');
  P.recoverInterruptedRace(n);
  ok(n.currentRace === null, 'recoverInterruptedRace() clears it');
  ok(n.log.every(function (e) { return e && typeof e === 'object'; }), 'broken log entries dropped');
})();

// =============================================================================
section('C. Roster reconciliation (data-driven roster)');
// =============================================================================
(function () {
  const saved = JSON.parse(JSON.stringify(SD.state.create({ seedSalt: 5 })));
  saved.runners.push(Object.assign(JSON.parse(JSON.stringify(saved.runners[0])), { id: 'r11', rosterKey: null, custom: true, name: 'Pebble Dash', owner: null }));
  saved.meta.runnerCounter = 11;
  const entry = { key: 'pebbleDash', name: 'Pebble Dash', emoji: '\u{1F994}', badgeColor: '#8a6a4a', species: 'Bramble Hedgehog',
    personality: 'Test runner.', description: 'Added to data.js after the save was made.', style: 'paceChaser',
    stats: { speed: 40, stamina: 40, power: 40, wisdom: 40, luck: 40 }, abilityId: 'moonlightPace' };
  SD.DATA.ROSTER.push(entry);
  try {
    const created = SD.state.create({ seedSalt: 6 });
    ok(created.runners.some(function (r) { return r.rosterKey === 'pebbleDash'; }), 'state.create() spawns a runner added to DATA.ROSTER');
    const n1 = P.migrate(JSON.parse(JSON.stringify(saved)));
    const hits = n1.runners.filter(function (r) { return r.rosterKey === 'pebbleDash'; });
    eq(hits.length, 1, 'an existing save gets the new roster runner on load');
    ok(hits[0].id !== 'r11' && n1.runners.filter(function (r) { return r.id === hits[0].id; }).length === 1, 'with an unused id', hits[0].id);
    eq(hits[0].name, 'Pebble Dash 2', 'a viewer-created runner keeps the name; the roster runner gets a unique one');
    const n2 = P.migrate(JSON.parse(JSON.stringify(n1)));
    eq(n2.runners.length, n1.runners.length, 'loading again does not duplicate it');
    eq(P.reconcileRoster(n2).length, 0, 'reconcileRoster() on a complete state adds nothing');
  } finally {
    SD.DATA.ROSTER.pop();
  }
})();

// =============================================================================
section('D. Interrupted-race recovery');
// =============================================================================
(function () {
  fakeStorage.clear();
  const st = boot(SD.state.create({ seedSalt: 777, dayEventId: 'clearSkies' }));
  ['FoxFan', 'MothMom', 'AcornAndy'].forEach(function (u) { say(u, '!join'); });
  const fo = SD.betting.fieldOdds(st);
  const a = fo.entrants[0].runnerId, b = fo.entrants[1].runnerId;
  ok(say('FoxFan', '!bet ' + a + ' 60').ok && say('MothMom', '!bet ' + b + ' all').ok, 'two bets placed');
  ok(say('AcornAndy', '!boost ' + a).ok, 'a paid boost queued');
  const spBefore = { foxfan: st.players.foxfan.spiritPoints, mothmom: st.players.mothmom.spiritPoints };
  const spentBefore = st.players.foxfan.stats.spSpentTotal;
  const started = SD.game.startRace();
  ok(started.ok, 'race started');
  ok(SD.state.get().raceEffects.length === 0, 'the boost was consumed at the gate');
  P.save();                                                    // the page closes during the countdown
  const res = P.load();
  const r = res.state;
  ok(r.currentRace === null, 'on load the interrupted race is gone');
  eq(r.bets.length, 0, 'its bets are refunded');
  eq(r.players.foxfan.spiritPoints, spBefore.foxfan + 60, 'FoxFan got the 60 SP back');
  ok(r.players.mothmom.spiritPoints > spBefore.mothmom, 'MothMom got her all-in back');
  eq(r.players.foxfan.stats.spSpentTotal, spentBefore - 60, 'a refund reverses the spend (not "SP earned")');
  ok(r.raceEffects.some(function (e) { return e.type === 'boost' && e.runnerId === a && e.by === 'acornandy'; }), 'the paid boost is queued again');
  ok(r.log.some(function (e) { return /interrupted/.test(e.text) && /2 bets were refunded/.test(e.text); }), 'the log says so');

  // A race saved as 'finished' (results not applied yet) is applied by game.init().
  const st2 = boot(SD.state.create({ seedSalt: 778, dayEventId: 'clearSkies' }));
  const s2 = SD.game.startRace();
  SD.game.setRaceStatus('finished');
  P.save();
  const res2 = P.load();
  ok(res2.state.currentRace && res2.state.currentRace.status === 'finished', 'a finished-but-unapplied race survives load');
  boot(res2.state);
  const after = SD.state.get();
  ok(after.currentRace === null && after.raceHistory.length === 1 && after.raceHistory[0].id === s2.record.id, 'game.init() applies its results');
  ok(st2 !== after, 'fresh objects after load');
})();

// =============================================================================
section('E. Backup key');
// =============================================================================
(function () {
  fakeStorage.clear();
  fakeStorage.setItem(KEY, '{ not json');
  const r1 = P.load();
  ok(!r1.fromStorage && r1.state && r1.state.runners.length === SD.DATA.ROSTER.length, 'an unreadable save starts a fresh game');
  eq(fakeStorage.getItem(P.BACKUP_KEY), '{ not json', 'and keeps the unreadable text in spiritderby.backup');
  ok(r1.state.log.some(function (e) { return /unreadable/.test(e.text); }), 'with a warning in the log');

  fakeStorage.setItem(KEY, JSON.stringify({ schemaVersion: 99, runners: [] }));
  const r2 = P.load();
  ok(!r2.fromStorage && /newer version/.test(r2.state.log[r2.state.log.length - 1].text), 'a save from a newer build is refused, not overwritten silently');
  ok(/"schemaVersion":99/.test(fakeStorage.getItem(P.BACKUP_KEY)), 'and backed up');

  boot(SD.state.create({ seedSalt: 31 }));
  const current = P.exportJSON();
  const imp = P.importJSON(JSON.stringify(SD.state.create({ seedSalt: 32 })));
  ok(imp.ok, 'import ok');
  eq(fakeStorage.getItem(P.BACKUP_KEY), current, 'IMPORT JSON backs up the game it replaces');
  eq(P.importJSON('nope').ok, false, 'invalid JSON is refused');
  eq(P.importJSON('{"runners": 3}').ok, false, 'a save without a runners list is refused');
})();

// =============================================================================
section('F. Race history trimming');
// =============================================================================
(function () {
  boot(SD.state.create({ seedSalt: 4040, dayEventId: 'clearSkies' }));
  SD.game.updateSettings({ autoAdvanceDay: true });
  const H = SD.CONFIG.HISTORY_FULL_LOGS;
  for (let i = 0; i < H + 3; i++) {
    let s = SD.game.startRace();
    if (!s.ok) { SD.game.nextDay(); s = SD.game.startRace(); }
    ok(s.ok, 'race ' + (i + 1) + ' starts', s.message);
    SD.game.endRace();
  }
  const hist = SD.state.get().raceHistory;
  eq(hist.length, H + 3, (H + 3) + ' races in the history');
  eq(hist.map(function (r) { return r.ticks.length > 0; }), hist.map(function (r, i) { return i >= hist.length - H; }), 'only the last ' + H + ' keep their ticks');
  ok(hist.slice(0, 3).every(function (r) { return r.ticksStripped === true; }), 'stripped records are flagged ticksStripped');
  ok(SD.game.replayLastRace().sameHash, 'replay still works');
  const copy = JSON.parse(JSON.stringify(SD.state.get()));
  const again = copy.raceHistory.slice(0, 3).map(function (rec) { return SD.race.simulate(SD.game.replayInputs(rec)).hash; });
  eq(again, hist.slice(0, 3).map(function (r) { return r.hash; }), 'stripped records still replay to their hash');

  const maxWas = SD.CONFIG.HISTORY_MAX;
  SD.CONFIG.HISTORY_MAX = 5;
  P.trimHistory(SD.state.get());
  eq(SD.state.get().raceHistory.length, 5, 'HISTORY_MAX caps the history (oldest dropped)');
  SD.CONFIG.HISTORY_MAX = maxWas;

  // Quota: the first write fails -> retry with 2 full logs.
  const full = JSON.stringify(SD.state.get()).length;
  fakeStorage.quota = full - 1;
  const saved = P.save();
  fakeStorage.quota = Infinity;
  ok(saved, 'a save over quota retries with fewer tick logs', P.lastError() && P.lastError().message);
  eq(SD.state.get().raceHistory.filter(function (r) { return r.ticks.length; }).length, 2, 'the retry keeps 2 full race logs');
})();

// =============================================================================
section('G. stats(), state:saved, autosave / flush, clear');
// =============================================================================
(function () {
  const st = boot(SD.state.create({ seedSalt: 55 }));
  say('FoxFan', '!join');
  let evt = null;
  const off = SD.bus.on(SD.EVENTS.STATE_SAVED, function (p) { evt = p; });
  ok(P.save(), 'save() ok');
  off();
  const stt = P.stats();
  eq(stt.bytes, fakeStorage.getItem(KEY).length, 'stats().bytes = size of the saved JSON');
  eq([stt.races, stt.players, stt.runners, stt.schema, stt.storage], [0, 1, SD.DATA.ROSTER.length, 2, 'localStorage'], 'stats() counts races / players / runners');
  eq(stt.savedAt, NOW, 'stats().savedAt');
  ok(evt && evt.bytes === stt.bytes && evt.at === NOW && evt.stats && evt.stats.players === 1, 'save() emits state:saved { at, bytes, stats }');

  // Node saves immediately on every mutation; with autosave off only flush()/save() write.
  const writes = fakeStorage.writes;
  P.setAutoSave(false);
  say('FoxFan', '!claim');
  eq(fakeStorage.writes, writes, 'setAutoSave(false): mutations do not write');
  ok(P.stats().dirty, 'the game is marked dirty');
  ok(P.flush() && fakeStorage.writes === writes + 1, 'flush() (beforeunload / pagehide) writes the pending save');
  ok(P.flush() && fakeStorage.writes === writes + 1, 'flush() with nothing pending does not write again');
  P.setAutoSave(true);
  say('FoxFan', '!train speed');
  ok(fakeStorage.writes > writes + 1, 'autosave back on');
  ok(JSON.parse(fakeStorage.getItem(KEY)).players.foxfan.runnerId === st.players.foxfan.runnerId, 'the saved game has the latest change');
  P.clear();
  eq(fakeStorage.getItem(KEY), null, 'clear() removes spiritderby.save');
})();

// =============================================================================
section('H. spiritderby.ui prefs');
// =============================================================================
(function () {
  const prefs = SD.ui.dom.prefs;
  ok(prefs && typeof prefs.read === 'function' && typeof prefs.write === 'function', 'SD.ui.dom.prefs exists');
  eq(prefs.KEY, 'spiritderby.ui', 'prefs key');
  fakeStorage.removeItem(prefs.KEY);
  eq(prefs.read(), {}, 'no prefs yet -> {}');
  prefs.write({ overlay: true, tab: 'chat' });
  prefs.write({ boards: { category: 'runnerWins', scope: 'all' } });
  eq(prefs.read(), { overlay: true, tab: 'chat', boards: { category: 'runnerWins', scope: 'all' } }, 'patches merge');
  eq(prefs.get('tab', 'log'), 'chat', 'get() reads one key');
  eq(prefs.get('missing', 'log'), 'log', 'get() falls back');
  boot(SD.state.create({ seedSalt: 8 }));
  P.save();
  SD.game.resetAll();
  ok(fakeStorage.getItem(prefs.KEY) && prefs.read().tab === 'chat', 'RESET ALL keeps the UI prefs (only the game is reset)');
  fakeStorage.setItem(prefs.KEY, '{broken');
  eq(prefs.read(), {}, 'corrupt prefs read as {}');
  prefs.write({ overlay: false });
  eq(prefs.read(), { overlay: false }, 'and are replaced on the next write');
})();

console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
