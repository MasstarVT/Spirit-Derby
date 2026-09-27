/*
 * Spirit Derby - commands.js
 * THE integration point: simulated chat, the admin SEND AS box, Twitch (M7) and the local
 * bridge (M7) all feed text through SD.commands.handleChat / SD.processCommand.
 *
 * Pipeline (plan section 4), in this exact order:
 *   parse -> lookup -> admin permission -> player gate -> race lock -> per-user cooldown ->
 *   arity -> handler inside SD.state.mutate('cmd:' + name) -> stamp cooldown (ok, or an
 *   unexpected exception: + the CONFIG.COOLDOWNS.ERROR_S error cooldown) ->
 *   emit chat:message (kind 'reply') + command:result
 * The incoming line itself is always emitted as chat:message kind 'user' (even plain chat).
 *
 * Handlers use check-then-commit: validate everything first and `throw new CommandError(msg)`
 * BEFORE any write to reject without mutating. A handler returns a string (ok reply) or
 * { ok?, message, severity?, effects?, cooldown?, locked? }. A refusal that is really a cooldown
 * or a race lock sets `cooldown: true` / `locked: true` (in the result or the CommandError extra)
 * so the reply line, the result and the bridge's reply frame carry the same flag as the gates'.
 * A handler whose invocation only looked (no-argument !bet / !ribbon) sets ctx.readOnly = true: no
 * cooldown is stamped and stats.commands counts it like a read-only command (READONLY_ACTIVITY_S).
 *
 * Commands never touch state.currentRace: mutating commands are refused while a race is
 * locked (countdown / running / paused), and SD.game.startRace refuses a second race.
 *
 * Identity: msg.username is the viewer's LOGIN (the player key, SD.players.keyOf); displayName is
 * presentation only. The streamer's console speaks as SD.players.STREAMER_KEY ('#streamer', a key
 * no Twitch login can produce) with source 'admin': it may run mod and read-only commands but never
 * plays (no !join, no player commands), so it earns no SP, hype credit or achievements. Reserved
 * '#' keys from any other source are dropped before the chat line is even shown.
 */
