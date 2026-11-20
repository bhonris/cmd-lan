# Startup choices

## 1. Feature specification

Today every terminal runs one fixed startup command (`claude`). The owner wants to pick, per terminal, between Claude and Codex. This adds a named list of startup commands in the settings file and a picker in the browser.

## 2. Scope & out of scope

In scope: a `startupCommands` setting (name → command); a picker in the terminal header; the choice remembered per browser; the server starting the chosen command.

Out of scope: typing an arbitrary command in the browser (the browser only ever sends a name from the list); installing or signing in to Codex; running two programs in one tab.

## 3. User stories

- As the owner, I want to choose Claude or Codex when I open a terminal from another computer so that I can use either without editing settings on the host.

## 4. Acceptance criteria

1. With `startupCommands` set to two or more entries, the header shows a picker listing their names; the first entry is the default.
2. Picking an entry starts a fresh terminal that runs that entry's command; the choice is remembered in that browser.
3. With one entry, or only the old `startupCommand`, there is no picker and behaviour is as before.
4. A terminal request naming a choice that isn't in the list is refused (400) and no shell is started.
5. The list of names is only available to signed-in sessions.
6. Bad `startupCommands` in the settings file (not an object, empty, non-string command, blank or over-long name) stops startup with a clear message.

## 5. Architecture & technical design

- `src/config.js`: validates `startupCommands` and returns `startupChoices`, an ordered array of `{ name, command }`. Precedence: `CMD_LAN_STARTUP_COMMAND` env (single choice) → file `startupCommands` → file `startupCommand` (single choice) → none. An empty command means "just the shell".
- `src/server.js`: `createApp({ startupChoices })` replaces the `startupCommand` option. `GET /api/options` returns the names. `/ws?start=<name>` selects a choice; no `start` means the first one.
- `public/`: a `<select>` in the header, filled from `/api/options`, hidden when there are fewer than two choices. Changing it reconnects with the new choice. The choice is kept in `localStorage` as a convenience only.

## 6. API contract

| Method & path | Request | Response |
| --- | --- | --- |
| `GET /api/options` | session cookie | `200 {"startupChoices": ["Claude", "Codex"]}`; `401` when not signed in |
| `GET /ws?start=<name>` (upgrade) | session cookie, same-origin `Origin` | `101`; `400` unknown name; `401`/`403` as before |

## 7. Database changes

N/A — no persistence.

## 8. UI/UX considerations

The picker sits in the header next to the status, labelled "Run". Changing it ends the current terminal and starts a new one, the same as Reconnect. It is keyboard-accessible (a native select) and hidden when there is nothing to choose.

## 9. Security considerations

Commands stay on the host: the browser sends only a name, the server looks it up in its own list and rejects anything else. The names are returned only to authenticated sessions.

## 10. Performance considerations

N/A.

## 11. Edge cases & error handling

- Remembered choice no longer exists (settings changed): the browser falls back to the first choice.
- Chosen program isn't installed: the shell prints its own "not recognized" error and stays at the prompt.

## 12. Testing strategy

Unit tests for config validation and precedence; server tests for `/api/options` (auth, content), default and named choices reaching the pty, and rejection of unknown names; manual browser check of the picker.

## 13. Dependencies

None for the feature. Codex itself is installed separately (`npm install -g @openai/codex`).

## 14. Migration & rollback plan

`startupCommand` keeps working. Remove `startupCommands` from the settings file to go back to a single command.

## 15. Open questions

None.

## 16. Todo list

- [x] Config: `startupCommands` validation and `startupChoices` + tests
- [x] Server: `/api/options`, `?start=` handling + tests
- [x] Browser picker
- [x] README, CLAUDE.md, settings file on this PC
- [x] Verify in a browser
