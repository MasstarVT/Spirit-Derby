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
| `!status` | `!stats` | Your SP (and your rank on the SP board) and your runner's level, stats, energy, condition, mood and record. |
| `!inspect [runner]` | `!i` | A runner's full card: style, ability, owner, stats, condition, mood, record and odds for the next race. |
| `!race` | | What is happening on the track, the next field and the favourite. |
| `!event` | | Today's day event and what it changes. |
| `!leaderboard [board] [all]` | `!lb`, `!top` | The top 3 on a board. Boards: `wins` (runner wins), `xp` (runner XP), `sp` (Spirit Points, the default), `part` (participation), `victories` (races won by the runner you own or back) and `hype` (hype you added). Add `all` for all-time totals: `!lb wins all`. |
| `!rank [viewer]` | | Your rank on the SP, victories and hype boards in one line (or another viewer's: `!rank FoxFan`). |
| `!help [command]` | `!h`, `!commands` | The command list, or details for one command (`!help train`). |

Rules worth knowing:

- Training, resting and claiming are locked while a race is running (countdown, running or paused). `!cheer`, `!status`, `!inspect`, `!race`, `!event`, `!leaderboard`, `!rank` and `!help` always work.
- Each viewer has a per-command cooldown (default 10 s, *User cooldown* in the admin Tuning section; `!cheer` 30 s). The streamer's own console (the **Streamer** sender and SEND AS) is not cooldown-limited.
- Runner names are case-insensitive and can be shortened: `moss`, `Moss Runner`, `mossrunner` and `@MossRunner` all work. An ambiguous name gets a "Did you mean…?" reply.
- Read-only commands (`!status`, `!lb`, `!rank`, `!help` …) have no cooldown, but they add to your participation score at most once every 10 s, so spamming them cannot top the participation board.
- Race payouts: the owner of each runner earns SP by finishing place (50 / 35 / 25 / 15 …). Viewers who mostly trained, rested or cheered a runner they don't own (its *backers*) earn half of that.

Simulated chat: type in the Chat tab; start a line with `@Name:` to speak as that viewer (for example `@FoxFan: !train speed`), or pick a sender from the list. The **🤖 Demo bots** toggle lets six fictional viewers join, claim, train and cheer every few seconds so you can test hype and races alone. In overlay mode (`?overlay=1` or key `O`) command replies appear as toasts under the track.

## Progression

Runners earn XP from every race by finishing place (1st 100, 2nd 70, 3rd 50, 4th 35, then 25 / 20 / 15 / 12), plus 20 for taking part, times a distance bonus (1200 m ×1, 1600 m ×1.1, 2000 m ×1.2, 2400 m ×1.3) and ×1.25 for runners below the roster's average level. Training adds a little too (+3 XP, +8 on a critical session). Level *L* needs 60 + 20 × (*L* − 1) XP to reach the next one (60, 80, 100 …), up to level 20. Each level raises every stat by 1, the stat cap by 4 (60 + 4 × level), max energy by 2 and training gains, strengthens the runner's ability, and gives the crowd +8 hype. A gold ring flashes on the runner's card and a toast announces it. At the end of a season runners return to level 1 (keeping 10% of the stats they gained).

## Leaderboards

The **Boards** tab in the sidebar shows six independent boards (runner wins, runner XP, Spirit Points, participation, race victories, hype) with a Season / All-time toggle; chat reaches the same numbers with `!lb` and `!rank`. Participation counts commands + trains × 2 + cheers + rests + bets and never SP, so no single stat decides every board. Ties share a rank. The paddock shows the season's leading runner ("👑 Leader: …") once someone has won a race.

## Balance & tuning

Races are simulated up front from one seed (the same inputs always give the same race), then played back. What decides a race, roughly in order:

- **Stats** (`SD.CONFIG.RACE.WEIGHTS`, `PERF_SLOPE` 0.5): each phase weighs the five stats differently; 10 points of phase-weighted stats = 5% speed. A +20 Speed runner wins about a third of races against seven equal rivals, +8 in every stat (a level-5-ish runner) about 37%. Stamina also sets the stamina pool (`STAMINA`), which only bites in long races: at 2400 m low-Stamina runners fade and can hit the wall.
- **Luck of the day**: every runner rolls a hidden per-race form (`FORM.AMP`, about ±3%) plus in-race swings that last several seconds (`NOISE`); Wisdom calms both. The best-form runner still only wins ~40% of races between identical clones.
- **Condition** (hidden fatigue) scales a runner's stats on race day: Excellent 103%, Good 101%, Normal 100%, Tired 96%, Exhausted 90% (`CONDITION.BANDS`); energy below half trims stats down to 92%. **Mood** is a nudge of at most ±0.6% over a race (`SD.DATA.MOODS`). Neither can outweigh a real stat edge.
- **Style, ability, events, chat**: running style changes the pace by phase, abilities give short bursts, race events and chat boosts / sabotages / cheers add drama.

Admin drawer → **Tuning**: *Event frequency* (none / low / normal / high / chaos: how often random race events happen, ×0 / ×0.5 / ×1 / ×1.6 / ×2.5, max 6 per race or 12 on chaos), *Hype multiplier* (scales every hype gain), *Playback speed* and *Final-stretch speedup* (presentation only: a 1200 m race plays in about 20 s, 2400 m in about 40 s), *User cooldown*. Every other number lives in `js/config.js` (`SD.CONFIG`), with ability magnitudes and moods in `js/data.js`. The betting odds come from a rating (stats, race-day modifiers, style, expected stamina left, ability) through a softmax (`RACE.ODDS`), fitted so implied and actual win rates agree within a couple of points.

Checking a change:

```
node tools/run-tests.js                          # everything (balance, race systems, parser, progression)
node tools/balance-test.js --matrix              # roster win rates per distance, style clones, odds calibration, sensitivity
node tools/balance-test.js --distance 2400 --races 3000
node tools/balance-test.js --streamday           # 20 trains without rest -> Exhausted -> race penalty
node tools/balance-test.js --dump 12345          # one full race record, tick by tick
node tools/race-test.js --verbose                # abilities, events, hype tiers, chat effects, replay, day events
```
