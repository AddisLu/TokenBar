# tokenbar

Show your **real Claude usage** — session (5h) and weekly limits with reset
countdowns — right in your OS status bar, on **macOS, Linux, and Windows**.

The data comes from Anthropic's official `oauth/usage` endpoint — the same source
as Claude Code's `/usage` command — so the percentages and reset times are the
real, server-side numbers (not an estimate from local logs). Because that endpoint
is **account-level**, every device shows the same combined usage; no syncing needed.

```
◉  27% 1:17  ·  W 10%          ← session bar + reset countdown, weekly bar
```

## What it shows
- **Session (5h)** utilization % + exact reset time (the window that resets often)
- **Weekly** utilization % + reset time
- A compact two-segment progress bar, colored green → orange → red

## Platforms

| OS | Tech | Folder |
|----|------|--------|
| macOS | [SwiftBar](https://github.com/swiftbar/SwiftBar) menu-bar plugin | [`mac/`](mac/) |
| Linux | GNOME Shell top-bar extension | [`linux/`](linux/) |
| Windows | System-tray indicator (PowerShell) | [`windows/`](windows/) |

All three share the same behaviour, including **rate-limit resilience**: they cache
the last good result and keep drawing the bar (countdowns recomputed live) when the
endpoint returns 429 / errors, and skip the API when the last success was very recent.

### macOS
```bash
cd mac && bash install-claude-usage-mac.sh
```
Installs the SwiftBar plugin (`claude-usage.120s.sh`, refresh every 120 s), adds
SwiftBar to Login Items, and refreshes. Prereqs: `brew install node`,
`brew install --cask swiftbar`, and signed in to Claude Code once (token read from
the macOS Keychain item `Claude Code-credentials`).

### Linux (GNOME)
```bash
cd linux && bash install-linux.sh
```
Installs + enables the GNOME extension, then reload the shell (X11: `Alt+F2` → `r` →
Enter; Wayland: log out/in). Prereqs: Node.js and signed in to Claude Code (token
read from `~/.claude/.credentials.json`).

### Windows
```powershell
cd windows
powershell -ExecutionPolicy Bypass -File install-claude-usage-windows.ps1
```
Installs a system-tray indicator that launches hidden at login. Prereqs: Node.js and
signed in to Claude Code (token read from `%USERPROFILE%\.claude\.credentials.json`).

## Notes
- **Read-only**: every version only *reads* the credentials file / Keychain — it
  never writes them back, so it can't rotate your token or log you out. If the token
  expires, run Claude Code once to refresh it.
- The `oauth/usage` endpoint is unofficial/internal (it's what Claude Code's `/usage`
  uses); Anthropic may change it.
- The session/weekly limits shown apply to Max/Pro subscription accounts.
