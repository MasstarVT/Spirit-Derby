#!/usr/bin/env node
/*
 * Spirit Derby - tools/parser-test.js
 * Assertion tests for the chat command parser and pipeline (plan section 12):
 * parse + aliases, plain chat, player gate, join idempotency + daily bonus, claim rules,
 * training (gains, energy, SP, hype, cooldowns, open training), rest cooldowns, cheers
 * (hype, SP, queued cheer effects, nervous cure), the race lock and owner/backer payouts,
 * status / inspect content, unknown commands, admin permission, check-then-commit
 * and the SD.processCommand alias.
 *
 *   node tools/parser-test.js [--verbose]
 *
 * SD.clock is frozen (advance with tick(ms)) so cooldowns are exact. Exit code 1 on failure.
 */
'use strict';

const SD = require('./load-core.js');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;

// -----------------------------------------------------------------------------
// Tiny assert helper
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

// -----------------------------------------------------------------------------
// Harness: frozen clock, fresh deterministic state, bus capture
// -----------------------------------------------------------------------------
let NOW = 1700000000000;
SD.clock.set(function () { return NOW; });
function tick(ms) { NOW += ms; }

const SALT = 424242;
function fresh(opts) {
  const rt = SD.state.runtime;
  rt.cooldowns = {};
  rt.runnerCooldowns = {};
  rt.chatFeed = [];
  rt.nervousCheers = {};
  SD.state.set(SD.state.create(Object.assign({ seedSalt: SALT, dayEventId: 'clearSkies' }, opts || {})));
  SD.game.init();
  tick(60000);
  return SD.state.get();
}
function S() { return SD.state.get(); }
function say(user, text, opts) { return SD.processCommand(user, text, opts); }
function player(u) { return SD.players.get(S(), u); }
function runner(q) { return SD.state.findRunner(q).runner; }
function effect(res, type) { return (res.effects || []).filter(function (e) { return e.type === type; })[0]; }
const USER_CD = SD.CONFIG.COOLDOWNS.USER_S * 1000;
const CHEER_CD = SD.CONFIG.COOLDOWNS.CHEER_S * 1000;

const captured = [];
SD.bus.on(SD.EVENTS.CHAT_MESSAGE, function (m) { captured.push(m); });
const results = [];
SD.bus.on(SD.EVENTS.COMMAND_RESULT, function (r) { results.push(r); });

// -----------------------------------------------------------------------------
section('parse()');
// -----------------------------------------------------------------------------
{
  const p = SD.commands.parse;
  eq(p('!join') && p('!join').name, 'join', '!join -> join');
  eq(p('!join').args, [], '!join has no args');
  const t = p('  !TRAIN  Speed  ');
  eq(t && [t.name, t.args], ['train', ['Speed']], 'case-insensitive name, trimmed args');
  eq(p('!t spd').name, 'train', 'alias t -> train');
  eq(p('!t spd').invoked, 't', 'invoked keeps the typed alias');
  eq(p('!lb').name, 'leaderboard', 'alias lb -> leaderboard');
  eq(p('!stats').name, 'status', 'alias stats -> status');
  eq(p('!r').name, 'rest', 'alias r -> rest');
  eq(p('!c moss').name, 'cheer', 'alias c -> cheer');
  eq(p('!i moss').name, 'inspect', 'alias i -> inspect');
  eq(p('!h').name, 'help', 'alias h -> help');
  eq(p('!commands').name, 'help', 'alias commands -> help');
  eq(p('!cheer @MossRunner').args, ['MossRunner'], '@ stripped from args');
  eq(p('!train @@moss   speed').args, ['moss', 'speed'], 'multiple @ and extra spaces');
  eq(p('!bet moss 50').argText, 'moss 50', 'argText joins args');
  eq(p('!train moss​').args, ['moss'], 'zero-width characters stripped');
  eq(p('hello chat'), null, 'plain text -> null');
  eq(p(''), null, 'empty -> null');
  eq(p('!'), null, '"!" alone -> null');
  eq(p('! train'), null, '"! train" -> null');
  eq(p('!!'), null, '"!!" -> null');
  eq(p('gg !train speed'), null, 'command not at the start -> null');
  eq(p(null), null, 'null -> null');
  eq(p(42), null, 'number -> null');
}

