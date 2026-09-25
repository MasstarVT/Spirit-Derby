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
   not your display name. `#fox`, `@fox` and `https://twitch.tv/fox` all work. Press **CONNECT**.
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
  viewer with a localized display name still keeps a single profile.
- **Flood guard:** at most 20 chat lines per second reach the game. During a raid the rest are
  dropped and counted, and the admin section shows `N dropped (flood guard)`. This keeps the page responsive.
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
under **Chat bridge**, press **CONNECT**, and tick **Auto-connect on load** if you want that.

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

- `username` and `text` are required. `displayName` and `isMod` are optional. Aliases are accepted:
  `user` / `userName` for `username`, `message` for `text`, and `isBroadcaster` or `mod` for `isMod`
  (`true`, `1`, `"1"`, `"true"` and `"yes"` all count).
- `{ "type": "ping" }` is answered with `{ "type": "pong", "ts": … }`. Frames with any other `type`
  are ignored.
- Malformed JSON and messages without `username` or `text` are counted as malformed and skipped;
  they never crash the game. The same 20-messages-per-second flood guard applies.
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
  (on cooldown) or `locked: true` (a race is running), so your bot can skip them if it likes.
- Replies to **unknown** commands (such as `!discord`, meant for another bot) are **not** sent by
  default. For debugging you can enable them from the browser console with
  `SD.integrations.bridge.configure({ replyUnknown: true })`.
- Replies to commands typed in the simulated chat or SEND AS are never sent.

When a race finishes:

```json
{ "type": "race", "winner": "Velvet Comet",
  "results": [ { "place": 1, "name": "Velvet Comet", "owner": "FoxFan", "runnerId": "r003", "timeSec": 71.42 },
               { "place": 2, "name": "Moss Runner", "owner": null, "runnerId": "r001", "timeSec": 71.9 } ],
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

Mix It Up (MIU) can run an action whenever a chat message or command arrives. What you need is an
action that passes `{ "username", "text", "isMod" }` to the relay:

- if your MIU version has an action that **sends a WebSocket message**, point it at the relay; or
- use its **Web Request** action to `POST` the JSON to the relay's HTTP endpoint (the example relay
  below accepts `POST http://localhost:8765/chat`); or
- use its **External Program** action to run a small script that does the same.

Map MIU's user name, message text and mod/role special identifiers into the JSON fields. **Check the
Mix It Up documentation for the exact action names and special identifiers in your version.**
These change between releases, and this guide does not assume them. To post the game's replies,
have the relay forward the `chat` field of `reply`/`race` frames to something that can speak in
chat, for example MIU's local developer API if you have it enabled (see the MIU docs for its chat
endpoint).

### Streamer.bot

Streamer.bot can act as a WebSocket client or run C# actions. Connect it to the relay, send the
JSON above on chat messages, and post `chat` from incoming `reply` frames. Check the Streamer.bot
docs for the exact triggers and sub-actions.

### Optional: a minimal relay using the `ws` package

