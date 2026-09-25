# Spirit Derby — Architecture & API Contract

This document is the authoritative interface contract between the **core** (DOM-free game logic under `js/`) and the **UI** (`js/ui/*`, `index.html`, `css/*`). Agents building either side must conform to it exactly. If something here is impossible, change the code AND this file, and say so in your report.

## Ground rules

- Vanilla JS, no build step, no dependencies. Must run from `file://` by double-clicking `index.html`.
- **No ES modules.** Every file is one IIFE attaching to a namespace:
  ```js
  (function (SD) {
    'use strict';
    // ...
    SD.race = { simulate, buildEntrants, selectField, phaseOf, hashRecord, PHASES };
  })(globalThis.SD = globalThis.SD || {});
  ```
- Core files (`js/*.js`, not `js/ui/`) may reference only `SD.*`, `Math`, `JSON`, `Number`, `Array`, `Object`, `String`. No `window`, `document`, `Date`, `setTimeout`, `Math.random`. Time comes from `SD.clock.now()` (defined in `namespace.js`; UI/tests may override it). `persistence.js` is the only core file allowed to touch `localStorage`, guarded by `typeof localStorage !== 'undefined'`, with an in-memory fallback.
- The race engine must be **deterministic**: all randomness from one `SD.rng.create(seed)` consumed in array order. `tools/load-core.js` replaces `Math.random` with a throwing function while tests run.
- Every number that tunes the game lives in `SD.CONFIG` (`js/config.js`). Catalog data lives in `SD.DATA` (`js/data.js`).
- Vocabulary: styles `frontRunner | paceChaser | lateSurger | wildCard`; stats `speed | stamina | power | wisdom | luck`; phases `START | EARLY | MID | FINAL_TURN | FINAL_STRETCH | FINISH`; conditions `Excellent | Good | Normal | Tired | Exhausted`; moods `Determined | Happy | Nervous | Fired Up | Sleepy | Chaotic`.

## Script load order (index.html) — mirrored by tools/load-core.js

```
js/namespace.js  js/config.js  js/rng.js  js/data.js  js/bus.js  js/state.js  js/persistence.js
js/runners.js  js/training.js  js/events.js  js/race.js  js/hype.js  js/players.js  js/betting.js
js/achievements.js  js/leaderboards.js  js/seasons.js  js/game.js  js/commands.js
js/ui/dom.js  js/ui/playback.js  js/ui/header.js  js/ui/track.js  js/ui/results.js  js/ui/season.js  js/ui/roster.js
js/ui/chat.js  js/ui/leaderboards.js  js/ui/eventlog.js  js/ui/admin.js
js/integrations/twitch.js  js/integrations/bridge.js  js/main.js
```
Files that do not exist yet in a milestone are simply omitted from both lists; a missing optional module must not break boot (UI checks `SD.commands` etc. before wiring).

## Core API

### `SD` (namespace.js)
- `SD.VERSION` string, `SD.isNode` boolean.
- `SD.clock.now()` → ms epoch (default `Date.now()`); `SD.clock.set(fn)` to override.
- `SD.util`: `clamp(v, lo, hi)`, `round1(v)`, `pctString(v)`, `nameKey(str)` (lowercase, strips spaces/punctuation), `deepClone(obj)`.

### `SD.CONFIG` (config.js) — plain object; see plan §5–§6 for values.

### `SD.rng` (rng.js)
- `create(seed:uint32) → rng` with `float()`, `chance(p)`, `range(a,b)`, `int(n)` (0..n-1), `tri()` (−1..1 peaked at 0), `pick(arr)`, `weighted(items, weightOf)`, `seed` (the seed), `calls` (count, for debugging).
- `hash(str) → uint32` (FNV-1a). `seedFrom(...parts)` = `hash(parts.join(':'))`.

### `SD.DATA` (data.js)
- `ROSTER: RosterEntry[]` — the 10 named runners: `{ key, name, emoji, badgeColor, species, personality, description, style, stats:{speed,stamina,power,wisdom,luck}, abilityId }`.
- `SPECIES: { id: { name, emoji, badgeColor, statBias:{...}, styles:[...] } }` templates for random runners.
- `STYLES: { frontRunner: { name:'Front Runner', short:'FR', desc, vel:[5 numbers by phase], drain:[5] }, ... }`.
- `ABILITIES: { id: { name, desc, hook: 'phaseEntry'|'tick'|'overtake'|'passive'|'event', phase?, ...params } }`.
- `RACE_EVENTS: [ { id, name, phases:[...], target:'ALL'|'ONE'|'ONE_POS'|'ONE_NEG'|'LEADER'|'LAST', weight, severity, message (with {r} placeholder), effect:{...} } ]` — 16 entries.
- `DAY_EVENTS: [ { id, name, desc, modifiers:{...} } ]`.
- `MOODS: { 'Happy': { emoji, desc, vel, velPhases, sigma, drain, critMult, trainGain, trainCrit, trainFail, eventW, hypeMult } , ... }`.
- `CONDITIONS: [ [maxFatigue, label, raceMult, trainMult], ... ]`.
- `HYPE_THRESHOLDS: [ { value:25, id:'loud', text:'The crowd is getting loud!' }, { value:50, id:'feral', text:'CHAT HAS ENTERED FERAL MODE.' }, { value:100, id:'awakened', text:'THE FOREST HAS AWAKENED.' } ]`.
- `TRACK_NAMES: string[]`, `BADGE_PALETTE: string[]`, `TRAINING_FLAVOUR: { normal:{stat:[...]}, crit:[...], fail:[...] }`, `ACHIEVEMENTS: [ { id, name, desc, sp } ]`.

### `SD.bus` (bus.js)
- `on(name, fn) → unsubscribe`, `once(name, fn)`, `off(name, fn)`, `emit(name, payload)` (synchronous; listener exceptions are caught and `console.error`-ed), `wildcard(fn)`.
- `SD.EVENTS` — string constants: `STATE_CHANGED:'state:changed'`, `STATE_LOADED:'state:loaded'`, `SETTINGS_CHANGED:'settings:changed'`, `LOG_ENTRY:'log:entry'`, `RUNNER_SPAWNED`, `RUNNER_TRAINED`, `RUNNER_RESTED`, `RUNNER_CLAIMED`, `RUNNER_LEVELUP`, `RUNNER_CONDITION`, `PLAYER_JOINED`, `PLAYER_SP`, `HYPE_CHANGED`, `HYPE_THRESHOLD`, `BET_PLACED`, `BET_RESOLVED`, `EVENT_DAY:'event:day'`, `RACE_STARTED`, `RACE_COUNTDOWN`, `RACE_FRAME`, `RACE_TICK`, `RACE_PHASE`, `RACE_EVENT`, `RACE_RUNNER_FINISHED`, `RACE_PAUSED`, `RACE_RESUMED`, `RACE_END_REQUESTED:'race:endRequested'`, `RACE_PLAYBACK_DONE:'race:playbackDone'`, `RACE_FINISHED`, `RACE_ABORTED`, `SEASON_DAY_ADVANCED`, `SEASON_ENDED`, `ACHIEVEMENT_UNLOCKED`, `CHAT_MESSAGE`, `COMMAND_RESULT`, `INTEGRATION_STATUS`. Values are the colon-separated lowercase names (`runner:trained`, `race:runnerFinished`, `season:dayAdvanced`, ...).

### `SD.state` (state.js)
- `create(opts?) → state` — fresh state per the plan §2 (10 roster runners spawned, `settings` defaults, `season` 1/1).
- `get() → state` (live object; UI must not mutate it), `set(state)`.
- `mutate(label, fn) → fn(state)` — runs `fn`, then bumps `meta.updatedAt`, calls `SD.persistence.scheduleSave()` if present, emits `state:changed {label}`. Nested mutates emit once (outermost). If `fn` throws, nothing is emitted and the error is rethrown.
- `log(type, text, severity='info', extra?)` → appends to `state.log` (cap `CONFIG.LOG_CAP`), emits `log:entry`.
- `runtime` — non-persisted object `{ cooldowns:{}, runnerCooldowns:{}, chatFeed:[], connected:{} }`.
- Selectors: `runnerById(id)`, `findRunner(query) → { runner } | { ambiguous:[...] } | { none:true }` (case-insensitive; matches `nameKey`, exact then unique prefix), `player(username)`, `activeRunners()` (not retired), `isRaceLocked()` (currentRace status in countdown/running/paused).

### `SD.persistence` (persistence.js)
- `KEY = 'spiritderby.save'`, `BACKUP_KEY`, `SCHEMA_VERSION`.
- `load() → { state, fromStorage, migratedFrom }` — returns a fresh state when nothing/corrupt is stored. Interrupted race (status not finished) → bets refunded, `currentRace = null`, log entry.
- `save(immediate?)`, `scheduleSave()` (debounced 500 ms via timers only in browser; immediate in Node), `flush()`, `exportJSON() → string`, `importJSON(text) → { ok, error? }`, `clear()`, `migrate(raw) → state`, `MIGRATIONS` map.

### `SD.runners` (runners.js)
- `spawnFromRoster(entry, idx) → Runner`, `spawnRandom(rng, { name?, style?, speciesId? }) → Runner`, `statCap(level)`, `energyMax(level)`, `xpToNext(level)`, `addXp(runner, amount) → { levelUps:number, level }` (applies level-up effects), `conditionOf(fatigue) → label`, `refreshCondition(runner)` (sets `runner.condition`), `setMood(runner, mood)`, `clampRunner(runner)` (stats 1..cap, energy 0..max, fatigue 0..120), `perfScore(runnerLike, phase) → number` (uses `CONFIG.RACE.WEIGHTS`), `describe(runner) → string` (one-line summary for chat).
- Runner ids are `'r' + zero-padded counter` from `state.meta.runnerCounter`.

### `SD.training` (training.js)
- `train(state, runner, stat, { rng, by }) → { ok, outcome:'normal'|'crit'|'fail', gain, energyCost, message, hype, sp, xp }` — implements plan §6.2; throws nothing, returns `{ ok:false, message }` on invalid stat / energy < MIN.
- `rest(state, runner, { by, now }) → { ok, message, energyGain }` — respects per-runner rest cooldown in `state.runtime.runnerCooldowns`.
- `tickClock(state, elapsedMs)` — passive energy regen, fatigue decay, idle mood; returns list of changed runner ids.

### `SD.events` (events.js)
- `rollDayEvent(rng) → DayEvent`, `dayEventById(id)`, `raceEventsForPhase(phase) → RaceEvent[]`, `raceEventById(id)`.

