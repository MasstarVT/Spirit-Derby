#!/usr/bin/env node
/*
 * Spirit Derby - tools/identity-test.js (review batch 2: identity model)
 * Players and runner ownership are keyed by the viewer's LOGIN; the display name is presentation
 * only. The streamer's console acts as a reserved key no Twitch login can produce.
 *   A  login-keyed ownership (economy-abuse#1): a viewer whose display name is not a case variant
 *      of the login (Twitch localized names, bridge display names) owns, uses, trains, ribbons and is
 *      paid for the runner they claim; a re-claim releases the old runner (no hoarding); !create sees
 *      the runner; the own-runner sabotage rule and the open-training check use the login
 *   B  the reserved streamer actor (economy#11, ui-panels-boot#3): '#streamer' only from source
 *      'admin', never a player, runs mod / read-only commands, earns no SP / hype credit /
 *      achievements from roster TRAIN / REST and ADD HYPE; the Twitch login 'streamer' is an
 *      ordinary, separate viewer; Top hype is always a real player
 *   C  admin SEND AS (ui-admin-chat-dom#2, #5): options keyed by login, labelled by display name;
 *      the chosen sender stays selected when it drops out of the recent list
 *   D  chat panel (ui-admin-chat-dom#3): "@login:" and the sender list speak as the login;
 *      old prefs holding display names map to logins
 *   E  roster TRAIN / REST and admin ADD HYPE act as '#streamer'
 *
 *   node tools/identity-test.js [--verbose]
 */
'use strict';