// -----------------------------------------------------------------------------
section('handleChat: plain chat and chat:message');
// -----------------------------------------------------------------------------
{
  fresh();
  captured.length = 0;
  const r = SD.commands.handleChat({ username: 'Viewer1', text: 'hello forest', source: 'sim' });
  eq([r.ok, r.isCommand, r.command], [true, false, null], 'plain text -> ok, isCommand:false');
  eq(captured.length, 1, 'exactly one chat:message for plain text');
  eq(captured[0] && [captured[0].kind, captured[0].text, captured[0].username, captured[0].displayName, captured[0].source],
    ['user', 'hello forest', 'viewer1', 'Viewer1', 'sim'], 'user line payload');
  ok(captured[0] && typeof captured[0].id === 'string' && typeof captured[0].ts === 'number', 'user line has id and ts');
  captured.length = 0;
  results.length = 0;
  const c = SD.commands.handleChat({ username: 'Viewer1', text: '!help', source: 'sim' });
  eq([c.ok, c.isCommand, c.command], [true, true, 'help'], '!help via handleChat');
  eq(captured.map(function (m) { return m.kind; }), ['user', 'reply'], 'command emits user line then reply');
  eq(captured[1] && captured[1].replyTo, captured[0] && captured[0].id, 'reply references the user line');
  eq(results.length, 1, 'command:result emitted once');
  const empty = SD.commands.handleChat({ username: 'Viewer1', text: '   ' });
  eq(empty.ok, false, 'empty text refused');
  ok(SD.state.runtime.chatFeed.length > 0, 'runtime.chatFeed records messages');
  for (let i = 0; i < 120; i++) SD.commands.handleChat({ username: 'Spammer', text: 'spam ' + i });
  ok(SD.state.runtime.chatFeed.length <= 80, 'chatFeed capped at 80', SD.state.runtime.chatFeed.length);
}

// -----------------------------------------------------------------------------
section('player gate and !join');
// -----------------------------------------------------------------------------
{
  fresh();
  const pre = say('FoxFan', '!train speed');
  eq(pre.ok, false, '!train before !join refused');
  has(pre.message, '!join', 'refusal tells you to !join');
  eq(Object.keys(S().players).length, 0, 'no player created by the refusal');

  const j1 = say('@FoxFan', '!join');
  eq(j1.ok, true, 'first !join ok');
  eq(player('foxfan') && player('foxfan').spiritPoints, SD.CONFIG.ECONOMY.JOIN_SP, 'first join gives 200 SP');
  eq(player('foxfan').displayName, 'FoxFan', 'displayName keeps case, @ stripped');
  eq(player('FOXFAN') === player('@foxfan'), true, 'lookups normalise case and @');
  const j2 = say('foxfan', '!join');
  eq(j2.ok, true, 'second !join ok (idempotent)');
  has(j2.message, 'already', 'second !join says already in');
  eq(Object.keys(S().players).length, 1, 'still one player');
  eq(player('foxfan').spiritPoints, 200, 'no second join bonus');
  eq(player('foxfan').stats.commands, 1, 'a repeated read-only command inside the activity window counts once (anti-spam)');
  tick(SD.CONFIG.LEADERBOARDS.READONLY_ACTIVITY_S * 1000);
  say('FoxFan', '!join');
  eq(player('foxfan').stats.commands, 2, 'stats.commands counts the read-only command again after the window');

  const keys = Object.keys(player('foxfan')).sort();
  eq(keys, ['achievements', 'backing', 'displayName', 'isMod', 'joinedAt', 'lastDailyDay', 'lastSeen', 'lifetime',
    'runnerId', 'spiritPoints', 'stats', 'username'], 'Player shape matches plan section 2');
  eq(Object.keys(player('foxfan').stats).sort(), SD.players.STAT_KEYS.slice().sort(), 'stats keys per plan');
  eq(player('foxfan').backing, { runnerId: null, actions: 0 }, 'backing starts empty');

  // Daily first-action bonus on a new in-game day.
  const nd = SD.game.nextDay();
  eq(nd.ok, true, 'nextDay ok');
  tick(1000);
  const s1 = say('FoxFan', '!status');
  has(s1.message, 'Daily bonus +' + SD.CONFIG.ECONOMY.DAILY_SP, 'first action of the day mentions the daily bonus');
  eq(player('foxfan').spiritPoints, 250, 'daily bonus +50');
  say('FoxFan', '!status');
  eq(player('foxfan').spiritPoints, 250, 'no second daily bonus the same day');
}

