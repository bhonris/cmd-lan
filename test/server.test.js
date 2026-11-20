'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createApp } = require('../src/server');

const PASSWORD = 'open-sesame-123';

function fakePty() {
  const pty = {
    written: [],
    resizes: [],
    killed: 0,
    write: (data) => pty.written.push(data),
    resize: (cols, rows) => pty.resizes.push([cols, rows]),
    kill: () => {
      pty.killed += 1;
    },
    onData: (listener) => {
      pty.emitData = listener;
    },
    onExit: (listener) => {
      pty.emitExit = listener;
    },
  };
  return pty;
}

async function waitFor(check, what = 'condition', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function start(t, options = {}) {
  const ptys = [];
  const spawnCalls = [];
  const clock = { time: Date.now() };
  const app = createApp({
    password: PASSWORD,
    shell: 'fake-shell',
    cwd: 'C:\\somewhere',
    now: () => clock.time,
    spawnPty: (...args) => {
      spawnCalls.push(args);
      const pty = fakePty();
      ptys.push(pty);
      return pty;
    },
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const { port } = app.server.address();
  const host = `127.0.0.1:${port}`;
  const base = `http://${host}`;

  const login = async (password = PASSWORD) => {
    const response = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password }) });
    const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
    return { response, cookie };
  };

  // Opens a terminal socket and records everything the server sends.
  const openTerminal = (cookie, headers = { Origin: base }, query = '') => {
    const ws = new WebSocket(`ws://${host}/ws${query}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    const client = { ws, messages: [], closed: null, rejectedWith: null };
    ws.on('message', (raw) => client.messages.push(JSON.parse(raw.toString())));
    ws.on('close', (code) => {
      client.closed = code;
    });
    ws.on('unexpected-response', (req, res) => {
      client.rejectedWith = res.statusCode;
      req.destroy();
    });
    ws.on('error', () => {});
    client.opened = new Promise((resolve) => ws.on('open', resolve));
    return client;
  };

  return { app, base, host, ptys, spawnCalls, clock, login, openTerminal };
}

test('createApp requires a password and a shell', () => {
  assert.throws(() => createApp({ shell: 'sh' }), /password/);
  assert.throws(() => createApp({ password: PASSWORD }), /shell/);
});

test('serves the page and its assets with security headers', async (t) => {
  const { base } = await start(t);

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<form id="login-form"/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

  for (const [file, type] of [
    ['/app.js', /javascript/],
    ['/style.css', /css/],
    ['/vendor/xterm.js', /javascript/],
    ['/vendor/xterm.css', /css/],
    ['/vendor/addon-fit.js', /javascript/],
  ]) {
    const response = await fetch(base + file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), type, file);
    assert.ok((await response.text()).length > 100, file);
  }

  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('unknown paths, traversal attempts and wrong methods are refused', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/vendor/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/login`)).status, 405);
  assert.equal((await fetch(`${base}/api/logout`)).status, 405);
});

test('login: wrong password is refused, right password starts a session', async (t) => {
  const { base, login } = await start(t);

  assert.equal((await fetch(`${base}/api/session`)).status, 401);

  const wrong = await login('not-the-password');
  assert.equal(wrong.response.status, 401);
  assert.deepEqual(await wrong.response.json(), { error: 'Wrong password' });
  assert.equal(wrong.cookie, '');

  const right = await login();
  assert.equal(right.response.status, 204);
  const setCookie = right.response.headers.get('set-cookie');
  assert.match(setCookie, /^cmdlan_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);

  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: right.cookie } })).status, 204);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: 'cmdlan_session=forged' } })).status, 401);
});

test('login rejects malformed bodies', async (t) => {
  const { base } = await start(t);
  const post = (body) => fetch(`${base}/api/login`, { method: 'POST', body });
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('{"password": 12345678}')).status, 400);
  assert.equal((await post('{}')).status, 400);
  assert.equal((await post(JSON.stringify({ password: 'x'.repeat(5000) }))).status, 400);
});

