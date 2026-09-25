/*
 * Spirit Derby - data.js
 * SD.DATA: every catalog the game reads (roster, species, styles, abilities, race and
 * day events, moods, conditions, hype thresholds, flavour text, achievements).
 * Numbers that need balancing live in SD.CONFIG; ability magnitudes live here.
 * Emoji are written as \u escapes so the file is safe regardless of page charset.
 */
(function (SD) {
  'use strict';

  const CFG = SD.CONFIG;

  // ---------------------------------------------------------------------------
  // Stat vocabulary
  // ---------------------------------------------------------------------------
  const STAT_LABELS = { speed: 'Speed', stamina: 'Stamina', power: 'Power', wisdom: 'Wisdom', luck: 'Luck' };
  const STAT_SHORT = { speed: 'SPD', stamina: 'STA', power: 'POW', wisdom: 'WIS', luck: 'LUK' };
  // Accepted spellings for !train <stat>
  const STAT_ALIASES = {
    speed: 'speed', spd: 'speed', spe: 'speed', fast: 'speed', sp: 'speed',
    stamina: 'stamina', sta: 'stamina', stam: 'stamina', endurance: 'stamina', end: 'stamina',
    power: 'power', pow: 'power', pwr: 'power', str: 'power', strength: 'power',
    wisdom: 'wisdom', wis: 'wisdom', wit: 'wisdom', int: 'wisdom', smart: 'wisdom',
    luck: 'luck', luk: 'luck', lck: 'luck', lucky: 'luck'
  };

  // ---------------------------------------------------------------------------
  // Styles (numeric tables are shared references to SD.CONFIG.STYLES)
  // ---------------------------------------------------------------------------
  const STYLES = {
    frontRunner: {
      name: 'Front Runner', short: 'FR',
      desc: 'Blasts out of the gate and tries to hold on. Burns stamina fast.',
      vel: CFG.STYLES.frontRunner.vel, drain: CFG.STYLES.frontRunner.drain, sigma: CFG.STYLES.frontRunner.sigma
    },
    paceChaser: {
      name: 'Pace Chaser', short: 'PC',
      desc: 'Sits just off the lead at an even pace. Reliable at any distance.',
      vel: CFG.STYLES.paceChaser.vel, drain: CFG.STYLES.paceChaser.drain, sigma: CFG.STYLES.paceChaser.sigma
    },
    lateSurger: {
      name: 'Late Surger', short: 'LS',
      desc: 'Saves energy at the back, then explodes down the final stretch.',
      vel: CFG.STYLES.lateSurger.vel, drain: CFG.STYLES.lateSurger.drain, sigma: CFG.STYLES.lateSurger.sigma
    },
    wildCard: {
      name: 'Wild Card', short: 'WC',
      desc: 'Nobody knows what happens next, least of all the runner. Very swingy.',
      vel: CFG.STYLES.wildCard.vel, drain: CFG.STYLES.wildCard.drain, sigma: CFG.STYLES.wildCard.sigma
    }
  };

  // ---------------------------------------------------------------------------
  // Roster: the 10 named runners (stats sum to 200)
  // ---------------------------------------------------------------------------
  const ROSTER = [
    {
      key: 'mossRunner', name: 'Moss Runner', emoji: '\u{1F98C}', badgeColor: '#5c8a4a', species: 'Forest Stag',
      personality: 'Quiet, steady, and suspiciously good at hide-and-seek.',
      description: 'A young stag spirit whose antlers sprout real moss every spring. Starts slow, then the whole forest seems to push him home.',
      style: 'lateSurger', stats: { speed: 40, stamina: 42, power: 40, wisdom: 40, luck: 38 }, abilityId: 'forestsFavor'
    },
    {
      key: 'moonhoof', name: 'Moonhoof', emoji: '\u{1F40E}', badgeColor: '#8fa3c7', species: 'Moon Horse',
      personality: 'Calm as a lake at midnight and has never once hurried.',
      description: 'A silver-maned horse who only trains by moonlight. Her pace barely changes from gate to finish, and that is exactly the point.',
      style: 'paceChaser', stats: { speed: 36, stamina: 58, power: 36, wisdom: 42, luck: 28 }, abilityId: 'moonlightPace'
    },
    {
      key: 'thunderFern', name: 'Thunder Fern', emoji: '\u{1F417}', badgeColor: '#7a5a3a', species: 'Storm Boar',
      personality: 'Loud, proud, and deeply allergic to being behind anyone.',
      description: 'A boar spirit who charges through the bracken like a rolling storm. Every runner he passes only makes him louder and faster.',
      style: 'frontRunner', stats: { speed: 42, stamina: 36, power: 58, wisdom: 34, luck: 30 }, abilityId: 'thunderStep'
    },
    {
      key: 'emberTail', name: 'Ember Tail', emoji: '\u{1F98A}', badgeColor: '#d9642b', species: 'Fire Fox',
      personality: 'Talks fast, runs faster, forgets to breathe.',
      description: 'A fox kit whose tail smoulders when she gets excited, which is always. Blistering off the line, but long races test her lungs.',
      style: 'frontRunner', stats: { speed: 60, stamina: 24, power: 44, wisdom: 32, luck: 40 }, abilityId: 'secondWind'
    },
    {
      key: 'velvetComet', name: 'Velvet Comet', emoji: '\u{1F408}', badgeColor: '#6b4fa3', species: 'Star Cat',
      personality: 'Elegant, aloof, and secretly competitive about everything.',
      description: 'A midnight cat who drifts at the back looking bored, then streaks home like a falling star while everyone else blinks.',
      style: 'lateSurger', stats: { speed: 56, stamina: 38, power: 34, wisdom: 42, luck: 30 }, abilityId: 'cometTail'
    },
    {
      key: 'mistyGale', name: 'Misty Gale', emoji: '\u{1F9A2}', badgeColor: '#a7c4c2', species: 'Mist Swan',
      personality: 'Reads the wind like a book and will quote it at you.',
      description: 'A swan spirit born from lake fog. She reads the course better than anyone and sidesteps trouble before it happens.',
      style: 'paceChaser', stats: { speed: 38, stamina: 42, power: 34, wisdom: 58, luck: 28 }, abilityId: 'readingTheWind'
    },
    {
      key: 'copperBloom', name: 'Copper Bloom', emoji: '\u{1F43F}\u{FE0F}', badgeColor: '#c9783a', species: 'Copper Squirrel',
      personality: 'Chaotic good, powered entirely by acorns and vibes.',
      description: 'A squirrel who believes every acorn is lucky, and somehow she is right. Bouncy, unpredictable, and prone to sudden bursts.',
      style: 'wildCard', stats: { speed: 38, stamina: 36, power: 36, wisdom: 30, luck: 60 }, abilityId: 'acornHoard'
    },
    {
      key: 'nightLantern', name: 'Night Lantern', emoji: '\u{1F989}', badgeColor: '#c9a84c', species: 'Lantern Owl',
      personality: 'Wise, patient, and awake at deeply inconvenient hours.',
      description: 'An owl spirit carrying a lantern of captured starlight. Saves every spark, then burns the whole lantern down the final stretch.',
      style: 'wildCard', stats: { speed: 32, stamina: 50, power: 30, wisdom: 50, luck: 38 }, abilityId: 'longNight'
    },
    {
      key: 'brambleJack', name: 'Bramble Jack', emoji: '\u{1F99D}', badgeColor: '#4a5d3a', species: 'Hedge Cryptid',
      personality: 'A hedge-dwelling trickster who treats rules as light suggestions.',
      description: 'Nobody is quite sure what Bramble Jack is, only that trouble slides right off him and onto whoever is running in front.',
      style: 'wildCard', stats: { speed: 40, stamina: 34, power: 46, wisdom: 26, luck: 54 }, abilityId: 'hedgeHop'
    },
    {
      key: 'glowWisp', name: 'Glow Wisp', emoji: '\u{1F407}', badgeColor: '#4fd1c5', species: 'Marsh Hare',
      personality: 'Shy until the lights go down, then absolutely unstoppable.',
      description: 'A bioluminescent hare from the fen who glows brighter the further behind she falls. Lives for a comeback.',
      style: 'lateSurger', stats: { speed: 52, stamina: 30, power: 34, wisdom: 46, luck: 38 }, abilityId: 'afterglow'
    }
  ];

  // ---------------------------------------------------------------------------
  // Species templates for SPAWN RUNNER / !create (statBias = relative weights)
  // ---------------------------------------------------------------------------
  const SPECIES = {
    foxSpirit:  { name: 'Fox Spirit', emoji: '\u{1F98A}', badgeColor: '#e07a3a', statBias: { speed: 1.4, stamina: 0.8, power: 1.0, wisdom: 0.9, luck: 1.1 }, styles: ['frontRunner', 'wildCard'] },
    moonHare:   { name: 'Moon Hare', emoji: '\u{1F407}', badgeColor: '#b9c6e8', statBias: { speed: 1.3, stamina: 0.8, power: 0.8, wisdom: 1.1, luck: 1.2 }, styles: ['lateSurger', 'wildCard'] },
    stag:       { name: 'Forest Stag', emoji: '\u{1F98C}', badgeColor: '#6f9a55', statBias: { speed: 1.0, stamina: 1.2, power: 1.1, wisdom: 1.0, luck: 0.8 }, styles: ['paceChaser', 'lateSurger'] },
    owl:        { name: 'Hollow Owl', emoji: '\u{1F989}', badgeColor: '#b89a52', statBias: { speed: 0.8, stamina: 1.1, power: 0.8, wisdom: 1.5, luck: 1.0 }, styles: ['paceChaser', 'wildCard'] },
    toad:       { name: 'Moss Toad', emoji: '\u{1F438}', badgeColor: '#7fa14a', statBias: { speed: 0.8, stamina: 1.3, power: 1.2, wisdom: 1.0, luck: 0.9 }, styles: ['paceChaser', 'wildCard'] },
    moth:       { name: 'Lantern Moth', emoji: '\u{1F98B}', badgeColor: '#d9c27a', statBias: { speed: 1.1, stamina: 0.8, power: 0.7, wisdom: 1.2, luck: 1.4 }, styles: ['wildCard', 'lateSurger'] },
    wolf:       { name: 'Grey Wolf', emoji: '\u{1F43A}', badgeColor: '#7d8a96', statBias: { speed: 1.2, stamina: 1.2, power: 1.2, wisdom: 0.8, luck: 0.7 }, styles: ['frontRunner', 'paceChaser'] },
    salamander: { name: 'Ember Salamander', emoji: '\u{1F98E}', badgeColor: '#d0503a', statBias: { speed: 1.2, stamina: 0.9, power: 1.3, wisdom: 0.8, luck: 1.0 }, styles: ['frontRunner', 'wildCard'] },
    tortoise:   { name: 'Elder Tortoise', emoji: '\u{1F422}', badgeColor: '#5d7a4a', statBias: { speed: 0.7, stamina: 1.6, power: 1.0, wisdom: 1.3, luck: 0.8 }, styles: ['paceChaser', 'lateSurger'] },
    lynx:       { name: 'Shadow Lynx', emoji: '\u{1F408}\u{200D}\u{2B1B}', badgeColor: '#4b4466', statBias: { speed: 1.3, stamina: 0.9, power: 1.0, wisdom: 1.0, luck: 1.0 }, styles: ['lateSurger', 'frontRunner'] },
    hedgehog:   { name: 'Bramble Hedgehog', emoji: '\u{1F994}', badgeColor: '#8a6a4a', statBias: { speed: 0.9, stamina: 1.1, power: 1.2, wisdom: 0.9, luck: 1.2 }, styles: ['wildCard', 'paceChaser'] },
    bat:        { name: 'Dusk Bat', emoji: '\u{1F987}', badgeColor: '#5a4a6e', statBias: { speed: 1.2, stamina: 0.8, power: 0.9, wisdom: 1.1, luck: 1.3 }, styles: ['wildCard', 'lateSurger'] }
  };

  // Abilities suitable for a random runner of each style.
  const STYLE_ABILITIES = {
    frontRunner: ['secondWind', 'thunderStep'],
    paceChaser: ['moonlightPace', 'readingTheWind'],
    lateSurger: ['forestsFavor', 'cometTail', 'afterglow'],
    wildCard: ['acornHoard', 'longNight', 'hedgeHop']
  };

  // Random name generator parts for spawned runners.
  const NAME_PARTS = {
    first: ['Thistle', 'Pebble', 'Hollow', 'Ash', 'Briar', 'Dusk', 'Fen', 'Willow', 'Cinder', 'Frost', 'Clover', 'Sorrel', 'Bracken', 'Juniper', 'Lichen', 'Rowan'],
    second: ['whisker', 'step', 'bloom', 'shade', 'dash', 'hop', 'tail', 'song', 'spark', 'drift', 'root', 'fang', 'glimmer', 'burrow']
  };
  const CUSTOM_PERSONALITIES = [
    'Wandered out of the deep woods and refused to leave.',
    'Believes the finish line is a very large snack.',
    'Has a rivalry with a rock. The rock is winning.',
    'Extremely polite. Apologises when overtaking.',
    'Was raised by fireflies and it shows.',
    'Trains by chasing its own shadow at noon.',
    'Nobody invited it. Everybody is glad it came.',
    'Collects shiny pebbles between races.'
  ];

  // ---------------------------------------------------------------------------
  // Abilities. hook = when the engine checks it. Magnitudes scale
  // base + <key>PerLevel * (level - 1). `rating` = odds correction in perf points
  // (fitted against simulated results; it is NOT used by the race engine itself).
  // ---------------------------------------------------------------------------
  const ABILITIES = {
    forestsFavor: {
      name: "Forest's Favor", hook: 'phaseEntry', phase: 'FINAL_STRETCH',
      desc: 'At the final stretch: a Luck-scaled chance (at least 40%) of a +18% burst for 6 ticks. Guaranteed when running 3rd to 5th.',
      chanceBase: 0.25, chancePerLuck: 0.005, chanceMin: 0.40, chanceMax: 0.85,
      burst: 0.18, burstPerLevel: 0.004, ticks: 6, guaranteedRanks: [3, 5], rating: -0.02
    },
    moonlightPace: {
      name: 'Moonlight Pace', hook: 'tick', phase: 'MID',
      desc: 'During the mid race: stamina drain x0.80 and +2% speed.',
      drainMult: 0.80, vel: 0.02, velPerLevel: 0.001, rating: 0.11
    },
    thunderStep: {
      name: 'Thunder Step', hook: 'overtake', phases: ['MID', 'FINAL_TURN'],
      desc: 'Overtaking in the mid race or final turn: +30% speed for 3 ticks (max 3 procs, 20-tick cooldown).',
      burst: 0.30, burstPerLevel: 0.005, ticks: 3, maxProcs: 3, cooldown: 20, rating: 0.39
    },
    secondWind: {
      name: 'Second Wind', hook: 'tick',
      desc: 'Once per race, when stamina drops below 12%: restore 15% stamina and ignore fatigue for 10 ticks.',
      threshold: 0.12, restore: 0.15, restorePerLevel: 0.005, noFadeTicks: 10, rating: 0.01
    },
    cometTail: {
      name: 'Comet Tail', hook: 'phaseEntry', phase: 'FINAL_STRETCH',
      desc: 'At the final stretch: +9% for 12 ticks when running 2nd to 5th, +6% when 6th or worse. Nothing when already leading.',
      burst: 0.09, burstPerLevel: 0.003, burstBack: 0.06, ticks: 12, rating: 0.29
    },
    readingTheWind: {
      name: 'Reading the Wind', hook: 'phaseEntry', phase: 'FINAL_TURN',
      desc: 'At the final turn: a Wisdom roll (50% + Wis/200) grants +5% through the turn and stamina drain x0.85 afterwards. Passive: bad events find her half as often.',
      chanceBase: 0.5, chancePerWis: 0.005, vel: 0.05, velPerLevel: 0.002, drainMult: 0.85, negEventWeight: 0.5, rating: 0.29
    },
    acornHoard: {
      name: 'Acorn Hoard', hook: 'passive', phase: 'FINAL_STRETCH',
      desc: 'Crit chance x2.5 and crits give +22% for 6 ticks. Good events find her 1.5x as often. One guaranteed crit at the final stretch if none yet.',
      critMult: 2.5, critBoost: 0.22, critBoostPerLevel: 0.004, critTicks: 6, posEventWeight: 1.5, rating: 0.96
    },
    longNight: {
      name: 'Long Night', hook: 'phaseEntry', phase: 'FINAL_STRETCH',
      desc: 'At the final stretch: bonus speed equal to remaining stamina x 14%. Stamina pool x1.06 in races of 2000 m or more.',
      perStam: 0.14, perStamPerLevel: 0.006, poolMult: 1.06, poolMinDistance: 2000, rating: 0.98
    },
    hedgeHop: {
      name: 'Hedge Hop', hook: 'event',
      desc: 'When hit by a bad event: 50% + Luck/200 to shrug it off, bounce it onto the runner directly ahead and spring forward (+12% for 10 ticks).',
      chanceBase: 0.5, chancePerLuck: 0.005, chancePerLevel: 0.005, chanceMax: 0.95,
      bounceBoost: 0.12, bounceBoostPerLevel: 0.002, bounceTicks: 10, rating: -0.61
    },
    afterglow: {
      name: 'Afterglow', hook: 'phaseEntry', phase: 'FINAL_STRETCH',
      desc: 'At the final stretch: +2% speed per runner ahead (max +10%) for the rest of the race.',
      perAhead: 0.02, perAheadPerLevel: 0.0005, max: 0.10, maxPerLevel: 0.002, rating: 0.09
    }
  };

  // ---------------------------------------------------------------------------
  // Random race events (16). target: ALL | ONE | ONE_POS | ONE_NEG | LEADER | LAST.
  // polarity: pos | neg | mixed | neutral. effect keys:
  //   vel (mult), ticks, drain (mult), stamina (+fraction of pool), fog (ticks),
  //   wisdomResist (penalty shrinks with Wisdom), mood (mood after race),
  //   roll {stat, base, per} + good {...} + bad {...} for mixed events.
  // ---------------------------------------------------------------------------
  const RACE_EVENTS = [
    {
      id: 'suddenRain', name: 'Sudden Rain', phases: ['EARLY', 'MID', 'FINAL_TURN'], target: 'ALL', polarity: 'neutral',
      weight: 1.0, severity: 'info',
      message: 'Sudden rain! The glade turns to mud and everyone slows down.',
      effect: { vel: 0.965, ticks: 18, drain: 1.06, wisdomResist: true }
    },
    {
      id: 'forestShortcut', name: 'Forest Shortcut', phases: ['EARLY', 'MID'], target: 'ONE_POS', polarity: 'pos',
      weight: 0.8, severity: 'good',
      message: '{r} spots a hidden deer path and cuts the corner!',
      effect: { vel: 1.10, ticks: 8 }
    },
    {
      id: 'looseShoe', name: 'Loose Shoe', phases: ['EARLY', 'MID', 'FINAL_TURN'], target: 'ONE_NEG', polarity: 'neg',
      weight: 1.0, severity: 'bad',
      message: '{r} throws a shoe! Clip, clop, CLANK.',
      effect: { vel: 0.90, ticks: 10 }
    },
    {
      id: 'cryptidCrossing', name: 'Cryptid Crossing', phases: ['EARLY', 'MID', 'FINAL_TURN'], target: 'ONE_NEG', polarity: 'neg',
      weight: 0.9, severity: 'bad',
      message: 'Something tall and hairy strolls across the track. {r} freezes!',
      effect: { vel: 0.82, ticks: 4 }
    },
    {
      id: 'audienceFrenzy', name: 'Audience Frenzy', phases: ['MID', 'FINAL_TURN', 'FINAL_STRETCH'], target: 'ALL', polarity: 'neutral',
      weight: 0.8, severity: 'epic',
      message: 'The crowd goes FERAL! Every runner digs a little deeper.',
      effect: { vel: 1.03, ticks: 10, drain: 1.05 }
    },
    {
      id: 'butterflyDistraction', name: 'Butterfly Distraction', phases: ['EARLY', 'MID'], target: 'ONE_NEG', polarity: 'neg',
      weight: 1.0, severity: 'bad',
      message: '{r} is distracted by a very pretty butterfly.',
      effect: { vel: 0.88, ticks: 6 }
    },
    {
      id: 'snackBreak', name: 'Snack Break', phases: ['EARLY', 'MID'], target: 'ONE_NEG', polarity: 'neg',
      weight: 0.8, severity: 'bad',
      message: '{r} stops for a quick berry snack. Priorities!',
      effect: { vel: 0.80, ticks: 4, stamina: 0.06 }
    },
    {
      id: 'unknownCreature', name: 'Unknown Creature Appears', phases: ['MID', 'FINAL_TURN'], target: 'ALL', polarity: 'neutral',
      weight: 0.6, severity: 'epic',
      message: 'An UNKNOWN CREATURE howls from the trees! Everyone sprints in blind panic!',
      effect: { vel: 1.07, ticks: 6, drain: 1.3 }
    },
    {
      id: 'mysteriousFog', name: 'Mysterious Fog', phases: ['EARLY', 'MID', 'FINAL_TURN'], target: 'ALL', polarity: 'neutral',
      weight: 0.7, severity: 'info',
      message: 'A mysterious fog rolls over the track... who is even winning?!',
      effect: { fog: 30 }
    },
    {
      id: 'suspiciousMushroom', name: 'Suspicious Mushroom', phases: ['EARLY', 'MID', 'FINAL_TURN'], target: 'ONE', polarity: 'mixed',
      weight: 0.8, severity: 'info',
      message: '{r} eats a suspicious mushroom... and starts GLOWING with power!',
      messageBad: '{r} eats a suspicious mushroom... and immediately regrets it.',
      effect: {
        roll: { stat: 'luck', base: 0.40, per: 0.005 },
        good: { vel: 1.10, ticks: 10 },
        bad: { vel: 0.90, ticks: 10, mood: 'Chaotic' }
      }
    },
    {
      id: 'forestWind', name: 'Forest Wind', phases: ['MID', 'FINAL_TURN', 'FINAL_STRETCH'], target: 'LEADER', polarity: 'neg',
      weight: 0.8, severity: 'bad',
      message: 'A howling forest wind slams into the leader, {r}!',
      effect: { vel: 0.94, ticks: 10, wisdomResist: true }
    },
    {
      id: 'luckyAcorn', name: 'Lucky Acorn', phases: ['EARLY', 'MID', 'FINAL_TURN', 'FINAL_STRETCH'], target: 'ONE_POS', polarity: 'pos',
      weight: 1.0, severity: 'good',
      message: '{r} finds a lucky acorn! Fortune favours the fluffy.',
      effect: { vel: 1.08, ticks: 8 }
    },
    {
      id: 'fireflyTrail', name: 'Firefly Trail', phases: ['MID', 'FINAL_TURN', 'FINAL_STRETCH'], target: 'LAST', polarity: 'pos',
      weight: 0.9, severity: 'good',
      message: 'A trail of fireflies lights the way for {r} at the back!',
      effect: { vel: 1.10, ticks: 12 }
    },
    {
      id: 'tangledVines', name: 'Tangled Vines', phases: ['MID', 'FINAL_TURN'], target: 'ONE_NEG', polarity: 'neg',
      weight: 1.0, severity: 'bad',
      message: '{r} gets tangled in creeping vines!',
      effect: { vel: 0.86, ticks: 6 }
    },
    {
      id: 'owlsAdvice', name: "Owl's Advice", phases: ['EARLY', 'MID'], target: 'ONE_POS', polarity: 'pos', weightStat: 'wisdom',
      weight: 0.8, severity: 'good',
      message: 'An old owl hoots advice at {r}: "Pace yourself, young one."',
      effect: { vel: 1.02, drain: 0.75, ticks: 24 }
    },
    {
      id: 'puddleJump', name: 'Puddle Jump', phases: ['EARLY', 'MID', 'FINAL_TURN', 'FINAL_STRETCH'], target: 'ONE', polarity: 'mixed',
      weight: 0.9, severity: 'info',
      message: '{r} clears a giant puddle in one heroic leap!',
      messageBad: '{r} lands SPLAT in the middle of a giant puddle.',
      effect: {
        roll: { stat: 'power', base: 0.40, per: 0.006 },
        good: { vel: 1.08, ticks: 5 },
        bad: { vel: 0.85, ticks: 4 }
      }
    }
  ];

  // ---------------------------------------------------------------------------
  // Day events (one active per in-game day). modifiers:
  //   eventRate, sigmaMult, critMult, poolMult, spMult, xpMult,
  //   statWeight {stat: mult} (race perf weights), eventWeights {eventId: mult}
  // ---------------------------------------------------------------------------
  const DAY_EVENTS = [
    {
      id: 'clearSkies', name: 'Clear Skies', weight: 2,
      desc: 'A perfectly ordinary day in the forest. Suspiciously ordinary.',
      modifiers: {}
    },
    {
      id: 'fogOfTheHollow', name: 'Fog of the Hollow', weight: 1,
      desc: 'Thick fog clings to the Hollow. Wise runners find the line (Wisdom counts 1.5x in races; fog rolls in more often).',
      modifiers: { statWeight: { wisdom: 1.5 }, eventWeights: { mysteriousFog: 3 } }
    },
    {
      id: 'harvestFestival', name: 'Harvest Festival', weight: 1,
      desc: 'Lanterns, pies and a very generous crowd. Spirit Point payouts x1.5.',
      modifiers: { spMult: 1.5, xpMult: 1.1 }
    },
    {
      id: 'cryptidSeason', name: 'Cryptid Season', weight: 1,
      desc: 'Something is out there. Several somethings. Race events happen 1.5x as often.',
      modifiers: { eventRate: 1.5, eventWeights: { cryptidCrossing: 2.5, unknownCreature: 2.5 } }
    },
    {
      id: 'stillMorning', name: 'Still Morning', weight: 1,
      desc: 'Not a leaf stirs. Fewer surprises and steadier form: the best runner usually wins.',
      modifiers: { eventRate: 0.6, sigmaMult: 0.8 }
    },
    {
      id: 'wispMigration', name: 'Wisp Migration', weight: 1,
      desc: 'Thousands of wisps drift over the track. Lucky sparks fly: crits x1.5, firefly trails everywhere.',
      modifiers: { critMult: 1.5, eventWeights: { fireflyTrail: 2.5, luckyAcorn: 1.5 } }
    },
    {
      id: 'moonlitGlade', name: 'Moonlit Glade', weight: 1,
      desc: 'A huge moon hangs over the glade. Stamina pools x1.08 and Stamina counts 1.3x.',
      modifiers: { poolMult: 1.08, statWeight: { stamina: 1.3 } }
    }
  ];

  // ---------------------------------------------------------------------------
  // Moods: small race-day nudges (M4). Every mood's race-level velocity effect stays
  // within +/-0.6% (per-phase values up to 2%) so mood can never outweigh stats: in a
  // field of identical Happy clones any single other mood keeps a 8.5-16.5% win rate
  // (tools/balance-test.js). vel applies in velPhases (null = all phases); sigma scales
  // the in-race swing; drain scales stamina use.
  // ---------------------------------------------------------------------------
  const MOODS = {
    'Determined': {
      emoji: '😤', desc: 'Locked in. +1.2% speed through the final turn and stretch, +8% training gains.',
      vel: 0.012, velPhases: ['FINAL_TURN', 'FINAL_STRETCH'], sigma: 1, drain: 1, critMult: 1,
      trainGain: 1.08, trainCrit: 0, trainFail: 0, eventW: 1, hypeMult: 1, regen: 1
    },
    'Happy': {
      emoji: '😊', desc: 'Feeling great. +0.4% speed all race, hype contributions x1.2.',
      vel: 0.004, velPhases: null, sigma: 1, drain: 1, critMult: 1,
      trainGain: 1, trainCrit: 0, trainFail: 0, eventW: 1, hypeMult: 1.2, regen: 1
    },
    'Nervous': {
      emoji: '😰', desc: 'Jittery. -0.4% speed and more erratic, bad events find them more often, training fails more. Cured by a crit or 10 cheers.',
      vel: -0.004, velPhases: null, sigma: 1.2, drain: 1, critMult: 1,
      trainGain: 1, trainCrit: 0, trainFail: 0.05, eventW: 1.2, hypeMult: 1, regen: 1
    },
    'Fired Up': {
      emoji: '🔥', desc: 'Pumped! +2% at the start and early race, but stamina drain x1.05.',
      vel: 0.02, velPhases: ['START', 'EARLY'], sigma: 1, drain: 1.05, critMult: 1,
      trainGain: 1, trainCrit: 0.02, trainFail: 0, eventW: 1, hypeMult: 1, regen: 1
    },
    'Sleepy': {
      emoji: '😴', desc: 'Drowsy. -1% out of the gate, but stamina drain x0.95 and energy recovers x1.3.',
      vel: -0.01, velPhases: ['START'], sigma: 1, drain: 0.95, critMult: 1,
      trainGain: 1, trainCrit: 0, trainFail: 0.02, eventW: 1.1, hypeMult: 1, regen: 1.3
    },
    'Chaotic': {
      emoji: '🌀', desc: 'Unhinged. Much more erratic, crits x1.5, training gains anywhere from x0.7 to x1.3.',
      vel: 0, velPhases: null, sigma: 1.3, drain: 1, critMult: 1.5,
      trainGain: 1, trainGainRange: [0.7, 1.3], trainCrit: 0, trainFail: 0, eventW: 1, hypeMult: 1, regen: 1
    }
  };

  // [maxFatigue, label, raceMult, trainMult] - shared with SD.CONFIG.CONDITION.BANDS
  const CONDITIONS = CFG.CONDITION.BANDS;
  const CONDITION_EMOJI = { Excellent: '\u{2728}', Good: '\u{1F44D}', Normal: '\u{1F610}', Tired: '\u{1F613}', Exhausted: '\u{1F4A4}' };

  const HYPE_THRESHOLDS = [
    { value: 25, id: 'loud', text: 'The crowd is getting loud!' },
    { value: 50, id: 'feral', text: 'CHAT HAS ENTERED FERAL MODE.' },
    { value: 100, id: 'awakened', text: 'THE FOREST HAS AWAKENED.' }
  ];

  const TRACK_NAMES = [
    'Hollow Glade', 'Mossback Meadow', 'Whispering Birches', 'Lantern Creek Loop',
    'Fernfall Hollow', 'Old Root Circuit', 'Glowcap Marsh', 'Thistledown Ridge'
  ];

  const BADGE_PALETTE = [
    '#5c8a4a', '#8fa3c7', '#7a5a3a', '#d9642b', '#6b4fa3', '#a7c4c2', '#c9783a', '#c9a84c',
    '#4a5d3a', '#4fd1c5', '#b85c7a', '#3f7f9f', '#9a8b3a', '#7d8a96', '#c25b4a', '#6e9e7e'
  ];

  // ---------------------------------------------------------------------------
  // Training flavour ({r} = runner name)
  // ---------------------------------------------------------------------------
  const TRAINING_FLAVOUR = {
    normal: {
      speed: [
        '{r} practiced explosive starts.',
        '{r} sprinted laps around the Great Oak.',
        '{r} raced a very smug hare. It was close.',
        '{r} did wind sprints between the mushroom rings.',
        "{r} chased a runaway will-o'-the-wisp across the meadow."
      ],
      stamina: [
        '{r} jogged the long trail to the Old Well and back.',
        '{r} carried acorns uphill for no clear reason.',
        '{r} ran the moonlit loop three times without stopping.',
        '{r} swam laps in the Frog Pond. The frogs were not consulted.'
      ],
      power: [
        '{r} pushed a fallen log up Bramble Hill.',
        '{r} practiced bursting through hedge walls.',
        '{r} arm-wrestled a mossy boulder. The boulder lost.',
        '{r} did hill charges until the ferns applauded.'
      ],
      wisdom: [
        '{r} studied the racing line with a wise old toad.',
        '{r} meditated beneath the Whispering Birches.',
        '{r} memorised every root on the Hollow Glade track.',
        '{r} read ancient racing scrolls. Mostly the pictures.'
      ],
      luck: [
        '{r} found a four-leaf clover. Then another one.',
        '{r} bowed politely to every magpie on the path.',
        '{r} rubbed the Lucky Stump for good fortune.',
        '{r} made a wish on a falling firefly.'
      ]
    },
    crit: [
      '{r} discovered a new technique.',
      '{r} was blessed by a passing forest spirit!',
      '{r} entered THE ZONE. Chat saw it happen.',
      '{r} unlocked ancient hoof-fu from a dusty scroll.',
      '{r} trained so hard the mushrooms started glowing.',
      '{r} had a breakthrough mid-stride. Legendary.',
      'A wise old owl whispered the secret to {r}.'
    ],
    fail: [
      '{r} tripped over a tree root.',
      '{r} got distracted by a very interesting beetle.',
      '{r} ran face-first into a spiderweb and had to lie down.',
      '{r} was chased off the track by an angry goose.',
      '{r} fell asleep mid-stretch. Snoring was heard.',
      '{r} ate a suspicious mushroom and spent the session staring at clouds.',
      '{r} took a wrong turn and ended up in Cryptid Territory.',
      '{r} slipped into the Frog Pond. The frogs laughed.',
      "Something in the ferns stole {r}'s training cones."
    ]
  };

  const REST_FLAVOUR = [
    '{r} curls up in a mossy hollow for a nap.',
    '{r} naps under a mushroom umbrella.',
    '{r} soaks their hooves in the Moonlit Spring.',
    '{r} lies in a sunbeam and refuses to move.',
    '{r} gets a gentle leaf massage from the local sprites.'
  ];

  // ---------------------------------------------------------------------------
  // Race commentary ({r} = runner, {r2} = second runner, {track} = track name)
  // ---------------------------------------------------------------------------
  const RACE_TEXT = {
    start: ["AND THEY'RE OFF at {track}!", 'The gates spring open at {track}!', 'A horn echoes through {track}... GO!'],
    phase: {
      EARLY: '{r} leads the pack into the early straight.',
      MID: 'MID RACE: {r} sets the pace, {r2} tucked in behind.',
      FINAL_TURN: 'FINAL TURN! {r} leads into the bend!',
      FINAL_STRETCH: 'FINAL STRETCH! {r} leads, {r2} is closing!',
      FINAL_STRETCH_CLEAR: 'FINAL STRETCH! {r} is clear by {gap} m!'
    },
    crit: [
      '{r} CRITS! A burst of wild spirit speed!',
      '{r} catches a lucky gust and CRITS!',
      'CRIT! {r} finds another gear!',
      '{r} hits a perfect stride. CRITICAL!'
    ],
    wall: [
      '{r} HITS THE WALL! Legs of pure jelly.',
      '{r} HITS THE WALL! The tank is empty.',
      '{r} HITS THE WALL and is running on vibes alone.'
    ],
    lead: '{r} takes the lead from {r2}!',
    pass: '{r} slips past {r2} into {place}.',
    awakened: 'THE FOREST HAS AWAKENED! Ancient roots surge beneath every runner!',
    awakenedLast: 'The roots lift {r} from the very back!'
  };

  // ---------------------------------------------------------------------------
  // Achievements (checked by achievements.js in a later milestone).
  // trigger is a machine-readable hint for that module.
  // ---------------------------------------------------------------------------
  const ACHIEVEMENTS = [
    { id: 'firstSteps', name: 'First Steps', desc: 'Join the Spirit Derby.', sp: 25, trigger: { on: 'join' } },
    { id: 'trainer', name: 'Trainer', desc: 'Train runners 25 times.', sp: 50, trigger: { on: 'train', stat: 'trains', min: 25 } },
    { id: 'criticalHit', name: 'Critical Hit', desc: 'Land a critical training.', sp: 25, trigger: { on: 'train', outcome: 'crit' } },
    { id: 'overtrainer', name: 'Overtrainer', desc: 'Train a runner until it is Exhausted. Oops.', sp: 25, trigger: { on: 'train', condition: 'Exhausted' } },
    { id: 'highRoller', name: 'High Roller', desc: 'Place a 250 SP bet.', sp: 50, trigger: { on: 'bet', amountMin: 250 } },
    { id: 'photoFinish', name: 'Photo Finish', desc: 'Own or back a runner in a photo finish.', sp: 50, trigger: { on: 'race', photoFinish: true } },
    { id: 'comebackKid', name: 'Comeback Kid', desc: 'Own a runner that wins from last place at the final turn.', sp: 100, trigger: { on: 'race', comeback: true } },
    { id: 'cryptidWhisperer', name: 'Cryptid Whisperer', desc: 'Own a runner that meets a cryptid and still makes the podium.', sp: 75, trigger: { on: 'race', eventIds: ['cryptidCrossing', 'unknownCreature'], podium: true } },
    { id: 'feralMode', name: 'Feral Mode', desc: 'Help push hype past 50.', sp: 25, trigger: { on: 'hype', threshold: 'feral' } },
    { id: 'forestAwakened', name: 'Forest Awakened', desc: 'Help push hype to 100.', sp: 100, trigger: { on: 'hype', threshold: 'awakened' } },
    { id: 'sabotageBackfire', name: 'Sabotage Backfire', desc: 'Have one of your sabotages backfire.', sp: 25, trigger: { on: 'race', backfire: true } },
    { id: 'winnersCircle', name: "Winner's Circle", desc: 'Own the winner of a race.', sp: 50, trigger: { on: 'race', ownerWin: true } },
    { id: 'underdogBeliever', name: 'Underdog Believer', desc: 'Win a bet at odds of 8x or more.', sp: 100, trigger: { on: 'bet', wonOddsMin: 8 } },
    { id: 'cheerleader', name: 'Cheerleader', desc: 'Cheer 50 times.', sp: 50, trigger: { on: 'cheer', stat: 'cheers', min: 50 } },
    { id: 'snackDealer', name: 'Snack Dealer', desc: 'Buy 10 snacks for runners.', sp: 25, trigger: { on: 'snack', stat: 'snacks', min: 10 } },
    { id: 'doubleDigits', name: 'Double Digits', desc: 'Get your runner to level 10.', sp: 100, trigger: { on: 'levelup', levelMin: 10 } },
    { id: 'spiritHoarder', name: 'Spirit Hoarder', desc: 'Hold 1000 Spirit Points at once.', sp: 50, trigger: { on: 'sp', balanceMin: 1000 } },
    { id: 'creator', name: 'Creator', desc: 'Create your own runner.', sp: 25, trigger: { on: 'create' } },
    { id: 'marathonMind', name: 'Marathon Mind', desc: 'Own the winner of a 2400 m race.', sp: 50, trigger: { on: 'race', ownerWin: true, distanceMin: 2400 } }
  ];

  SD.DATA = {
    STAT_LABELS: STAT_LABELS,
    STAT_SHORT: STAT_SHORT,
    STAT_ALIASES: STAT_ALIASES,
    ROSTER: ROSTER,
    SPECIES: SPECIES,
    STYLE_ABILITIES: STYLE_ABILITIES,
    NAME_PARTS: NAME_PARTS,
    CUSTOM_PERSONALITIES: CUSTOM_PERSONALITIES,
    STYLES: STYLES,
    ABILITIES: ABILITIES,
    RACE_EVENTS: RACE_EVENTS,
    DAY_EVENTS: DAY_EVENTS,
    MOODS: MOODS,
    CONDITIONS: CONDITIONS,
    CONDITION_EMOJI: CONDITION_EMOJI,
    HYPE_THRESHOLDS: HYPE_THRESHOLDS,
    TRACK_NAMES: TRACK_NAMES,
    BADGE_PALETTE: BADGE_PALETTE,
    TRAINING_FLAVOUR: TRAINING_FLAVOUR,
    REST_FLAVOUR: REST_FLAVOUR,
    RACE_TEXT: RACE_TEXT,
    ACHIEVEMENTS: ACHIEVEMENTS
  };
})(globalThis.SD = globalThis.SD || {});
