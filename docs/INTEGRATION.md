# Spirit Derby: Twitch, Mix It Up and OBS

This guide covers connecting Spirit Derby to a real Twitch chat, relaying replies back through a
chat bot (Mix It Up, Streamer.bot or your own script), and putting the game on stream with OBS.

Both chat connections are **off by default**. The game plays fine without them: the simulated chat,
the demo bots and SEND AS all use the same command pipeline.

- **Read-only Twitch chat** needs no account, token or install. The game reads the channel as an
  anonymous guest and never posts anything.
- **The chat bridge** is optional. It connects the game to a small local WebSocket relay so a chat
  bot can feed messages in and post the game's replies back into Twitch chat.

---

## 1. How it fits together

```
 Twitch chat ──(IRC over wss://, read-only)──► js/integrations/twitch.js ──┐
 Mix It Up / Streamer.bot ──(local relay, JSON)──► js/integrations/bridge.js ─┤
 Simulated chat, demo bots, SEND AS ──────────────────────────────────────────┤
                                                                              ▼
 ┌────────────────┐   ┌──────────────────┐   ┌──────────────┐   ┌────────────┐   ┌────────────────┐
 │ Twitch message │ → │  Command parser  │ → │ Game action  │ → │ Game state │ → │   UI update    │
 │  "!train spd"  │   │ SD.processCommand│   │  SD.game.*   │   │  SD.state  │   │ bus → panels,  │
 │                │   │ parse, cooldown, │   │ train, rest, │   │ (autosaved)│   │ overlay toasts │
 │                │   │ race lock, perms │   │ cheer, claim │   │            │   │ (+ bridge reply)│
 └────────────────┘   └──────────────────┘   └──────────────┘   └────────────┘   └────────────────┘
```

Every source ends up in the same call:
`SD.processCommand(username, text, { source: 'twitch' | 'bridge' | 'sim' | 'admin', isMod, displayName })`.
The adapters only feed text in. They cannot change a race or the game state any other way, so
spamming chat cannot corrupt a race. Races are simulated before playback starts, and commands that
change things are locked while a race runs.

---

## 2. Read-only Twitch chat (no token)

1. Open `index.html` (double-click it, or use OBS; see section 7).
2. Press **`** (backtick) or click **⚙** to open **Streamer Controls**, then expand **📡 Twitch & bridge**.
3. Type your channel name into **Twitch chat**. This is your login name, the part after `twitch.tv/`,
   not your display name. `#fox`, `@fox` and `https://twitch.tv/fox` all work, and so do the chat
   popout / OBS dock URL (`https://www.twitch.tv/popout/fox/chat?popout=`), Mod View
   (`twitch.tv/moderator/fox`) and embed URLs. Press **CONNECT**.
4. The pill changes from `CONNECTING…` to `ON · 0` and the dot in the header turns green. The Chat
   tab shows `📡 Connected to Twitch chat #fox (read-only).`, followed by every chat line as it arrives.
5. Tick **Auto-connect on load** to reconnect automatically each time the page opens.

What happens under the hood:

- The page opens `wss://irc-ws.chat.twitch.tv:443` and logs in as `justinfan12345` (a random
  5-digit guest nick with the conventional password `SCHMOOPIIE`). It requests Twitch's tags and
  commands capabilities and joins `#yourchannel`. Guest logins can read any public channel but can
  never send messages.
- **Mods** are recognised from Twitch's own data: the `mod=1` tag, a `moderator/1` badge or the
  `broadcaster/1` badge. You count as a mod in your own chat.
- **Player identity** is the viewer's login (lowercase). The feed shows their display name, so a
  viewer with a localized display name still keeps a single profile, and the runner they `!claim`
  is owned by that login: they can train it and are paid for it like everyone else. (Before review
  batch 2 a claim stored the display name, so such a viewer never really owned the runner; loading an
  older save repairs this and releases runners nobody could use.)
- **Flood guard:** at most 20 commands per second, and separately at most 20 plain chat lines per
  second, reach the game. The two budgets are independent, so a busy chat can never crowd out the
  `!commands`. During a raid the rest are dropped and counted, and the admin section shows
  `N dropped (flood guard, M commands)`. This keeps the page responsive.
- **Reconnects:** if the connection drops, the game retries after 1 s, then 2 s, 4 s, and so on,
  up to once a minute. It keeps retrying until you press DISCONNECT. When Twitch sends a
  maintenance `RECONNECT`, the game reconnects immediately. If a suspended or nonexistent channel
  produces a NOTICE, the pill shows ERROR and retries stop.

### Header dot

| Dot | Meaning |
|---|---|
| grey | nothing connected |
| amber (blinking) | connecting or reconnecting |
| green | Twitch chat or the bridge is connected |
| red | the last attempt failed. Hover for the reason; retries continue in the background unless the error is fatal |

The tooltip lists both connections, for example `Twitch: on (#fox, 142 msgs) · Bridge: off`.
In overlay mode the header buttons fade out, but the dot is still there on hover.

### URL options (per window, nothing is saved)

| Add to the URL | Effect |
|---|---|
| `?twitch=fox` | read #fox in this window, whatever the saved setting says |
| `?twitch=0` | never auto-connect Twitch in this window |
| `?bridge=1` or `?bridge=ws://localhost:8765` | connect the bridge (saved URL or the given one) |
| `?bridge=0` | never auto-connect the bridge in this window |
| `?connect=0` | no auto-connect at all (use this for a second tab) |

Combine them with `&`: `index.html?overlay=1&twitch=fox&bridge=1`.

