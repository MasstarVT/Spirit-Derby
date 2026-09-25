/*
 * Spirit Derby - commands.js
 * THE integration point: simulated chat, the admin SEND AS box, Twitch (M7) and the local
 * bridge (M7) all feed text through SD.commands.handleChat / SD.processCommand.
 *
 * Pipeline (plan section 4), in this exact order:
 *   parse -> lookup -> admin permission -> player gate -> race lock -> per-user cooldown ->
 *   arity -> handler inside SD.state.mutate('cmd:' + name) -> stamp cooldown (ok only) ->
 *   emit chat:message (kind 'reply') + command:result
 * The incoming line itself is always emitted as chat:message kind 'user' (even plain chat).
 *
 * Handlers use check-then-commit: validate everything first and `throw new CommandError(msg)`
 * BEFORE any write to reject without mutating. A handler returns a string (ok reply) or
 * { ok?, message, severity?, effects? }.
 *
 * Commands never touch state.currentRace: mutating commands are refused while a race is
 * locked (countdown / running / paused), and SD.game.startRace refuses a second race.
 */
(function (SD) {
  'use strict';

  const U = SD.util;
  const DOT = ' · ';
  const MAX_TEXT = 500;        // incoming chat line cap
  const MAX_REPLY = 400;       // hard safety cap (Twitch allows 500); replies aim for <= ~200
  const FEED_CAP = 80;         // SD.state.runtime.chatFeed length
  const SOURCES = { sim: true, twitch: true, bridge: true, admin: true };
  // Aliases resolved by parse() even before the target command is registered.
  const BUILTIN_ALIASES = { t: 'train', lb: 'leaderboard', stats: 'status', r: 'rest', c: 'cheer', i: 'inspect', h: 'help', commands: 'help' };
  // Zero-width characters some chat clients append to repeated messages.
  const INVISIBLE = /[͏​-‏⁠﻿]|\udb40[\udc00-\udc7f]/g;

  const registry = {};   // name -> def
  const order = [];      // registration order (for !help)
  const aliasMap = {};   // alias -> name
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
  function ownerKeyOf(runner) { return runner && runner.owner ? keyOf(runner.owner) : null; }
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
    if (runner.owner) {
      throw new CommandError(runner.name + ' runs for ' + runner.owner + '. Open training is off, so you can only ' + verb + ' your own runner.');
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
    return (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + 'x';
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
  //        lockedDuringRace, cooldownMs (number | fn(ctx)), cooldownKey, minArgs, hidden, handler(ctx, args) }
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
      minArgs: d.minArgs, hidden: d.hidden
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

  function lastUse(username, def) {
    const map = SD.state.runtime.cooldowns && SD.state.runtime.cooldowns[username];
    return map ? map[cooldownKeyOf(def)] : undefined;
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

  function stampCooldown(username, def, now) {
    const rt = SD.state.runtime;
    if (!rt.cooldowns) rt.cooldowns = {};
    if (!rt.cooldowns[username]) rt.cooldowns[username] = {};
    rt.cooldowns[username][cooldownKeyOf(def)] = now;
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
    const displayName = cleanName(msg.displayName) || cleanName(msg.username) || username;
    const source = SOURCES[msg.source] ? msg.source : 'sim';
    const isMod = !!msg.isMod || source === 'admin';
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
    // 3. player gate
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
    const lastActivity = readOnly && rt.activity ? rt.activity[username] : undefined;
    const ctx = {
      state: state, username: username, displayName: displayName, source: source, isMod: isMod, player: player,
      parsed: parsed, args: parsed.args, argText: parsed.argText, command: def.name, now: now,
      effects: effects, touched: false,
      // false for a read-only command repeated inside CONFIG.LEADERBOARDS.READONLY_ACTIVITY_S
      countActivity: !(lastActivity != null && now - lastActivity < activityWindowMs())
    };
    const cdLen = cooldownLength(def, ctx);
    if (cdLen > 0 && source !== 'admin') {
      const last = lastUse(username, def);
      const left = last == null ? 0 : cdLen - (now - last);
      if (left > 0) {
        return finish(false, '!' + def.name + ' is cooling down — try again in ' + U.fmtDuration(left) + '.',
          { cooldownMs: left, cooldown: true, severity: 'info' });
      }
    }
    // 6. arity
    if (parsed.args.length < def.minArgs) return finish(false, 'Usage: ' + def.usage, { severity: 'info' });

    // 7. handler (check-then-commit inside one mutate)
    let out;
    try {
      out = SD.state.mutate('cmd:' + def.name, function (st) {
        ctx.state = st;
        const r = normalizeOut(def.handler(ctx, parsed.args));
        if (r.ok && !ctx.touched && P() && P().get(st, username)) {
          // The streamer console (source admin) can speak as anyone: it never changes player.isMod.
          const t = P().touch(st, username, {
            isMod: source === 'admin' ? undefined : isMod, displayName: displayName, now: now, count: ctx.countActivity
          });
          if (t.dailyBonus) {
            r.message += DOT + 'Daily bonus +' + t.dailyBonus + ' SP!';
            effects.push({ type: 'sp', amount: t.dailyBonus, reason: 'daily' });
          }
        }
        return r;
      });
    } catch (e) {
      if (e instanceof CommandError) {
        const x = e.extra || {};
        out = { ok: false, message: e.message, severity: x.severity || 'bad', cooldownMs: x.cooldownMs || 0 };
      } else {
        if (typeof console !== 'undefined') console.error('[SD.commands] !' + def.name + ' failed:', e);
        try { SD.state.log('error', '!' + def.name + ' from ' + displayName + ' failed: ' + ((e && e.message) || e), 'warn'); } catch (x) { /* ignore */ }
        out = { ok: false, message: 'Something went wrong with !' + def.name + '. The streamer can check the log.', severity: 'bad' };
      }
    }
    if (Array.isArray(out.effects)) out.effects.forEach(function (x) { if (effects.indexOf(x) < 0) effects.push(x); });

    // 8. stamp the cooldown (successful commands only)
    if (out.ok && cdLen > 0) stampCooldown(username, def, now);
    if (out.ok && readOnly && ctx.countActivity && P() && P().get(SD.state.get(), username)) {
      if (!rt.activity) rt.activity = {};
      rt.activity[username] = now;
    }
    return finish(out.ok, out.message, {
      severity: out.severity || (out.ok ? 'good' : 'bad'),
      cooldownMs: out.ok ? cdLen : (out.cooldownMs || 0)
    });
  }

  // Every chat line enters here. Emits the 'user' line, then runs the pipeline for commands.
  // msg: { username, displayName?, text, source:'sim'|'twitch'|'bridge'|'admin', isMod, ts? }
  // -> { ok, isCommand, command, message, effects, cooldownMs }
  function handleChat(msg) {
    msg = msg || {};
    const username = keyOf(msg.username);
    const displayName = cleanName(msg.displayName) || cleanName(msg.username);
    const text = String(msg.text == null ? '' : msg.text).replace(INVISIBLE, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TEXT);
    const source = SOURCES[msg.source] ? msg.source : 'sim';
    const isMod = !!msg.isMod || source === 'admin';
    if (!username || !text) {
      return { ok: false, isCommand: false, command: null, message: username ? 'Empty message.' : 'Missing username.', effects: [], cooldownMs: 0 };
    }
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
      if (args.length === 1) {
        stat = norm(args[0]);
        if (!stat) throw new CommandError('Usage: ' + TRAIN_USAGE);
      } else {
        const last = norm(args[args.length - 1]);
        const first = norm(args[0]);
        if (last) { stat = last; query = args.slice(0, -1).join(' '); }
        else if (first) { stat = first; query = args.slice(1).join(' '); }
        else throw new CommandError('Unknown stat "' + String(args[args.length - 1]).slice(0, 20) + '". Usage: ' + TRAIN_USAGE);
      }
      const runner = query ? resolveRunnerArg(S, query) : myRunnerOrThrow(ctx, 'train one by name: !train <runner> ' + stat);
      assertMayHandle(ctx, runner, 'train');

      const hypeBefore = S.hype.value;
      const res = SD.game.trainRunner(runner.id, stat, ctx.username);
      if (!res || !res.ok) return { ok: false, message: (res && res.message) || 'Training did not happen.', severity: 'bad' };
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
      if (left > 0) throw new CommandError(runner.name + ' is still resting — try again in ' + U.fmtDuration(left) + '.', { cooldownMs: left, severity: 'info' });
      const res = SD.game.restRunner(runner.id, ctx.username);
      if (!res || !res.ok) return { ok: false, message: (res && res.message) || 'Resting did not happen.', cooldownMs: res && res.cooldownMs };
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
      P().recordAction(S, ctx.username, runner ? runner.id : null, 'cheer');
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
        if (!rt.nervousCheers) rt.nervousCheers = {};
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
    handler: function (ctx, args) {
      const S = ctx.state;
      let runner = null;
      if (args.length) runner = resolveRunnerArg(S, args.join(' '));
      else if (P()) runner = P().runnerOf(S, ctx.username);
      if (!runner) throw new CommandError('Usage: !inspect <runner>');
      const parts = [runner.emoji + ' ' + runner.name, 'Lv ' + runner.level + ' ' + styleName(runner.style),
        runner.owner ? 'Owner: ' + runner.owner : 'Unclaimed', statsLine(runner),
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

  // !race — viewer-facing race status (read-only).
  // TODO(M5): mods/streamer (ctx.isMod) get START RACE here: call SD.game.startRace() and reply with its message.
  register({
    name: 'race',
    usage: '!race',
    description: 'What is happening on the track right now (and who is favourite).',
    cooldownMs: 0,
    handler: function (ctx) {
      const S = ctx.state;
      const season = S.season;
      const cr = S.currentRace;
      if (cr && cr.record) {
        const rec = cr.record;
        if (cr.status === 'finished') return { message: 'The race at ' + rec.trackName + ' just finished — results incoming!', severity: 'info' };
        const fav = rec.entrants.slice().sort(function (a, b) { return a.odds - b.odds; })[0];
        const word = cr.status === 'paused' ? 'is PAUSED' : (cr.status === 'countdown' ? 'is about to start' : 'is running');
        return {
          message: 'Race ' + rec.indexInDay + '/' + season.racesPerDay + ' at ' + rec.trackName + ' (' + rec.distance + ' m) ' + word + ': ' +
            rec.entrants.map(function (e) { return e.name; }).join(', ') + '. Favourite: ' + fav.name + ' at ' + fmtOdds(fav.odds) + '. !cheer them on!',
          severity: 'info'
        };
      }
      if (season.raceIndexInDay >= season.racesPerDay) {
        return { message: "Today's " + season.racesPerDay + ' races are done. A new day dawns soon — keep training!', severity: 'info' };
      }
      let line = 'No race running. Next up: Race ' + (season.raceIndexInDay + 1) + '/' + season.racesPerDay + ' · ' + S.settings.distance + ' m';
      try {
        const field = SD.game && SD.game.previewField ? SD.game.previewField() : [];
        if (field.length) {
          const ents = SD.race.buildEntrants(field, { distance: Number(S.settings.distance) || 1200, hypeLevel: S.hype.value, dayEvent: SD.state.dayEvent(S), cheerBonus: {} });
          line += ' · ' + ents.map(function (e) { return e.name + ' ' + fmtOdds(e.odds); }).join(', ');
        }
      } catch (e) { /* preview is best-effort */ }
      return { message: line + '. Train now, the gates open when the streamer says so!', severity: 'info' };
    }
  });

  // !event — today's day event (read-only).
  // TODO(M5): mods/streamer trigger a day event here: SD.game.triggerDayEvent(args[0]).
  register({
    name: 'event',
    usage: '!event',
    description: "Today's day event and what it changes.",
    cooldownMs: 0,
    handler: function (ctx) {
      const S = ctx.state;
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
    handler: function (ctx, args) {
      const L = SD.leaderboards;
      if (!L) throw new CommandError('Leaderboards are not available right now.', { severity: 'info' });
      const S = ctx.state;
      let p = ctx.player;
      if (args.length) {
        p = P().get(S, args[0]);
        if (!p) throw new CommandError('No viewer called "' + cleanName(args[0]).slice(0, 25) + '" has joined the derby.', { severity: 'info' });
      }
      if (!p) throw new CommandError("You're not in the derby yet — type !join", { severity: 'info' });
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
  // Later-milestone registration points (do not implement here yet)
  // ---------------------------------------------------------------------------
  // TODO(M5): register !bet <runner> <amount>, !boost <runner>, !snack <runner>, !sabotage <runner>
  //           (cooldown CONFIG.COOLDOWNS.SABOTAGE_S), !ribbon <colour>; extend !race / !event with mod actions.
  // TODO(M6): register !create <name> (requires settings.allowCreate and no free runner) -> SD.game.spawnRunner + claim.

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
