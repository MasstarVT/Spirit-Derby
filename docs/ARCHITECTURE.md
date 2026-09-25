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
js/ui/dom.js  js/ui/playback.js  js/ui/header.js  js/ui/track.js  js/ui/results.js  js/ui/roster.js
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

### `SD.seasons` (seasons.js) — `advanceDay(state, rng)`, `resetDay(state)`, `endSeason(state) → summary`, `startSeason(state)`, `summary(state)`.

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
- **Optional later-milestone hooks** called by `SD.game` only when present: `SD.betting.resolveRace(state, record) → bets[]`, `SD.betting.refundAll(state, reason)`, `SD.players.applyRaceResults(state, record) → payouts[]`, `SD.players.award(state, username, amount, reason)`, `SD.players.onNewDay(state)`, `SD.players.onSeasonEnd(state)`, `SD.players.normalize(player)`, `SD.achievements.checkRace(state, record) → unlocked[]`.

**Tuning (tools/balance-test.js)**: every number lives in `SD.CONFIG` (plus ability magnitudes in `SD.DATA.ABILITIES`). Values that differ from the plan's starting numbers, and why:
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
- `touch(state, username, { isMod?, displayName?, now?, count? }) → { player, dailyBonus }` — `lastSeen`, `stats.commands++`, `DAILY_SP` (+50) on the first action of each in-game day. The pipeline touches after every **successful** command, so `stats.commands` counts successful commands and the daily bonus comes with the first successful command of the day. `lastDailyDay` is the day key `'s<season>d<day>'` (`dayKey(state)`). `isMod` is only updated when passed (the pipeline never passes it for source `admin`, so SEND AS cannot turn a viewer into a mod).
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
- **M2 commands**: `!join`, `!claim [runner]` (first free runner when unnamed), `!train <stat> | <runner> <stat>` (`<stat> <runner>` also accepted; default = your runner; any runner while `settings.openTraining`, else only your own; calls `SD.game.trainRunner(id, stat, username)` — which awards the training SP through `SD.players.award` — then `recordAction` + hype contribution), `!rest [runner]` (`SD.game.restRunner`; runner rest cooldown checked first), `!cheer [runner]` (allowed mid-race; `SD.hype.add(GAINS.cheer)` × `hypeMultiplier`, `CHEER_SP` × day `spMult`; a named runner outside a race gets a merged `{ type:'cheer', runnerId, by, count }` in `state.raceEffects`; a Nervous runner turns Happy after `CONFIG.MOOD.NERVOUS_CURE_CHEERS` (10) such cheers, counted in `SD.state.runtime.nervousCheers[runnerId]`; mid-race only hype; reply `The forest hears you! Hype +3 (42/120) · …`), `!status` (alias stats), `!inspect [runner]` (style, owner, stats, energy, condition, mood, record, next-race odds from `SD.game.previewField()` + `buildEntrants` like the paddock, or live odds when racing, ability name + first sentence), `!race` / `!event` (read-only status lines; mod actions are M5), `!help [command]`. TODO markers in the file: M3 `!leaderboard`, M5 `!bet !boost !snack !sabotage !ribbon` + mod `!race`/`!event`, M6 `!create`.
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

## Persistence keys
`spiritderby.save` (state), `spiritderby.backup` (pre-migration/import copy), `spiritderby.ui` (overlay/drawer/tab prefs, plus `chat: { sender, recent }` for the chat panel).