---

## 3. What viewers type

A typical first minute for a viewer:

```
!join              → joins the derby (+200 Spirit Points)
!claim             → claims the first free runner (or: !claim moss)
!train speed       → trains your runner (stats: speed, stamina, power, wisdom, luck)
!cheer             → hype +3 and +2 SP; works mid-race too
!status            → your SP, rank and runner at a glance
```

The full command list is in section 9.

---

## 4. Why the replies appear on the overlay and not in chat

The read-only connection **cannot post** to Twitch. Guest logins are read-only by design, and no
token is ever stored. Every command still gets a reply:

- In the **Chat** tab (control window), every reply is shown indented under the viewer's line.
- In **overlay mode** (`?overlay=1` or key **O**), replies pop up as toasts in the bottom-right
  strip on stream, for example `@FoxFan Moss Runner raced a very smug hare. It was close. · Speed +3 · …`.
  Replies to unknown commands
  (`!discord` meant for another bot) are not toasted.

This is deliberate. A game that answers every `!train` in chat would flood your chat and run into
Twitch's message limits. Toasts on the overlay are something viewers can see without the spam.

## 5. Adding write-back (replies in Twitch chat)

**Recommended: use the bridge (section 6).** Mix It Up and Streamer.bot are already logged in as
your bot account. The game sends each reply to the bridge as a JSON frame, and the bot decides
which replies to post. The game never sees a token.

**Possible but not built: a bot token inside the game.** If you know what you are doing, these are
the steps (no code is included here on purpose):

1. Create a separate Twitch account for the bot. Never use your own account's token.
2. Register an application in the Twitch developer console and generate a **user access token for
   the bot account** with the `chat:read` and `chat:edit` scopes. Check Twitch's developer docs for
   the currently recommended chat API and token flow first.
3. In `js/integrations/twitch.js`, send `PASS oauth:<token>` and `NICK <botlogin>` in the handshake
   instead of the guest pair. `CAP REQ` and `JOIN` stay the same.
4. Send replies with `PRIVMSG #yourchannel :<text>`, throttled to Twitch's limits (roughly 20
   messages per 30 seconds for a normal account; going over gets the bot temporarily muted). Posting
   only the successful and important replies is a good idea.
5. Refresh the token when it expires.

Why this is off by default: the game is a local web page with no server. A token would have to sit
in the source or in browser storage. From there it can leak through an exported save, a shared
screenshot of the developer tools or any script on the page. The comment block at the top of
`twitch.js` explains the same.

---

## 6. The chat bridge (Mix It Up, Streamer.bot, custom bots)

The page is a WebSocket **client**. It connects to a relay you run on your own PC, by default
`ws://localhost:8765`. Your bot talks to the same relay. In the admin section, enter the relay URL
under **Chat bridge** (with the example relay below that is `ws://localhost:8765/?token=<the relay's
token>`), press **CONNECT**, and tick **Auto-connect on load** if you want that.

> **⚠ Security: the bridge is trusted completely.** Whatever sends frames to the game decides the
> viewer's name and whether they are a mod. Two rules keep viewers from abusing that:
>
> 1. **Never build a frame by pasting chat text into JSON.** A template such as
>    `{"username":"$user","text":"$message","isMod":false}` lets a viewer who types a `"` add keys of
>    their own: they can then start races as a "mod", bet or spend another viewer's Spirit Points,
>    or steal their runner. **Anyone who can put a `"` into a templated frame is effectively a
>    mod.** Use the relay's `POST /chat` endpoint, which takes the raw message and builds the JSON
>    itself, or a real JSON serializer (see the Mix It Up and Streamer.bot recipes below).
> 2. **Only frames that come from the game may be posted in chat.** The example relay below
>    enforces this: bot frames go to the game only, and only the game's `reply` / `race` frames reach
>    your bot's chat action.
> 3. **Lock the relay with a token.** Any web page open in your browser can try to reach a relay on
>    `localhost`. The example relay refuses every client that does not present its token.
>
> The game also refuses frames that look tampered with (duplicate keys, unknown keys, or
> disagreeing aliases; see below), but that is a safety net, not a replacement for the rules above.

### Frames the game accepts (bot → game)

A single chat message:

```json
{ "username": "FoxFan", "text": "!train speed", "isMod": false, "displayName": "FoxFan" }
```

A batch (array) of messages:

```json
[
  { "username": "FoxFan", "text": "!join" },
  { "username": "MothMom", "text": "!cheer moss", "isMod": true }
]
```

- `username` and `text` are required. `displayName` and `isMod` are optional. **Send `isMod: true`
  for mods and for the broadcaster.** `displayName` is only used when it is the username in other
  letter case (`FoxFan` for `foxfan`); anything else, including a localized display name, is
  replaced by the username, so a viewer can never choose the name the game shows for them. `isMod` accepts `true` / `false`, `1` / `0`, `"true"` /
  `"false"`, `"yes"` / `"no"` and `"on"` / `"off"`; any other value is refused.
- A chat message may carry **only** these keys (plus `"type": "chat"`). The older aliases still work:
  `user` / `userName` for `username`, `message` for `text`, `isBroadcaster` / `mod` for `isMod` and
  `display_name` for `displayName`. If a message carries more than one key for the same field,
  they must agree (`"isMod": false` with `"isBroadcaster": true` is refused; send one `isMod`).