// -----------------------------------------------------------------------------
section('!claim');
// -----------------------------------------------------------------------------
{
  fresh();
  say('FoxFan', '!join');
  say('MothMom', '!join');
  const noPlayer = say('Nobody', '!claim moss');
  has(noPlayer.message, '!join', 'claim requires a player');
  const c1 = say('FoxFan', '!claim moss');
  eq(c1.ok, true, '!claim moss ok');
  const moss = runner('moss');
  eq(moss.owner, 'FoxFan', 'runner.owner set to the display name');
  eq(player('foxfan').runnerId, moss.id, 'player.runnerId set');
  const taken = say('MothMom', '!claim moss runner');
  eq(taken.ok, false, 'claiming an owned runner is refused');
  has(taken.message, 'FoxFan', 'refusal names the owner');
  has(taken.message, 'Free runners', 'refusal hints at free runners');
  eq(runner('moss').owner, 'FoxFan', 'owner unchanged after refusal');
  const again = say('FoxFan', '!claim ember');
  eq(again.ok, false, 're-claim inside the user cooldown is refused');
  ok(again.cooldownMs > 0, 'cooldownMs reported', again.cooldownMs);
  tick(USER_CD + 1);
  const re = say('FoxFan', '!claim ember');
  eq(re.ok, true, 're-claim after the cooldown ok');
  has(re.message, 'Released Moss Runner', 're-claim reports the release');
  eq(runner('moss').owner, null, 'old runner released');
  eq(runner('ember').owner, 'FoxFan', 'new runner owned');
  eq(player('foxfan').runnerId, runner('ember').id, 'runnerId moved');
  const mine = say('FoxFan', '!claim ember');
  eq(mine.ok, false, 'claiming your own runner again is refused');
  const auto = say('MothMom', '!claim');
  eq(auto.ok, true, '!claim with no name picks a free runner');
  ok(player('mothmom').runnerId && SD.state.runnerById(player('mothmom').runnerId).owner === 'MothMom', 'free runner owned by MothMom');
  const amb = say('Acorn', '!join') && say('Acorn', '!claim m');
  has(amb.message, 'Did you mean', 'ambiguous runner name asks "Did you mean"');
  tick(USER_CD + 1);
  const none = say('Acorn', '!claim zzzz');
  has(none.message, 'No runner called', 'unknown runner name');
}

