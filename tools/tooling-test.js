#!/usr/bin/env node
/*
 * Spirit Derby - tools/tooling-test.js (review batch 10: tests, tools and docs sweep)
 *   A  tools/load-core.js traps the whole determinism contract (tools-tests#9): the static scan finds
 *      Date / timers / window / document / localStorage / crypto / Math.random in core source (not in
 *      comments, strings or regexes), the real core scans clean, and at runtime Date, new Date(),
 *      setTimeout, setInterval and Math.random throw when a core file calls them, while test code
 *      keeps using them
 *   B  tools/run-tests.js kills a suite that never exits and reports it as FAIL "timed out" with its
 *      partial output (tools-tests#11); every suite file in SUITES exists
 *   C  tools/serve.js (tools-tests#2, #6, #7): 127.0.0.1 unless --lan / SD_SERVE_HOST (a shell's HOST is ignored); a malformed %-escape or a
 *      NUL byte is a 400 and never stops the server; sibling folders / files sharing the project
 *      folder's name, and dot-folders (.git), are refused
 *
 *   node tools/tooling-test.js [--verbose]
 * Uses a temporary folder under the OS temp dir for the fake project tree and the hanging suite
 * (removed at the end).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const VERBOSE = process.argv.indexOf('--verbose') >= 0;
let passed = 0;
let failed = 0;
function section(t) { console.log('\n' + t); }
function ok(cond, name, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '')); }
  return !!cond;
}
function eq(a, b, name) { return ok(JSON.stringify(a) === JSON.stringify(b), name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const SD = require('./load-core.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-tooling-'));

// =============================================================================
section('A. load-core traps the determinism contract (tools-tests#9)');
// =============================================================================
(function () {
  const scan = SD.testing.scanSource;
  ok(typeof scan === 'function', 'SD.testing.scanSource is exported');
  const tokens = function (src, rel) { return scan(rel || 'js/training.js', src).map(function (h) { return h.token; }); };

  // Rogue code in a core file.
  eq(tokens('r.lastActionAt = Date.now();'), ['Date'], 'Date.now() in a core file');
  eq(tokens('const d = new Date();'), ['Date'], 'new Date() in a core file');
  eq(tokens('setTimeout(function () {}, 10);'), ['setTimeout'], 'setTimeout');
  eq(tokens('const t = setInterval(f, 5);'), ['setInterval'], 'setInterval');
  eq(tokens('globalThis.setTimeout(f);'), ['setTimeout'], 'globalThis.setTimeout');
  eq(tokens("if (typeof window !== 'undefined') window.x = 1;"), ['window', 'window'], 'window behind a typeof guard');
  eq(tokens("if (typeof document !== 'undefined') document.title = 'x';"), ['document', 'document'], 'document behind a typeof guard');
  eq(tokens('localStorage.setItem(k, v);'), ['localStorage'], 'localStorage outside persistence.js');
  eq(tokens('crypto.getRandomValues(buf);'), ['crypto'], 'crypto');
  eq(tokens('const t0 = performance.now();'), ['performance'], 'performance');
  eq(tokens('const x = Math.random();'), ['Math.random'], 'Math.random');
  eq(tokens('const s = `took ${Date.now() - t}`;'), ['Date'], 'inside a template expression');

  // Not code: comments, strings, regexes, properties, object keys.
  eq(tokens('// never Date.now() or window here\n/* setTimeout, document */ const x = 1;'), [], 'comments are ignored');
  eq(tokens("const msg = 'This window is read-only (Date: now)'; const m2 = \"setTimeout\";"), [], 'strings are ignored');
  eq(tokens('const re = /window|Date|setTimeout/g; const t = `a window b`;'), [], 'regex literals and template text are ignored');
  eq(tokens('const a = b / 2; const c = x.window; const d = { window: 1 }; st.meta.Date = 2;'), [], 'division, properties and object keys are not globals');
  eq(tokens('const clock = SD.clock.now(); const updated = 1; const windowed = 2; const Dated = 3;'), [], 'identifiers that merely contain a forbidden word');

  // The allowed uses.
  eq(tokens('function defaultNow() { return Date.now(); }', 'js/namespace.js'), [], 'namespace.js may read Date (the default clock)');
  eq(tokens("if (typeof localStorage !== 'undefined') store = localStorage; globalThis.setTimeout(f, 1);", 'js/persistence.js'), [],
    'persistence.js may use localStorage and the save timer');
  eq(tokens('const d = Date.now();', 'js/persistence.js'), ['Date'], 'but not Date');

  // The real core is clean.
  const all = [];
  SD.testing.coreFiles.forEach(function (rel) {
    const file = path.join(__dirname, '..', rel);
    if (fs.existsSync(file)) scan(rel, fs.readFileSync(file, 'utf8')).forEach(function (h) { all.push(h); });
  });
  eq(all, [], 'every core file passes the scan');
  ok(SD.testing.loadedFiles.length === SD.testing.coreFiles.length, 'load-core loaded every core file');

  // Runtime: a core file calling Date / timers / Math.random throws. SD.bus.emit (js/bus.js) calls its
  // listeners itself, so registering the global function as a listener makes bus.js the caller.
  const errors = [];
  const realError = console.error;
  console.error = function () { errors.push(Array.prototype.slice.call(arguments).map(String).join(' ')); };
  const offs = [];
  let timerRan = false;
  try {
    offs.push(SD.bus.on('tooling:date', Date.now));
    offs.push(SD.bus.on('tooling:dateCall', Date));
    offs.push(SD.bus.on('tooling:timeout', setTimeout));
    offs.push(SD.bus.on('tooling:interval', setInterval));
    SD.testing.strictRandom = false;          // only the caller rule applies now
    offs.push(SD.bus.on('tooling:random', Math.random));
    SD.bus.emit('tooling:date', null);
    SD.bus.emit('tooling:dateCall', null);
    SD.bus.emit('tooling:timeout', function () { timerRan = true; });
    SD.bus.emit('tooling:interval', function () { timerRan = true; });
    SD.bus.emit('tooling:random', null);
  } finally {
    SD.testing.strictRandom = true;
    offs.forEach(function (off) { off(); });
    console.error = realError;
  }
  const said = function (word) { return errors.some(function (e) { return e.indexOf(word + ' is forbidden in Spirit Derby core (js/bus.js)') >= 0; }); };
  ok(said('Date') && errors.filter(function (e) { return /Date is forbidden/.test(e); }).length === 2, 'Date.now() and Date() called from a core file throw', errors);
  ok(said('setTimeout'), 'setTimeout called from a core file throws');
  ok(said('setInterval'), 'setInterval called from a core file throws');
  ok(said('Math.random'), 'Math.random called from a core file throws even with strictRandom off');

  // Test code keeps its clock, timers and (with strictRandom off) Math.random.
  let fine = true;
  try {
    const t = Date.now();
    const d = new Date(0);
    fine = t > 0 && d.getTime() === 0 && d instanceof Date && typeof Date() === 'string' && Date.UTC(2020, 0, 1) > 0;
    SD.testing.strictRandom = false;
    fine = fine && Math.random() >= 0;
  } catch (e) {
    fine = false;
  } finally {
    SD.testing.strictRandom = true;
  }
  ok(fine, 'test code still uses Date, new Date(), Date.UTC and (strictRandom off) Math.random');
  let threw = false;
  try { Math.random(); } catch (e) { threw = /forbidden/.test(e.message); }
  ok(threw, 'strictRandom on: Math.random throws for every caller, as before');
  // SD.clock still reads the real time through namespace.js (the one allowed Date user).
  SD.clock.reset();
  let clockOk = false;
  try { clockOk = Math.abs(SD.clock.now() - Date.now()) < 5000; } catch (e) { clockOk = false; }
  ok(clockOk, 'SD.clock.now() (namespace.js defaultNow) is allowed');
  const h = setTimeout(function () {}, 1);
  clearTimeout(h);
  ok(!timerRan, 'the trapped timers never scheduled anything');
})();