test('five wrong passwords lock that IP out for five minutes', async (t) => {
  const { login, clock } = await start(t);
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong-guess')).response.status, 401);

  const locked = await login();
  assert.equal(locked.response.status, 429, 'even the right password is refused during lockout');
  assert.equal(locked.response.headers.get('retry-after'), '300');
  assert.match((await locked.response.json()).error, /Try again in 300 seconds/);

  clock.time += 5 * 60 * 1000;
  assert.equal((await login()).response.status, 204);
});

test('a successful login clears earlier failures', async (t) => {
  const { login } = await start(t);
  for (let i = 0; i < 4; i++) await login('wrong-guess');
  assert.equal((await login()).response.status, 204);
  for (let i = 0; i < 4; i++) assert.equal((await login('wrong-guess')).response.status, 401);
  assert.equal((await login()).response.status, 204);
});

test('terminal socket is refused without a session, from another origin, or on another path', async (t) => {
  const { base, host, login, openTerminal, ptys } = await start(t);
  const { cookie } = await login();

  const cases = [
    [openTerminal(null), 401, 'no cookie'],
    [openTerminal('cmdlan_session=forged'), 401, 'forged cookie'],
    [openTerminal(cookie, { Origin: 'http://evil.example' }), 403, 'cross-site origin'],
    [openTerminal(cookie, {}), 403, 'missing origin'],
    [openTerminal(cookie, { Origin: 'not a url' }), 403, 'garbage origin'],
  ];
  for (const [client, status, label] of cases) {
    assert.equal(await waitFor(() => client.rejectedWith, label), status, label);
  }

  const wrongPath = { status: null };
  const ws = new WebSocket(`ws://${host}/other`, { headers: { Cookie: cookie, Origin: base } });
  ws.on('unexpected-response', (req, res) => {
    wrongPath.status = res.statusCode;
    req.destroy();
  });
  ws.on('error', () => {});
  assert.equal(await waitFor(() => wrongPath.status, 'wrong path'), 404);

  assert.equal(ptys.length, 0, 'no shell was started for any refused socket');
});