// -----------------------------------------------------------------------------
section('!train');
// -----------------------------------------------------------------------------
{
  fresh();
  say('FoxFan', '!join');
  say('FoxFan', '!claim moss');
  const noRunner = say('MothMom', '!join') && say('MothMom', '!train speed');
  eq(noRunner.ok, false, '!train <stat> without a runner refused');
  has(noRunner.message, '!claim', 'hint to !claim');

  const moss = runner('moss');
  const before = { speed: moss.stats.speed, energy: moss.energy, sp: player('foxfan').spiritPoints, hype: S().hype.value };
  const t1 = say('FoxFan', '!train speed');
  eq(t1.ok, true, '!train speed ok');
  const tr = effect(t1, 'train');
  ok(tr && tr.outcome !== 'fail', 'seeded first session is not a fail (seed ' + SALT + ')', tr && tr.outcome);
  ok(moss.stats.speed > before.speed, 'speed went up', [before.speed, moss.stats.speed]);
  eq(moss.stats.speed - before.speed, tr.gain, 'gain matches the effect');
  eq(Math.round((before.energy - moss.energy) * 100) / 100, SD.CONFIG.TRAINING.ENERGY_COST, 'energy -12');
  const spGain = player('foxfan').spiritPoints - before.sp;
  eq(spGain, tr.outcome === 'crit' ? SD.CONFIG.ECONOMY.TRAIN_CRIT_SP : SD.CONFIG.ECONOMY.TRAIN_SP, 'SP +5 (or +15 on a crit)');
  const moodHype = SD.DATA.MOODS.Happy.hypeMult;
  const expectHype = SD.util.round1(SD.CONFIG.TRAINING.REWARDS[tr.outcome].hype * moodHype);
  eq(SD.util.round1(S().hype.value - before.hype), expectHype, 'hype +1 (x Happy mood 1.2) on a normal session');
  has(t1.message, ' · ', 'multi-line training feedback joined with " · "');
  ok(t1.message.indexOf('\n') < 0, 'reply is one line');
  ok(t1.message.length <= 220, 'reply is Twitch-sized', t1.message.length);
  eq(player('foxfan').stats.trains, 1, 'stats.trains counted');
  eq(player('foxfan').backing, { runnerId: moss.id, actions: 1 }, 'backing follows the trained runner');
  ok(S().hype.contributions.foxfan > 0 && player('foxfan').stats.hypeContributed > 0, 'hype contribution tracked');

  const t2 = say('FoxFan', '!train speed');
  eq(t2.ok, false, 'immediate second !train refused');
  ok(t2.cooldownMs > 0 && t2.cooldownMs <= USER_CD, 'cooldownMs > 0', t2.cooldownMs);
  has(t2.message, 'cooling down', 'cooldown message');
  eq(t2.cooldown, true, 'result.cooldown flag');
  tick(USER_CD);
  const t3 = say('FoxFan', '!t stamina');
  eq(t3.ok, true, 'after the cooldown !t stamina ok');

  tick(USER_CD);
  const bad = say('FoxFan', '!train fly');
  eq(bad.ok, false, 'invalid stat refused');
  has(bad.message, 'Usage', 'invalid stat shows usage');
  const bad2 = say('FoxFan', '!train moss fly');
  has(bad2.message, 'Usage', 'invalid stat with a runner shows usage');
  const bare = say('FoxFan', '!train');
  has(bare.message, 'Usage', '!train with no args shows usage');
  const named = say('FoxFan', '!train moss runner power');
  eq(named.ok, true, 'multi-word runner name + stat');
  eq(effect(named, 'train').stat, 'power', 'stat parsed from the last arg');

  // Open training
  say('MothMom', '!claim ember');
  tick(USER_CD);
  const ember = runner('ember');
  const embSpeed = ember.stats.speed;
  eq(SD.game.updateSettings({ openTraining: false }).ok, true, 'openTraining off');
  const closed = say('MothMom', '!train moss speed');
  eq(closed.ok, false, "training someone else's runner is refused when openTraining is off");
  has(closed.message, 'own runner', 'refusal explains open training');
  const own = say('MothMom', '!train speed');
  eq(own.ok, true, 'own runner still trainable');
  ok(ember.stats.speed >= embSpeed, 'own runner trained');
  const unowned = say('Acorn', '!join') && say('Acorn', '!train glow speed');
  eq(unowned.ok, false, 'unowned runner refused too when openTraining is off');
  SD.game.updateSettings({ openTraining: true });
  tick(USER_CD);
  const open = say('MothMom', '!train moss wisdom');
  eq(open.ok, true, "openTraining on: anyone may train any runner");

  // settings.userCooldownS drives the default cooldown
  SD.game.updateSettings({ userCooldownS: 2 });
  tick(2500);
  eq(say('MothMom', '!train luck').ok, true, 'userCooldownS=2: first');
  tick(2500);
  eq(say('MothMom', '!train luck').ok, true, 'userCooldownS=2: ok again after 2.5 s');
  SD.game.updateSettings({ userCooldownS: SD.CONFIG.COOLDOWNS.USER_S });

  // The streamer console (source 'admin') skips per-user cooldowns
  say('Streamer', '!join', { source: 'admin', isMod: true });
  say('Streamer', '!claim glow', { source: 'admin', isMod: true });
  const a1 = say('Streamer', '!train speed', { source: 'admin', isMod: true });
  const a2 = say('Streamer', '!train speed', { source: 'admin', isMod: true });
  eq([a1.ok, a2.ok], [true, true], 'source admin is not cooldown-limited');
}

// -----------------------------------------------------------------------------
section('!rest');
// -----------------------------------------------------------------------------
{
  fresh();
  say('FoxFan', '!join');
  say('FoxFan', '!claim moss');
  const moss = runner('moss');
  moss.energy = 40;
  const r1 = say('FoxFan', '!rest');
  eq(r1.ok, true, '!rest ok');
  eq(moss.energy, 70, 'energy +30');
  eq(player('foxfan').stats.rests, 1, 'stats.rests counted');
  const r2 = say('FoxFan', '!rest');
  eq(r2.ok, false, 'second !rest refused');
  has(r2.message, 'cooling down', 'user cooldown message');
  tick(USER_CD + 1);
  const r3 = say('FoxFan', '!rest');
  eq(r3.ok, false, 'third !rest refused by the runner rest cooldown');
  has(r3.message, 'still resting', 'runner cooldown message');
  ok(r3.cooldownMs > 0, 'runner cooldownMs reported', r3.cooldownMs);
  tick(SD.CONFIG.TRAINING.REST.COOLDOWN_MS);
  eq(say('FoxFan', '!rest moss').ok, true, '!rest <runner> after the rest cooldown');
  const who = say('MothMom', '!join') && say('MothMom', '!rest');
  has(who.message, '!claim', '!rest without a runner hints at !claim');
}

