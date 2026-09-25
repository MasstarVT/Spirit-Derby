# Spirit Derby

A Twitch-chat-driven forest spirit racing and management game. Open `index.html` (no build step, no server needed), or run `node tools/serve.js`. Headless tests: `node tools/run-tests.js`.

## Commands

Chat commands work the same whether they come from the simulated chat in the sidebar, the streamer's **SEND AS** box in the admin drawer (⚙ or backtick), Twitch chat or the local bridge. Spirit Points (SP) are fictional and have no real-world value (see [Spirit Points](#spirit-points)).

| Command | Aliases | What it does |
|---|---|---|
| `!join` | | Join the Spirit Derby. +200 SP the first time; +50 SP for your first action each in-game day. |
| `!claim [runner]` | | Claim a free runner (named, or the first free one). One runner per viewer: claiming another releases your old one. |
| `!train <stat>` / `!train <runner> <stat>` | `!t` | Train your runner (or any runner by name while *open training* is on). Stats: `speed`, `stamina`, `power`, `wisdom`, `luck` (short forms like `spd`, `sta`, `pow`, `wis`, `luk` work). Costs 12 energy; +5 SP (+15 on a critical session), hype +1. |
| `!rest [runner]` | `!r` | Energy +30 and less fatigue (hype −5). Each runner can rest once every 3 minutes. |
| `!cheer [runner]` | `!c` | Hype +3 and +2 SP. Cheering a named runner before a race gives it a tiny boost, and 10 cheers calm a Nervous runner. Works during races too. |
| `!status` | `!stats` | Your SP (and your rank on the SP board) and your runner's level, stats, energy, condition, mood and record. |
| `!inspect [runner]` | `!i` | A runner's full card: style, ability, owner, stats, condition, mood, record and odds for the next race. |
| `!race` | | Viewers: what is happening on the track, the next field with odds, the favourite and the open bets. **Mods and the streamer:** starts the race (`!race 2000` picks the distance; `!race status` only looks). |
| `!event` | | Viewers: today's day event and what it changes. **Mods and the streamer:** `!event` rolls a new random day event, `!event <name>` sets one (`!event harvest`, `!event fog`), `!event today` only looks. |
| `!odds` | | Odds for every runner in the next race (or the race that is running). |
| `!bet <runner> <amount>` | | Bet 10–250 SP on a runner in the next race. Also `!bet <amount> <runner>`, `!bet <runner> all` (all-in, capped at 250), `!bet <amount>` (same runner as your open bet), `!bet` (show your bet) and `!bet cancel`. One bet per viewer: a new bet refunds and replaces the old one. |
| `!bets` | | The open bets on the next race: how many, how much, on whom, and yours. |
| `!boost <runner>` | | 40 SP: the runner gets a +2.5% burst for 15 ticks at a random moment of its next race. Max 3 boosts per runner per race; boosting your own runner is fine. |
| `!snack <runner>` | | 25 SP: +10 energy. Max 2 snacks per runner per in-game day. |
| `!sabotage <runner>` | | 60 SP: a pebble in the runner's shoe for its next race (×0.96 for 15 ticks). Wise runners may kick it back: backfire chance = 15% + Wisdom / 200 (max 50%), and then *they* get faster. Not your own runner; 10-minute cooldown; max 2 per target and 4 per race. Chat sees "FoxFan slipped a pebble into Moss Runner's shoe…", and whether it sticks is decided at the gate. |
| `!ribbon <colour>` | | 100 SP: a coloured ribbon ring around your runner's badge (cosmetic). Named colours (`gold`, `teal`, `crimson`, `lilac` …) or `#hex`; `!ribbon` lists them, `!ribbon off` removes it for free. |
| `!hype` | | The hype meter, the current tier and how far the next threshold is. |
| `!achievements [viewer]` | `!ach`, `!badges` | Your achievements (count / total and the latest three), or another viewer's. |
| `!leaderboard [board] [all]` | `!lb`, `!top` | The top 3 on a board. Boards: `wins` (runner wins), `xp` (runner XP), `sp` (Spirit Points, the default), `part` (participation), `victories` (races won by the runner you own or back) and `hype` (hype you added). Add `all` for all-time totals: `!lb wins all`. |
| `!rank [viewer]` | | Your rank on the SP, victories and hype boards in one line (or another viewer's: `!rank FoxFan`). |
| `!help [command]` | `!h`, `!commands` | The command list, or details for one command (`!help train`). |

Rules worth knowing:

- Training, resting, claiming and everything that spends SP (`!bet`, `!boost`, `!snack`, `!sabotage`, `!ribbon`) are locked while a race is running (countdown, running or paused). `!cheer`, `!status`, `!inspect`, `!race`, `!event`, `!odds`, `!bets`, `!hype`, `!achievements`, `!leaderboard`, `!rank` and `!help` always work.
- Each viewer has a per-command cooldown (default 10 s, *User cooldown* in the admin Tuning section; `!cheer` 30 s). The streamer's own console (the **Streamer** sender and SEND AS) is not cooldown-limited.
- Runner names are case-insensitive and can be shortened: `moss`, `Moss Runner`, `mossrunner` and `@MossRunner` all work. An ambiguous name gets a "Did you mean…?" reply.
- Read-only commands (`!status`, `!lb`, `!rank`, `!help` …) have no cooldown, but they add to your participation score at most once every 10 s, so spamming them cannot top the participation board.
- Race payouts: the owner of each runner earns SP by finishing place (50 / 35 / 25 / 15 …). Viewers who mostly trained, rested or cheered a runner they don't own (its *backers*) earn half of that.

Simulated chat: type in the Chat tab; start a line with `@Name:` to speak as that viewer (for example `@FoxFan: !train speed`), or pick a sender from the list. The **🤖 Demo bots** toggle lets six fictional viewers join, claim, train, cheer and (with what they can afford) bet, boost, snack and now and then sabotage every few seconds, so you can test hype, bets and races alone. In overlay mode (`?overlay=1` or key `O`) command replies appear as toasts under the track.

## Spirit Points

Spirit Points are a **fictional** in-game currency. They cannot be bought, sold, transferred out of the game or exchanged for anything real, and nothing in Spirit Derby involves real money. Betting uses SP only.

- **Earning (faucets):** joining (+200 once), the daily bonus (+50 on your first action each in-game day), training (+5, +15 on a critical session), cheering (+2), race payouts for owners (50 / 35 / 25 / 15 / 15 / 8 … by place, ×1.5 when the Forest Awakened) and half of that for backers, winning bets, and achievements (+25 to +100 each). The Harvest Festival day event multiplies payouts by 1.5.
- **Spending (sinks):** bets (10–250), `!boost` 40, `!sabotage` 60, `!snack` 25, `!ribbon` 100. Nothing ever goes below 0.
- **Betting:** the odds come from the same rating the race engine's odds use (stats, condition, energy, mood, style, stamina for the distance, ability, queued cheers), turned into a win probability with a softmax and a 15% house edge: `odds = 0.85 / p`, clamped to 1.3×–25×. Your bet keeps the odds shown when you placed it. When the race finishes, a winning bet pays `floor(amount × odds)` (the stake is included), a losing bet loses its stake. One open bet per viewer; placing another refunds the first. Open bets are refunded when a race is cancelled, the day advances or is reset, the season ends, the page closed mid-race, or your runner did not make the field at the gate.
- Refunds give the SP back without counting as "SP earned", so they don't inflate the SP board or the season MVP.

## Seasons & achievements

A day has 3 races (`SEASON.RACES_PER_DAY`); with *Auto-advance day* on, the day moves on after the last race (or use admin **NEXT DAY**): energy is restored, open bets are refunded, snacks reset and a new day event is rolled. A season lasts 7 days (`SEASON.DAYS`). It ends automatically after the last race of day 7 (or on the 7th **NEXT DAY**, or admin **RESET SEASON**) and a **season summary** appears (after the race results, if a race ended it):

- **Champion:** the runner with the most wins (then most season XP), with its owner.
- **MVP:** the viewer who earned the most SP this season.
- **Biggest upset:** the race won at the longest odds (a true upset at 10× or more).
- **Top hype contributor**, **achievements unlocked** this season, and a per-runner table (wins, races, podiums, XP).

The summary is archived in the season history (Boards tab → *Season history*). Then the new season starts: every runner returns to level 1 with its base stats plus 10% of what it gained (`SEASON.STAT_CARRY`) and no owner; viewers keep their profiles and achievements, their season stats roll into the all-time boards, and SP restarts at 200 + 10% of their balance (open bets and paid boosts / sabotages that never ran are refunded first). The header's SEASON number pops when it changes.

**Achievements** (25 in `js/data.js`, each unlocked once per viewer, kept across seasons, +25 to +100 SP): First Steps (join), Stable Hand (first claim), Trainer (10 trainings), Critical Hit, Overtrainer (train a runner into Exhausted), Well Rested (5 rests), Cheerleader (25 cheers), Hype Train (help push hype past 50), Forest Awakened (help push it to 100), High Roller (a 200+ SP bet), Sharp Eye (win a bet at 5×+), Longshot (win a bet at 10×+), Owner's Pride (your runner wins), Podium Regular (3 podiums), Photo Finish, Comeback Kid (your runner wins from last place at the final turn), Saboteur, Karma (your sabotage backfires), Season Champion (own the champion when the season ends), Cryptid Whisperer, Marathon Mind, Snack Dealer, Double Digits, Spirit Hoarder and Creator. "Helped push hype" means you added hype within the last 3 minutes before the threshold was crossed. Unlocks appear in the command reply, as a gold toast, in chat, and in the race results when a race caused them; `!achievements` lists yours.

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
node tools/run-tests.js                          # everything (balance, race systems, parser, progression, integration, community)
node tools/community-test.js --transcript        # M5: betting, chat effects, achievements, seasons (+ a readable chat transcript)
node tools/balance-test.js --matrix              # roster win rates per distance, style clones, odds calibration, sensitivity
node tools/balance-test.js --distance 2400 --races 3000
node tools/balance-test.js --streamday           # 20 trains without rest -> Exhausted -> race penalty
node tools/balance-test.js --dump 12345          # one full race record, tick by tick
node tools/race-test.js --verbose                # abilities, events, hype tiers, chat effects, replay, day events
```

## Twitch and Mix It Up integration

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for connecting read-only Twitch chat (no token needed), the local WebSocket bridge protocol for Mix It Up / Streamer.bot, OBS browser-source setup and troubleshooting.
