'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnShell } = require('../src/pty');

// A stand-in for node-pty's Windows terminal, including the internals pty.js releases.
function fakeNodePty({ withInternals = true } = {}) {
  const log = [];
  const exitListeners = [];
  const term = {
    pid: 4242,
    write: (data) => log.push(['write', data]),
    resize: (cols, rows) => log.push(['resize', cols, rows]),
    onData: (listener) => {
      term.emitData = listener;
    },
    onExit: (listener) => exitListeners.push(listener),
    kill: () => log.push(['node-pty kill']),
    emitExit: (event) => exitListeners.forEach((listener) => listener(event)),
  };
  if (withInternals) {
    term._agent = {
      _pty: 'pty-handle',
      _inSocket: { destroy: () => log.push(['input closed']) },
      _ptyNative: { kill: (handle, useDll) => log.push(['native kill', handle, useDll]) },
      _conoutSocketWorker: { dispose: () => log.push(['worker dispose']) },
    };
  }
  const spawnCalls = [];
  const pty = {
    spawn: (...args) => {
      spawnCalls.push(args);
      return term;
    },
  };
  return { pty, term, log, spawnCalls };
}

const RELEASED = [['input closed'], ['native kill', 'pty-handle', true], ['worker dispose']];

function fakeExecFile() {
  const calls = [];
  const execFile = (file, args, options, callback) => calls.push({ file, args, options, callback });
  return { execFile, calls };
}

test('off Windows the node-pty terminal is returned untouched', () => {
  const { pty, term, spawnCalls } = fakeNodePty();
  const shell = spawnShell('bash', ['-l'], { cols: 80 }, { pty, platform: 'linux' });
  assert.equal(shell, term);
  assert.deepEqual(spawnCalls, [['bash', ['-l'], { cols: 80 }]]);
});

test('on Windows the bundled console engine is requested', () => {
  const { pty, spawnCalls } = fakeNodePty();
  spawnShell('powershell.exe', [], { cols: 80 }, { pty, platform: 'win32' });
  assert.deepEqual(spawnCalls, [['powershell.exe', [], { cols: 80, useConptyDll: true }]]);
});

test('on Windows, input, resize and events pass through', () => {
  const { pty, term, log } = fakeNodePty();
  const shell = spawnShell('powershell.exe', [], {}, { pty, platform: 'win32' });
  assert.equal(shell.pid, 4242);

  const seen = [];
  shell.onData((data) => seen.push(data));
  shell.onExit((event) => seen.push(event));
  shell.write('dir\r');
  shell.resize(100, 30);
  term.emitData('output');
  term.emitExit({ exitCode: 0 });

  assert.deepEqual(log.slice(0, 2), [['write', 'dir\r'], ['resize', 100, 30]]);
  assert.deepEqual(seen, ['output', { exitCode: 0 }]);
});

test('on Windows, a shell that exits by itself has its handles released once', () => {
  const { pty, term, log } = fakeNodePty();
  const { execFile, calls } = fakeExecFile();
  const shell = spawnShell('powershell.exe', [], {}, { pty, platform: 'win32', execFile });

  term.emitExit({ exitCode: 0 });
  assert.deepEqual(log, RELEASED);

  shell.kill();
  assert.equal(calls.length, 0, 'nothing left to kill');
  assert.deepEqual(log, RELEASED);
});

test('on Windows, kill ends the process tree and the exit releases the handles', () => {
  const { pty, term, log } = fakeNodePty();
  const { execFile, calls } = fakeExecFile();
  const shell = spawnShell('powershell.exe', [], {}, { pty, platform: 'win32', execFile });

  shell.kill();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '4242', '/T', '/F']);
  assert.deepEqual(log, [], 'handles are released by the exit, not before it');

  term.emitExit({ exitCode: 1 });
  calls[0].callback(null);
  assert.deepEqual(log, RELEASED);
});

test('on Windows, handles are still released if taskkill cannot end the shell', () => {
  const { pty, term, log } = fakeNodePty();
  const { execFile, calls } = fakeExecFile();
  const shell = spawnShell('powershell.exe', [], {}, { pty, platform: 'win32', execFile });

  shell.kill();
  calls[0].callback(new Error('Access is denied'));
  assert.deepEqual(log, RELEASED);

  term.emitExit({ exitCode: 1 });
  assert.deepEqual(log, RELEASED, 'not released twice');
});

test('on Windows, falls back to node-pty kill when its internals are not as expected', () => {
  const { pty, term, log } = fakeNodePty({ withInternals: false });
  spawnShell('powershell.exe', [], {}, { pty, platform: 'win32' });
  term.emitExit({ exitCode: 0 });
  assert.deepEqual(log, [['node-pty kill']]);
});

const windowsOnly = { skip: process.platform !== 'win32' && 'Windows-only' };

function workerCount() {
  return process.getActiveResourcesInfo().filter((name) => name === 'MessagePort').length;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('real Windows shell: exiting by itself leaves no worker thread behind', windowsOnly, async () => {
  const before = workerCount();
  const shell = spawnShell('powershell.exe', ['-NoLogo', '-NoProfile'], { cols: 80, rows: 24 });
  let exit = null;
  shell.onData(() => {});
  shell.onExit((event) => {
    exit = event;
  });
  assert.equal(workerCount(), before + 1);

  shell.write('exit 7\r');
  await waitFor(() => exit, 'shell exit');
  assert.equal(exit.exitCode, 7);
  await waitFor(() => workerCount() === before, 'worker thread to stop');
});

// Regression: Windows' built-in console gave every Thai vowel and tone mark its own cell, so
// full-screen programs (such as Claude Code) put the cursor in the wrong place and Thai text
// lost characters in the browser. The console must count a consonant plus its marks as one cell.
test('real Windows shell: Thai combining marks do not take up their own cells', windowsOnly, async (t) => {
  const shell = spawnShell('powershell.exe', ['-NoLogo', '-NoProfile'], { cols: 80, rows: 24 });
  t.after(() => shell.kill());
  let output = '';
  shell.onData((data) => {
    output += data;
  });

  // "ที่นี่" is two consonants, each carrying a vowel and a tone mark: two cells.
  shell.write('[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Write("ที่นี่"); "=left$([Console]::CursorLeft)="\r');
  await waitFor(() => /=left\d+=/.test(output), 'cursor position');
  assert.equal(/=left(\d+)=/.exec(output)[1], '2');
});

test('real Windows shell: kill ends the shell and its children', windowsOnly, async () => {
  const before = workerCount();
  const shell = spawnShell('powershell.exe', ['-NoLogo', '-NoProfile'], { cols: 80, rows: 24 });
  let output = '';
  let exited = false;
  shell.onData((data) => {
    output += data;
  });
  shell.onExit(() => {
    exited = true;
  });

  // Start a long-running child and have the shell report its PID.
  shell.write('$p = Start-Process ping -ArgumentList "-n 300 127.0.0.1" -NoNewWindow -PassThru; "child=$($p.Id)="\r');
  await waitFor(() => /child=\d+=/.test(output), 'child process to start');
  const childPid = Number(/child=(\d+)=/.exec(output)[1]);
  assert.equal(isRunning(shell.pid), true);
  assert.equal(isRunning(childPid), true);

  shell.kill();
  await waitFor(() => exited, 'shell exit');
  await waitFor(() => !isRunning(shell.pid) && !isRunning(childPid), 'shell and child to be gone');
  await waitFor(() => workerCount() === before, 'worker thread to stop');
});