- These frames are **refused as malformed**, because they are what a hand-built template produces
  when a viewer types a `"`: a key that appears twice anywhere in the frame, an unknown key,
  disagreeing aliases, or an `isMod` that is not a boolean. The admin section then shows
  `N malformed (last: <reason>)`, and `SD.integrations.bridge.status().lastBad` has the reason.
- `{ "type": "ping" }` is answered with `{ "type": "pong", "ts": … }`. Frames with any other `type`
  are ignored.
- Send **text** WebSocket frames. Binary frames are decoded as UTF-8 text; anything else binary is
  counted as malformed.
- Malformed JSON and messages without `username` or `text` are counted as malformed and skipped;
  they never crash the game. The same flood guard as Twitch applies (20 commands and 20 plain chat
  lines per second).
- **The bridge decides who is a mod.** Only point the game at a relay you control.

### Frames the game sends (game → bot)

When the game connects:

```json
{ "type": "hello", "app": "spirit-derby", "version": "1.0.0", "protocol": 1 }
```

After each command from the bridge **or from read-only Twitch chat**:

```json
{ "type": "reply", "username": "foxfan", "displayName": "FoxFan", "command": "train", "ok": true,
  "message": "Moss Runner raced a very smug hare. It was close. · Speed +3 · Energy -12 · Hype +1 · +5 SP",
  "severity": "good", "source": "bridge", "id": "m42",
  "chat": "@FoxFan Moss Runner raced a very smug hare. It was close. · Speed +3 · Energy -12 · Hype +1 · +5 SP" }
```

- `chat` is ready to post as-is. Refusals are included with `ok: false` and carry `cooldown: true`
  (on cooldown, including a runner's 3-minute `!rest` cooldown and the 30 s wait after a command
  failed with an internal error) or `locked: true` (a race is
  running, including a mod's `!event <name>` mid-race), so your bot can skip them if it likes.
- Replies to **unknown** commands (such as `!discord`, meant for another bot) are **not** sent by
  default. For debugging you can enable them from the browser console with
  `SD.integrations.bridge.configure({ replyUnknown: true })`.
- Replies to commands typed in the simulated chat or SEND AS are never sent.

When a race finishes:

```json
{ "type": "race", "winner": "Velvet Comet",
  "results": [ { "place": 1, "name": "Velvet Comet", "owner": "FoxFan", "runnerId": "r03", "timeSec": 71.42 },
               { "place": 2, "name": "Moss Runner", "owner": null, "runnerId": "r01", "timeSec": 71.9 } ],
  "recordId": "…", "track": "Hollow Glade", "distance": 1200, "photoFinish": false, "upset": false,
  "message": "🏆 Velvet Comet wins (Hollow Glade, 1200 m)! 🥇 Velvet Comet (FoxFan) · 🥈 Moss Runner · 🥉 …" }
```

### Which input should you use?

Feed each chat message into the game **once**:

- **Read-only Twitch plus the bridge for replies:** leave Twitch connected and have your bot post
  the `reply`/`race` frames. Do not also send chat messages in through the bridge.
- **Bridge only:** your bot forwards chat messages to the relay and posts the replies. Leave the
  read-only Twitch connection off.

If both inputs carry the same messages, every command runs twice.

### Mix It Up

Mix It Up (MIU) can run an action whenever a chat message or command arrives. **Do not type the
JSON frame into an MIU action by hand:** MIU's special identifiers are inserted as raw text, so a
viewer's `"` would break out of the JSON (see the security note at the top of this section).
Use the example relay's serialising endpoint instead:

- Add a **Web Request** action that sends a `POST` to
  `http://localhost:8765/chat?user=<the user's login name>&mod=<1 for mods and the broadcaster, else 0>&token=<the relay's token>`
  with the **chat message as the raw request body** (content type `text/plain`). The relay turns
  that into `{ "username", "text", "isMod" }` with a real JSON serializer, so nothing a viewer types
  can change the user or the mod flag. The relay only accepts a login name (letters, digits and `_`)
  in `user=` and refuses a request that repeats `user=` or `mod=`.
- If your MIU version cannot send a raw body, do not fall back to a JSON template or to putting the
  message in the URL. Use Streamer.bot or a small script with a real serializer instead.
- **Do not use the External Program / Run Program action with the chat message on the command
  line** (`node send.js "$message"`, a `.bat` / `.cmd` file, `cmd /c …`, `powershell -Command …`).
  A viewer's `"`, `&`, `|`, `%…%` or `$(…)` could then add arguments or even **run commands on your
  PC**. If a script is unavoidable, it must read the message from standard input or a file and build
  the JSON with a serializer (for example `JSON.stringify` in Node).

**Check the Mix It Up documentation for the exact action names and special identifiers in your
version.** These change between releases, and this guide does not assume them. To post the game's
replies, have the relay forward the `chat` field of the **game's** `reply`/`race` frames to something
that can speak in chat, for example MIU's local developer API if you have it enabled (see the MIU
docs for its chat endpoint). The example relay marks the spot with `[for chat]`.

### Streamer.bot

Streamer.bot can act as a WebSocket client and run C# actions. Connect a **WebSocket client** to
the relay (`ws://localhost:8765/?token=<the relay's token>`), and on chat messages run a C# action that builds the frame with a JSON serializer, never
with a text template:

