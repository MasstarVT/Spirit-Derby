/* SPIRIT DERBY — integrations/twitch.js (M7)
 * Anonymous, READ-ONLY Twitch chat over Twitch's IRC WebSocket gateway. Zero dependencies,
 * no token, no login: the page connects as a "justinfan" guest, which may read any public
 * channel but can never post.
 *
 *   SD.integrations.twitch.connect('fox')  → { ok, message }   (also '#Fox', 'twitch.tv/fox')
 *   SD.integrations.twitch.disconnect()    → { ok, message }
 *   SD.integrations.twitch.status()        → { adapter:'twitch', state, channel, since, messages,
 *                                              dropped, lastError, attempt, nextRetryAt, nick, ... }
 *
 * Every chat line (commands AND plain chat, so the feed shows real chat) becomes
 *   SD.processCommand(login, text, { source:'twitch', isMod, displayName })
 * and that is the ONLY way this file touches the game: Twitch is an input layer. The login
 * (always lowercase ASCII) is the player key; the display name is what the feed shows, so a
 * viewer with a localized display name still keeps one stable profile.
 *
 * Handshake (on open): CAP REQ :twitch.tv/tags twitch.tv/commands · PASS SCHMOOPIIE ·
 * NICK justinfanNNNNN · JOIN #channel. PING :tmi.twitch.tv → PONG :tmi.twitch.tv.
 * RECONNECT (Twitch maintenance) → reconnect at once. NOTICE / JOIN / PART / USERSTATE /
 * ROOMSTATE and numerics are only recorded as status lines (recentLines(), status().lastLine).
 *
 * States: off → connecting → on. A drop after 'on' → reconnecting; an attempt that never got
 * in → error. While enabled, retries use exponential backoff (1 s, 2 s, 4 s … capped at 60 s,
 * ±20 % jitter); a connection that stayed up for 15 s resets the backoff. Fatal NOTICEs
 * (suspended / nonexistent channel, failed login) stop retrying. Nothing is written to the
 * console per retry. Every change emits SD.EVENTS.INTEGRATION_STATUS
 * ({ adapter:'twitch', ...status() }), mirrors the state into SD.state.runtime.connected.twitch,
 * and connection milestones become dim 'system' lines in the chat feed.
 *
 * Inbound flood guard: at most RATE.MAX (20) chat lines per second reach the game; extras are
 * dropped and counted in status().dropped, so a raid cannot freeze the page.
 *
 * The parser is pure and exported (parseLine, parseTags, parseBadges, privmsgToChat, pongFor,
 * normalizeChannel, backoffDelay, createRateLimiter) so tools/integration-test.js can check it
 * in Node without sockets. In Node (no WebSocket) connect() returns { ok:false }.
 *
 * ---------------------------------------------------------------------------------------------
 * WRITE-BACK (posting replies into Twitch chat) — documented here, deliberately NOT built:
 *   A streamer who wants the game to talk in chat could:
 *     1. create a separate Twitch account for the bot (never use the streamer's own account);
 *     2. register an application in the Twitch developer console and get a user access token
 *        for the bot account with the chat:read + chat:edit scopes;
 *     3. in the handshake, send `PASS oauth:<token>` and `NICK <botlogin>` instead of the
 *        justinfan pair (the tags/commands CAP and JOIN stay the same);
 *     4. send replies with `PRIVMSG #channel :<text>`, throttled to Twitch's limits (about
 *        20 messages per 30 s for a normal account; exceeding them gets the bot muted for a while),
 *        and keep the token refreshed when it expires.
 *   Why it is off by default: this page is a local file with no server, so the token would sit
 *   in localStorage or in the source where any script on the page, an exported save, or a
 *   screenshot of the dev tools could leak it; a reply to every command would flood chat and trip
 *   the rate limits; and read-only guests need no account at all. Replies therefore appear on the
 *   overlay. If you want chat replies, the recommended path is the local bridge
 *   (integrations/bridge.js): Mix It Up / Streamer.bot already hold the bot's credentials and
 *   receive every reply as a JSON frame. Check Twitch's developer docs for the currently
 *   recommended chat API before building a token-based bot.
 * ---------------------------------------------------------------------------------------------
 */
