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
 *   E  backup key: written before a migration and before an import; unreadable / newer saves are
 *      held untouched (review batch 6: see tools/durability-test.js for the rest)
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
  keyWrites: Object.create(null),   // per-key count (review batch 6: a save also stamps spiritderby.lock)
  getItem: function (k) { return k in this.data ? this.data[k] : null; },
  setItem: function (k, v) {
    v = String(v);
    if (v.length > this.quota) { const e = new Error('QuotaExceededError (fake)'); e.name = 'QuotaExceededError'; throw e; }
    this.writes++;
    this.keyWrites[k] = (this.keyWrites[k] || 0) + 1;
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
  eq(P.SCHEMA_VERSION, 4, 'SCHEMA_VERSION is 4 (review batch 2: runner.ownerKey; review batch 6: slim history records)');
  ok(typeof P.MIGRATIONS[2] === 'function', 'MIGRATIONS[2] exists');
  eq(P.storageKind(), 'localStorage', 'persistence uses (fake) localStorage when it exists');

  fakeStorage.clear();
  fakeStorage.setItem(KEY, fixtureText);
  const res = P.load();
  ok(res.fromStorage, 'load() reads the M1 save');
  eq(res.migratedFrom, 1, 'load() reports migratedFrom 1');
  eq(fakeStorage.getItem(P.BACKUP_KEY), fixtureText, 'the raw M1 save was copied to spiritderby.backup before migrating');
  const st = res.state;
  eq(st.schemaVersion, 4, 'migrated state is schema 4');
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
  // Review batch 5: an export leaves out meta.seedSalt (the import draws a new salt), so the salt is
  // compared separately and everything else must match.
  ok(!('seedSalt' in JSON.parse(json).meta), 'the export does not carry meta.seedSalt');
  ok(Number.isInteger(SD.state.get().meta.seedSalt), 'the imported game has a seed salt again');
  const importedNoSalt = JSON.parse(JSON.stringify(SD.state.get()));
  delete importedNoSalt.meta.seedSalt;
  const d1 = sameState(JSON.parse(json), importedNoSalt);
  ok(!d1, 'export -> import is lossless (except the "Save imported." log line and the new seed salt)', d1);
  // save -> load
  P.save();
  const again = P.load();
  ok(again.fromStorage && again.migratedFrom === null && again.rosterAdded.length === 0, 'the upgraded save loads again without migrating or respawning');
  const d2 = sameState(SD.state.get(), again.state);
  ok(!d2, 'save -> load is lossless', d2);
  // importing the raw M1 fixture works too
  const imp2 = P.importJSON(fixtureText);
  ok(imp2.ok && imp2.migratedFrom === 1 && SD.state.get().schemaVersion === 4 && SD.state.get().currentRace === null, 'IMPORT JSON of the M1 save migrates it as well');
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
  // Review batch 6 (lifecycle-concurrency#12, persistence#3): the unreadable save is no longer copied to
  // the single backup slot and then overwritten by the fresh game's first autosave; it is held.
  eq(fakeStorage.getItem(KEY), '{ not json', 'and the unreadable text stays untouched in spiritderby.save');
  ok(r1.held === true && P.role() === 'held' && /unreadable/.test(r1.error), 'load() reports it (held, error)');
  ok(r1.state.log.some(function (e) { return /unreadable/.test(e.text); }), 'with a warning in the log');

  fakeStorage.setItem(KEY, JSON.stringify({ schemaVersion: 99, runners: [] }));
  const r2 = P.load();
  ok(!r2.fromStorage && /newer version/.test(r2.state.log[r2.state.log.length - 1].text), 'a save from a newer build is refused, not overwritten silently');
  ok(/"schemaVersion":99/.test(fakeStorage.getItem(KEY)) && r2.held, 'and held untouched');
  ok(P.releaseHeld().ok && P.role() === 'writer' && /"schemaVersion":99/.test(fakeStorage.getItem(P.RESCUE_KEY)), 'START NEW GAME copies it to spiritderby.rescue first');

  boot(SD.state.create({ seedSalt: 31 }));
  say('FoxFan', '!join');                      // a game someone played (a blank game is not backed up: see durability-test)
  // The backup is the full local state (salt included: it never leaves this PC), not an export.
  const current = JSON.stringify(SD.state.get());
  const imp = P.importJSON(JSON.stringify(SD.state.create({ seedSalt: 32 })));
  ok(imp.ok, 'import ok');
  eq(fakeStorage.getItem(P.BACKUP_KEY), current, 'IMPORT JSON backs up the game it replaces');
  eq(P.importJSON('nope').ok, false, 'invalid JSON is refused');
  eq(P.importJSON('{"runners": 3}').ok, false, 'a save without a runners list is refused');
})();