```csharp
using System;
using Newtonsoft.Json;

public class CPHInline
{
    public bool Execute()
    {
        // Argument names differ between Streamer.bot versions and triggers: check its docs.
        CPH.TryGetArg("userName", out string login);        // the login name (player key)
        CPH.TryGetArg("user", out string display);          // the display name
        CPH.TryGetArg("message", out string text);
        CPH.TryGetArg("isModerator", out bool isModerator);
        CPH.TryGetArg("isBroadcaster", out bool isBroadcaster);
        string frame = JsonConvert.SerializeObject(new {
            username = login, displayName = display, text = text, isMod = isModerator || isBroadcaster
        });
        CPH.WebsocketSend(frame, 0);                        // 0 = the index of the relay connection
        return true;
    }
}
```

Post `chat` from incoming `reply` / `race` frames. With the example relay, only the game's frames
ever reach the bot. Check the Streamer.bot docs for the exact triggers, argument names and
sub-actions.

### Optional: a minimal relay using the `ws` package

> **Optional, not part of the game.** Spirit Derby has no dependencies. Use this script only if you
> want a relay and do not have one. It needs [Node.js](https://nodejs.org) and the `ws` package,
> which you install yourself in a separate folder: `npm install ws`.

What it does to keep chat viewers and other web pages out:

- It listens on `127.0.0.1` only, so other machines cannot reach it.
- **Every client must present the relay's token.** On its first start the relay makes a random
  token, saves it in `relay-token.txt` next to `relay.js` and prints the URLs to use. (To pick your
  own, `set RELAY_TOKEN=a-long-random-word`, or in PowerShell `$env:RELAY_TOKEN='…'`, before
  `node relay.js`.) Put it in the game's bridge URL (`ws://localhost:8765/?token=…`) and in your
  bot's URLs, or have the bot send it as an `X-Relay-Token` header. The token is what keeps other
  web pages out: a page in a sandboxed frame has the Origin `null`, exactly like the game opened from
  disk, so without a token any page open in your browser could connect, send commands as a "mod", or
  pretend to be the game and make your bot post its text in chat.
- It refuses WebSocket connections and `POST`s from web pages on other sites (Origin check). Bots
  and scripts send no `Origin` header; the game sends `null` (from `file://`) or `http://localhost…`.
- `POST /chat?user=<login>&mod=0|1&token=…` takes the **raw** chat message as a `text/plain` body
  and builds the JSON with `JSON.stringify`, so no chat text is ever inside a JSON template.
- It remembers which socket is the game: a **browser** connection (bots send no `Origin`, so a bot,
  or a viewer's text inside a bot's frame, can never become the game) whose first frame is
  `{ "type": "hello", "app": "spirit-derby" }`, and only while no other game is connected. A second
  game is refused (close code 1008) until the first one disconnects. Bot frames go **only to the
  game**, never to other bots, and only the game's `reply` / `race` frames are passed to bots and
  printed for chat.
- The token is a password for your relay: keep it off stream. The game hides it (`?token=…`) in the
  chat feed, toasts, the admin status line and EXPORT JSON, but the **bridge URL box** in Streamer
  Controls shows it as typed, and the relay window prints it at start-up.

```js
// relay.js: a Spirit Derby chat relay (optional helper).  Run: node relay.js
//
//   Token: every client must present the relay's token (?token=… or an X-Relay-Token header). The
//         relay makes one on first start and keeps it in relay-token.txt (or set RELAY_TOKEN).
//   Game: connects to ws://localhost:8765/?token=<token> and says {"type":"hello","app":"spirit-derby"}
//         first. Only THAT socket's frames go to the bots and only its reply/race frames are printed
//         under [for chat]. Only a browser can be the game, and only one game at a time.
//   Bots: EITHER post the RAW chat message (text/plain, no JSON) to
//           http://localhost:8765/chat?user=<login>&mod=0|1&token=<token>   (the relay builds the JSON)
//         OR connect to ws://localhost:8765/?token=<token> and send frames built with a JSON serializer.
//         Bot frames go to the game only: never to other bots, never to chat.
//   Safety: listens on 127.0.0.1 only; refuses web pages from other sites (Origin check).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 8765;
const MAX_BODY = 2000;
const TOKEN = process.env.RELAY_TOKEN || loadOrMakeToken();

// The token is what keeps other web pages out: a page in a sandboxed frame has the Origin "null",
// exactly like the game opened from disk, so the Origin check alone cannot tell them apart.
function loadOrMakeToken() {
  const file = path.join(__dirname, 'relay-token.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch (e) { /* first start */ }
  const fresh = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(file, fresh + '\n');
  return fresh;
}

// Browsers always send Origin; bots and scripts send none. Allow only the game's own origins:
// file:// pages ("null") and http://localhost / 127.0.0.1 (tools/serve.js).
function originOk(origin) {
  if (origin === undefined) return true;
  return origin === 'null' || origin === 'file://' ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}
function requestUrl(req) {
  try { return new URL(req.url, 'http://localhost'); } catch (e) { return null; }   // a garbled request
}
function tokenOk(req, url) {
  return (url.searchParams.get('token') || req.headers['x-relay-token']) === TOKEN;
}

let game = null;                               // the browser socket that said hello as spirit-derby
function gameLive() { return !!game && game.readyState === 1; }
function toGame(text) {
  if (!gameLive()) return false;
  game.send(text);                             // a string, so always a TEXT frame
  return true;
}

const server = http.createServer((req, res) => {
  const url = requestUrl(req);
  if (!url) { res.writeHead(400); res.end(); return; }
  if (req.method !== 'POST' || url.pathname !== '/chat') { res.writeHead(404); res.end(); return; }
  // A POST from a web page always carries an Origin header (even "null"); bots send none.
  if (req.headers.origin !== undefined || !tokenOk(req, url)) { res.writeHead(403); res.end(); return; }
  const users = url.searchParams.getAll('user');
  const mods = url.searchParams.getAll('mod');
  if (users.length !== 1 || mods.length > 1 || !/^[A-Za-z0-9_]{1,25}$/.test(users[0])) {
    res.writeHead(400); res.end('Use exactly one ?user=<login> and at most one &mod=0|1.'); return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) { res.writeHead(413); res.end(); req.destroy(); }
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    // JSON.stringify escapes the message, so whatever the viewer typed stays inside "text".
    const frame = JSON.stringify({ username: users[0], text: body, isMod: /^(1|true|yes)$/i.test(mods[0] || '') });
    res.writeHead(toGame(frame) ? 204 : 503);
    res.end();
  });
});

const wss = new WebSocketServer({
  server,
  maxPayload: 65536,
  verifyClient: (info) => {
    const url = requestUrl(info.req);
    const why = !url ? 'garbled request' : !originOk(info.origin) ? 'web page from another site'
      : !tokenOk(info.req, url) ? 'missing or wrong token' : '';
    if (why) console.log('Refused a connection (' + why + ').');
    return !why;
  }
});

wss.on('error', (e) => console.log('Relay error: ' + e.message));

wss.on('connection', (socket, req) => {
  const browser = req.headers.origin !== undefined;   // the game is a web page; bots send no Origin
  let first = true;
  // A frame over maxPayload or with broken UTF-8 raises 'error' on the socket. Without this listener
  // that would stop the relay; with it, ws just closes that one connection (code 1009 / 1007).
  socket.on('error', (e) => console.log('Client error: ' + e.message));
  socket.on('message', (data) => {
    const text = data.toString();
    let f = null;
    try { f = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (first && browser && f && f.type === 'hello' && f.app === 'spirit-derby') {
      if (gameLive()) {                              // never let a second "game" take over
        console.log('Refused a second game connection (one game at a time).');
        socket.close(1008, 'Another game is already connected');
        return;
      }
      game = socket;
    }
    first = false;
    if (socket === game) {
      for (const c of wss.clients) if (c !== game && c.readyState === 1) c.send(text);   // game -> bots
      // Only frames from the game may be posted in chat. Replace this line with your bot's chat call.
      if (f && (f.type === 'reply' || f.type === 'race')) console.log('[for chat]', f.chat || f.message);
    } else {
      toGame(text);                              // bot -> game only
    }
  });
  socket.on('close', () => { if (socket === game) game = null; });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Spirit Derby relay is running. Keep the token private (it is in relay-token.txt).');
  console.log('  Game bridge URL: ws://localhost:' + PORT + '/?token=' + encodeURIComponent(TOKEN));
  console.log('  Bot POST URL:    http://localhost:' + PORT + '/chat?user=<login>&mod=0|1&token=' + encodeURIComponent(TOKEN));
});
```

Test it without a bot. With the relay running and the game's bridge showing **ON**, run (replace
`YOUR-TOKEN` with the relay's token):

```powershell
Invoke-RestMethod -Method Post -Uri 'http://localhost:8765/chat?user=test_viewer&mod=0&token=YOUR-TOKEN' -ContentType 'text/plain; charset=utf-8' -Body '!join'
```

`test_viewer` joins in the game's chat feed (a real profile in this save: remove it afterwards with
**🛡 Runners & viewers → REMOVE VIEWER**), and the relay prints the reply under `[for chat]`. A `503`
answer means the game is not connected to the relay; `403` means the token is missing or wrong. You
can also test with no relay at all from the browser console:
`SD.integrations.bridge.receive('{"username":"test_viewer","text":"!join"}')`.

