#!/usr/bin/env node
// Claude Usage MCP server — exposes REAL Claude usage (session 5h + weekly) from
// Anthropic's official oauth/usage endpoint (same data as Claude Code's /usage),
// so any MCP client (Claude Code, Claude Desktop) can just *ask* about usage,
// plus a usage-history trend recorded by the daily logger (log-usage.mjs).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchUsage, humanSummary, readHistory } from './usage-core.mjs';

const server = new McpServer({name: 'claude-usage', version: '1.1.0'});

server.registerTool('get_claude_usage', {
    title: 'Get Claude usage',
    description: 'Get the current REAL Claude subscription usage — session (5-hour rolling window) and weekly limits, each as a percentage used with time until reset. Source: Anthropic\'s official oauth/usage endpoint (same as Claude Code\'s /usage). Use when the user asks about their Claude usage, limits, quota, or when their session/weekly limit resets.',
    inputSchema: {},
}, async () => {
    const u = await fetchUsage();
    return {content: [{type: 'text', text: humanSummary(u) + '\n\n' + JSON.stringify(u)}]};
});

server.registerTool('get_usage_history', {
    title: 'Get Claude usage history',
    description: 'Return recorded historical Claude usage snapshots (session % and weekly % over time), written daily by the logger. Use when the user asks about their usage trend, history, or "how much have I used this week/lately".',
    inputSchema: {limit: z.number().int().positive().max(1000).optional().describe('Max number of most-recent snapshots to return (default 60)')},
}, async ({limit}) => {
    const rows = readHistory(limit ?? 60);
    if (!rows.length) return {content: [{type: 'text', text: 'No usage history recorded yet. The daily logger (log-usage.mjs) will populate it.'}]};
    const first = rows[0], last = rows[rows.length - 1];
    const summary = `Usage history: ${rows.length} snapshots from ${first.ts} to ${last.ts}. `
        + `Latest — session ${last.session}%, weekly ${last.weekly}%.`;
    return {content: [{type: 'text', text: summary + '\n\n' + JSON.stringify(rows)}]};
});

const transport = new StdioServerTransport();
await server.connect(transport);