// -----------------------------------------------------------------------------
section('!cheer');
// -----------------------------------------------------------------------------
{
  fresh();
  say('FoxFan', '!join');
  const moss = runner('moss');
  const h0 = S().hype.value, sp0 = player('foxfan').spiritPoints;
  const c1 = say('FoxFan', '!cheer moss');
  eq(c1.ok, true, '!cheer moss ok');
  eq(SD.util.round1(S().hype.value - h0), SD.CONFIG.HYPE.GAINS.cheer, 'hype +3');
  eq(player('foxfan').spiritPoints - sp0, SD.CONFIG.ECONOMY.CHEER_SP, 'SP +2');
  has(c1.message, 'The forest hears you! Hype +3 (' + Math.round(S().hype.value) + '/120)', 'reply format');
  eq(S().raceEffects, [{ type: 'cheer', runnerId: moss.id, by: 'foxfan', count: 1 }], 'cheer queued in raceEffects');
  eq(player('foxfan').stats.cheers, 1, 'stats.cheers counted');
  const c2 = say('FoxFan', '!cheer moss');
  eq(c2.ok, false, 'second cheer inside the cheer cooldown refused');
  ok(c2.cooldownMs > USER_CD, 'cheer uses the longer cheer cooldown', c2.cooldownMs);
  tick(CHEER_CD);
  say('FoxFan', '!c moss');
  eq(S().raceEffects.length, 1, 'same viewer + runner merges into one entry');
  eq(S().raceEffects[0].count, 2, 'merged count 2');
  tick(CHEER_CD);
  const plain = say('FoxFan', '!cheer');
  eq(plain.ok, true, '!cheer with no runner ok');
  eq(S().raceEffects.length, 1, 'unnamed cheer queues nothing');
  SD.game.updateSettings({ hypeMultiplier: 2 });
  tick(CHEER_CD);
  const h1 = S().hype.value;
  say('FoxFan', '!cheer');
  eq(SD.util.round1(S().hype.value - h1), SD.CONFIG.HYPE.GAINS.cheer * 2, 'hype x settings.hypeMultiplier');
  SD.game.updateSettings({ hypeMultiplier: 1 });

  // Nervous runners are cured by 10 cheers (plan 6.6)
  SD.runners.setMood(moss, 'Nervous');
  let cured = null;
  for (let i = 0; i < SD.CONFIG.MOOD.NERVOUS_CURE_CHEERS; i++) {
    tick(CHEER_CD);
    const r = say('FoxFan', '!cheer moss');
    if (i < SD.CONFIG.MOOD.NERVOUS_CURE_CHEERS - 1 && moss.mood !== 'Nervous') cured = 'early at ' + (i + 1);
    if (i === SD.CONFIG.MOOD.NERVOUS_CURE_CHEERS - 1) cured = r.message;
  }
  eq(moss.mood, 'Happy', '10 cheers cure Nervous');
  has(cured, 'Happy again', 'cure is announced');
}

