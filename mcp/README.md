# claude-usage MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes your **real Claude
usage** as tools, so any MCP client (Claude Code, Claude Desktop) can just *ask*
"what's my Claude usage?" — plus a daily logger that records a usage history you can
ask about later.

## Tools
- **`get_claude_usage`** — current session (5h) + weekly utilization %, each with
  time until reset. Live from Anthropic's `oauth/usage` endpoint. No arguments.
- **`get_usage_history`** — recorded usage snapshots over time (populated by the
  daily logger). Optional `limit` argument.

## Auth
Read-only. Finds a token from (in order): the fresh short-lived session token in
`~/.claude/.credentials.json`, the macOS Keychain (`Claude Code-credentials`), a
long-lived `claude setup-token` in `~/.config/claude-usage-bar/token`, or the
`CLAUDE_CODE_OAUTH_TOKEN` env var. Never writes the token back. If it 401s, run
`claude` once on that machine.

## Install
```bash
cd mcp
npm install
```

## Register with Claude Code
```bash
claude mcp add --scope user claude-usage -- node "$(pwd)/server.mjs"
claude mcp list          # should show: claude-usage ✓ Connected
```
Then in any Claude Code session: *"what's my Claude usage?"* → it calls the tool.

## Register with Claude Desktop
Settings → Developer → Edit Config → add:
```json
{ "mcpServers": { "claude-usage": { "command": "node", "args": ["/abs/path/to/mcp/server.mjs"] } } }
```

## Daily automation — usage history logger
`log-usage.mjs` fetches usage and appends a snapshot to
`~/.local/share/claude-usage-mcp/history.jsonl`. `get_usage_history` reads it back.

Install it (this repo's `mcp/` copied to `~/claude-usage-mcp`), then schedule it.

**Linux (systemd user timer):** copy `systemd/claude-usage-log.{service,timer}` to
`~/.config/systemd/user/`, then:
```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-usage-log.timer   # runs daily
systemctl --user start claude-usage-log.service        # log one now
```
Change cadence by editing `OnCalendar=` in the timer (e.g. `*-*-* 00/6:00:00` = every
6 h for a richer trend).

**macOS (launchd):** wrap `node .../log-usage.mjs` in a LaunchAgent with
`StartCalendarInterval`. **Windows:** a Scheduled Task running
`node ...\log-usage.mjs`.

## Swap in your own daily task
The logger is just the starter task. To run a *different* daily task, point the timer
at your own command instead — e.g. a full Claude Code run:
```
ExecStart=/usr/bin/bash -lc 'claude -p "summarize my Claude usage today and note anything unusual"'
```
Because the MCP is registered user-wide, that `claude -p` run can call
`get_claude_usage` / `get_usage_history` itself.

## Test manually
```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_claude_usage","arguments":{}}}' \
 | node server.mjs
```