(function (SD) {
  'use strict';

  const U = SD.util;
  const DOT = ' · ';
  const MAX_TEXT = 500;        // incoming chat line cap
  const MAX_REPLY = 400;       // hard safety cap (Twitch allows 500); replies aim for <= ~200
  const FEED_CAP = 80;         // SD.state.runtime.chatFeed length
  // Maps looked up with chat words / usernames have no prototype (SD.util.dict): '!constructor',
  // '!__proto__' or a 'constructor' source never find an Object.prototype member.
  const SOURCES = U.dict({ sim: true, twitch: true, bridge: true, admin: true });
  // Aliases resolved by parse() even before the target command is registered.
  const BUILTIN_ALIASES = U.dict({ t: 'train', lb: 'leaderboard', stats: 'status', r: 'rest', c: 'cheer', i: 'inspect', h: 'help', commands: 'help' });
  // Zero-width characters some chat clients append to repeated messages.
  const INVISIBLE = /[͏​-‏⁠﻿]|\udb40[\udc00-\udc7f]/g;

  const registry = U.dict();   // name -> def
  const order = [];            // registration order (for !help)
  const aliasMap = U.dict();   // alias -> name
  let msgCounter = 0;

  // ---------------------------------------------------------------------------
  // CommandError: throw (with or without `new`) to reject a command without writing.
  // ---------------------------------------------------------------------------
  function CommandError(message, extra) {
    if (!(this instanceof CommandError)) return new CommandError(message, extra);
    this.name = 'CommandError';
    this.message = String(message == null ? 'That did not work.' : message);
    this.extra = extra || null;
  }
  CommandError.prototype = Object.create(Error.prototype);
  CommandError.prototype.constructor = CommandError;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function P() { return SD.players; }
  function keyOf(name) {
    return P() ? P().keyOf(name) : String(name == null ? '' : name).trim().replace(/^@+/, '').toLowerCase().slice(0, 25);
  }
  function cleanName(name) {
    return P() ? P().cleanName(name) : String(name == null ? '' : name).trim().replace(/^@+/, '').slice(0, 25);
  }
  function clip(s, n) {
    s = String(s == null ? '' : s);
    n = n || MAX_REPLY;
    return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  }
  function orList(names) {
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function firstSentence(s) {
    s = String(s || '');
    const m = /^(.+?[.!?])(\s|$)/.exec(s);
    return m ? m[1] : s;
  }
  function statsLine(r) {
    const S = SD.DATA.STAT_SHORT;
    return SD.CONFIG.STATS.map(function (k) { return S[k] + ' ' + Math.round(r.stats[k]); }).join(' ');
  }
  function recordLine(r) {
    const rec = r.record || {};
    return (rec.wins || 0) + 'W / ' + plural(rec.races || 0, 'race');
  }
  function styleName(style) { return SD.runners ? SD.runners.styleName(style) : style; }
  // Ownership is the owner's login key (runner.ownerKey); runner.owner is only the label.
  function ownerKeyOf(runner) { return P() ? P().ownerKey(runner) : (runner && runner.ownerKey) || null; }
  function ownerLabel(state, runner) { return P() ? P().ownerName(state, runner) : (runner && runner.owner) || null; }
  function isReserved(key) { return !!(P() && P().isReservedKey(key)); }
  const STREAMER_CANT_PLAY = "The streamer console runs the derby but doesn't play. Pick a viewer in SEND AS " +
    '(or type @login: in the chat box) to act for them.';
  // The name shown for a message: its display name, else "Streamer" for the console key, else the login.
  function shownName(msg, username) {
    return cleanName(msg.displayName) || (P() && username === P().STREAMER_KEY ? P().STREAMER_NAME : '') || cleanName(msg.username);
  }
  function reservedRefusal(username) {
    return { ok: false, isCommand: false, command: null, message: 'The name "' + username + '" is reserved for the streamer console.',
      effects: [], cooldownMs: 0, reserved: true };
  }
  // Review batch 8: '~' keys are the chat panel's demo bots (SD.players.isDemoKey). No Twitch login can
  // start with '~'; the bridge could send one, so live sources never reach a bot's profile.
  function isDemo(key) { return !!(P() && typeof P().isDemoKey === 'function' && P().isDemoKey(key)); }
  function demoRefusal(username) {
    return { ok: false, isCommand: false, command: null, message: 'The name "' + username + '" belongs to a demo bot and cannot come from live chat.',
      effects: [], cooldownMs: 0, reserved: true };
  }
  function liveSource(source) { return source === 'twitch' || source === 'bridge'; }
  function spMult(state) {
    return SD.events && SD.events.dayModifiers ? (SD.events.dayModifiers(state.season.activeDayEvent).spMult || 1) : 1;
  }
  function fmtHype(v) { return String(Math.round(Number(v) || 0)); }

  // Resolve a runner query or throw a friendly CommandError (before any write).
  function resolveRunnerArg(state, query) {
    const q = String(query || '').trim();
    const f = SD.state.findRunner(q, state);
    if (f.runner) return f.runner;
    if (f.ambiguous) {
      throw new CommandError('Did you mean ' + orList(f.ambiguous.slice(0, 4).map(function (r) { return r.name; })) + '?');
    }
    const some = SD.state.activeRunners(state).slice(0, 4).map(function (r) { return r.name; });
    throw new CommandError('No runner called "' + q.slice(0, 30) + '". Try ' + orList(some) + '.');
  }

  // May ctx train / rest this runner? (openTraining, or your own runner; the streamer may always)
  function assertMayHandle(ctx, runner, verb) {
    const st = ctx.state.settings || {};
    if (st.openTraining !== false || ctx.source === 'admin') return;
    if (ownerKeyOf(runner) === ctx.username) return;
    if (ownerKeyOf(runner)) {
      throw new CommandError(runner.name + ' runs for ' + ownerLabel(ctx.state, runner) + '. Open training is off, so you can only ' + verb + ' your own runner.');
    }
    throw new CommandError('Open training is off: claim ' + runner.name + ' first (!claim ' + runner.name + ') to ' + verb + ' it.');
  }

  function myRunnerOrThrow(ctx, hint) {
    const r = P() ? P().runnerOf(ctx.state, ctx.username) : null;
    if (!r) throw new CommandError("You don't have a runner yet — type !claim first" + (hint ? ', or ' + hint : '') + '.');
    return r;
  }

  // Odds the next race would offer for runnerId (same field + inputs as the paddock preview).
  function previewOdds(state, runnerId) {
    try {
      if (SD.betting && typeof SD.betting.odds === 'function') {
        const o = SD.betting.odds(state, runnerId); // same numbers the paddock and !bet use (queued cheers included)
        return o ? o.odds : null;
      }
      if (!SD.game || typeof SD.game.previewField !== 'function' || !SD.race) return null;
      const field = SD.game.previewField();
      if (!field.some(function (r) { return r.id === runnerId; })) return null;
      const ents = SD.race.buildEntrants(field, {
        distance: Number(state.settings.distance) || 1200,
        hypeLevel: state.hype.value,
        dayEvent: SD.state.dayEvent(state),
        cheerBonus: {}
      });
      const e = ents.filter(function (x) { return x.runnerId === runnerId; })[0];
      return e ? e.odds : null;
    } catch (err) {
      return null;
    }
  }

  function fmtOdds(x) {
    x = Number(x);
    if (!isFinite(x) || x <= 0) return '?';
    return x.toFixed(1) + 'x'; // the exact odds a bet is paid at (never rounded to whole numbers)
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------
  function resolveName(raw) {
    raw = String(raw || '').toLowerCase();
    if (registry[raw]) return raw;
    return aliasMap[raw] || BUILTIN_ALIASES[raw] || raw;
  }

  // "!T @Moss speed" -> { name:'train', invoked:'t', args:['Moss','speed'], argText:'Moss speed', text }
  // Returns null for anything that is not a command (plain chat).
  function parse(text) {
    if (text == null) return null;
    const t = String(text).replace(INVISIBLE, '').trim();
    const m = /^!([A-Za-z0-9_]+)(?:\s+([\s\S]*))?$/.exec(t);
    if (!m) return null;
    const invoked = m[1].toLowerCase();
    const rest = (m[2] || '').trim();
    const args = rest ? rest.split(/\s+/).map(function (a) { return a.replace(/^@+/, ''); }).filter(Boolean) : [];
    return { name: resolveName(invoked), invoked: invoked, args: args, argText: args.join(' '), text: t };
  }

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------
  // def: { name, aliases, usage, description, admin, requiresPlayer, requiresRunner,
  //        lockedDuringRace, cooldownMs (number | fn(ctx)), cooldownKey, minArgs, hidden, lookOnly,
  //        handler(ctx, args) }
  // lookOnly (review batch 6): the handler never writes the state (!status, !lb, !help ...), so the
  // pipeline saves the viewer's lastSeen / command count lazily (SD.state.saveHint) instead of within
  // 500 ms; a daily bonus it grants is saved as usual.
  function register(def) {
    if (!def || typeof def.handler !== 'function') throw new Error('SD.commands.register: a handler function is required.');
    const name = String(def.name || '').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('SD.commands.register: invalid command name "' + def.name + '".');
    if (registry[name]) unregister(name);
    const d = {
      name: name,
      aliases: (def.aliases || []).map(function (a) { return String(a).toLowerCase(); })
        .filter(function (a) { return /^[a-z0-9_]+$/.test(a) && a !== name; }),
      usage: def.usage || '!' + name,
      description: def.description || '',
      admin: !!def.admin,
      requiresPlayer: !!def.requiresPlayer,
      requiresRunner: !!def.requiresRunner,
      lockedDuringRace: !!def.lockedDuringRace,
      cooldownMs: (typeof def.cooldownMs === 'number' || typeof def.cooldownMs === 'function') ? def.cooldownMs : null,
      cooldownKey: def.cooldownKey ? String(def.cooldownKey) : null,
      minArgs: Math.max(0, def.minArgs | 0),
      hidden: !!def.hidden,
      lookOnly: !!def.lookOnly,
      handler: def.handler
    };
    registry[name] = d;
    if (order.indexOf(name) < 0) order.push(name);
    d.aliases.forEach(function (a) { aliasMap[a] = name; });
    return d;
  }

  function unregister(name) {
    name = String(name || '').toLowerCase();
    const d = registry[name];
    if (!d) return false;
    Object.keys(aliasMap).forEach(function (a) { if (aliasMap[a] === name) delete aliasMap[a]; });
    delete registry[name];
    const i = order.indexOf(name);
    if (i >= 0) order.splice(i, 1);
    return true;
  }

  function publicDef(d) {
    return {
      name: d.name, aliases: d.aliases.slice(), usage: d.usage, description: d.description, admin: d.admin,
      requiresPlayer: d.requiresPlayer, requiresRunner: d.requiresRunner, lockedDuringRace: d.lockedDuringRace,
      cooldownMs: typeof d.cooldownMs === 'number' ? d.cooldownMs : null, cooldownKey: d.cooldownKey,
      minArgs: d.minArgs, hidden: d.hidden, lookOnly: d.lookOnly
    };
  }

  // list({ all:true }) includes hidden commands. Returns plain copies (no handlers).
  function list(opts) {
    opts = opts || {};
    return order.map(function (n) { return registry[n]; })
      .filter(function (d) { return opts.all || !d.hidden; })
      .map(publicDef);
  }

  function get(name) {
    const d = registry[resolveName(name)];
    return d ? publicDef(d) : null;
  }

  // ---------------------------------------------------------------------------
  // Cooldowns (SD.state.runtime.cooldowns = { username: { cooldownKey: lastSuccessTs } })
  // ---------------------------------------------------------------------------
  function cooldownLength(def, ctx) {
    if (typeof def.cooldownMs === 'function') return Math.max(0, Number(def.cooldownMs(ctx)) || 0);
    if (typeof def.cooldownMs === 'number') return Math.max(0, def.cooldownMs);
    const st = ctx && ctx.state && ctx.state.settings;
    const s = st && st.userCooldownS != null ? Number(st.userCooldownS) : SD.CONFIG.COOLDOWNS.USER_S;
    return Math.max(0, (isFinite(s) ? s : SD.CONFIG.COOLDOWNS.USER_S) * 1000);
  }
  function cooldownKeyOf(def) { return def.cooldownKey || def.name; }

  // Cooldown maps are keyed by login ('constructor' / '__proto__' are valid names): own reads and
  // writes only (SD.util.own / setOwn), whatever the prototype of the map a caller installed.
  function lastUse(username, def, key) {
    const map = U.own(SD.state.runtime.cooldowns, username);
    return map ? U.own(map, key || cooldownKeyOf(def)) : undefined;
  }

  // Remaining cooldown (ms) for username on a command (0 = ready). Used by the demo bots.
  function cooldownLeft(username, name, now) {
    const def = registry[resolveName(name)];
    if (!def) return 0;
    const user = keyOf(username);
    const last = lastUse(user, def);
    if (last == null) return 0;
    const len = cooldownLength(def, { state: SD.state.get(), username: user, command: def.name });
    now = now != null ? now : SD.clock.now();
    return Math.max(0, len - (now - last));
  }

  // Read-only commands (def.cooldownMs === 0) count toward stats.commands (the participation
  // board) at most once per this window per viewer, so spamming !status / !lb cannot farm it.
  function activityWindowMs() {
    const L = SD.CONFIG.LEADERBOARDS;
    const s = L && L.READONLY_ACTIVITY_S != null ? Number(L.READONLY_ACTIVITY_S) : SD.CONFIG.COOLDOWNS.USER_S;
    return Math.max(0, (isFinite(s) ? s : 0) * 1000);
  }

  function stampCooldown(username, def, now, key) {
    const rt = SD.state.runtime;
    if (!rt.cooldowns || typeof rt.cooldowns !== 'object') rt.cooldowns = U.dict();
    const map = U.own(rt.cooldowns, username) || U.setOwn(rt.cooldowns, username, U.dict());
    U.setOwn(map, key || cooldownKeyOf(def), now);
  }
  // After a handler fails unexpectedly (a bug, not a CommandError) the same viewer's same command
  // is refused for max(its cooldown, CONFIG.COOLDOWNS.ERROR_S): a crashing command can't be
  // repeated at chat speed to flood the event log, the overlay and the bridge with error replies.
  function errorKeyOf(def) { return '!error:' + cooldownKeyOf(def); }
  function errorLockMs() {
    const s = Number(SD.CONFIG.COOLDOWNS.ERROR_S);
    return Math.max(0, (isFinite(s) ? s : 0) * 1000);
  }

  // ---------------------------------------------------------------------------
  // Chat feed
  // ---------------------------------------------------------------------------
  // Append to runtime.chatFeed (cap 80) and emit chat:message.
  function emitChat(m) {
    const entry = {
      id: 'm' + (++msgCounter),
      username: m.username || null,
      displayName: m.displayName || '',
      text: String(m.text == null ? '' : m.text),
      source: m.source || 'sim',
      isMod: !!m.isMod,
      kind: m.kind || 'user',
      ts: m.ts != null && isFinite(Number(m.ts)) ? Number(m.ts) : SD.clock.now()
    };
    ['severity', 'command', 'ok', 'replyTo', 'isCommand', 'unknown', 'cooldown', 'locked'].forEach(function (k) {
      if (m[k] !== undefined) entry[k] = m[k];
    });
    const rt = SD.state.runtime;
    if (!Array.isArray(rt.chatFeed)) rt.chatFeed = [];
    rt.chatFeed.push(entry);
    if (rt.chatFeed.length > FEED_CAP) rt.chatFeed.splice(0, rt.chatFeed.length - FEED_CAP);
    if (SD.bus) SD.bus.emit(SD.EVENTS.CHAT_MESSAGE, entry);
    return entry;
  }

  // A dim system line in the chat feed (race started, bots toggled, ...).
  function system(text, severity) {
    return emitChat({ kind: 'system', username: null, displayName: '', text: text, source: 'system', isMod: false, severity: severity || 'info' });
  }

  // ---------------------------------------------------------------------------
  // Pipeline
  // ---------------------------------------------------------------------------
  function normalizeOut(r) {
    if (r == null) return { ok: true, message: 'Done.' };
    if (typeof r === 'string') return { ok: true, message: r };
    const out = Object.assign({}, r);
    out.ok = out.ok !== false;
    out.message = out.message == null ? (out.ok ? 'Done.' : 'That did not work.') : String(out.message);
    return out;
  }

  // Run one already-identified command message through the pipeline.
  // msg: { username, displayName?, text | parsed, source, isMod, replyTo? }
  function runCommand(msg) {
    msg = msg || {};
    const username = keyOf(msg.username);
    const displayName = shownName(msg, username) || username;
    const source = SOURCES[msg.source] ? msg.source : 'sim';
    const isMod = !!msg.isMod || source === 'admin';
    if (isReserved(username) && source !== 'admin') return reservedRefusal(username);
    if (isDemo(username) && liveSource(source)) return demoRefusal(username);
    const parsed = msg.parsed || parse(msg.text);
    if (!parsed) return { ok: false, isCommand: false, command: null, message: '', effects: [], cooldownMs: 0 };
    const state = SD.state.get();
    const def = registry[parsed.name] || null;
    let effects = [];

    function finish(ok, message, extra) {
      extra = extra || {};
      const text = clip(message);
      const severity = extra.severity || (ok ? 'good' : 'bad');
      const res = {
        ok: !!ok, isCommand: true, command: def ? def.name : parsed.name, message: text, effects: effects,
        cooldownMs: extra.cooldownMs || 0, severity: severity
      };
      ['unknown', 'cooldown', 'locked'].forEach(function (k) { if (extra[k]) res[k] = true; });
      const reply = emitChat({
        kind: 'reply', username: username, displayName: displayName, text: text, source: source, isMod: isMod,
        severity: severity, command: res.command, ok: res.ok, replyTo: msg.replyTo || null,
        unknown: extra.unknown || undefined, cooldown: extra.cooldown || undefined, locked: extra.locked || undefined
      });
      res.id = reply.id;
      // A public line a handler asked for (e.g. the !sabotage announcement), right after its reply.
      if (ok && extra.announce && extra.announce.text) system(clip(extra.announce.text), extra.announce.severity || 'info');
      if (SD.bus) {
        SD.bus.emit(SD.EVENTS.COMMAND_RESULT, {
          id: reply.id, username: username, displayName: displayName, source: source, isMod: isMod,
          command: res.command, invoked: parsed.invoked, args: parsed.args, ok: res.ok, message: text,
          severity: severity, effects: effects, cooldownMs: res.cooldownMs, ts: reply.ts
        });
      }
      return res;
    }

    if (!username) return finish(false, 'Who said that? (missing username)');
    if (!state) return finish(false, 'The derby is still waking up — try again in a moment.', { severity: 'info' });
    // 1. lookup
    if (!def) return finish(false, 'Unknown command !' + parsed.invoked + ' — try !help', { unknown: true, severity: 'info' });
    // 2. admin permission
    if (def.admin && !isMod) return finish(false, 'Only the streamer or a mod can use !' + def.name + '.');
    // 3. player gate (the streamer's console never plays: see the header)
    if (isReserved(username) && (def.requiresPlayer || def.requiresRunner || def.name === 'join')) {
      return finish(false, STREAMER_CANT_PLAY, { severity: 'info' });
    }
    const player = P() ? P().get(state, username) : null;
    if ((def.requiresPlayer || def.requiresRunner) && !player) {
      return finish(false, "You're not in the derby yet — type !join", { severity: 'info' });
    }
    if (def.requiresRunner && !(P() && P().runnerOf(state, username))) {
      return finish(false, "You don't have a runner yet — type !claim to pick one.", { severity: 'info' });
    }
    // 4. race lock
    if (def.lockedDuringRace && SD.state.isRaceLocked(state)) {
      return finish(false, 'Hold on — a race is running! Try again after the results.', { locked: true, severity: 'info' });
    }
    // 5. per-user cooldown (the streamer's own console, source 'admin', is exempt)
    const now = SD.clock.now();
    const rt = SD.state.runtime;
    const readOnly = def.cooldownMs === 0;
    const lastActivity = readOnly ? U.own(rt.activity, username) : undefined;
    const ctx = {
      state: state, username: username, displayName: displayName, source: source, isMod: isMod, player: player,
      parsed: parsed, args: parsed.args, argText: parsed.argText, command: def.name, now: now,
      effects: effects, touched: false,
      // false for a read-only command repeated inside CONFIG.LEADERBOARDS.READONLY_ACTIVITY_S
      countActivity: !(lastActivity != null && now - lastActivity < activityWindowMs()),
      // A handler sets readOnly = true when this invocation only looked (the no-argument !bet / !ribbon
      // info lines): no cooldown is stamped and it counts toward stats.commands like a read-only
      // command (at most once per READONLY_ACTIVITY_S), so info lines cannot farm participation.
      readOnly: false
    };
    function infoCount() {
      const last = U.own(rt.activity, username);
      return !(last != null && now - last < activityWindowMs());
    }
    const cdLen = cooldownLength(def, ctx);
    if (source !== 'admin') {
      const last = cdLen > 0 ? lastUse(username, def) : undefined;
      const failedAt = lastUse(username, def, errorKeyOf(def));
      const left = Math.max(last == null ? 0 : cdLen - (now - last),
        failedAt == null ? 0 : Math.max(cdLen, errorLockMs()) - (now - failedAt));
      if (left > 0) {
        return finish(false, '!' + def.name + ' is cooling down — try again in ' + U.fmtDuration(left) + '.',
          { cooldownMs: left, cooldown: true, severity: 'info' });
      }
    }
    // 6. arity
    if (parsed.args.length < def.minArgs) return finish(false, 'Usage: ' + def.usage, { severity: 'info' });

    // 7. handler (check-then-commit inside one mutate)
    let out;
    let crashed = false;
    // Achievements unlocked by this command for this viewer are appended to the reply (M5).
    const achList = state.achievements && Array.isArray(state.achievements.unlocked) ? state.achievements.unlocked : null;
    const achMark = achList ? achList.length : 0;
    rt.activeCommand = { username: username, command: def.name };
    try {
      out = SD.state.mutate('cmd:' + def.name, function (st) {
        ctx.state = st;
        const r = normalizeOut(def.handler(ctx, parsed.args));
        let touched = false, bonus = 0;
        if (r.ok && !ctx.touched && P() && P().get(st, username)) {
          // The streamer console (source admin) can speak as anyone: it never changes player.isMod.
          if (ctx.readOnly && !readOnly) ctx.countActivity = infoCount();
          const t = P().touch(st, username, {
            isMod: source === 'admin' ? undefined : isMod, displayName: displayName, now: now, count: ctx.countActivity
          });
          touched = true;
          bonus = t.dailyBonus || 0;
          if (t.dailyBonus) {
            r.message += DOT + 'Daily bonus +' + t.dailyBonus + ' SP!';
            effects.push({ type: 'sp', amount: t.dailyBonus, reason: 'daily' });
          }
        }
        // Review batch 6: a look-only command (or a handler that only looked, ctx.readOnly) changed at
        // most lastSeen / the command count: saved lazily, or not at all when no player was touched.
        if (r.ok && (def.lookOnly || ctx.readOnly) && !bonus) SD.state.saveHint(touched ? 'lazy' : 'none');
        return r;
      });
    } catch (e) {
      if (e instanceof CommandError) {
        const x = e.extra || {};
        out = { ok: false, message: e.message, severity: x.severity || 'bad', cooldownMs: x.cooldownMs || 0, cooldown: !!x.cooldown, locked: !!x.locked };
      } else {
        if (typeof console !== 'undefined') console.error('[SD.commands] !' + def.name + ' failed:', e);
        try { SD.state.log('error', '!' + def.name + ' from ' + displayName + ' failed: ' + ((e && e.message) || e), 'warn', { username: username }); } catch (x) { /* ignore */ }
        out = { ok: false, message: 'Something went wrong with !' + def.name + '. The streamer can check the log.', severity: 'bad' };
        crashed = true;
      }
    } finally {
      rt.activeCommand = null;
    }
    if (Array.isArray(out.effects)) out.effects.forEach(function (x) { if (effects.indexOf(x) < 0) effects.push(x); });
    if (out.ok && achList && achList.length > achMark && SD.state.get() === state) {
      const mine = achList.slice(achMark).filter(function (a) { return a.username === username; });
      if (mine.length) {
        out.message += DOT + '\u{1F3C5} Achievement' + (mine.length > 1 ? 's' : '') + ': ' +
          mine.map(function (a) { return a.name + ' (+' + a.sp + ' SP)'; }).join(', ');
        out.severity = 'epic';
        mine.forEach(function (a) { effects.push({ type: 'achievement', id: a.id, sp: a.sp }); });
      }
    }

    // 8. stamp the cooldown (successful commands, and unexpected failures: see errorKeyOf)
    const lookedOnly = out.ok && ctx.readOnly;
    if (((out.ok && !lookedOnly) || crashed) && cdLen > 0) stampCooldown(username, def, now);
    if (crashed) stampCooldown(username, def, now, errorKeyOf(def));
    if (out.ok && (readOnly || lookedOnly) && ctx.countActivity && P() && P().get(SD.state.get(), username)) {
      if (!rt.activity || typeof rt.activity !== 'object') rt.activity = U.dict();
      U.setOwn(rt.activity, username, now);
    }
    return finish(out.ok, out.message, {
      severity: out.severity || (out.ok ? 'good' : 'bad'),
      cooldownMs: out.ok ? (lookedOnly ? 0 : cdLen) : (out.cooldownMs || 0),
      // A handler's own refusal can be a cooldown (!rest's per-runner rest) or a race lock (a mod's
      // !event mid-race): CommandError extras / handler results carry the same flags as the gates.
      cooldown: !out.ok && !!out.cooldown,
      locked: !out.ok && !!out.locked,
      announce: out.announce || null
    });
  }

  // Every chat line enters here. Emits the 'user' line, then runs the pipeline for commands.
  // msg: { username, displayName?, text, source:'sim'|'twitch'|'bridge'|'admin', isMod, ts? }
  // -> { ok, isCommand, command, message, effects, cooldownMs }
  function handleChat(msg) {
    msg = msg || {};
    const username = keyOf(msg.username);
    const displayName = shownName(msg, username);
    const text = String(msg.text == null ? '' : msg.text).replace(INVISIBLE, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TEXT);
    const source = SOURCES[msg.source] ? msg.source : 'sim';
    const isMod = !!msg.isMod || source === 'admin';
    if (!username || !text) {
      return { ok: false, isCommand: false, command: null, message: username ? 'Empty message.' : 'Missing username.', effects: [], cooldownMs: 0 };
    }
    // Only the local console (source 'admin') may speak as a reserved '#' key such as '#streamer'.
    if (isReserved(username) && source !== 'admin') return reservedRefusal(username);
    if (isDemo(username) && liveSource(source)) return demoRefusal(username);
    const parsed = parse(text);
    const line = emitChat({
      kind: 'user', username: username, displayName: displayName, text: text, source: source, isMod: isMod,
      ts: msg.ts, isCommand: !!parsed
    });
    if (!parsed) return { ok: true, isCommand: false, command: null, message: '', effects: [], cooldownMs: 0, id: line.id };
    return runCommand({ username: username, displayName: displayName, source: source, isMod: isMod, parsed: parsed, replyTo: line.id });
  }

  // ---------------------------------------------------------------------------
  // Built-in commands (M2)
  // ---------------------------------------------------------------------------
  const STAT_HELP = 'speed, stamina, power, wisdom or luck';
  const TRAIN_USAGE = '!train <stat> or !train <runner> <stat> (stats: speed, stamina, power, wisdom, luck)';

  register({
    name: 'join',
    usage: '!join',
    description: 'Join the Spirit Derby (+' + SD.CONFIG.ECONOMY.JOIN_SP + ' Spirit Points the first time).',
    cooldownMs: 0,
    handler: function (ctx) {
      if (!P()) throw new CommandError('Player profiles are not available right now.');
      const r = P().join(ctx.state, ctx.username, ctx.displayName,
        { source: ctx.source, isMod: ctx.source === 'admin' ? undefined : ctx.isMod, now: ctx.now, count: ctx.countActivity });
      if (!r.player) throw new CommandError('That name cannot join the derby.');
      ctx.touched = true;
      const p = r.player;
      if (r.created) {
        ctx.effects.push({ type: 'join', created: true }, { type: 'sp', amount: SD.CONFIG.ECONOMY.JOIN_SP, reason: 'join' });
        return {
          message: 'Welcome to the Spirit Derby, ' + p.displayName + '! You have ' + p.spiritPoints +
            ' Spirit Points. Type !claim to pick a runner, then !train speed.',
          severity: 'epic'
        };
      }
      if (r.dailyBonus) ctx.effects.push({ type: 'sp', amount: r.dailyBonus, reason: 'daily' });
      const mine = P().runnerOf(ctx.state, ctx.username);
      return "You're already in the derby, " + p.displayName + '! ' + (r.dailyBonus ? 'Daily bonus +' + r.dailyBonus + ' SP! ' : '') +
        'You have ' + p.spiritPoints + ' SP' + (mine ? ' and run with ' + mine.name + '.' : '. Type !claim to pick a runner.');
    }
  });

  register({
    name: 'claim',
    usage: '!claim [runner]',
    description: 'Claim a free runner (named, or the first free one). Claiming another releases your old runner.',
    requiresPlayer: true,
    lockedDuringRace: true,
    handler: function (ctx, args) {
      const S = ctx.state;
      let runner;
      if (args.length) {
        runner = resolveRunnerArg(S, args.join(' '));
      } else {
        const free = P().freeRunners(S);
        if (!free.length) throw new CommandError('Every runner already has an owner. Ask the streamer to spawn a new one!');
        runner = free[0];
      }
      const r = P().claim(S, ctx.username, runner.id); // validates before writing
      if (!r.ok) throw new CommandError(r.message);
      ctx.effects.push({ type: 'claim', runnerId: runner.id, released: r.released || null });
      return {
        message: ctx.displayName + ' claimed ' + runner.emoji + ' ' + runner.name + ' (' + styleName(runner.style) + ')! ' +
          (r.released ? 'Released ' + r.released + '. ' : '') + 'Now try !train speed.',
        severity: 'epic'
      };
    }
  });

  // ---------------------------------------------------------------------------
  // M6: !create <name> — a brand-new runner for a viewer without one, once every runner has an
  // owner (and settings.allowCreate). Same spawn code as admin SPAWN RUNNER (SD.game.spawnRunner):
  // random species template, a style that species runs, stats summing to 200 and a style-suited
  // ability from the catalog; then it is claimed like !claim (Creator achievement via runner:spawned).
  // ---------------------------------------------------------------------------
  function andList(names) {
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function freeRunnersPhrase(free) {
    const names = free.slice(0, 3).map(function (r) { return r.name; });
    const more = free.length > 3 ? ' and ' + (free.length - 3) + ' more' : '';
    return (more ? names.join(', ') + more : andList(names)) + (free.length === 1 ? ' is' : ' are') + ' still free';
  }

  register({
    name: 'create',
    usage: '!create <name>',
    description: 'Create your own runner when every runner already has an owner (if the streamer allows it): a random species, style and ability, stats summing to ' +
      SD.CONFIG.PROGRESSION.STAT_TOTAL + '. Names: ' + ((SD.CONFIG.RUNNERS || {}).CREATE_NAME_MIN || 3) + '–' + ((SD.CONFIG.RUNNERS || {}).CREATE_NAME_MAX || 20) +
      ' letters, digits, spaces or apostrophes.',
    requiresPlayer: true,
    lockedDuringRace: true,
    minArgs: 1,
    handler: function (ctx, args) {
      const S = ctx.state;
      const mine = P().runnerOf(S, ctx.username);
      if (mine) throw new CommandError('You already run with ' + mine.emoji + ' ' + mine.name + '. One runner per viewer!', { severity: 'info' });
      const free = P().freeRunners(S);
      if (S.settings.allowCreate === false) {
        throw new CommandError(free.length
          ? freeRunnersPhrase(free) + ' — !claim one, or wait for the streamer to allow !create.'
          : 'Every runner has an owner and creating runners is switched off. Ask the streamer to allow !create (or to spawn a runner).',
        { severity: 'info' });
      }
      if (free.length) {
        throw new CommandError(freeRunnersPhrase(free) + ' — !claim one! (!create opens up once every runner has an owner.)', { severity: 'info' });
      }
      const R = SD.CONFIG.RUNNERS || {};
      const max = Number(R.MAX_ACTIVE) > 0 ? Number(R.MAX_ACTIVE) : 24;
      if (SD.state.activeRunners(S).length >= max) {
        throw new CommandError('The paddock is full (' + max + ' runners) and every one has an owner. Owners are cleared when the season ends: !claim one then!', { severity: 'info' });
      }
      const check = SD.runners.checkName(S, args.join(' '));
      if (!check.ok) throw new CommandError(check.message, { severity: 'info' });
      // --- commit ---
      const runner = SD.game.spawnRunner({ name: check.name, by: ctx.username, byName: ctx.displayName });
      if (!runner || runner.ok === false || !runner.id) {
        return { ok: false, message: (runner && runner.message) || 'The forest could not make a runner right now.', severity: 'bad' };
      }
      const c = P().claim(S, ctx.username, runner.id);
      if (!c.ok) return { ok: false, message: runner.name + ' wandered in, but claiming it failed: ' + c.message, severity: 'bad' };
      ctx.effects.push({ type: 'create', runnerId: runner.id, name: runner.name }, { type: 'claim', runnerId: runner.id, released: null });
      const ab = runner.ability && runner.ability.id ? runner.ability.name : null;
      return {
        message: '✨ ' + ctx.displayName + ' created ' + runner.emoji + ' ' + runner.name + ', a ' + runner.species + ' ' +
          styleName(runner.style) + '! ' + statsLine(runner) + (ab ? DOT + 'Ability: ' + ab : '') + DOT + 'Try !train speed',
        severity: 'epic'
      };
    }
  });

  register({
    name: 'train',
    aliases: ['t'],
    usage: TRAIN_USAGE,
    description: 'Train your runner (or any runner by name while open training is on).',
    requiresPlayer: true,
    lockedDuringRace: true,
    minArgs: 1,
    handler: function (ctx, args) {
      const S = ctx.state;
      const norm = SD.training.normalizeStat;
      let stat = null, query = null;
      // Review batch 8 (gap3#3): exactly a runner's name with no stat asks for the stat, even when a word of
      // the name is a stat alias ("Speed Demon", "Big Str" in older saves).
      const named = exactRunner(S, args.join(' '));
      if (named && (args.length > 1 || !norm(args[0]))) {
        throw new CommandError('Which stat? !train ' + shortOf(S, named) + ' <stat> (' + STAT_HELP + ').', { severity: 'info' });
      }
      if (args.length === 1) {
        stat = norm(args[0]);
        if (!stat) throw new CommandError('Usage: ' + TRAIN_USAGE);
      } else {
        const last = norm(args[args.length - 1]);
        const first = norm(args[0]);
        if (last) {
          stat = last; query = args.slice(0, -1).join(' ');
          // "!train speed Big Str": the last word is a stat too, but the rest names no runner. Fall back
          // to the stat-first reading when that one does.
          if (first && !tryRunner(S, query) && tryRunner(S, args.slice(1).join(' '))) { stat = first; query = args.slice(1).join(' '); }
        } else if (first) { stat = first; query = args.slice(1).join(' '); }
        else throw new CommandError('Unknown stat "' + String(args[args.length - 1]).slice(0, 20) + '". Usage: ' + TRAIN_USAGE);
      }
      const runner = query ? resolveRunnerArg(S, query) : myRunnerOrThrow(ctx, 'train one by name: !train <runner> ' + stat);
      assertMayHandle(ctx, runner, 'train');

      const hypeBefore = S.hype.value;
      const res = SD.game.trainRunner(runner.id, stat, ctx.username);
      // A refused train changed nothing (review batch 5: SD.game.trainRunner refuses before its commit),
      // so it is thrown as a CommandError: the command's own mutate emits no state:changed / save either.
      if (!res || !res.ok) throw new CommandError((res && res.message) || 'Training did not happen.', { severity: 'bad' });
      P().recordAction(S, ctx.username, runner.id, 'train');
      const hypeDelta = U.round1(S.hype.value - hypeBefore);
      P().addHypeContribution(S, ctx.username, hypeDelta);
      const sp = res.spAwarded || 0;
      ctx.effects.push(
        { type: 'train', runnerId: runner.id, stat: res.stat, gain: res.gain, outcome: res.outcome, energyCost: res.energyCost },
        { type: 'hype', delta: hypeDelta },
        { type: 'sp', amount: sp, reason: 'train' }
      );
      return {
        message: String(res.message).split('\n').join(DOT) + (sp ? DOT + '+' + sp + ' SP' : ''),
        severity: res.outcome === 'crit' || res.levelUps ? 'epic' : (res.outcome === 'fail' ? 'bad' : 'good')
      };
    }
  });

  register({
    name: 'rest',
    aliases: ['r'],
    usage: '!rest [runner]',
    description: 'Rest a runner: energy +30, fatigue down, hype -5 (3-minute cooldown per runner).',
    requiresPlayer: true,
    lockedDuringRace: true,
    handler: function (ctx, args) {
      const S = ctx.state;
      const runner = args.length ? resolveRunnerArg(S, args.join(' ')) : myRunnerOrThrow(ctx, 'name one: !rest <runner>');
      assertMayHandle(ctx, runner, 'rest');
      const left = SD.training.restCooldownLeft(runner, ctx.now);
      if (left > 0) throw new CommandError(runner.name + ' is still resting — try again in ' + U.fmtDuration(left) + '.', { cooldownMs: left, cooldown: true, severity: 'info' });
      const res = SD.game.restRunner(runner.id, ctx.username);
      if (!res || !res.ok) {
        return { ok: false, message: (res && res.message) || 'Resting did not happen.', cooldownMs: res && res.cooldownMs, cooldown: !!(res && res.cooldownMs > 0) };
      }
      P().recordAction(S, ctx.username, runner.id, 'rest');
      ctx.effects.push({ type: 'rest', runnerId: runner.id, energyGain: res.energyGain }, { type: 'hype', delta: res.hype || 0 });
      return String(res.message).split('\n').join(DOT);
    }
  });

  register({
    name: 'cheer',
    aliases: ['c'],
    usage: '!cheer [runner]',
    description: 'Cheer! Hype +3 and +2 SP. Cheering a runner before a race gives it a tiny boost (works mid-race too).',
    requiresPlayer: true,
    lockedDuringRace: false,
    cooldownMs: function () {
      const C = SD.CONFIG;
      const s = C.ECONOMY.CHEER_COOLDOWN_S != null ? C.ECONOMY.CHEER_COOLDOWN_S : C.COOLDOWNS.CHEER_S;
      return (Number(s) || 0) * 1000;
    },
    handler: function (ctx, args) {
      const S = ctx.state;
      const runner = args.length ? resolveRunnerArg(S, args.join(' ')) : null;
      const locked = SD.state.isRaceLocked(S);
      // --- commit ---
      const h = SD.hype.add(S, SD.CONFIG.HYPE.GAINS.cheer, { by: ctx.username, reason: 'cheer' });
      P().addHypeContribution(S, ctx.username, h.delta);
      const sp = P().award(S, ctx.username, Math.round(SD.CONFIG.ECONOMY.CHEER_SP * spMult(S)), 'cheer');
      // Backing is only for the race to come: a mid-race cheer (the result is already decided and being
      // played back) counts as a cheer but never makes you the backer of the runner you see leading.
      P().recordAction(S, ctx.username, runner && !locked ? runner.id : null, 'cheer');
      ctx.effects.push({ type: 'hype', delta: h.delta }, { type: 'sp', amount: sp, reason: 'cheer' });

      const parts = [h.delta > 0
        ? 'The forest hears you! Hype ' + U.signed(h.delta) + ' (' + fmtHype(h.value) + '/' + fmtHype(S.hype.max) + ')'
        : 'The forest hears you! Hype is maxed out (' + fmtHype(h.value) + '/' + fmtHype(S.hype.max) + ')'];
      let severity = 'good';
      if (runner && !locked) {
        if (!Array.isArray(S.raceEffects)) S.raceEffects = [];
        let entry = S.raceEffects.filter(function (e) { return e.type === 'cheer' && e.runnerId === runner.id && e.by === ctx.username; })[0];
        if (entry) entry.count = (entry.count || 1) + 1;
        else S.raceEffects.push(entry = { type: 'cheer', runnerId: runner.id, by: ctx.username, count: 1 });
        const total = S.raceEffects.reduce(function (a, e) { return a + (e.type === 'cheer' && e.runnerId === runner.id ? (e.count || 1) : 0); }, 0);
        ctx.effects.push({ type: 'cheer', runnerId: runner.id, queued: total });
        parts.push(runner.name + ' feels the love (' + plural(total, 'cheer') + ' for the next race)');
        // Mood nudge (plan 6.6): a Nervous runner is cured by 10 cheers.
        const rt = SD.state.runtime;
        if (!rt.nervousCheers) rt.nervousCheers = U.dict();
        if (runner.mood === 'Nervous') {
          const n = (rt.nervousCheers[runner.id] || 0) + 1;
          if (n >= SD.CONFIG.MOOD.NERVOUS_CURE_CHEERS) {
            SD.runners.setMood(runner, 'Happy');
            delete rt.nervousCheers[runner.id];
            parts.push(runner.name + ' shakes off the nerves and looks Happy again!');
            SD.state.log('mood', 'Chat cheered ' + runner.name + ' out of their nerves. Happy again!', 'good', { runnerId: runner.id });
            severity = 'epic';
          } else {
            rt.nervousCheers[runner.id] = n;
          }
        } else {
          delete rt.nervousCheers[runner.id];
        }
      } else if (runner) {
        parts.push('Go ' + runner.name + '!');
      }
      if (h.crossed && h.crossed.length) {
        const th = SD.DATA.HYPE_THRESHOLDS.filter(function (t) { return h.crossed.indexOf(t.id) >= 0; });
        if (th.length) { parts.push(th[th.length - 1].text); severity = 'epic'; }
      }
      if (sp) parts.push('+' + sp + ' SP');
      return { message: parts.join(DOT), severity: severity };
    }
  });

  register({
    name: 'status',
    aliases: ['stats'],
    usage: '!status',
    description: 'Your Spirit Points and your runner at a glance.',
    requiresPlayer: true,
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx) {
      const S = ctx.state;
      const p = ctx.player;
      const r = P().runnerOf(S, ctx.username);
      const parts = [p.displayName + ': ' + p.spiritPoints + ' SP'];
      const spRank = SD.leaderboards ? SD.leaderboards.rankOf(S, 'spiritPoints', ctx.username) : null;
      if (spRank) parts.push('#' + spRank.rank + ' in SP');
      if (r) {
        parts.push(r.emoji + ' ' + r.name + ' Lv ' + r.level, statsLine(r), 'Energy ' + Math.floor(r.energy) + '/' + r.maxEnergy,
          r.condition, r.mood, recordLine(r));
      } else {
        parts.push('no runner yet — type !claim');
      }
      const b = p.backing;
      if (b && b.runnerId && (!r || b.runnerId !== r.id)) {
        const br = SD.state.runnerById(b.runnerId, S);
        if (br) parts.push('backing ' + br.name);
      }
      return { message: parts.join(DOT), severity: 'info' };
    }
  });

  register({
    name: 'inspect',
    aliases: ['i'],
    usage: '!inspect <runner>',
    description: 'Full card for a runner: style, ability, owner, stats, condition, mood, record and odds.',
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx, args) {
      const S = ctx.state;
      let runner = null;
      if (args.length) runner = resolveRunnerArg(S, args.join(' '));
      else if (P()) runner = P().runnerOf(S, ctx.username);
      if (!runner) throw new CommandError('Usage: !inspect <runner>');
      const parts = [runner.emoji + ' ' + runner.name, 'Lv ' + runner.level + ' ' + styleName(runner.style),
        ownerKeyOf(runner) ? 'Owner: ' + ownerLabel(S, runner) : 'Unclaimed', statsLine(runner),
        'Energy ' + Math.floor(runner.energy) + '/' + runner.maxEnergy, runner.condition, runner.mood, recordLine(runner)];
      const cr = S.currentRace;
      const inRace = cr && cr.record && cr.record.entrants.filter(function (e) { return e.runnerId === runner.id; })[0];
      if (inRace) parts.push('Racing now at ' + fmtOdds(inRace.odds));
      else if (!cr) {
        const odds = previewOdds(S, runner.id);
        if (odds != null) parts.push('Next race odds ' + fmtOdds(odds));
      }
      if (runner.ability && runner.ability.name && runner.ability.id) {
        parts.push(runner.ability.name + ': ' + firstSentence(runner.ability.desc));
      }
      return { message: parts.join(DOT), severity: 'info' };
    }
  });

  // Open bets in one short phrase: "3 bets (210 SP)" or ''.
  function betsPhrase(state) {
    if (!SD.betting) return '';
    const o = SD.betting.open(state);
    return o.count ? plural(o.count, 'bet') + ' (' + o.total + ' SP)' : '';
  }

  // Viewer-facing race status line (also what mods get with !race status).
  function raceStatusLine(S) {
    const season = S.season;
    const cr = S.currentRace;
    if (cr && cr.record) {
      const rec = cr.record;
      if (cr.status === 'finished') return 'The race at ' + rec.trackName + ' just finished — results incoming!';
      const fav = rec.entrants.slice().sort(function (a, b) { return a.odds - b.odds; })[0];
      const word = cr.status === 'paused' ? 'is PAUSED' : (cr.status === 'countdown' ? 'is about to start' : 'is running');
      const bets = betsPhrase(S);
      return 'Race ' + rec.indexInDay + '/' + season.racesPerDay + ' at ' + rec.trackName + ' (' + rec.distance + ' m) ' + word + ': ' +
        rec.entrants.map(function (e) { return e.name; }).join(', ') + '. Favourite: ' + fav.name + ' at ' + fmtOdds(fav.odds) +
        (bets ? '. ' + bets + ' riding on it' : '') + '. !cheer them on!';
    }
    if (season.raceIndexInDay >= season.racesPerDay) {
      return "Today's " + season.racesPerDay + ' races are done. ' +
        (S.settings.autoAdvanceDay !== false ? 'A new day dawns soon' : 'The streamer starts the next day') + ' — keep training!';
    }
    let line = 'No race running. Next up: Race ' + Math.min(season.raceIndexInDay + 1, season.racesPerDay) + '/' + season.racesPerDay + ' · ' + S.settings.distance + ' m';
    try {
      if (SD.betting) {
        const fo = SD.betting.fieldOdds(S);
        if (fo.entrants.length) {
          line += ' · ' + fo.entrants.map(function (e) { return e.name + ' ' + fmtOdds(e.odds); }).join(', ');
          if (fo.favourite) line += ' · Favourite: ' + fo.favourite.name;
        }
      } else {
        const field = SD.game && SD.game.previewField ? SD.game.previewField() : [];
        if (field.length) {
          const ents = SD.race.buildEntrants(field, { distance: Number(S.settings.distance) || 1200, hypeLevel: S.hype.value, dayEvent: SD.state.dayEvent(S), cheerBonus: {} });
          line += ' · ' + ents.map(function (e) { return e.name + ' ' + fmtOdds(e.odds); }).join(', ');
        }
      }
    } catch (e) { /* preview is best-effort */ }
    const bets = betsPhrase(S);
    if (bets) line += ' · Bets: ' + bets;
    return line + '. Train now, the gates open when the streamer says so!';
  }

  // !race — viewers: race status / next field / favourite / open bets.
  //         mods & the streamer: START RACE (optional distance: !race 2000); "!race status" shows the line.
  register({
    name: 'race',
    usage: '!race',
    description: 'What is happening on the track (next field, favourite, open bets). Mods: !race starts the race (!race 2000 picks the distance, !race status just looks).',
    cooldownMs: 0,
    handler: function (ctx, args) {
      const S = ctx.state;
      const wantsStatus = args.length === 1 && /^(?:(?:status|info|odds|next)\??|\?)$/i.test(args[0]); // "!race next?" only looks too
      if (!ctx.isMod || wantsStatus || S.currentRace) return { message: raceStatusLine(S), severity: 'info' };
      if (!SD.game || typeof SD.game.startRace !== 'function') throw new CommandError('Races cannot be started right now.');
      // A mod starts the race only with no argument or a supported distance ("2000", "2000m", "2000 m").
      // Anything else ("!race soon", a typo, "!race 1500") is refused with the usage:
      // chat that merely mentions the race must not lock the bets and open the gates.
      const opts = {};
      if (args.length) {
        const D = SD.CONFIG.RACE.DISTANCES;
        const m = /^(\d{1,6})\s*(m|metres|meters)?$/i.exec(args.join(' '));
        const dist = m ? Number(m[1]) : null;
        if (dist == null || D.indexOf(dist) < 0) {
          throw new CommandError((m ? dist + ' m is not a race distance. ' : '"' + args.join(' ').slice(0, 30) + '" is not a race option. ') +
            'Mods: !race starts the next race, !race <' + D.join('|') + '> picks the distance, !race status just looks.', { severity: 'info' });
        }
        opts.distance = dist;
      }
      const res = SD.game.startRace(opts);
      if (!res || !res.ok) return { ok: false, message: (res && res.message) || 'The race could not start.', severity: 'bad' };
      ctx.effects.push({ type: 'race', recordId: res.record.id });
      const bets = betsPhrase(ctx.state);
      const moved = res.bets && Array.isArray(res.bets.repriced) ? res.bets.repriced.length : 0;
      return {
        message: '\u{1F3C1} ' + res.message + (bets ? ' ' + bets + ' locked in' + (moved ? ' (' + moved + ' at shorter gate odds)' : '') + '.' : '') +
          ' Cheer with !cheer!',
        severity: 'epic'
      };
    }
  });

  // Day event by id, name or unique prefix ("fog" -> Fog of the Hollow).
  function findDayEvent(query) {
    const q = String(query || '').trim();
    if (!q) return { none: true };
    const exact = SD.events.dayEventById(q);
    if (exact) return { event: exact };
    const k = U.nameKey(q);
    const hits = SD.DATA.DAY_EVENTS.filter(function (e) {
      return U.nameKey(e.name).indexOf(k) === 0 || e.id.toLowerCase().indexOf(k) === 0 ||
        e.name.split(/\s+/).some(function (w) { return U.nameKey(w).indexOf(k) === 0 && k.length >= 3; });
    });
    if (hits.length === 1) return { event: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
    return { none: true };
  }

  // !event — viewers: today's day event. Mods: "!event" rolls a random new one, "!event <id|name>"
  // sets it (e.g. !event harvest), "!event today" just looks.
  register({
    name: 'event',
    usage: '!event',
    description: "Today's day event and what it changes. Mods: !event rolls a new one, !event <name> picks it.",
    cooldownMs: 0,
    handler: function (ctx, args) {
      const S = ctx.state;
      const look = args.length && /^(today|status|info|now|\?)$/i.test(args[0]);
      if (ctx.isMod && !look) {
        // M6: a mod's day-event change waits for the results, like every other mutating command.
        if (SD.state.isRaceLocked(S)) {
          throw new CommandError('Hold on — a race is running! Change the day event after the results (!event today just looks).', { locked: true, severity: 'info' });
        }
        let ev = null;
        if (args.length) {
          const f = findDayEvent(args.join(' '));
          if (f.ambiguous) throw new CommandError('Did you mean ' + orList(f.ambiguous.map(function (e) { return e.name; })) + '?', { severity: 'info' });
          if (!f.event) {
            throw new CommandError('No day event called "' + args.join(' ').slice(0, 30) + '". Try: ' +
              SD.DATA.DAY_EVENTS.map(function (e) { return e.name; }).join(', ') + '.', { severity: 'info' });
          }
          ev = f.event;
        }
        const out = SD.game.triggerDayEvent(ev ? ev.id : null);
        if (!out) throw new CommandError('Could not change the day event.');
        ctx.effects.push({ type: 'dayEvent', id: out.id });
        return { message: '\u{1F342} New day event: ' + out.name + ' — ' + out.desc, severity: 'epic' };
      }
      const ev = SD.state.dayEvent(S);
      const when = 'Season ' + S.season.number + ', Day ' + S.season.day;
      if (!ev) return { message: when + ': a calm day in the forest. No day event.', severity: 'info' };
      return { message: 'Today (' + when + '): ' + ev.name + ' — ' + ev.desc, severity: 'info' };
    }
  });

  register({
    name: 'help',
    aliases: ['h', 'commands'],
    usage: '!help [command]',
    description: 'List the commands, or explain one: !help train',
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx, args) {
      if (args.length) {
        const d = registry[resolveName(String(args[0]).replace(/^!+/, ''))];
        if (d && !d.hidden && (!d.admin || ctx.isMod)) return { message: d.usage + ' — ' + d.description, severity: 'info' };
        throw new CommandError('No command called !' + String(args[0]).replace(/^!+/, '').slice(0, 20) + '. Type !help for the list.');
      }
      const names = order.map(function (n) { return registry[n]; })
        .filter(function (d) { return !d.hidden && (!d.admin || ctx.isMod); })
        .map(function (d) { return '!' + d.name; });
      return { message: 'Commands: ' + names.join(', ') + '. Try !help train for details.', severity: 'info' };
    }
  });

  // ---------------------------------------------------------------------------
  // M3: leaderboards (read-only, no cooldown, never locked)
  // ---------------------------------------------------------------------------
  function boardNames() {
    return SD.leaderboards.CATEGORIES.map(function (c) { return c.short; }).join(', ');
  }

  register({
    name: 'leaderboard',
    aliases: ['lb', 'top'],
    usage: '!leaderboard [wins|xp|sp|part|victories|hype] [all]',
    description: 'Top ' + SD.CONFIG.LEADERBOARDS.CHAT_TOP_N + ' on a board (default: Spirit Points). Add "all" for all-time: !lb wins all',
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx, args) {
      const L = SD.leaderboards;
      if (!L) throw new CommandError('Leaderboards are not available right now.', { severity: 'info' });
      let cat = null, scope = 'season';
      const unknown = [];
      args.forEach(function (a) {
        const sc = L.resolveScope(a);
        const c = L.resolve(a);
        if (c && !cat) cat = c;
        else if (sc) scope = sc;
        else unknown.push(a);
      });
      if (!cat && unknown.length) {
        return {
          message: 'No board called "' + String(unknown[0]).slice(0, 20) + '". Boards: ' + boardNames() + ' (e.g. !lb wins, add "all" for all-time).',
          severity: 'info'
        };
      }
      const line = L.format(ctx.state, cat || 'spiritPoints', SD.CONFIG.LEADERBOARDS.CHAT_TOP_N, scope);
      return { message: line + (args.length ? '' : DOT + 'More: !lb ' + boardNames().split(', ').filter(function (s) { return s !== 'sp'; }).join(' | ')), severity: 'info' };
    }
  });

  register({
    name: 'rank',
    usage: '!rank [viewer]',
    description: 'Your rank on the Spirit Points, victories and hype boards (or another viewer\'s).',
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx, args) {
      const L = SD.leaderboards;
      if (!L) throw new CommandError('Leaderboards are not available right now.', { severity: 'info' });
      const S = ctx.state;
      let p = ctx.player;
      if (args.length) {
        p = P().get(S, args[0]);
        if (!p) throw new CommandError('No viewer called "' + cleanName(args[0]).slice(0, 25) + '" has joined the derby.', { severity: 'info' });
      }
      if (!p) throw new CommandError(isReserved(ctx.username) ? 'The streamer console has no profile: name a viewer, e.g. !' + ctx.command + ' <viewer>.' : "You're not in the derby yet — type !join", { severity: 'info' });
      const parts = SD.CONFIG.LEADERBOARDS.RANK_BOARDS.map(function (id) {
        const cat = L.get(id);
        if (!cat) return null;
        const r = L.rankOf(S, id, p.username);
        return r ? '#' + r.rank + ' in ' + cat.noun + ' (' + L.fmtNum(r.value) + ')' : 'unranked in ' + cat.noun;
      }).filter(Boolean);
      return { message: p.displayName + ': ' + parts.join(DOT), severity: 'info' };
    }
  });

  // ---------------------------------------------------------------------------
  // M5: community commands. Spirit Points are fictional: nothing here involves real money.
  // Every command that spends SP is locked while a race runs (countdown / running / paused).
  // ---------------------------------------------------------------------------
  function EC() { return SD.CONFIG.ECONOMY; }
  function CH() { return SD.CONFIG.RACE.CHAT; }

  function needBetting() {
    if (!SD.betting) throw new CommandError('Betting is not available right now.', { severity: 'info' });
    return SD.betting;
  }

  // Try a runner query without throwing (null when it does not resolve to exactly one runner).
  function tryRunner(state, query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const f = SD.state.findRunner(q, state);
    return f.runner || null;
  }

  // Review batch 8 (gap3#3): the runner whose id or WHOLE name is exactly this query (not a prefix or
  // word match), or null. The !bet / !train parsers try it first, so a name is never split into
  // "runner + amount / stat" when the viewer typed exactly a runner's name.
  function exactRunner(state, query) {
    const q = String(query || '').trim().replace(/^@+/, '');
    if (!q) return null;
    const r = tryRunner(state, q);
    if (!r) return null;
    return String(r.id).toLowerCase() === q.toLowerCase() || U.nameKey(r.name) === U.nameKey(q) ? r : null;
  }
  function amountText(a) { return a === 'all' ? 'all your SP' : a + ' SP'; }
  // How chat can type a runner: its first word when that finds it (and is not itself an amount, cancel
  // or stat word), else its full name.
  function shortOf(state, r) {
    const first = String(r.name || '').split(/\s+/)[0];
    if (parseAmount(first) != null || /^(cancel|refund|undo|none|off)$/i.test(first) || SD.training.normalizeStat(first)) return r.name;
    const f = SD.state.findRunner(first, state);
    return f.runner && f.runner.id === r.id ? first.toLowerCase() : r.name;
  }

  function inNextField(state, runnerId) {
    if (!SD.betting) return true;
    return !!SD.betting.fieldOdds(state).byId[runnerId];
  }

  // Queued chat effects: { type:'boost'|'sabotage'|'cheer', runnerId, by, count, paid? }
  function queuedCount(state, type, runnerId) {
    return (Array.isArray(state.raceEffects) ? state.raceEffects : []).reduce(function (a, e) {
      return a + (e && e.type === type && (runnerId == null || e.runnerId === runnerId) ? Math.max(1, e.count || 1) : 0);
    }, 0);
  }
  // Sabotages queued on runners in the next race's field (what its startRace will consume).
  function nextRaceSabotages(state) {
    if (!SD.betting) return queuedCount(state, 'sabotage');
    const ids = SD.betting.fieldOdds(state).entrants.map(function (e) { return e.runnerId; });
    return (Array.isArray(state.raceEffects) ? state.raceEffects : []).reduce(function (a, e) {
      return a + (e && e.type === 'sabotage' && ids.indexOf(e.runnerId) >= 0 ? Math.max(1, e.count || 1) : 0);
    }, 0);
  }
  function queueEffect(state, type, runnerId, by, paid) {
    if (!Array.isArray(state.raceEffects)) state.raceEffects = [];
    let entry = state.raceEffects.filter(function (e) { return e.type === type && e.runnerId === runnerId && e.by === by; })[0];
    if (entry) {
      entry.count = (entry.count || 1) + 1;
      entry.paid = (entry.paid || 0) + (paid || 0);
    } else {
      state.raceEffects.push(entry = { type: type, runnerId: runnerId, by: by, count: 1, paid: paid || 0 });
    }
    return entry;
  }

  function spend(ctx, amount, reason, what) {
    const p = ctx.player || P().get(ctx.state, ctx.username);
    if (!p || p.spiritPoints < amount) {
      throw new CommandError((what || 'That') + ' costs ' + amount + ' SP and you have ' + (p ? p.spiritPoints : 0) + '.', { severity: 'info' });
    }
    return function commit() {
      const r = P().spendSp(ctx.state, ctx.username, amount, reason);
      ctx.effects.push({ type: 'sp', amount: -amount, reason: reason });
      return r.balance;
    };
  }

  // --- !bet -------------------------------------------------------------------
  const BET_USAGE = '!bet <runner> <amount> (' + SD.CONFIG.ECONOMY.BET_MIN + '–' + SD.CONFIG.ECONOMY.BET_MAX + ' SP, or "all") · !bet cancel';
  const AMOUNT_RE = /^(?:(\d+)(?:sp)?|all|max|allin|all-in)$/i;
  function parseAmount(tok) {
    const m = AMOUNT_RE.exec(String(tok || ''));
    if (!m) return null;
    return m[1] != null ? Number(m[1]) : 'all';
  }

  function betLine(b) {
    return b.amount + ' SP on ' + b.runnerName + ' at ' + fmtOdds(b.odds) + ' (pays ' + SD.betting.payoutFor(b.amount, b.odds) + ')';
  }

  register({
    name: 'bet',
    usage: BET_USAGE,
    description: 'Bet fictional Spirit Points on a runner in the next race: pays amount × odds if it wins (the odds can only get shorter when the gates open). One bet each; a new bet replaces (and refunds) your old one. See !odds.',
    requiresPlayer: true,
    lockedDuringRace: true,
    handler: function (ctx, args) {
      const B = needBetting();
      const S = ctx.state;
      if (!args.length) {
        ctx.readOnly = true; // just looking: no cooldown, participation throttled like !status
        const mine = B.betOf(S, ctx.username);
        return { message: mine ? 'Your bet: ' + betLine(mine) + '. Change it with !bet <runner> <amount>, or !bet cancel.' : 'Usage: ' + BET_USAGE + ' — see !odds for the field.', severity: 'info' };
      }
      // Review batch 8 (gap3#3): exactly a runner's name (or id) and nothing else is a bet with no amount,
      // even when a word of that name reads as an amount or a cancel word ("Max Power", "Route 66", "Undo"
      // in a save made before !create refused such names): ask for the amount instead of guessing.
      const named = exactRunner(S, args.join(' '));
      if (named) {
        throw new CommandError('How much? !bet ' + shortOf(S, named) + ' <amount> (' + EC().BET_MIN + '–' + EC().BET_MAX + ' SP, or "all")' +
          (args.length === 1 && /^(cancel|refund|undo|none|off)$/i.test(args[0]) ? ' · to cancel your bet: !bet cancel' : '') + '.', { severity: 'info' });
      }
      if (args.length === 1 && /^(cancel|refund|undo|none|off)$/i.test(args[0])) {
        const c = B.cancel(S, ctx.username);
        if (!c.ok) throw new CommandError(c.message, { severity: 'info' });
        ctx.effects.push({ type: 'bet', cancelled: true, refunded: c.refunded });
        return { message: c.message, severity: 'info' };
      }
      // Amount first or last; the rest is the runner ("!bet moss 50", "!bet 50 moss runner", "!bet moss all").
      let amount = null, runner = null;
      const first = parseAmount(args[0]), last = parseAmount(args[args.length - 1]);
      const lastQ = args.slice(0, -1).join(' '), firstQ = args.slice(1).join(' ');
      const byLast = args.length >= 2 && last != null ? tryRunner(S, lastQ) : null;
      const byFirst = args.length >= 2 && first != null ? tryRunner(S, firstQ) : null;
      if (byLast && byFirst && (byLast !== byFirst || last !== first)) {
        // Both readings name a runner ("!bet 250 100" with runners called 250 and 100): an exact name
        // wins over a shorthand; when both (or neither) are exact, ask rather than guess.
        const exLast = exactRunner(S, lastQ), exFirst = exactRunner(S, firstQ);
        if (exLast && !exFirst) { amount = last; runner = byLast; }
        else if (exFirst && !exLast) { amount = first; runner = byFirst; }
        else {
          throw new CommandError('That could be ' + amountText(last) + ' on ' + byLast.name + ' or ' + amountText(first) + ' on ' + byFirst.name +
            '. Use the runner id to be sure, e.g. !bet ' + byLast.id + ' ' + args[args.length - 1] + '.', { severity: 'info' });
        }
      } else if (byLast) {
        amount = last; runner = byLast;
      } else if (byFirst) {
        amount = first; runner = byFirst;
      } else if (args.length >= 2 && (last != null || first != null)) {
        runner = resolveRunnerArg(S, last != null ? args.slice(0, -1).join(' ') : args.slice(1).join(' ')); // throws a friendly error
        amount = last != null ? last : first;
      } else if (args.length === 1 && first != null) {
        amount = first;
        // No runner named: your open bet's runner, else your own runner.
        const mine = B.betOf(S, ctx.username);
        const own = P().runnerOf(S, ctx.username);
        runner = mine ? SD.state.runnerById(mine.runnerId, S) : (own && inNextField(S, own.id) ? own : null);
        if (!runner) throw new CommandError('Name a runner: !bet <runner> ' + args[0] + ' (see !odds).', { severity: 'info' });
      } else {
        throw new CommandError('Usage: ' + BET_USAGE + ' — e.g. !bet moss 50', { severity: 'info' });
      }
      const res = B.place(S, ctx.username, runner.id, amount, ctx.now);
      if (!res.ok) throw new CommandError(res.message, { severity: 'info' });
      ctx.effects.push(
        { type: 'bet', runnerId: runner.id, amount: res.bet.amount, odds: res.bet.odds, replaced: res.replaced ? res.replaced.id : null },
        { type: 'sp', amount: -res.bet.amount + (res.refunded || 0), reason: 'bet' }
      );
      return { message: '\u{1F4B0} ' + res.message, severity: 'good' };
    }
  });

  register({
    name: 'bets',
    usage: '!bets',
    description: 'Open bets on the next race: how many, how much, on whom (and yours).',
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx) {
      const B = needBetting();
      const S = ctx.state;
      const o = B.open(S);
      const mine = ctx.player ? B.betOf(S, ctx.username) : null;
      if (!o.count) return { message: 'No open bets yet. Check !odds, then !bet <runner> <amount>.', severity: 'info' };
      const rows = Object.keys(o.byRunner).map(function (id) { return o.byRunner[id]; })
        .sort(function (a, b) { return b.total - a.total || (a.name < b.name ? -1 : 1); })
        .map(function (r) { return r.name + ' ' + r.count + ' (' + r.total + ' SP)'; });
      const where = S.currentRace ? 'Bets riding on this race' : 'Open bets for the next race';
      return {
        message: where + ': ' + plural(o.count, 'bet') + ' · ' + o.total + ' SP' + DOT + rows.slice(0, 6).join(DOT) +
          (mine ? DOT + 'Yours: ' + betLine(mine) : ''),
        severity: 'info'
      };
    }
  });

  register({
    name: 'odds',
    usage: '!odds',
    description: 'Odds for every runner in the next race (or the race that is running).',
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx) {
      const S = ctx.state;
      const cr = S.currentRace;
      if (cr && cr.record) {
        const rec = cr.record;
        return {
          message: 'Racing now at ' + rec.trackName + ' (' + rec.distance + ' m, bets locked): ' +
            rec.entrants.slice().sort(function (a, b) { return a.odds - b.odds; }).map(function (e) { return e.name + ' ' + fmtOdds(e.odds); }).join(DOT),
          severity: 'info'
        };
      }
      const B = needBetting();
      const fo = B.fieldOdds(S);
      if (!fo.entrants.length) return { message: 'No runners are ready for the next race yet.', severity: 'info' };
      const idx = Math.min(S.season.raceIndexInDay + 1, S.season.racesPerDay);
      return {
        message: 'Next race (Race ' + idx + '/' + S.season.racesPerDay + ', ' + fo.distance + ' m): ' +
          fo.entrants.slice().sort(function (a, b) { return a.odds - b.odds; }).map(function (e) { return e.name + ' ' + fmtOdds(e.odds); }).join(DOT) +
          DOT + '!bet <runner> <amount>',
        severity: 'info'
      };
    }
  });

  // --- !boost / !snack / !sabotage ---------------------------------------------
  register({
    name: 'boost',
    usage: '!boost <runner>',
    description: 'Spend ' + SD.CONFIG.ECONOMY.BOOST_COST + ' SP: the runner gets a +' + Math.round(SD.CONFIG.RACE.CHAT.BOOST * 1000) / 10 +
      '% burst at a random moment of its next race (max ' + SD.CONFIG.RACE.CHAT.MAX_BOOSTS_PER_RUNNER + ' per runner per race).',
    requiresPlayer: true,
    lockedDuringRace: true,
    handler: function (ctx, args) {
      const S = ctx.state;
      const runner = args.length ? resolveRunnerArg(S, args.join(' ')) : myRunnerOrThrow(ctx, 'name one: !boost <runner>');
      const max = CH().MAX_BOOSTS_PER_RUNNER;
      const queued = queuedCount(S, 'boost', runner.id);
      if (queued >= max) {
        throw new CommandError(runner.name + ' already has ' + max + ' boosts queued for its next race — that is the limit.', { severity: 'info' });
      }
      const pay = spend(ctx, EC().BOOST_COST, 'boost', 'A boost');
      // --- commit ---
      const balance = pay();
      queueEffect(S, 'boost', runner.id, ctx.username, EC().BOOST_COST);
      P().recordAction(S, ctx.username, runner.id, 'boost');
      const left = max - queued - 1;
      SD.state.log('chat', ctx.displayName + ' boosted ' + runner.name + ' for its next race.', 'good', { runnerId: runner.id, by: ctx.username });
      ctx.effects.push({ type: 'boost', runnerId: runner.id, queued: queued + 1 });
      return {
        message: '⚡ ' + ctx.displayName + ' boosts ' + runner.name + ' for its next race! ' +
          (left > 0 ? plural(left, 'more boost') + ' allowed' : 'That was the last boost allowed') +
          (inNextField(S, runner.id) ? '' : ' (not in the next field yet — the boost waits for its next race)') +
          DOT + balance + ' SP left',
        severity: 'good'
      };
    }
  });

  register({
    name: 'snack',
    usage: '!snack <runner>',
    description: 'Spend ' + SD.CONFIG.ECONOMY.SNACK_COST + ' SP: +' + SD.CONFIG.ECONOMY.SNACK_ENERGY + ' energy for a runner (max ' +
      SD.CONFIG.ECONOMY.SNACKS_PER_DAY + ' snacks per runner per day).',
    requiresPlayer: true,
    lockedDuringRace: true,
    handler: function (ctx, args) {
      const S = ctx.state;
      const E = EC();
      const runner = args.length ? resolveRunnerArg(S, args.join(' ')) : myRunnerOrThrow(ctx, 'name one: !snack <runner>');
      if (!runner.daily || typeof runner.daily !== 'object') runner.daily = { snacks: 0 };
      const had = runner.daily.snacks || 0;
      if (had >= E.SNACKS_PER_DAY) {
        throw new CommandError(runner.name + ' has had ' + plural(E.SNACKS_PER_DAY, 'snack') + ' today — no more until tomorrow.', { severity: 'info' });
      }
      // Energy is fractional (passive regen): a snack that would add less than 1 energy is refused
      // before anything is charged or a daily snack is used.
      if (runner.maxEnergy - runner.energy < 1) {
        throw new CommandError(runner.name + ' is already full of energy (' + Math.floor(runner.energy) + '/' + runner.maxEnergy +
          ') — a snack would not add even 1.', { severity: 'info' });
      }
      const pay = spend(ctx, E.SNACK_COST, 'snack', 'A snack');
      // --- commit ---
      const balance = pay();
      const before = runner.energy;
      runner.energy = U.round2(U.clamp(runner.energy + E.SNACK_ENERGY, 0, runner.maxEnergy));
      runner.daily.snacks = had + 1;
      runner.lastActionAt = ctx.now;
      P().recordAction(S, ctx.username, runner.id, 'snack');
      const gain = Math.round(runner.energy - before);
      const flavours = SD.DATA.SNACK_FLAVOUR || ['{r} munches a snack.'];
      const flavour = flavours[(SD.rng.hash(ctx.username + ':' + runner.id) + had) % flavours.length].replace('{r}', runner.name);
      SD.state.log('snack', ctx.displayName + ' fed ' + runner.name + ' a snack (+' + gain + ' energy).', 'good', { runnerId: runner.id, by: ctx.username });
      ctx.effects.push({ type: 'snack', runnerId: runner.id, energyGain: gain });
      const left = E.SNACKS_PER_DAY - runner.daily.snacks;
      return {
        message: '\u{1F34E} ' + flavour + ' Energy +' + gain + ' (' + Math.floor(runner.energy) + '/' + runner.maxEnergy + ')' +
          DOT + (left > 0 ? plural(left, 'snack') + ' left today' : 'no more snacks today') + DOT + balance + ' SP left',
        severity: 'good'
      };
    }
  });

  register({
    name: 'sabotage',
    usage: '!sabotage <runner>',
    description: 'Spend ' + SD.CONFIG.ECONOMY.SABOTAGE_COST + ' SP: slip a pebble into a rival\'s shoe for its next race (slower for a stretch). Wise runners may kick it back! Not your own runner; ' +
      Math.round(SD.CONFIG.COOLDOWNS.SABOTAGE_S / 60) + '-minute cooldown.',
    requiresPlayer: true,
    lockedDuringRace: true,
    minArgs: 1,
    cooldownMs: function () { return (Number(SD.CONFIG.COOLDOWNS.SABOTAGE_S) || 0) * 1000; },
    handler: function (ctx, args) {
      const S = ctx.state;
      const C = CH();
      const runner = resolveRunnerArg(S, args.join(' '));
      if (ownerKeyOf(runner) === ctx.username) throw new CommandError("You can't sabotage your own runner! Try !boost " + runner.name.split(' ')[0].toLowerCase() + ' instead.', { severity: 'info' });
      const onTarget = queuedCount(S, 'sabotage', runner.id);
      if (onTarget >= C.MAX_SABOTAGE_PER_TARGET) {
        throw new CommandError(runner.name + ' already has ' + plural(C.MAX_SABOTAGE_PER_TARGET, 'pebble') + ' waiting — leave the poor thing alone.', { severity: 'info' });
      }
      // The per-race cap counts only pebbles the next race will use (queued on runners in its field).
      // A pebble on a runner outside it waits for that runner's next race, which takes at most
      // MAX_SABOTAGE_PER_RACE (SD.game.raceEffectsFor keeps the rest queued, so none fizzles).
      if (inNextField(S, runner.id) && nextRaceSabotages(S) >= C.MAX_SABOTAGE_PER_RACE) {
        throw new CommandError('The forest only hides ' + C.MAX_SABOTAGE_PER_RACE + ' pebbles per race and the next race has them all. Try after the next race.', { severity: 'info' });
      }
      const pay = spend(ctx, EC().SABOTAGE_COST, 'sabotage', 'A sabotage');
      // --- commit ---
      const balance = pay();
      queueEffect(S, 'sabotage', runner.id, ctx.username, EC().SABOTAGE_COST);
      P().recordAction(S, ctx.username, runner.id, 'sabotage');
      const pBack = Math.min(C.BACKFIRE_MAX, C.BACKFIRE_BASE + (Number(runner.stats.wisdom) || 0) / C.BACKFIRE_WIS_DIV);
      SD.state.log('chat', ctx.displayName + ' slipped a pebble into ' + runner.name + "'s shoe.", 'bad', { runnerId: runner.id, by: ctx.username });
      ctx.effects.push({ type: 'sabotage', runnerId: runner.id, queued: onTarget + 1, backfireChance: U.round2(pBack) });
      return {
        message: '\u{1FAA8} Sabotage queued on ' + runner.name + ' for its next race. Whether the pebble sticks or ' + runner.name +
          ' kicks it back at you (' + Math.round(pBack * 100) + '% with its Wisdom) is decided at the gate!' + DOT + balance + ' SP left',
        severity: 'good',
        announce: { text: '\u{1FAA8} ' + ctx.displayName + ' slipped a pebble into ' + runner.name + "'s shoe…", severity: 'bad' }
      };
    }
  });

  // --- !ribbon -------------------------------------------------------------------
  function ribbonNames() { return Object.keys(SD.DATA.RIBBON_COLORS || {}); }
  function ribbonHelp() {
    const names = ribbonNames();
    return 'Ribbons cost ' + EC().RIBBON_COST + ' SP: ' + names.slice(0, 14).join(', ') + ' … or any #hex (e.g. !ribbon teal, !ribbon #ff66aa). !ribbon off removes it.';
  }

  register({
    name: 'ribbon',
    usage: '!ribbon <colour>',
    description: 'Spend ' + SD.CONFIG.ECONOMY.RIBBON_COST + ' SP on a coloured ribbon ring for your runner (cosmetic). Named colours or #hex; !ribbon off removes it.',
    requiresPlayer: true,
    requiresRunner: true,
    lockedDuringRace: true,
    handler: function (ctx, args) {
      const S = ctx.state;
      const runner = myRunnerOrThrow(ctx);
      if (!args.length) { ctx.readOnly = true; return { message: ribbonHelp(), severity: 'info' }; }
      const raw = args.join('').toLowerCase();
      if (/^(off|none|remove|clear)$/.test(raw)) {
        if (!runner.ribbonColor) throw new CommandError(runner.name + " isn't wearing a ribbon.", { severity: 'info' });
        runner.ribbonColor = null;
        return { message: runner.name + ' takes the ribbon off.', severity: 'info' };
      }
      // Own, string-valued entries only: 'constructor' / '__proto__' are not colours.
      const named = U.own(SD.DATA.RIBBON_COLORS, raw);
      let colour = typeof named === 'string' && named ? named : null;
      const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
      if (!colour && hex) {
        let h = hex[1].toLowerCase();
        if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
        colour = '#' + h;
      }
      if (!colour) throw new CommandError('Unknown colour "' + args.join(' ').slice(0, 20) + '". ' + ribbonHelp(), { severity: 'info' });
      if (typeof runner.ribbonColor === 'string' && runner.ribbonColor.toLowerCase() === colour) {
        throw new CommandError(runner.name + ' already wears that ribbon.', { severity: 'info' });
      }
      const pay = spend(ctx, EC().RIBBON_COST, 'ribbon', 'A ribbon');
      // --- commit ---
      const balance = pay();
      runner.ribbonColor = colour;
      const label = colour === named ? raw : colour;
      SD.state.log('ribbon', ctx.displayName + ' tied a ' + label + ' ribbon on ' + runner.name + '.', 'good', { runnerId: runner.id, by: ctx.username });
      ctx.effects.push({ type: 'ribbon', runnerId: runner.id, color: colour });
      return { message: '\u{1F380} ' + runner.name + ' now wears a ' + label + ' ribbon!' + DOT + balance + ' SP left', severity: 'good' };
    }
  });

  // --- !hype / !achievements ---------------------------------------------------------
  const HYPE_EFFECT = [
    'the forest is calm',
    'races get a little wilder',
    'more race events and crits',
    'FOREST AWAKENED: everyone surges at the final turn and SP payouts ×1.5'
  ];

  register({
    name: 'hype',
    usage: '!hype',
    description: 'The crowd hype meter and the next threshold.',
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx) {
      const S = ctx.state;
      const v = Number(S.hype.value) || 0;
      const tier = SD.hype.tier(v);
      const th = SD.DATA.HYPE_THRESHOLDS;
      const next = SD.hype.nextThreshold(v);
      const parts = ['\u{1F525} Hype ' + fmtHype(v) + '/' + fmtHype(S.hype.max)];
      parts.push(tier > 0 ? th[tier - 1].text + ' (' + HYPE_EFFECT[tier] + ')' : 'The forest is calm');
      if (next) parts.push('next: ' + next.value + ' — ' + next.text + ' (' + fmtHype(Math.ceil(next.value - v)) + ' to go)');
      parts.push('!cheer, !train and !bet raise it');
      return { message: parts.join(DOT), severity: tier >= 2 ? 'epic' : 'info' };
    }
  });

  register({
    name: 'achievements',
    aliases: ['ach', 'badges'],
    usage: '!achievements [viewer]',
    description: 'Your achievements (count and the latest ones), or another viewer\'s.',
    cooldownMs: 0,
    lookOnly: true,
    handler: function (ctx, args) {
      const A = SD.achievements;
      if (!A) throw new CommandError('Achievements are not available right now.', { severity: 'info' });
      const S = ctx.state;
      let p = ctx.player;
      if (args.length) {
        p = P().get(S, args[0]);
        if (!p) throw new CommandError('No viewer called "' + cleanName(args[0]).slice(0, 25) + '" has joined the derby.', { severity: 'info' });
      }
      if (!p) throw new CommandError(isReserved(ctx.username) ? 'The streamer console has no profile: name a viewer, e.g. !' + ctx.command + ' <viewer>.' : "You're not in the derby yet — type !join", { severity: 'info' });
      const total = A.catalog().length;
      const got = A.listFor(S, p.username);
      if (!got.length) {
        return { message: p.displayName + ' has no achievements yet (0/' + total + '). !train, !cheer and !bet to earn some!', severity: 'info' };
      }
      const n = (SD.CONFIG.ACHIEVEMENTS && SD.CONFIG.ACHIEVEMENTS.LATEST_N) || 3;
      const sp = got.reduce(function (a, x) { return a + (x.sp || 0); }, 0);
      const latest = got.slice(-n).reverse().map(function (x) { return (x.icon ? x.icon + ' ' : '') + x.name; });
      return {
        message: '\u{1F3C5} ' + p.displayName + ': ' + got.length + '/' + total + ' achievements (+' + sp + ' SP)' + DOT + 'latest: ' + latest.join(', '),
        severity: 'info'
      };
    }
  });

  SD.commands = {
    CommandError: CommandError,
    parse: parse,
    register: register,
    unregister: unregister,
    list: list,
    get: get,
    process: runCommand,
    handleChat: handleChat,
    system: system,
    cooldownLeft: cooldownLeft,
    resolveName: resolveName,
    BUILTIN_ALIASES: BUILTIN_ALIASES
  };

  // The integration point used by chat sim, SEND AS, Twitch and the bridge.
  SD.processCommand = function (username, text, opts) {
    opts = opts || {};
    return handleChat({
      username: username, displayName: opts.displayName, text: text,
      source: opts.source || 'sim', isMod: !!opts.isMod, ts: opts.ts
    });
  };
})(globalThis.SD = globalThis.SD || {});