test('terminal socket bridges input, output, resize and exit to the shell', async (t) => {
  const { login, openTerminal, ptys, spawnCalls } = await start(t);
  const { cookie } = await login();
  const client = openTerminal(cookie);
  await client.opened;

  const pty = await waitFor(() => ptys[0], 'shell spawn');
  const [file, args, options] = spawnCalls[0];
  assert.equal(file, 'fake-shell');
  assert.deepEqual(args, []);
  assert.equal(options.cwd, 'C:\\somewhere');
  assert.equal(options.name, 'xterm-256color');

  pty.emitData('PS C:\\> ');
  await waitFor(() => client.messages.length === 1, 'output');
  assert.deepEqual(client.messages[0], { type: 'output', data: 'PS C:\\> ' });

  const sendRaw = (text) => client.ws.send(text);
  sendRaw(JSON.stringify({ type: 'input', data: 'dir\r' }));
  sendRaw(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  // None of these may reach the shell or crash the server.
  sendRaw('not json');
  sendRaw('null');
  sendRaw('"text"');
  sendRaw(JSON.stringify({ type: 'input', data: { evil: true } }));
  sendRaw(JSON.stringify({ type: 'resize', cols: 0, rows: 40 }));
  sendRaw(JSON.stringify({ type: 'resize', cols: 80.5, rows: 40 }));
  sendRaw(JSON.stringify({ type: 'resize', cols: 80, rows: 100000 }));
  sendRaw(JSON.stringify({ type: 'resize', cols: '80', rows: '24' }));
  sendRaw(JSON.stringify({ type: 'unknown' }));
  sendRaw(JSON.stringify({ type: 'input', data: 'exit\r' }));

  await waitFor(() => pty.written.length === 2, 'input');
  assert.deepEqual(pty.written, ['dir\r', 'exit\r']);
  assert.deepEqual(pty.resizes, [[120, 40]]);

  pty.emitExit({ exitCode: 3 });
  await waitFor(() => client.closed, 'close after exit');
  assert.deepEqual(client.messages.at(-1), { type: 'exit', code: 3 });
  assert.equal(client.closed, 1000);
  assert.equal(pty.killed, 0, 'an already-exited shell is not killed again');
});

test('the startup command is typed into every new shell before anything else', async (t) => {
  const { login, openTerminal, ptys } = await start(t, { startupChoices: [{ name: 'Claude', command: 'claude' }] });
  const { cookie } = await login();
  const first = openTerminal(cookie);
  const second = openTerminal(cookie);
  await Promise.all([first.opened, second.opened]);
  await waitFor(() => ptys.length === 2, 'two shells');

  first.ws.send(JSON.stringify({ type: 'input', data: 'hello' }));
  await waitFor(() => ptys.some((pty) => pty.written.length === 2), 'input');
  const sorted = ptys.map((pty) => pty.written).sort((a, b) => b.length - a.length);
  assert.deepEqual(sorted, [['claude\r', 'hello'], ['claude\r']]);
});

const CLAUDE_OR_CODEX = [
  { name: 'Claude', command: 'claude' },
  { name: 'Codex', command: 'codex --full-auto' },
  { name: 'Just the shell', command: '' },
];

test('the startup choices are listed for signed-in sessions only', async (t) => {
  const { base, login } = await start(t, { startupChoices: CLAUDE_OR_CODEX });
  assert.equal((await fetch(`${base}/api/options`)).status, 401);

  const { cookie } = await login();
  const response = await fetch(`${base}/api/options`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { startupChoices: ['Claude', 'Codex', 'Just the shell'] });
  assert.ok(!body.includes('--full-auto'), 'commands themselves are not sent to the browser');
});

test('with no startup commands configured the list is empty', async (t) => {
  const { base, login } = await start(t);
  const { cookie } = await login();
  const response = await fetch(`${base}/api/options`, { headers: { Cookie: cookie } });
  assert.deepEqual(await response.json(), { startupChoices: [] });
});

test('a terminal runs the chosen startup command, or the first one by default', async (t) => {
  const { base, login, openTerminal, ptys } = await start(t, { startupChoices: CLAUDE_OR_CODEX });
  const { cookie } = await login();
  const origin = { Origin: base };

  for (const [query, expected] of [
    ['', ['claude\r']],
    ['?start=Codex', ['codex --full-auto\r']],
    ['?start=Claude', ['claude\r']],
    ['?start=Just%20the%20shell', []],
  ]) {
    const before = ptys.length;
    const client = openTerminal(cookie, origin, query);
    await client.opened;
    await waitFor(() => ptys.length === before + 1, `shell for "${query}"`);
    assert.deepEqual(ptys[before].written, expected, query);
  }
});

test('a terminal asking for a choice that is not on the list is refused', async (t) => {
  const { base, login, openTerminal, ptys } = await start(t, { startupChoices: CLAUDE_OR_CODEX });
  const { cookie } = await login();
  const origin = { Origin: base };

  for (const query of ['?start=codex', '?start=', '?start=' + encodeURIComponent('calc.exe; claude'), '?start=__proto__']) {
    const client = openTerminal(cookie, origin, query);
    assert.equal(await waitFor(() => client.rejectedWith, query), 400, query);
  }
  assert.equal(ptys.length, 0, 'no shell was started');
});

test('closing the tab kills its shell, and each tab gets its own shell', async (t) => {
  const { login, openTerminal, ptys } = await start(t);
  const { cookie } = await login();
  const first = openTerminal(cookie);
  const second = openTerminal(cookie);
  await Promise.all([first.opened, second.opened]);
  await waitFor(() => ptys.length === 2, 'two shells');

  first.ws.close();
  await waitFor(() => ptys[0].killed === 1, 'first shell killed');
  assert.equal(ptys[1].killed, 0);

  // Output arriving after the socket closed is dropped rather than throwing.
  ptys[0].emitData('late output');
});

test('a shell that is already gone when the tab closes does not crash the server', async (t) => {
  const pty = fakePty();
  pty.kill = () => {
    throw new Error('process not found');
  };
  const { base, login, openTerminal } = await start(t, { spawnPty: () => pty });
  const { cookie } = await login();
  const client = openTerminal(cookie);
  await client.opened;
  client.ws.close();
  await waitFor(() => client.closed, 'close');
  assert.equal((await fetch(base)).status, 200);
});

test('a shell that fails to start is reported in the terminal', async (t) => {
  const { login, openTerminal } = await start(t, {
    spawnPty: () => {
      throw new Error('File not found');
    },
  });
  const { cookie } = await login();
  const client = openTerminal(cookie);
  await waitFor(() => client.closed, 'close');
  assert.equal(client.closed, 1011);
  assert.equal(client.messages.length, 1);
  assert.match(client.messages[0].data, /Could not start fake-shell: File not found/);
});

test('logout ends the session and closes its terminals', async (t) => {
  const { base, login, openTerminal, ptys } = await start(t);
  const { cookie } = await login();
  const other = await login();
  const client = openTerminal(cookie);
  const otherClient = openTerminal(other.cookie);
  await Promise.all([client.opened, otherClient.opened]);
  await waitFor(() => ptys.length === 2, 'shells');

  const response = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /^cmdlan_session=; .*Max-Age=0$/);

  await waitFor(() => client.closed, 'socket closed by logout');
  assert.equal(client.closed, 4001);
  await waitFor(() => ptys.some((pty) => pty.killed === 1), 'shell killed');
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status, 401);

  assert.equal(otherClient.closed, null, 'other sessions stay connected');
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: other.cookie } })).status, 204);

  // Logging out without a session is harmless.
  assert.equal((await fetch(`${base}/api/logout`, { method: 'POST' })).status, 204);
});