// -----------------------------------------------------------------------------
section('race lock, payouts and spam safety');
// -----------------------------------------------------------------------------
{
  fresh();
  const field = SD.game.previewField();
  eq(field.length, 4, 'preview field has 4 runners');
  const owners = ['Owner1', 'Owner2', 'Owner3', 'Owner4'];
  owners.forEach(function (u, i) {
    say(u, '!join');
    const c = say(u, '!claim ' + field[i].name);
    ok(c.ok, u + ' claims ' + field[i].name, c.message);
  });
  // A non-owner backer trains one of the field runners (open training).
  say('BackerBob', '!join');
  const backed = field[1];
  eq(say('BackerBob', '!train ' + backed.name + ' speed').ok, true, 'backer trains a field runner');
  eq(player('backerbob').backing.runnerId, backed.id, 'backer backs that runner');
  tick(USER_CD + 1);

  const started = SD.game.startRace();
  eq(started.ok, true, 'startRace ok');
  const rec = started.record;
  eq(rec.entrants.filter(function (e) { return e.ownerAtRace; }).length, 4, 'all four entrants are owned');
  eq(SD.state.isRaceLocked(), true, 'race is locked');
  const hashBefore = rec.hash;

  const locked = say('Owner1', '!train speed');
  eq(locked.ok, false, '!train during a race refused');
  has(locked.message, 'Hold on — a race is running!', 'race lock message');
  eq(locked.locked, true, 'result.locked flag');
  eq(say('Owner1', '!claim moss').ok, false, '!claim during a race refused');
  eq(say('Owner1', '!rest').ok, false, '!rest during a race refused');
  const queuedBefore = S().raceEffects.length;
  const h0 = S().hype.value;
  const cheer = say('Owner1', '!cheer ' + field[0].name);
  eq(cheer.ok, true, '!cheer during a race ok');
  eq(SD.util.round1(S().hype.value - h0), SD.CONFIG.HYPE.GAINS.cheer, 'mid-race cheer adds hype');
  eq(S().raceEffects.length, queuedBefore, 'mid-race cheer queues no effect');
  eq(say('Owner2', '!status').ok, true, '!status during a race ok');
  has(say('Owner2', '!race').message, rec.trackName + ' (' + rec.distance + ' m) is about to start', '!race reports the race in countdown');
  SD.game.setRaceStatus('running');
  has(say('Owner2', '!race').message, 'is running', '!race reports the running race');
  for (let i = 0; i < 50; i++) { say('Spam' + (i % 5), '!train speed'); say('Owner3', '!train ' + field[0].name + ' power'); say('Owner3', '!claim ' + field[2].name); }
  eq(S().currentRace && S().currentRace.record.hash, hashBefore, 'spam does not touch the running race');
  eq(SD.game.startRace().ok, false, 'a second startRace is refused');

  const winnerRes = rec.results[0];
  const winnerOwner = SD.players.keyOf(winnerRes.ownerAtRace);
  const spBefore = {};
  owners.concat(['BackerBob']).forEach(function (u) { spBefore[SD.players.keyOf(u)] = player(u).spiritPoints; });
  let finished = null;
  const off = SD.bus.on(SD.EVENTS.RACE_FINISHED, function (p) { finished = p; });
  const end = SD.game.endRace();
  off();
  eq(end.ok, true, 'endRace ok (Node finishes immediately)');
  eq(S().currentRace, null, 'currentRace cleared');
  eq(SD.state.isRaceLocked(), false, 'lock released');
  ok(finished && Array.isArray(finished.payouts) && finished.payouts.length >= 4, 'race:finished carries payouts', finished && finished.payouts);

  const expectWin = SD.CONFIG.RESULTS.OWNER_SP[0];
  eq(winnerRes.spOwner, expectWin, 'winner spOwner = OWNER_SP[0] (no awakened / day bonus)');
  eq(player(winnerOwner).spiritPoints - spBefore[winnerOwner], winnerRes.spOwner, 'winning owner SP increased by the place payout');
  rec.results.forEach(function (res) {
    const k = SD.players.keyOf(res.ownerAtRace);
    eq(player(k).spiritPoints - spBefore[k], res.spOwner, res.name + ' owner paid for ' + SD.util.ordinal(res.place));
    eq(player(k).stats.racesParticipated, 1, res.name + ' owner racesParticipated 1');
  });
  eq(player(winnerOwner).stats.raceVictories, 1, 'winning owner raceVictories 1');
  const backedRes = rec.results.filter(function (r) { return r.runnerId === backed.id; })[0];
  eq(player('backerbob').spiritPoints - spBefore.backerbob, backedRes.spBacker, 'backer paid spBacker (half)');
  eq(backedRes.spBacker, Math.floor(backedRes.spOwner * SD.CONFIG.RESULTS.BACKER_SHARE), 'spBacker is half of the owner payout');
  eq(player('backerbob').stats.racesParticipated, 1, 'backer racesParticipated 1');
  eq(player('backerbob').backing, { runnerId: null, actions: 0 }, 'backing reset after the race');

  tick(USER_CD + 1);
  const after = say('Owner1', '!train speed');
  eq(after.ok, true, '!train works again after the race');
  const st = say(winnerOwner, '!status');
  has(st.message, '1W / 1 race', '!status shows the win');
}

