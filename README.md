# claude-usage-mac-plugin

A [SwiftBar](https://github.com/swiftbar/SwiftBar) menu-bar plugin that shows **real
Claude usage** — session (5h) and weekly limits with reset countdowns — pulled from
Anthropic's official `oauth/usage` endpoint (the same data as Claude Code's `/usage`).

It draws a compact graphical progress bar in the macOS menu bar, matching the look of
the Linux GNOME version:

```
◐◐░  27% 1:17 · W 10%
```

## Install (macOS)

```bash
bash install-claude-usage-mac.sh
```

The installer:
- writes `claude-usage.60s.sh` into SwiftBar's plugin folder,
- checks prerequisites (Node.js, SwiftBar, Claude Code login),
- adds SwiftBar to Login Items and refreshes it.

**Prerequisites**
- `brew install node`
- `brew install --cask swiftbar`
- Signed in to Claude Code once on this Mac (token is read from the macOS Keychain
  item `Claude Code-credentials`, or `~/.claude/.credentials.json` on Linux).

## Install (Windows)

Windows has no menu bar, so the same bar is shown as a **system-tray icon**
(top segment = session, bottom = weekly; hover for %/reset, right-click to
Refresh/Quit). Pure PowerShell — no Node or extra install needed.

```powershell
powershell -ExecutionPolicy Bypass -File windows\install-claude-usage-windows.ps1
```

The installer copies the tray app to `%LOCALAPPDATA%\ClaudeUsageBar`, makes it
launch hidden at login, and starts it. Credentials are read from
`%USERPROFILE%\.claude\.credentials.json` (sign in to Claude Code once first).

## Files
- `claude-usage.60s.sh` — the macOS SwiftBar plugin (source of truth for the design).
- `install-claude-usage-mac.sh` — one-shot macOS installer; embeds a copy of the plugin.
- `windows/claude-usage-tray.ps1` — the Windows system-tray indicator (same data + design).
- `windows/install-claude-usage-windows.ps1` — one-shot Windows installer.

All three read the same `oauth/usage` endpoint and share the same look, colours,
and rate-limit resilience (cache last-good result + 50s throttle guard).

> Every version only **reads** the credentials file / Keychain; it never writes them back.