test('terminals are closed once their session expires', async (t) => {
  const { app, clock, login, openTerminal, ptys } = await start(t, { sessionTtlMs: 60_000 });
  const { cookie } = await login();
  const client = openTerminal(cookie);
  await client.opened;
  await waitFor(() => ptys[0], 'shell');

  clock.time += 59_000;
  app.sweep();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.closed, null, 'still valid');

  clock.time += 1_000;
  app.sweep();
  await waitFor(() => client.closed, 'socket closed by expiry');
  assert.equal(client.closed, 4001);
  await waitFor(() => ptys[0].killed === 1, 'shell killed');
});

test('runs a real command through a real shell', async (t) => {
  const windows = process.platform === 'win32';
  const { login, openTerminal } = await start(t, {
    shell: windows ? 'powershell.exe' : 'sh',
    shellArgs: windows ? ['-NoLogo', '-NoProfile'] : [],
    cwd: process.cwd(),
    spawnPty: undefined,
    startupChoices: [{ name: 'Sum', command: windows ? 'echo "startup-$(8*8)"' : 'echo "startup-$((8*8))"' }],
  });
  const { cookie } = await login();
  const client = openTerminal(cookie);
  const output = () => client.messages.filter((m) => m.type === 'output').map((m) => m.data).join('');
  await client.opened;
  await waitFor(() => output().includes('startup-64'), 'startup command output', 30_000);

  // The typed text contains the expression, so "smoke-42" can only come from the shell evaluating it.
  const command = windows ? 'echo "smoke-$(6*7)"\r' : 'echo "smoke-$((6*7))"\n';
  client.ws.send(JSON.stringify({ type: 'input', data: command }));
  await waitFor(() => output().includes('smoke-42'), 'command output', 30_000);

  client.ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
  await waitFor(() => client.messages.some((m) => m.type === 'exit'), 'shell exit', 30_000);
});
