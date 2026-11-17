# cmd-lan

## 1. Feature specification

A small web app that exposes this machine's command line in a browser. The server runs on the host PC, listens on the LAN, and any other computer on the same network can open the page, sign in with a password, and get a real interactive terminal (PowerShell by default) running on the host.

## 2. Scope & out of scope

In scope:

- Node.js server serving a single-page terminal UI (xterm.js) and a WebSocket that bridges to a real pseudo-terminal (ConPTY via `node-pty`).
- Password login with a session cookie; all terminal access requires it.
- Multiple simultaneous browser tabs/computers, each with its own shell.
- Terminal resize, colours, interactive programs (vim, `python`, etc.).
- Startup banner listing the LAN URLs and the password.

Out of scope:

- HTTPS/TLS. Traffic is plain HTTP, acceptable only on a trusted LAN (see Security).
- Access from the internet, port forwarding, tunnelling.
- Multiple user accounts or per-user permissions. One password, and the shell runs as the Windows user that started the server.
- Session persistence: a shell dies when its browser tab disconnects or the server stops.
- File upload/download UI, shared/collaborative sessions.
- Opening the Windows Firewall port automatically (documented as a manual step).

## 3. User stories

- As the owner of the host PC, I want to start one command and get a URL so that I can use its command line from my other computers.
- As the owner, I want access to require a password so that other people on the network cannot run commands on my PC.
- As a remote user, I want a real terminal (colours, arrow keys, Ctrl+C, resizing) so that it behaves like sitting at the PC.

## 4. Acceptance criteria

1. `npm start` starts the server on `0.0.0.0:3000` (configurable) and prints the LAN URLs and the password.
2. Without a valid session, `/` shows only the login form, `GET /api/session` returns 401, and a WebSocket upgrade on `/ws` is rejected with 401.
3. A correct password sets an `HttpOnly; SameSite=Strict` session cookie; a wrong one returns 401.
4. After 5 failed logins from one IP, further attempts from that IP return 429 for 5 minutes.
5. An authenticated WebSocket spawns a shell; typed input reaches it and its output is rendered in the browser.
6. Resizing the browser window resizes the pty.
7. Closing the tab kills that tab's shell process; shell exit is reported in the terminal with a reconnect option.
8. WebSocket upgrades whose `Origin` header doesn't match the `Host` are rejected (403).
9. Logout invalidates the session and closes that session's terminals.
10. `npm run test:coverage` passes with at least 95% line coverage of `src/`.

## 5. Architecture & technical design

```
browser (xterm.js)  <— WebSocket /ws —>  server.js  <—>  node-pty  <—>  powershell.exe
        |— HTTP: /, /api/login, /api/logout, /api/session, static assets
```

- `src/auth.js` — session store (random 256-bit tokens, 12 h expiry), constant-time password check, per-IP login rate limiter, cookie parsing. No I/O, so it is unit-testable; takes an injectable clock.
- `src/server.js` — `createApp(options)` builds an `http.Server` plus a `ws` server in `noServer` mode. It handles routing, static files, the upgrade handshake (cookie + Origin check) and the pty bridge. The pty spawner is injected (`spawnPty`) so tests can use a fake.
- `src/pty.js` — thin wrapper over `node-pty`. On Windows, node-pty leaks a worker thread and pseudoconsole when a shell exits by itself and its `kill()` prints a stack trace, so the wrapper ends the process tree with `taskkill` and releases node-pty's handles itself (using node-pty internals, hence the pinned version).
- `src/config.js` — resolves port/host/password/shell from env vars and lists LAN IPv4 addresses.
- `src/cli.js` — entry point: loads config, starts the app, prints the banner.
- `public/` — `index.html`, `app.js`, `style.css`. xterm.js and its fit addon are served from `node_modules` under `/vendor/` (no CDN, so it works on an offline LAN).

WebSocket protocol (JSON text frames):

- client → server: `{"type":"input","data":"..."}`, `{"type":"resize","cols":N,"rows":N}`
- server → client: `{"type":"output","data":"..."}`, `{"type":"exit","code":N}`