// =============================================================================
section('B. run-tests.js: per-suite timeout (tools-tests#11)');
// =============================================================================
(function () {
  const RT = require('./run-tests.js');
  ok(typeof RT.runSuite === 'function' && Array.isArray(RT.SUITES), 'run-tests.js exports runSuite and SUITES (require() runs nothing)');
  ok(RT.DEFAULT_TIMEOUT_MS >= 60000, 'a default per-suite timeout exists', RT.DEFAULT_TIMEOUT_MS);
  const missing = RT.SUITES.filter(function (s) { return !fs.existsSync(path.join(__dirname, s.file)); });
  eq(missing.map(function (s) { return s.file; }), [], 'every suite in SUITES exists');
  ok(RT.SUITES.some(function (s) { return s.file === 'tooling-test.js'; }) && RT.SUITES.some(function (s) { return s.file === 'escape-test.js'; }),
    'the batch 10 suites (tooling, escape) are registered');

  const hang = path.join(TMP, 'hang-test.js');
  fs.writeFileSync(hang, "console.log('  PASS started'); setInterval(function () {}, 1000);\n");
  const t0 = Date.now();
  const r = RT.runSuite({ name: 'hang', file: hang, args: [] }, { timeoutMs: 1500 });
  const took = Date.now() - t0;
  ok(took < 20000, 'a suite that never exits is stopped (not waited on forever)', took);
  ok(!r.ok && r.timedOut, 'it is reported as failed / timed out', { ok: r.ok, timedOut: r.timedOut, error: r.error });
  ok(/timed out after 1\.5 s/.test(r.error), 'the summary error says "timed out"', r.error);
  ok(/PASS started/.test(r.out) && /FAIL suite timed out/.test(r.out), 'its partial output is kept, with a FAIL line', r.out);

  const good = path.join(TMP, 'good-test.js');
  fs.writeFileSync(good, "console.log('OK: 3 passed, 0 failed');\n");
  const g = RT.runSuite({ name: 'good', file: good, args: [] }, { timeoutMs: 20000 });
  ok(g.ok && !g.timedOut && g.detail === '3 passed, 0 failed', 'a normal suite still passes with its tally', g);
})();

