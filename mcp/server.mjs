#!/usr/bin/env node
// Claude Usage MCP server — exposes REAL Claude usage (session 5h + weekly) from
// Anthropic's official oauth/usage endpoint (same data as Claude Code's /usage),
// so any MCP client (Claude Code, Claude Desktop) can just *ask* about usage.
//
// Read-only auth: reads the OAuth token from ~/.claude/.credentials.json, the macOS
// Keychain, a long-lived `claude setup-token` file, or CLAUDE_CODE_OAUTH_TOKEN.
// It never writes the token back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const CRED = path.join(os.homedir(), '.claude', '.credentials.json');
const TOKEN_FILE = path.join(os.homedir(), '.config', 'claude-usage-bar', 'token');
const URL = 'https://api.anthropic.com/api/oauth/usage';

function readCredsJson() {
    try { return JSON.parse(fs.readFileSync(CRED, 'utf8')).claudeAiOauth; } catch {}
    if (process.platform === 'darwin') {
        try {
            const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {encoding: 'utf8'});
            return JSON.parse(raw).claudeAiOauth;
        } catch {}
    }
    return null;
}

// Prefer the fresh short-lived session token; fall back to a long-lived setup-token.
function pickToken() {
    const c = readCredsJson() || {};
    let longTok;
    try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) longTok = t; } catch {}
    if (!longTok && process.env.CLAUDE_CODE_OAUTH_TOKEN) longTok = process.env.CLAUDE_CODE_OAUTH_TOKEN.trim();

    if (c.accessToken && c.expiresAt && Date.now() < c.expiresAt - 60000)
        return {tok: c.accessToken, sub: c.subscriptionType, source: 'session'};
    if (longTok) return {tok: longTok, sub: c.subscriptionType, source: 'longlived'};
    if (c.accessToken) return {tok: c.accessToken, sub: c.subscriptionType, source: 'session-stale'};
    return {tok: null};
}

async function fetchUsage() {
    const {tok, sub, source} = pickToken();
    if (!tok) return {ok: false, error: 'not-logged-in', hint: 'Run `claude` once to sign in on this machine.'};
    let res;
    try {
        res = await fetch(URL, {
            headers: {
                'Authorization': `Bearer ${tok}`,
                'anthropic-beta': 'oauth-2025-04-20',
                'anthropic-version': '2023-06-01',
                'Accept': 'application/json',
                'User-Agent': 'claude-usage-mcp',
            },
            signal: AbortSignal.timeout(15000),
        });
    } catch (e) { return {ok: false, error: 'network', detail: String(e?.message || e)}; }

    if (res.status === 401 || res.status === 403)
        return {ok: false, error: 'auth-expired',
            hint: source === 'longlived' ? 'Long-lived token expired — run `claude setup-token`.' : 'Token expired — run `claude` once to refresh.'};
    if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        return {ok: false, error: 'rate-limited', retryAfterSeconds: ra ? Number(ra) : null,
            hint: 'Account-level rate limit (per token). Wait, or run `claude` on this machine to get a fresh token.'};
    }
    if (!res.ok) return {ok: false, error: `http-${res.status}`};

    const d = await res.json();
    const lim = Array.isArray(d.limits) ? d.limits : [];
    const norm = (l, fb) => {
        const x = l || fb;
        if (!x) return null;
        const resetsAt = x.resets_at ?? null;
        const mins = resetsAt ? Math.max(0, Math.round((new Date(resetsAt) - Date.now()) / 60000)) : null;
        return {percent: Math.round(x.percent ?? x.utilization ?? 0), resetsAt, resetsInMinutes: mins, severity: x.severity ?? 'normal'};
    };
    const session = norm(lim.find(l => l.kind === 'session'), d.five_hour);
    const weekly = norm(lim.find(l => l.kind === 'weekly_all'), d.seven_day);
    return {ok: true, subscription: sub || null, fetchedAt: new Date().toISOString(), session, weekly};
}

function humanSummary(u) {
    if (!u.ok) return `Claude usage unavailable (${u.error}). ${u.hint || ''}`.trim();
    const fmt = (l, name) => {
        if (!l) return `${name}: n/a`;
        const h = l.resetsInMinutes != null ? `${Math.floor(l.resetsInMinutes / 60)}h ${l.resetsInMinutes % 60}m` : 'n/a';
        return `${name}: ${l.percent}% used, resets in ${h}`;
    };
    return [`Claude${u.subscription ? ` (${u.subscription})` : ''} usage:`,
            '• ' + fmt(u.session, 'Session (5h)'),
            '• ' + fmt(u.weekly, 'Weekly')].join('\n');
}

// ---- MCP server ----
const server = new McpServer({name: 'claude-usage', version: '1.0.0'});

server.registerTool('get_claude_usage', {
    title: 'Get Claude usage',
    description: 'Get the current REAL Claude subscription usage — session (5-hour rolling window) and weekly limits, each as a percentage used with time until reset. Source: Anthropic\'s official oauth/usage endpoint (same as Claude Code\'s /usage). Use when the user asks about their Claude usage, limits, quota, or when their session/weekly limit resets.',
    inputSchema: {},
}, async () => {
    const u = await fetchUsage();
    return {content: [{type: 'text', text: humanSummary(u) + '\n\n' + JSON.stringify(u)}]};
});

const transport = new StdioServerTransport();
await server.connect(transport);
