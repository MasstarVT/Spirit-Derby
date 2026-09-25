#!/usr/bin/env node
/*
 * Spirit Derby - tools/integration-test.js
 * Assertion tests for the M7 input adapters (no network):
 *   Twitch: parseTags / parseLine on real-shaped IRC lines (PRIVMSG with tags, PING, a colon in
 *   the trailing text, escaped \s tag values, numerics, CAP), privmsgToChat isMod detection,
 *   routing through SD.processCommand with source 'twitch', PING → PONG, the 20-per-second flood
 *   guard (frozen SD.clock), backoff values, and the socket lifecycle against a fake WebSocket with
 *   fake timers (handshake, JOIN → on, drop → reconnecting, RECONNECT, fatal NOTICE, join timeout,
 *   watchdog, disconnect).
 *   Bridge: receive() with a valid frame / batch / malformed JSON / missing fields / aliases /
 *   flood guard, outbound hello / reply / race frames through a captured fake socket, reply
 *   filtering by source, and 'error' + quiet backoff when no server answers.
 *
 *   node tools/integration-test.js [--verbose]
 *
 * Exit code 1 on failure.
 */
'use strict';

const path = require('path');
const SD = require('./load-core.js');
// The adapters are browser-side modules (they may use Math.random for the guest nick and the
// backoff jitter), so the core's strict-random guard is lifted before they run.
SD.testing.strictRandom = false;
require(path.join(__dirname, '..', 'js', 'integrations', 'twitch.js'));
require(path.join(__dirname, '..', 'js', 'integrations', 'bridge.js'));

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
const twitch = SD.integrations.twitch;
const bridge = SD.integrations.bridge;

// -----------------------------------------------------------------------------
// Tiny assert helper (same output format as parser-test.js)
// -----------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log('\n' + title);
}
function ok(cond, name, detail) {
  if (cond) {
    passed++;
    if (VERBOSE) console.log('  PASS ' + name);
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
function has(str, needle, name) {
  return ok(typeof str === 'string' && str.indexOf(needle) >= 0, name, 'expected "' + needle + '" in "' + str + '"');
}
function between(v, lo, hi, name) {
  return ok(typeof v === 'number' && v >= lo && v <= hi, name, 'expected ' + lo + '..' + hi + ', got ' + v);
}
function noThrow(fn, name) {
  try { fn(); return ok(true, name); } catch (e) { return ok(false, name, 'threw ' + e.message); }
}

// -----------------------------------------------------------------------------
// Harness: frozen clock, fresh state, bus capture, fake timers, fake WebSocket
// -----------------------------------------------------------------------------
let NOW = 1700000000000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }

function fresh() {
  const rt = SD.state.runtime;
  rt.cooldowns = {};
  rt.runnerCooldowns = {};
  rt.chatFeed = [];
  rt.activity = {};
  SD.state.set(SD.state.create({ seedSalt: 424242, dayEventId: 'clearSkies' }));
  tick(60000);
  return SD.state.get();
}
fresh();
SD.game.init();

const chat = [];
const statusEvents = [];
SD.bus.on(SD.EVENTS.CHAT_MESSAGE, function (m) { chat.push(m); });
SD.bus.on(SD.EVENTS.INTEGRATION_STATUS, function (s) { statusEvents.push(s); });
function systemLines(re) { return chat.filter(function (m) { return m.kind === 'system' && re.test(m.text); }); }
function lastStatus(adapter) {
  for (let i = statusEvents.length - 1; i >= 0; i--) if (statusEvents[i].adapter === adapter) return statusEvents[i];
  return null;
}

// Fake timers: the adapters call the global setTimeout / setInterval at call time.
const REAL = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
let timers = [];
let timerSeq = 0;
function installFakeTimers() {
  globalThis.setTimeout = function (fn, ms) { const t = { id: ++timerSeq, fn: fn, ms: ms, kind: 'timeout' }; timers.push(t); return t.id; };
  globalThis.setInterval = function (fn, ms) { const t = { id: ++timerSeq, fn: fn, ms: ms, kind: 'interval' }; timers.push(t); return t.id; };
  globalThis.clearTimeout = globalThis.clearInterval = function (id) { timers = timers.filter(function (t) { return t.id !== id; }); };
}
function restoreTimers() { Object.assign(globalThis, REAL); timers = []; }
function timeouts() { return timers.filter(function (t) { return t.kind === 'timeout'; }); }
function intervals() { return timers.filter(function (t) { return t.kind === 'interval'; }); }
function fireTimeout(t) { timers = timers.filter(function (x) { return x !== t; }); t.fn(); }
function fireOnlyTimeout(name) {
  const list = timeouts();
  if (!ok(list.length === 1, name + ': exactly one pending timeout', list.map(function (t) { return t.ms; }))) return null;
  const t = list[0];
  fireTimeout(t);
  return t;
}

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    FakeWS.all.push(this);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('InvalidStateError: not open');
    this.sent.push(String(data));
  }
  close() { this.closed = true; this.readyState = 3; }
  // server side
  serverOpen() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  serverSend(data) { if (this.onmessage) this.onmessage({ data: data }); }
  serverClose(code) {
    this.readyState = 3;
    if (this.onerror) this.onerror({});
    if (this.onclose) this.onclose({ code: code || 1006, reason: '', wasClean: false });
  }
  frames() { return this.sent.map(function (s) { try { return JSON.parse(s); } catch (e) { return s; } }); }
}
FakeWS.all = [];
FakeWS.OPEN = 1;
function lastWS() { return FakeWS.all[FakeWS.all.length - 1]; }