// =============================================================================
section('E2. Import keeps this PC\'s Twitch / bridge settings (review batch 1, integrations#7)');
// =============================================================================
(function () {
  fakeStorage.clear();
  const local = SD.state.create({ seedSalt: 41 });
  local.settings.twitch = { channel: 'myownchannel', enabled: true };
  local.settings.bridge = { url: 'ws://localhost:9001', enabled: false };
  boot(local);
  const foreign = SD.state.create({ seedSalt: 42 });
  foreign.settings.twitch = { channel: 'someoneelse', enabled: true };
  foreign.settings.bridge = { url: 'wss://relay.attacker.example/x', enabled: true };
  foreign.settings.playbackSpeed = 2;
  const imp = P.importJSON(JSON.stringify(foreign));
  ok(imp.ok, 'import ok');
  const s = SD.state.get().settings;
  eq([s.twitch, s.bridge], [{ channel: 'myownchannel', enabled: true }, { url: 'ws://localhost:9001', enabled: false }],
    "the file's Twitch channel, bridge URL and auto-connect flags are ignored; this PC's are kept");
  eq(s.playbackSpeed, 2, 'every other setting still comes from the file');
  eq(imp.ignoredConnection, true, 'importJSON reports that the connection settings were ignored');
  const saved = JSON.parse(fakeStorage.getItem(KEY)).settings;
  eq([saved.twitch.channel, saved.bridge.url, saved.bridge.enabled], ['myownchannel', 'ws://localhost:9001', false],
    'the saved game (next boot / auto-connect) keeps the local values');

  // same connection settings in the file (e.g. re-importing your own export) → nothing to report
  const own = P.importJSON(P.exportJSON());
  eq([own.ok, own.ignoredConnection], [true, false], 're-importing your own export reports nothing ignored');

  // no current game → the defaults (auto-connect off), never the file's values
  SD.state.set(null);
  const imp2 = P.importJSON(JSON.stringify(foreign));
  const s2 = SD.state.get().settings;
  eq([imp2.ok, s2.twitch.enabled, s2.twitch.channel, s2.bridge.enabled, s2.bridge.url],
    [true, false, '', false, 'ws://localhost:8765'], 'with no current game the defaults are used (auto-connect off)');

  // the M1 fixture (M1 settings, no twitch / bridge keys) still imports with the local values
  boot(local);
  const imp3 = P.importJSON(fixtureText);
  eq([imp3.ok, SD.state.get().settings.twitch.channel, SD.state.get().schemaVersion], [true, 'myownchannel', 4], 'the M1 fixture imports and keeps the local connection settings');
  eq(imp3.ignoredConnection, false, 'the M1 fixture carries no connection settings → nothing reported as ignored (fix round 1)');

  // a fresh install's export (default connection values) into a configured install → nothing ignored
  boot(local);
  const imp4 = P.importJSON(JSON.stringify(SD.state.create({ seedSalt: 43 })));
  eq([imp4.ok, imp4.ignoredConnection, SD.state.get().settings.twitch.channel], [true, false, 'myownchannel'],
    "a file with only the default connection values reports nothing ignored");
  // only the risky part differs (auto-connect on) → reported
  const onlyFlag = SD.state.create({ seedSalt: 44 });
  onlyFlag.settings.bridge = { url: 'ws://localhost:9001', enabled: true };
  eq(P.importJSON(JSON.stringify(onlyFlag)).ignoredConnection, true, "a file that would switch this PC's auto-connect on is reported");

  // EXPORT JSON hides a relay token in the bridge URL; re-importing it keeps the real local URL
  const withToken = SD.state.create({ seedSalt: 45 });
  withToken.settings.bridge = { url: 'ws://localhost:8765/?token=s3cret', enabled: true };
  boot(withToken);
  const exported = P.exportJSON();
  ok(exported.indexOf('s3cret') < 0, 'EXPORT JSON does not contain the relay token');
  eq(JSON.parse(exported).settings.bridge, { url: 'ws://localhost:8765/?token=…', enabled: true }, 'the exported bridge URL shows ?token=…');
  eq(SD.state.get().settings.bridge.url, 'ws://localhost:8765/?token=s3cret', 'exporting does not change the live settings');
  const back = P.importJSON(exported);
  eq([back.ok, back.ignoredConnection, SD.state.get().settings.bridge.url], [true, false, 'ws://localhost:8765/?token=s3cret'],
    're-importing your own export keeps the real URL and reports nothing ignored');
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
  eq([stt.races, stt.players, stt.runners, stt.schema, stt.storage], [0, 1, SD.DATA.ROSTER.length, 4, 'localStorage'], 'stats() counts races / players / runners');
  eq(stt.savedAt, NOW, 'stats().savedAt');
  ok(evt && evt.bytes === stt.bytes && evt.at === NOW && evt.stats && evt.stats.players === 1, 'save() emits state:saved { at, bytes, stats }');

  // Node saves immediately on every mutation; with autosave off only flush()/save() write.
  // (Counted on spiritderby.save itself: since review batch 6 a save also stamps spiritderby.lock.)
  const saves = function () { return fakeStorage.keyWrites[KEY] || 0; };
  const writes = saves();
  const allWrites = fakeStorage.writes;
  P.setAutoSave(false);
  say('FoxFan', '!claim');
  eq(fakeStorage.writes, allWrites, 'setAutoSave(false): mutations do not write');
  ok(P.stats().dirty, 'the game is marked dirty');
  ok(P.flush() && saves() === writes + 1, 'flush() (beforeunload / pagehide) writes the pending save');
  ok(P.flush() && saves() === writes + 1, 'flush() with nothing pending does not write again');
  P.setAutoSave(true);
  say('FoxFan', '!train speed');
  ok(saves() > writes + 1, 'autosave back on');
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

// =============================================================================
section('I. Schema 3: a v2 save with display-name owners (review batch 2, economy-abuse#1)');
// =============================================================================
// tools/fixtures/save-v2-display-names.json was exported by the v1.0.0 / batch-1 core (schema 2):
// Twitch viewer foxfan (display name 狐狸) claimed Moss Runner, Moonhoof, Thunder Fern and Ember Tail
// (every claim "succeeded" and none was ever usable: runner.owner held the display name), mothmom
// (MothMom) claimed Velvet Comet, bridge viewer user_42 (display name "Fox Fan") claimed Misty Gale,
// acornandy cheered, the roster TRAIN buttons added hype as 'streamer' (no such player), and a
// 6-runner race was saved 'finished' but not applied (entrants carry only the owner labels).
(function () {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'save-v2-display-names.json'), 'utf8');
  const v2 = JSON.parse(text);
  eq(v2.schemaVersion, 2, 'the fixture is a schema-2 save');
  eq(v2.runners.filter(function (r) { return r.owner === '狐狸'; }).length, 4, 'four runners are held under the display name 狐狸');
  ok(v2.runners.every(function (r) { return !('ownerKey' in r); }), 'no runner has an ownerKey yet');
  eq(Object.keys(v2.hype.contributions).sort(), ['acornandy', 'streamer'], "the roster buttons credited hype to 'streamer'");

  fakeStorage.clear();
  fakeStorage.setItem(KEY, text);
  const res = P.load();
  ok(res.fromStorage && res.migratedFrom === 2, 'load() migrates the v2 save', res.migratedFrom);
  eq(fakeStorage.getItem(P.BACKUP_KEY), text, 'the raw v2 save was backed up first');
  const st = res.state;
  eq([st.schemaVersion, st.meta.migratedFrom], [4, 2], 'schema 4, meta.migratedFrom 2');
  ok(st.log.some(function (e) { return /schema v3/.test(e.text) && /3 runners/.test(e.text) && /released/.test(e.text); }), 'the upgrade and the 3 released runners are logged');
  const R = function (id) { return st.runners.filter(function (r) { return r.id === id; })[0]; };
  eq([R('r04').ownerKey, R('r04').owner], ['foxfan', '狐狸'], "foxfan's last claim (his runnerId) is his: ownerKey = login, owner = display label");
  eq(['r01', 'r02', 'r03'].map(function (id) { return [R(id).ownerKey, R(id).owner]; }), [[null, null], [null, null], [null, null]],
    'the three hoarded runners nobody could use are released');
  eq([R('r05').ownerKey, R('r05').owner], ['mothmom', 'MothMom'], 'a case-variant owner keeps its runner');
  eq([R('r06').ownerKey, R('r06').owner], ['user_42', 'Fox Fan'], 'a bridge display name maps to the login that claimed it');
  eq(Object.keys(st.players).sort(), Object.keys(v2.players).sort(), 'every player is kept');
  eq(Object.keys(st.players).map(function (k) { return st.players[k].spiritPoints; }),
    Object.keys(st.players).map(function (k) { return v2.players[k].spiritPoints; }), 'SP balances are unchanged by the migration');
  eq(['foxfan', 'mothmom', 'user_42', 'acornandy'].map(function (k) { return st.players[k].runnerId; }), ['r04', 'r05', 'r06', null], 'player.runnerId agrees with runner.ownerKey');
  eq(st.currentRace.record.entrants.map(function (e) { return e.runnerId + ':' + e.ownerKeyAtRace; }).sort(),
    ['r01:null', 'r02:null', 'r03:null', 'r04:foxfan', 'r05:mothmom', 'r06:user_42'], 'the unapplied race gets entrant.ownerKeyAtRace');
  eq(st.currentRace.record.hash, v2.currentRace.record.hash, 'the record hash is untouched');

  // Boot applies the finished race: owners are paid by login; released runners pay nobody.
  const spBefore = {};
  Object.keys(st.players).forEach(function (k) { spBefore[k] = st.players[k].spiritPoints; });
  const results = st.currentRace.record.results;
  const spOf = function (id) { return results.filter(function (x) { return x.runnerId === id; })[0].spOwner; };
  let finished = null;
  const off = SD.bus.on(SD.EVENTS.RACE_FINISHED, function (p) { finished = p; });
  boot(st);
  if (typeof off === 'function') off();
  const s = SD.state.get();
  ok(s.currentRace === null && s.raceHistory.length === 1 && !!finished, 'game.init() applied the finished race');
  const owners = ((finished && finished.payouts) || []).filter(function (x) { return x.role === 'owner'; })
    .map(function (x) { return x.username + ':' + x.runnerId + ':' + x.amount; }).sort();
  eq(owners, ['foxfan:r04:' + spOf('r04'), 'mothmom:r05:' + spOf('r05'), 'user_42:r06:' + spOf('r06')],
    'owner payouts go to the logins (foxfan for Ember Tail only, user_42 for Misty Gale), none for the released runners');
  ok(spOf('r04') > 0 && s.players.foxfan.spiritPoints >= spBefore.foxfan + spOf('r04'), "foxfan's balance got Ember Tail's owner payout");
  eq(s.players.foxfan.stats.racesParticipated, 1, 'foxfan raced as an owner');

  // Playing on: foxfan now owns and can use his runner; the released runners are claimable again.
  const tw = { source: 'twitch', displayName: '狐狸' };
  const tr = say('foxfan', '!train speed', tw);
  ok(tr.ok, "foxfan's !train speed trains his own runner now", tr.message);
  eq(SD.players.runnerOf(s, 'foxfan') && SD.players.runnerOf(s, 'foxfan').id, 'r04', 'runnerOf(foxfan) is Ember Tail');
  ok(say('acornandy', '!claim moss', { displayName: 'AcornAndy' }).ok, 'a released runner can be claimed by another viewer');

  // The roster's old 'streamer' hype credit (no such player) never wins the season's Top hype card.
  const sum = SD.seasons.summary(s);
  ok(!sum.topHypeContributor || sum.topHypeContributor.username !== 'streamer', 'Top hype is never a key without a player', sum.topHypeContributor);
  ok(!Object.prototype.hasOwnProperty.call(s.hype.contributions, 'streamer'), "the v2 -> v3 upgrade dropped the console's old 'streamer' credit");

  // The same save where the chat panel's default "Streamer" sender had typed !join first (source
  // admin): the old core made that a player 'streamer' (shaped like any !join), and the roster
  // buttons / ADD HYPE then piled season hype onto it. The upgrade drops that credit; the player
  // itself is kept as an ordinary viewer.
  const v2c = JSON.parse(text);
  const pc = JSON.parse(JSON.stringify(v2c.players.acornandy));
  pc.username = 'streamer'; pc.displayName = 'Streamer'; pc.isMod = true; pc.runnerId = null;
  v2c.players.streamer = pc;
  v2c.hype.contributions.streamer = 24.4;
  const mc = P.migrate(v2c);
  ok(!!mc.players.streamer && mc.players.streamer.spiritPoints === pc.spiritPoints, "the console-joined player 'streamer' is kept, SP unchanged");
  eq(Object.keys(mc.hype.contributions), ['acornandy'], "its old 'streamer' season hype credit is dropped");
  const sc = SD.seasons.summary(mc);
  eq(sc.topHypeContributor && sc.topHypeContributor.username, 'acornandy', "Top hype is the viewer who cheered, not the console's old credit");
  // Only the v2 -> v3 step drops it: a schema-3 credit under 'streamer' is the Twitch viewer's own.
  mc.hype.contributions.streamer = 5;
  eq(P.migrate(JSON.parse(JSON.stringify(mc))).hype.contributions.streamer, 5, "a schema-3 'streamer' credit (the Twitch viewer) is kept");

  // Idempotent: loading the upgraded save again changes nothing.
  P.save();
  const again = P.load();
  ok(again.migratedFrom === null && !sameState(SD.state.get(), again.state), 'the upgraded save loads again unchanged', sameState(SD.state.get(), again.state));
})();