### `SD.race` (race.js) — pure
- `PHASES = ['START','EARLY','MID','FINAL_TURN','FINAL_STRETCH','FINISH']`, `phaseOf(fraction) → phase`.
- `buildEntrants(runners, { hypeLevel, dayEvent, cheerBonus:{runnerId:n} }) → Entrant[]` — snapshot incl. `perf` per phase, `stamMax`, `odds`, `lane` (1-based).
- `selectField(state, count, rng) → Runner[]` — owned runners first, then by condition/energy; skips `energy < CONFIG.RACE.MIN_ENERGY_TO_RACE` unless not enough runners.
- `simulate({ id, seed, distance, entrants, eventFrequency, hypeLevel, dayEvent, chatEffects:[], trackName, season, day, indexInDay }) → RaceRecord`.
- `hashRecord(record) → string` (8-char hex FNV-1a of `JSON.stringify(results) + totalTicks + a digest of every event's tick/kind/runnerId`; results carry each runner's sub-tick `finishTick`, i.e. the final positions. Deliberately independent of `ticks` so records whose ticks were stripped from history still hash the same).

**RaceRecord** (all serialisable):
```js
{ id, season, day, indexInDay, seed, distance, trackName, settingsSnapshot:{ eventFrequency, hypeLevel, dayEventId },
  entrants: [ { runnerId, name, emoji, badgeColor, ribbonColor, lane, style, abilityId, ownerAtRace, level,
                stats, condition, mood, energy, perf:{START,EARLY,MID,FINAL_TURN,FINAL_STRETCH}, stamMax, wildRoll, odds } ],
  ticks: [ { t, phase /*leader phase*/, pos: [ { id, d /*metres*/, v /*m per s*/, st /*stamina fraction 0..1*/, rank /*1-based*/, fx:[/*'crit','ability','fade','wall','event:<id>','boost','sabotage','fog','awakened'*/] } ] } ],
  events: [ { tick, kind:'phase'|'event'|'ability'|'crit'|'overtake'|'chat'|'finish'|'awakened'|'wall', runnerId|null, text, severity:'info'|'good'|'bad'|'epic', hidden?:true, data?:{} } ],
  results: [ { runnerId, place, finishTick /*float*/, timeSec, margin, wallHit, xp, spOwner, spBacker, statChanges:{stat:delta}, energyDelta, fatigueDelta, moodAfter, abilityActivations:[{tick,id,text}], majorEvents:[eventId], levelUps:0 } ],
  bets: [], hypeBefore, hypeAfter, totalTicks,
  summary: { winnerId, winnerName, photoFinish, forestAwakened, eventsCount, critsCount, upset, upsetOdds }, hash }
```
`ticks[0]` is the starting line (all `d = 0`). `pos` arrays are in **lane order** every tick. Ranks are computed per tick (ties by lane). A finished runner keeps `d = distance`.

### `SD.hype` (hype.js) — `add(state, amount, { by, reason }) → { value, crossed:[thresholdId] }` (emits `hype:changed`, `hype:threshold`), `tier(value) → 0|1|2|3`, `decayAfterRace(state)`, `idleDecay(state, elapsedMs)`, `nextThreshold(value)`.

### `SD.seasons` (seasons.js) — `advanceDay(state, rng)`, `resetDay(state)`, `endSeason(state) → summary`, `startSeason(state)`, `summary(state)`, `refundBets(state, reason)`, `refundEffects(state)` (summary shape: **M5 additions**).

### `SD.game` (game.js) — the director; every method wraps `SD.state.mutate`.
- `init()` — subscribes to `race:playbackDone` → `finishRace()`.
- `startRace({ distance?, runnerCount?, seed? } = {}) → { ok, message, record? }` — refuses if a race exists. Selects field, builds entrants, simulates, sets `currentRace = { record, status:'countdown', startedAt }`, emits `race:started { record }`. **Does not** reference playback; the UI's playback module listens for `race:started`.
- `setRaceStatus(status)` — used by playback for `countdown → running`.
- `pauseRace() / resumeRace()` — flips status, emits `race:paused` / `race:resumed`.
- `endRace()` — emits `race:endRequested` (playback jumps to the end and then emits `race:playbackDone`). In Node (no playback) `endRace()` calls `finishRace()` directly if `SD.playback` is undefined.
- `finishRace()` — applies `record.results` to runners/players, resolves bets, hype decay, pushes to `raceHistory`, clears `currentRace`, may auto-advance day, emits `race:finished { record, results, bets, levelUps, achievements }`.
- `abortRace()` — refund bets, drop record, emit `race:aborted`.
- `trainRunner(runnerId, stat, by) → result`, `restRunner(runnerId, by) → result` (used by roster card buttons and by `!train`/`!rest`).
- `triggerDayEvent(id?) → event`, `addHype(n, by?)`, `spawnRunner({ name? }) → runner`, `nextDay()`, `resetDay()`, `resetSeason()`, `resetAll()`, `updateSettings(patch)` (validates; emits `settings:changed`), `tickClock()` (call every 30 s from UI), `seedForRace() → uint32`, `replayLastRace() → { ok, sameHash }` (re-simulates last record with stored inputs and compares hashes).

### `SD.commands` (commands.js, M2+) — `parse(text)`, `register(def)`, `list()`, `process(msg)`, `handleChat({ username, displayName?, text, source, isMod, ts? }) → { ok, isCommand, command, message, effects, cooldownMs }`; `SD.processCommand(username, text, opts)` alias. Emits `chat:message { id, username, displayName, text, source, isMod, kind:'user'|'reply'|'system', ts }` and `command:result`. Details in **M2 additions** below.

### `SD.players` (players.js, M2+) — viewer profiles + Spirit Points ledger; see **M2 additions** below.

### `SD.leaderboards` (leaderboards.js, M3+) — six read-only boards (`top`, `rankOf`, `format`, `resolve`); see **M3 additions** below.

## UI API

### `SD.ui.dom` — `$(sel, root?)`, `$$(sel, root?)`, `el(tag, attrs?, children?)`, `esc(str)`, `fmt.int/pct/time`, `schedule(panel)` (marks dirty; renders each dirty panel once per rAF), `toast(text, severity)`.

### `SD.playback` (ui/playback.js) — no DOM; drives rAF.
- `load(record, opts?)`, `play()` (countdown then ticks; calls `SD.game.setRaceStatus('running')` when the countdown ends), `pause()`, `resume()`, `finish()` (jump to last tick, emit remaining events, then `race:playbackDone`), `stop()`, `seek(tick)`, `setSpeed(mult)`, `getFrame()`, `isPlaying()`, `currentTick()`.
- Listens: `race:started` → load+play, `race:paused`/`race:resumed`, `race:endRequested` → finish().
- Emits per frame `race:frame { tickFloat, phase, distance, runners:[{ id, d, progress, rank, v, st, fx }] , finished:[ids] }`; on integer tick `race:tick { tick, data }`, `race:phase { phase, tick }`, `race:event` (each record event whose tick was crossed), `race:runnerFinished { runnerId, place, timeSec }`, `race:countdown { secondsLeft }`, then `race:playbackDone { recordId }`.
- Speed: ticks-per-second by leader phase from `CONFIG.PLAYBACK.TPS` × `settings.playbackSpeed`; `FINAL_STRETCH` additionally × `settings.finalStretchSpeedup`.

### Panels — each exports `{ init(rootEl), render(state), destroy() }` on `SD.ui.<name>`; `main.js` calls `init` for every panel whose root exists in the DOM.

### UI additions (M1, all additive — nothing above changed)
- **`SD.ui.dom` extras**: `refs(root)` (collect `[data-ref]`), `ev(KEY)` (EVENTS key → name, derives `'race:runnerFinished'` style names if `SD.EVENTS` lacks a key), `on(KEY|name, fn) → unsubscribe`, `emit(KEY|name, payload)`, `state()`, `settings()`, `debugOn()`, `cfg('A.B', fallback)`, `clamp`, `num`, `safeColor`, `safeUrl`, `runnerVars(r)`, `badgeHTML(r, cls)`, `isRaceLocked()`, `confirmClick(btn, fn)` (two-click confirm), `info.{style, species, ability, abilityName, moodEmoji, dayEvent, thresholds, hypeTier, statCap, xpToNext}`, `flush()`; `fmt` also has `clockSec, hhmm, hhmmss, odds, signed, metres, ordinal, medal`; `toast(text, severity, { ms, who })`.
- **`SD.playback` extras**: also listens to `race:aborted` → `stop()` and `race:finished` → `stop()` unless playback already finished; adds `getMode()` (`idle|loaded|countdown|running|hold|done`), `isPaused()`, `getRecord()`. `race:frame` additionally carries `tick, totalTicks, leaderD, recordId, mode, paused` and each runner `lane`; `race:runnerFinished` carries `finishTick`; `race:countdown { secondsLeft: 0, skipped: true }` is emitted when END skips the countdown. Hidden-tab dt clamp uses `CONFIG.PLAYBACK.MAX_FRAME_DT_MS` (fallback 100 ms); `FINISH` leader phase uses the final-stretch speed-up too. `CONFIG.PLAYBACK.COUNTDOWN_S` / `FINISH_HOLD_MS` are read with fallbacks 3 s / 1500 ms.
- **Panel names / roots** (`main.js`): `header #header`, `track #track`, `results #results`, `roster #roster`, `chat #chat` (M2), `leaderboards #boards` (M3), `eventlog #eventlog`, `admin #admin`. The sidebar tab buttons are `.tabs [data-tab="chat|boards|log"]` with panels `#panel-chat|#panel-boards|#panel-log`; M2/M3 enable their tab (`disabled=false`) and mount inside the tab panel.
- **`SD.ui.results`** also exposes `show(raceFinishedPayload)`, `close()`, `isOpen()`; main.js wires `race:finished → show` and closes it on `race:started`. Closing emits the UI-internal bus event **`ui:resultsClosed`** (track returns to the paddock). Auto-close reads `settings.resultsAutoCloseMs` (fallback `CONFIG.UI.RESULTS_AUTO_CLOSE_MS`, then 25000; `0` disables).
- **main.js helpers**: `SD.ui.setOverlay(on)`, `toggleOverlay()`, `setAdmin(open)`, `toggleAdmin()`, `selectTab(name)`, `renderAll()`, `panels`, `booted`. Body state: `body.sd-overlay`, `body.sd-admin-open`, `body.sd-debug`, `body[data-hype-tier]`.

## Core implementation notes (M1 core; additive unless marked CHANGED)

**Shapes and semantics the UI can rely on**
- `state.season.activeDayEvent` is a day-event **id string** (e.g. `'fogOfTheHollow'`); resolve it with `SD.events.dayEventById(id)` or `SD.state.dayEvent()`.
- `runner.energy` / `runner.fatigue` may be **fractional** (passive regen every 30 s). Round for display. `fatigue` is hidden (0..120); chat sees `runner.condition`.
- RaceRecord tick precision: `d` 0.01 m, `v` 0.1 m/s, `st` 0.01. Unchanged `fx` arrays share one frozen empty array: treat `fx` as read-only.
- **fx tags** (present on every tick the effect is active): `crit`, `ability`, `boost` (chat boost or backfired sabotage), `sabotage`, `event:<raceEventId>` (e.g. `event:looseShoe`), `fade` (stamina ≤ 12%), `wall` (≤ 3%), `fog` (on every runner while Mysterious Fog is active; hide positions), `awakened` (Forest Awakened glow).
- **Event kinds / data**: `phase` `{phase}` (START at tick 0, then once each when the *leader* enters EARLY / MID / FINAL_TURN / FINAL_STRETCH); `event` `{eventId, targets:[ids], outcome?, durationTicks?, redirectedTo?, dodged?}` (ALL-target events have `runnerId: null`; fog has `durationTicks`); `ability` `{abilityId}`; `crit`; `overtake` `{passed, place}` (top-3 only, throttled); `chat` `{type:'boost'|'sabotage', by, backfire?}`; `wall`; `awakened`; `finish` `{place, timeSec, margin}`. Hidden debug events (`hidden: true`, `data.debug: true`) carry each Wild Card's `wildRoll` at tick 0. **Severity** is always `info | good | bad | epic`; `state.log` entries may also use `warn`.
- Events are sorted by tick (stable). Several events can share one tick.
- `results` are sorted by place. `margin` = metres behind the runner directly ahead; for the winner it is the lead over 2nd. `photoFinish` = winner margin < `CONFIG.RACE.PHOTO_FINISH_M`; `upset` = winner odds ≥ `CONFIG.RACE.UPSET_ODDS`.
- Extra RaceRecord fields: `inputs: { chatEffects, raceEffects, rosterAvgLevel }` (for replay and abort restore), `ticksStripped: true` on history records beyond `CONFIG.HISTORY_FULL_LOGS` (their `ticks` become `[]`). Entrant extras: `maxEnergy`, `fatigue`, `cheerBonus`, `form` (hidden per-race form), `rating`, `winProb` (implied probability behind `odds`). Result extras: `name`, `crits`, `overtakes`, `odds`, `ownerAtRace`. Summary extras: `winnerEmoji`, `margin`, `wallHits`, `timedOut`.
- **`race:finished` payload**: `{ record, results, bets, levelUps:[{runnerId, name, level, levelUps}], achievements, payouts, dayAdvanced: null | { seasonEnded, season, day, dayEvent, summary? } }`. It is emitted after `runner:levelup` events and before `season:ended` / `season:started` / `season:dayAdvanced` / `event:day`.
- `race:aborted { recordId, refunded, reset? }`, `event:day { event, manual }`, `season:dayAdvanced { seasonEnded, season, day, dayEvent, refunded, reset? }`, `season:ended { summary }`, `season:started { season }` (new `SD.EVENTS.SEASON_STARTED`), `runner:trained { runnerId, stat, by, result }`, `runner:rested { runnerId, by, result }`, `runner:condition { runnerId, from, to }`, `runner:spawned { runner, by }`, `hype:changed { value, delta, by, reason, tier }`, `hype:threshold { id, value, threshold, text }`, `settings:changed { patch, settings }`, `log:entry <entry>`.

**API additions**
- `SD.testing.strictRandom` (set by tools/load-core.js); `SD.clock.reset()`; `SD.util.round2/signed/ordinal/fmtDuration/capitalize`.
- `SD.rng.create(seed).shuffle(arr)`; `SD.bus.clear()` (tests).
- `SD.DATA` extras: `STAT_LABELS`, `STAT_SHORT`, `STAT_ALIASES` (for `!train spd`), `STYLE_ABILITIES`, `NAME_PARTS`, `CUSTOM_PERSONALITIES`, `CONDITION_EMOJI`, `REST_FLAVOUR`, `RACE_TEXT`. `RACE_EVENTS[]` also have `polarity: 'pos'|'neg'|'mixed'|'neutral'`, optional `messageBad` (mixed events) and `weightStat`. `DAY_EVENTS[]` have `weight` and `modifiers { eventRate, sigmaMult, critMult, poolMult, spMult, xpMult, statWeight:{stat:mult}, eventWeights:{eventId:mult} }` (normalised by `SD.events.dayModifiers(ev)`). `ABILITIES[id].rating` is an **odds-only** correction in perf points (fitted by the harness), not an engine effect. `DATA.STYLES[style].vel/drain` are the same arrays as `CONFIG.STYLES[style]` and `DATA.CONDITIONS` is `CONFIG.CONDITION.BANDS` (tune in config only). `ACHIEVEMENTS[]` carry a machine-readable `trigger` hint for achievements.js.
- `SD.state`: `create({ seedSalt?, settings?, roster?:false, dayEventId? })`, `defaultSettings()`, `isMutating()`, `runnersOwnedBy(user)`, `dayEvent()`; selectors take an optional explicit state as last argument. `findRunner` also matches ids and unique word prefixes ("comet" → Velvet Comet). `state.meta.actionCounter` seeds per-action randomness (training, spawns, day rolls) without `Math.random`. `settings.seedOverride` (null | uint32, used only when `settings.debug`), `settings.resultsAutoCloseMs`. `season.racesRun`, `season.startedAt`. Runner extras: `rosterKey`, `createdAt`, `speciesId` (random runners), `record.bestTimes {distance: sec}`, `daily { snacks }` (reset each day).
- `SD.persistence`: `exportFilename()`, `normalize(state)`, `validate(raw)`, `trimHistory(state, keepFull?)`, `recoverInterruptedRace(state)`, `readBackup()`, `storageKind() → 'localStorage'|'memory'`, `lastError()`, `lastSavedAt()`. `load()` never throws and never calls `state.set` (main.js does). `importJSON` sets state, saves and emits `state:loaded {source:'import'}` + `state:changed`. History beyond `CONFIG.HISTORY_MAX` (200) is dropped. main.js should call `SD.persistence.flush()` on `beforeunload`.
- `SD.runners`: `makeId(n)`, `nextId(state)`, `rollStats`, `sanitizeName`, `conditionBand/RaceMult/TrainMult`, `normalize(runner)`, `statTotal`, `styleName`, `freshRecord`. `spawnRandom(rng, { name, style, speciesId, abilityId, id })`. `perfScore(runnerLike, phase, statWeightMods?)`.
- `SD.training`: `train()` applies the **runner-side** effects itself (stat, energy, fatigue, condition, mood, streak, XP and level-ups) and returns `{ ok, outcome, stat, gain, energyCost, fatigueGain, message, hype, sp, xp, levelUps, level, conditionBefore, condition, conditionChanged, moodBefore, mood, moodChanged, by }`. Hype and SP are **returned** for the caller (`SD.game`) to apply. `rest()` returns `{ ok, message, energyGain, fatigueDrop, hype:-5, condition..., mood... }`. Also `chances(state, runner) → {critP, failP}`, `normalizeStat(str)`, `restCooldownLeft(runner, now?)`. A stat already at its cap is refused (no energy spent).
- `SD.events`: `dayModifiers(dayEventOrId)`, `rollDayEvent(rng, excludeId?)`.
- `SD.race`: `buildEntrants(runners, { distance, hypeLevel, dayEvent, cheerBonus })` (**CHANGED**: `distance` added, needed for `stamMax` and odds; default 1200). `simulate()` also accepts `rosterAvgLevel` (underdog XP) and `raceEffects` (stored for abort restore). Extra exports: `phaseIndexOf`, `distFactor`, `lookupByDistance`, `interpByDistance`, `stylePts`, `energyMult`, `ratingOf`, `oddsFeatures`, `assignOdds`.
- `SD.hype`: `add(state, amount, { by, reason, raw?, idle? }) → { value, delta, crossed }` (positive amounts × `settings.hypeMultiplier` unless `raw`), `set`, `effects(value)`, `multiplier(state)`, `syncThresholds`, `reset`.
- `SD.seasons`: `refundBets(state, reason)`. `advanceDay()` returns `{ seasonEnded, summary?, season, day, dayEvent, refunded }`. Summary shape: `{ number, day, championRunnerId, championName, championEmoji, championWins, mvpUsername, totalRaces, biggestUpset:{recordId, winnerId, winnerName, odds}|null, topHypeContributor:{username, hype}|null, achievements:[...], endedAt }`.
- `SD.game`: every method returns `{ ok:false, message }` on bad input instead of throwing. `trainRunner` / `restRunner` accept a runner id **or** a name query. `spawnRunner({ name, speciesId, style, abilityId, owner })` makes names unique ("Moss Runner 2"). `triggerDayEvent(id)` returns `null` for an unknown id and rolls a *different* event when no id is given. `updateSettings(patch) → { ok, settings, applied, rejected, message }` (numbers are clamped; unknown keys are rejected). `nextDay/resetDay/resetSeason` refuse while a race exists. `replayLastRace() → { ok, sameHash, hash, replayHash, recordId, record, message }`. Also `resolveRunner`, `replayInputs(record)`, `commit(label, fn(state, emit))` (mutate plus queued bus emits).
- **Optional later-milestone hooks** called by `SD.game` only when present: `SD.betting.lockForRace(state, record)` (startRace, M5), `SD.betting.resolveRace(state, record) → bets[]`, `SD.betting.refundAll(state, reason)`, `SD.players.applyRaceResults(state, record) → payouts[]`, `SD.players.award(state, username, amount, reason)`, `SD.players.onNewDay(state)`, `SD.players.onSeasonEnd(state)`, `SD.players.normalize(player)`, `SD.achievements.checkRace(state, record) → unlocked[]`.

**Tuning (tools/balance-test.js)** — M1 values; **CHANGED in M4** (`PERF_SLOPE`, noise / form, stamina pool, `DIST_FACTOR`, moods, odds: see **M4 additions**). Every number lives in `SD.CONFIG` (plus ability magnitudes in `SD.DATA.ABILITIES`). Values that differed from the plan's starting numbers after M1, and why:
- `PERF_SLOPE` 0.24: compresses the roster into 5–40% win rates while a +20 Speed clone still wins about 40%.
- `STAMINA.DRAIN_SCALE` 0.815 and `DIST_FACTOR` {0.92, 1.04, 1.20, 1.40}: fresh runners are Excellent + Happy (about 1.07× speed), so they need a lower drain scale. 1200 m is a sprint and 2400 m punishes low stamina.
- Style tables (Front Runner drain 1.04/1.00, Late Surger 0.965→1.11, Wild Card 1.0025 / σ×1.15 / roll 0.96–1.025) balance style-clone fields to 19–30% at every distance.
- `CRIT.PER_LUCK` 0.00005.
- `WILD.LUCK_TILT`: Luck lowers a Wild Card's collapse chance.
- Odds: `ODDS.TEMP` 5.7, per-distance `STYLE_PTS`, `REMAIN_PTS` / `SHORTFALL_PTS` / `REMAIN_CAP`. Calibrated by maximum likelihood; mean |implied − actual| is about 1.5 points.
- Ability magnitude changes: Second Wind +15%, Thunder Step +30% ×3, Comet Tail +9%, Reading the Wind +5%, Acorn Hoard +22%/6 ticks, Long Night 14% / pool ×1.06, Afterglow max 10%, Hedge Hop adds a +12%/10-tick spring on a successful hop.

## M2 additions (players, command pipeline, simulated chat) — additive

### `SD.players` (js/players.js)
All functions take the state explicitly and are meant to run inside `SD.state.mutate` (the pipeline / `SD.game` wrap them). Validation happens before any write.
- **Player** (plan §2, exact keys): `{ username /*lowercase key*/, displayName, joinedAt, lastSeen, lastDailyDay, spiritPoints, runnerId, isMod, stats:{commands, trains, rests, cheers, bets, betsWon, sabotages, boosts, racesParticipated, raceVictories, hypeContributed, spEarnedTotal, spSpentTotal}, lifetime:{same keys}, achievements:[], backing:{ runnerId, actions } }`. `state.players` is keyed by `username`. **`lifetime` holds completed seasons** (rolled in by `onSeasonEnd`); all-time = `lifetime + stats`. `spEarnedTotal` includes the join bonus.
- Names: `cleanName(name)` (strip leading `@`, collapse whitespace, max 25), `keyOf(name)` (= cleanName lowercased). `runner.owner` stores the owner's **displayName**; always compare owners with `keyOf()`.
- `create(username, displayName, opts)` (pure), `normalize(player)`, `get(state, username)`, `all(state)`.
- `ensure(state, username, displayName, { source, isMod, now }) → { player, created }` — creates with `CONFIG.ECONOMY.JOIN_SP` (200) and marks today as used (no extra daily bonus on the join day); emits `player:joined`, `player:sp`, logs.
- `touch(state, username, { isMod?, displayName?, now?, count? }) → { player, dailyBonus }` — `lastSeen`, `stats.commands++`, `DAILY_SP` (+50) on the first action of each in-game day. The pipeline touches after every **successful** command, so `stats.commands` counts successful commands (read-only ones are throttled since M3, see **M3 additions**) and the daily bonus comes with the first successful command of the day. `lastDailyDay` is the day key `'s<season>d<day>'` (`dayKey(state)`). `isMod` is only updated when passed (the pipeline never passes it for source `admin`, so SEND AS cannot turn a viewer into a mod).
- `join(state, username, displayName, opts) → { player, created, dailyBonus }` = ensure + touch.
- `addSp(state, u, amount, reason) → { ok, balance, amount }`, `spendSp(...) → { ok, balance, amount, message? }` (refused without writing when the balance is too low; never negative), `award(state, u, amount, reason) → number awarded` (0 when the player does not exist). All emit `player:sp { username, displayName, delta, balance, reason }`.
- `claim(state, u, runnerId) → { ok, message, runner?, released? }` — one runner per player; claiming your own or someone else's runner is refused (the refusal names the owner and lists up to 3 free runners); re-claiming releases the old runner. Emits `runner:claimed { runnerId, username, displayName, releasedRunnerId }`. `release(state, u)`, `runnerOf(state, u)` (validated against `runner.owner`), `freeRunners(state)`.
- `recordAction(state, u, runnerId, kind)` — `kind` train/rest/cheer/bet/sabotage/boost bumps the matching `stats` counter; supportive kinds (train, rest, cheer, boost, snack) update **backing** with a majority-vote counter (acting on the backed runner +1, on another −1, switch at 0; ties go to the most recent) so `backing.runnerId` is the runner you acted on most since the last race whenever one runner got most of your actions. `addHypeContribution(state, u, delta)`.
- Hooks: `applyRaceResults(state, record) → payouts[{ username, displayName, runnerId, runnerName, place, amount, role:'owner'|'backer' }]` (owners get `result.spOwner`, non-owner backers of a runner in the field get `result.spBacker`; each player counts once in `racesParticipated`, and in `raceVictories` when their owned/backed runner won; backing resets for players whose backed runner raced, others keep it; one `sp` log line), `award`, `onNewDay` (no-op: the bonus is keyed on `lastDailyDay`), `onSeasonEnd` (stats → lifetime, SP = `SEASON_BASE_SP` + 10 % carry, `runnerId`/backing cleared), `normalize`.

### `SD.commands` (js/commands.js)
- **Pipeline** (exact order): parse → lookup (unknown → `Unknown command !foo — try !help`) → admin permission (`source === 'admin'` or `isMod`) → player gate (`You're not in the derby yet — type !join`; `requiresRunner` → `type !claim`) → race lock via `SD.state.isRaceLocked()` (`Hold on — a race is running! Try again after the results.`) → per-user cooldown → arity (`Usage: …`) → handler inside `SD.state.mutate('cmd:' + name)` → on success `SD.players.touch` (daily bonus appended to the reply) → cooldown stamped **only on ok** → `chat:message` (kind `reply`) + `command:result`.
- **Cooldowns** live in `SD.state.runtime.cooldowns[username][cooldownKey || name] = lastSuccessTs`. Length: `def.cooldownMs` (number or `fn(ctx)`) else `settings.userCooldownS × 1000` (default `CONFIG.COOLDOWNS.USER_S` = 10 s, read at check time). `!cheer` uses `CONFIG.ECONOMY.CHEER_COOLDOWN_S` if defined, else `CONFIG.COOLDOWNS.CHEER_S` (30 s). Read-only commands (`!join !status !inspect !race !event !help`) have `cooldownMs: 0`. **Source `admin` (the streamer's own console: chat "Streamer" sender and SEND AS) skips cooldowns** and the open-training restriction.
- **Command def**: `register({ name, aliases, usage, description, admin, requiresPlayer, requiresRunner, lockedDuringRace, cooldownMs, cooldownKey, minArgs, hidden, handler(ctx, args) })`; re-registering a name replaces it (M5 can extend `!race`/`!event`). `ctx = { state, username /*key*/, displayName, source, isMod, player, parsed, args, argText, command, now, effects:[], touched }`. A handler returns a string or `{ ok?, message, severity?, effects? }`; it rejects **before any write** with `throw new SD.commands.CommandError(message, { severity?, cooldownMs? })` (`new` optional) — nothing is emitted by `mutate`, no cooldown is stamped. Unexpected exceptions become a friendly reply plus a `warn` log line.
- `parse(text) → null | { name, invoked, args, argText, text }` — must start with `!`, name `[a-z0-9_]+` (lowercased), args split on whitespace with leading `@` stripped, zero-width chat-client characters removed. Built-in aliases (resolved even before the target exists): `t→train, lb→leaderboard, stats→status, r→rest, c→cheer, i→inspect, h/commands→help`; registered `aliases` also resolve; a registered name wins over an alias.
- Other exports: `unregister(name)`, `get(name) → def copy | null`, `list({ all? }) → def copies` (no handlers, registration order, hidden excluded), `process(msg)` (pipeline for an already-identified command, no `user` line), `system(text, severity)` (dim `system` line), `cooldownLeft(username, name, now?) → ms`, `resolveName(raw)`, `BUILTIN_ALIASES`.
- **Results**: `handleChat` → `{ ok, isCommand, command, message, effects, cooldownMs, severity, id, unknown?, cooldown?, locked? }`; plain chat → `{ ok:true, isCommand:false, command:null, message:'' }`. `cooldownMs` = remaining ms on a cooldown refusal, the stamped length on success. `effects` items: `{type:'sp', amount, reason}`, `{type:'hype', delta}`, `{type:'train', runnerId, stat, gain, outcome, energyCost}`, `{type:'rest', runnerId, energyGain}`, `{type:'cheer', runnerId, queued}`, `{type:'claim', runnerId, released}`, `{type:'join', created}`.
- **`chat:message`** extras: `severity` (`info|good|bad|epic`), `command`, `ok`, `replyTo` (id of the user line), `isCommand` (user lines), `unknown` / `cooldown` / `locked` flags on replies. Every line is also appended to `SD.state.runtime.chatFeed` (cap 80). **`command:result`** `{ id, username, displayName, source, isMod, command, invoked, args, ok, message, severity, effects, cooldownMs, ts }`.
- Replies are one line (training / rest feedback joined with `' · '`), aimed at ≤ ~200 chars, hard-capped at 400.
- **M2 commands**: `!join`, `!claim [runner]` (first free runner when unnamed), `!train <stat> | <runner> <stat>` (`<stat> <runner>` also accepted; default = your runner; any runner while `settings.openTraining`, else only your own; calls `SD.game.trainRunner(id, stat, username)` — which awards the training SP through `SD.players.award` — then `recordAction` + hype contribution), `!rest [runner]` (`SD.game.restRunner`; runner rest cooldown checked first), `!cheer [runner]` (allowed mid-race; `SD.hype.add(GAINS.cheer)` × `hypeMultiplier`, `CHEER_SP` × day `spMult`; a named runner outside a race gets a merged `{ type:'cheer', runnerId, by, count }` in `state.raceEffects`; a Nervous runner turns Happy after `CONFIG.MOOD.NERVOUS_CURE_CHEERS` (10) such cheers, counted in `SD.state.runtime.nervousCheers[runnerId]`; mid-race only hype; reply `The forest hears you! Hype +3 (42/120) · …`), `!status` (alias stats), `!inspect [runner]` (style, owner, stats, energy, condition, mood, record, next-race odds from `SD.game.previewField()` + `buildEntrants` like the paddock, or live odds when racing, ability name + first sentence), `!race` / `!event` (read-only status lines; mod actions are M5), `!help [command]`. TODO markers in the file: M5 `!bet !boost !snack !sabotage !ribbon` + mod `!race`/`!event`, M6 `!create`.
- Commands never touch `state.currentRace`; spam cannot corrupt a race (lock + `startRace` refusal; tested).

### UI (M2)
- **`SD.ui.chat`** (js/ui/chat.js, root `#chat` inside `#panel-chat`): `init` enables `#tab-chat` (removes the "M2" badge); main.js opens the Chat tab by default unless another tab was saved. Append-only feed (80 rows; user lines = coloured name chip (hash of the username, 🎙 streamer, 🛡 mod) + text, replies indented with `↳ @Name` in severity colour, dim italic system lines for race start/finish/cancel and hype thresholds). Input row: `@Name: text` or `Name: text` speaks as Name (casing taken from the existing player), otherwise as the `<select>` sender (Streamer = source `admin`, isMod; others source `sim`); Enter submits via `SD.commands.handleChat`, keeps focus, remembers the sender. Extra methods: `send(name, text)`, `setBots(on)`, `botStep()`, `botLine(state, name)`, `system(text, sev)`.
- **Demo bots**: `🤖 Demo bots` toggle; every 2–4 s one of FoxFan, MothMom, AcornAndy, WispWatcher, BrambleBob, LanternLiz speaks. Unjoined → `!join`; no runner → `!claim [free runner]`; otherwise weighted `!train` (own runner, or any runner by short name with open training), `!cheer [runner]`, `!rest` (likely when energy < 35), `!status`, `!inspect`, `!race` and plain chatter. They skip commands on cooldown (`SD.commands.cooldownLeft`); during a race they mostly cheer. Bots use `Math.random` (UI only).
- **Overlay**: with `body.sd-overlay`, every `reply` (except unknown-command replies, so other bots' `!discord`-style commands don't pop up on stream) is also shown via `SD.ui.dom.toast(text, severity, { who:'@Name' })` in the reply-toast strip.
- **Admin SEND AS**: sender `<select>` (Streamer, Mod, then the 12 most recently active players) + command input (Enter or SEND) → `SD.processCommand(name, text, { source:'admin', isMod:true, displayName:name })`; the reply is shown inline (`.adm-reply sev-*`).
- CSS: `.chat*` block and `.adm-reply` in css/panels.css (≥ 16 px text; teal only as the bots-on glow).

### Tools
- `tools/parser-test.js` — assertion suite for parse / pipeline / players (frozen `SD.clock`, fixed seed salt 424242, day event `clearSkies`). `--verbose` prints every PASS.
- `tools/run-tests.js` — runs `balance-test.js --races 1000 --matrix --quick` and `parser-test.js` as child processes, prints a summary, exits 1 on any failure. (300 races is too few: the odds-calibration assertion then fails deterministically on sampling noise; 1000 + `--quick` runs in ~4 s.)

## M3 additions (progression + leaderboards) — additive unless marked CHANGED

### Progression (verified, plan §6.3)
- `SD.runners.addXp(runner, amount)` is pure (no bus): `xpToNext(L) = 60 + 20(L−1)` (`CONFIG.PROGRESSION.XP_BASE / XP_PER_LEVEL`), stops at `MAX_LEVEL` 20 (xp is then capped at `xpToNext(20)`; `totalXp` keeps counting). Each level: stat cap `60 + 4L` (+4), `maxEnergy` +2 (current energy grows by the same amount), +1 to every stat (clamped to the new cap). The **director** applies the rest for both XP sources: `SD.game.trainRunner` and `SD.game.finishRace` add hype `levelUps × PROGRESSION.LEVELUP_HYPE` (+8), log `"<name> reached level <n>!"` and emit `runner:levelup { runnerId, name, level, levelUps }` (race level-ups are emitted before `race:finished`, whose payload lists them in `levelUps`).
- **CHANGED** `SD.seasons.endSeason` now also resets `runner.totalXp = 0`: `runner.totalXp` is **season** XP, `runner.lifetime.totalXp` is all-time (it already included the current season, like `lifetime.races/wins`).

### `SD.leaderboards` (js/leaderboards.js, core, read-only)
- `CATEGORIES` — ordered: `runnerWins` (short `wins`), `runnerXp` (`xp`), `spiritPoints` (`sp`, `points`), `participation` (`part`, `active`), `raceVictories` (`victories`, `wins-player`), `hypeContributions` (`hype`). Each `{ id, name, short, chip, noun, icon, kind:'runner'|'player', unit:[singular, plural], unitAll?, desc, empty, aliases }`. `SCOPES = ['season','all']`.
- Values (each board is one independent metric; only the SP board counts SP):

  | Board | season (default) | all-time (`scope 'all'`) |
  |---|---|---|
  | runnerWins | `runner.record.wins` | `runner.lifetime.wins` |
  | runnerXp | `runner.totalXp` | `runner.lifetime.totalXp` |
  | spiritPoints | `player.spiritPoints` (balance) | `lifetime.spEarnedTotal + stats.spEarnedTotal` (label "SP earned") |
  | participation | Σ `stats[k] × CONFIG.LEADERBOARDS.PARTICIPATION[k]` = commands + trains×2 + cheers + rests + bets | same over `lifetime + stats` |
  | raceVictories | `stats.raceVictories` | `lifetime + stats` |
  | hypeContributions | `stats.hypeContributed` | `lifetime + stats` |

  Season boards skip retired runners; all-time boards include them. The hype board reads the per-player counter (the commands add to it); `state.hype.contributions` stays the source for the season summary's top hype contributor.
- `top(state, categoryId, n = CONFIG.LEADERBOARDS.TOP_N (10), scope = 'season' | { scope })` → `[{ rank, id, kind, name, value, label, category, scope, … }]`. Values are rounded to 0.1; entries with value 0 are omitted; sorted by value desc, then name, then id; **ties share a rank** (1, 2, 2, 4). Runner entries add `emoji, badgeColor, ribbonColor, avatarUrl, level, owner` (the owner's display name or `null`), `retired`; player entries (`id` = username key, `name` = displayName) add `runnerId, runnerName, runnerEmoji` for their claimed runner (or `null`). `categoryId` may be an alias.
- `all(state, categoryId, scope)` — the full ranked list. `rankOf(state, categoryId, id, scope)` → `{ rank, value, label, total } | null` (`id` = runner id or name / player username or display name; `null` when not on the board). `resolve(alias) → categoryId | null` (case and punctuation insensitive). `resolveScope(word) → 'season' | 'all' | null` (`all`, `all-time`, `alltime`, `lifetime`, `ever`, `total`, `overall`; `season`, `current`). `get(idOrAlias) → category | null`.
- `format(state, categoryId, n = CHAT_TOP_N (3), scope)` → one chat line, e.g. `🏆 Runner wins: 1. Velvet Comet (3) · 2. Moss Runner (2) · 3. Ember Tail (1)`; all-time adds ` (all-time)` after the name; an empty board prints the category's `empty` text; unknown category → `''`.
- `leader(state, scope) → { entries, names, wins, count } | null` (rank-1 runners by wins), `participation(player, scope)`, `fmtNum(v)` (locale-free: `1,240`, `12.5`).
- `CONFIG.LEADERBOARDS = { TOP_N: 10, CHAT_TOP_N: 3, PARTICIPATION: { commands:1, trains:2, cheers:1, rests:1, bets:1 }, READONLY_ACTIVITY_S: 10, RANK_BOARDS: ['spiritPoints','raceVictories','hypeContributions'], LEADER_NAMES: 2 }`.

### Commands (js/commands.js)
- `!leaderboard [board] [all]` (aliases `!lb`, `!top`): read-only, `cooldownMs: 0`, not race-locked, no `!join` needed, always `ok: true`, severity `info`. Default board `spiritPoints`; the no-argument reply appends `· More: !lb wins | xp | part | victories | hype`. Args may come in any order (`!lb wins all`, `!lb all wins`). An unknown board replies `No board called "x". Boards: wins, xp, sp, part, victories, hype (e.g. !lb wins, add "all" for all-time).`
- `!rank [viewer]`: read-only, `cooldownMs: 0`: `FoxFan: #2 in SP (357) · #1 in victories (1) · #5 in hype (6.6)` over `CONFIG.LEADERBOARDS.RANK_BOARDS` (`unranked in …` when the value is 0). Without an argument the sender must have joined (`CommandError` "type !join"); `!rank <viewer>` looks up another player.
- `!status` adds `#<n> in SP` right after the SP balance (via `rankOf`).
- **CHANGED (anti-spam)**: a read-only command (`def.cooldownMs === 0`: `!join !status !inspect !race !event !help !leaderboard !rank`) bumps `stats.commands` at most once per `CONFIG.LEADERBOARDS.READONLY_ACTIVITY_S` (10 s) per viewer; mutating commands always count. Tracked in the non-persisted `SD.state.runtime.activity[username]` (stamped only when the command succeeded for an existing player). `ctx.countActivity` is passed to `SD.players.touch({ count })`; `SD.players.join(…, { count })` forwards it.
- `list()` order is now `join … help, leaderboard, rank`.

### UI (M3)
- **`SD.ui.leaderboards`** (js/ui/leaderboards.js, root `#boards` inside `#panel-boards`): `init` enables `#tab-boards` (removes the "M3" badge and any placeholder); tab switching is main.js's `selectTab`, like Chat/Log. Six chips (3×2 grid, `aria-pressed`), a Season / All-time toggle, a description line (Runners/Viewers tag + desc + "Season n · Day d" or "All seasons"), the top 10 (🥇🥈🥉 for ranks 1–3, shared on ties; runner badge or a viewer initial chip coloured like chat names; runner rows show `Lv n · 👤 owner`, viewer rows their runner; value + unit on the right), `+n more on this board`, an empty-state line, and a chat-hint footer. The streamer's rows are not special-cased. The choice is remembered in `spiritderby.ui` as `boards: { category, scope }`. Re-renders via `dom.schedule` on `state:changed`, `state:loaded`, `race:finished`, `season:ended`, `player:joined`, `runner:claimed`. Extra method: `select(category|null, scope|null)`.
- **Roster**: the XP bar shows `xp/xpToNext` (title "to level n+1"); at `MAX_LEVEL` the bar is full gold with `MAX` and the level pill reads `Lv 20 MAX`. On `runner:levelup`: a toast `⬆ Moss Runner reached level 3!` and the gold `sd-levelup-ring` on the card, its badge and its Lv pill (3.3 s). A ring for a level-up that happens while the results modal is open (race level-ups are emitted just before `race:finished`) is queued and plays on `ui:resultsClosed`.
- **Paddock**: under the "Next race" line, `👑 Leader: Velvet Comet (3 wins)` (ties: `👑 Leaders: A & B (2 wins each)`; more than `LEADER_NAMES` → `+n more`) once any runner has a season win (`SD.leaderboards.leader`, with a plain fallback). The header is unchanged.
- **Chat**: the demo bots occasionally send `!lb …` / `!top sp` / `!rank`; the hint line mentions `!lb wins` and `!rank`.
- CSS: `.boards*`, `.lbchip*`, `.lbrow*`, `.sbar--max`, `.pill--max`, `.rcard--levelup` badge/pill rings in css/panels.css; `.paddock__leader` in css/track.css (all ≥ 16 px).

### Tools
- `tools/progression-test.js` — XP/levels, level-up side effects, leaderboards (ordering, ties, scope, participation, format, rankOf), `!leaderboard/!lb/!top/!rank/!status`, the read-only anti-spam rule, and a seeded 4-owner race updating runnerWins / raceVictories / runnerXp plus the season rollover. Wired into `tools/run-tests.js` (suite `progression`).
- parser-test.js updates: `!lb` is registered, `list()` includes `leaderboard, rank`, and a repeated read-only `!join` inside the activity window counts once.

## M4 additions (advanced race systems + balance) — additive unless marked CHANGED

### Balance model (CHANGED, plan §5.1 / §6.6)
Goal from the brief: stats matter substantially, randomness influences races without overriding investment, and mood / condition never decide a race on their own. Before M4 the engine was nearly deterministic at race level (slope 0.24, ~1.6% race-level noise), so a 2–5% condition + mood gap beat 20 stat points: in the brief's 4-runner case Velvet Comet (best stats, Good + Sleepy) won 0.9%, and 48% when made Happy + Excellent.
- **Stats**: `RACE.PERF_SLOPE` 0.24 → **0.5** (10 phase-weighted perf points = 5% speed). `SD.race.coreOf(perf) = 1 + PERF_SLOPE × (perf − PERF_PIVOT) / 100`.
- **Race-level randomness** roughly doubled: per-race "day" form `FORM.AMP` 0.04 → **0.08** (sd ≈ 2.8%); in-race swing `NOISE.SIGMA` 0.12 → **0.20**, `SEGMENT_TICKS` 6 → **a per-distance table {1200: 8, 1600: 10, 2000: 12, 2400: 15}** (a number still works; read through `SD.race.segmentTicks(distance)`, so every race has ~20 swings and the race-level luck is about the same at every distance), new **`NOISE.RHO` 0.65**: each new segment is `seg = RHO × seg + sqrt(1 − RHO²) × sigma × tri()` (AR(1); still one rng draw per segment, `RHO = 0` reproduces the old i.i.d. segments), so good and bad spells last ~30 ticks and do not average out. In identical-clone fields the best-form clone wins ~42% (not a coin flip, not decisive).
- **CHANGED semantics — condition and energy scale effective stats, not velocity**: `core[p] = coreOf(perf[p] × SD.race.raceStatMult(entrant))` with `raceStatMult(e) = conditionRaceMult(e.condition) × energyMult(e.energy, e.maxEnergy)`. The band values are unchanged (Excellent 1.03, Good 1.01, Normal 1.00, Tired 0.96, Exhausted 0.90; energy below half down to ×0.92) and the velocity product no longer contains them. An Exhausted average runner loses ~5 perf points (≈ 2.6% speed); a well-trained Tired runner can still beat a weak fresh one. (As plain velocity multipliers, 0.90 vs 1.03 = 12.6% would need ~13% race noise for the "Exhausted clone ≥ 2.5%" target, which would erase stats.)
- **Moods** (`DATA.MOODS[m].vel`, race-level effect ≤ ±0.6%): Happy +0.4% all phases; Determined +1.2% FINAL_TURN + FINAL_STRETCH; Fired Up +2% START + EARLY (drain ×1.05); Sleepy −1% START only (drain ×0.95, regen ×1.3); Nervous −0.4% (σ ×1.2); Chaotic 0 (σ ×1.3, was 1.5; crits ×1.5). Descriptions updated.
- **Stamina**: pool = `(STAMINA.BASE + sta / STA_DIV) × POOL_SCALE × DIST_FACTOR` with `BASE` 0.9 → **0.5**, `STA_DIV` 100 → **50** (Stamina counts double; a 40-Stamina pool is unchanged) and `DIST_FACTOR` {1200: 0.92, 1600: **1.02**, 2000: **1.10**, 2400: **1.20**} (was 1.04 / 1.20 / 1.40). Nobody tires at 1200 m; at 2400 m low-Stamina, faster runners fade (Ember Tail every race, wall ~1 in 3 even with Second Wind; Glow Wisp / Thunder Fern often), Moonhoof never. `DRAIN_SCALE` 0.815 unchanged.
- **Odds refit** (maximum likelihood, 24,000 races: roster fields + mixed fields at levels 1–8 with random condition / mood / energy): **`ODDS.TEMP` may now be a per-distance table** {1200: 6.28, 1600: 5.77, 2000: 5.44, 2400: 5.23} read through `SD.race.oddsTemp(distance)` (a number still works); `REMAIN_PTS` 10.41, `SHORTFALL_PTS` 8.86, `REMAIN_CAP` 0.38, `SAFE_REMAIN` 0.14, new `STYLE_PTS` and `ABILITIES[*].rating`. `oddsFeatures().formPts` = `perfAvg × (raceStatMult − 1)` + (mood + cheer + wild-roll mean) × 100 / PERF_SLOPE. Roster calibration: mean |implied − actual| 0.5–1.4 pp per distance (was 1.2–2.5); mixed fields: every probability bucket within ~1.5 pp.
- Style tables, `CONDITION.BANDS`, crits, events and ability magnitudes are unchanged (style clones stay 22–29% per style at every distance).
- The sensitivity targets hold at every distance, not just the default 1600 m harness distance (e.g. +8 every stat 36.6% @1200 → 42.1% @2400; Chaotic ≤ 14.4%; Good ≥ 9.3%).

Measured (tools/balance-test.js, 8-runner clone fields, 2000 races @1600 m): identical clones 11.1–13.5%; one clone Good 11.7% / Tired 7.9% / Exhausted 4.2% (others Excellent); one clone Determined 13.5% / Nervous 10.2% / Fired Up 12.8% / Sleepy 10.0% / Chaotic 14.1% (others Happy); +20 Speed 32.3%; +8 every stat 37.3%; +20 Stamina 24.3% @1200 → 29.6% @2400. Brief's 4-runner case @1200 m: Thunder Fern 24.5%, Moonhoof 21.2%, Moss Runner 24.3%, Velvet Comet 30.1% (35.7% when Happy + Excellent). Roster averages over the matrix 6.4% (Bramble Jack) – 21.3% (Velvet Comet); Ember Tail 14.3% @1200 → 4.9% @2400, Moonhoof 13.1% → 17.9%.

### Race engine additions (js/race.js, js/game.js)
- **Cheers are visible**: `simulate({ chatEffects })` accepts `{ runnerId, type:'cheer', by, count }`. Each cheered runner gets one `chat` event at tick 1, `data: { type:'cheer', by /*first viewer*/, names:[...], count, bonus }` (text: "FoxFan & MothMom cheer Moss Runner on! The crowd lifts them (+0.35%)."), and fx `boost` for `CHAT.CHEER_GLOW_TICKS` (6) ticks. Bonus = `min(CHEER_CAP, max(entrant.cheerBonus, count × CHEER_PER))` — the entrant's pre-race `cheerBonus` and the cheer chat effects are the same crowd, never added twice. `SD.game.startRace` now passes queued cheers both as `cheerBonus` (for odds) and as cheer chat effects (for names), and maps every chat effect's `by` (a username key) to the player's display name. `record.inputs.chatEffects` therefore includes cheers (replay unchanged: same inputs → same hash).
- **Sabotage respects the negative cooldown**: a due sabotage (not a backfire) waits until its target is `EVENTS.NEG_COOLDOWN` (30) ticks clear of its last bad event / sabotage, so no runner gets two negatives within 30 ticks from any source.
- **Every queued chat effect appears in the record**: a boost / sabotage that never fired (runner finished first, or a sabotage still waiting) gets `chat` `{ type, by, fizzled:true }` at the runner's finish tick ("FoxFan's boost never caught up with Moss Runner.", severity `info`).
- `chat` event data is now `{ type:'boost'|'sabotage'|'cheer', by, backfire?, fizzled?, names?, count?, bonus? }`. No new fx tags (the cheer glow uses `boost`).
- New `SD.race` exports: `raceStatMult(entrant)`, `coreOf(perf)`, `oddsTemp(distance)`, `segmentTicks(distance)`, `ENGINE_VERSION` (2 since M4).
- RaceRecord extra: `engineVersion`. `SD.game.replayLastRace()` returns `{ ok:false, stale:true, recordId, message }` for a record without it or from another engine version (a race saved before M4 cannot replay to the same hash; the admin REPLAY button shows the message instead of "determinism broken").
- Verified unchanged: all 16 race events, 7 day events (every modifier — `eventRate`, `sigmaMult`, `critMult`, `poolMult`, `spMult`, `xpMult`, `statWeight`, `eventWeights` — measurably changes races), hype tiers, Forest Awakened, photo finish / upset flags (+15 hype each in `finishRace`), `replayLastRace()`.
- Playback length (default settings, `CONFIG.PLAYBACK.TPS` × final-stretch speed-up 1.75): 1200 m ≈ 161 ticks / 18 s running (+3 s countdown, +1.5 s hold ≈ 23 s), 1600 m ≈ 214 / 24 s, 2000 m ≈ 267 / 30 s, 2400 m ≈ 321 / 36.5 s (≈ 41 s total). The leader's final stretch plays in ~1–2 s at every distance.

### Tools
- **`tools/race-test.js`** (suite `race` in run-tests, ~7 s): A distances + playback estimate; B the 10 abilities (activations per 100 races per distance, and each mechanic: Thunder Step only on real MID / FINAL_TURN overtakes with its cooldown, Second Wind below 12% and ~99% of 2400 m races, Long Night = stamina left × 14%, Afterglow = 2% per runner ahead capped at 10%, Forest's Favor always when 3rd–5th, Comet Tail never when leading, Reading the Wind at 50% + Wis/200, Acorn Hoard only without an earlier crit, Hedge Hop redirects onto a runner ahead at 50% + Luck/200); C all 16 events on normal and chaos, frequency none < low < normal < high < chaos, per-race caps, min gap, the 30-tick negative rule (events + sabotage), one sample message per event; D hype tiers (identical races within a tier, feral ×1.5 events / ×1.25 crits, Awakened exactly once with pool restore, last-place lift, SP ×1.5); E condition bands, `raceStatMult`, passive clock, mood after race by place / after training crit or fail / after rest; F chat effects (names, fx, backfire from target Wisdom, caps); G photo finish / upset flags and finishRace hype; H replay (game replays, JSON round trip with ticks stripped); I day events.
- **`tools/balance-test.js`**: new M4 sensitivity block (see its header; ≥ 2000 races per check), the brief's 4-runner case, odds calibration on mixed fields, and `--streamday` now asserts the runner reaches **Exhausted** and prints the race penalty (e.g. "Exhausted with 16 energy → race-day stats ×0.852; odds 4.1x vs 1.6x if fresh"). **Changed bound**: "+20 Speed ≥ 35%" → "+20 Speed in 25–45%" (justified in the header; "+8 to every stat ≥ 35%" carries the intent).
- `tools/run-tests.js` runs balance with `--streamday` and the new `race` suite.

## M5 additions (community: betting, chat effects, achievements, seasons) — additive unless marked CHANGED

Spirit Points stay fictional: nothing in M5 touches real money. Every SP move goes through `SD.players` (`spendSp`, `addSp`, new `refundSp`).

### `SD.betting` (js/betting.js, core)
- `fieldOdds(state) → { key, distance, field:[Runner], entrants:[Entrant], byId:{runnerId: Entrant}, favourite }` — the NEXT race: `SD.game.previewField()` + `SD.race.buildEntrants(field, { distance, hypeLevel, dayEvent, cheerBonus })` where `cheerBonus` = queued cheer counts (exactly what `startRace` passes). Cached per `seedSalt | raceCounter | season/day | distance | runnerCount | hype | day event | seed override` + every field runner's id / level / style / mood / condition / energy / owner / ability / stats / queued cheers; the cache returns the same object while nothing changed (treat it as read-only). The paddock, `!inspect`, `!race`, `!odds` and `!bet` all use it.
- `odds(state, runnerId) → { odds, winProb } | null` (null = not in the next field). `payoutFor(amount, odds) = floor(round(amount × odds, CONFIG.BETTING.PAYOUT_ROUND))` (10 × 2.3 pays 23). `fmtOdds(x)`.
- `place(state, username, runnerId, amount | 'all', now) → { ok, message, bet, replaced, refunded, balance, pays, hype }` — validation first (joined, no race, runner in the next field, integer `BET_MIN ≤ amount ≤ min(BET_MAX, balance + stake of the bet it replaces)`, not identical to the open bet); then refund + remove the old bet, `spendSp`, push the bet, `recordAction(…, 'bet')` + hype `GAINS.bet` (+1 × hype multiplier, contribution recorded) **only for a new bet** (`CONFIG.BETTING.COUNT_REPLACEMENTS` false), log, emit `bet:placed { bet, username, displayName, replaced, refunded, balance }`. `'all'` = `min(BET_MAX, balance + old stake)`.
- **Bet** `{ id:'b<n>' (state.meta.betCounter), username, displayName, runnerId, runnerName, amount, odds /*locked*/, winProb, placedAt, raceNumber, season, day, recordId? /*set at the gate*/ }` in `state.bets` (one per player).
- `cancel(state, username)`, `betOf(state, username)`, `list(state)`, `open(state) → { count, total, byRunner:{ runnerId:{ count, total, name } } }`, `clearCache()` (tests).
- **Hooks for `SD.game`:** `lockForRace(state, record)` (**new hook, CHANGED game.js**: `startRace` calls it right after the record is created) refunds bets on runners that did not make the field and stamps the rest with `recordId`; `resolve(state, record)` = `resolveRace` (called by `finishRace` before `applyRaceResults`) pays winners `payoutFor(amount, bet.odds)` via `addSp(…, 'betWin')` + `stats.betsWon++`, losers keep nothing, refunds any leftover, clears `state.bets`, logs "Bets paid: …", emits `bet:resolved { recordId, bets, winners, losers, totalPaid, totalStaked, refunded:<count> }` and returns `[{ id, username, displayName, runnerId, runnerName, amount, odds, payout, won, net }]` (stored as `record.bets`, `race:finished.bets`).
- `refundAll(state, reason)` → refunded bets[]; used by `SD.seasons.refundBets` (abort, `newDay`, `resetDay`, `seasonEnd`) and `persistence.recoverInterruptedRace` (`interrupted`). Emits `bet:resolved { recordId:null, refunded:true, reason, bets:[{…, refunded:true, won:false, payout:0}] }`.
- Refunds use `SD.players.refundSp` (balance up, `spSpentTotal` down): they are not "SP earned".

### `SD.achievements` (js/achievements.js, core)
- `init()` subscribes to the bus and enables unlocking; **main.js calls it right after `SD.game.init()`**. Headless suites that predate M5 never call it, so their SP arithmetic is unchanged; `tools/community-test.js` calls it. `disable()`, `isEnabled()`.
- `catalog()` (= `SD.DATA.ACHIEVEMENTS`), `get(id)`, `has(state, user, id)`, `check(state, trigger, ctx) → unlocked[]`, `checkRace(state, record)` (**the `finishRace` hook**: race checks, then returns every unlock tagged with this `record.id`, including winning-bet ones from `bet:resolved` earlier in the same finish), `unlock(state, user, id, extra?)`, `listFor(state, user) → [{ id, name, desc, icon, sp, at, … }]` in unlock order, `progress(state, user)`, `CHECKS` (per-trigger functions).
- `unlock` is once per player: pushes the id to `player.achievements` (ids only), appends `{ id, name, username, displayName, sp, at, season, day, recordId? }` to `state.achievements.unlocked`, `addSp(…, 'achievement')`, logs an epic `achievement` line and emits **`achievement:unlocked`** `{ …entry, desc, icon, count, total, duringCommand }` (`duringCommand` = the viewer's own command caused it; the reply already names it). Players are matched by username key or display name (race records store display names).
- **State:** `state.achievements = { unlocked:[], progress:{ username:{ trains, rests, snacks, podiums } }, lastRaceChecked }` (**CHANGED** `state.create` adds `progress`; loaded saves get it from `persistence.normalize`). `lastRaceChecked` keeps race checks to once per record (race ids are unique within a state, not across states).
- **Triggers** (listener → check): `player:joined` → First Steps; `runner:claimed` → Stable Hand; `runner:trained` (`by`) → Trainer (progress, ≥ 10), Critical Hit (`outcome crit`), Overtrainer (`conditionBefore ≠ Exhausted → Exhausted`); `runner:rested` → Well Rested (≥ 5); `command:result` ok `cheer` → Cheerleader (all-time cheers ≥ 25), `snack` → Snack Dealer (≥ 10), `sabotage` → Saboteur; `hype:changed` (`by`, delta > 0) records recent contributors in `SD.state.runtime.hypeRecent`; `hype:threshold` feral / awakened → Hype Train / Forest Awakened for everyone who added hype within `CONFIG.ACHIEVEMENTS.HYPE_WINDOW_MS` (3 min) plus the `by` that crossed it; `bet:placed` ≥ 200 → High Roller; `bet:resolved` wins ≥ 5× / ≥ 10× → Sharp Eye / Longshot; race (hook, or `race:finished` if the hook did not run) → Owner's Pride, Marathon Mind (≥ 2400 m), Comeback Kid (the winner's rank was last — field ≥ `MIN_FIELD_COMEBACK` 3 — in `ticks[t]` of the leader's FINAL_TURN phase event), Podium Regular (progress ≥ 3), Cryptid Whisperer, Photo Finish (1st/2nd owners), Karma (`chat` event `data.backfire` → `data.by`); `season:ended` + `season:started` → Season Champion (`summary.championOwner`, awarded on season:started so the summary modal and chat line come first); `runner:levelup` ≥ 10 → Double Digits (owner); `player:sp` balance ≥ 1000 → Spirit Hoarder; `runner:spawned` with `by` → Creator (M6 `!create`). Listeners outside a mutation wrap their writes in `SD.state.mutate('achievements:<trigger>')`.
- **CHANGED `SD.DATA.ACHIEVEMENTS`** (nothing could unlock the M1 draft): 25 entries `{ id, icon, name, desc, sp (25..100), trigger }` — firstSteps, stableHand, trainer, criticalHit, overtrainer, wellRested, cheerleader, hypeTrain, forestAwakened, highRoller, sharpEye, longshot, ownersPride, podiumRegular, photoFinish, comebackKid, saboteur, karma, seasonChampion, cryptidWhisperer, marathonMind, snackDealer, doubleDigits, spiritHoarder, creator.

### Seasons (js/seasons.js) — CHANGED summary, refunds
- `endSeason(state)` now **refunds open bets (`refundBets(state,'seasonEnd')`) and paid queued boosts / sabotages (`refundEffects(state)`) first**, then builds the summary, archives it, rolls runners / players back (unchanged rules: level 1, base + `floor(10% of gains)`, owners cleared, season record reset, lifetime kept; players via `SD.players.onSeasonEnd`: stats → lifetime, SP = 200 + 10%, achievements kept), clears bets / effects / hype.
- **Summary** `{ number, day, daysPerSeason, startedAt, championRunnerId, championName, championEmoji, championBadgeColor, championWins, championXp, championOwner, mvpUsername /*display*/, mvpKey, mvpSpEarned, totalRaces, biggestUpset:{ recordId, winnerId, winnerName, winnerEmoji, odds, upset, trackName, distance, day } | null, topHypeContributor:{ username, displayName, hype } | null, achievements:[entries this season], achievementsCount, runnerTable:[{ rank, runnerId, name, emoji, badgeColor, ribbonColor, owner, wins, races, podiums, xp, level, bestTimeSec }], refundedBets, refundedEffects, endedAt }`. Champion = most wins, then season XP (then podiums, name). **MVP = most `stats.spEarnedTotal`** (was a composite score). **Biggest upset = the highest winning odds of the season** (was: only races flagged `upset`); `upset:true` when ≥ `RACE.UPSET_ODDS`.
- `season.history[]` entry: `{ number, startedAt, endedAt, days, championRunnerId, championName, championEmoji, championWins, championOwner, mvpUsername, mvpSpEarned, totalRaces, biggestUpset, topHypeContributor, achievementsCount, runnerTable (top CONFIG.SEASON.HISTORY_TABLE_N, slim rows) }`.
- `advanceDay` at season end reports `refunded` = the season-end bet refunds. Exports add `refundEffects`.

### Commands (js/commands.js)
- **Pipeline additions:** `SD.state.runtime.activeCommand = { username, command }` while the handler runs; achievements this viewer unlocked during the command are appended to the reply (`· 🏅 Achievement: First Steps (+25 SP)`, severity `epic`, effect `{ type:'achievement', id, sp }`); a handler may return `announce: { text, severity }` → a `system` chat line right after its reply (before `command:result`).
- **Queued chat effects** in `state.raceEffects`: `{ type:'boost'|'sabotage', runnerId, by /*username key*/, count, paid /*SP*/ }` (same viewer + runner + type merges) and M2's `{ type:'cheer', runnerId, by, count }`. They stay queued until that runner races (`startRace` consumes only the field's entries and maps `by` to display names for the record); `abortRace` / interrupted races put them back; season end refunds `paid`.
- **New commands** (all spending commands `lockedDuringRace`, `requiresPlayer`): `!bet` (`<runner> <amount>`, `<amount> <runner>`, `<runner> all`, `all <runner>`, `<amount>` = your open bet's runner / your own runner, `cancel`, none = show your bet), `!bets` (read-only), `!odds` (read-only; live race odds while racing), `!boost [runner]` (`ECONOMY.BOOST_COST`, cap `RACE.CHAT.MAX_BOOSTS_PER_RUNNER` queued per runner, own runner allowed), `!snack [runner]` (`SNACK_COST`, `+SNACK_ENERGY` clamped, `runner.daily.snacks < SNACKS_PER_DAY`, refused at full energy), `!sabotage <runner>` (`SABOTAGE_COST`, not your own runner, cooldown `COOLDOWNS.SABOTAGE_S` via `cooldownMs`, caps `MAX_SABOTAGE_PER_TARGET` queued on the target and `MAX_SABOTAGE_PER_RACE` queued in total, public `announce` line "X slipped a pebble into Y's shoe…", reply says the outcome is decided at the gate and shows the target's backfire chance), `!ribbon <colour>` (`requiresRunner`; `SD.DATA.RIBBON_COLORS` name or `#rgb/#rrggbb`, stored as hex in `runner.ribbonColor`; `!ribbon` lists, `!ribbon off` free), `!hype`, `!achievements [viewer]` (aliases `ach`, `badges`).
- **`!race` (CHANGED):** viewers (and `!race status`) get the status line, now with the favourite and open bets; mods / the streamer start the race via `SD.game.startRace({ distance? })` (`!race 2000`), reply `🏁 … N bets (X SP) locked in.`; while a race exists everyone gets the status. **`!event` (CHANGED):** viewers (and `!event today`) get today's line; mods: `!event` → `SD.game.triggerDayEvent()` (random, different), `!event <id|name|unique prefix>` → that event.
- `list()` order: `join claim train rest cheer status inspect race event help leaderboard rank bet bets odds boost snack sabotage ribbon hype achievements`.
- New effect types: `bet`, `boost`, `snack`, `sabotage`, `ribbon`, `race`, `dayEvent`, `achievement`.

### Other core changes
- `SD.players.refundSp(state, user, amount, reason) → { ok, balance, amount }` (reverses a spend; `player:sp` carries `refund:true`). **CHANGED:** `ensure()` emits `player:joined` after the join SP and log line (so listeners see a complete player).
- `SD.hype`: `hype:threshold` payload adds `by` and `reason` of the change that crossed it (`syncThresholds(state, emit, src)`).
- `SD.state.create`: `meta.betCounter`, `achievements.progress`.
- `SD.DATA`: `RIBBON_COLORS` (32 names → hex), `SNACK_FLAVOUR`.
- `SD.CONFIG`: `BETTING { PAYOUT_ROUND, COUNT_REPLACEMENTS, LOG_WINNERS }`, `ACHIEVEMENTS { HYPE_WINDOW_MS, LATEST_N, MIN_FIELD_COMEBACK }`, `SEASON.HISTORY_TABLE_N`.

### UI (M5)
- **`SD.ui.season`** (js/ui/season.js, root `#season` = `.modal.modal--season` in index.html): subscribes to `season:ended` itself and queues the summary; if the results modal is open it waits for `ui:resultsClosed`. `show(summary)`, `close()` (emits `ui:seasonClosed`), `isOpen()`, `enqueue(summary)`. Cards: champion (badge, wins, XP, owner), MVP (SP earned), biggest upset, top hype, achievements; runner standings table; what the new season resets; Continue / Esc / backdrop; auto-close after 2 × `resultsAutoCloseMs` (0 = never). Admin RESET SEASON and the automatic season end both show it.
- **Results modal:** "Bets" (winners with amount, odds and payout; losing bets count + SP; total paid) and "Achievements unlocked" (icon, viewer, name, +SP).
- **Paddock:** odds from `SD.betting.fieldOdds`; status pill `Bets open · n bets · X SP`; per-runner chips `💰 n · X SP`, `⚡ boost ×n`, `🪨 sabotage ×n`, `📣 cheers ×n` (`track.queuedEffects(state)`); ribbon rings via `runnerVars` (`--ring`).
- **main.js:** `SD.achievements.init()` after `SD.game.init()`; panel `['season', '#season']`; `achievement:unlocked` → gold toast `🏅 FoxFan unlocked Critical Hit (+25 SP)` (`.toast--achievement`); Esc closes the season modal.
- **Header:** the SEASON label pops (`.hdr-season__main--bump`, keyframes `sd-season-bump`) when the season number changes. Hype banners (`hype:threshold`) and `body[data-hype-tier]` were verified unchanged (admin ADD HYPE crosses 25 / 50 / 100 with banners).
- **Boards tab:** "Season history" under the board (last 5 seasons: champion, wins, owner, MVP) from `state.season.history`.
- **Chat:** system lines for bets paid / lost (after the winner line), race achievements, other viewers' achievements (not `duringCommand`), bet refunds and the season end; demo bots also `!bet` / `!boost` / `!snack` / `!sabotage` (only what they can afford, respecting cooldowns) and ask `!odds` / `!bets` / `!hype` / `!achievements`.
- CSS: `.pfx*`, `.paddock__fx`, `.results__betsum`, `.season__*`, `.modal--season` (css/track.css); `.toast--achievement`, `.hdr-season__main--bump`, `.boards__history*` (css/panels.css); `@keyframes sd-season-bump` (css/tokens.css).

### Tools
- **`tools/community-test.js`** (suite `community` in run-tests): betting odds / place / limits / replace / cancel / `all` / resolve math + stats / refunds (abort, new day, reset day, season end, non-starters) / race lock; `!boost` / `!snack` / `!sabotage` / `!ribbon` costs, caps, own-runner rule, cooldown, public line, consumption by `startRace` and record events, abort restore; mod-only `!race` / `!event`; `!hype` / `!odds` / `!bets` / `!achievements` / `!help`; hype thresholds; achievements once with SP, Hype Train window, crafted race record, scripted session (≥ 8 different), real Karma backfire; season summary fields, rollback, history, refunds, automatic end, RESET SEASON; persistence round trip. `--transcript` prints a readable scripted stream.
- `tools/parser-test.js`: the `list()` assertion includes the M5 commands.

## Persistence keys
`spiritderby.save` (state), `spiritderby.backup` (pre-migration/import copy), `spiritderby.ui` (overlay/drawer/tab prefs, plus `chat: { sender, recent }` for the chat panel and `boards: { category, scope }` for the Boards tab).

## M7 additions — Twitch and bridge input adapters

Both adapters are pure input layers: they only ever call `SD.processCommand(username, text, { source, isMod, displayName })`. Neither stores or asks for tokens.

### `SD.integrations.twitch` (js/integrations/twitch.js)
- `connect(channel, opts?) → { ok, message }` — anonymous read-only IRC over `wss://irc-ws.chat.twitch.tv:443` (`CAP REQ :twitch.tv/tags twitch.tv/commands`, `NICK justinfanNNNNN`, `JOIN #channel`), PING/PONG, RECONNECT handling, exponential backoff (1 s → 60 s with jitter) while enabled, inbound rate limit of 20 commands/s (extras dropped and counted).
- `disconnect()`, `status() → { state:'off'|'connecting'|'on'|'error'|'reconnecting', channel, since, messages, dropped, lastError, attempt, nextRetryAt, nick, enabled, readOnly:true }`.
- Pure helpers for tests: `parseLine(raw) → { tags, prefix, command, params, trailing }`, `parseTags(str)`, `privmsgToChat(parsed) → { username, displayName, text, isMod }` (mod tag, broadcaster/moderator badges).
- Routes PRIVMSG as `SD.processCommand(login, text, { source:'twitch', isMod, displayName })` so a viewer keeps one stable profile.

### `SD.integrations.bridge` (js/integrations/bridge.js)
- `connect(url = settings.bridge.url || 'ws://localhost:8765')`, `disconnect()`, `status()`, `receive(jsonString)` (exposed for tests), `send(obj)` (no-op when closed), `configure({ replyUnknown })`.
- Inbound frames: `{ "username", "text", "isMod"?, "displayName"? }` or an array of them → `SD.processCommand(..., { source:'bridge' })`. Malformed frames are counted and ignored.
- Outbound frames: `{type:'hello', app, version, protocol:1}` on connect; `{type:'reply', username, displayName, command, ok, message, severity, source, id, chat, cooldown?, locked?}` for every command from `bridge` or `twitch` (unknown-command replies skipped unless `replyUnknown`); `{type:'race', winner, results:[{place,name,owner,runnerId,timeSec}], recordId, track, distance, photoFinish, upset, message}` on `race:finished`; `{type:'pong'}` for pings.

### Events, settings, UI
- `integration:status { adapter:'twitch'|'bridge', state, ... }` on every state change/retry/inbound batch; `SD.state.runtime.connected.twitch|bridge` mirror it; connect/disconnect/outage lines are posted once as `chat:message` kind `system`.
- Settings: `settings.twitch { channel, enabled }`, `settings.bridge { url, enabled }` — `enabled` = auto-connect on load (admin checkboxes). URL overrides for one window without saving: `?twitch=<channel>`, `?twitch=0`, `?bridge=1|ws://…`, `?bridge=0`, `?connect=0`.
- Admin drawer "Twitch & bridge" section (channel / URL inputs, CONNECT/DISCONNECT, status pills); header connection dot (grey off, amber connecting, green on, red error).
- Tests: `tools/integration-test.js` (211 assertions, no network). Streamer guide: `docs/INTEGRATION.md`.