---

## 7. OBS Browser Source

1. **Sources → + → Browser.**
2. Untick **Local file** and enter the URL:
   `file:///E:/Github/Spirit%20Derby/index.html?overlay=1`
   Adjust the path to where the game lives; spaces become `%20`. Add `&twitch=yourchannel` to have
   this source read your chat (see the storage note below).
3. **Width 1920, Height 1080.**
4. **Shutdown source when not visible: OFF.** If it is on, switching scenes reloads the page: a
   running race is cancelled (bets refunded) and the chat connection drops.
5. **Refresh browser when scene becomes active: OFF**, for the same reason.
6. Leave the default Custom CSS as it is. The game draws its own forest background.
7. To control the overlay, right-click the source and choose **Interact**. Press **O** to leave
   overlay mode, **`** for Streamer Controls, **Space** to pause or resume, then **O** again.

## 8. Two instances (control window + overlay) and localStorage

The game saves to the browser's `localStorage` under `spiritderby.save`. Two open copies of the game
do **not** share a live game, and since review batch 6 only **one of them saves**:

- **Two tabs or windows in the same browser** share the same storage. The first one open is the
  *saving window*: it keeps a small `spiritderby.lock` entry fresh (every 10 s). A copy opened while
  that window is alive starts **read-only**: a banner says so, it never writes the save (not even on
  its 30 s clock), never auto-connects to Twitch or the bridge, and leaves a race it sees running
  alone (it does not cancel it or refund its bets). Changes made in a read-only window are not kept.
  When the saving window closes, the read-only one takes over by itself about 8 s later
  (`CONFIG.LOCK.RELEASE_GRACE_MS`) and reloads the latest save. Reloading the saving window (F5, or
  OBS refreshing its source) is not a close: the reloaded page claims the role back within that
  time, so it stays the saving window and reconnects to chat, and the read-only one stays read-only.
  **TAKE OVER** in the banner makes a read-only window the saving window at once (use it when the other window crashed or is on
  another screen you cannot reach). The window that loses the saving role that way stops saving,
  disconnects from chat and shows the banner too. A window that crashed stops counting after 90 s
  (`CONFIG.LOCK.STALE_MS`), so a copy opened later saves normally.
- **OBS and your normal browser** have separate storage. OBS's built-in browser has its own
  profile, so they do not even see each other's saves (and each one is its own saving window). To
  move a game between them, use **Streamer Controls → Save → EXPORT JSON / IMPORT JSON**. The import
  keeps the receiving side's own Twitch and bridge settings, so set up the connection once in each
  place. After moving a game this way, **play on in the copy you imported into only**: close the old
  copy, or leave it alone. The two copies would otherwise race on from the same saved game with
  different results, each in its own storage. (Every load and import draws new race seeds, so an
  older copy never replays races chat already watched; an export also leaves the secret seed salt
  out, so it is safe to share in a bug report.)

Recommended setups:

- **One instance (simplest):** the OBS source is the game
  (`…/index.html?overlay=1&twitch=yourchannel`). Drive it through **Interact**.
- **Browser window + Window Capture:** run the game in a normal browser window, connect chat there,
  press **O** for the overlay layout while live, and capture the window in OBS. Only close Streamer
  Controls before you go live. A race keeps its normal pace when the window is minimised or covered
  (the browser then wakes the page only once a second, or once a minute after five minutes, and the
  race catches up at each wake-up), so results, payouts and training are never held up.

**Before going live in a window you tested in:** the demo bots of the Chat tab play in the same game
under their own `~` profiles (`~foxfan` …, which no Twitch login can be, so a viewer called foxfan
never gets a bot's SP or runner). They stop by themselves when Twitch chat or the bridge connects,
on overlay mode, RESET ALL and IMPORT (and cannot be switched on while chat is connected), and when
they stop their profiles and the runners they made leave the game. Test profiles you made yourself
(`@test_viewer: !join`, the relay test below) stay: remove them with **🛡 Runners & viewers → REMOVE
VIEWER**, or start clean with **RESET ALL** (the old game is kept as the backup). Saves from v1.0.0
may still hold the old bots as plain viewers (`foxfan`, `mothmom` …): remove them the same way.
- Opening a second copy in the same browser just to look at something is safe now: it opens
  read-only and saves nothing. Adding `?connect=0` is no longer needed for that (a read-only window
  never connects on its own), but it still keeps a window you *take over* in off chat.

If the stored save cannot be loaded (it comes from a newer version of Spirit Derby, or it is
damaged), the game starts a fresh game **without overwriting it**: a banner offers **DOWNLOAD SAVED
GAME** (open it in the newer version with IMPORT JSON) and **START NEW GAME**, which first copies the
old save to `spiritderby.rescue` (Save → **⬇ RESCUE COPY** downloads it later, and **✕ DELETE
RESCUE COPY** frees the space once you have it: the copy shares the browser's storage quota with the
save and its backup). Nothing is saved until you choose.

IMPORT JSON checks the file in depth. Anything malformed (a race record the game cannot use, bad
runner ids or best times) is repaired or dropped, a race saved as finished is applied right away (or
cancelled and its bets refunded when it is broken), and IMPORT clears the old game's chat cooldowns,
rest cooldowns and cheer counts. If the page still fails to start, it shows the error with
**DOWNLOAD SAVED GAME**, **RESTORE BACKUP** and **START NEW GAME** buttons (see section 10).

## 9. Commands, sources and permissions

Sources: `twitch` (read-only chat), `bridge` (relay), `sim` (Chat tab / demo bots) and `admin`
(the Streamer sender and SEND AS). **Admin** skips cooldowns and may train any runner even with
open training off. Mod status comes from Twitch badges and tags, or from the bridge's `isMod`.

The **Streamer** sender (Chat tab and SEND AS) is the streamer's console, not a viewer. It acts as
the reserved name `#streamer`, which no Twitch login can be, so it never shares a profile with a
viewer called `streamer`. It can run every mod and read-only command (`!race`, `!event`, `!odds`,
`!help` …) but never plays: `!join` and player commands reply that the console doesn't play, and
it never earns SP, hype credit or achievements. The roster TRAIN / REST buttons and **ADD HYPE**
act as the console too: they move runners and the hype meter without crediting anyone. To act for
a viewer, pick them in SEND AS (listed by display name, sent by login) or type `@login: !command`
in the Chat tab. A `#streamer` name arriving from Twitch, the bridge or the demo chat is ignored,
and so is a demo-bot name (`~foxfan` …) arriving from Twitch or the bridge.

