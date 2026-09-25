/*
 * Spirit Derby - config.js
 * SD.CONFIG: every tunable number in the game. No logic lives here.
 * Balance tuning (tools/balance-test.js) only edits this file and ability magnitudes in data.js.
 */
(function (SD) {
  'use strict';

  SD.CONFIG = {
    STATS: ['speed', 'stamina', 'power', 'wisdom', 'luck'],

    LOG_CAP: 300,              // state.log entries kept
    HISTORY_FULL_LOGS: 10,     // raceHistory entries that keep full tick data
    HISTORY_MAX: 200,          // raceHistory entries kept at all (older ones dropped)
    SAVE_DEBOUNCE_MS: 500,
    CLOCK_INTERVAL_MS: 30000,  // UI calls SD.game.tickClock() this often
    CLOCK_MAX_ELAPSED_MS: 30 * 60 * 1000, // cap on one tickClock step (sleeping tabs)

    // -------------------------------------------------------------------------
    // RACE ENGINE (plan section 5.1)
    // -------------------------------------------------------------------------
    RACE: {
      DT: 0.5,                 // seconds per tick
      BASE_SPEED: 16,          // m/s -> 8 m per tick nominal
      MAX_TICKS_MULT: 3,       // hard stop at 3x nominal ticks
      DISTANCES: [1200, 1600, 2000, 2400],
      MIN_RUNNERS: 2,
      MAX_RUNNERS: 10,
      MIN_ENERGY_TO_RACE: 15,

      // Phase boundaries by a runner's own position fraction:
      // START <5%, EARLY <30%, MID <65%, FINAL_TURN <85%, FINAL_STRETCH <100%, FINISH.
      PHASE_BOUNDS: [0.05, 0.30, 0.65, 0.85],
      PHASE_SHARE: [0.05, 0.25, 0.35, 0.20, 0.15], // share of distance per phase (odds rating)

      // Per-phase performance weights (rows sum to 1).
      WEIGHTS: {
        START:         { speed: 0.25, stamina: 0.05, power: 0.45, wisdom: 0.15, luck: 0.10 },
        EARLY:         { speed: 0.35, stamina: 0.20, power: 0.15, wisdom: 0.20, luck: 0.10 },
        MID:           { speed: 0.35, stamina: 0.25, power: 0.10, wisdom: 0.25, luck: 0.05 },
        FINAL_TURN:    { speed: 0.30, stamina: 0.20, power: 0.30, wisdom: 0.15, luck: 0.05 },
        FINAL_STRETCH: { speed: 0.45, stamina: 0.15, power: 0.25, wisdom: 0.05, luck: 0.10 }
      },
      PERF_PIVOT: 45,          // core = 1 + SLOPE * (perf - PIVOT) / 100
      PERF_SLOPE: 0.24,        // 10 perf points ~= 2.4% speed (plan start 0.35; tuned by balance-test)

      NOISE: {
        SIGMA: 0.12,           // segment noise amplitude (triangular -1..1)
        WIS_DIV: 250,          // sigma *= (1 - wisdom / WIS_DIV)
        SEGMENT_TICKS: 6       // re-rolled every N ticks (offset per runner)
      },
      FORM: {
        AMP: 0.04,             // per-race form = AMP * (1 - wis/WIS_DIV) * tri()
        WIS_DIV: 300
      },

      STAMINA: {
        BASE: 0.90,            // stamMax = (BASE + sta/STA_DIV) * POOL_SCALE * DIST_FACTOR
        STA_DIV: 100,
        POOL_SCALE: 1600,
        // Pool per metre falls with distance: 1200 is a sprint, 2400 punishes low stamina.
        DIST_FACTOR: { 1200: 0.92, 1600: 1.04, 2000: 1.20, 2400: 1.40 },
        DRAIN_SCALE: 0.815,    // drain per metre at nominal speed (fresh Excellent+Happy runners run ~1.05x)
        // pool fraction thresholds -> velocity multiplier
        FADE_AT: [0.25, 0.12, 0.03],        // tiring / fading / wall
        FADE_MULT: [1.0, 0.96, 0.90, 0.80], // ok / tiring / fading / wall
        DRAFT_MIN: 0.5,        // metres behind someone
        DRAFT_MAX: 4,
        DRAFT_MULT: 0.92       // drain multiplier while drafting
      },

      ENERGY: { LOW: 0.5, SLOPE: 0.16, MIN: 0.92 }, // e < LOW -> 1 - (LOW - e) * SLOPE

      CRIT: {
        BASE: 0.0010,          // chance per tick
        PER_LUCK: 0.00005,
        COOLDOWN: 20,          // ticks
        BOOST: 0.15,           // +15% velocity
        TICKS: 3
      },

      OVERTAKE: {
        RANGE: 3,              // metres behind someone to get the push
        PUSH: 0.03,            // push = power/100 * PUSH
        LOG_GAP_LEAD: 8,       // min ticks between lead-change log lines
        LOG_GAP: 12,           // min ticks between other top-3 overtake lines
        PAIR_GAP: 24           // the same two runners are not re-announced within this many ticks
      },

      HYPE: {
        LOUD: 25, FERAL: 50, AWAKENED: 100,
        LOUD_SIGMA: 1.10,      // >=25: noise sigma x1.10
        FERAL_EVENTS: 1.5,     // >=50: event rate x1.5
        FERAL_CRIT: 1.25,      // >=50: crit chance x1.25
        AWAKEN_POOL: 0.15,     // Forest Awakened: +15% stamina pool
        AWAKEN_VEL: 1.04,      // +4% velocity for the rest of the race
        AWAKEN_LAST: 1.10,     // last place gets an extra +10% ...
        AWAKEN_LAST_TICKS: 15, // ... for this many ticks
        AWAKEN_SP: 1.5         // SP payouts x1.5
      },

      EVENTS: {
        BASE_P: 0.013,         // per-tick chance at 'normal'
        SLIDER: { none: 0, low: 0.5, normal: 1, high: 1.6, chaos: 2.5 },
        MIN_GAP: 8,            // ticks between random events
        MAX: 6,
        MAX_CHAOS: 12,
        NEG_COOLDOWN: 30,      // no runner gets two negatives within this many ticks
        NEG_WIS_DIV: 50,       // negative target weight 1 / (1 + wis / 50)
        POS_LUCK_DIV: 50,      // positive target weight 1 + luck / 50
        LOW_ENERGY_NEG: 1.3,   // energy < 50% -> negative weight x1.3
        FOG_SIGMA: 1.3,        // noise multiplier while fogged
        WIS_RESIST_DIV: 150    // wisdomResist events: penalty * (1 - wis / 150)
      },

      CHAT: {
        BOOST: 0.025, BOOST_TICKS: 15,
        SABOTAGE: 0.96, SABOTAGE_TICKS: 15,
        BACKFIRE_BASE: 0.15, BACKFIRE_WIS_DIV: 200, BACKFIRE_MAX: 0.5, BACKFIRE_BONUS: 1.02,
        CHEER_PER: 0.0005, CHEER_CAP: 0.02,
        MAX_BOOSTS_PER_RUNNER: 3, MAX_SABOTAGE_PER_TARGET: 2, MAX_SABOTAGE_PER_RACE: 4,
        DELAY_MAX: 6           // ticks after entering the seeded phase
      },

      PHOTO_FINISH_M: 0.4,
      UPSET_ODDS: 8,

      // Odds model (plan: softmax over a rating). Calibrated by maximum likelihood against
      // simulated races (roster + random runners); see tools/balance-test.js calibration check.
      ODDS: {
        TEMP: 5.7,             // softmax temperature over ratings (perf points)
        HOUSE: 0.85,           // odds = HOUSE / p  (15% house edge)
        MIN: 1.3,
        MAX: 25,
        SAFE_REMAIN: 0.25,     // expected pool left below this -> rating penalty
        SHORTFALL_PTS: 8.7,    // perf points per 100% shortfall
        REMAIN_PTS: 6.7,       // perf points per 100% expected stamina reserve ...
        REMAIN_CAP: 0.4,       // ... counted up to this fraction (beyond it nobody is short)
        // Style correction in perf points by distance (interpolated in between).
        STYLE_PTS: {
          1200: { frontRunner: -0.4, paceChaser: 0, lateSurger: -0.4, wildCard: 1.1 },
          1600: { frontRunner: -2.1, paceChaser: 0, lateSurger: -0.4, wildCard: 0.55 },
          2000: { frontRunner: -2.4, paceChaser: 0, lateSurger: -0.8, wildCard: -0.55 },
          2400: { frontRunner: -2.9, paceChaser: 0, lateSurger: -1.5, wildCard: -0.65 }
        }
      }
    },

    // Race style tables (DATA.STYLES references these arrays). Index = phase
    // START, EARLY, MID, FINAL_TURN, FINAL_STRETCH.
    STYLES: {
      frontRunner: { vel: [1.07, 1.055, 1.015, 0.99, 0.97], drain: [1.04, 1.04, 1.00, 1.00, 1.00], sigma: 1.0 },
      paceChaser:  { vel: [1.01, 1.01, 1.01, 1.01, 1.01], drain: [1.00, 1.00, 1.00, 1.00, 1.00], sigma: 1.0 },
      lateSurger:  { vel: [0.965, 0.965, 0.99, 1.04, 1.11], drain: [0.90, 0.90, 0.90, 1.00, 1.10], sigma: 1.0 },
      wildCard:    { vel: [1.0025, 1.0025, 1.0025, 1.0025, 1.0025], drain: [1.00, 1.00, 1.00, 1.00, 1.00], sigma: 1.15 }
    },
    WILD: {
      COLLAPSE_P: 0.15, COLLAPSE_VEL: 0.96, COLLAPSE_DRAIN: 1.10,
      LUCK_TILT: 0.004,       // collapse chance -0.4% per Luck point above 40 ...
      COLLAPSE_MIN: 0.05, COLLAPSE_MAX: 0.25, // ... clamped to this range
      GREAT_P: 0.15, GREAT_VEL: 1.025,
      STEADY_RANGE: 0.03      // else 1 +/- 3%
    },

    // Provisional race results (applied by game.finishRace).
    RESULTS: {
      PLACE_XP: [100, 70, 50, 35, 25, 20, 15, 12],
      XP_BONUS: 20,
      DIST_MULT: { 1200: 1, 1600: 1.1, 2000: 1.2, 2400: 1.3 },
      UNDERDOG_XP: 1.25,       // level below roster average
      OWNER_SP: [50, 35, 25, 15, 15, 8, 8, 8],
      BACKER_SHARE: 0.5,
      ENERGY_COST: 25,
      FATIGUE: 15,
      FATIGUE_LONG_EXTRA: 5,
      LONG_DISTANCE: 2400,
      SECOND_STAT_P: 0.35,     // chance of a second +1 stat
      SECOND_STAT_P_WIN: 0.7,
      STAT_GROWTH: {
        frontRunner: { speed: 3, stamina: 1, power: 3, wisdom: 1, luck: 1 },
        paceChaser:  { speed: 2, stamina: 3, power: 1, wisdom: 2, luck: 1 },
        lateSurger:  { speed: 3, stamina: 2, power: 1, wisdom: 2, luck: 1 },
        wildCard:    { speed: 1, stamina: 1, power: 2, wisdom: 1, luck: 3 }
      },
      MAJOR_HYPE: { finish: 15, photoFinish: 15, upset: 15, awakened: 15 }
    },

    // -------------------------------------------------------------------------
    // TRAINING (plan section 6.2)
    // -------------------------------------------------------------------------
    TRAINING: {
      MIN_ENERGY: 5,
      ENERGY_COST: 12,
      BASE: 2.0,               // gain base = BASE + PER_LEVEL * level
      PER_LEVEL: 0.15,
      CAP_ZONE: 0.25,          // capFactor = clamp((cap - stat) / (CAP_ZONE * cap), 0, 1)
      ENERGY_F: [[40, 1.0], [20, 0.85], [0, 0.60]], // [minEnergyBefore, factor]
      FERAL_MULT: 1.05,        // hype >= 50
      CRIT: { BASE: 0.08, PER_LUCK: 0.0015, PER_WIS: 0.001, AWAKENED: 0.05, MAX: 0.35, GAIN_MULT: 2 },
      FAIL: {
        BASE: 0.05, LOW30: 0.15, LOW15: 0.15, TIRED: 0.05, EXHAUSTED: 0.15, MAX: 0.60,
        EXTRA_FATIGUE: 8, NERVOUS_P: 0.4
      },
      FATIGUE: 5,              // per train
      FATIGUE_LOW: 10,         // per train when energy before < FATIGUE_LOW_BELOW
      FATIGUE_LOW_BELOW: 30,
      REWARDS: {
        normal: { hype: 1, sp: 5, xp: 3 },
        crit:   { hype: 10, sp: 15, xp: 8 },
        fail:   { hype: 0, sp: 0, xp: 0 }
      },
      FIRED_UP_ON_CRIT: 0.3,
      STREAK_FOR_DETERMINED: 3,
      REST: { ENERGY: 30, FATIGUE: 25, HYPE: -5, COOLDOWN_MS: 180000, HAPPY_BELOW: 35 },
      PASSIVE: { ENERGY_PER_MIN: 0.75, FATIGUE_PER_10MIN: 1, SLEEPY_IDLE_MS: 30 * 60 * 1000 }
    },

    // Condition = hidden fatigue bands: [maxFatigue, label, raceMult, trainMult]
    CONDITION: {
      BANDS: [
        [15, 'Excellent', 1.03, 1.15],
        [35, 'Good', 1.01, 1.05],
        [60, 'Normal', 1.00, 1.00],
        [80, 'Tired', 0.96, 0.85],
        [120, 'Exhausted', 0.90, 0.60]
      ],
      MAX_FATIGUE: 120,
      START_FATIGUE: 10
    },

    // -------------------------------------------------------------------------
    // PROGRESSION (plan section 6.3)
    // -------------------------------------------------------------------------
    PROGRESSION: {
      MAX_LEVEL: 20,
      CAP_BASE: 60, CAP_PER_LEVEL: 4,        // stat cap = 60 + 4 * level
      ENERGY_BASE: 100, ENERGY_PER_LEVEL: 2, // max energy = 100 + 2 * (level - 1)
      XP_BASE: 60, XP_PER_LEVEL: 20,         // xpToNext = 60 + 20 * (level - 1)
      LEVELUP_STAT_BONUS: 1,
      LEVELUP_HYPE: 8,
      STAT_TOTAL: 200                        // random/custom runners
    },

    // -------------------------------------------------------------------------
    // ECONOMY (plan section 6.4) - Spirit Points are fictional only.
    // -------------------------------------------------------------------------
    ECONOMY: {
      JOIN_SP: 200, DAILY_SP: 50,
      TRAIN_SP: 5, TRAIN_CRIT_SP: 15, CHEER_SP: 2,
      BET_MIN: 10, BET_MAX: 250,
      SABOTAGE_COST: 60, BOOST_COST: 40, SNACK_COST: 25, SNACK_ENERGY: 10, SNACKS_PER_DAY: 2,
      RIBBON_COST: 100,
      SEASON_BASE_SP: 200, SEASON_CARRY: 0.10,
      ACHIEVEMENT_SP_MIN: 25, ACHIEVEMENT_SP_MAX: 100
    },

    // -------------------------------------------------------------------------
    // HYPE (plan section 6.5)
    // -------------------------------------------------------------------------
    HYPE: {
      MAX: 120,
      GAINS: { train: 1, cheer: 3, crit: 10, levelUp: 8, bet: 1, backfire: 5, major: 15, rest: -5, admin: 25 },
      AFTER_RACE_KEEP: 0.4,     // hype = floor(hype * 0.4) after a race
      IDLE_AFTER_MS: 5 * 60 * 1000,
      IDLE_STEP_MS: 2 * 60 * 1000 // -1 per 2 idle minutes
    },

    // -------------------------------------------------------------------------
    // MOOD (plan section 6.6) - per-mood numbers live in DATA.MOODS
    // -------------------------------------------------------------------------
    MOOD: {
      DEFAULT: 'Happy',
      FIRED_UP_RACE_CHANCE: 0.6,  // hype >= 50 at race start
      CHAOTIC_RACE_CHANCE: 0.35,  // hype >= 100 at race start
      NERVOUS_CURE_CHEERS: 10
    },

    SEASON: {
      DAYS: 7,
      RACES_PER_DAY: 3,
      DAY_FATIGUE_RECOVERY: 40,
      STAT_CARRY: 0.10          // new season: base + 10% of gained stats
    },

    // Playback pacing (UI): ticks per second by leader phase.
    PLAYBACK: {
      TPS: { START: 4, EARLY: 6, MID: 8, FINAL_TURN: 10, FINAL_STRETCH: 14, FINISH: 14 },
      COUNTDOWN_S: 3,
      MAX_FRAME_DT_MS: 100,
      FINISH_HOLD_MS: 1500    // pause on the final frame before race:playbackDone
    },

    UI: {
      RESULTS_AUTO_CLOSE_MS: 25000 // default for settings.resultsAutoCloseMs (0 = never)
    },

    COOLDOWNS: { USER_S: 10, SABOTAGE_S: 600, CHEER_S: 30 },

    // -------------------------------------------------------------------------
    // LEADERBOARDS (plan sections 4 and 7) - six independent boards
    // -------------------------------------------------------------------------
    LEADERBOARDS: {
      TOP_N: 10,                // rows per board (Boards tab, SD.leaderboards.top default)
      CHAT_TOP_N: 3,            // entries in a !leaderboard reply
      // Participation score = sum(stat x weight). Never counts SP, wins or hype (those have their own boards).
      PARTICIPATION: { commands: 1, trains: 2, cheers: 1, rests: 1, bets: 1 },
      // Read-only commands (cooldownMs 0: !status, !lb, !help ...) add to stats.commands at most
      // once per this many seconds per viewer, so spamming them cannot top the participation board.
      READONLY_ACTIVITY_S: 10,
      RANK_BOARDS: ['spiritPoints', 'raceVictories', 'hypeContributions'], // what !rank reports
      LEADER_NAMES: 2           // paddock "Leader" line: names shown before "+n more"
    },

    NAMES: { MAX_LEN: 24 }
  };
})(globalThis.SD = globalThis.SD || {});
