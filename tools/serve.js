#!/usr/bin/env node
/**
 * Spirit Derby — tiny static file server for local testing.
 *
 * The game itself runs from file:// (double-click index.html). This server only
 * exists so browser automation / OBS can load it over HTTP when file:// is
 * inconvenient. No dependencies.
 *
 *   node tools/serve.js            → http://localhost:8090 (this computer only)
 *   node tools/serve.js 3000       → http://localhost:3000
 *   node tools/serve.js 8090 --lan → also reachable from other devices on the network
 *                                     (or SD_SERVE_HOST=0.0.0.0 node tools/serve.js)
 *
 * Review batch 10 (tools-tests#2, #6, #7):
 *  - it listens on 127.0.0.1 unless --lan (or SD_SERVE_HOST) is given; the generic HOST variable is
 *    ignored, because some shells (tcsh) export it as the machine's name, which would open the server
 *    to the network without being asked;
 *  - a malformed %-escape or a NUL byte in the path is a 400, and no request can crash the server
 *    (a handler exception is a 500, server errors are logged);
 *  - only files inside the project folder are served (checked with path.relative, so a sibling folder
 *    such as "Spirit Derby - Copy" or a file "Spirit Derby.zip" is refused), and nothing under a
 *    dot-folder or dot-file (.git, .claude) is served.
 * require('./tools/serve.js') starts nothing: it exports { resolvePath, createServer, parseArgs }.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** argv (after the script) + env -> { port, host, lan } */
function parseArgs(argv, env) {
  argv = argv || [];
  env = env || {};
  const lan = argv.indexOf('--lan') >= 0;
  const portArg = argv.filter(function (a) { return /^\d+$/.test(a); })[0];
  const port = Number(portArg) || Number(env.PORT) || 8090;
  // Only a dedicated variable opts in: HOST is often set by the shell to the machine's hostname.
  const host = lan ? '0.0.0.0' : (String(env.SD_SERVE_HOST || '').trim() || '127.0.0.1');
  return { port: port, host: host, lan: lan || (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') };
}

/**
 * The file a request URL maps to under root.
 * -> { ok:true, file, urlPath } | { ok:false, status: 400 | 403, message }
 */
function resolvePath(root, url) {
  const raw = String(url || '/').split('?')[0].split('#')[0];
  let urlPath;
  try { urlPath = decodeURIComponent(raw); } catch (e) { return { ok: false, status: 400, message: 'Bad request' }; }
  if (urlPath.indexOf('\0') >= 0) return { ok: false, status: 400, message: 'Bad request' };
  const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  const rel = path.relative(root, file);
  if (rel === '..' || rel.indexOf('..' + path.sep) === 0 || path.isAbsolute(rel)) {
    return { ok: false, status: 403, message: 'Forbidden' };
  }
  // No dot-folders / dot-files (.git, .claude, .env ...).
  if (rel.split(path.sep).some(function (seg) { return seg.charAt(0) === '.'; })) {
    return { ok: false, status: 403, message: 'Forbidden' };
  }
  return { ok: true, file: file, urlPath: urlPath };
}

function send(res, status, text) {
  if (res.headersSent) { try { res.end(); } catch (e) { /* ignore */ } return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function createServer(root) {
  root = path.resolve(root || ROOT);
  const server = http.createServer(function (req, res) {
    try {
      const r = resolvePath(root, req.url);
      if (!r.ok) { send(res, r.status, r.message); return; }
      let filePath = r.file;
      fs.stat(filePath, function (err, stat) {
        try {
          if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
          fs.readFile(filePath, function (readErr, data) {
            if (readErr) { send(res, 404, 'Not found'); return; }
            res.writeHead(200, {
              'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
              'Cache-Control': 'no-store',
            });
            res.end(data);
          });
        } catch (e) {
          send(res, 500, 'Server error');
        }
      });
    } catch (e) {
      send(res, 500, 'Server error');
    }
  });
  server.on('clientError', function (err, socket) {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) { /* ignore */ }
  });
  return server;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2), process.env);
  const server = createServer(ROOT);
  server.on('error', function (err) {
    console.error('Spirit Derby dev server: ' + (err && err.message ? err.message : err));
    if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EADDRNOTAVAIL')) process.exit(1);
  });
  server.listen(opts.port, opts.host, function () {
    const shown = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
    console.log('Spirit Derby dev server: http://' + (shown === '127.0.0.1' ? 'localhost' : shown) + ':' + opts.port +
      '  (root: ' + ROOT + ')' + (opts.lan ? '  [listening on ' + opts.host + ': other devices on the network can connect]' : ''));
  });
}

module.exports = { resolvePath: resolvePath, createServer: createServer, parseArgs: parseArgs, ROOT: ROOT };