// =============================================================================
section('C. serve.js: local only, no crash on bad paths, no sibling or dot folders (tools-tests#2, #6, #7)');
// =============================================================================
const serve = require('./serve.js');
(function () {
  eq(serve.parseArgs([], {}).host, '127.0.0.1', 'listens on 127.0.0.1 by default');
  eq(serve.parseArgs(['3000'], {}), { port: 3000, host: '127.0.0.1', lan: false }, 'a port argument');
  eq(serve.parseArgs(['8090', '--lan'], {}), { port: 8090, host: '0.0.0.0', lan: true }, '--lan opts in to every interface');
  eq(serve.parseArgs([], { SD_SERVE_HOST: '0.0.0.0', PORT: '9000' }), { port: 9000, host: '0.0.0.0', lan: true }, 'SD_SERVE_HOST / PORT from the environment');
  eq(serve.parseArgs([], { HOST: 'my-machine.local' }), { port: 8090, host: '127.0.0.1', lan: false }, 'a HOST exported by the shell (tcsh: the hostname) does not open the server to the network');
  eq(serve.parseArgs([], { HOST: '0.0.0.0' }).host, '127.0.0.1', 'HOST is ignored altogether (only --lan / SD_SERVE_HOST opt in)');

  const root = path.join(TMP, 'srv', 'Spirit Derby');
  const R = function (u) { return serve.resolvePath(root, u); };
  eq(R('/%E0%A4%A').status, 400, 'a malformed escape is a 400 (not a URIError)');
  eq(R('/%').status, 400, '"/%" is a 400');
  eq(R('/%00').status, 400, 'a NUL byte is a 400');
  eq(R('/js/%00.js').status, 400, 'a NUL byte inside a path is a 400');
  eq(R('/../Spirit Derby - Copy/.git/config').status, 403, 'a sibling folder sharing the name prefix is refused');
  eq(R('/%2e%2e/Spirit%20Derby-backup/secret.txt').status, 403, '… also through %2e%2e');
  eq(R('/../Spirit%20Derby.zip').status, 403, 'a sibling file sharing the name prefix is refused');
  eq(R('/../../Windows/win.ini').status, 403, 'deeper traversal is refused');
  eq(R('/.git/config').status, 403, '.git is not served');
  eq(R('/.claude/launch.json').status, 403, '.claude is not served');
  ok(R('/').ok && path.basename(R('/').file) === 'index.html', '/ is index.html');
  ok(R('/js/main.js?v=2').ok && R('/js/main.js?v=2').file === path.join(root, 'js', 'main.js'), 'a normal file resolves inside the root');
  ok(R('/css/a%20b.css').ok, 'a valid escape still decodes');
})();

function rawGet(port, p) {
  return new Promise(function (resolve) {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', function () { sock.write('GET ' + p + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'); });
    sock.on('data', function (d) { buf += d; });
    sock.on('error', function (e) { resolve({ status: 0, err: e.code || e.message, body: '' }); });
    sock.on('close', function () {
      const m = /^HTTP\/1\.1 (\d+)/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 0, body: buf.split('\r\n\r\n').slice(1).join('\r\n\r\n') });
    });
    sock.setTimeout(5000, function () { sock.destroy(); });
  });
}

(async function () {
  // A fake project folder with siblings and a .git folder next to / inside it.
  const srv = path.join(TMP, 'srv');
  const root = path.join(srv, 'Spirit Derby');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(srv, 'Spirit Derby-backup'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>ok</html>');
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core] secret');
  fs.writeFileSync(path.join(srv, 'Spirit Derby-backup', 'secret.txt'), 'TOP SECRET SIBLING');
  fs.writeFileSync(path.join(srv, 'Spirit Derby.zip'), 'ZIPDATA');

  const server = serve.createServer(root);
  let crashed = null;
  const onUncaught = function (e) { crashed = e; };
  process.on('uncaughtException', onUncaught);
  await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
  const port = server.address().port;
  try {
    eq((await rawGet(port, '/')).status, 200, 'server: / is served');
    for (const p of ['/%E0%A4%A', '/%', '/%00', '/%00.js']) {
      const r = await rawGet(port, p);
      eq(r.status, 400, 'server: ' + p + ' -> 400');
    }
    for (const p of ['/../Spirit%20Derby-backup/secret.txt', '/%2e%2e/Spirit%20Derby-backup/secret.txt',
      '/..%5cSpirit%20Derby-backup%5csecret.txt', '/../Spirit%20Derby.zip', '/.git/config', '/%2egit/config']) {
      const r = await rawGet(port, p);
      ok(r.status !== 200 && !/SECRET|ZIPDATA|secret/.test(r.body), 'server: ' + p + ' is not served', r);
    }
    const after = await rawGet(port, '/index.html');
    ok(after.status === 200 && /ok/.test(after.body), 'server: still up after every hostile request', after);
    ok(!crashed, 'no uncaught exception', crashed && crashed.message);
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    await new Promise(function (res) { server.close(res); });
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n' + (failed ? 'FAILED: ' : 'OK: ') + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
