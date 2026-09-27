#!/usr/bin/env node
/*
 * Spirit Derby - tools/hygiene-test.js (review batch 8: streamer tooling and live hygiene)
 *   A  SD.game.retireRunner / renameRunner / deleteRunner / removePlayer: a viewer-created runner (or
 *      a viewer) can be taken out of the game; bets and paid effects on it are refunded, owners and
 *      pointers cleared, the old name replaced in the log (gap1#1)
 *   B  demo bots play as '~' keys: live sources cannot use them, a real viewer never inherits a bot's
 *      profile, SD.game.purgeDemo() removes the bots' profiles and the runners they made (after a race),
 *      and a loaded save never keeps them (gap1#2)
 *   C  the chat panel stops the bots on state:loaded (RESET ALL / IMPORT) and when live chat connects,
 *      and refuses to start them while it is connected (gap1#3)
 *   D  the two-click confirm needs CONFIG.UI.CONFIRM_ARM_MS and ignores multi-clicks; RESET ALL keeps
 *      the wiped game as spiritderby.backup (ui-admin-chat-dom#1)
 *   E  NEXT DAY: a double-click advances one day, and on the last day it needs a confirm
 *      (lifecycle-concurrency#6)
 *   F  a new game drops the old game's queued season summaries (gap1#6)
 *   G  !create names cannot take over another runner's shorthand; findRunner reports a name / word
 *      prefix shared by two runners as ambiguous (gap3#1)
 *   H  amount / cancel / stat words and digit-only names are refused, and the !bet / !train parsers
 *      prefer an exact runner name (gap3#3)
 *   I  confusable (homoglyph) copies of a name are refused (xss-trust#8)
 *   J  admin drawer RUNNERS & VIEWERS actions call the new SD.game methods
 *   K  fix round 1: season summaries, tagged log scrubs, saved bot-made runners, TAKE OVER, key repeat
 *   L  review batch 11 (R12-R14): scrubs keep fixed words (tracks, species, labels) and other names
 *      ("Moss" removed, "Moss Runner" kept); the session's chat feed is scrubbed too
 *
 *   node tools/hygiene-test.js [--verbose]
 * Uses a fake localStorage (installed before the core loads) so the real storage path runs, and the
 * DOM-free parts of js/ui/dom.js, chat.js, season.js and admin.js with small stubs.
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
require('../js/ui/chat.js');
require('../js/ui/season.js');
require('../js/ui/admin.js');

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
function has(str, needle, name) { return ok(typeof str === 'string' && str.indexOf(needle) >= 0, name, 'expected "' + needle + '" in "' + str + '"'); }

let NOW = 1767225600000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }
const P = SD.persistence;
const EV = SD.EVENTS;
SD.achievements.init();

// UI stubs: no document in Node. Toasts and render scheduling are recorded, not drawn.
const dom = SD.ui.dom;
const toasts = [];
dom.toast = function (text, sev) { toasts.push({ text: String(text), sev: sev }); return null; };
dom.schedule = function () {};

function S() { return SD.state.get(); }
function fresh(opts) {
  fakeStorage.clear();
  P.load();
  SD.state.resetRuntime();
  SD.state.runtime.chatFeed = [];
  SD.state.set(SD.state.create(Object.assign({ seedSalt: 424242, dayEventId: 'clearSkies' }, opts || {})));
  SD.game.init();
  SD.betting.clearCache();
  tick(60000);
  return S();
}
function say(user, text, opts) {
  tick(11000);
  return SD.processCommand(user, text, Object.assign({ source: 'twitch' }, opts || {}));
}
function sp(k) { const p = SD.players.get(S(), k); return p ? p.spiritPoints : null; }
function claimAll() {
  SD.players.freeRunners(S()).forEach(function (r, i) {
    const u = 'owner' + (i + 1) + '_' + S().runners.length;
    say(u, '!join');
    say(u, '!claim ' + r.id);
  });
  return SD.players.freeRunners(S()).length;
}
function runAndFinish() {
  const st = SD.game.startRace();
  if (!st.ok) return st;
  return SD.game.endRace();
}
function logHas(re) { return S().log.some(function (e) { return re.test(e.text); }); }
// A runner made by admin SPAWN RUNNER with this exact name: the way a name that !create now refuses
// ends up in an older save.
function legacyRunner(name) {
  const r = SD.game.spawnRunner({});
  r.name = name;
  SD.betting.clearCache();
  return r;
}

// =============================================================================
section('A. Retire / rename / delete a runner, remove a viewer (gap1#1)');
// =============================================================================
(function () {
  fresh();
  eq(claimAll(), 0, 'every roster runner has an owner');
  ok(say('troll', '!join').ok, 'troll joins');
  const made = say('troll', '!create Rude Name');
  ok(made.ok, '!create Rude Name is accepted (no word filter)', made.message);
  const x = S().runners.filter(function (r) { return r.name === 'Rude Name'; })[0];
  ok(!!x && x.ownerKey === 'troll', 'troll owns the new runner');
  S().settings.runnerCount = 10;
  // Make sure the runner is in the next field so bets on it are possible.
  SD.betting.clearCache();
  say('bob', '!join');
  const bobStart = sp('bob');
  const inField = !!SD.betting.fieldOdds(S()).byId[x.id];
  if (!inField) SD.state.mutate('test', function () { S().settings.runnerCount = 10; });
  const b = say('bob', '!bet ' + x.id + ' 20');
  ok(b.ok, 'bob bets 20 on Rude Name', b.message);
  const boost = say('bob', '!boost ' + x.id);
  ok(boost.ok, 'bob boosts Rude Name (paid effect queued)', boost.message);
  ok(sp('bob') < bobStart, 'bob spent SP');
  say('bob', '!cheer ' + x.id);
  eq(S().players.bob.backing.runnerId, x.id, 'bob backs Rude Name');

  // Refused while a race exists.
  const st = SD.game.startRace();
  ok(st.ok, 'a race starts', st.message);
  const during = SD.game.retireRunner(x.id);
  ok(!during.ok && /race/i.test(during.message), 'retire is refused while a race exists', during.message);
  ok(!SD.game.removePlayer('troll').ok, 'remove viewer is refused while a race exists');
  ok(!SD.game.renameRunner(x.id, 'Kind Name').ok, 'rename is refused while a race exists');
  SD.game.abortRace();
  ok(!S().currentRace, 'race aborted (bets refunded, effects queued again)');
  ok(say('bob', '!bet ' + x.id + ' 20').ok, 'bob bets 20 on Rude Name again');

  // RENAME
  const bad = SD.game.renameRunner(x.id, 'Comet');
  ok(!bad.ok && bad.invalidName, 'rename follows the !create rules ("Comet" takes Velvet Comet\'s shorthand)', bad.message);
  const rn = SD.game.renameRunner(x.id, 'Kind Name');
  ok(rn.ok, 'rename to Kind Name', rn.message);
  eq(x.name, 'Kind Name', 'the runner has its new name');
  ok(!logHas(/Rude Name/), 'the old name is gone from the log');
  ok(logHas(/Kind Name/), 'the log shows the new name');
  eq(S().bets.filter(function (bb) { return bb.runnerId === x.id; }).map(function (bb) { return bb.runnerName; }), ['Kind Name'], 'open bets show the new name');
  eq(SD.state.findRunner('rude').none, true, 'chat can no longer find the old name');
  eq(SD.state.findRunner('kind').runner && SD.state.findRunner('kind').runner.id, x.id, 'chat finds the new name');
  ok(SD.game.renameRunner(x.id, 'Kind Names').ok, 'a rename may keep the runner\'s own words');
  SD.game.renameRunner(x.id, 'Kind Name');

  // RETIRE
  const spBefore = sp('bob');
  let retiredEv = null, resolved = null;
  const off1 = SD.bus.on(EV.RUNNER_RETIRED, function (p) { retiredEv = p; });
  const off2 = SD.bus.on(EV.BET_RESOLVED, function (p) { resolved = p; });
  const rt = SD.game.retireRunner(x.id);
  off1(); off2();
  ok(rt.ok, 'retire', rt.message);
  ok(x.retired === true, 'runner.retired = true');
  eq(rt.refunded, { bets: 1, effects: 1 }, 'its open bet and its paid boost were refunded');
  eq(sp('bob'), spBefore + 20 + SD.CONFIG.ECONOMY.BOOST_COST, 'bob got the bet and the boost back');
  eq(S().bets.filter(function (bb) { return bb.runnerId === x.id; }).length, 0, 'no bet on it remains');
  eq(S().raceEffects.filter(function (e) { return e.runnerId === x.id; }).length, 0, 'no queued effect on it remains (cheers dropped)');
  eq([x.ownerKey, x.owner, S().players.troll.runnerId], [null, null, null], 'owner released on both sides');
  eq(S().players.bob.backing, { runnerId: null, actions: 0 }, 'backing on it cleared');
  ok(retiredEv && retiredEv.runnerId === x.id && !retiredEv.deleted, 'runner:retired emitted');
  ok(resolved && resolved.refunded && resolved.reason === 'runnerRetired', 'bet:resolved {refunded} emitted for the refund');
  eq(SD.state.findRunner('kind').none, true, 'chat cannot find a retired runner');
  ok(!SD.game.previewField(10).some(function (r) { return r.id === x.id; }), 'a retired runner is never in the field');
  ok(!SD.game.retireRunner(x.id).ok, 'retiring twice is refused');
  const r2 = say('troll', '!claim');
  ok(!r2.ok, 'troll cannot get it back with !claim', r2.message);

  // DELETE
  ok(!SD.game.deleteRunner('r01').ok, 'roster runners cannot be deleted (retire them)');
  const del = SD.game.deleteRunner(x.id);
  ok(del.ok, 'delete the (retired) viewer-made runner', del.message);
  ok(!SD.state.runnerById(x.id), 'it is gone from state.runners');
  ok(!logHas(/Kind Name/) && logHas(/\(removed runner\)/), 'its name is replaced in the log');
  ok(SD.runners.checkName(S(), 'Kind Name').ok, 'its name is free again');
  ok(!SD.leaderboards.all(S(), 'runnerXp', 'all').some(function (e) { return e.id === x.id; }), 'not on the all-time boards');
  const run = runAndFinish();
  ok(run.ok, 'races still run after a delete', run.message);

  // REMOVE PLAYER
  ok(say('troll', '!create Spare Wheel').ok, 'troll creates another runner');
  const y = SD.players.runnerOf(S(), 'troll');
  say('troll', '!bet ' + SD.betting.fieldOdds(S()).entrants[0].runnerId + ' 10');
  let removedEv = null;
  const off3 = SD.bus.on(EV.PLAYER_REMOVED, function (p) { removedEv = p; });
  const rp = SD.game.removePlayer('Troll');
  off3();
  ok(rp.ok, 'remove the viewer troll', rp.message);
  ok(!SD.players.get(S(), 'troll'), 'the profile is gone');
  eq([y.ownerKey, y.owner], [null, null], 'their runner is free again');
  eq(S().bets.filter(function (bb) { return bb.username === 'troll'; }).length, 0, 'their bets are dropped');
  ok(!S().achievements.unlocked.some(function (a) { return a.username === 'troll'; }), 'their achievements are gone');
  ok(!Object.prototype.hasOwnProperty.call(S().achievements.progress, 'troll'), 'their achievement counters are gone');
  ok(!Object.prototype.hasOwnProperty.call(S().hype.contributions, 'troll'), 'their hype credit is gone');
  ok(removedEv && removedEv.username === 'troll' && !removedEv.demo, 'player:removed emitted');
  ok(!S().log.some(function (e) { return (e.username === 'troll' || e.by === 'troll') && /troll/.test(e.text); }), 'log lines about them no longer name them');
  const back = say('troll', '!join');
  say('newbie', '!join');
  ok(back.ok && /Welcome/.test(back.message) && sp('troll') === sp('newbie'), 'if they come back they start afresh', back.message);
  ok(!SD.game.removePlayer('nobody_here').ok, 'removing an unknown viewer is refused');
})();

// =============================================================================
section('B. Demo bots play as ~ keys and are cleaned up (gap1#2)');
// =============================================================================
(function () {
  fresh();
  eq(SD.players.demoKey('FoxFan'), '~foxfan', 'demoKey(FoxFan) = ~foxfan');
  ok(SD.players.isDemoKey('~foxfan') && !SD.players.isDemoKey('foxfan'), 'isDemoKey');
  const tw = SD.processCommand('~foxfan', '!join', { source: 'twitch' });
  ok(!tw.ok && tw.reserved, 'a ~ key from Twitch is refused', tw.message);
  const br = SD.processCommand('~foxfan', '!join', { source: 'bridge' });
  ok(!br.ok && br.reserved, 'a ~ key from the bridge is refused', br.message);
  ok(!SD.players.get(S(), '~foxfan'), '... and no profile is made');
  const bot = SD.processCommand('~foxfan', '!join', { source: 'sim', displayName: 'FoxFan' });
  ok(bot.ok, 'the demo bot (source sim) joins', bot.message);
  eq(S().players['~foxfan'].displayName, 'FoxFan', 'the bot shows as FoxFan');
  tick(11000);
  ok(SD.processCommand('~foxfan', '!claim moss', { source: 'sim', displayName: 'FoxFan' }).ok, 'the bot claims Moss Runner');
  tick(11000);
  const target = SD.betting.fieldOdds(S()).entrants[1].runnerId;
  ok(SD.processCommand('~foxfan', '!bet ' + target + ' 30', { source: 'sim', displayName: 'FoxFan' }).ok, 'the bot bets');
  tick(11000);
  ok(SD.processCommand('~foxfan', '!boost ' + target, { source: 'sim', displayName: 'FoxFan' }).ok, 'the bot boosts a runner');
  // A real viewer with the same name is a different player.
  const real = say('FoxFan', '!join');
  ok(real.ok && /Welcome/.test(real.message), 'the real Twitch foxfan gets a brand-new profile', real.message);
  say('newbie', '!join');
  eq(sp('foxfan'), sp('newbie'), '... with only what any new viewer gets');
  ok(!SD.players.runnerOf(S(), 'foxfan'), '... and no runner');

  // Bot-made runner: once every runner is owned the bot can !create.
  claimAll();
  tick(11000);
  SD.processCommand('~mothmom', '!join', { source: 'sim', displayName: 'MothMom' });
  tick(11000);
  const mk = SD.processCommand('~mothmom', '!create Pebble Dash', { source: 'sim', displayName: 'MothMom' });
  ok(mk.ok, 'a bot creates a runner', mk.message);
  const botMade = SD.players.runnerOf(S(), '~mothmom');
  ok(botMade && SD.state.runtime.demoRunners[botMade.id] === true, 'runtime.demoRunners remembers it');

  // purge refused during a race, done after it
  const st = SD.game.startRace();
  ok(st.ok, 'a race starts');
  const early = SD.game.purgeDemo();
  ok(!early.ok && early.pending, 'purgeDemo waits for the race', early.message);
  SD.game.endRace();
  const moss = SD.state.runnerById('r01');
  const res = SD.game.purgeDemo();
  ok(res.ok, 'purgeDemo after the race');
  eq(res.removed, ['~foxfan', '~mothmom'], 'both bot profiles removed');
  eq(res.runners, [botMade.id], 'the bot-made runner is deleted');
  ok(!SD.state.runnerById(botMade.id), '... and gone from the game');
  eq(moss.ownerKey, null, 'Moss Runner is free again');
  eq(S().bets.filter(function (b) { return b.username.charAt(0) === '~'; }).length, 0, 'no bot bets remain');
  eq(S().raceEffects.filter(function (e) { return String(e.by).charAt(0) === '~'; }).length, 0, 'no bot effects remain');
  ok(!S().achievements.unlocked.some(function (a) { return a.username.charAt(0) === '~'; }), 'no bot achievements remain');
  ok(!!SD.players.get(S(), 'foxfan'), 'the real foxfan is untouched');
  eq(SD.game.purgeDemo().removed, [], 'a second purge has nothing to do');

  // A save with bot profiles in it never keeps them (the bots do not survive a reload).
  SD.processCommand('~lanternliz', '!join', { source: 'sim', displayName: 'LanternLiz' });
  ok(!!SD.players.get(S(), '~lanternliz'), 'a bot joins again');
  P.save(true);
  const loaded = P.load();
  SD.state.resetRuntime();
  SD.state.set(loaded.state);
  const init = SD.game.init({ deferPending: true });
  ok(init.ok, 'reload');
  ok(!SD.players.get(S(), '~lanternliz'), 'the reloaded game has no bot profile');
  SD.processCommand('~lanternliz', '!join', { source: 'sim', displayName: 'LanternLiz' });
  const text = P.exportJSON();
  const imp = P.importJSON(text);
  ok(imp.ok, 'import a save with a bot profile', imp.error);
  ok(!SD.players.get(S(), '~lanternliz'), 'the imported game has no bot profile');
})();

// =============================================================================
section('C. The chat panel stops the bots when a new game loads or live chat connects (gap1#3)');
// =============================================================================
(function () {
  const chat = SD.ui.chat;
  fresh();
  SD.testing.strictRandom = false;       // the bots are UI code: they use Math.random
  const realSetTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = function (fn) { timers.push(fn); return timers.length; };
  globalThis.clearTimeout = function () {};
  try {
    chat.offs = [];
    chat.bindBots();
    chat.setBots(true);
    ok(chat.botsOn, 'bots on');
    for (let i = 0; i < 60; i++) { tick(3000); chat.botStep(); }
    const keys = Object.keys(S().players);
    ok(keys.length > 0 && keys.every(function (k) { return k.charAt(0) === '~'; }), 'every bot player has a ~ key', keys);
    ok(S().runners.some(function (r) { return r.ownerKey && r.ownerKey.charAt(0) === '~'; }), 'bots own runners');
    const reset = SD.game.resetAll();
    ok(reset.ok, 'RESET ALL');
    ok(!chat.botsOn, 'RESET ALL stopped the bots (state:loaded)');
    for (let i = 0; i < 20; i++) { tick(3000); chat.botStep && chat.botsOn && chat.botStep(); }
    eq(Object.keys(S().players).length, 0, 'the new game has no bot players');

    // Stopping the bots removes their profiles.
    chat.setBots(true);
    for (let i = 0; i < 30; i++) { tick(3000); chat.botStep(); }
    ok(Object.keys(S().players).length > 0, 'bots joined the new game');
    chat.setBots(false);
    eq(Object.keys(S().players).filter(function (k) { return k.charAt(0) === '~'; }).length, 0, 'switching the bots off removes them');
    ok(S().runners.every(function (r) { return !r.ownerKey; }), '... and releases their runners');

    // Stopped mid-race: the clean-up waits for the race and then runs.
    chat.setBots(true);
    for (let i = 0; i < 30; i++) { tick(3000); chat.botStep(); }
    ok(SD.game.startRace().ok, 'a race starts with bots playing');
    chat.setBots(false);
    ok(chat.purgePending, 'the clean-up is pending while the race runs');
    SD.game.endRace();
    ok(!chat.purgePending, 'it ran when the race finished');
    eq(Object.keys(S().players).filter(function (k) { return k.charAt(0) === '~'; }).length, 0, 'no bot left after the race');

    // A live connection opening stops them; they cannot be switched on while one is live.
    chat.setBots(true);
    SD.bus.emit(EV.INTEGRATION_STATUS, { adapter: 'twitch', state: 'on' });
    ok(!chat.botsOn, 'a Twitch connection opening stops the bots');
    SD.integrations = { twitch: { status: function () { return { state: 'on' }; } } };
    toasts.length = 0;
    chat.setBots(true);
    ok(!chat.botsOn, 'the bots cannot be switched on while Twitch is connected');
    ok(toasts.some(function (t) { return /stay off/.test(t.text); }), '... and the streamer is told why');
    delete SD.integrations;

    // IMPORT stops them too.
    chat.setBots(true);
    const imp = P.importJSON(P.exportJSON());
    ok(imp.ok && !chat.botsOn, 'IMPORT stopped the bots');
  } finally {
    chat.setBots(false, true);
    chat.offs.forEach(function (off) { off(); });
    chat.offs = [];
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClear;
    SD.testing.strictRandom = true;
  }
})();

// Fake button for the admin drawer / dom.confirmClick.
function fakeButton(act, attrs) {
  const a = Object.assign({ 'data-act': act }, attrs || {});
  const btn = {
    dataset: {}, textContent: act.toUpperCase(), disabled: false,
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(a, k) ? a[k] : null; },
    hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(a, k); },
    closest: function () { return btn; }
  };
  return btn;
}
const realNow = Date.now;
let uiNow = 5000000;
function withClock(fn) {
  Date.now = function () { return uiNow; };
  const t = globalThis.setTimeout;
  globalThis.setTimeout = function () { return 0; };
  try { return fn(); } finally { Date.now = realNow; globalThis.setTimeout = t; }
}

// =============================================================================
section('D. Two-click confirm needs an arm delay; RESET ALL keeps a backup (ui-admin-chat-dom#1)');
// =============================================================================
(function () {
  withClock(function () {
    let runs = 0;
    const btn = fakeButton('x', { 'data-confirm': '' });
    ok(dom.confirmClick(btn, function () { runs++; }, 4000, { detail: 1 }) === false, 'the first click arms');
    uiNow += 120;
    ok(dom.confirmClick(btn, function () { runs++; }, 4000, { detail: 2 }) === false, 'the second click of a double-click does not confirm');
    uiNow += 100;
    ok(dom.confirmClick(btn, function () { runs++; }, 4000, { detail: 0 }) === false, 'a repeated keyboard click 220 ms after arming does not confirm');
    eq([runs, btn.dataset.armed], [0, '1'], 'nothing ran and the button is still armed');
    uiNow += SD.CONFIG.UI.CONFIRM_ARM_MS;
    ok(dom.confirmClick(btn, function () { runs++; }, 4000, { detail: 3 }) === false, 'a triple-click never confirms');
    ok(dom.confirmClick(btn, function () { runs++; }, 4000, { detail: 1 }) === true, 'a deliberate second click confirms');
    eq(runs, 1, 'the action ran once');
  });

  // The admin drawer's RESET ALL through onClick: a double-click wipes nothing.
  fresh();
  say('alice', '!join');
  SD.state.mutate('test', function (s) { s.players.alice.spiritPoints = 5000; });
  P.save(true);
  const admin = SD.ui.admin;
  admin.root = { contains: function () { return true; } };
  admin.refs = {};
  const btn = fakeButton('resetall', { 'data-confirm': '' });
  withClock(function () {
    admin.onClick({ target: btn, detail: 1 });
    uiNow += 120;
    admin.onClick({ target: btn, detail: 2 });
  });
  ok(SD.players.get(S(), 'alice') && sp('alice') === 5000, 'a double-click on RESET ALL wipes nothing');
  let res;
  withClock(function () {
    uiNow += 1500;
    admin.onClick({ target: btn, detail: 1 });
  });
  ok(!SD.players.get(S(), 'alice'), 'a real second click resets everything');
  ok(toasts.some(function (t) { return /RESTORE BACKUP/.test(t.text); }), 'the reset toast points at RESTORE BACKUP');
  const backup = P.readBackup();
  ok(!!backup && JSON.parse(backup).players.alice.spiritPoints === 5000, 'the wiped game is in spiritderby.backup');
  res = P.restoreBackup();
  ok(res.ok && sp('alice') === 5000, 'RESTORE BACKUP undoes the reset', res.error);

  // A blank game does not replace an existing backup.
  const r1 = SD.game.resetAll();          // the restored game (not blank) becomes the backup
  const mid = P.readBackup();
  ok(r1.backedUp && !!mid && JSON.parse(mid).players.alice.spiritPoints === 5000, 'resetting a played game writes it to the backup');
  const r2 = SD.game.resetAll(); // blank game: nothing to keep
  eq([r2.backedUp, P.readBackup() === mid], [false, true], 'resetting a blank game keeps the existing backup');
})();

// =============================================================================
section('E. NEXT DAY: debounced, and a confirm when it ends the season (lifecycle-concurrency#6)');
// =============================================================================
(function () {
  fresh();
  const admin = SD.ui.admin;
  admin.root = { contains: function () { return true; } };
  admin.refs = {};
  admin.lastAct = {};
  const btn = fakeButton('nextday');
  withClock(function () {
    admin.onClick({ target: btn, detail: 1 });
    uiNow += 150;
    admin.onClick({ target: btn, detail: 2 });
  });
  eq(S().season.day, 2, 'a double-click on NEXT DAY advances one day');
  withClock(function () {
    uiNow += 300;
    admin.onClick({ target: btn, detail: 1 });   // held Enter / fast repeat, detail 0/1 but too soon
  });
  eq(S().season.day, 2, 'a repeat within ACTION_DEBOUNCE_MS is ignored');
  withClock(function () {
    uiNow += SD.CONFIG.UI.ACTION_DEBOUNCE_MS;
    admin.onClick({ target: btn, detail: 1 });
  });
  eq(S().season.day, 3, 'a later click advances again');

  // Last day: one click only arms.
  SD.state.mutate('test', function (s) { s.season.day = s.season.daysPerSeason; });
  const season = S().season.number;
  withClock(function () {
    uiNow += 5000;
    admin.onClick({ target: btn, detail: 1 });
    uiNow += 150;
    admin.onClick({ target: btn, detail: 2 });
  });
  eq(S().season.number, season, 'on the last day a double-click does not end the season');
  eq(btn.dataset.armed, '1', 'the button waits for a confirm');
  withClock(function () {
    uiNow += 1000;
    admin.onClick({ target: btn, detail: 1 });
  });
  eq(S().season.number, season + 1, 'the confirming click ends the season');

  // SPAWN RUNNER / ADD HYPE double-clicks run once.
  const n = S().runners.length;
  const spawn = fakeButton('spawn');
  admin.refs = { spawnName: { value: '' } };
  withClock(function () {
    uiNow += 5000;
    admin.onClick({ target: spawn, detail: 1 });
    uiNow += 100;
    admin.onClick({ target: spawn, detail: 2 });
  });
  eq(S().runners.length, n + 1, 'a double-click on SPAWN RUNNER spawns one runner');
})();

// =============================================================================
section('F. A new game drops the old game\'s queued season summaries (gap1#6)');
// =============================================================================
(function () {
  const season = SD.ui.season;
  let shown = 0;
  season.show = function () { shown++; this.open = true; };
  season.close = function () { this.open = false; };
  season.queue = [{ number: 1 }];
  season.open = false;
  season.reset();
  eq(season.queue.length, 0, 'reset() empties the queue');
  season.pump();
  eq(shown, 0, 'nothing of the old game is shown afterwards');
  season.open = true;
  season.queue = [{ number: 2 }];
  season.reset();
  ok(!season.open && !season.queue.length, 'an open summary is closed too');
  // main.js wiring (browser-only): the state:loaded handler resets the season queue, the roster rings
  // and closes the results modal.
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'main.js'), 'utf8');
  ok(/dom\.on\('STATE_LOADED', function \(\) \{[\s\S]{0,200}season\.reset\(\)[\s\S]{0,200}clearPending\(\)[\s\S]{0,200}results\.close\(\)/.test(main),
    'main.js: state:loaded -> season.reset(), roster.clearPending(), results.close() (in that order)');
})();

// =============================================================================
section('G. Shorthand takeovers are refused; shared prefixes are ambiguous (gap3#1)');
// =============================================================================
(function () {
  fresh();
  ['Comet', 'Comet Kid', 'Comets', 'Mossy', 'Pebble Mossy', 'Tail Spin', 'Jackal', 'Wisp'].forEach(function (n) {
    const c = SD.runners.checkName(S(), n);
    ok(!c.ok && /too close/.test(c.message), '"' + n + '" is refused (too close)', c.message);
  });
  ['Pebble Dash', 'Juniper Song', 'Zoë Dash'].forEach(function (n) {
    ok(SD.runners.checkName(S(), n).ok, '"' + n + '" is accepted');
  });
  claimAll();
  say('mallory', '!join');
  const c = say('mallory', '!create Comet');
  ok(!c.ok, '!create Comet is refused', c.message);
  eq(SD.state.findRunner('comet').runner.id, 'r05', 'comet still means Velvet Comet');
  // An older save that already has "Comet Kid": the shared prefix is ambiguous, not a silent takeover.
  const kid = legacyRunner('Comet Kid');
  const f = SD.state.findRunner('comet');
  ok(f.ambiguous && f.ambiguous.length === 2, 'findRunner(comet) is ambiguous with Velvet Comet and Comet Kid', f);
  say('bob', '!join');
  const b = say('bob', '!boost comet');
  ok(!b.ok && /Did you mean/.test(b.message), '!boost comet asks "Did you mean ...?" instead of paying for Comet Kid', b.message);
  eq(SD.state.findRunner('velvet').runner.id, 'r05', 'velvet still finds Velvet Comet');
  eq(SD.state.findRunner('comet kid').runner.id, kid.id, 'the full name finds Comet Kid');
  eq(SD.state.findRunner('moss').runner.id, 'r01', 'moss still finds Moss Runner');
})();

// =============================================================================
section('H. Command words in names; the parsers prefer an exact name (gap3#3)');
// =============================================================================
(function () {
  fresh();
  ['Max Power', 'Power Max', 'All Stars', 'Allin Hope', 'Route 66', '100 Acre', 'Undo', '250', 'Speed Demon', 'Big Str', 'Lucky Star', 'Cancel Culture'].forEach(function (n) {
    const c = SD.runners.checkName(S(), n);
    ok(!c.ok, '"' + n + '" is refused', c.message);
  });
  has(SD.runners.checkName(S(), '250').message, 'at least one letter', 'a digit-only name needs a letter');
  ok(SD.runners.checkName(S(), 'R2 Dash').ok, 'digits inside a word are fine ("R2 Dash")');

  // Older saves: runners with such names still parse sensibly.
  fresh({ roster: false });
  ['Max Power', 'Route 66', 'Undo', '250', '100', 'Speed Demon', 'Big Str', 'Glow Moth'].forEach(legacyRunner);
  SD.state.mutate('test', function (s) { s.settings.runnerCount = 8; });
  SD.betting.clearCache();
  say('b0', '!join');
  const sp0 = sp('b0');
  let r = say('b0', '!bet Max Power');
  ok(!r.ok && /How much\?/.test(r.message) && sp('b0') === sp0, '!bet Max Power asks how much (no all-in)', r.message);
  r = say('b0', '!bet Route 66');
  ok(!r.ok && /How much\?/.test(r.message) && sp('b0') === sp0, '!bet Route 66 asks how much (no 66 SP bet)', r.message);
  r = say('b0', '!bet Undo');
  ok(!r.ok && /How much\?/.test(r.message) && /!bet cancel/.test(r.message), '!bet Undo asks how much and points at !bet cancel', r.message);
  r = say('b0', '!bet 250 100');
  ok(!r.ok && /could be/.test(r.message) && sp('b0') === sp0, '!bet 250 100 (two digit-named runners) asks instead of guessing', r.message);
  r = say('b0', '!bet 20 Max Power');
  ok(r.ok && S().bets[0].amount === 20 && S().bets[0].runnerName === 'Max Power', '!bet 20 Max Power bets 20 on Max Power', r.message);
  r = say('b0', '!bet Max Power 30');
  ok(r.ok && S().bets[0].amount === 30, '!bet Max Power 30 bets 30', r.message);
  r = say('b0', '!bet cancel');
  ok(r.ok, '!bet cancel still cancels', r.message);
  r = say('b0', '!train Speed Demon');
  ok(!r.ok && /Which stat\?/.test(r.message), '!train Speed Demon asks which stat', r.message);
  const big = SD.state.findRunner('big str').runner;
  const spd = big.stats.speed;
  r = say('b0', '!train speed Big Str');
  ok(r.ok && big.stats.speed > spd, '!train speed Big Str trains speed on Big Str (stat-first fallback)', r.message);
  const pow = big.stats.power;
  r = say('b0', '!train Big Str power');
  ok(r.ok && big.stats.power > pow, '!train Big Str power still works', r.message);
  r = say('b0', '!train glow');
  ok(!r.ok && /Usage/.test(r.message), '!train <shorthand> is still the usage error', r.message);
})();

// =============================================================================
section('I. Confusable copies of a name are refused (xss-trust#8)');
// =============================================================================
(function () {
  fresh();
  const cases = {
    'Vеlvet Comet (Cyrillic e)': 'Vеlvet Comet',
    'Мoss Runner (Cyrillic M)': 'Мoss Runner',
    'Glοw Wisp (Greek o)': 'Glοw Wisp',
    'Ve1vet Comet (digit 1)': 'Ve1vet Comet',
    'Vélvet Comet (accent)': 'Vélvet Comet',
    'Velvet Cornet (rn)': 'Velvet Cornet',
    'MOONH00F (zeros)': 'MOONH00F'
  };
  Object.keys(cases).forEach(function (label) {
    const c = SD.runners.checkName(S(), cases[label]);
    ok(!c.ok, label + ' is refused', c.message);
  });
  eq(SD.runners.nameSkeleton('Vеlvet Comet'), SD.runners.nameSkeleton('Velvet Comet'), 'the skeleton folds the Cyrillic e');
  eq(SD.runners.nameSkeleton('Vel​vet'), SD.runners.nameSkeleton('Velvet'), 'zero-width characters are ignored by the skeleton');
  ok(!SD.runners.checkName(S(), 'Vel​vet Dash').ok, 'a zero-width character in a name is refused');
  claimAll();
  say('evil', '!join');
  const r = say('evil', '!create Vеlvet Comet');
  ok(!r.ok, '!create Vеlvet Comet is refused', r.message);
  eq(S().runners.filter(function (x) { return x.custom; }).length, 0, 'no lookalike runner was made');
})();

// =============================================================================
section('J. Admin drawer RUNNERS & VIEWERS actions');
// =============================================================================
(function () {
  fresh();
  claimAll();
  say('troll', '!join');
  ok(say('troll', '!create Rude Name').ok, 'troll creates a runner');
  const x = SD.players.runnerOf(S(), 'troll');
  const admin = SD.ui.admin;
  admin.root = { contains: function () { return true; } };
  admin.refs = { modRunner: { value: x.id }, modName: { value: 'Calm Brook', focus: function () {} }, modPlayer: { value: 'troll' } };
  admin.run('renamerunner');
  eq(x.name, 'Calm Brook', 'RENAME renames the picked runner');
  admin.refs.modName.value = 'Moss';
  toasts.length = 0;
  admin.run('renamerunner');
  ok(x.name === 'Calm Brook' && toasts.some(function (t) { return t.sev === 'bad'; }), 'a refused rename shows why and changes nothing');
  const retire = fakeButton('retirerunner', { 'data-confirm': '' });
  withClock(function () {
    uiNow += 10000;
    admin.onClick({ target: retire, detail: 1 });
    uiNow += 100;
    admin.onClick({ target: retire, detail: 2 });
  });
  ok(!x.retired, 'RETIRE RUNNER needs a confirm (a double-click is not one)');
  withClock(function () {
    uiNow += 1000;
    admin.onClick({ target: retire, detail: 1 });
  });
  ok(x.retired, 'RETIRE RUNNER after the confirm');
  admin.run('deleterunner');
  ok(!SD.state.runnerById(x.id), 'DELETE RUNNER');
  admin.run('removeplayer');
  ok(!SD.players.get(S(), 'troll'), 'REMOVE VIEWER');
})();

// =============================================================================
section('K. Fix round 1: season summaries, tagged log scrubs, saved bot-made runners, TAKE OVER, key repeat');
// =============================================================================
(function () {
  fresh();
  claimAll();
  ok(say('troll', '!join').ok, 'troll joins');
  const made = say('troll', '!create Season');
  ok(made.ok, '!create Season (an everyday log word) is accepted', made.message);
  const x = S().runners.filter(function (r) { return r.name === 'Season'; })[0];
  SD.state.mutate('test', function () {
    S().settings.runnerCount = SD.CONFIG.RACE.MAX_RUNNERS;
    Object.keys(x.stats).forEach(function (k) { x.stats[k] = 100; });
  });
  SD.betting.clearCache();
  let won = false;
  for (let i = 0; i < 6 && !won; i++) {
    if (!runAndFinish().ok) { SD.game.nextDay(); continue; }
    won = S().raceHistory[S().raceHistory.length - 1].results[0].runnerId === x.id;
  }
  ok(won, 'the created runner wins a race');
  eq(SD.seasons.summary(S()).biggestUpset.winnerId, x.id, 'it holds the season\'s biggest upset');
  ok(SD.game.nextDay().ok, 'next day');
  const dayLines = function () { return S().log.filter(function (e) { return /^A new day dawns in the forest: Season \d+, Day \d+/.test(e.text); }).length; };
  const days = dayLines();
  ok(days > 0, 'the log has "A new day dawns ...: Season 1, Day 2" lines');

  // RENAME: the summary follows, lines about other things keep the word "Season".
  ok(SD.game.renameRunner(x.id, 'Kind Name').ok, 'rename Season -> Kind Name');
  eq(SD.seasons.summary(S()).biggestUpset.winnerName, 'Kind Name', 'the season summary shows the new name');
  eq(dayLines(), days, 'the day lines still say "Season N, Day N"');
  ok(S().log.every(function (e) { return !/\bSeason\b/.test(e.text) || /\bSeason \d/.test(e.text); }), 'no line still names the runner "Season"',
    S().log.filter(function (e) { return /\bSeason\b/.test(e.text) && !/\bSeason \d/.test(e.text); }).map(function (e) { return e.text; }));
  ok(logHas(/^Kind Name wins at /), 'the race-win line names Kind Name');
  ok(logHas(/^Race payouts: .*Kind Name 1st/), 'the payouts line names Kind Name');
  ok(logHas(/^Race \d\/\d at .*Kind Name/), 'the race-start line names Kind Name');

  // DELETE: the summary and the archived season say "(removed runner)".
  const del = SD.game.deleteRunner(x.id);
  ok(del.ok, 'delete it', del.message);
  eq(SD.seasons.summary(S()).biggestUpset.winnerName, '(removed runner)', 'the season summary shows (removed runner)');
  let ended = null;
  const off = SD.bus.on(EV.SEASON_ENDED, function (p) { ended = p.summary; });
  ok(SD.game.resetSeason().ok, 'end the season');
  off();
  eq(ended && ended.biggestUpset && ended.biggestUpset.winnerName, '(removed runner)', 'the summary modal (season:ended) shows (removed runner)');
  const hist = S().season.history[S().season.history.length - 1];
  eq(hist.biggestUpset.winnerName, '(removed runner)', 'season.history keeps (removed runner)');
  ok(!logHas(/Kind Name/), 'no log line names Kind Name');
  eq(dayLines(), days, 'the day lines are untouched by the delete');
  ok(logHas(/^Season 1 is over!/), 'the season-end line still starts "Season 1 is over!"');

  // REMOVE VIEWER: every line naming them, tagged or from before the tags.
  ok(say('season', '!join').ok, 'a viewer called season joins');
  ok(SD.game.removePlayer('season').ok, '... and is removed');
  eq(dayLines(), days, 'removing a viewer called "season" leaves the day lines alone');
  ok(logHas(/created by troll\./), 'the runner-created line names troll');
  const rec = S().raceHistory[0];
  SD.state.log('runner', 'A new runner joins the derby: \u{1F98A} Old Timer, a Fox Spirit (Front Runner), created by troll.', 'good', { runnerId: 'r77' });
  SD.state.log('sp', 'Race payouts: troll +5 SP (Old Timer 1st).', 'good', { recordId: rec.id });
  SD.state.log('season', 'A new day dawns in the forest: troll hollow.', 'good', { dayEventId: 'clearSkies' });
  ok(logHas(/Bets paid|Race payouts: .*troll/), 'payout lines name troll');
  ok(SD.game.removePlayer('troll').ok, 'remove troll');
  const left = S().log.filter(function (e) { return /\btroll\b/.test(e.text); }).map(function (e) { return e.text; });
  eq(left, ['A new day dawns in the forest: troll hollow.'], 'only a line that is not about the viewer still says "troll"');
  ok(logHas(/created by \(removed viewer\)\./), 'the runner-created line says (removed viewer), also in an older save');
  ok(logHas(/^Race payouts: .*\(removed viewer\) \+/), 'the payouts lines say (removed viewer)');

  // A bot-made runner is saved as one: it leaves after a reload too, unless a real viewer took it.
  fresh();
  claimAll();
  const bot = function (u, t) { tick(11000); return SD.processCommand(u, t, { source: 'sim', displayName: u.slice(1) }); };
  bot('~mothmom', '!join');
  ok(bot('~mothmom', '!create Pebble Dash').ok, 'a bot creates Pebble Dash');
  const pd = SD.players.runnerOf(S(), '~mothmom');
  ok(pd && pd.demo === true, 'the runner is marked demo (saved)');
  bot('~foxfan', '!join');
  ok(bot('~foxfan', '!create Juniper Song').ok, 'another bot creates Juniper Song');
  const js = SD.players.runnerOf(S(), '~foxfan');
  // Juniper Song changes hands: the bot is removed, a real viewer claims it.
  ok(SD.game.removePlayer('~foxfan').ok, 'the second bot leaves (its runner is free)');
  say('realfan', '!join');
  ok(say('realfan', '!claim ' + js.id).ok, 'a real viewer claims Juniper Song');
  P.save(true);
  const loaded = P.load();
  SD.state.resetRuntime();
  SD.state.set(loaded.state);
  ok(SD.game.init({ deferPending: true }).ok, 'reload');
  ok(!SD.state.runnerById(pd.id), 'the bot-made runner is gone after the reload');
  ok(!SD.players.get(S(), '~mothmom'), '... with its bot');
  const kept = SD.state.runnerById(js.id);
  ok(kept && kept.ownerKey === 'realfan' && kept.demo === undefined, 'the one a real viewer owns stays, no longer marked demo');

  // main.js (browser-only): TAKE OVER defers the pending race until after state:loaded, like IMPORT.
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'main.js'), 'utf8');
  ok(/function adopt\(res, source\) \{[\s\S]{0,400}SD\.game\.init\(\{ deferPending: true \}\)[\s\S]{0,300}STATE_LOADED[\s\S]{0,300}SD\.game\.applyPending\(\)/.test(main),
    'main.js adopt(): init({ deferPending }) -> state:loaded -> applyPending()');
  // The page-wide key-repeat guard: a held Enter / Space never confirms an armed button.
  const m = main.match(/function blockArmedRepeat\(e\) \{[\s\S]*?\n {2}\}/);
  ok(!!m && /document\.addEventListener\('keydown', blockArmedRepeat, true\)/.test(main), 'main.js installs blockArmedRepeat (capture phase)');
  if (m) {
    const guard = new Function(m[0] + '\nreturn blockArmedRepeat;')();
    const key = function (k, repeat, armed) {
      const b = fakeButton('newgame', armed ? { 'data-armed': '1' } : {});
      const ev = { key: k, repeat: repeat, target: b, prevented: false, preventDefault: function () { this.prevented = true; } };
      guard(ev);
      return ev.prevented;
    };
    ok(key('Enter', true, true) && key(' ', true, true), 'a repeated Enter / Space on an armed button is cancelled');
    ok(!key('Enter', false, true), 'a fresh Enter on an armed button still confirms');
    ok(!key('Enter', true, false), 'a repeat on a button that is not armed is left alone');
  }
})();

// =============================================================================
section('L. Review batch 11: name scrubs hold fixed words and other names; the chat feed is scrubbed too (R12-R14)');
// =============================================================================
(function () {
  const FIXED = /Hollow Glade|Fernfall Hollow|Hollow Owl/g;
  const fixedCount = function () { return S().log.reduce(function (n, e) { return n + (e.text.match(FIXED) || []).length; }, 0); };
  const strayWord = function (word, keepRe) {
    return S().log.map(function (e) { return e.text.replace(keepRe, ''); }).filter(function (t) { return new RegExp('\\b' + word + '\\b').test(t); });
  };

  // R12: a runner named after a track / species word ("Hollow"), deleted.
  fresh();
  claimAll();
  ok(say('troll', '!join').ok, 'troll joins');
  ok(say('troll', '!create Hollow').ok, '!create Hollow');
  const x = S().runners.filter(function (r) { return r.name === 'Hollow'; })[0];
  SD.state.mutate('test', function () {
    S().settings.runnerCount = SD.CONFIG.RACE.MAX_RUNNERS;
    Object.keys(x.stats).forEach(function (k) { x.stats[k] = 100; });
  });
  SD.betting.clearCache();
  for (let i = 0; i < 6; i++) { if (!runAndFinish().ok) SD.game.nextDay(); }
  // Lines of the kinds the review found, with the fixed words it broke (the seeded run above has some).
  SD.state.log('runner', 'A new runner joins the derby: \u{1F989} Hollow, a Hollow Owl (Wild Card), created by troll.', 'good', { runnerId: x.id, by: 'troll' });
  SD.state.log('race', 'Race 1/3 at Hollow Glade (1200 m): Hollow, Moss Runner. Favourite: Hollow at 1.0x.', 'info', { runnerIds: [x.id, 'r01'] });
  SD.state.log('race', 'Hollow wins at Fernfall Hollow (1200 m) in 60.0s!', 'epic', { winnerId: x.id, recordId: S().raceHistory[0].id });
  const before = fixedCount();
  ok(before >= 4, 'the log names Hollow Glade / Fernfall Hollow / Hollow Owl', before);
  ok(SD.game.deleteRunner(x.id).ok, 'delete Hollow');
  eq(fixedCount(), before, 'every "Hollow Glade", "Fernfall Hollow" and "Hollow Owl" is still there');
  eq(strayWord('Hollow', FIXED), [], 'no line still names the runner Hollow');
  ok(logHas(/^Race 1\/3 at Hollow Glade \(1200 m\): \(removed runner\), Moss Runner\. Favourite: \(removed runner\) at 1\.0x\.$/), 'the race-start line: track kept, runner slots replaced');
  ok(logHas(/^\(removed runner\) wins at Fernfall Hollow \(1200 m\)/), 'the win line: track kept');
  ok(logHas(/joins the derby: \u{1F989} \(removed runner\), a Hollow Owl \(Wild Card\)/u), 'the spawn line: species kept');

  // R12: a runner named like a label ("Favourite") or exactly like a track, renamed.
  ok(say('troll', '!create Favourite').ok, '!create Favourite');
  const fav = S().runners.filter(function (r) { return r.name === 'Favourite'; })[0];
  SD.state.log('race', 'Race 2/3 at Glowcap Marsh (1200 m): Favourite, Moss Runner. Favourite: Favourite at 1.0x.', 'info', { runnerIds: [fav.id, 'r01'] });
  ok(SD.game.renameRunner(fav.id, 'Kind Name').ok, 'rename Favourite -> Kind Name');
  ok(logHas(/^Race 2\/3 at Glowcap Marsh \(1200 m\): Kind Name, Moss Runner\. Favourite: Kind Name at 1\.0x\.$/), 'the "Favourite:" label is kept', S().log.slice(-3));
  const hg = legacyRunner('Hollow Glade');   // exactly a track name
  SD.state.log('race', 'Race 3/3 at Hollow Glade (1200 m): Hollow Glade, Moss Runner. Favourite: Hollow Glade at 1.2x.', 'info', { runnerIds: [hg.id, 'r01'] });
  const hgr = SD.game.renameRunner(hg.id, 'Brook Song');
  ok(hgr.ok, 'rename Hollow Glade -> Brook Song', hgr.message);
  ok(logHas(/^Race 3\/3 at Hollow Glade \(1200 m\): Brook Song, Moss Runner\. Favourite: Brook Song at 1\.2x\.$/), 'the track slot keeps "at Hollow Glade ("');

  // R13: a viewer whose display name is a word of a runner's name ("Moss" / Moss Runner), removed.
  fresh();
  const mossSay = function (t) { tick(11000); return SD.processCommand('moss', t, { source: 'twitch', displayName: 'Moss' }); };
  ok(mossSay('!join').ok && mossSay('!claim r01').ok, 'Moss joins and claims Moss Runner');
  ok(mossSay('!bet Moss Runner 10').ok, 'Moss bets on Moss Runner');
  ok(say('fan', '!join').ok && say('fan', '!bet Moss Runner 10').ok, 'fan bets on Moss Runner too');
  SD.state.mutate('test', function () { S().settings.runnerCount = SD.CONFIG.RACE.MAX_RUNNERS; });
  for (let i = 0; i < 3; i++) { if (!runAndFinish().ok) SD.game.nextDay(); }
  const mossRunnerLines = S().log.filter(function (e) { return /Moss Runner/.test(e.text); }).length;
  ok(mossRunnerLines > 3, 'the log names Moss Runner', mossRunnerLines);
  ok(SD.game.removePlayer('moss').ok, 'remove Moss');
  eq(S().log.filter(function (e) { return /Moss Runner/.test(e.text); }).length, mossRunnerLines, 'every "Moss Runner" is still there');
  eq(S().log.filter(function (e) { return /\(removed viewer\) Runner/.test(e.text); }).map(function (e) { return e.text; }), [], 'no line says "(removed viewer) Runner"');
  eq(strayWord('Moss', /Moss Runner/g), [], 'no line still names the viewer Moss');
  ok(logHas(/^\(removed viewer\) claimed \u{1F98C} Moss Runner\.$/u), 'the claim line: viewer replaced, runner kept');

  // R13: a display name identical to the runner's whole name.
  fresh();
  const mhSay = function (t) { tick(11000); return SD.processCommand('moonhoof', t, { source: 'twitch', displayName: 'Moonhoof' }); };
  ok(mhSay('!join').ok && mhSay('!claim r02').ok, 'a viewer called Moonhoof claims the runner Moonhoof');
  ok(SD.game.removePlayer('moonhoof').ok, 'remove the viewer');
  ok(logHas(/^\(removed viewer\) claimed \u{1F40E} Moonhoof\.$/u), 'the claim line keeps the runner (its emoji marks it)', S().log.map(function (e) { return e.text; }).slice(-4));

  // R14: the session's chat feed (runtime.chatFeed).
  fresh();
  claimAll();
  const feedText = function () { return SD.state.runtime.chatFeed.map(function (m) { return m.text; }).join('\n'); };
  const feedTail = function () { return SD.state.runtime.chatFeed.slice(-6).map(function (m) { return m.text; }).join(' | '); };
  ok(say('troll', '!join').ok && say('troll', '!create Trollface Zed').ok, 'troll creates Trollface Zed');
  ok(say('bob', '!join').ok && say('bob', '!boost Trollface Zed').ok, 'bob boosts it');
  has(feedText(), 'Trollface Zed', 'the chat feed names it');
  const tz = S().runners.filter(function (r) { return r.name === 'Trollface Zed'; })[0];
  ok(SD.game.renameRunner(tz.id, 'Calm Zed').ok, 'rename it');
  ok(feedText().indexOf('Trollface Zed') < 0 && feedText().indexOf('Calm Zed') >= 0, 'the chat feed shows the new name only', feedTail());
  ok(SD.game.deleteRunner(tz.id).ok, 'delete it');
  ok(feedText().indexOf('Calm Zed') < 0 && feedText().indexOf('(removed runner)') >= 0, 'the chat feed says (removed runner)', feedTail());
  ok(say('moss', '!join').ok, 'moss joins');
  const bobBet = say('bob', '!inspect Moss Runner');
  ok(bobBet.ok && /Moss Runner/.test(bobBet.message), 'bob asks about Moss Runner', bobBet.message);
  SD.commands.system('🏅 moss unlocked First Steps (+25 SP)', 'epic');
  ok(SD.game.removePlayer('moss').ok, 'remove moss');
  eq(SD.state.runtime.chatFeed.filter(function (m) { return m.username === 'moss'; }).length, 0, 'moss\'s own lines (typed and replies) are dropped from the feed');
  ok(/\(removed viewer\) unlocked First Steps/.test(feedText()) && /\bmoss\b/.test(feedText()) === false, 'other lines naming moss say (removed viewer)', feedTail());
  ok(/Moss Runner/.test(feedText()), 'bob\'s line keeps Moss Runner');
  // js/ui/chat.js draws the feed again on those events (browser-only DOM work).
  const chatSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'ui', 'chat.js'), 'utf8');
  ok(['RUNNER_RENAMED', 'RUNNER_RETIRED', 'PLAYER_REMOVED'].every(function (n) {
    return new RegExp("dom\\.on\\('" + n + "'[^\\n]*redrawFeed\\(\\)").test(chatSrc);
  }) && typeof SD.ui.chat.redrawFeed === 'function', 'chat.js redraws the feed on runner:renamed / runner:retired / player:removed');
})();

console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