// -----------------------------------------------------------------------------
section('!status / !inspect / !race / !event / !help');
// -----------------------------------------------------------------------------
{
  fresh();
  say('FoxFan', '!join');
  const s0 = say('FoxFan', '!status');
  has(s0.message, 'FoxFan: 200 SP', 'status shows SP');
  has(s0.message, '!claim', 'status without a runner hints at !claim');
  say('FoxFan', '!claim velvet');
  const vc = runner('velvet');
  const s1 = say('FoxFan', '!stats');
  has(s1.message, vc.name + ' Lv 1', 'status shows runner name and level');
  has(s1.message, 'SPD ' + vc.stats.speed + ' STA ' + vc.stats.stamina + ' POW ' + vc.stats.power + ' WIS ' + vc.stats.wisdom + ' LUK ' + vc.stats.luck, 'status shows the five stats');
  has(s1.message, 'Energy ' + Math.floor(vc.energy) + '/' + vc.maxEnergy, 'status shows energy');
  has(s1.message, vc.condition, 'status shows condition');
  has(s1.message, vc.mood, 'status shows mood');
  has(s1.message, '0W / 0 races', 'status shows the record');
  const i1 = say('Lurker', '!inspect moonhoof');
  eq(i1.ok, true, '!inspect works without joining');
  const mh = runner('moonhoof');
  has(i1.message, mh.name, 'inspect shows the name');
  has(i1.message, 'Pace Chaser', 'inspect shows the style');
  has(i1.message, mh.ability.name, 'inspect shows the ability');
  has(i1.message, 'SPD ' + mh.stats.speed, 'inspect shows stats');
  has(i1.message, 'Unclaimed', 'inspect shows the owner (none)');
  const i2 = say('FoxFan', '!i');
  has(i2.message, 'Owner: FoxFan', '!inspect with no args shows your own runner');
  const inField = SD.game.previewField().filter(function (r) { return r.id === vc.id; }).length > 0;
  if (inField) has(i2.message, 'Next race odds', 'inspect shows next-race odds for a runner in the field');
  has(say('Lurker', '!inspect').message, 'Usage', '!inspect without a runner shows usage');
  has(say('Lurker', '!event').message, 'Clear Skies', '!event shows the day event');
  has(say('Lurker', '!race').message, 'Next up', '!race shows the next race');
  const help = say('Lurker', '!help');
  ['!join', '!claim', '!train', '!rest', '!cheer', '!status', '!inspect', '!help'].forEach(function (c) { has(help.message, c, 'help lists ' + c); });
  has(say('Lurker', '!help cheer').message, '!cheer [runner]', '!help <command> shows usage');
  const unk = say('Lurker', '!foo');
  eq(unk.ok, false, 'unknown command refused');
  has(unk.message, '!help', 'unknown command points to !help');
  has(unk.message, '!foo', 'unknown command echoes the name');
  eq(unk.unknown, true, 'result.unknown flag');
  eq(say('Lurker', '!lb').ok, true, '!lb works without joining (M3)');
}

// -----------------------------------------------------------------------------
section('registry: admin permission, check-then-commit, processCommand');
// -----------------------------------------------------------------------------
{
  fresh();
  SD.commands.register({ name: 'zzadmin', admin: true, usage: '!zzadmin', description: 'test', cooldownMs: 0, handler: function () { return 'secret ok'; } });
  const viewer = say('Viewer', '!zzadmin');
  eq(viewer.ok, false, 'admin-only command refused for a viewer');
  has(viewer.message, 'mod', 'refusal mentions mods');
  eq(say('ModMia', '!zzadmin', { source: 'twitch', isMod: true }).ok, true, 'Twitch mod may use it');
  eq(say('Streamer', '!zzadmin', { source: 'admin' }).ok, true, 'source admin may use it');
  ok(say('Viewer', '!help').message.indexOf('!zzadmin') < 0, '!help hides admin commands from viewers');
  has(say('ModMia', '!help', { source: 'twitch', isMod: true }).message, '!zzadmin', '!help lists admin commands for mods');
  SD.commands.unregister('zzadmin');
  eq(SD.commands.get('zzadmin'), null, 'unregister removes it');

  // CommandError before any write: no state:changed, no cooldown stamp
  let changed = 0;
  const offC = SD.bus.on(SD.EVENTS.STATE_CHANGED, function () { changed++; });
  SD.commands.register({
    name: 'zzfail', usage: '!zzfail', handler: function () { throw SD.commands.CommandError('Nope, not today.'); }
  });
  const f = say('Viewer', '!zzfail');
  eq([f.ok, f.message], [false, 'Nope, not today.'], 'CommandError message becomes the reply');
  eq(changed, 0, 'CommandError: no state:changed emitted');
  eq(SD.commands.cooldownLeft('Viewer', 'zzfail'), 0, 'CommandError: cooldown not stamped');
  SD.commands.register({ name: 'zzok', usage: '!zzok', aliases: ['zo'], handler: function (ctx, args) { return 'hi ' + ctx.displayName + ' ' + args.join('+'); } });
  const z = say('Viewer', '!zo a @b');
  eq([z.ok, z.command, z.message], [true, 'zzok', 'hi Viewer a+b'], 'registered alias + args + string reply');
  ok(SD.commands.cooldownLeft('Viewer', 'zzok') > 0, 'successful command stamps the cooldown');
  offC();
  SD.commands.unregister('zzfail');
  SD.commands.unregister('zzok');

  // A handler that crashes is contained
  SD.commands.register({ name: 'zzboom', handler: function () { throw new Error('kaboom'); } });
  const origErr = console.error;
  console.error = function () {};
  const boom = say('Viewer', '!zzboom');
  console.error = origErr;
  eq(boom.ok, false, 'unexpected handler error -> ok:false');
  has(boom.message, 'Something went wrong', 'friendly error reply');
  SD.commands.unregister('zzboom');

  // SD.processCommand alias (Twitch source)
  captured.length = 0;
  const tw = SD.processCommand('TwitchTom', '!join', { source: 'twitch', displayName: 'TwitchTom' });
  eq([tw.ok, tw.isCommand, tw.command], [true, true, 'join'], 'SD.processCommand with source twitch');
  eq(captured[0] && captured[0].source, 'twitch', 'chat line keeps source twitch');
  ok(!!player('twitchtom'), 'player created via processCommand');
  const list = SD.commands.list().map(function (d) { return d.name; });
  eq(list, ['join', 'claim', 'train', 'rest', 'cheer', 'status', 'inspect', 'race', 'event', 'help', 'leaderboard', 'rank',
    'bet', 'bets', 'odds', 'boost', 'snack', 'sabotage', 'ribbon', 'hype', 'achievements'], 'list() in registration order (M5 commands after M3)');
  ok(SD.commands.list().every(function (d) { return typeof d.handler === 'undefined'; }), 'list() hides handlers');
}