**Moderation:** a viewer-made runner with a name that should not be on stream can be renamed,
retired or deleted, and a viewer removed, in Streamer Controls → **🛡 Runners & viewers** (not while a
race runs). Bets and paid boosts / sabotages on a retired or deleted runner are refunded, and the old
name is replaced in the log and in season summaries (the one of the season in progress included),
so the bridge's race frames and replies stop using it.

| Command | Aliases | Needs | Locked during a race | Cooldown | What it does |
|---|---|---|---|---|---|
| `!join` | — | — | no | none | Join the derby (+200 SP the first time; +50 SP daily bonus on your first action each day) |
| `!claim [runner]` | — | `!join` | yes | 10 s | Claim a free runner (named, or the first free one). One runner per viewer; re-claiming releases the old one |
| `!create <name>` | — | `!join`, no runner | yes | 10 s | When every runner has an owner (and the streamer allows it): create your own runner (random species, style and ability; stats sum to 200). Names 3–20 letters, digits, spaces or apostrophes, with a letter; unique, no lookalike of another name, no command words (`all`, `max`, `cancel`, numbers, stat names), not a shortening of another runner |
| `!train <stat>` / `!train <runner> <stat>` | `!t` | `!join` | yes | 10 s | Train your runner (or any runner while *open training* is on). Stats: speed, stamina, power, wisdom, luck (short forms such as `spd`, `sta`, `pow`, `wis`, `luk` work) |
| `!rest [runner]` | `!r` | `!join` | yes | 10 s + 3 min per runner | Energy +30, fatigue down, hype −5 (less when the meter is under 5; the reply says the real change) |
| `!cheer [runner]` | `!c` | `!join` | **no** | 30 s | Hype +3 and +2 SP; a named runner gets a tiny pre-race boost (a cheer during a race never makes you its backer) |
| `!status` | `!stats` | `!join` | no | none | Your SP, rank and runner at a glance |
| `!inspect <runner>` | `!i` | — | no | none | Full runner card: style, ability, owner, stats, condition, mood, record, odds |
| `!race` | — | — | no | none | Viewers: what is happening on the track, the next field, favourite and open bets. **Mods / streamer:** starts the race (`!race 2000` or `!race 2000m` picks the distance, `!race status` or `!race next?` only looks; any other argument, e.g. `!race soon` or `!race 1500`, is refused with the usage and starts nothing) |
| `!event` | — | — | mods: yes (looking with `!event today` still works) | none | Viewers: today's day event. **Mods / streamer:** `!event` rolls a new random day event, `!event <name>` sets one (`!event harvest`), `!event today` only looks |
| `!leaderboard [board] [all]` | `!lb`, `!top` | — | no | none | Top 3 on a board: `wins`, `xp`, `sp`, `part`, `victories`, `hype`; add `all` for all-time |
| `!rank [viewer]` | — | `!join` (for yourself) | no | none | Your rank on the SP, victories and hype boards |
| `!help [command]` | `!h`, `!commands` | — | no | none | Command list, or help for one command |
| `!bet <runner> <amount>` | — | `!join` | yes | 10 s | Bet 10–250 fictional SP on a runner in the next race (`!bet 50 moss`, `!bet moss all`, `!bet cancel`). Quoted the odds shown when you bet; when the gates open it is settled at the shorter of that quote and the race's own odds (the game logs and shows whose odds shortened; a bet on a runner that became odds-on, under 1.1×, is refunded). Pays amount × those odds. No bets on an odds-on runner. One bet each; a new bet refunds the old one. `!bet` alone only looks (no cooldown) |
| `!bets` | — | — | no | none | Open bets on the next race (count, total, per runner, yours) |
| `!odds` | — | — | no | none | Odds for every runner in the next race (or the running race) |
| `!boost <runner>` | — | `!join` | yes | 10 s | 40 SP: a +2.5% burst at a random moment of that runner's next race (max 3 per runner per race; your own runner is fine) |
| `!snack <runner>` | — | `!join` | yes | 10 s | 25 SP: +10 energy (max 2 snacks per runner per day; refused, free, when the runner is less than 1 energy from full) |
| `!sabotage <runner>` | — | `!join` | yes | **10 min** | 60 SP: a pebble in a rival's shoe for its next race (slower for a stretch); wise runners may kick it back at you. Not your own runner; max 2 per target and 4 per race (pebbles on the next race's runners; a pebble on a runner outside it waits for that runner's next race); announced publicly |
| `!ribbon <colour>` | — | a runner | yes | 10 s | 100 SP: a coloured ribbon ring on your runner (named colours or `#hex`; `!ribbon off` is free) |
| `!hype` | — | — | no | none | The hype meter and the next threshold |
| `!achievements [viewer]` | `!ach`, `!badges` | `!join` (for yourself) | no | none | Achievements unlocked (count / total and the latest 3) |

