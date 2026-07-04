// Shared core for the Claude usage MCP server + the daily logger.
// Read-only token handling + the oauth/usage fetch + a tiny JSONL history store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CRED = path.join(os.homedir(), '.claude', '.credentials.json');
const TOKEN_FILE = path.join(os.homedir(), '.config', 'claude-usage-bar', 'token');
const URL = 'https://api.anthropic.com/api/oauth/usage';

export const HISTORY = path.join(os.homedir(), '.local', 'share', 'claude-usage-mcp', 'history.jsonl');

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

export async function fetchUsage() {
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

export function humanSummary(u) {
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

export function appendHistory(u) {
    if (!u.ok) return false;
    const row = {ts: u.fetchedAt, session: u.session?.percent ?? null, sessionResetsAt: u.session?.resetsAt ?? null,
        weekly: u.weekly?.percent ?? null, weeklyResetsAt: u.weekly?.resetsAt ?? null};
    try {
        fs.mkdirSync(path.dirname(HISTORY), {recursive: true});
        fs.appendFileSync(HISTORY, JSON.stringify(row) + '\n');
        return true;
    } catch { return false; }
}

export function readHistory(limit = 200) {
    try {
        const lines = fs.readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean);
        return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}