const path = require('path');
const SD = require('./load-core.js');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
let passed = 0;
let failed = 0;
const failures = [];
let currentSection = '';
function section(title) { currentSection = title; console.log('\n' + title); }
function ok(cond, name, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  PASS ' + name); }
  else {
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
function has(str, needle, name) {
  return ok(typeof str === 'string' && str.indexOf(needle) >= 0, name, 'expected "' + needle + '" in "' + str + '"');
}

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------
let NOW = 1767225600000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }
SD.persistence.setAutoSave(false);
SD.achievements.init();

function fresh() {
  const rt = SD.state.runtime;
  rt.cooldowns = {}; rt.runnerCooldowns = {}; rt.chatFeed = []; rt.nervousCheers = {}; rt.activity = {}; rt.hypeRecent = {};
  SD.state.set(SD.state.create({ seedSalt: 5150, dayEventId: 'clearSkies' }));
  SD.game.init();
  tick(60000);
  return SD.state.get();
}
function S() { return SD.state.get(); }
function say(user, text, opts) { tick(11000); return SD.processCommand(user, text, Object.assign({ source: 'twitch' }, opts || {})); }
function runner(q) { return SD.state.findRunner(q).runner; }
function owned(key) { return S().runners.filter(function (r) { return r.ownerKey === key; }); }

const KEY = SD.players.STREAMER_KEY;
const ADMIN = { source: 'admin', isMod: true };
const FOX = { source: 'twitch', displayName: '狐狸' };

// =============================================================================
section('A. Ownership is keyed by login (economy-abuse#1)');
// =============================================================================
{
  fresh();
  ok(say('foxfan', '!join', FOX).ok, 'foxfan (display name 狐狸) joins');
  eq(SD.players.get(S(), 'foxfan').displayName, '狐狸', 'the localized display name is kept for display');
  const c1 = say('foxfan', '!claim moss', FOX);
  ok(c1.ok, '!claim moss', c1.message);
  const moss = runner('moss');
  eq([moss.ownerKey, moss.owner], ['foxfan', '狐狸'], 'runner.ownerKey = login, runner.owner = display label');
  eq(SD.players.runnerOf(S(), 'foxfan') && SD.players.runnerOf(S(), 'foxfan').id, moss.id, 'runnerOf(foxfan) finds the runner');
  const tr = say('foxfan', '!train speed', FOX);
  ok(tr.ok, '!train speed trains the claimed runner', tr.message);
  const rb = say('foxfan', '!ribbon teal', FOX);
  ok(rb.ok && moss.ribbonColor, '!ribbon is allowed (requiresRunner)', rb.message);
  const sab = say('foxfan', '!sabotage moss', FOX);
  ok(!sab.ok && /your own runner/.test(sab.message), 'own-runner sabotage is refused', sab.message);
  const inspect = say('mothmom', '!inspect moss', { displayName: 'MothMom' });
  has(inspect.message, 'Owner: 狐狸', '!inspect shows the display name as the owner');

  // Re-claiming releases the old runner: no hoarding.
  const c2 = say('foxfan', '!claim moonhoof', FOX);
  ok(c2.ok && /Released Moss Runner/.test(c2.message), 're-claim releases the old runner', c2.message);
  eq([moss.ownerKey, moss.owner], [null, null], 'Moss Runner is free again');
  ['thunder', 'ember', 'velvet'].forEach(function (n) { say('foxfan', '!claim ' + n, FOX); });
  eq(owned('foxfan').length, 1, 'five claims later foxfan still holds exactly one runner');
  const cr = say('foxfan', '!create Foxy Dash', FOX);
  ok(!cr.ok && /already run with/.test(cr.message), '!create sees the runner ("You already run with")', cr.message);

  // Other viewers see the owner by display name and cannot take it.
  const velvet = runner('velvet');
  say('mothmom', '!join', { displayName: 'MothMom' });
  const taken = say('mothmom', '!claim velvet', { displayName: 'MothMom' });
  ok(!taken.ok && /already runs for 狐狸/.test(taken.message), 'a claim on it is refused, naming 狐狸', taken.message);
  SD.game.updateSettings({ openTraining: false });
  const t2 = say('mothmom', '!train velvet speed', { displayName: 'MothMom' });
  ok(!t2.ok && /runs for 狐狸/.test(t2.message), 'open training off: another viewer cannot train it', t2.message);
  const t3 = say('foxfan', '!train velvet stamina', FOX);
  ok(t3.ok, 'open training off: the owner (by login) can', t3.message);
  SD.game.updateSettings({ openTraining: true });

  // A bridge viewer whose display name is not the login (processCommand keeps it as given).
  const BR = { source: 'bridge', displayName: 'Fox Fan' };
  say('user_42', '!join', BR);
  ok(say('user_42', '!claim misty', BR).ok, 'bridge viewer user_42 ("Fox Fan") claims Misty Gale');
  eq(runner('misty').ownerKey, 'user_42', 'owned by the login user_42');

  // Display-name casing changes update the label, not the owner.
  say('mothmom', '!claim glow', { displayName: 'MothMom' });
  say('mothmom', '!status', { displayName: 'MOTHMOM' });
  eq([runner('glow').ownerKey, runner('glow').owner], ['mothmom', 'MOTHMOM'], "a new display-name casing refreshes the runner's owner label");

  // Owner payouts go to the login.
  SD.game.updateSettings({ runnerCount: 8 });
  let finished = null;
  const off = SD.bus.on(SD.EVENTS.RACE_FINISHED, function (p) { finished = p; });
  const before = SD.players.get(S(), 'foxfan').spiritPoints;
  const start = say('lanternliz', '!race', { isMod: true, displayName: 'LanternLiz' });
  ok(start.ok, 'a mod starts a race', start.message);
  SD.game.endRace();
  off();
  const rec = finished && finished.record;
  const mine = rec && rec.results.filter(function (x) { return x.runnerId === velvet.id; })[0];
  ok(!!mine, 'Velvet Comet raced');
  if (mine) {
    const entrant = rec.entrants.filter(function (e) { return e.runnerId === velvet.id; })[0];
    eq([entrant.ownerKeyAtRace, entrant.ownerAtRace], ['foxfan', '狐狸'], 'the entrant carries ownerKeyAtRace (login) and ownerAtRace (label)');
    const pay = finished.payouts.filter(function (x) { return x.role === 'owner' && x.runnerId === velvet.id; })[0];
    ok(pay && pay.username === 'foxfan' && pay.amount === mine.spOwner && mine.spOwner > 0, 'foxfan is paid the owner SP', pay);
    ok(SD.players.get(S(), 'foxfan').spiritPoints >= before + mine.spOwner, "foxfan's balance includes it");
  }

  // Karma: race commentary shows the display name (data.by), the unlock uses the login (data.byKey).
  fresh();
  say('foxfan', '!join', FOX);
  let backfired = null;
  for (let i = 0; i < 16 && !backfired; i++) {
    S().runners.forEach(function (x) { x.energy = x.maxEnergy; });
    const t = SD.game.previewField()[0];
    t.stats.wisdom = 70;                                   // backfire chance 50%
    SD.players.get(S(), 'foxfan').spiritPoints = 500;
    const r = SD.processCommand('foxfan', '!sabotage ' + t.name, { source: 'admin', displayName: '狐狸' }); // SEND AS: no cooldown
    if (!ok(r.ok || i > 0, 'sabotage accepted', r.message)) break;
    if (!SD.game.startRace().ok) break;
    const done = SD.game.endRace();
    const ev = done.record && done.record.events.filter(function (e) { return e.kind === 'chat' && e.data && e.data.type === 'sabotage'; })[0];
    if (ev && ev.data.backfire) backfired = ev;
    tick(60000);
  }
  ok(!!backfired, 'a sabotage by 狐狸 backfired within 16 races');
  if (backfired) eq([backfired.data.by, backfired.data.byKey], ['狐狸', 'foxfan'], 'the race event shows 狐狸 and carries the login');
  ok(SD.players.get(S(), 'foxfan').achievements.indexOf('karma') >= 0, 'Karma is unlocked for foxfan');
}

// =============================================================================
section('B. The streamer console is a reserved actor (economy#11, ui-panels-boot#3)');
// =============================================================================
{
  fresh();
  eq(KEY, '#streamer', 'STREAMER_KEY is #streamer');
  ok(!/^[a-z0-9_]{1,25}$/.test(KEY) && SD.players.isReservedKey(KEY), 'no Twitch login can produce it');
  ok(!SD.players.isReservedKey('streamer'), "the login 'streamer' is not reserved");
  eq(SD.players.ensure(S(), KEY, 'Streamer').player, null, 'players.ensure() refuses a reserved key');

  const j = SD.processCommand(KEY, '!join', ADMIN);
  ok(!j.ok && /doesn't play/.test(j.message), 'the console cannot !join', j.message);
  ['!claim', '!cheer', '!status', '!bet moss 20', '!train moss speed', '!boost moss'].forEach(function (t) {
    const r = SD.processCommand(KEY, t, ADMIN);
    ok(!r.ok && /doesn't play/.test(r.message), 'console ' + t + ' is refused (never a player)', r.message);
  });
  eq(Object.keys(S().players), [], 'no player was created');
  const help = SD.processCommand(KEY, '!help', ADMIN);
  ok(help.ok, 'read-only commands work (!help)');
  const feed = SD.state.runtime.chatFeed;
  eq(feed[feed.length - 1].displayName, 'Streamer', 'the console is shown as "Streamer"');
  ok(SD.processCommand(KEY, '!event today', ADMIN).ok, 'mod commands work (!event today)');
  const rank = SD.processCommand(KEY, '!rank', ADMIN);
  ok(!rank.ok && /no profile/.test(rank.message), '!rank without a viewer explains the console has no profile', rank.message);

  // A reserved key from anywhere but the local console is dropped before the chat line.
  ['twitch', 'bridge', 'sim'].forEach(function (src) {
    const n = SD.state.runtime.chatFeed.length;
    const r = SD.processCommand('#streamer', '!race', { source: src, isMod: true });
    ok(!r.ok && r.reserved && SD.state.runtime.chatFeed.length === n, src + ': "#streamer" is refused and not shown', r.message);
    const r2 = SD.commands.process({ username: '#Streamer', text: '!race', source: src, isMod: true });
    ok(!r2.ok && r2.reserved, src + ': SD.commands.process refuses it too');
  });
  ok(!S().currentRace, 'no race was started through a spoofed console key');

  // The Twitch login 'streamer' is an ordinary viewer, separate from the console.
  ok(say('streamer', '!join', { displayName: 'Streamer' }).ok, "Twitch viewer 'streamer' joins");
  const viewer = SD.players.get(S(), 'streamer');
  const sp0 = viewer.spiritPoints;
  const ids = S().runners.slice(0, 3).map(function (r) { return r.id; });
  ids.forEach(function (id) { tick(5000); ok(SD.game.trainRunner(id, 'speed', KEY).ok, 'roster-style TRAIN by the console ' + id); });
  tick(5000);
  ok(SD.game.restRunner(ids[0], KEY).ok !== false, 'roster-style REST by the console');
  eq(viewer.spiritPoints, sp0, "the console's clicks give the viewer 'streamer' no SP");
  eq(viewer.stats.trains, 0, 'nor training stats');
  ok(!(KEY in S().hype.contributions) && !('streamer' in S().hype.contributions), 'no hype contribution for #streamer or streamer', S().hype.contributions);
  ok(!(KEY in (S().achievements.progress || {})), 'no achievement progress for the console');
  const hypeBefore = S().hype.value;
  SD.game.addHype(25, KEY);
  ok(S().hype.value > hypeBefore && !(KEY in S().hype.contributions), 'ADD HYPE raises the meter without crediting anyone');
  ok(!S().achievements.unlocked.some(function (a) { return SD.players.isReservedKey(a.username); }), 'no achievement was unlocked by a reserved key');

  // Season summary: Top hype is a real player, never a key without a profile.
  say('mothmom', '!join', { displayName: 'MothMom' });
  tick(60000);
  say('mothmom', '!cheer', { displayName: 'MothMom' });
  S().hype.contributions.ghost = 999;               // e.g. the old roster 'streamer' credit with no player
  const sum = SD.seasons.summary(S());
  eq(sum.topHypeContributor && sum.topHypeContributor.username, 'mothmom', 'Top hype skips keys with no player');
  delete S().hype.contributions.ghost;

  // SD.game.spawnRunner({ owner }) keys the owner by login and never by a reserved key.
  const sp = SD.game.spawnRunner({ name: 'Keyed Owner', owner: 'MothMom' });
  eq([sp.ownerKey, sp.owner], ['mothmom', 'MothMom'], 'spawnRunner({ owner }) stores the login key and the display label');
  const sp2 = SD.game.spawnRunner({ name: 'Not The House', owner: KEY });
  eq([sp2.ownerKey, sp2.owner], [null, null], 'spawnRunner({ owner: #streamer }) leaves it unowned');
}

// =============================================================================
// UI stubs (admin.js / chat.js / roster.js only touch these outside init())
// =============================================================================
function unescapeHtml(s) { return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function fakeSelect() {
  const sel = { _html: '', _value: '', options: [] };
  Object.defineProperty(sel, 'innerHTML', {
    get: function () { return this._html; },
    set: function (h) {
      this._html = h;
      const re = /<option value="([^"]*)">([^<]*)<\/option>/g;
      const out = [];
      let m;
      while ((m = re.exec(h))) out.push({ value: unescapeHtml(m[1]), label: unescapeHtml(m[2]) });
      this.options = out;
      this._value = out.length ? out[0].value : '';
    }
  });
  // Like a browser: a value that is not an option selects nothing.
  Object.defineProperty(sel, 'value', {
    get: function () { return this._value; },
    set: function (v) { this._value = this.options.some(function (o) { return o.value === v; }) ? v : ''; }
  });
  return sel;
}
function fakeInput(v) { return { value: v || '', disabled: false, focus: function () {} }; }
globalThis.document = { activeElement: null, body: { classList: { contains: function () { return false; } } }, getElementById: function () { return null; } };
require(path.join(__dirname, '..', 'js', 'ui', 'dom.js'));
SD.ui.dom.toast = function () {};
SD.ui.dom.schedule = function () {};      // no render loop in Node (panels are driven directly)
require(path.join(__dirname, '..', 'js', 'ui', 'admin.js'));
require(path.join(__dirname, '..', 'js', 'ui', 'chat.js'));
require(path.join(__dirname, '..', 'js', 'ui', 'roster.js'));
const admin = SD.ui.admin;
const chat = SD.ui.chat;

// =============================================================================
section('C. Admin SEND AS keys viewers by login (ui-admin-chat-dom#2, #5)');
// =============================================================================
{
  fresh();
  say('abc123', '!join', { displayName: '日本語' });
  say('foxfan', '!join', { displayName: 'FoxFan' });
  say('fox_a', '!join', { source: 'bridge', displayName: 'Fox' });
  say('fox_b', '!join', { source: 'bridge', displayName: 'Fox' });
  const sel = fakeSelect();
  const reply = { textContent: '', className: '' };
  admin.refs = { sendAs: sel, sendText: fakeInput(), sendReply: reply };
  admin.sendAsKey = '';
  admin.sendAsValue = '';
  admin.fillSendAs(S());
  const values = sel.options.map(function (o) { return o.value; });
  eq(values[0], KEY, 'the first option is the console (#streamer)');
  ok(values.indexOf('abc123') >= 0 && values.indexOf('日本語') < 0, 'viewers are listed by login, not by display name', values);
  ok(sel.options.some(function (o) { return o.value === 'abc123' && o.label === '日本語 (abc123)'; }), 'a non-case-variant name is labelled "日本語 (abc123)"', sel.options);
  ok(sel.options.some(function (o) { return o.value === 'foxfan' && o.label === 'FoxFan'; }), 'a case variant is labelled by its display name only');
  ok(values.indexOf('fox_a') >= 0 && values.indexOf('fox_b') >= 0, 'two viewers with the same display name get two distinct options');
  ok(values.indexOf('mod') < 0 && values.indexOf('streamer') < 0, 'no "Mod" / "Streamer" pseudo-viewers (they collided with real logins)');

  sel.value = 'abc123';
  admin.onChange({ target: sel });
  admin.refs.sendText.value = '!status';
  admin.sendAs();
  has(reply.textContent, '@日本語 日本語: ', 'SEND AS runs !status as abc123 and shows the display name');
  ok(!/not in the derby/.test(reply.textContent), 'the player is found');
  eq(Object.keys(S().players).sort(), ['abc123', 'fox_a', 'fox_b', 'foxfan'], 'no duplicate player keyed by the display name');

  // #5: the chosen sender survives 12 other viewers pushing it out of the recent list.
  say('quietx', '!join', { displayName: 'QuietX' });
  admin.fillSendAs(S());
  sel.value = 'quietx';
  admin.onChange({ target: sel });
  for (let i = 0; i < 12; i++) { say('viewer' + i, '!join', { displayName: 'Viewer' + i }); admin.fillSendAs(S()); }
  eq(sel.value, 'quietx', 'the selected sender is still selected after 12 re-renders');
  ok(sel.options.filter(function (o) { return o.value === 'quietx'; }).length === 1, 'and is pinned in the list');
  admin.refs.sendText.value = '!status';
  admin.sendAs();
  has(reply.textContent, '@QuietX QuietX: ', 'SEND AS still runs as quietx, not as the console');

  // The console: mod rights, never a player.
  sel.value = KEY;
  admin.onChange({ target: sel });
  admin.refs.sendText.value = '!join';
  admin.sendAs();
  ok(/doesn't play/.test(reply.textContent) && !SD.players.get(S(), KEY), 'SEND AS Streamer !join is refused, no player created', reply.textContent);
  admin.refs.sendText.value = '!race status';
  admin.sendAs();
  has(reply.textContent, '@Streamer ', 'SEND AS Streamer runs mod / read-only commands');
}

// =============================================================================
section('D. Chat panel speaks as logins (ui-admin-chat-dom#3)');
// =============================================================================
{
  fresh();
  const sel = fakeSelect();
  const input = fakeInput();
  chat.refs = { sender: sel, input: input };
  ok(Object.getPrototypeOf(chat.labels) === null, 'chat.labels is a prototype-free map');
  chat.recent = []; chat.labels = Object.create(null); chat.sender = KEY; chat.senderKey = '';
  const off = SD.bus.on(SD.EVENTS.CHAT_MESSAGE, function (m) { chat.onMessage(m); });
  say('abc123', '!join', { displayName: '日本語' });
  eq(chat.recent, ['abc123'], 'a Twitch line records the sender login, not the display name');
  ok(sel.options.some(function (o) { return o.value === 'abc123' && o.label === '日本語 (abc123)'; }), 'the sender list shows "日本語 (abc123)"', sel.options);

  let last = null;
  const off2 = SD.bus.on(SD.EVENTS.COMMAND_RESULT, function (r) { last = r; });
  input.value = '@abc123: !status';
  chat.submit();
  ok(last && last.username === 'abc123' && last.ok, 'typing "@abc123: !status" runs as abc123', last);
  eq(last && last.displayName, '日本語', 'shown with the display name');
  sel.value = 'abc123';
  chat.setSender('abc123');
  input.value = '!status';
  chat.submit();
  ok(last && last.username === 'abc123' && last.ok, 'the sender picked from the list runs as abc123', last);
  eq(Object.keys(S().players), ['abc123'], 'no duplicate player keyed by the display name');

  input.value = '@FoxFan: !join';
  chat.submit();
  eq([last.username, SD.players.get(S(), 'foxfan').displayName], ['foxfan', 'FoxFan'], '"@FoxFan:" joins as login foxfan with the typed casing as display name');

  // The console sender never plays; a typed "@streamer:" is the viewer login 'streamer'.
  chat.setSender(KEY);
  input.value = '!join';
  chat.submit();
  ok(last && !last.ok && /doesn't play/.test(last.message) && !SD.players.get(S(), KEY), 'the Streamer sender cannot !join', last && last.message);
  input.value = '@streamer: !join';
  chat.submit();
  ok(last && last.ok && last.username === 'streamer' && last.source === 'sim', 'a typed "@streamer:" is the ordinary viewer login streamer', last);
  ok(chat.recent.indexOf(KEY) < 0, 'the console key is never stored as a recent viewer');

  // Prefs written before logins were stored held display names.
  eq(chat.prefKey('Streamer'), KEY, 'old pref "Streamer" -> the console key');
  eq(chat.prefKey('日本語'), 'abc123', 'old pref "日本語" -> the login of the one player showing that name');
  eq(chat.prefKey('FoxFan'), 'foxfan', 'old pref "FoxFan" -> foxfan');
  eq(chat.prefKey('NewViewer'), 'newviewer', 'an unknown name is read as a login');

  // Prototype-named logins are valid on Twitch: their label is their own, never an Object.prototype
  // member (the reads are own-key only even when labels is a plain object).
  const labels0 = chat.labels;
  chat.labels = {};
  eq([chat.labelOf('constructor'), chat.labelOf('__proto__')], ['constructor', '__proto__'], 'labelOf ignores Object.prototype members');
  eq([chat.resolveTyped('constructor'), chat.labelOf('constructor')], ['constructor', 'constructor'], 'a typed "@constructor:" speaks as constructor, labelled constructor');
  chat.labels = labels0;
  chat.noteSender('constructor');
  const cOpt = sel.options.filter(function (o) { return o.value === 'constructor'; })[0];
  eq(cOpt && cOpt.label, 'constructor', 'the sender list shows "constructor", not a native function', cOpt);
  chat.noteSender('__proto__', 'Proto Fan');
  eq(chat.labelOf('__proto__'), 'Proto Fan', 'a "__proto__" label is stored as an own entry');
  eq(Object.getPrototypeOf(chat.labels), null, 'and does not replace the map prototype');

  // Demo bots speak as their logins.
  chat.send('foxfan', '!status', 'FoxFan');
  eq([last.username, last.displayName], ['foxfan', 'FoxFan'], 'send(login, text, label)');
  off(); off2();
}

// =============================================================================
section('E. Roster TRAIN / REST and ADD HYPE act as the console (ui-panels-boot#3)');
// =============================================================================
{
  fresh();
  say('streamer', '!join', { displayName: 'Streamer' });
  say('foxfan', '!join', { displayName: 'FoxFan' });
  tick(60000);
  say('foxfan', '!cheer', { displayName: 'FoxFan' });
  const viewer = SD.players.get(S(), 'streamer');
  const sp0 = viewer.spiritPoints;
  const roster = SD.ui.roster;
  roster.cards = {}; roster.chosenStat = {}; roster.pulse = function () {};
  const ids = S().runners.slice(0, 4).map(function (r) { return r.id; });
  ids.forEach(function (id) { tick(4000); roster.train(id); });
  tick(4000);
  roster.rest(ids[1]);
  ok(S().runners.slice(0, 4).some(function (r) { return C_trained(r); }), 'the roster buttons trained runners');
  eq(viewer.spiritPoints, sp0, "roster TRAIN / REST give the Twitch viewer 'streamer' nothing");
  eq(Object.keys(S().hype.contributions), ['foxfan'], 'hype credit stays with real viewers');
  admin.run('hype');
  eq(Object.keys(S().hype.contributions), ['foxfan'], 'ADD HYPE credits nobody');
  const sum = SD.seasons.summary(S());
  eq(sum.topHypeContributor && sum.topHypeContributor.username, 'foxfan', "Top hype is the viewer who cheered, not 'streamer'");
}
function C_trained(r) { return r.lastActionAt != null || (r.trainStreak && r.trainStreak.count > 0); }

// -----------------------------------------------------------------------------
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
