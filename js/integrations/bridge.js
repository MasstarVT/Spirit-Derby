/* SPIRIT DERBY — integrations/bridge.js (M7)
 * Generic local WebSocket bridge for Mix It Up, Streamer.bot or a custom bot/relay script.
 * The page is the WebSocket CLIENT: it connects to a small server the streamer runs locally
 * (default ws://localhost:8765). Zero dependencies.
 *
 *   SD.integrations.bridge.connect(url?)   → { ok, message }   (url defaults to settings.bridge.url)
 *   SD.integrations.bridge.disconnect()    → { ok, message }
 *   SD.integrations.bridge.status()        → { adapter:'bridge', state, url, since, messages, dropped,
 *                                              malformed, ignored, sent, lastError, attempt, nextRetryAt }
 *   SD.integrations.bridge.receive(json)   → { ok, handled, malformed, dropped, ignored, results }
 *   SD.integrations.bridge.send(obj)       → true | false (no-op while closed)
 *
 * INBOUND frames (text, JSON): one chat message or an array of them (a batch):
 *   { "username": "FoxFan", "text": "!train speed", "isMod": false, "displayName": "FoxFan" }
 *   → SD.processCommand(username, text, { source:'bridge', isMod, displayName })
 *   Lenient aliases: user/userName for username, message for text, isBroadcaster/mod for isMod
 *   (true, 1, "1", "true", "yes"). { "type":"ping" } is answered with { "type":"pong" }; other
 *   "type"s are ignored. Malformed JSON / missing fields are counted (status().malformed) and
 *   ignored, never thrown. Same flood guard as Twitch: at most 20 messages per second.
 *
 * OUTBOUND frames (so the bot can speak in Twitch chat):
 *   on open        { type:'hello', app:'spirit-derby', version, protocol:1 }
 *   every command result from source 'bridge' or 'twitch' (configure({ replySources }))
 *                  { type:'reply', username, displayName, command, ok, message, severity, source,
 *                    id, chat:'@Name message', cooldown?, locked? }
 *                  unknown commands (another bot's !discord) are NOT sent unless
 *                  configure({ replyUnknown:true }).
 *   race finished  { type:'race', winner, results:[{ place, name, owner, runnerId, timeSec }],
 *                    recordId, track, distance, photoFinish, upset, message }
 *
 * Status / backoff / events follow integrations/twitch.js: states off | connecting | on |
 * error (never reached the bridge; retrying) | reconnecting (lost it after 'on'); backoff 1 s → 2 → 4 …
 * capped at 60 s with jitter; no console output per retry (the browser itself still prints one
 * "WebSocket connection failed" line per attempt, which the backoff keeps to about one a minute).
 * Emits SD.EVENTS.INTEGRATION_STATUS { adapter:'bridge', ...status() } and mirrors the state
 * into SD.state.runtime.connected.bridge.
 *
 * Trust: the bridge decides isMod. Only point this at a relay you run yourself.
 */
