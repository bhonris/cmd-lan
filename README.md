# cmd-lan

A password-protected web terminal for this PC. Start it, then open the printed URL from any computer on the same network to get a real PowerShell session in the browser.

## Use

```
npm install
npm start
```

The console prints something like:

```
  This computer:   http://localhost:3000
  Other computers: http://192.168.1.20:3000

  Password: kq3ZxT0b1c9RtYwA
```

Open the "Other computers" URL on another machine and enter the password.

The first time, Windows Firewall asks whether to allow Node.js on the network: allow it for **Private** networks. If you dismissed that prompt, or other computers can't connect, add the rule from an administrator PowerShell:

```
New-NetFirewallRule -DisplayName "cmd-lan" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

## Settings

All settings are optional. Save them in `cmd-lan.config.json` in this folder, or set the environment variable, which wins over the file:

| File key | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `password` | `CMD_LAN_PASSWORD` | random, new on every start | Password to sign in (at least 8 characters) |
| `port` | `CMD_LAN_PORT` | `3000` | Port to listen on |
| `host` | `CMD_LAN_HOST` | `0.0.0.0` (all interfaces) | Address to listen on; `127.0.0.1` for this computer only |
| `shell` | `CMD_LAN_SHELL` | `powershell.exe` | Shell to run, e.g. `cmd.exe` or `pwsh.exe` |
| `cwd` | `CMD_LAN_CWD` | your home folder | Folder each terminal starts in |
| `startupCommand` | `CMD_LAN_STARTUP_COMMAND` | none | Command run in each new terminal; when it exits you are left at the shell prompt |

Example file (backslashes are doubled in JSON):

```json
{
  "cwd": "C:\\repos\\iso-27001",
  "startupCommand": "claude"
}
```

Example with variables: `$env:CMD_LAN_PASSWORD = "a long passphrase"; $env:CMD_LAN_SHELL = "cmd.exe"; npm start`

The file is git-ignored because it can hold the password. Restart the server after changing it.

## Security

Anyone who signs in can run any command as the Windows user that started the server.

- The connection is plain HTTP, not encrypted. Someone able to capture traffic on your network can read the password and everything typed. Use it only on a network you trust.
- Never forward this port from your router to the internet.
- Five wrong passwords lock that computer's IP address out for five minutes.
- Stop the server (Ctrl+C) when you're not using it.

## Notes

- Each browser tab gets its own shell. Closing the tab ends that shell and anything running in it.
- Copy: select text, then Ctrl+C. Paste: Ctrl+V. Ctrl+C with nothing selected interrupts the running command.

## Development

```
npm test                # run the tests
npm run test:coverage   # same, failing under 95% line coverage of src/
```