(function (SD) {
  'use strict';

  const ADAPTER = 'twitch';
  const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
  const CAPS = 'twitch.tv/tags twitch.tv/commands';
  const ANON_PASS = 'SCHMOOPIIE';            // conventional password for justinfan guest logins
  const BACKOFF = { BASE_MS: 1000, CAP_MS: 60000, JITTER: 0.2 };
  const RATE = { MAX: 20, WINDOW_MS: 1000 };
  const JOIN_TIMEOUT_MS = 15000;             // no JOIN confirmation after this long → retry
  const STABLE_MS = 15000;                   // a connection that lived this long resets the backoff
  const PING_AFTER_MS = 270000;              // 4.5 min of silence → send our own PING
  const DEAD_AFTER_MS = 360000;              // 6 min of silence → the socket is dead, reconnect
  const WATCHDOG_MS = 30000;
  const LOG_LINES = 30;
  const CHANNEL_RE = /^[a-z0-9_]{1,25}$/;
  // NOTICE msg-ids that retrying cannot fix.
  const FATAL_NOTICES = { msg_channel_suspended: true, msg_banned: true, tos_ban: true };
  const FATAL_TEXT = /login authentication failed|improperly formatted auth|invalid nick/i;

  function now() { return SD.clock && SD.clock.now ? SD.clock.now() : Date.now(); }
  function evName(key, fallback) { return (SD.EVENTS && SD.EVENTS[key]) || fallback; }
  function errMsg(e) { return String((e && e.message) || e || 'unknown error'); }

  // ===========================================================================================
  // Pure helpers (unit-tested in Node)
  // ===========================================================================================

  // IRCv3 tag value escapes: \: → ;  \s → space  \\ → \  \r → CR  \n → LF; other \x → x.
  function unescapeTag(v) {
    v = String(v);
    if (v.indexOf('\\') < 0) return v;
    let out = '';
    for (let i = 0; i < v.length; i++) {
      const c = v.charAt(i);
      if (c !== '\\') { out += c; continue; }
      i++;
      if (i >= v.length) break;                // a lone trailing backslash is dropped
      const n = v.charAt(i);
      out += n === ':' ? ';' : n === 's' ? ' ' : n === 'r' ? '\r' : n === 'n' ? '\n' : n;
    }
    return out;
  }

  // "badges=broadcaster/1;display-name=Fox" (leading @ optional) → { badges:'broadcaster/1', 'display-name':'Fox' }
  function parseTags(str) {
    const tags = {};
    if (!str) return tags;
    String(str).replace(/^@/, '').split(';').forEach(function (pair) {
      if (!pair) return;
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      if (key) tags[key] = eq < 0 ? '' : unescapeTag(pair.slice(eq + 1));
    });
    return tags;
  }

  // "broadcaster/1,subscriber/12" → { broadcaster:'1', subscriber:'12' }
  function parseBadges(str) {
    const out = {};
    String(str || '').split(',').forEach(function (b) {
      if (!b) return;
      const i = b.indexOf('/');
      const k = i < 0 ? b : b.slice(0, i);
      if (k) out[k] = i < 0 ? '' : b.slice(i + 1);
    });
    return out;
  }

  // "nick!nick@nick.tmi.twitch.tv" → "nick"; a bare server name ("tmi.twitch.tv") → "".
  function nickOf(prefix) {
    if (!prefix) return '';
    const s = String(prefix);
    const bang = s.indexOf('!');
    if (bang > 0) return s.slice(0, bang);
    const at = s.indexOf('@');
    if (at > 0) return s.slice(0, at);
    return s.indexOf('.') >= 0 ? '' : s;
  }

  // One raw IRC line → { tags:{}, prefix, nick, command, params:[], trailing, raw } | null.
  // `trailing` (the text after " :") is also the last entry of `params`.
  function parseLine(raw) {
    let line = String(raw == null ? '' : raw).replace(/[\r\n]+$/, '');
    if (!line.trim()) return null;
    let tags = {};
    let prefix = null;
    let i;
    if (line.charAt(0) === '@') {
      i = line.indexOf(' ');
      if (i < 0) return null;
      tags = parseTags(line.slice(1, i));
      line = line.slice(i + 1).replace(/^ +/, '');
    }
    if (line.charAt(0) === ':') {
      i = line.indexOf(' ');
      if (i < 0) return null;
      prefix = line.slice(1, i);
      line = line.slice(i + 1).replace(/^ +/, '');
    }
    let trailing = null;
    i = line.indexOf(' :');
    if (i >= 0) {
      trailing = line.slice(i + 2);
      line = line.slice(0, i);
    }
    const params = line.split(' ').filter(Boolean);
    if (!params.length) return null;
    const command = params.shift().toUpperCase();
    if (trailing !== null) params.push(trailing);
    return { tags: tags, prefix: prefix, nick: nickOf(prefix), command: command, params: params, trailing: trailing, raw: String(raw) };
  }

  // Parsed PRIVMSG → { username, displayName, text, isMod } | null.
  // isMod: tag mod=1, or a broadcaster/1 or moderator/1 badge. /me actions are unwrapped and the
  // "@Parent " that Twitch prepends to thread replies is removed so a reply can still be a command.
  function privmsgToChat(p) {
    if (!p || p.command !== 'PRIVMSG') return null;
    const tags = p.tags || {};
    let username = String(p.nick || nickOf(p.prefix) || tags.login || '').toLowerCase();
    let text = p.trailing != null ? p.trailing : (p.params && p.params.length > 1 ? p.params[p.params.length - 1] : '');
    text = String(text);
    const action = /^\u0001ACTION ([\s\S]*?)\u0001?$/.exec(text);
    if (action) text = action[1];
    [tags['reply-parent-display-name'], tags['reply-parent-user-login']].some(function (parent) {
      if (!parent) return false;
      const lead = '@' + String(parent).toLowerCase() + ' ';
      if (text.toLowerCase().indexOf(lead) !== 0) return false;
      text = text.slice(lead.length);
      return true;
    });
    const displayName = String(tags['display-name'] || '').trim() || username;
    if (!username) username = displayName.toLowerCase();
    if (!username) return null;
    const badges = parseBadges(tags.badges);
    const isMod = tags.mod === '1' || badges.broadcaster === '1' || badges.moderator === '1';
    return { username: username, displayName: displayName, text: text.trim(), isMod: !!isMod };
  }

  // PING :tmi.twitch.tv → "PONG :tmi.twitch.tv"
  function pongFor(p) {
    const arg = p && p.trailing != null ? p.trailing : (p && p.params && p.params[0]) || 'tmi.twitch.tv';
    return 'PONG :' + arg;
  }

  // "#Fox", "fox", "@fox", "https://www.twitch.tv/fox?x=1" → "fox"; invalid → "".
  function normalizeChannel(input) {
    let s = String(input == null ? '' : input).trim().toLowerCase();
    s = s.replace(/^https?:\/\//, '').replace(/^(www\.|m\.)?twitch\.tv\//, '').replace(/^[#@]+/, '');
    s = s.split(/[/?#\s]/)[0];
    return CHANNEL_RE.test(s) ? s : '';
  }

  // attempt 0,1,2… → 1 s, 2 s, 4 s … capped at 60 s, ±JITTER. random() = 0.5 gives the exact base.
  function backoffDelay(attempt, random) {
    const n = Math.max(0, Math.floor(Number(attempt) || 0));
    const base = Math.min(BACKOFF.CAP_MS, BACKOFF.BASE_MS * Math.pow(2, Math.min(n, 30)));
    let r = typeof random === 'function' ? Number(random()) : Math.random();
    if (!(r >= 0)) r = 0.5;
    if (r > 1) r = 1;
    const jittered = base * (1 + BACKOFF.JITTER * (2 * r - 1));
    return Math.round(Math.max(BACKOFF.BASE_MS * (1 - BACKOFF.JITTER), Math.min(BACKOFF.CAP_MS, jittered)));
  }

  // Sliding-window limiter: allow(now) is true for at most `max` calls per `windowMs`.
  function createRateLimiter(max, windowMs) {
    const stamps = [];
    return {
      allow: function (t) {
        while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
        if (stamps.length >= max) return false;
        stamps.push(t);
        return true;
      },
      reset: function () { stamps.length = 0; },
      size: function () { return stamps.length; }
    };
  }

  // ===========================================================================================
  // Connection
  // ===========================================================================================
  const st = {
    state: 'off', channel: '', since: now(), messages: 0, dropped: 0, lastError: null,
    attempt: 0, nextRetryAt: null, nick: '', lastLine: ''
  };
  const lines = [];                          // recent status lines (NOTICE, ROOMSTATE, CAP …)
  const limiter = createRateLimiter(RATE.MAX, RATE.WINDOW_MS);
  const timers = { retry: 0, join: 0, watchdog: 0 };
  let enabled = false;                       // the streamer wants to be connected (drives retries)
  let ws = null;
  let joined = false;
  let connectedAt = 0;
  let lastRx = 0;
  let pingSent = false;
  let outage = false;                        // an outage was announced (once, not per retry)
  let everJoined = false;                    // joined at least once since connect() (→ "Reconnected")

  function status() {
    return {
      adapter: ADAPTER, state: st.state, channel: st.channel, since: st.since, messages: st.messages,
      dropped: st.dropped, lastError: st.lastError, attempt: st.attempt, nextRetryAt: st.nextRetryAt,
      nick: st.nick, enabled: enabled, lastLine: st.lastLine, readOnly: true
    };
  }
  function emitStatus() {
    if (SD.bus) SD.bus.emit(evName('INTEGRATION_STATUS', 'integration:status'), status());
  }
  function setState(next, patch) {
    if (patch) Object.assign(st, patch);
    if (st.state !== next) { st.state = next; st.since = now(); }
    const rt = SD.state && SD.state.runtime;
    if (rt) {
      if (!rt.connected || typeof rt.connected !== 'object') rt.connected = {};
      rt.connected[ADAPTER] = next;
    }
    emitStatus();
  }

  function note(text) {
    const line = String(text).slice(0, 300);
    st.lastLine = line;
    lines.push({ t: now(), text: line });
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
  }

  // A dim line in the chat feed (never throws into the socket loop).
  function systemLine(text, severity) {
    try {
      if (SD.commands && typeof SD.commands.system === 'function') { SD.commands.system(text, severity || 'info'); return; }
      if (SD.bus) {
        SD.bus.emit(evName('CHAT_MESSAGE', 'chat:message'), {
          id: 'tw' + now(), username: null, displayName: '', text: text, source: 'system', isMod: false,
          kind: 'system', severity: severity || 'info', ts: now()
        });
      }
    } catch (e) { /* ignore */ }
  }

  function setTimer(name, fn, ms) {
    clearTimer(name);
    timers[name] = setTimeout(function () { timers[name] = 0; fn(); }, ms);
  }
  function clearTimer(name) {
    if (!timers[name]) return;
    if (name === 'watchdog') clearInterval(timers[name]); else clearTimeout(timers[name]);
    timers[name] = 0;
  }
  function clearTimers() { Object.keys(timers).forEach(clearTimer); }

  function sendRaw(line) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(line + '\r\n'); return true; } catch (e) { return false; }
  }

  function closeQuietly(sock) {
    if (!sock) return;
    sock.onopen = null; sock.onmessage = null; sock.onerror = null; sock.onclose = null;
    try { sock.close(); } catch (e) { /* ignore */ }
  }
  function teardown() {
    clearTimers();
    const sock = ws;
    ws = null;
    joined = false;
    closeQuietly(sock);
  }

  function savedChannel() {
    const s = SD.state && SD.state.get ? SD.state.get() : null;
    return (s && s.settings && s.settings.twitch && s.settings.twitch.channel) || '';
  }

  function connect(channel, opts) {
    opts = opts || {};
    const raw = channel == null || channel === '' ? savedChannel() : channel;
    const chan = normalizeChannel(raw);
    if (!chan) {
      return {
        ok: false,
        message: raw ? '"' + String(raw).slice(0, 40) + '" is not a Twitch channel name (letters, numbers and _ only).'
          : 'Enter the Twitch channel to read (the streamer\'s login name).'
      };
    }
    if (typeof WebSocket === 'undefined') {
      return { ok: false, message: 'WebSocket is not available here (Node or a very old browser), so Twitch chat cannot connect.' };
    }
    if (enabled && st.channel === chan && ws) {
      return { ok: true, message: (st.state === 'on' ? 'Already connected to' : 'Already connecting to') + ' Twitch chat #' + chan + '.' };
    }
    teardown();
    enabled = true;
    outage = false;
    everJoined = false;
    if (st.channel !== chan) { st.messages = 0; st.dropped = 0; limiter.reset(); }
    Object.assign(st, { channel: chan, attempt: 0, nextRetryAt: null, lastError: null });
    open(true);
    return { ok: true, message: 'Connecting to Twitch chat #' + chan + (opts.auto ? ' (auto-connect)' : '') + '…' };
  }

  function open(fresh) {
    clearTimer('retry');
    st.nextRetryAt = null;
    joined = false;
    pingSent = false;
    if (fresh) setState('connecting'); else emitStatus();
    let sock;
    try {
      sock = new WebSocket(IRC_URL);
    } catch (e) {
      fatal('Could not open the Twitch socket: ' + errMsg(e));
      return;
    }
    ws = sock;
    let opened = false;
    sock.onopen = function () {
      if (sock !== ws) return;
      opened = true;
      lastRx = now();
      st.nick = 'justinfan' + (10000 + Math.floor(Math.random() * 90000));
      sendRaw('CAP REQ :' + CAPS);
      sendRaw('PASS ' + ANON_PASS);
      sendRaw('NICK ' + st.nick);
      sendRaw('JOIN #' + st.channel);
      setTimer('join', function () {
        if (sock === ws && !joined) dropSocket('Twitch did not confirm joining #' + st.channel + '.');
      }, JOIN_TIMEOUT_MS);
    };
    sock.onmessage = function (ev) { if (sock === ws) receive(ev ? ev.data : ''); };
    sock.onerror = function () { /* a close event always follows; handled there */ };
    sock.onclose = function (ev) {
      if (sock !== ws) return;
      ws = null;
      const code = ev && ev.code ? ' (code ' + ev.code + ')' : '';
      onSocketGone(opened ? 'The Twitch chat connection closed' + code + '.' : 'Could not reach Twitch chat' + code + '.');
    };
  }

  function dropSocket(reason) {
    const sock = ws;
    ws = null;
    closeQuietly(sock);
    onSocketGone(reason);
  }

  function onSocketGone(reason) {
    clearTimer('join');
    clearTimer('watchdog');
    const wasOn = st.state === 'on';
    joined = false;
    if (!enabled) { setState('off'); return; }
    if (wasOn && connectedAt && now() - connectedAt >= STABLE_MS) st.attempt = 0;
    scheduleRetry(wasOn || st.state === 'reconnecting' ? 'reconnecting' : 'error', reason);
  }

  function scheduleRetry(nextState, reason) {
    const delay = backoffDelay(st.attempt);
    st.attempt += 1;
    st.nextRetryAt = now() + delay;
    if (reason) st.lastError = reason;
    setTimer('retry', function () { if (enabled) open(false); }, delay);
    if (!outage) {
      outage = true;
      systemLine(nextState === 'reconnecting'
        ? '📡 Lost Twitch chat #' + st.channel + ' — reconnecting…'
        : '📡 Could not reach Twitch chat #' + st.channel + ' — retrying in the background.', 'bad');
    }
    setState(nextState);
  }

  // Retrying cannot help (suspended channel, bad login, blocked socket): stop and show why.
  function fatal(reason) {
    enabled = false;
    teardown();
    outage = false;
    st.nextRetryAt = null;
    setState('error', { lastError: reason });
    systemLine('📡 Twitch chat stopped: ' + reason, 'bad');
  }

  function markJoined() {
    if (joined) return;
    joined = true;
    connectedAt = now();
    clearTimer('join');
    const again = everJoined;
    everJoined = true;
    outage = false;
    st.nextRetryAt = null;
    startWatchdog();
    setState('on', { lastError: null });
    systemLine('📡 ' + (again ? 'Reconnected' : 'Connected') + ' to Twitch chat #' + st.channel + ' (read-only).', 'good');
  }

  function startWatchdog() {
    clearTimer('watchdog');
    timers.watchdog = setInterval(function () {
      if (!ws || !joined) return;
      const idle = now() - lastRx;
      if (idle >= DEAD_AFTER_MS) dropSocket('No data from Twitch for ' + Math.round(idle / 60000) + ' minutes.');
      else if (idle >= PING_AFTER_MS && !pingSent) { pingSent = true; sendRaw('PING :spiritderby'); }
    }, WATCHDOG_MS);
  }

  function disconnect() {
    const was = st.state;
    enabled = false;
    teardown();
    outage = false;
    Object.assign(st, { attempt: 0, nextRetryAt: null, lastError: null });
    setState('off');
    if (was !== 'off' && st.channel) systemLine('📡 Disconnected from Twitch chat #' + st.channel + '.', 'info');
    return { ok: true, message: was === 'off' ? 'Twitch chat is not connected.' : 'Disconnected from Twitch chat #' + st.channel + '.' };
  }

  // ===========================================================================================
  // Inbound
  // ===========================================================================================
  // One WebSocket frame (one or more CRLF-separated IRC lines). Returns what happened:
  // { lines, routed, dropped, out:[lines we answered with, e.g. 'PONG :tmi.twitch.tv'] }.
  function receive(frame) {
    const acc = { lines: 0, routed: 0, dropped: 0, out: [] };
    if (frame == null || frame === '') return acc;
    lastRx = now();
    pingSent = false;
    String(frame).split(/\r?\n/).forEach(function (raw) {
      if (!raw) return;
      acc.lines++;
      try {
        handleLine(raw, acc);
      } catch (e) {
        note('! could not handle a line: ' + errMsg(e));
      }
    });
    if (acc.routed || acc.dropped) emitStatus();
    return acc;
  }

  function handleLine(raw, acc) {
    const m = parseLine(raw);
    if (!m) return;
    switch (m.command) {
      case 'PING': {
        const pong = pongFor(m);
        acc.out.push(pong);
        sendRaw(pong);
        return;
      }
      case 'PONG':
        return;
      case 'PRIVMSG':
        onPrivmsg(m, acc);
        return;
      case 'RECONNECT':
        note('RECONNECT — Twitch asked us to reconnect');
        if (ws && enabled) {
          st.attempt = 0;
          connectedAt = 0;
          dropSocket('Twitch asked us to reconnect (server maintenance).');
        }
        return;
      case 'JOIN':
      case 'ROOMSTATE':
      case '366':
        note(m.command + ' ' + m.params.join(' '));
        if (ws && enabled && !joined && (m.command !== 'JOIN' || !st.nick || m.nick === st.nick)) markJoined();
        return;
      case 'NOTICE':
        onNotice(m);
        return;
      case '001':
        note('Logged in as ' + (m.params[0] || st.nick));
        return;
      default:
        // PART, USERSTATE, GLOBALUSERSTATE, CAP, CLEARCHAT, USERNOTICE, numerics …
        note((m.command + ' ' + m.params.join(' ')).slice(0, 200));
    }
  }

  function onNotice(m) {
    const text = m.trailing || m.params.slice(1).join(' ');
    const id = (m.tags && m.tags['msg-id']) || '';
    note('NOTICE ' + (id ? '[' + id + '] ' : '') + text);
    if (FATAL_NOTICES[id] || FATAL_TEXT.test(text)) {
      if (enabled) fatal(text || id);
      else st.lastError = text || id;
    }
  }

  function onPrivmsg(m, acc) {
    const chat = privmsgToChat(m);
    if (!chat || !chat.username || !chat.text) return;
    if (!limiter.allow(now())) {
      st.dropped++;
      acc.dropped++;
      return;
    }
    st.messages++;
    acc.routed++;
    if (typeof SD.processCommand !== 'function') return;
    try {
      SD.processCommand(chat.username, chat.text, { source: 'twitch', isMod: chat.isMod, displayName: chat.displayName });
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[twitch] processCommand failed', e);
    }
  }

  // ===========================================================================================
  // Public API
  // ===========================================================================================
  function init() {
    const rt = SD.state && SD.state.runtime;
    if (rt && rt.connected && rt.connected[ADAPTER] == null) rt.connected[ADAPTER] = st.state;
    emitStatus();
  }

  SD.integrations = SD.integrations || {};
  SD.integrations.twitch = {
    ADAPTER: ADAPTER,
    IRC_URL: IRC_URL,
    RATE: RATE,
    BACKOFF: BACKOFF,
    init: init,
    connect: connect,
    disconnect: disconnect,
    status: status,
    receive: receive,
    recentLines: function () { return lines.slice(); },
    resetStats: function () { st.messages = 0; st.dropped = 0; limiter.reset(); },
    isConnected: function () { return st.state === 'on'; },
    // pure helpers
    parseLine: parseLine,
    parseTags: parseTags,
    parseBadges: parseBadges,
    unescapeTag: unescapeTag,
    privmsgToChat: privmsgToChat,
    pongFor: pongFor,
    normalizeChannel: normalizeChannel,
    backoffDelay: backoffDelay,
    createRateLimiter: createRateLimiter
  };
})(globalThis.SD = globalThis.SD || {});
