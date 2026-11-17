'use strict';

const childProcess = require('node:child_process');

// Wraps node-pty so that shells are shut down cleanly on Windows. Used as-is, node-pty 1.1.0
// has two problems there (checked against its lib/windowsPtyAgent.js):
//   - when a shell exits by itself, the worker thread and pseudoconsole behind it are never
//     released, so a long-running server leaks one of each per closed terminal;
//   - its kill() forks a helper that races the shell's death and prints an
//     "AttachConsole failed" stack trace to this process's stderr.
// So on Windows we end the process tree with taskkill and release node-pty's handles
// ourselves. That release uses node-pty internals, which is why package.json pins the
// exact version; if the internals are missing we fall back to node-pty's own kill().

function releaseWindowsHandles(term) {
  try {
    const agent = term._agent;
    agent._inSocket.readable = false;
    agent._outSocket.readable = false;
    agent._ptyNative.kill(agent._pty, false);
    agent._conoutSocketWorker.dispose();
  } catch {
    term.kill();
  }
}

function spawnShell(file, args, options, deps = {}) {
  const { pty = require('node-pty'), platform = process.platform, execFile = childProcess.execFile } = deps;
  const term = pty.spawn(file, args, options);
  if (platform !== 'win32') return term;

  let exited = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseWindowsHandles(term);
  };

  term.onExit(() => {
    exited = true;
    release();
  });

  return {
    pid: term.pid,
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    onData: (listener) => term.onData(listener),
    onExit: (listener) => term.onExit(listener),
    kill: () => {
      if (exited) return;
      // /T takes the shell's children with it (a running server, ping -t, ...).
      execFile('taskkill', ['/pid', String(term.pid), '/T', '/F'], { windowsHide: true }, () => {
        // Normally the shell's exit has already released everything; if taskkill could not
        // end it, closing the pseudoconsole here does.
        if (!exited) release();
      });
    },
  };
}

module.exports = { spawnShell };
