# cmd-lan

Password-protected web terminal served on the LAN. Specs: `documents/completed/`.

## Commands

- `npm start` — run the server. Settings come from `CMD_LAN_*` env vars, then the git-ignored `cmd-lan.config.json` in the project root, then defaults (see README). A new setting needs adding to `FILE_KEYS` in `src/config.js`, or the file rejects it as unknown.
- `npm test` / `npm run test:coverage` — Node's built-in test runner; coverage must stay at or above 95% of lines in `src/` (`src/cli.js` is excluded, so keep logic out of it).

## Conventions and gotchas

- No build step and no framework: plain CommonJS on the server, plain scripts in `public/`. xterm.js is served from `node_modules` under `/vendor/`, so the app works on a LAN with no internet.
- Static files come from the fixed `STATIC_FILES` allow-list in `src/server.js`. A new front-end file must be added there or it returns 404.
- `createApp` takes its clock (`now`) and pty spawner (`spawnPty`) as options so tests can fake them; keep new time- or process-dependent code injectable the same way.
- `node-pty` is pinned to an exact version on purpose. `src/pty.js` reaches into its internals to release the worker thread and pseudoconsole on Windows (node-pty leaks them when a shell exits by itself, and its own `kill()` prints an "AttachConsole failed" stack trace). When upgrading node-pty, re-check `lib/windowsPtyAgent.js` and run the "real Windows shell" tests in `test/pty.test.js`.
- On Windows `src/pty.js` always passes `useConptyDll: true` (node-pty's bundled conpty.dll/OpenConsole.exe). The console engine built into Windows gives combining characters their own cell, which corrupts Thai (and similar scripts) in full-screen programs such as Claude Code. Do not remove it; the "Thai combining marks" test guards it.
- A test run that passes but never exits means a pty was not released. A real-shell test must kill its shell in `t.after`, or a failed assertion hangs the run.
- Startup commands live only on the host. The browser sends a choice *name* (`/ws?start=<name>`) and the server looks the command up in its own list; never accept a command string from the client.
- This app is remote code execution by design. Every new HTTP route or WebSocket path needs the session check, and WebSocket upgrades must keep the Origin check.
