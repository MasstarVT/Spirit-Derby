#!/usr/bin/env node
/*
 * Spirit Derby - tools/run-tests.js
 * Runs every headless suite as a child process and exits non-zero if any fails.
 *
 *   node tools/run-tests.js [--verbose]
 *
 * Suites:
 *   balance  tools/balance-test.js --races 1000 --matrix --quick --streamday
 *            (1000 races per distance: at 300 the odds-calibration assertion is dominated by
 *             sampling noise and fails deterministically on the fixed seed; --quick keeps the
 *             style checks at 1000 races; the M4 sensitivity checks always use >= 2000 races;
 *             --streamday adds the 20-trains-to-Exhausted story)
 *   race     tools/race-test.js (M4 race systems: abilities, events, hype tiers, chat effects,
 *            photo finish / upset, replay, day events, playback duration)
 *   parser   tools/parser-test.js (command parser + pipeline)
 *   progression  tools/progression-test.js (XP / level-ups, leaderboards, !leaderboard / !rank)
 *   integration  tools/integration-test.js (M7 Twitch IRC parser / adapter + local bridge, no network)
 */
'use strict';

const path = require('path');
const childProcess = require('child_process');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
const SUITES = [
  { name: 'balance', file: 'balance-test.js', args: ['--races', '1000', '--matrix', '--quick', '--streamday'] },
  { name: 'race', file: 'race-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'parser', file: 'parser-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'progression', file: 'progression-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'integration', file: 'integration-test.js', args: VERBOSE ? ['--verbose'] : [] }
];

function lastLines(text, n) {
  const lines = String(text || '').replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

const summary = [];
let anyFailed = false;
const t0 = Date.now();

SUITES.forEach(function (suite) {
  const started = Date.now();
  const file = path.join(__dirname, suite.file);
  console.log('> node tools/' + suite.file + (suite.args.length ? ' ' + suite.args.join(' ') : ''));
  const res = childProcess.spawnSync(process.execPath, [file].concat(suite.args), {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const ms = Date.now() - started;
  const out = (res.stdout || '') + (res.stderr ? '\n' + res.stderr : '');
  const passed = res.status === 0 && !res.error;
  if (!passed) anyFailed = true;
  if (VERBOSE || !passed) console.log(out);
  else console.log(lastLines(out, 1));
  const fails = (out.match(/^\s*FAIL /gm) || []).length;
  const passes = (out.match(/^\s*PASS /gm) || []).length;
  const tally = /OK: (\d+) passed, (\d+) failed|FAILED: (\d+) passed, (\d+) failed/.exec(out);
  summary.push({
    name: suite.name,
    ok: passed,
    ms: ms,
    detail: tally ? (tally[1] || tally[3]) + ' passed, ' + (tally[2] || tally[4]) + ' failed'
      : passes + ' passed, ' + fails + ' failed',
    error: res.error ? res.error.message : (res.status !== 0 ? 'exit code ' + res.status : '')
  });
  console.log('');
});

console.log('SUMMARY');
summary.forEach(function (s) {
  console.log('  ' + (s.ok ? 'PASS' : 'FAIL') + '  ' + s.name + '  ' + s.detail + '  (' + (s.ms / 1000).toFixed(1) + ' s)' + (s.error ? '  ' + s.error : ''));
});
console.log((anyFailed ? 'TESTS FAILED' : 'ALL TESTS PASSED') + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
process.exit(anyFailed ? 1 : 0);