// Real-shaped Twitch IRC lines.
const RAW_PRIV = '@badge-info=subscriber/14;badges=broadcaster/1,subscriber/12;client-nonce=459e3142897c7a22b7d275178f2259e0;' +
  'color=#FF4500;display-name=FoxStreams;emotes=25:0-4,12-16/1902:6-10;first-msg=0;flags=;id=b34ccfc7-4977-403a-8a94-33c6bac34fb8;' +
  'mod=0;returning-chatter=0;room-id=713936733;subscriber=1;tmi-sent-ts=1642696567751;turbo=0;user-id=713936733;user-type= ' +
  ':foxstreams!foxstreams@foxstreams.tmi.twitch.tv PRIVMSG #foxstreams :Kappa Keepo Kappa !train speed';
const RAW_MODTAG = '@badges=;color=;display-name=ModMia;emotes=;mod=1;user-type=mod :modmia!modmia@modmia.tmi.twitch.tv PRIVMSG #foxstreams :!race';
const RAW_MODBADGE = '@badges=moderator/1,partner/1;display-name=BrambleBob :bramblebob!bramblebob@bramblebob.tmi.twitch.tv PRIVMSG #foxstreams :hello there';
const RAW_VIEWER = '@badges=subscriber/6,premium/1;display-name=WispWatcher;mod=0 :wispwatcher!wispwatcher@wispwatcher.tmi.twitch.tv PRIVMSG #foxstreams :!cheer moss';
const RAW_VIP = '@badges=vip/1;display-name=Vippy;mod=0;vip=1 :vippy!vippy@vippy.tmi.twitch.tv PRIVMSG #foxstreams :!join';
function privFrom(login, text, tags) {
  return (tags ? '@' + tags + ' ' : '') + ':' + login + '!' + login + '@' + login + '.tmi.twitch.tv PRIVMSG #foxstreams :' + text;
}

// =============================================================================
section('twitch: parseTags / unescape');
{
  eq(twitch.parseTags('badge-info=;badges=broadcaster/1,subscriber/12;display-name=Fox\\sFan;msg=a\\:b\\\\c;flag'),
    { 'badge-info': '', badges: 'broadcaster/1,subscriber/12', 'display-name': 'Fox Fan', msg: 'a;b\\c', flag: '' },
    'tags: empty value, list value, \\s, \\:, \\\\, key without =');
  eq(twitch.parseTags('@mod=1;color=#1E90FF'), { mod: '1', color: '#1E90FF' }, 'leading @ is ignored');
  eq(twitch.parseTags(''), {}, 'empty tag string');
  eq(twitch.unescapeTag('line\\nbreak\\rend'), 'line\nbreak\rend', '\\n and \\r unescape');
  eq(twitch.unescapeTag('trail\\'), 'trail', 'lone trailing backslash dropped');
  eq(twitch.unescapeTag('\\q'), 'q', 'unknown escape keeps the character');
  eq(twitch.parseBadges('broadcaster/1,subscriber/3012,glhf-pledge/1'), { broadcaster: '1', subscriber: '3012', 'glhf-pledge': '1' }, 'badges');
  eq(twitch.parseBadges(''), {}, 'no badges');
}

