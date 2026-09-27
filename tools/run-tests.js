#!/usr/bin/env node
/*
 * Spirit Derby - tools/run-tests.js
 * Runs every headless suite as a child process and exits non-zero if any fails.
 *
 *   node tools/run-tests.js [--verbose] [--timeout <seconds per suite, default 300>]
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
 *   community    tools/community-test.js (M5 betting, boost / snack / sabotage / ribbon, mod !race / !event,
 *                achievements, season summary + rollover)
 *   persistence  tools/persistence-test.js (M6 M1-save migration from tools/fixtures/save-m1.json, normalize,
 *                roster reconciliation, interrupted races, backup key, history trimming, stats, UI prefs,
 *                schema 3 owner-key migration from tools/fixtures/save-v2-display-names.json)
 *   identity     tools/identity-test.js (review batch 2: login-keyed players and runner ownership, the reserved
 *                '#streamer' console actor, SEND AS / chat panel senders by login, roster buttons)
 *   protokeys    tools/protokeys-test.js (review batch 3: chat words, usernames, arguments, settings keys and save
 *                keys named like Object.prototype members - 'constructor', '__proto__', 'toString' ... - never reach
 *                Object.prototype; every command swept with them; error cooldown for crashing commands)
 *   economy      tools/economy-test.js (review batch 4: odds never above the fair price minus the house edge,
 *                bets settled at min(quoted, gate odds), hype-aware odds, bets counted when settled, profit-only
 *                SP earned, exact odds display, no gate moods after an abort, !bet / !ribbon / !snack / !race /
 *                !rest / !sabotage fixes, snack counter reset at season rollover)
 *   rng          tools/rng-test.js (review batch 5: SD.entropy, unpredictable race seeds (salt re-drawn at every
 *                race start, load and import; a leaked race seed predicts nothing), no seed salt / seed override
 *                in EXPORT JSON, no replayed races after a save rollback, refused trainings draw no action RNG,
 *                the seed override is never saved, hashRecord(stored) === hash, rollStats remainder order)
 *   durability   tools/durability-test.js (review batch 6: slim history records + MIGRATIONS[4], the save size
 *                budget under a per-origin quota, save-failure events, lazy saves for read-only chat / idle clock /
 *                races, one writer per storage (a second window is read-only, TAKE OVER, stale locks), held
 *                unreadable / newer saves, checked backups + RESTORE BACKUP, player retention, rankOf)
 *   import       tools/import-test.js (review batch 7: deep checks of imported saves - a 'finished' race
 *                finishRace cannot apply, bestTimes, non-string runner ids, lanes / distance, retired runners'
 *                refunds; IMPORT runs boot's post-load routine; runtime maps reset; state.set() depth; boot
 *                order; bootRecovery)
 *   ui           tools/ui-test.js (review batch 9: the real UI modules and main.js boot on a fake DOM - hidden-page
 *                playback speed, END while paused / in the countdown, the final view behind a results modal
 *                that never auto-closes, 9-10 runner fields, season summary vs the next race, modal focus,
 *                Tab containment, tab arrow keys, reduced motion, backer lines, toast priority; review batch 10: the
 *                playback state machine - pause / resume / END / abort, playbackDone exactly once)
 *   runners     tools/runners-test.js (M6 !create, admin SPAWN RUNNER, MAX_ACTIVE, SD.debug)
 *   hygiene      tools/hygiene-test.js (review batch 8: retire / rename / delete a runner and remove a viewer,
 *                demo bots on '~' keys and their clean-up, bots stopped by RESET ALL / IMPORT / live chat,
 *                confirm arm delay + RESET ALL backup, NEXT DAY debounce, stale season summaries, !create name
 *                rules (shorthand takeovers, command words, confusables), exact-name !bet / !train parsing)
 *   escape       tools/escape-test.js (review batch 10: every panel of the real page - index.html, all of js/ui and
 *                main.js on a fake DOM that parses innerHTML - rendered with hostile display names, chat text,
 *                runner names, ribbon / badge colours, avatar URLs and imported save values; no markup, event
 *                handler attribute, style injection or javascript: URL gets through; dom.esc / safeColor / safeUrl)
 *   tooling      tools/tooling-test.js (review batch 10: load-core traps the whole determinism contract (static
 *                scan + runtime caller check), run-tests.js per-suite timeout, serve.js local-only / bad escapes /
 *                sibling folders / dot-folders)
 *   fuzz         tools/fuzz-test.js (M6 seeded 3-season fuzz: 17 viewers spamming every command, random race
 *                starts / pauses / ends / aborts / reloads, invariants after every command and race; review batch 10:
 *                RESET SEASON mid-season, admin actions and EXPORT -> IMPORT during races)
 *
 * Review batch 10 (tools-tests#11): each suite runs under a timeout (default 5 min, --timeout <seconds>); a
 * suite that never exits is killed and reported as FAIL "timed out after N s" with its partial output.
 * require('./run-tests.js') runs nothing: it exports { SUITES, runSuite, DEFAULT_TIMEOUT_MS }.
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
  { name: 'integration', file: 'integration-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'community', file: 'community-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'persistence', file: 'persistence-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'identity', file: 'identity-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'protokeys', file: 'protokeys-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'economy', file: 'economy-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'rng', file: 'rng-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'durability', file: 'durability-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'import', file: 'import-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'ui', file: 'ui-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'runners', file: 'runners-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'hygiene', file: 'hygiene-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'escape', file: 'escape-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'tooling', file: 'tooling-test.js', args: VERBOSE ? ['--verbose'] : [] },
  { name: 'fuzz', file: 'fuzz-test.js', args: VERBOSE ? ['--verbose'] : [] }
];

function lastLines(text, n) {
  const lines = String(text || '').replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

// Review batch 10 (tools-tests#11): every suite runs under a timeout (default 5 min, --timeout <s> or
// a suite's own timeoutMs). A suite that never exits (a leaked real timer or socket, a runaway loop)
// is killed and reported as FAIL "timed out" with the output it printed so far, instead of blocking
// the run forever with nothing on screen.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
function argTimeoutMs(argv) {
  const i = argv.indexOf('--timeout');
  const s = i >= 0 ? Number(argv[i + 1]) : NaN;
  return isFinite(s) && s > 0 ? Math.round(s * 1000) : null;
}

/**
 * Run one suite as a child process.
 * suite { name, file (absolute, or relative to tools/), args, timeoutMs? }; opts { timeoutMs?, cwd? }
 * -> { name, ok, ms, out, timedOut, detail, error }
 */
