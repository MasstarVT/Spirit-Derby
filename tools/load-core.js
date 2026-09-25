/*
 * Spirit Derby - tools/load-core.js
 * Loads the DOM-free core into Node in the same order as index.html and returns SD.
 *   const SD = require('./tools/load-core.js');
 * Files that do not exist yet (later milestones) are skipped.
 * While SD.testing.strictRandom is true, Math.random throws: core code must use SD.rng.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE_ORDER = [
  'js/namespace.js', 'js/config.js', 'js/rng.js', 'js/data.js', 'js/bus.js', 'js/state.js', 'js/persistence.js',
  'js/runners.js', 'js/training.js', 'js/events.js', 'js/race.js', 'js/hype.js', 'js/players.js', 'js/betting.js',
  'js/achievements.js', 'js/leaderboards.js', 'js/seasons.js', 'js/game.js', 'js/commands.js'
];

const SD = (globalThis.SD = globalThis.SD || {});
SD.testing = SD.testing || {};
if (SD.testing.strictRandom === undefined) SD.testing.strictRandom = true;

// Guard Math.random once (idempotent if this file is required twice).
if (!SD.testing.realRandom) {
  const realRandom = Math.random;
  SD.testing.realRandom = realRandom;
  Math.random = function guardedRandom() {
    if (globalThis.SD && globalThis.SD.testing && globalThis.SD.testing.strictRandom) {
      throw new Error('Math.random() is forbidden in Spirit Derby core (use SD.rng for determinism).');
    }
    return realRandom();
  };
}

const loaded = [];
for (const rel of CORE_ORDER) {
  const file = path.join(ROOT, rel);
  if (fs.existsSync(file)) {
    require(file);
    loaded.push(rel);
  }
}
SD.testing.loadedFiles = loaded;

module.exports = SD;