section('twitch: parseLine');
{
  const p = twitch.parseLine(RAW_PRIV);
  eq(p.command, 'PRIVMSG', 'PRIVMSG command');
  eq(p.prefix, 'foxstreams!foxstreams@foxstreams.tmi.twitch.tv', 'prefix');
  eq(p.nick, 'foxstreams', 'nick from prefix');
  eq(p.params, ['#foxstreams', 'Kappa Keepo Kappa !train speed'], 'params = channel + trailing');
  eq(p.trailing, 'Kappa Keepo Kappa !train speed', 'trailing text');
  eq([p.tags['display-name'], p.tags.emotes, p.tags['user-type'], p.tags.flags, p.tags['tmi-sent-ts'], p.tags.color],
    ['FoxStreams', '25:0-4,12-16/1902:6-10', '', '', '1642696567751', '#FF4500'], 'tags incl. emotes with colons and empty values');

  const ping = twitch.parseLine('PING :tmi.twitch.tv');
  eq([ping.command, ping.trailing, ping.prefix, ping.params], ['PING', 'tmi.twitch.tv', null, ['tmi.twitch.tv']], 'PING');
  eq(twitch.pongFor(ping), 'PONG :tmi.twitch.tv', 'PONG answer');
  eq(twitch.parseLine('PING :tmi.twitch.tv\r\n').trailing, 'tmi.twitch.tv', 'CRLF stripped');

  const colon = twitch.parseLine(':moss_mom!moss_mom@moss_mom.tmi.twitch.tv PRIVMSG #foxstreams :race at 12:30 :) see you: there');
  eq(colon.trailing, 'race at 12:30 :) see you: there', 'colon inside the trailing text is kept');
  eq(colon.params[0], '#foxstreams', 'channel param before the trailing');

  const raid = twitch.parseLine('@msg-id=raid;display-name=Acorn\\sAndy;system-msg=15\\sraiders\\sfrom\\sAcornAndy\\shave\\sjoined!;msg-param-viewerCount=15 :tmi.twitch.tv USERNOTICE #foxstreams');
  eq([raid.command, raid.tags['system-msg'], raid.tags['display-name'], raid.nick, raid.trailing, raid.params],
    ['USERNOTICE', '15 raiders from AcornAndy have joined!', 'Acorn Andy', '', null, ['#foxstreams']], 'escaped \\s tag values, server prefix, no trailing');

  eq(twitch.parseLine(':tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!').params, ['justinfan12345', 'Welcome, GLHF!'], 'numeric 001');
  eq(twitch.parseLine(':tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands').params, ['*', 'ACK', 'twitch.tv/tags twitch.tv/commands'], 'CAP ACK');
  eq(twitch.parseLine(':nick!nick@nick.tmi.twitch.tv PRIVMSG #foxstreams :').trailing, '', 'empty trailing');
  eq(twitch.parseLine('privmsg #x :hi').command, 'PRIVMSG', 'command upper-cased');
  eq([twitch.parseLine(''), twitch.parseLine('   '), twitch.parseLine('@only-tags'), twitch.parseLine(':prefix-only'), twitch.parseLine(null)],
    [null, null, null, null, null], 'empty / truncated lines → null');
}

section('twitch: privmsgToChat (isMod detection)');
{
  const pc = function (raw) { return twitch.privmsgToChat(twitch.parseLine(raw)); };
  eq(pc(RAW_PRIV), { username: 'foxstreams', displayName: 'FoxStreams', text: 'Kappa Keepo Kappa !train speed', isMod: true }, 'broadcaster/1 badge → mod (mod=0 tag)');
  eq(pc(RAW_MODTAG).isMod, true, 'mod=1 tag → mod');
  eq(pc(RAW_MODBADGE).isMod, true, 'moderator/1 badge without mod tag → mod');
  eq(pc(RAW_VIEWER).isMod, false, 'subscriber badge → not mod');
  eq(pc(RAW_VIP).isMod, false, 'vip badge → not mod');
  eq(pc(privFrom('lanternliz', '!join')), { username: 'lanternliz', displayName: 'lanternliz', text: '!join', isMod: false }, 'no tags: nick from the prefix');
  eq(pc(privFrom('kitsune_jp', '!join', 'display-name=きつね')), { username: 'kitsune_jp', displayName: 'きつね', text: '!join', isMod: false }, 'localized display name keeps the login as key');
  eq(pc(privFrom('acorn', '\u0001ACTION cheers loudly\u0001')).text, 'cheers loudly', '/me ACTION unwrapped');
  eq(pc(privFrom('acorn', '@FoxStreams !cheer moss', 'reply-parent-display-name=FoxStreams;reply-parent-user-login=foxstreams;display-name=Acorn')).text,
    '!cheer moss', 'thread reply "@Parent " prefix removed');
  eq(pc(privFrom('acorn', '  !rest  ')).text, '!rest', 'text trimmed');
  eq(twitch.privmsgToChat(twitch.parseLine('PING :tmi.twitch.tv')), null, 'non-PRIVMSG → null');
  eq(twitch.privmsgToChat(null), null, 'null → null');
}

section('twitch: normalizeChannel');
{
  eq(['#FoxStreams', 'foxstreams', '@fox_1', 'https://www.twitch.tv/FoxStreams?sr=a', 'twitch.tv/fox/videos', ' fox '].map(twitch.normalizeChannel),
    ['foxstreams', 'foxstreams', 'fox_1', 'foxstreams', 'fox', 'fox'], 'accepted forms');
  eq(['', 'bad-name', 'x'.repeat(26), null].map(twitch.normalizeChannel), ['', '', '', ''], 'rejected forms');
}

section('twitch: routing through SD.processCommand (stub)');
{
  const realPC = SD.processCommand;
  const calls = [];
  SD.processCommand = function (u, t, o) { calls.push([u, t, o]); return { ok: true, isCommand: true }; };
  twitch.resetStats();
  const acc = twitch.receive(RAW_PRIV);
  eq(calls.length, 1, 'PRIVMSG → one processCommand call');
  eq(calls[0], ['foxstreams', 'Kappa Keepo Kappa !train speed', { source: 'twitch', isMod: true, displayName: 'FoxStreams' }],
    'called with (login, text, { source:"twitch", isMod, displayName })');
  eq([acc.lines, acc.routed, acc.dropped], [1, 1, 0], 'receive() summary');

  const pong = twitch.receive('PING :tmi.twitch.tv');
  eq(pong.out, ['PONG :tmi.twitch.tv'], 'PING → PONG generated');
  eq(calls.length, 1, 'PING is not routed');

  const multi = twitch.receive('PING :tmi.twitch.tv\r\n' + RAW_MODTAG + '\r\n@msg-id=slow_on :tmi.twitch.tv NOTICE #foxstreams :This room is now in slow mode.\r\n' +
    '@emote-only=0;room-id=1 :tmi.twitch.tv ROOMSTATE #foxstreams\r\n:tmi.twitch.tv USERSTATE #foxstreams\r\n');
  eq([multi.lines, multi.routed, multi.out], [5, 1, ['PONG :tmi.twitch.tv']], 'multi-line frame: 5 lines, 1 routed, 1 PONG');
  eq(calls[1][2], { source: 'twitch', isMod: true, displayName: 'ModMia' }, 'mod tag routed as isMod');
  has(twitch.status().lastLine, 'USERSTATE', 'status lines recorded, not routed');
  ok(twitch.recentLines().some(function (l) { return /slow_on/.test(l.text); }), 'NOTICE kept as a status line');

  twitch.receive(privFrom('ghost', '   '));
  eq(calls.length, 2, 'blank PRIVMSG is not routed');
  eq(twitch.status().state, 'off', 'receiving lines without a socket does not change the state');
  SD.processCommand = realPC;
}