- The 10 s cooldown is per viewer and per command, and can be changed under **Tuning → User
  cooldown**. Read-only commands have no cooldown but count toward activity at most once every 10 s.
  If a command fails with an internal error ("Something went wrong … The streamer can check the
  log"), that viewer must wait at least 30 s (`CONFIG.COOLDOWNS.ERROR_S`) before that command runs
  again, so one bug can't flood the log, the overlay or your bot.
- The game answers commands meant for other bots with `Unknown command` in the feed, but these
  replies are not toasted on the overlay and not sent to the bridge.
- Spirit Points are fictional: they cannot be bought, sold or cashed out. `!bet`, `!boost`, `!snack`,
  `!sabotage` and `!ribbon` only move SP inside the game.
- Achievements a viewer unlocks with their own command are appended to that command's reply, so
  they also reach Twitch through the bridge.
- `!create <name>` only works once every runner has an owner and **Allow !create** is ticked (admin Tuning); the paddock holds at most 24 runners (`CONFIG.RUNNERS.MAX_ACTIVE`).

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Twitch pill stuck on `CONNECTING…` or `ERROR` | Check the channel is the **login name** (the part after `twitch.tv/`). Check that your internet, firewall or antivirus allows `wss://irc-ws.chat.twitch.tv` on port 443. Hover the header dot for the reason. |
| `Twitch chat stopped: This channel does not exist or has been suspended.` | Wrong channel name. Fix it and press CONNECT; this error does not retry by itself. |
| Connects, then drops again after reloading many times | Twitch limits how often one IP can log in and join channels, including anonymous `justinfan` guests. Stop reloading; the adapter backs off (up to once a minute) and gets back in. Keep one connected instance per PC. |
| Lines arrive, but some raid messages are missing | That is the flood guard (20 commands and 20 plain chat lines per second, counted separately). The admin section shows the dropped count and how many of them were commands. |
| Bridge shows `N malformed (last: …)` and commands from the bot do nothing | The bot's frames are refused; the reason is after `last:`. `duplicate key`, `unknown key` or `conflicting …` means the bot builds its JSON from a text template, which is unsafe (section 6): switch to the relay's `POST /chat` endpoint or a JSON serializer. `invalid "isMod" value` means `isMod` is not `true` / `false`. `not valid JSON` often means a viewer typed a `"` or `\` into a templated frame. |
| Viewers say the game ignores them | Are they typing in **your** channel? Are they on cooldown? Is a race running (training is locked until the results)? The Chat tab shows every reply. |
| Nobody sees the replies on stream | Replies are toasts, and they only show in **overlay mode** (`?overlay=1` or **O**). To reply in Twitch chat, use the bridge (sections 5 and 6). |
| Bridge pill shows `ERROR · No bridge is answering at ws://localhost:8765` | The relay isn't running, or it uses another port. Start it; the game retries by itself. If the relay **is** running, look at its window: `Refused a connection (missing or wrong token)` means the bridge URL needs `?token=<the relay's token>` (the game shows it as `?token=…`); `(web page from another site)` means the game is not opened from disk or `localhost` (see the hosting row below). The browser console prints one `WebSocket connection … failed` line per attempt; that is the browser, not the game, and the backoff limits it to about once a minute. If `localhost` fails, try `ws://127.0.0.1:8765`. |
| Every command happens twice | Two instances are connected, or chat arrives through both Twitch and the bridge. See sections 6 and 8. |
| A **Read-only window** banner | Another window of the game in this browser is saving it. Close this one, or press **TAKE OVER** if the other one is gone. See section 8. |
| **⚠ NOT SAVED** in the header | The browser refused the last save (storage full or blocked). It retries by itself; meanwhile use **EXPORT JSON** so nothing is lost. |
| **Spirit Derby could not start.** with an error box | Something in the stored game stops the page from starting (for example a hand-edited file you imported). Press **⬇ DOWNLOAD SAVED GAME** first, then **RESTORE BACKUP** (the game before your last import or upgrade) or **START NEW GAME** (click twice to confirm). Both keep the failing save in `spiritderby.rescue` (replacing an older rescue copy: **⬇ DOWNLOAD RESCUE COPY** on that screen downloads it first) and reload the page, so you never need to clear `localStorage` by hand. The one exception: if the backup you just restored there fails too, the backup keeps it, and START NEW GAME leaves the rescue copy (your newest game) alone. |
| Bridge refuses to connect when the game is hosted on a website, or opened through a LAN address | The example relay only accepts the game from disk (`file://`) or from `http://localhost` / `127.0.0.1` (`node tools/serve.js`); any other page is refused (the browser sees HTTP `401`, and the relay prints `Refused a connection (web page from another site)`), TLS or not. Run the game from disk or localhost (`node tools/serve.js` serves it to this PC only; its `--lan` option opens it to your network, but the relay still refuses those pages). If you really host it elsewhere, add that exact origin (for example `https://derby.example.com`) to `originOk` in `relay.js` and keep the token. A page on `https://` must also use `wss://` for any host other than `localhost` (mixed content), so the relay then needs TLS as well. |
| Bridge keeps flipping between ON and `RECONNECTING…` (header tooltip: `The bridge connection closed (code 1008).`) | The example relay already has a game connected (another tab, window or OBS source) and allows one game at a time. Close the other copy's bridge (or use `?connect=0` there, section 8). |
| Auto-connect stopped working | **RESET ALL** replaces the settings, including the auto-connect boxes. Tick them again. (**IMPORT JSON** keeps this PC's Twitch channel, bridge URL and auto-connect boxes.) |

Browser console helpers:

```js
SD.integrations.twitch.status()        // { state, channel, messages, dropped, lastError, nextRetryAt, … }
SD.integrations.twitch.recentLines()   // last 30 status lines from Twitch (NOTICE, ROOMSTATE, CAP, …)
SD.integrations.bridge.status()        // { state, url, messages, malformed, lastBad, sent, lastError, … }
SD.integrations.bridge.receive('{"username":"test_viewer","text":"!join"}')
```

## 11. What is stored

| Where | What |
|---|---|
| `settings.twitch = { channel, enabled }` | the last channel you connected to and **Auto-connect on load** |
| `settings.bridge = { url, enabled }` | the relay URL and **Auto-connect on load** |
| `SD.state.runtime.connected = { twitch, bridge }` | live connection state (not saved) |

The settings are saved with the game (`spiritderby.save`) and included in EXPORT JSON, but **IMPORT
JSON never applies them**: an imported save keeps this PC's Twitch channel, bridge URL and
auto-connect boxes (a shared save could otherwise make your game connect to someone else's relay),
and the import message says so when the file's values differed. The game **never stores or asks
for a Twitch token or password**; the only secret it may hold is a relay token you put in the bridge
URL yourself. That token is saved with the game on this PC, but it is shown as `?token=…` in the chat
feed, toasts, the admin status line and the header tooltip, and EXPORT JSON writes it as
`?token=…` too. The **bridge URL box** in Streamer Controls shows it as typed, so close the controls
(or keep that window off stream) while you are live.