(function (SD) {
  'use strict';

  const ADAPTER = 'bridge';
  const DEFAULT_URL = 'ws://localhost:8765';
  const PROTOCOL = 1;
  const BACKOFF = { BASE_MS: 1000, CAP_MS: 60000, JITTER: 0.2 };
  const RATE = { MAX: 20, WINDOW_MS: 1000 };
  const STABLE_MS = 15000;
  const MAX_FRAME_CHARS = 65536;
  const MAX_BATCH = 100;
  const MEDALS = ['🥇', '🥈', '🥉'];

  function now() { return SD.clock && SD.clock.now ? SD.clock.now() : Date.now(); }
  function evName(key, fallback) { return (SD.EVENTS && SD.EVENTS[key]) || fallback; }
  function errMsg(e) { return String((e && e.message) || e || 'unknown error'); }

  // ---------------------------------------------------------------- pure helpers
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

  function createRateLimiter(max, windowMs) {
    const stamps = [];
    return {
      allow: function (t) {
        while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
        if (stamps.length >= max) return false;
        stamps.push(t);
        return true;
      },
      reset: function () { stamps.length = 0; }
    };
  }

  // "ws://localhost:8765" / "wss://…" → trimmed URL; anything else → "".
  function normalizeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (s.length > 300 || !/^wss?:\/\/[^\s/?#]+/i.test(s) || /\s/.test(s)) return '';
    return s;
  }

  function truthy(v) {
    return v === true || v === 1 || v === '1' || (typeof v === 'string' && /^(true|yes|on)$/i.test(v.trim()));
  }
  function pickStr() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60);
      if (typeof v === 'number' && isFinite(v)) return String(v);
    }
    return '';
  }

  // command:result payload (+ the reply chat line's flags) → outbound reply frame.
  function replyFrame(r, flags) {
    flags = flags || {};
    const name = r.displayName || r.username || '';
    const frame = {
      type: 'reply', username: r.username, displayName: name, command: r.command, ok: !!r.ok,
      message: String(r.message == null ? '' : r.message), severity: r.severity || (r.ok ? 'good' : 'bad'),
      source: r.source, id: r.id || null
    };
    frame.chat = (name ? '@' + name + ' ' : '') + frame.message;
    if (flags.cooldown) frame.cooldown = true;
    if (flags.locked) frame.locked = true;
    if (flags.unknown) frame.unknown = true;
    return frame;
  }

  // race:finished payload → outbound race frame (with a ready-to-post chat line).
  function raceFrame(p) {
    const rec = (p && p.record) || {};
    const ents = {};
    (rec.entrants || []).forEach(function (e) { if (e && e.runnerId) ents[e.runnerId] = e; });
    const results = ((p && p.results) || rec.results || []).slice().sort(function (a, b) {
      return (Number(a.place) || 99) - (Number(b.place) || 99);
    }).map(function (r) {
      const e = ents[r.runnerId] || {};
      return {
        place: r.place, name: r.name || e.name || r.runnerId || '?', owner: r.ownerAtRace || e.ownerAtRace || null,
        runnerId: r.runnerId || null, timeSec: isFinite(Number(r.timeSec)) ? Math.round(Number(r.timeSec) * 100) / 100 : null
      };
    });
    const sum = rec.summary || {};
    const winner = sum.winnerName || (results[0] && results[0].name) || null;
    const podium = results.slice(0, 3).map(function (x, i) {
      return MEDALS[i] + ' ' + x.name + (x.owner ? ' (' + x.owner + ')' : '');
    }).join(' · ');
    const where = [rec.trackName, rec.distance ? rec.distance + ' m' : ''].filter(Boolean).join(', ');
    const message = winner
      ? '🏆 ' + winner + ' wins' + (where ? ' (' + where + ')' : '') + '! ' + podium +
        (sum.photoFinish ? ' — photo finish!' : '') + (sum.upset ? ' — what an upset!' : '')
      : '🏁 The race is over!';
    return {
      type: 'race', winner: winner, results: results, recordId: rec.id || null, track: rec.trackName || null,
      distance: rec.distance || null, photoFinish: !!sum.photoFinish, upset: !!sum.upset, message: message
    };
  }

  // ---------------------------------------------------------------- state
  const st = {
    state: 'off', url: '', since: now(), messages: 0, dropped: 0, malformed: 0, ignored: 0, sent: 0,
    lastError: null, lastBad: null, attempt: 0, nextRetryAt: null
  };
  const options = { replySources: { bridge: true, twitch: true }, replyUnknown: false };
  const limiter = createRateLimiter(RATE.MAX, RATE.WINDOW_MS);
  let enabled = false;
  let ws = null;
  let retryTimer = 0;
  let connectedAt = 0;
  let outage = false;
  let everOpened = false;
  let listening = false;
  let lastReply = null;

  function status() {
    return {
      adapter: ADAPTER, state: st.state, url: st.url, since: st.since, messages: st.messages, dropped: st.dropped,
      malformed: st.malformed, ignored: st.ignored, sent: st.sent, lastError: st.lastError, lastBad: st.lastBad,
      attempt: st.attempt, nextRetryAt: st.nextRetryAt, enabled: enabled
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
  function systemLine(text, severity) {
    try {
      if (SD.commands && typeof SD.commands.system === 'function') { SD.commands.system(text, severity || 'info'); return; }
      if (SD.bus) {
        SD.bus.emit(evName('CHAT_MESSAGE', 'chat:message'), {
          id: 'br' + now(), username: null, displayName: '', text: text, source: 'system', isMod: false,
          kind: 'system', severity: severity || 'info', ts: now()
        });
      }
    } catch (e) { /* ignore */ }
  }

  function isOpen() { return !!ws && ws.readyState === 1; }

  function send(obj) {
    if (!isOpen() || obj == null) return false;
    let text;
    try { text = typeof obj === 'string' ? obj : JSON.stringify(obj); } catch (e) { return false; }
    try { ws.send(text); st.sent++; return true; } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- outbound listeners
  function ensureListeners() {
    if (listening || !SD.bus) return;
    listening = true;
    SD.bus.on(evName('CHAT_MESSAGE', 'chat:message'), function (m) {
      if (m && m.kind === 'reply') lastReply = m;
    });
    SD.bus.on(evName('COMMAND_RESULT', 'command:result'), onCommandResult);
    SD.bus.on(evName('RACE_FINISHED', 'race:finished'), function (p) {
      if (isOpen()) send(raceFrame(p));
    });
  }

  function onCommandResult(r) {
    if (!r || !isOpen() || !options.replySources[r.source]) return;
    // commands.js emits the reply chat line (with unknown / cooldown / locked flags) right before
    // command:result, both carrying the same id.
    const flags = lastReply && lastReply.id === r.id ? lastReply
      : { unknown: !!(SD.commands && SD.commands.get && r.command && !SD.commands.get(r.command)) };
    if (flags.unknown && !options.replyUnknown) return;
    send(replyFrame(r, flags));
  }

  // ---------------------------------------------------------------- connection
  function savedUrl() {
    const s = SD.state && SD.state.get ? SD.state.get() : null;
    return (s && s.settings && s.settings.bridge && s.settings.bridge.url) || '';
  }

  function connect(url, opts) {
    opts = opts || {};
    const raw = url == null || url === '' ? (savedUrl() || DEFAULT_URL) : url;
    const u = normalizeUrl(raw);
    if (!u) return { ok: false, message: 'The bridge URL must start with ws:// or wss:// (e.g. ' + DEFAULT_URL + ').' };
    if (typeof WebSocket === 'undefined') {
      return { ok: false, message: 'WebSocket is not available here (Node or a very old browser), so the bridge cannot connect.' };
    }
    ensureListeners();
    if (enabled && st.url === u && ws) {
      return { ok: true, message: (st.state === 'on' ? 'Already connected to' : 'Already connecting to') + ' the bridge at ' + u + '.' };
    }
    teardown();
    enabled = true;
    outage = false;
    everOpened = false;
    if (st.url !== u) { st.messages = 0; st.dropped = 0; st.malformed = 0; st.ignored = 0; st.sent = 0; limiter.reset(); }
    Object.assign(st, { url: u, attempt: 0, nextRetryAt: null, lastError: null });
    open(true);
    return { ok: true, message: 'Connecting to the bridge at ' + u + (opts.auto ? ' (auto-connect)' : '') + '…' };
  }

  function open(fresh) {
    clearTimeout(retryTimer);
    retryTimer = 0;
    st.nextRetryAt = null;
    if (fresh) setState('connecting'); else emitStatus();
    let sock;
    try {
      sock = new WebSocket(st.url);
    } catch (e) {
      // SyntaxError (bad URL) or SecurityError (e.g. ws:// from an https:// page): retrying cannot help.
      fatal('Could not open ' + st.url + ': ' + errMsg(e));
      return;
    }
    ws = sock;
    let opened = false;
    sock.onopen = function () {
      if (sock !== ws) return;
      opened = true;
      connectedAt = now();
      const again = everOpened;
      everOpened = true;
      outage = false;
      st.nextRetryAt = null;
      setState('on', { lastError: null });
      send({ type: 'hello', app: 'spirit-derby', version: SD.VERSION || null, protocol: PROTOCOL });
      systemLine('🔌 ' + (again ? 'Reconnected' : 'Connected') + ' to the chat bridge (' + st.url + ').', 'good');
    };
    sock.onmessage = function (ev) { if (sock === ws) receive(ev ? ev.data : null); };
    sock.onerror = function () { /* a close event always follows; handled there */ };
    sock.onclose = function (ev) {
      if (sock !== ws) return;
      ws = null;
      const code = ev && ev.code ? ' (code ' + ev.code + ')' : '';
      onSocketGone(opened ? 'The bridge connection closed' + code + '.' : 'No bridge is answering at ' + st.url + code + '.');
    };
  }

  function closeQuietly(sock) {
    if (!sock) return;
    sock.onopen = null; sock.onmessage = null; sock.onerror = null; sock.onclose = null;
    try { sock.close(); } catch (e) { /* ignore */ }
  }
  function teardown() {
    clearTimeout(retryTimer);
    retryTimer = 0;
    const sock = ws;
    ws = null;
    closeQuietly(sock);
  }

  function onSocketGone(reason) {
    const wasOn = st.state === 'on';
    if (!enabled) { setState('off'); return; }
    if (wasOn && connectedAt && now() - connectedAt >= STABLE_MS) st.attempt = 0;
    const next = wasOn || st.state === 'reconnecting' ? 'reconnecting' : 'error';
    const delay = backoffDelay(st.attempt);
    st.attempt += 1;
    st.nextRetryAt = now() + delay;
    st.lastError = reason;
    retryTimer = setTimeout(function () { retryTimer = 0; if (enabled) open(false); }, delay);
    if (!outage) {
      outage = true;
      systemLine(next === 'reconnecting'
        ? '🔌 Lost the chat bridge — reconnecting…'
        : '🔌 No chat bridge at ' + st.url + ' yet — retrying quietly in the background.', 'bad');
    }
    setState(next);
  }

  function fatal(reason) {
    enabled = false;
    teardown();
    outage = false;
    st.nextRetryAt = null;
    setState('error', { lastError: reason });
    systemLine('🔌 Chat bridge stopped: ' + reason, 'bad');
  }

  function disconnect() {
    const was = st.state;
    enabled = false;
    teardown();
    outage = false;
    Object.assign(st, { attempt: 0, nextRetryAt: null, lastError: null });
    setState('off');
    if (was !== 'off') systemLine('🔌 Disconnected from the chat bridge.', 'info');
    return { ok: true, message: was === 'off' ? 'The bridge is not connected.' : 'Disconnected from the bridge.' };
  }

  // ---------------------------------------------------------------- inbound
  function receive(input) {
    const res = { ok: true, handled: 0, malformed: 0, dropped: 0, ignored: 0, results: [] };
    let data;
    if (typeof input === 'string') {
      if (input.length > MAX_FRAME_CHARS) return bad(res, 'frame larger than ' + MAX_FRAME_CHARS + ' characters');
      try { data = JSON.parse(input); } catch (e) { return bad(res, 'not valid JSON'); }
    } else if (input && typeof input === 'object') {
      data = input;                         // already-parsed object (handy from the console)
    } else {
      return bad(res, 'empty or binary frame');
    }
    const items = Array.isArray(data) ? data : [data];
    items.forEach(function (item, i) {
      if (i >= MAX_BATCH) { res.dropped++; st.dropped++; return; }
      handleItem(item, res);
    });
    res.ok = res.malformed === 0;
    emitStatus();
    return res;
  }

  function bad(res, why) {
    res.ok = false;
    res.malformed++;
    st.malformed++;
    st.lastBad = why;
    emitStatus();
    return res;
  }

  function handleItem(item, res) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      res.malformed++; st.malformed++; st.lastBad = 'a frame item is not an object';
      return;
    }
    const type = item.type == null ? 'chat' : String(item.type).toLowerCase();
    if (type === 'ping') { send({ type: 'pong', ts: now() }); res.ignored++; st.ignored++; return; }
    if (type !== 'chat' && type !== 'message') { res.ignored++; st.ignored++; return; }
    const username = pickStr(item.username, item.user, item.userName, item.displayName);
    const text = typeof item.text === 'string' ? item.text : (typeof item.message === 'string' ? item.message : '');
    if (!username || !text.trim()) {
      res.malformed++; st.malformed++; st.lastBad = 'missing "username" or "text"';
      return;
    }
    if (!limiter.allow(now())) { res.dropped++; st.dropped++; return; }
    const isMod = truthy(item.isMod) || truthy(item.isBroadcaster) || truthy(item.mod);
    const displayName = pickStr(item.displayName, item.display_name) || username;
    st.messages++;
    res.handled++;
    if (typeof SD.processCommand !== 'function') {
      res.results.push({ username: username, ok: false, isCommand: false, command: null, message: 'The command pipeline is not loaded.' });
      return;
    }
    let r = null;
    try {
      r = SD.processCommand(username, text, { source: 'bridge', isMod: isMod, displayName: displayName });
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[bridge] processCommand failed', e);
    }
    res.results.push(r
      ? { username: username, ok: !!r.ok, isCommand: !!r.isCommand, command: r.command || null, message: r.message || '' }
      : { username: username, ok: false, isCommand: false, command: null, message: 'Command failed.' });
  }

  // ---------------------------------------------------------------- public API
  function configure(o) {
    o = o || {};
    if (Array.isArray(o.replySources)) {
      options.replySources = {};
      o.replySources.forEach(function (s) { options.replySources[String(s)] = true; });
    }
    if (o.replyUnknown !== undefined) options.replyUnknown = !!o.replyUnknown;
    return { replySources: Object.keys(options.replySources), replyUnknown: options.replyUnknown };
  }

  function init() {
    ensureListeners();
    const rt = SD.state && SD.state.runtime;
    if (rt && rt.connected && rt.connected[ADAPTER] == null) rt.connected[ADAPTER] = st.state;
    emitStatus();
  }

  SD.integrations = SD.integrations || {};
  SD.integrations.bridge = {
    ADAPTER: ADAPTER,
    DEFAULT_URL: DEFAULT_URL,
    PROTOCOL: PROTOCOL,
    RATE: RATE,
    BACKOFF: BACKOFF,
    init: init,
    connect: connect,
    disconnect: disconnect,
    status: status,
    receive: receive,
    send: send,
    configure: configure,
    isConnected: isOpen,
    resetStats: function () {
      st.messages = 0; st.dropped = 0; st.malformed = 0; st.ignored = 0; st.sent = 0; st.lastBad = null; limiter.reset();
    },
    // pure helpers
    replyFrame: replyFrame,
    raceFrame: raceFrame,
    normalizeUrl: normalizeUrl,
    backoffDelay: backoffDelay,
    createRateLimiter: createRateLimiter
  };
})(globalThis.SD = globalThis.SD || {});