section('twitch: real pipeline');
{
  fresh();
  chat.length = 0;
  twitch.resetStats();
  twitch.receive(privFrom('foxfan', '!join', 'display-name=FoxFan;badges=;mod=0'));
  const p = SD.players.get(SD.state.get(), 'foxfan');
  ok(!!p, '!join from Twitch creates the player');
  eq(p && p.displayName, 'FoxFan', 'display name from the tag');
  const user = chat.filter(function (m) { return m.kind === 'user'; })[0];
  const reply = chat.filter(function (m) { return m.kind === 'reply'; })[0];
  eq([user && user.source, user && user.displayName, reply && reply.source, reply && reply.ok], ['twitch', 'FoxFan', 'twitch', true], 'chat:message user + reply lines carry source twitch');
  twitch.receive(privFrom('foxfan', '!status', 'display-name=FoxFan;badges=moderator/1;mod=1'));
  eq(SD.players.get(SD.state.get(), 'foxfan').isMod, true, 'Twitch mod flag reaches the player');
  twitch.receive(privFrom('foxfan', 'just chatting'));
  eq(chat.filter(function (m) { return m.kind === 'user' && m.text === 'just chatting'; }).length, 1, 'plain chat shows in the feed');
}

section('twitch: flood guard (20 per second, frozen clock)');
{
  const realPC = SD.processCommand;
  let n = 0;
  SD.processCommand = function () { n++; return { ok: true }; };
  twitch.resetStats();
  for (let i = 0; i < 21; i++) twitch.receive(privFrom('raider' + i, '!cheer'));
  eq(n, 20, '21st message in the same second is not routed');
  eq([twitch.status().messages, twitch.status().dropped], [20, 1], 'status counts 20 routed, 1 dropped');
  tick(999);
  twitch.receive(privFrom('late', '!cheer'));
  eq([n, twitch.status().dropped], [20, 2], 'still limited 999 ms later');
  tick(2);
  twitch.receive(privFrom('later', '!cheer'));
  eq(n, 21, 'window slides after 1 s');
  twitch.resetStats();
  tick(5000);
  const frame = [];
  for (let i = 0; i < 25; i++) frame.push(privFrom('burst' + i, 'PogChamp'));
  const acc = twitch.receive(frame.join('\r\n'));
  eq([acc.routed, acc.dropped], [20, 5], 'one 25-line frame: 20 routed, 5 dropped');
  SD.processCommand = realPC;

  const lim = twitch.createRateLimiter(3, 1000);
  eq([lim.allow(0), lim.allow(10), lim.allow(20), lim.allow(30), lim.allow(999), lim.allow(1000), lim.allow(1001)],
    [true, true, true, false, false, true, false], 'createRateLimiter sliding window');
  tick(5000);
}

section('backoff');
{
  const half = function () { return 0.5; };
  const seq = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(function (i) { return twitch.backoffDelay(i, half); });
  eq(seq, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000], 'twitch: 1 s → 2 → 4 … capped at 60 s');
  eq([0, 1, 2, 3, 6].map(function (i) { return bridge.backoffDelay(i, half); }), [1000, 2000, 4000, 8000, 60000], 'bridge: same sequence');
  [0, 0.25, 0.75, 0.999].forEach(function (r) {
    const f = function () { return r; };
    between(twitch.backoffDelay(0, f), 800, 1200, 'jitter r=' + r + ' attempt 0 within ±20 %');
    between(twitch.backoffDelay(3, f), 6400, 9600, 'jitter r=' + r + ' attempt 3 within ±20 %');
    between(twitch.backoffDelay(12, f), 48000, 60000, 'jitter r=' + r + ' never above the 60 s cap');
  });
  eq([twitch.backoffDelay(1000, half), twitch.backoffDelay(-3, half), twitch.backoffDelay(NaN, half), twitch.backoffDelay('x', half)],
    [60000, 1000, 1000, 1000], 'huge / negative / NaN attempts');
  between(twitch.backoffDelay(2), 3200, 4800, 'default random stays in range');
}