> **Optional, not part of the game.** Spirit Derby has no dependencies. Use this script only if you
> want a relay and do not have one. It needs [Node.js](https://nodejs.org) and the `ws` package,
> which you install yourself in a separate folder: `npm install ws`.

```js
// relay.js: a Spirit Derby chat relay (optional helper).  Run: node relay.js
// The game connects to ws://localhost:8765. Bots connect to the same URL, or POST JSON to
// http://localhost:8765/chat. Every frame is passed on to every other connected client.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 8765;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
    req.on('end', () => { broadcast(body, null); res.writeHead(204); res.end(); });
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server });

function broadcast(text, from) {
  for (const client of wss.clients) if (client !== from && client.readyState === 1) client.send(text);
}

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    const text = data.toString();
    broadcast(text, socket);                    // game <-> bots
    try {
      const f = JSON.parse(text);
      if (f.type === 'reply' || f.type === 'race') console.log('[for chat]', f.chat || f.message);
    } catch (e) { /* not JSON: ignore */ }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log('Spirit Derby relay on ws://localhost:' + PORT));
```

Test it without a bot. With the relay running and the game's bridge showing **ON**, run:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8765/chat -ContentType 'application/json' -Body '{"username":"FoxFan","text":"!join"}'
```

FoxFan joins in the game's chat feed, and the relay prints the reply under `[for chat]`.
You can also test with no relay at all from the browser console:
`SD.integrations.bridge.receive('{"username":"FoxFan","text":"!join"}')`.

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
do **not** share a live game:

- **Two tabs or windows in the same browser** share the same storage but each runs its own
  simulation. Whichever saves last overwrites the other. If both are connected to chat, every
  command runs twice.
- **OBS and your normal browser** have separate storage. OBS's built-in browser has its own
  profile, so they do not even see each other's saves. To move a game between them, use
  **Streamer Controls → Save → EXPORT JSON / IMPORT JSON**.

Recommended setups:

- **One instance (simplest):** the OBS source is the game
  (`…/index.html?overlay=1&twitch=yourchannel`). Drive it through **Interact**.
- **Browser window + Window Capture:** run the game in a normal browser window, connect chat there,
  press **O** for the overlay layout while live, and capture the window in OBS. Only close Streamer
  Controls before you go live.
- If you open a second copy just to look at something, add `?connect=0` so it does not connect to
  chat, and avoid changing the game in it.

## 9. Commands, sources and permissions

Sources: `twitch` (read-only chat), `bridge` (relay), `sim` (Chat tab / demo bots) and `admin`
(the Streamer sender and SEND AS). **Admin** skips cooldowns and may train any runner even with
open training off. Mod status comes from Twitch badges and tags, or from the bridge's `isMod`.

| Command | Aliases | Needs | Locked during a race | Cooldown | What it does |
|---|---|---|---|---|---|
| `!join` | — | — | no | none | Join the derby (+200 SP the first time; +50 SP daily bonus on your first action each day) |
| `!claim [runner]` | — | `!join` | yes | 10 s | Claim a free runner (named, or the first free one). One runner per viewer; re-claiming releases the old one |
| `!create <name>` | — | `!join`, no runner | yes | 10 s | When every runner has an owner (and the streamer allows it): create your own runner (random species, style and ability; stats sum to 200). Names 3–20 letters, digits, spaces or apostrophes, unique |
| `!train <stat>` / `!train <runner> <stat>` | `!t` | `!join` | yes | 10 s | Train your runner (or any runner while *open training* is on). Stats: speed, stamina, power, wisdom, luck (short forms such as `spd`, `sta`, `pow`, `wis`, `luk` work) |
| `!rest [runner]` | `!r` | `!join` | yes | 10 s + 3 min per runner | Energy +30, fatigue down, hype −5 |
| `!cheer [runner]` | `!c` | `!join` | **no** | 30 s | Hype +3 and +2 SP; a named runner gets a tiny pre-race boost |
| `!status` | `!stats` | `!join` | no | none | Your SP, rank and runner at a glance |
| `!inspect <runner>` | `!i` | — | no | none | Full runner card: style, ability, owner, stats, condition, mood, record, odds |
| `!race` | — | — | no | none | Viewers: what is happening on the track, the next field, favourite and open bets. **Mods / streamer:** starts the race (`!race 2000` picks the distance, `!race status` only looks) |
| `!event` | — | — | no | none | Viewers: today's day event. **Mods / streamer:** `!event` rolls a new random day event, `!event <name>` sets one (`!event harvest`), `!event today` only looks |
| `!leaderboard [board] [all]` | `!lb`, `!top` | — | no | none | Top 3 on a board: `wins`, `xp`, `sp`, `part`, `victories`, `hype`; add `all` for all-time |
| `!rank [viewer]` | — | `!join` (for yourself) | no | none | Your rank on the SP, victories and hype boards |
| `!help [command]` | `!h`, `!commands` | — | no | none | Command list, or help for one command |
| `!bet <runner> <amount>` | — | `!join` | yes | 10 s | Bet 10–250 fictional SP on a runner in the next race (`!bet 50 moss`, `!bet moss all`, `!bet cancel`). Pays amount × the odds locked when you bet. One bet each; a new bet refunds the old one |
| `!bets` | — | — | no | none | Open bets on the next race (count, total, per runner, yours) |
| `!odds` | — | — | no | none | Odds for every runner in the next race (or the running race) |
| `!boost <runner>` | — | `!join` | yes | 10 s | 40 SP: a +2.5% burst at a random moment of that runner's next race (max 3 per runner per race; your own runner is fine) |
| `!snack <runner>` | — | `!join` | yes | 10 s | 25 SP: +10 energy (max 2 snacks per runner per day) |
| `!sabotage <runner>` | — | `!join` | yes | **10 min** | 60 SP: a pebble in a rival's shoe for its next race (slower for a stretch); wise runners may kick it back at you. Not your own runner; max 2 per target and 4 per race; announced publicly |
| `!ribbon <colour>` | — | a runner | yes | 10 s | 100 SP: a coloured ribbon ring on your runner (named colours or `#hex`; `!ribbon off` is free) |
| `!hype` | — | — | no | none | The hype meter and the next threshold |
| `!achievements [viewer]` | `!ach`, `!badges` | `!join` (for yourself) | no | none | Achievements unlocked (count / total and the latest 3) |

- The 10 s cooldown is per viewer and per command, and can be changed under **Tuning → User
  cooldown**. Read-only commands have no cooldown but count toward activity at most once every 10 s.
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
| Lines arrive, but some raid messages are missing | That is the flood guard (20 lines per second). The admin section shows the dropped count. |
| Viewers say the game ignores them | Are they typing in **your** channel? Are they on cooldown? Is a race running (training is locked until the results)? The Chat tab shows every reply. |
| Nobody sees the replies on stream | Replies are toasts, and they only show in **overlay mode** (`?overlay=1` or **O**). To reply in Twitch chat, use the bridge (sections 5 and 6). |
| Bridge pill shows `ERROR · No bridge is answering at ws://localhost:8765` | The relay isn't running, or it uses another port. Start it; the game retries by itself. The browser console prints one `WebSocket connection … failed` line per attempt; that is the browser, not the game, and the backoff limits it to about once a minute. If `localhost` fails, try `ws://127.0.0.1:8765`. |
| Every command happens twice | Two instances are connected, or chat arrives through both Twitch and the bridge. See sections 6 and 8. |
| Bridge refuses to connect when the game is hosted on a website | Mixed content. Opening `index.html` from disk (`file://`) can open both `wss://` (Twitch) and `ws://localhost` (the bridge), and so can a page on `http://localhost` (`node tools/serve.js`). A page on `https://` must use `wss://` for any other host. Browsers usually still allow `ws://localhost` / `ws://127.0.0.1`, but not all do, so run the game from disk or localhost, or give the relay TLS. |
| Auto-connect stopped working | **RESET ALL** and **IMPORT JSON** replace the settings, including the auto-connect boxes. Tick them again. |

Browser console helpers:

```js
SD.integrations.twitch.status()        // { state, channel, messages, dropped, lastError, nextRetryAt, … }
SD.integrations.twitch.recentLines()   // last 30 status lines from Twitch (NOTICE, ROOMSTATE, CAP, …)
SD.integrations.bridge.status()        // { state, url, messages, malformed, sent, lastError, … }
SD.integrations.bridge.receive('{"username":"FoxFan","text":"!join"}')
```

## 11. What is stored

| Where | What |
|---|---|
| `settings.twitch = { channel, enabled }` | the last channel you connected to and **Auto-connect on load** |
| `settings.bridge = { url, enabled }` | the relay URL and **Auto-connect on load** |
| `SD.state.runtime.connected = { twitch, bridge }` | live connection state (not saved) |

The settings are saved with the game (`spiritderby.save`) and included in EXPORT JSON. The game
**never stores or asks for a token or password**.
