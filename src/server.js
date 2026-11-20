'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { COOKIE_NAME, passwordMatches, parseCookies, SessionStore, LoginLimiter } = require('./auth');
const { spawnShell } = require('./pty');

const ROOT = path.join(__dirname, '..');
const MAX_LOGIN_BODY = 1024;
const MAX_WS_PAYLOAD = 1024 * 1024;
const MAX_TERMINAL_SIZE = 1000;

// Fixed allow-list: a request path can only ever map to one of these files.
const STATIC_FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isValidSize(n) {
  return Number.isInteger(n) && n >= 2 && n <= MAX_TERMINAL_SIZE;
}

function createApp({
  password,
  shell,
  shellArgs = [],
  cwd,
  startupChoices = [],
  env = process.env,
  spawnPty = spawnShell,
  now = Date.now,
  sessionTtlMs,
  sweepIntervalMs = 60 * 1000,
} = {}) {
  if (!password) throw new Error('a password is required');
  if (!shell) throw new Error('a shell is required');

  const sessions = new SessionStore({ ttlMs: sessionTtlMs, now });
  const limiter = new LoginLimiter({ now });
  const socketsByToken = new Map();

  function send(res, status, headers = {}, body) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  function sendError(res, status, message, headers) {
    send(res, status, { 'Content-Type': 'application/json', ...headers }, JSON.stringify({ error: message }));
  }

  function tokenOf(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return token && sessions.has(token) ? token : null;
  }

  function closeSockets(token) {
    for (const ws of socketsByToken.get(token) || []) ws.close(4001, 'session ended');
    socketsByToken.delete(token);
  }

  async function handleLogin(req, res) {
    const ip = req.socket.remoteAddress;
    const retryAfter = limiter.retryAfter(ip);
    if (retryAfter > 0) {
      sendError(res, 429, `Too many failed attempts. Try again in ${retryAfter} seconds.`, { 'Retry-After': String(retryAfter) });
      return;
    }

    let candidate;
    try {
      candidate = JSON.parse(await readBody(req, MAX_LOGIN_BODY)).password;
    } catch {
      sendError(res, 400, 'Expected a JSON body like {"password": "..."}');
      return;
    }
    if (typeof candidate !== 'string') {
      sendError(res, 400, 'Expected a JSON body like {"password": "..."}');
      return;
    }

    if (!passwordMatches(candidate, password)) {
      limiter.recordFailure(ip);
      sendError(res, 401, 'Wrong password');
      return;
    }

    limiter.reset(ip);
    const token = sessions.create();
    const maxAge = Math.floor(sessions.ttlMs / 1000);
    send(res, 204, { 'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` });
  }

  function handleRequest(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/login' || pathname === '/api/logout') {
      if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed', { Allow: 'POST' });
      if (pathname === '/api/login') return handleLogin(req, res);
      const token = tokenOf(req);
      if (token) {
        sessions.delete(token);
        closeSockets(token);
      }
      return send(res, 204, { 'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }

    if (pathname === '/api/session') {
      return tokenOf(req) ? send(res, 204) : sendError(res, 401, 'Not signed in');
    }

    if (pathname === '/api/options') {
      if (!tokenOf(req)) return sendError(res, 401, 'Not signed in');
      const body = JSON.stringify({ startupChoices: startupChoices.map((choice) => choice.name) });
      return send(res, 200, { 'Content-Type': 'application/json' }, body);
    }

    const entry = STATIC_FILES[pathname];
    if (!entry) return sendError(res, 404, 'Not found');
    fs.readFile(path.join(ROOT, entry[0]), (err, data) => {
      if (err) return sendError(res, 500, 'Could not read file');
      send(res, 200, { 'Content-Type': entry[1] }, req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  function rejectUpgrade(socket, status, reason) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  // Browsers always send Origin on WebSocket handshakes; requiring it to match Host
  // stops another website's JavaScript from opening a terminal with the user's cookie.
  function isSameOrigin(req) {
    try {
      return new URL(req.headers.origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    const token = tokenOf(req);
    if (!token) return rejectUpgrade(socket, 401, 'Unauthorized');
    if (!isSameOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden');

    // The browser names a choice; the command itself only ever comes from the host's settings.
    const wanted = searchParams.get('start');
    const choice = wanted === null ? startupChoices[0] : startupChoices.find((c) => c.name === wanted);
    if (wanted !== null && !choice) return rejectUpgrade(socket, 400, 'Bad Request');

    wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(ws, token, choice ? choice.command : ''));
  });

  function attachTerminal(ws, token, startupCommand) {
    const sendMessage = (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };

    let pty;
    try {
      pty = spawnPty(shell, shellArgs, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
    } catch (err) {
      sendMessage({ type: 'output', data: `\r\nCould not start ${shell}: ${err.message}\r\n` });
      ws.close(1011, 'shell failed to start');
      return;
    }

    if (!socketsByToken.has(token)) socketsByToken.set(token, new Set());
    socketsByToken.get(token).add(ws);

    // Typed into the shell rather than passed as arguments, so it works the same in any
    // shell and leaves a normal prompt when the command exits.
    if (startupCommand) pty.write(`${startupCommand}\r`);

    let exited = false;
    pty.onData((data) => sendMessage({ type: 'output', data }));
    pty.onExit(({ exitCode }) => {
      exited = true;
      sendMessage({ type: 'exit', code: exitCode });
      ws.close(1000, 'shell exited');
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (exited || message === null || typeof message !== 'object') return;
      if (message.type === 'input' && typeof message.data === 'string') {
        pty.write(message.data);
      } else if (message.type === 'resize' && isValidSize(message.cols) && isValidSize(message.rows)) {
        pty.resize(message.cols, message.rows);
      }
    });

    ws.on('close', () => {
      socketsByToken.get(token)?.delete(ws);
      if (exited) return;
      exited = true;
      try {
        pty.kill();
      } catch {
        // The shell was already gone.
      }
    });
  }

  // Close terminals whose session has expired since they connected.
  function sweep() {
    for (const token of [...socketsByToken.keys()]) {
      if (!sessions.has(token)) closeSockets(token);
    }
  }
  const sweepTimer = setInterval(sweep, sweepIntervalMs);
  sweepTimer.unref();

  function close() {
    clearInterval(sweepTimer);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { server, sessions, sweep, close };
}

module.exports = { createApp };
