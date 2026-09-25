# Spirit Derby

A Twitch-chat-driven forest spirit racing and management game. Open `index.html` (no build step, no server needed), or run `node tools/serve.js`. Headless tests: `node tools/run-tests.js`.

## Commands

Chat commands work the same whether they come from the simulated chat in the sidebar, the streamer's **SEND AS** box in the admin drawer (⚙ or backtick), or (later) Twitch. Spirit Points (SP) are fictional and have no real-world value.

| Command | Aliases | What it does |
|---|---|---|
| `!join` | | Join the Spirit Derby. +200 SP the first time; +50 SP for your first action each in-game day. |
| `!claim [runner]` | | Claim a free runner (named, or the first free one). One runner per viewer: claiming another releases your old one. |
| `!train <stat>` / `!train <runner> <stat>` | `!t` | Train your runner (or any runner by name while *open training* is on). Stats: `speed`, `stamina`, `power`, `wisdom`, `luck` (short forms like `spd`, `sta`, `pow`, `wis`, `luk` work). Costs 12 energy; +5 SP (+15 on a critical session), hype +1. |
| `!rest [runner]` | `!r` | Energy +30 and less fatigue (hype −5). Each runner can rest once every 3 minutes. |
| `!cheer [runner]` | `!c` | Hype +3 and +2 SP. Cheering a named runner before a race gives it a tiny boost, and 10 cheers calm a Nervous runner. Works during races too. |
| `!status` | `!stats` | Your SP and your runner's level, stats, energy, condition, mood and record. |
| `!inspect [runner]` | `!i` | A runner's full card: style, ability, owner, stats, condition, mood, record and odds for the next race. |
| `!race` | | What is happening on the track, the next field and the favourite. |
| `!event` | | Today's day event and what it changes. |
| `!help [command]` | `!h`, `!commands` | The command list, or details for one command (`!help train`). |

Rules worth knowing:

- Training, resting and claiming are locked while a race is running (countdown, running or paused). `!cheer`, `!status`, `!inspect`, `!race`, `!event` and `!help` always work.
- Each viewer has a per-command cooldown (default 10 s, *User cooldown* in the admin Tuning section; `!cheer` 30 s). The streamer's own console (the **Streamer** sender and SEND AS) is not cooldown-limited.
- Runner names are case-insensitive and can be shortened: `moss`, `Moss Runner`, `mossrunner` and `@MossRunner` all work. An ambiguous name gets a "Did you mean…?" reply.
- Race payouts: the owner of each runner earns SP by finishing place (50 / 35 / 25 / 15 …). Viewers who mostly trained, rested or cheered a runner they don't own (its *backers*) earn half of that.

Simulated chat: type in the Chat tab; start a line with `@Name:` to speak as that viewer (for example `@FoxFan: !train speed`), or pick a sender from the list. The **🤖 Demo bots** toggle lets six fictional viewers join, claim, train and cheer every few seconds so you can test hype and races alone. In overlay mode (`?overlay=1` or key `O`) command replies appear as toasts under the track.