function runSuite(suite, opts) {
  opts = opts || {};
  const started = Date.now();
  const file = path.isAbsolute(suite.file) ? suite.file : path.join(__dirname, suite.file);
  const timeoutMs = Number(suite.timeoutMs) > 0 ? Number(suite.timeoutMs) : (Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS);
  const res = childProcess.spawnSync(process.execPath, [file].concat(suite.args || []), {
    cwd: opts.cwd || path.join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL'
  });
  const ms = Date.now() - started;
  const timedOut = !!(res.error && (res.error.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(res.error.message)));
  let out = (res.stdout || '') + (res.stderr ? '\n' + res.stderr : '');
  if (timedOut) out += '\n  FAIL suite timed out after ' + (timeoutMs / 1000) + ' s (killed; the output above is all it printed)';
  const passed = res.status === 0 && !res.error;
  const fails = (out.match(/^\s*FAIL /gm) || []).length;
  const passes = (out.match(/^\s*PASS /gm) || []).length;
  const tally = /OK: (\d+) passed, (\d+) failed|FAILED: (\d+) passed, (\d+) failed/.exec(out);
  return {
    name: suite.name,
    ok: passed,
    ms: ms,
    out: out,
    timedOut: timedOut,
    detail: tally ? (tally[1] || tally[3]) + ' passed, ' + (tally[2] || tally[4]) + ' failed'
      : passes + ' passed, ' + fails + ' failed',
    error: timedOut ? 'timed out after ' + (timeoutMs / 1000) + ' s'
      : res.error ? res.error.message : (res.status !== 0 ? 'exit code ' + (res.status === null ? res.signal : res.status) : '')
  };
}

function main() {
  const summary = [];
  let anyFailed = false;
  const t0 = Date.now();
  const timeoutMs = argTimeoutMs(process.argv) || DEFAULT_TIMEOUT_MS;

  SUITES.forEach(function (suite) {
    console.log('> node tools/' + suite.file + (suite.args.length ? ' ' + suite.args.join(' ') : ''));
    const r = runSuite(suite, { timeoutMs: timeoutMs });
    if (!r.ok) anyFailed = true;
    if (VERBOSE || !r.ok) console.log(r.out);
    else console.log(lastLines(r.out, 1));
    summary.push(r);
    console.log('');
  });

  console.log('SUMMARY');
  summary.forEach(function (s) {
    console.log('  ' + (s.ok ? 'PASS' : 'FAIL') + '  ' + s.name + '  ' + s.detail + '  (' + (s.ms / 1000).toFixed(1) + ' s)' + (s.error ? '  ' + s.error : ''));
  });
  console.log((anyFailed ? 'TESTS FAILED' : 'ALL TESTS PASSED') + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  process.exit(anyFailed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { SUITES: SUITES, runSuite: runSuite, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS };
