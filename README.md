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

## Files
- `claude-usage.60s.sh` — the SwiftBar plugin (source of truth for the design).
- `install-claude-usage-mac.sh` — one-shot installer; embeds a copy of the plugin.

> The plugin only **reads** the credentials file / Keychain; it never writes them back.
