# tokenbar

Show your **real Claude usage** — session (5h) and weekly limits with reset
countdowns — right in your OS status bar, on **macOS, Linux, and Windows**.

The data comes from Anthropic's official `oauth/usage` endpoint — the same source
as Claude Code's `/usage` command — so the percentages and reset times are the
real, server-side numbers (not an estimate from local logs). Because that endpoint
is **account-level**, every device shows the same combined usage; no syncing needed.

```
◉  27% 1:17  ·  W 10%  ·  F 89%   ← session bar + reset countdown, weekly bar, per-model weekly bar
```

## What it shows
- **Session (5h)** utilization % + exact reset time (the window that resets often)
- **Weekly** utilization % + reset time
- **Per-model weekly caps** (e.g. Fable), tagged with the model's initial — these are
  often the binding limit, sitting near 100% while the all-model weekly is still low.
  The segment only appears on accounts that have one; when several exist the bar shows
  the most-consumed and the dropdown lists them all.
- A compact progress bar, colored green → orange → red

## Platforms

| OS | Tech | Folder |
|----|------|--------|
| macOS | [SwiftBar](https://github.com/swiftbar/SwiftBar) menu-bar plugin | [`mac/`](mac/) |
| Linux | GNOME Shell top-bar extension | [`linux/`](linux/) |
| Windows | System-tray indicator (PowerShell) | [`windows/`](windows/) |

All three refresh every **180 s** and share the same behaviour, including
**rate-limit resilience**: they cache the last good result and keep drawing the bar
(countdowns recomputed live) when the endpoint returns 429 / errors, and skip the API
when the last success was very recent. So running the bar on several machines at once
won't break — the shared account-level rate limit may occasionally 429, but each bar
just keeps showing its last-good data with a small "throttled" note.

## Sharing one fetch across machines

That local cache is per-machine, so it makes each bar *degrade gracefully* — it does
not reduce total requests. The rate limit is **account-level**, so N machines polling
every 180 s means N× the requests against one budget, and the MCP server adds more
(it fetches on every tool call). If you run TokenBar in several places, point them all
at one file in a synced folder:

```bash
mkdir -p ~/.config/claude-usage-bar
echo "$HOME/Library/Mobile Documents/com~apple~CloudDocs/tokenbar-usage.json" \
  > ~/.config/claude-usage-bar/shared-cache-path      # iCloud Drive; or Dropbox/OneDrive/Syncthing
```

Or set `TOKENBAR_SHARED_CACHE` to the same path. Then whichever machine polls first
pays for the fetch and the rest reuse it, so **total requests settle at roughly one
per 150 s no matter how many machines you run** (instead of 20/hour each). All four
surfaces — the three bars and the MCP server — read and write the same file.

Details worth knowing:
- Freshness window is 150 s, just under the 180 s poll, so a **single** machine behaves
  exactly as before — nothing gets staler.
- Writes are atomic (temp file + rename), so a peer mid-sync never reads a half-written
  file; a corrupt or unreadable file is ignored and the bar just fetches normally.
- A peer's clock running ahead is treated as fresh rather than as a stale entry.
- A machine that is **not signed in** to Claude Code can still display the account's
  usage from a peer's reading — handy for a work machine you don't run `claude` on.
- Unset it and everything behaves exactly as it did before.

### macOS
```bash
cd mac && bash install-claude-usage-mac.sh
```
Installs the SwiftBar plugin (`claude-usage.180s.sh`), adds SwiftBar to Login Items,
and refreshes. Prereqs: `brew install node`, `brew install --cask swiftbar`, and
signed in to Claude Code once (token read from the macOS Keychain item
`Claude Code-credentials`).

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

## Keeping it authenticated
The OAuth access token expires ~every 8 h and is refreshed automatically whenever you
use **Claude Code** (CLI or the VS Code extension) on that machine — the bar itself
only *reads* the token, never writes it. So on a machine you use regularly it just
stays fresh. If a machine sits idle past the token's lifetime, the bar shows an "auth"
state until you next run Claude Code. (The standalone Claude desktop app uses separate
auth and does **not** refresh this token.)

The Linux version additionally accepts a long-lived token from `claude setup-token`,
placed in `~/.config/claude-usage-bar/token`, used only as a fallback when the
short-lived token is stale — handy for machines left idle for long stretches.

## Notes
- **Read-only**: every version only *reads* the credentials file / Keychain — it
  never writes them back, so it can't rotate your token or log you out.
- The `oauth/usage` endpoint is unofficial/internal (it's what Claude Code's `/usage`
  uses); Anthropic may change it.
- The session/weekly limits shown apply to Max/Pro subscription accounts.
