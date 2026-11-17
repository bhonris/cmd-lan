# Startup command and saved settings

## 1. Feature specification

Every new terminal should open in a chosen folder and immediately run a command (here: `C:\repos\iso-27001` and `claude`), without having to set environment variables on each start. This adds a `startupCommand` setting and an optional settings file that `npm start` reads.

## 2. Scope & out of scope

In scope: a `startupCommand` setting typed into each new shell; a `cmd-lan.config.json` file in the project root holding any of the settings; environment variables still override the file.

Out of scope: per-tab or per-user commands, choosing the command from the browser, restarting the command when it exits (the user is left at the shell prompt).

## 3. User stories

- As the owner, I want every terminal to open in my project folder with Claude already running so that I can start working from another computer straight away.

## 4. Acceptance criteria

1. With `startupCommand` set, each new terminal runs it once, right after the shell starts; when it exits the shell stays usable.
2. Without it, behaviour is unchanged.
3. `cmd-lan.config.json` may set `port`, `host`, `password`, `shell`, `cwd`, `startupCommand`; a `CMD_LAN_*` environment variable wins over the file.
4. A missing file is fine; invalid JSON, a non-object, or an unknown key stops startup with a message naming the problem.

## 5. Architecture & technical design

- `src/config.js`: `readConfigFile(path)` returns the parsed object (or `{}` if the file is absent) and validates keys; `loadConfig(env, platform, fileConfig)` merges env over file over defaults. New env var `CMD_LAN_STARTUP_COMMAND`.
- `src/server.js`: `createApp({ startupCommand })` writes `startupCommand + "\r"` to the pty right after spawning it. Typing it into the shell (rather than passing shell arguments) works the same for PowerShell, cmd and bash, and leaves a normal prompt afterwards.
- `src/cli.js`: reads the file from the project root and prints the startup command in the banner.

## 6. API contract

N/A — no HTTP or WebSocket changes.

## 7. Database changes

N/A — no persistence beyond the settings file.

## 8. UI/UX considerations

N/A — the browser UI is unchanged; the command simply appears in the terminal.

## 9. Security considerations

The startup command comes only from the host's own file or environment, never from the browser. The settings file can contain the password, so it is git-ignored.

## 10. Performance considerations

N/A.

## 11. Edge cases & error handling

- `cwd` that doesn't exist: the shell fails to start and the existing "Could not start" message is shown in the terminal.
- Startup command not found: the shell prints its own error and stays at the prompt.

## 12. Testing strategy

Unit tests for file reading, validation and precedence; a server test with the fake pty that the command is written once before any client input; the real-shell test runs a startup command and sees its output.

## 13. Dependencies

None.

## 14. Migration & rollback plan

Delete `cmd-lan.config.json` to return to the defaults.

## 15. Open questions

None.

## 16. Todo list

- [x] Config file reading, validation, precedence + tests
- [x] Startup command in server + tests
- [x] CLI banner, README, CLAUDE.md, .gitignore
- [x] Write the settings file for this PC and restart