// -----------------------------------------------------------------------------
section('players hooks: season end, normalize, spend');
// -----------------------------------------------------------------------------
{
  fresh();
  say('FoxFan', '!join');
  say('FoxFan', '!claim moss');
  const p = player('foxfan');
  const spend = SD.state.mutate('test', function (st) { return SD.players.spendSp(st, 'foxfan', 1000, 'test'); });
  eq(spend.ok, false, 'spendSp refuses more than the balance');
  eq(p.spiritPoints, 200, 'balance untouched after refusal');
  const spend2 = SD.state.mutate('test', function (st) { return SD.players.spendSp(st, 'foxfan', 60, 'test'); });
  eq([spend2.ok, spend2.balance, p.stats.spSpentTotal], [true, 140, 60], 'spendSp debits and tracks spSpentTotal');
  p.spiritPoints = 1000;
  const r = SD.game.resetSeason();
  eq(r.ok, true, 'resetSeason ok');
  eq(p.spiritPoints, SD.CONFIG.ECONOMY.SEASON_BASE_SP + 100, 'season rollover: SP = 200 + 10% carry');
  eq(p.runnerId, null, 'season rollover clears the runner');
  eq(p.stats.commands, 0, 'seasonal stats reset');
  eq(p.lifetime.commands, 2, 'seasonal stats rolled into lifetime');
  // Players survive export -> import (persistence.normalize runs SD.players.normalize).
  tick(USER_CD + 1);
  eq(say('FoxFan', '!claim moss').ok, true, 're-claim after the season reset');
  const json = SD.persistence.exportJSON();
  const spNow = player('foxfan').spiritPoints;
  fresh();
  eq(player('foxfan'), null, 'fresh state has no players');
  const imp = SD.persistence.importJSON(json);
  eq(imp.ok, true, 'importJSON ok');
  eq([player('foxfan') && player('foxfan').spiritPoints, player('foxfan') && player('foxfan').runnerId], [spNow, runner('moss').id], 'player SP and runner survive export/import');
  eq(runner('moss').owner, 'FoxFan', 'runner owner survives export/import');

  // isMod follows the chat source; the streamer console never flags a viewer as a mod.
  say('ModMia', '!join', { source: 'twitch', isMod: true });
  eq(player('modmia').isMod, true, 'Twitch mod flag stored on join');
  say('ModMia', '!status', { source: 'twitch', isMod: false });
  eq(player('modmia').isMod, false, 'mod flag follows the latest Twitch message');
  say('Viewer', '!join');
  say('Viewer', '!status', { source: 'admin', isMod: true });
  eq(player('viewer').isMod, false, 'SEND AS (source admin) does not make a viewer a mod');

  const loaded = SD.players.normalize({ username: 'OldSave', spiritPoints: '12' });
  eq([loaded.username, loaded.spiritPoints, typeof loaded.stats.trains, Array.isArray(loaded.achievements)], ['oldsave', 12, 'number', true], 'normalize fills a partial player');
}

// -----------------------------------------------------------------------------
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
}