// Owner repair rules on hand-made legacy states.
(function () {
  const base = JSON.parse(JSON.stringify(SD.state.create({ seedSalt: 31 })));
  base.schemaVersion = 2;
  base.runners.forEach(function (r) { delete r.ownerKey; });
  const mk = function (u, d, runnerId) {
    return { username: u, displayName: d, joinedAt: 1, lastSeen: 1, lastDailyDay: 's1d1', spiritPoints: 100, runnerId: runnerId, isMod: false, stats: {} };
  };
  base.players = { kitsune_jp: mk('kitsune_jp', 'きつね', null), bob: mk('bob', 'Bob', 'r03'), carl: mk('carl', 'Carl', 'r04') };
  base.runners[0].owner = 'Kitsune_JP';     // label = the login in other case, but kitsune_jp.runnerId is null
  base.runners[1].owner = 'Ghost';          // nobody
  base.runners[2].owner = 'Bob';            // normal
  base.runners[3].owner = 'Somebody Else';  // carl points at it but the label is not carl
  const m = P.migrate(base);
  eq([m.runners[0].ownerKey, m.players.kitsune_jp.runnerId], ['kitsune_jp', m.runners[0].id], 'a login label pairs with a player holding no runner');
  eq([m.runners[1].ownerKey, m.runners[1].owner], [null, null], 'a label that matches no player is released');
  eq([m.runners[2].ownerKey, m.players.bob.runnerId], ['bob', 'r03'], 'a normal claim is kept');
  eq([m.runners[3].ownerKey, m.runners[3].owner, m.players.carl.runnerId], [null, null, null], "a runner whose label is not its pointer's player is released, and the pointer cleared");
  const again = P.migrate(JSON.parse(JSON.stringify(m)));
  ok(!sameState(m, again), 'a schema-3 state goes through migrate() unchanged');
})();

console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