## 6. API contract

| Method & path | Request | Response |
| --- | --- | --- |
| `POST /api/login` | JSON `{"password": "..."}` (max 1 KB) | `204` + `Set-Cookie: cmdlan_session=...`; `400` bad body; `401` wrong password; `429` rate limited (`Retry-After`) |
| `POST /api/logout` | session cookie | `204`, cookie cleared, session's sockets closed |
| `GET /api/session` | session cookie | `204` if valid, `401` otherwise |
| `GET /ws` (upgrade) | session cookie, same-origin `Origin` | `101`; `401` no session; `403` bad origin |
| `GET /`, `/app.js`, `/style.css`, `/vendor/*` | — | static files; `404` otherwise; `405` for other methods |

Errors are JSON: `{"error": "message"}`.

## 7. Database changes

N/A — no persistence; sessions live in memory.

## 8. UI/UX considerations

- Login screen: single password field, inline error for wrong password / rate limit.
- Terminal screen: full-viewport terminal, slim header with host name, connection status and a Log out button. Terminal refits on window resize.
- Disconnected / exited state: message in the terminal plus a Reconnect button.
- Works on phone-width screens (the terminal just gets fewer columns).

## 9. Security considerations

This app is remote code execution by design, so the password is the only barrier.

- Password: from `CMD_LAN_PASSWORD`, otherwise a random 16-character one is generated on each start and printed to the host console. Compared in constant time.
- Login rate limit per IP (5 failures → 5-minute lockout) to slow brute force.
- Session cookie is `HttpOnly`, `SameSite=Strict`, 12 h lifetime. WebSocket upgrades also check `Origin` against `Host`, blocking cross-site WebSocket hijacking from a malicious web page.
- Static file serving uses a fixed allow-list of files, so there is no path traversal surface.
- Known limitation: plain HTTP. Anyone able to sniff the LAN can read the password and the session. Use only on a network you trust; never port-forward it to the internet.
- The shell has the full rights of the Windows user who started the server.

## 10. Performance considerations

Single user, a handful of sessions. Pty output is forwarded as it arrives; no buffering or caching needed. WebSocket message size is capped at 1 MB.

## 11. Edge cases & error handling

- Malformed or unknown WebSocket messages are ignored; invalid resize dimensions are ignored.
- Pty spawn failure: an error line is sent to the client and the socket is closed.
- Shell exits: client gets an `exit` message and the socket closes.
- Socket closes: pty is killed.
- Session expires or is logged out while connected: its sockets are closed.
- Oversized or non-JSON login body: `400`.
- Port already in use: the CLI prints a clear message and exits non-zero.

## 12. Testing strategy

- Unit tests (`node:test`) for `auth.js` (sessions, expiry, rate limiter, cookie parsing) and `config.js`.
- Integration tests for `server.js` against a real HTTP server on an ephemeral port with a fake pty: login flow, rate limiting, static files, upgrade rejection (no cookie, bad origin), input/output/resize/exit bridging, logout closing sockets.
- Tests with the real `node-pty`: run a command and see its output; on Windows, a shell that exits or is killed leaves no worker thread or child process behind.
- Manual: open from a second computer on the LAN.

## 13. Dependencies

- `node-pty` pinned to exactly 1.1.0 (ConPTY bindings; see `src/pty.js`), `ws` (WebSocket server), `@xterm/xterm`, `@xterm/addon-fit` (browser terminal).
- Node.js 20+.

## 14. Migration & rollback plan

N/A — new standalone app. Stop the process to turn it off.

## 15. Open questions

None blocking. Possible later additions: HTTPS with a self-signed certificate, running as a Windows service.

## 16. Todo list

- [x] Project scaffold and dependencies
- [x] `auth.js` + tests
- [x] `config.js` + tests
- [x] `server.js` + tests
- [x] Front end (login + terminal)
- [x] CLI entry point and banner
- [x] README and CLAUDE.md
- [x] Coverage ≥ 95%, run the app and verify in a browser
