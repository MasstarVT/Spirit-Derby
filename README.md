# 🌲 Spirit Derby

**A Twitch-chat-driven forest-spirit racing and management game.** Chat joins, claims runners, trains them, cheers, bets fictional Spirit Points, slips pebbles into rivals' shoes and watches the results unfold in animated races on stream. In short, chat accidentally became a horse-racing management company.

Spirit Derby is original work: the runners, art direction (emoji on coloured badges), text and rules were all written for this project. It borrows the *genre* (chat-played idle racing and management games), not any third-party assets, names or code. It uses plain HTML, CSS and JavaScript with no build step, no dependencies and no server.

Version **1.0.0** · [Architecture](docs/ARCHITECTURE.md) · [Twitch / Mix It Up / OBS guide](docs/INTEGRATION.md) · MIT licence

---

## Contents

[The loop](#the-loop) · [Quick start](#quick-start) · [Screen tour](#screen-tour) · [Viewer commands](#viewer-commands) · [Spirit Points](#spirit-points) · [Training, energy, condition and mood](#training-energy-condition-and-mood) · [Runners and abilities](#runners-and-abilities) · [Races](#races) · [Hype](#hype) · [Seasons and achievements](#seasons-and-achievements) · [Streamer guide](#streamer-guide) · [Twitch and Mix It Up](#twitch-and-mix-it-up) · [Architecture](#architecture) · [Testing](#testing) · [Project structure](#project-structure) · [Roadmap](#roadmap--ideas) · [Licence](#licence)

## The loop

1. Viewers **`!join`** (200 SP) and **`!claim`** one of 10 runners, or **`!create`** their own once every runner has an owner.
2. Between races, chat **trains** (`!train speed`), **rests**, **cheers**, **snacks**, **boosts**, **sabotages** and **bets** on the next field. Every action has a small cost and a visible effect.
3. The streamer starts the race (admin **START RACE**, or a mod types `!race`). It is simulated up front from one seed, then played back in about 20–40 s with phases, abilities, random forest events and chat effects.
4. Results pay owners, backers and winning bets, give XP and level-ups, and update six leaderboards. Three races make a day and seven days make a season, which ends with a summary (champion, MVP, biggest upset). Then everyone starts fresh with a small carry-over.

## Quick start

- **Play:** double-click `index.html` (Chrome, Edge or Firefox). Everything runs from `file://`, and the game autosaves in the browser.
- **Or serve it:** `node tools/serve.js` (optional; any static server works), then open <http://localhost:8090> (`node tools/serve.js 3000` picks another port).
- **Try it alone:** open the **Chat** tab and switch on **🤖 Demo bots**. Six fictional viewers join, train, bet and cheer. Press **`** (backtick) for the streamer controls and hit **▶ START RACE**.
- **Go live:** press **O** for overlay mode, or load `index.html?overlay=1` as an OBS browser source (1920×1080). Add `&twitch=yourchannel` to read your chat. Details are in [docs/INTEGRATION.md](docs/INTEGRATION.md).
- **Run the tests:** `node tools/run-tests.js` (Node 18+, about 40 s).

## Screen tour

| Area | What it shows |
|---|---|
| **Header** | 🌲 logo · `SEASON n · DAY d` and `RACE i/3` · today's day event · the hype meter (value, next threshold) · connection dot (grey off, amber connecting, green on, red error) · 📺 overlay and ⚙ controls buttons |
| **Track** | Title bar (track name, distance, phase, distance progress bar) · one lane per runner (badge, name, owner, level, style, stamina bar) with the sprite moving along it · live **Positions** column (gaps in metres, finish times) · ticker with the three latest race events · countdown, fog, finish flash and photo-finish / upset / winner banners |
| **Paddock** (no race) | The exact next field in lane order with odds, condition, energy and owner · chips for open bets, queued boosts, sabotages and cheers · the season's leader |
| **Roster strip** | One card per runner: stats vs cap, energy, XP, mood, condition, record, owner, ability (hover for details) · local TRAIN / REST controls for the streamer |
| **Sidebar** | **Chat** (simulated chat: speak as anyone with `@Name: !cmd`, demo bots) · **Boards** (six leaderboards, season or all-time, and past seasons) · **Log** (everything that happened) |
| **Modals** | Race results (places, times, XP, SP, stat gains, abilities, bets, achievements) · season summary |
| **Toasts** | Achievements, level-ups, streamer messages; in overlay mode also every command reply (queued, max 4 visible, max 1 new reply per second) |

## Viewer commands

Every source (simulated chat, SEND AS, Twitch, the bridge) goes through the same pipeline: `SD.processCommand(username, text, { source, isMod, displayName })`. Runner names are case-insensitive and can be shortened (`moss`, `Moss Runner`, `@MossRunner`, the id `r01`); an ambiguous name gets a "Did you mean…?" reply. **Locked** = refused while a race is running (countdown, running or paused).

| Command | Aliases | Cost / effect | Cooldown | Locked | Example reply |
|---|---|---|---|---|---|
| `!join` | | +200 SP once; +50 SP daily bonus on your first action each in-game day | none | no | *Welcome to the Spirit Derby, FoxFan! You have 225 Spirit Points. Type !claim to pick a runner… · 🏅 Achievement: First Steps (+25 SP)* |
| `!claim [runner]` | | Claim a free runner (named or the first free one). One per viewer; claiming another releases yours | 10 s | yes | *FoxFan claimed 🦌 Moss Runner (Late Surger)! Now try !train speed.* |
| `!create <name>` | | Once every runner has an owner (and **Allow !create** is on): a new runner from a random species, style and ability, stats summing to 200, claimed by you. Names: 3–20 letters, digits, spaces, apostrophes; unique | 10 s | yes | *✨ AcornAndy created 🦉 Pebble Dash, a Hollow Owl Wild Card! SPD 37 STA 37 POW 32 WIS 52 LUK 42 · Ability: Acorn Hoard* |
| `!train <stat>` · `!train <runner> <stat>` | `!t` | −12 energy, +stat, +5 SP (+15 on a critical), hype +1 (+10). Stats `speed stamina power wisdom luck` or `spd sta pow wis luk` | 10 s | yes | *Moss Runner practiced explosive starts. · Speed +2 · Energy -12 · Hype +1 · +5 SP* |
| `!rest [runner]` | `!r` | +30 energy, −25 fatigue, hype −5 | 10 s + 3 min per runner | yes | *Moss Runner soaks their hooves in the Moonlit Spring. · Energy +30 · Hype -5 · Feeling Good* |
| `!cheer [runner]` | `!c` | Hype +3, +2 SP; a named runner gets a tiny pre-race boost (+0.05% per cheer, max 2%); 10 cheers calm a Nervous runner | 30 s | **no** | *The forest hears you! Hype +3 (3/120) · Moss Runner feels the love (1 cheer for the next race) · +2 SP* |
| `!status` | `!stats` | Your SP, SP rank and runner | none | no | *FoxFan: 261 SP · #1 in SP · 🦌 Moss Runner Lv 1 · SPD 42 STA 42 …* |
| `!inspect [runner]` | `!i` | Full card: style, owner, stats, energy, condition, mood, record, next-race odds, ability | none | no | *🐇 Glow Wisp · Lv 1 Late Surger · Unclaimed · SPD 52 … · Afterglow: …* |
| `!race` | | Viewers: status, next field with odds, open bets. **Mods / streamer:** start the race (`!race 2000` picks the distance, `!race status` only looks) | none | — | *No race running. Next up: Race 1/3 · 1200 m · Moss Runner 4.2x, …* |
| `!event` | | Viewers: today's day event. **Mods:** `!event` rolls a new one, `!event harvest` picks one (locked during races), `!event today` looks | none | mods | *Today (Season 1, Day 1): Harvest Festival — … payouts x1.5.* |
| `!odds` | | Odds of the next field (or the running race) | none | no | *Next race (Race 1/3, 1200 m): Velvet Comet 2.6x · Thunder Fern 2.9x · …* |
| `!bet <runner> <amount>` | | Bet 10–250 SP; also `!bet 50 moss`, `!bet moss all`, `!bet 50` (same runner), `!bet`, `!bet cancel`. One open bet each; a new bet refunds the old | 10 s | yes | *💰 FoxFan bets 50 SP on Moss Runner at 4.2x — pays 210 SP if Moss Runner wins!* |
| `!bets` | | Open bets: count, total, per runner, yours | none | no | *Open bets for the next race: 1 bet · 50 SP · Moss Runner 1 (50 SP) · …* |
| `!boost <runner>` | | 40 SP: +2.5% for 15 ticks at a random moment of its next race (max 3 per runner) | 10 s | yes | *⚡ FoxFan boosts Moss Runner for its next race! 2 more boosts allowed · 171 SP left* |
| `!snack <runner>` | | 25 SP: +10 energy (max 2 per runner per day) | 10 s | yes | *🍎 Glow Wisp munches a honey-glazed acorn. Energy +10 (78/100) · 1 snack left today · 146 SP left* |
| `!sabotage <runner>` | | 60 SP: ×0.96 for 15 ticks in its next race. Backfire chance 15% + Wisdom/200 (max 50%). Not your own; max 2 per target, 4 per race; announced publicly | 10 min | yes | *🪨 Sabotage queued on Moss Runner … (35% with its Wisdom) is decided at the gate!* |
| `!ribbon <colour>` | | 100 SP cosmetic ribbon ring (`gold`, `teal`, `#ff66aa` …); `!ribbon off` is free | 10 s | yes | *🎀 Moss Runner now wears a teal ribbon! · 71 SP left* |
| `!hype` | | The meter, tier and next threshold | none | no | *🔥 Hype 4/120 · The forest is calm · next: 25 — The crowd is getting loud!* |
| `!achievements [viewer]` | `!ach` `!badges` | Count / total and the latest three | none | no | *🏅 FoxFan: 2/25 achievements (+50 SP) · latest: 🏡 Stable Hand, 👣 First Steps* |
| `!leaderboard [board] [all]` | `!lb` `!top` | Top 3 of `sp` (default), `wins`, `xp`, `part`, `victories`, `hype`; `all` = all-time | none | no | *🏆 Runner wins: 1. Velvet Comet (3) · 2. Moss Runner (2) · …* |
| `!rank [viewer]` | | Your rank on the SP, victories and hype boards | none | no | *FoxFan: #2 in SP (71) · unranked in victories · #1 in hype (5.2)* |
| `!help [command]` | `!h` `!commands` | The list, or one command's usage | none | no | *!train <stat> or !train <runner> <stat> … — Train your runner …* |

- The per-viewer cooldown (default 10 s) is **Tuning → User cooldown**. Cooldowns start only after a command succeeds. The streamer's own console (the *Streamer* sender, SEND AS) has no cooldowns and may train any runner.
- Read-only commands have no cooldown but count toward the participation board at most once every 10 s.
- **Open training** (default on) lets anyone `!train` / `!rest` any runner by name. This is the "chat overtrains the favourite" story. Turn it off and only owners train their runner.
- Unknown commands (`!discord`, meant for other bots) get a short reply in the Chat tab but no toast on stream and nothing through the bridge.

## Spirit Points

Spirit Points (SP) are a **fictional** in-game currency. They cannot be bought, sold, transferred or exchanged for anything real. Nothing in Spirit Derby involves real money.

- **Faucets:** join +200 · daily first action +50 · train +5 (critical +15) · cheer +2 · owner race payout by place 50 / 35 / 25 / 15 / 15 / 8 / 8 / 8 · **backers** (viewers who mostly trained, rested, cheered, boosted or snacked a runner they do not own since its last race) get half · winning bets · achievements +25 to +100. Payouts are ×1.5 when the Forest Awakened and ×1.5 on the Harvest Festival day.
- **Sinks:** bets 10–250 · `!boost` 40 · `!snack` 25 · `!sabotage` 60 · `!ribbon` 100. Balances never go below 0.
- **Betting:** odds come from the race engine's own rating (stats, condition, energy, mood, style, stamina for the distance, ability, queued cheers) through a softmax with a 15% house edge: `odds = 0.85 / p`, clamped to 1.3×–25×. A bet keeps the odds shown when it was placed and pays `floor(stake × odds)` (stake included). Open bets are **refunded** when a race is cancelled or interrupted, the day advances or is reset, the season ends, or the runner does not make the field. Refunds reverse the spend, so they never count as "SP earned".
- **New season:** SP restarts at 200 + 10% of your balance.

## Training, energy, condition and mood

- **Energy** (0–100, +2 per level) is spent by training (−12) and racing (−25), and comes back by `!rest` (+30), `!snack` (+10), slowly over time (+0.75 per minute) and fully each new day. Below 15 energy a runner only races if nobody else can; below half energy its race-day stats shrink (to ×0.92 at worst).
- **Fatigue** is hidden (the streamer sees it in the debug table). Training adds 5 (10 when energy is below 30, +8 on a failure), racing adds 15, resting removes 25, a new day removes 40. It sets the **condition** chat sees: **Excellent** 0–15 (race stats ×1.03, training ×1.15) · **Good** 16–35 (×1.01, ×1.05) · **Normal** 36–60 · **Tired** 61–80 (×0.96, ×0.85, more failures) · **Exhausted** 81+ (×0.90, ×0.60). Twenty trainings without rest leave a runner Exhausted for its next race; that is the intended story.
- **Training:** a critical session (8% + Luck and Wisdom bonuses, max 35%) doubles the gain; a failure (5%, more when low on energy or tired) gains nothing and may make the runner Nervous. Gains shrink near the stat cap (60 + 4 × level).
- **Mood** is a small nudge (at most ±0.6% over a race): 😤 Determined (3 trainings of one stat, or 4th–6th) · 😊 Happy (podium, rest) · 😰 Nervous (failed training, 7th–8th; 10 cheers or a crit cure it) · 🔥 Fired Up (a crit, or hype ≥ 50 at the gate) · 😴 Sleepy (resting while tired, 30 min idle) · 🌀 Chaotic (hype ≥ 100, a bad mushroom). Neither mood nor condition can outweigh a real stat edge.
- **Progression:** races give XP by place (100 / 70 / 50 / 35 …, +20 for taking part, ×1.1–1.3 for longer races, ×1.25 for below-average-level runners). Level *L* needs 60 + 20 × (*L* − 1) XP, up to level 20. Each level adds +1 to every stat, +4 to the cap, +2 max energy, stronger abilities and +8 hype.

## Runners and abilities

Stats are Speed / Stamina / Power / Wisdom / Luck (each sums to 200 at level 1).

| Runner | Style | SPD / STA / POW / WIS / LUK | Ability |
|---|---|---|---|
| 🦌 **Moss Runner** | Late Surger | 40 / 42 / 40 / 40 / 38 | **Forest's Favor**: a Luck-scaled chance (at least 40%) of a +18% burst at the final stretch; guaranteed when 3rd–5th |
| 🐎 **Moonhoof** | Pace Chaser | 36 / 58 / 36 / 42 / 28 | **Moonlight Pace**: mid race stamina drain ×0.80 and +2% speed |
| 🐗 **Thunder Fern** | Front Runner | 42 / 36 / 58 / 34 / 30 | **Thunder Step**: overtaking mid race or in the final turn gives +30% for 3 ticks (max 3) |
| 🦊 **Ember Tail** | Front Runner | 60 / 24 / 44 / 32 / 40 | **Second Wind**: once, below 12% stamina, restore 15% and ignore fatigue for 10 ticks |
| 🐈 **Velvet Comet** | Late Surger | 56 / 38 / 34 / 42 / 30 | **Comet Tail**: final stretch +9% for 12 ticks from 2nd–5th, +6% from further back |
| 🦢 **Misty Gale** | Pace Chaser | 38 / 42 / 34 / 58 / 28 | **Reading the Wind**: Wisdom roll at the final turn for +5% and cheaper stamina; bad events find her half as often |
| 🐿️ **Copper Bloom** | Wild Card | 38 / 36 / 36 / 30 / 60 | **Acorn Hoard**: crits ×2.5 and stronger, good events ×1.5, a guaranteed final-stretch crit |
| 🦉 **Night Lantern** | Wild Card | 32 / 50 / 30 / 50 / 38 | **Long Night**: final-stretch speed = stamina left × 14%; bigger pool at 2000 m+ |
| 🦝 **Bramble Jack** | Wild Card | 40 / 34 / 46 / 26 / 54 | **Hedge Hop**: shrugs off bad events (50% + Luck/200), bounces them onto the runner ahead and springs forward |
| 🐇 **Glow Wisp** | Late Surger | 52 / 30 / 34 / 46 / 38 | **Afterglow**: final stretch +2% per runner ahead (max +10%) for the rest of the race |

**Running styles:** *Front Runner* blasts out of the gate and tries to hold on (burns stamina) · *Pace Chaser* sits just off the lead at an even pace · *Late Surger* saves energy, then explodes down the final stretch · *Wild Card* rolls a hidden "wild roll" each race (great, steady or collapse; Luck helps) and swings more.

**Created and spawned runners** (`!create`, admin SPAWN RUNNER) come from 12 species templates (🦊 Fox Spirit, 🐇 Moon Hare, 🦌 Forest Stag, 🦉 Hollow Owl, 🐸 Moss Toad, 🦋 Lantern Moth, 🐺 Grey Wolf, 🦎 Ember Salamander, 🐢 Elder Tortoise, 🐈‍⬛ Shadow Lynx, 🦔 Bramble Hedgehog, 🦇 Dusk Bat). Each has a stat bias and the styles it runs; the ability is drawn from the catalog abilities that suit the style. The paddock holds at most `CONFIG.RUNNERS.MAX_ACTIVE` (24) runners.

**Adding a runner:** append an object to `ROSTER` in `js/data.js`:

```js
{ key: 'pebbleDash', name: 'Pebble Dash', emoji: '\u{1F994}', badgeColor: '#8a6a4a', species: 'Bramble Hedgehog',
  personality: 'One line of character.', description: 'Two sentences for the card.',
  style: 'paceChaser', stats: { speed: 40, stamina: 42, power: 38, wisdom: 40, luck: 40 }, abilityId: 'moonlightPace',
  avatarUrl: null /* optional image instead of the emoji */ }
```

Keep the stats summing to 200 (each at most 64) and reuse an ability id from `ABILITIES` (a new mechanic needs engine code in `js/race.js`). New games spawn it, and **existing saves pick it up on load**: `SD.persistence.load()` reconciles the roster by `key` without duplicating anyone, and a toast announces it.

## Races

- **Distances:** 1200, 1600, 2000 and 2400 m (admin **Distance**, or `!race 2000`). 4–8 runners from the drawer (2–10 through `SD.game.updateSettings`). Owned runners get priority for the field; then the most rested. Lanes are drawn at random, and the paddock shows the exact field before the gate.
- **Phases** (by each runner's own progress): Start (<5%) · Early Pace (<30%) · Mid Race (<65%) · Final Turn (<85%) · Final Stretch · Finish. Each phase weighs the stats differently: Power at the start, Speed and Wisdom mid race, Speed and Power in the stretch. Stamina is a pool that only bites in long races.
- **What decides a race**, roughly in order: stats (10 phase-weighted points ≈ 5% speed), a hidden per-race form and in-race swings (Wisdom calms both), condition and energy, style and ability, then events and chat effects. The best-form identical clone still only wins about 40% of the time.
- **Race events** (16, max 6 per race, 12 on *chaos*; no runner gets two bad ones within 30 ticks): Sudden Rain · Forest Shortcut · Loose Shoe · Cryptid Crossing · Audience Frenzy · Butterfly Distraction · Snack Break · Unknown Creature Appears · Mysterious Fog (hides positions) · Suspicious Mushroom · Forest Wind (hits the leader) · Lucky Acorn · Firefly Trail (lifts the last runner) · Tangled Vines · Owl's Advice · Puddle Jump.
- **Day events** (one per day, header badge): Clear Skies · Fog of the Hollow (Wisdom ×1.5) · Harvest Festival (payouts ×1.5) · Cryptid Season (events ×1.5) · Still Morning (steadier form) · Wisp Migration (crits ×1.5) · Moonlit Glade (bigger stamina pools).
- **Flags:** a *photo finish* (winning margin under 0.4 m) and an *upset* (winner at 10× or more) each add hype and get a banner.
- Playback is presentation only: speed ramps up by phase, and the final stretch plays faster (`finalStretchSpeedup`). With the default settings a race lasts roughly 20 s (1200 m) to 40 s (2400 m) including the countdown.

## Hype

The crowd meter runs from 0 to 120. Cheers +3, training +1 (a crit +10), bets +1, level-ups +8, a backfired sabotage +5, and each race moment (finish, photo finish, upset, Forest Awakened) +15; resting costs 5. It is scaled by **Tuning → Hype multiplier**. After each race it keeps 40%; after 5 idle minutes it loses 1 every 2 minutes.

| Threshold | Banner | Effect |
|---|---|---|
| 25 | *The crowd is getting loud!* | wilder in-race swings (×1.10) |
| 50 | *CHAT HAS ENTERED FERAL MODE.* | race events ×1.5, crits ×1.25, training gains ×1.05, runners may start Fired Up |
| 100 | *THE FOREST HAS AWAKENED.* | at the final turn: +15% stamina and +4% speed for everyone, the last runner surges, payouts ×1.5; runners may start Chaotic; training crits +5% |

## Seasons and achievements

A day has 3 races and a season has 7 days. With **Auto-advance day** on, the day moves on after the last race: energy is restored, bets are refunded, snacks reset and a new day event rolls. With it off, press **NEXT DAY** (races stop after the third). After the last race of day 7 (or **RESET SEASON**) the **season summary** shows the champion runner (most wins, then XP), the MVP (most SP earned), the biggest upset, the top hype contributor, achievements and a standings table, and archives it under Boards → *Season history*. Then runners return to level 1 with their base stats + 10% of what they gained, and owners are cleared. Viewers keep their profiles and achievements, and their season stats roll into the all-time boards.

**25 achievements** (+25 to +100 SP, once per viewer, kept across seasons): 👣 First Steps · 🏡 Stable Hand · 🏋 Trainer · ⚡ Critical Hit · 💤 Overtrainer · 🛌 Well Rested · 📣 Cheerleader · 🚂 Hype Train · 🌳 Forest Awakened · 🎲 High Roller · 👁 Sharp Eye · 🎯 Longshot · 🏆 Owner's Pride · 🥉 Podium Regular · 📸 Photo Finish · 🔄 Comeback Kid · 🪨 Saboteur · 🪃 Karma · 👑 Season Champion · 👾 Cryptid Whisperer · 🏃 Marathon Mind · 🍎 Snack Dealer · 🔟 Double Digits · 💰 Spirit Hoarder · ✨ Creator. They appear in the command reply, as a gold toast, in chat and in the race results.

**Leaderboards** (Boards tab, `!lb`, `!rank`): runner wins, runner XP, Spirit Points, participation (commands + trainings × 2 + cheers + rests + bets), race victories (races won by the runner you own or back) and hype added. Each has a season and an all-time view, and ties share a rank.

## Streamer guide

**Streamer Controls** (⚙ or **`**) slide over the sidebar. All actions go through `SD.game`, and dangerous ones need a second click.

| Section | Controls |
|---|---|
| 🏁 Race | **START RACE** · **END RACE** (plays the result out instantly) · **PAUSE / RESUME** · distance · number of runners |
| 🌲 World | day event picker + **TRIGGER EVENT** · **ADD HYPE +25** · name + **SPAWN RUNNER** · **NEXT DAY** · **RESET DAY** · **RESET SEASON** (summary + rollover) · **RESET ALL** (new game) |
| 🎛 Tuning | event frequency (none / low / normal / high / chaos) · hype multiplier · playback speed · final-stretch speedup · user cooldown · open training · allow `!create` · auto-advance day |
| 🐞 Debug | debug mode (hidden events such as wild rolls in the ticker, a HUD on the track with tick / fps / seed / hash / wild rolls, a perf + fatigue table, error toasts) · **seed override** (every race uses it while debug is on; the paddock matches) · **REPLAY LAST RACE** (re-simulates and compares hashes; races from an older engine are flagged as such) · **COPY LAST RACE JSON** for bug reports |
| 💾 Save | **EXPORT JSON** / **IMPORT JSON** · `autosave ● 2 s ago · 41 KB` with a *SAVED ✓* flash · counts and storage type · **Save now** |
| 💬 Send as | run any command as the streamer, a mod or a recent viewer (no cooldowns) |
| 📡 Twitch & bridge | read-only Twitch chat and the local bridge: connect, auto-connect, live status |

The drawer footer shows the build: `Spirit Derby v1.0.0 · save schema v2 · race engine v2`.

**Keyboard:** **`** controls · **O** overlay mode · **Space** pause / resume · **Esc** closes the results, the season summary or the drawer.

**Overlay mode** (`?overlay=1` or **O**) hides the sidebar, the drawer, the roster's TRAIN / REST controls, the streamer hint and the debug HUD, widens the track and shows command replies as toasts: at most 4 on screen, 1 new reply per second, and the oldest waiting reply is dropped during a raid. For OBS, add a Browser Source at 1920×1080 with `file:///…/index.html?overlay=1&twitch=yourchannel`, and turn **Shutdown source when not visible** off. [docs/INTEGRATION.md](docs/INTEGRATION.md) covers two-instance setups.

**Saves:** the game lives in this browser's `localStorage`: `spiritderby.save` (the game), `spiritderby.backup` (the previous save, written before an upgrade or import) and `spiritderby.ui` (overlay, drawer, tab, chat sender and board choices; RESET ALL keeps them). Saves from any earlier version load and upgrade automatically. A race interrupted by closing the page is cancelled on the next load, and its bets are refunded. Use EXPORT / IMPORT to move a game between browsers or into OBS.

**Tuning beyond the sliders:** every number lives in `SD.CONFIG` (`js/config.js`). The ones worth touching first:

| Constant | Default | Meaning |
|---|---|---|
| `SEASON.RACES_PER_DAY` / `SEASON.DAYS` | 3 / 7 | length of a day and a season |
| `ECONOMY.JOIN_SP`, `DAILY_SP`, `BET_MIN` / `BET_MAX`, `BOOST_COST`, `SNACK_COST`, `SABOTAGE_COST`, `RIBBON_COST` | 200, 50, 10 / 250, 40, 25, 60, 100 | the SP economy |
| `COOLDOWNS.USER_S` / `CHEER_S` / `SABOTAGE_S` | 10 / 30 / 600 | chat cooldowns (seconds) |
| `HYPE.GAINS`, `HYPE.AFTER_RACE_KEEP` | see file, 0.4 | hype per action, post-race decay |
| `RUNNERS.MAX_ACTIVE`, `CREATE_NAME_MIN` / `MAX` | 24, 3 / 20 | roster cap, `!create` names |
| `UI.TOAST_MAX`, `REPLY_TOASTS_PER_S`, `REPLY_QUEUE_MAX` | 4, 1, 6 | overlay toast flood control |
| `PLAYBACK.TPS`, `COUNTDOWN_S` | per phase, 3 | how fast races play back |
| `RACE.EVENTS.SLIDER`, `RACE.EVENTS.MAX` | ×0 … ×2.5, 6 | event frequency presets |
| `HISTORY_FULL_LOGS`, `HISTORY_MAX` | 10, 200 | races kept with tick data / at all |

Race balance lives in `RACE.*`, `STYLES`, `CONDITION.BANDS` and the ability magnitudes in `js/data.js`. Check any change with the balance harness (below).

**Console helpers** (browser devtools):

```js
SD.debug.help()                       // this list
SD.debug.state()                      // the live game state (read-only please)
SD.debug.lastRace()                   // the race on the track, or the last finished one
SD.debug.lastRaceJSON(true)           // the same as pretty JSON (what COPY LAST RACE JSON copies)
SD.debug.simulate(12345, 2400)        // simulate the next field with a seed + distance, without changing the game
SD.debug.replay()                     // re-simulate the last race and compare hashes
SD.debug.bus.wildcard(true, /bet|race:finished/)   // log bus events; wildcard(false) stops
SD.processCommand('FoxFan', '!join', { source: 'sim' })
```

## Twitch and Mix It Up

Both are optional and off by default. **Read-only Twitch chat** connects anonymously (no token, no login) and feeds `!commands` into the game. The **local WebSocket bridge** lets Mix It Up, Streamer.bot or your own script send chat in and post the game's replies back to Twitch. Mods are recognised from Twitch badges. Setup, frame formats, OBS and troubleshooting: **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

## Architecture

Classic `<script>` files on one `globalThis.SD` namespace (no modules, so it runs from `file://`). The core (`js/*.js`) is DOM-free and loads unchanged in Node for tests. It has one JSON-serialisable state, `SD.state.mutate()` for every change, a synchronous event bus and a deterministic race engine (all randomness from one seed, so a race replays to the same hash). The UI (`js/ui/*.js`) renders from the state and bus events. Twitch and the bridge are input adapters that only call `SD.processCommand`. The full API contract, load order and per-milestone notes are in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Testing

`node tools/run-tests.js` runs every suite as a child process and exits non-zero on any failure (`--verbose` prints every assertion).

| Suite | File | Covers |
|---|---|---|
| balance | `balance-test.js` | determinism, no NaN, win-rate bands per runner / style / distance, odds calibration, stat / condition / mood sensitivity |
| race | `race-test.js` | abilities, the 16 events, hype tiers, chat effects in races, photo finish / upset, replay, day events, playback length |
| parser | `parser-test.js` | command parsing, aliases, the pipeline (permissions, race lock, cooldowns), players |
| progression | `progression-test.js` | XP / level-ups, leaderboards, `!lb` / `!rank` |
| integration | `integration-test.js` | Twitch IRC parsing and adapter, the bridge (no network) |
| community | `community-test.js` | betting, boost / snack / sabotage / ribbon, mod commands, achievements, seasons |
| persistence | `persistence-test.js` | an M1 save (`tools/fixtures/save-m1.json`) migrating and playing on, normalize, roster reconciliation, interrupted races, backups, history trimming, UI prefs |
| runners | `runners-test.js` | `!create` rules and replies, SPAWN RUNNER, the runner cap, `SD.debug` |
| fuzz | `fuzz-test.js` | 12 seeded viewers spamming every command (hostile arguments, spam bursts, mid-race attempts, non-mod mod commands, reloads) over 3 full seasons, with invariants checked after every command and race |

Useful flags:

```
node tools/balance-test.js --matrix                # win rates for every runner at every distance
node tools/balance-test.js --distance 2400 --races 3000 --events chaos
node tools/balance-test.js --streamday             # 20 trainings without rest -> Exhausted -> race penalty
node tools/balance-test.js --dump 12345            # one full race record, tick by tick
node tools/community-test.js --transcript          # a readable chat transcript of a scripted stream
node tools/runners-test.js --transcript            # the !create conversation (success and every refusal)
node tools/fuzz-test.js --seed 7 --seasons 3       # another fuzz run (prints a command-outcome histogram)
```

## Project structure

```
index.html              page + script load order (classic scripts, no build)
css/                    tokens.css (palette, type, keyframes) · layout.css (grid, overlay, drawer) · track.css · panels.css
js/                     core, DOM-free (loads in Node)
  namespace.js config.js rng.js data.js bus.js      SD, SD.CONFIG, seeded rng, catalogs, event bus
  state.js persistence.js                            the game state, save / load / migrate / export
  runners.js training.js events.js race.js hype.js   runners, training, events, the race engine, hype
  players.js betting.js achievements.js leaderboards.js seasons.js
  game.js                                            the director (races, days, settings)
  commands.js                                        the chat command pipeline (SD.processCommand)
  debug.js                                           SD.debug console helpers
  ui/                   browser panels: dom, playback, header, track, results, season, roster, chat, leaderboards, eventlog, admin
  integrations/         twitch.js (read-only IRC), bridge.js (local WebSocket relay)
  main.js               boot
tools/                  load-core.js · run-tests.js · *-test.js suites · serve.js · fixtures/save-m1.json
docs/                   ARCHITECTURE.md (API contract) · INTEGRATION.md (Twitch, Mix It Up, OBS)
```

## Roadmap / ideas

- Twitch write-back through a bot token (documented in INTEGRATION.md, deliberately not built).
- Runner art: `avatarUrl` per runner is already supported; a sprite sheet per species would be next.
- Channel-point redemptions through the bridge (for example a free boost).
- Team events and relay races; rival pairs with their own banter; retirement and a hall of fame.
- A second track layout per distance and weather that lasts a whole day.
- Localisation: every reply is one string in `js/commands.js` and `js/data.js`.

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Spirit Derby contributors. Spirit Points are fictional and have no monetary value.