section('twitch: connect guards (Node, no WebSocket)');
{
  delete globalThis.WebSocket;
  const r = twitch.connect('foxstreams');
  eq([r.ok, twitch.status().state], [false, 'off'], 'no WebSocket → { ok:false }, state stays off');
  has(r.message, 'WebSocket', 'message explains why');
  eq(twitch.connect('bad channel!').ok, false, 'invalid channel refused');
  eq(twitch.connect('').ok, false, 'empty channel with nothing saved refused');
  eq(bridge.connect('ws://localhost:8765').ok, false, 'bridge: no WebSocket → { ok:false }');
  eq(bridge.connect('http://localhost:8765').ok, false, 'bridge: http:// URL refused');
  eq([bridge.normalizeUrl(' ws://localhost:8765 '), bridge.normalizeUrl('wss://relay.example:443/x'), bridge.normalizeUrl('ftp://x'), bridge.normalizeUrl('ws://')],
    ['ws://localhost:8765', 'wss://relay.example:443/x', '', ''], 'bridge URL normalisation');
  eq(bridge.send({ type: 'x' }), false, 'bridge.send() while closed is a no-op');
}

section('twitch: socket lifecycle (fake WebSocket + fake timers)');
{
  installFakeTimers();
  globalThis.WebSocket = FakeWS;
  fresh();
  chat.length = 0;
  statusEvents.length = 0;

  const r = twitch.connect('#FoxStreams');
  eq(r.ok, true, 'connect ok');
  const ws1 = lastWS();
  eq(ws1.url, 'wss://irc-ws.chat.twitch.tv:443', 'opens the IRC WebSocket gateway');
  eq(twitch.status().state, 'connecting', 'state connecting');
  const ev = lastStatus('twitch');
  ok(ev && ev.state === 'connecting' && ev.channel === 'foxstreams' && 'since' in ev && 'messages' in ev && 'lastError' in ev,
    'integration:status { adapter:"twitch", state, channel, since, messages, lastError }', ev);
  eq(SD.state.runtime.connected.twitch, 'connecting', 'runtime.connected.twitch mirrors the state');
  const again = twitch.connect('foxstreams');
  eq([again.ok, FakeWS.all.length], [true, 1], 'connecting twice to the same channel opens no second socket');

  ws1.serverOpen();
  const nick = twitch.status().nick;
  ok(/^justinfan\d{5}$/.test(nick), 'guest nick justinfan + 5 digits', nick);
  eq(ws1.sent, ['CAP REQ :twitch.tv/tags twitch.tv/commands\r\n', 'PASS SCHMOOPIIE\r\n', 'NICK ' + nick + '\r\n', 'JOIN #foxstreams\r\n'],
    'handshake: CAP REQ, PASS, NICK, JOIN');
  eq(twitch.status().state, 'connecting', 'still connecting until the JOIN is confirmed');
  eq(timeouts().map(function (t) { return t.ms; }), [15000], 'join timeout armed');

  ws1.serverSend(':tmi.twitch.tv 001 ' + nick + ' :Welcome, GLHF!\r\n:' + nick + '!' + nick + '@' + nick + '.tmi.twitch.tv JOIN #foxstreams\r\n');
  eq(twitch.status().state, 'on', 'own JOIN → on');
  eq(SD.state.runtime.connected.twitch, 'on', 'runtime.connected.twitch = on');
  eq(systemLines(/^📡 Connected to Twitch chat #foxstreams/).length, 1, 'system chat line "Connected to Twitch chat #foxstreams"');
  eq([timeouts().length, intervals().length], [0, 1], 'join timeout cleared, watchdog running');

  ws1.serverSend('PING :tmi.twitch.tv\r\n');
  eq(ws1.sent[ws1.sent.length - 1], 'PONG :tmi.twitch.tv\r\n', 'PING answered with PONG on the socket');
  ws1.serverSend(privFrom('foxfan', '!join', 'display-name=FoxFan'));
  ok(!!SD.players.get(SD.state.get(), 'foxfan'), 'socket PRIVMSG reaches the pipeline');
  eq(twitch.status().messages, 1, 'message counter');

  // watchdog: 4.5 min of silence → our own PING; 6 min → reconnect
  const wd = intervals()[0];
  tick(271000);
  wd.fn();
  eq(ws1.sent[ws1.sent.length - 1], 'PING :spiritderby\r\n', 'watchdog pings after 4.5 min of silence');
  tick(90000);
  wd.fn();
  eq(twitch.status().state, 'reconnecting', 'watchdog drops a silent socket → reconnecting');
  ok(ws1.closed, 'silent socket closed');
  eq(systemLines(/Lost Twitch chat #foxstreams/).length, 1, 'outage announced once');
  const t1 = fireOnlyTimeout('retry after watchdog');
  between(t1 && t1.ms, 800, 1200, 'first retry after a long-lived connection ≈ 1 s');

  // retry fails before opening → still reconnecting, delay grows, no second announcement
  const ws2 = lastWS();
  ok(ws2 !== ws1, 'retry opened a new socket');
  ws2.serverClose(1006);
  eq(twitch.status().state, 'reconnecting', 'failed retry keeps reconnecting');
  eq(twitch.status().attempt, 2, 'attempt counter');
  const t2 = fireOnlyTimeout('second retry');
  between(t2 && t2.ms, 1600, 2400, 'second retry ≈ 2 s');
  eq(systemLines(/Lost Twitch chat/).length, 1, 'no chat spam per retry');

  const ws3 = lastWS();
  ws3.serverOpen();
  ws3.serverSend('@emote-only=0;room-id=713936733 :tmi.twitch.tv ROOMSTATE #foxstreams');
  eq(twitch.status().state, 'on', 'ROOMSTATE also confirms the join');
  eq(systemLines(/^📡 Reconnected to Twitch chat #foxstreams/).length, 1, '"Reconnected" system line');

  // RECONNECT (Twitch maintenance) → reconnect at once, fresh backoff
  tick(1000);
  ws3.serverSend(':tmi.twitch.tv RECONNECT');
  ok(ws3.closed, 'RECONNECT closes the old socket');
  eq(twitch.status().state, 'reconnecting', 'RECONNECT → reconnecting');
  const t3 = fireOnlyTimeout('retry after RECONNECT');
  between(t3 && t3.ms, 800, 1200, 'RECONNECT retries after ≈ 1 s (backoff reset)');
  const ws4 = lastWS();
  ws4.serverOpen();
  ws4.serverSend(':' + twitch.status().nick + '!x@x.tmi.twitch.tv JOIN #foxstreams');
  eq(twitch.status().state, 'on', 'back on after RECONNECT');

  // fatal NOTICE → error, no retries
  ws4.serverSend('@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #foxstreams :This channel does not exist or has been suspended.');
  const s = twitch.status();
  eq([s.state, s.enabled, s.nextRetryAt, timeouts().length, intervals().length], ['error', false, null, 0, 0], 'fatal NOTICE → error, retries stopped, timers cleared');
  has(s.lastError, 'suspended', 'lastError carries the NOTICE');
  ok(ws4.closed, 'socket closed after a fatal NOTICE');

  // never reaches Twitch → error + backoff
  statusEvents.length = 0;
  twitch.connect('foxstreams');
  const ws5 = lastWS();
  ws5.serverClose(1006);
  const e5 = twitch.status();
  eq(e5.state, 'error', 'an attempt that never connects → error');
  has(e5.lastError, 'Could not reach Twitch chat', 'error message');
  between(e5.nextRetryAt - NOW, 800, 1200, 'nextRetryAt ≈ 1 s ahead');
  eq(lastStatus('twitch').state, 'error', 'integration:status emitted for the error');
  fireOnlyTimeout('retry after error');
  eq(twitch.status().state, 'error', 'retry attempt keeps the error state until it succeeds');

  // join timeout → retry
  const ws6 = lastWS();
  ws6.serverOpen();
  const jt = timeouts().filter(function (t) { return t.ms === 15000; })[0];
  ok(!!jt, 'join timeout armed on open');
  if (jt) fireTimeout(jt);
  eq(twitch.status().state, 'error', 'no JOIN confirmation → error + retry');
  has(twitch.status().lastError, 'did not confirm', 'join-timeout message');
  eq(timeouts().length, 1, 'one retry pending');

  // disconnect clears everything
  const d = twitch.disconnect();
  eq([d.ok, twitch.status().state, timeouts().length, intervals().length], [true, 'off', 0, 0], 'disconnect → off, no timers left');
  eq(SD.state.runtime.connected.twitch, 'off', 'runtime.connected.twitch = off');
  eq(twitch.disconnect().message, 'Twitch chat is not connected.', 'second disconnect is harmless');
  ok(statusEvents.every(function (e) { return e.adapter === 'twitch' && typeof e.state === 'string'; }), 'every twitch status event is tagged adapter "twitch"');
}

section('bridge: receive()');
{
  fresh();
  chat.length = 0;
  bridge.resetStats();
  const r1 = bridge.receive('{"username":"FoxFan","text":"!join","isMod":false}');
  eq([r1.ok, r1.handled, r1.malformed], [true, 1, 0], 'valid frame handled');
  eq([r1.results[0].command, r1.results[0].ok], ['join', true], 'result from the real pipeline');
  ok(!!SD.players.get(SD.state.get(), 'foxfan'), 'player created via the bridge');
  const u = chat.filter(function (m) { return m.kind === 'user'; })[0];
  eq(u && u.source, 'bridge', 'chat:message source bridge');

  const realPC = SD.processCommand;
  const calls = [];
  SD.processCommand = function (a, b, c) { calls.push([a, b, c]); return { ok: true, isCommand: true, command: 'x', message: 'ok' }; };
  bridge.receive('{"username":"ModMia","text":"!race","isMod":true,"displayName":"Mod Mia"}');
  eq(calls[0], ['ModMia', '!race', { source: 'bridge', isMod: true, displayName: 'Mod Mia' }], 'processCommand(username, text, { source:"bridge", isMod, displayName })');
  bridge.receive('{"username":"A","text":"!status","isMod":"true"}');
  bridge.receive('{"username":"B","text":"!status"}');
  bridge.receive('{"username":"C","text":"!status","isBroadcaster":1}');
  eq(calls.slice(1).map(function (c) { return c[2].isMod; }), [true, false, true], 'isMod "true" / missing / isBroadcaster:1');
  bridge.receive('{"user":"Acorn","message":"!cheer"}');
  eq(calls[calls.length - 1].slice(0, 2), ['Acorn', '!cheer'], 'aliases user / message accepted');

  calls.length = 0;
  const batch = bridge.receive(JSON.stringify([{ username: 'A', text: '!join' }, { username: 'B', text: '!join' }, { username: 'C', text: 'hi chat' }]));
  eq([batch.ok, batch.handled, calls.length], [true, 3, 3], 'batch array of 3');
  const mixed = bridge.receive('[{"username":"A","text":"hi"},{"text":"no user"},7]');
  eq([mixed.ok, mixed.handled, mixed.malformed], [false, 1, 2], 'batch with bad items: good ones still handled');

  const before = bridge.status().malformed;
  let bad;
  noThrow(function () { bad = bridge.receive('{nope'); }, 'malformed JSON does not throw');
  eq([bad.ok, bad.malformed, bad.handled], [false, 1, 0], 'malformed JSON counted + ignored');
  eq(bridge.status().malformed, before + 1, 'status().malformed counter');
  eq(bridge.status().lastBad, 'not valid JSON', 'status().lastBad');
  const missing = ['{"text":"!join"}', '{"username":"x"}', '{"username":"x","text":"   "}', '{"username":"","text":"!join"}',
    '42', 'null', '"just a string"', '[[1]]'];
  missing.forEach(function (f) {
    const res = bridge.receive(f);
    ok(res.ok === false && res.malformed === 1 && res.handled === 0, 'missing fields / wrong shape ignored: ' + f, res);
  });
  noThrow(function () { bridge.receive(undefined); bridge.receive(''); bridge.receive(12); }, 'undefined / empty / number input never throws');
  eq(bridge.receive('x'.repeat(70000)).malformed, 1, 'oversized frame rejected');
  eq(bridge.receive('{"type":"hello","app":"relay"}').ignored, 1, 'unknown frame type ignored');
  eq(bridge.receive('{"type":"ping"}').ignored, 1, 'ping handled (no socket: pong is a no-op)');
  calls.length = 0;
  bridge.receive({ username: 'Obj', text: '!help' });
  eq(calls.length, 1, 'already-parsed object accepted (console convenience)');

  bridge.resetStats();
  calls.length = 0;
  tick(5000);
  const flood = [];
  for (let i = 0; i < 25; i++) flood.push({ username: 'raider' + i, text: '!cheer' });
  const fr = bridge.receive(JSON.stringify(flood));
  eq([fr.handled, fr.dropped, calls.length, bridge.status().dropped], [20, 5, 20, 5], 'flood guard: 25 in one second → 20 handled, 5 dropped');
  SD.processCommand = realPC;
  tick(5000);
}

section('bridge: outbound frames (fake WebSocket)');
{
  fresh();
  chat.length = 0;
  statusEvents.length = 0;
  bridge.init();
  bridge.configure({ replySources: ['bridge', 'twitch'], replyUnknown: false });
  const c = bridge.connect('ws://localhost:8765');
  eq([c.ok, bridge.status().state, lastWS().url], [true, 'connecting', 'ws://localhost:8765'], 'connect → connecting');
  const ws = lastWS();
  ws.serverOpen();
  eq(bridge.status().state, 'on', 'open → on');
  eq(SD.state.runtime.connected.bridge, 'on', 'runtime.connected.bridge = on');
  const hello = ws.frames()[0];
  eq([hello.type, hello.app, hello.protocol], ['hello', 'spirit-derby', 1], 'hello frame on open');
  eq(systemLines(/^🔌 Connected to the chat bridge/).length, 1, 'system chat line on connect');

  function replies() { return ws.frames().filter(function (f) { return f && f.type === 'reply'; }); }
  bridge.receive('{"username":"FoxFan","text":"!join"}');
  bridge.receive('{"username":"FoxFan","text":"!claim"}');
  const rep = replies();
  eq(rep.length, 2, 'one reply frame per bridge command');
  const r0 = rep[0];
  ok(r0.type === 'reply' && r0.username === 'foxfan' && r0.command === 'join' && r0.ok === true && typeof r0.message === 'string' && r0.message.length > 0,
    'reply frame { type, username, command, ok, message }', r0);
  eq([r0.displayName, r0.source, r0.chat.indexOf('@FoxFan ')], ['FoxFan', 'bridge', 0], 'reply extras: displayName, source, ready-to-post chat line');

  const n0 = replies().length;
  twitch.receive(privFrom('wispwatcher', '!join', 'display-name=WispWatcher'));
  eq(replies().length, n0 + 1, 'Twitch-sourced command results are relayed too');
  eq(replies()[n0].source, 'twitch', '… tagged source twitch');
  SD.processCommand('SimBot', '!join');
  SD.processCommand('Streamer', '!status', { source: 'admin', isMod: true });
  eq(replies().length, n0 + 1, 'sim / admin results are not sent to the bridge');
  bridge.receive('{"username":"FoxFan","text":"hello chat"}');
  eq(replies().length, n0 + 1, 'plain chat produces no reply frame');
  bridge.receive('{"username":"FoxFan","text":"!discord"}');
  eq(replies().length, n0 + 1, 'unknown commands (other bots) are not relayed by default');
  bridge.configure({ replyUnknown: true });
  bridge.receive('{"username":"FoxFan","text":"!discord"}');
  eq([replies().length, replies()[replies().length - 1].unknown], [n0 + 2, true], 'configure({ replyUnknown:true }) relays them with unknown:true');
  bridge.configure({ replyUnknown: false });

  bridge.receive('{"username":"FoxFan","text":"!train speed"}');
  bridge.receive('{"username":"FoxFan","text":"!train speed"}');
  const cd = replies()[replies().length - 1];
  eq([cd.command, cd.ok, cd.cooldown], ['train', false, true], 'cooldown refusal carries cooldown:true');

  bridge.receive('{"type":"ping"}');
  eq(ws.frames()[ws.frames().length - 1].type, 'pong', 'ping → pong');

  // race frame on race:finished (Node: endRace finishes at once)
  const start = SD.game.startRace({ distance: 1200, runnerCount: 4 });
  eq(start.ok, true, 'race started');
  const locked = bridge.receive('{"username":"FoxFan","text":"!train speed"}');
  eq(locked.results[0].ok, false, 'mutating command refused during the race');
  eq(replies()[replies().length - 1].locked, true, 'race-lock refusal carries locked:true');
  SD.game.endRace();
  const race = ws.frames().filter(function (f) { return f && f.type === 'race'; });
  eq(race.length, 1, 'one race frame');
  const rf = race[0] || {};
  ok(typeof rf.winner === 'string' && rf.winner.length > 0, 'race frame winner', rf.winner);
  eq(Array.isArray(rf.results) && rf.results.length, 4, 'race frame lists every runner');
  eq(rf.results && rf.results.map(function (x) { return x.place; }), [1, 2, 3, 4], 'results sorted by place');
  ok(rf.results && rf.results.every(function (x) { return 'place' in x && 'name' in x && 'owner' in x; }), 'results [{ place, name, owner }]');
  eq(rf.results && rf.results[0].name, rf.winner, 'winner = 1st place');
  ok(rf.results && rf.results.some(function (x) { return x.owner === 'FoxFan'; }), "FoxFan's claimed runner raced with its owner");
  has(rf.message, rf.winner, 'ready-to-post race message');
  eq(bridge.raceFrame({}).message, '🏁 The race is over!', 'raceFrame tolerates an empty payload');

  // drop after 'on' → reconnecting, then disconnect
  tick(20000);
  ws.serverClose(1001);
  eq(bridge.status().state, 'reconnecting', 'lost after on → reconnecting');
  eq(systemLines(/Lost the chat bridge/).length, 1, 'outage announced once');
  bridge.disconnect();
  eq([bridge.status().state, timeouts().length, bridge.send({ type: 'x' })], ['off', 0, false], 'disconnect → off, no timers, send() no-op');
  ok(statusEvents.filter(function (e) { return e.adapter === 'bridge'; }).length > 0 &&
    statusEvents.filter(function (e) { return e.adapter === 'bridge'; }).every(function (e) { return 'url' in e && 'state' in e && 'malformed' in e; }),
    'bridge status events { adapter:"bridge", state, url, … }');
}

section('bridge: no server → error + quiet backoff');
{
  chat.length = 0;
  const spy = { n: 0 };
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  ['warn', 'error', 'info'].forEach(function (k) { console[k] = function () { spy.n++; }; });
  bridge.connect('ws://localhost:8765');
  lastWS().serverClose(1006);
  const s1 = bridge.status();
  eq(s1.state, 'error', 'no server → error');
  has(s1.lastError, 'No bridge is answering at ws://localhost:8765', 'error names the URL');
  const d1 = fireOnlyTimeout('bridge retry 1');
  between(d1 && d1.ms, 800, 1200, 'retry 1 ≈ 1 s');
  lastWS().serverClose(1006);
  const d2 = fireOnlyTimeout('bridge retry 2');
  between(d2 && d2.ms, 1600, 2400, 'retry 2 ≈ 2 s');
  lastWS().serverClose(1006);
  const d3 = timeouts()[0];
  between(d3 && d3.ms, 3200, 4800, 'retry 3 ≈ 4 s');
  eq(bridge.status().state, 'error', 'still error while retrying');
  eq(bridge.status().attempt, 3, 'attempt counter');
  eq(systemLines(/No chat bridge at ws:\/\/localhost:8765/).length, 1, 'one chat line for the whole outage');
  Object.assign(console, saved);
  eq(spy.n, 0, 'no console output per retry');
  if (d3) fireTimeout(d3);
  lastWS().serverOpen();
  eq(bridge.status().state, 'on', 'the relay starts later → on');
  eq(systemLines(/^🔌 Connected to the chat bridge/).length, 1, '"Connected" once it answers');
  bridge.disconnect();
  eq([bridge.status().state, SD.state.runtime.connected.bridge, timers.length], ['off', 'off', 0], 'clean disconnect');
}

restoreTimers();
delete globalThis.WebSocket;

// -----------------------------------------------------------------------------
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
