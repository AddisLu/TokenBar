# claude-usage MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes your **real Claude
usage** as a tool, so any MCP client (Claude Code, Claude Desktop) can just *ask*
"what's my Claude usage?" and get the live session (5h) + weekly numbers from
Anthropic's official `oauth/usage` endpoint (same data as `/usage`).

## Tool
- **`get_claude_usage`** — returns session (5-hour) and weekly utilization %, each
  with time until reset. No arguments.

## Auth
Read-only. Finds a token from (in order): the fresh short-lived session token in
`~/.claude/.credentials.json`, the macOS Keychain (`Claude Code-credentials`), a
long-lived `claude setup-token` in `~/.config/claude-usage-bar/token`, or the
`CLAUDE_CODE_OAUTH_TOKEN` env var. Never writes the token back. On a machine you use
regularly it stays fresh automatically; if it 401s, run `claude` once.

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
Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):
```json
{
  "mcpServers": {
    "claude-usage": { "command": "node", "args": ["/absolute/path/to/mcp/server.mjs"] }
  }
}
```

## Test manually
```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_claude_usage","arguments":{}}}' \
 | node server.mjs
```
