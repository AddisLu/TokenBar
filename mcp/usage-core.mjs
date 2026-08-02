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

// ---- shared cache (optional; for accounts used from several machines) ----
// The rate limit is account-level, so every extra consumer eats the same budget —
// and this server is the worst offender, since it fetches on every tool call with
// no throttle of its own. Point all machines/apps at one synced file and whoever
// polls first pays for the fetch. Unset → unchanged behaviour.
//   path from $TOKENBAR_SHARED_CACHE, else ~/.config/claude-usage-bar/shared-cache-path
// Format v1 is platform-neutral: {v,ts,sub,S,W,XL} — same shape the status bars use.
const SHARED_TTL = 150_000;
function sharedPath() {
    const e = (process.env.TOKENBAR_SHARED_CACHE || '').trim();
    if (e) return e;
    try { const p = fs.readFileSync(path.join(os.homedir(), '.config', 'claude-usage-bar', 'shared-cache-path'), 'utf8').trim(); if (p) return p; } catch {}
    return null;
}
function readShared() {
    const p = sharedPath(); if (!p) return null;
    try { const o = JSON.parse(fs.readFileSync(p, 'utf8')); if (o && o.v === 1 && typeof o.ts === 'number') return o; } catch {}
    return null;
}
function writeShared(o) {
    const p = sharedPath(); if (!p) return;
    try {
        fs.mkdirSync(path.dirname(p), {recursive: true});
        const t = `${p}.tmp${process.pid}`;
        fs.writeFileSync(t, JSON.stringify(o));
        fs.renameSync(t, p);   // atomic, so a syncing peer never reads a half-written file
    } catch {}
}
// Another machine's clock may run ahead of ours; treat "written in the future" as fresh.
const ageOf = (ts) => Math.max(0, Date.now() - ts);
// flatten an API limit (or a five_hour/seven_day fallback) into the shared format
const toShared = (l, fb) => {
    const x = l || fb; if (!x) return null;
    return {percent: Math.round(x.percent ?? x.utilization ?? 0), resets_at: x.resets_at ?? null, severity: x.severity ?? 'normal'};
};

// Normalize an API limit / five_hour / seven_day / shared-cache entry — all three
// carry `percent`-or-`utilization` plus `resets_at`, so one mapper covers them.
// Module-scoped because the shared-cache path needs it before any fetch happens.
const norm = (l, fb) => {
    const x = l || fb;
    if (!x) return null;
    const resetsAt = x.resets_at ?? null;
    const mins = resetsAt ? Math.max(0, Math.round((new Date(resetsAt) - Date.now()) / 60000)) : null;
    return {percent: Math.round(x.percent ?? x.utilization ?? 0), resetsAt, resetsInMinutes: mins, severity: x.severity ?? 'normal'};
};

// Reconstruct the public shape from a shared-cache entry. resetsInMinutes is
// recomputed against the local clock, so countdowns stay correct however old it is.
const fromShared = (sh) => ({
    ok: true,
    subscription: sh.sub ?? null,
    fetchedAt: new Date(sh.ts).toISOString(),
    fromSharedCache: true,
    cacheAgeSeconds: Math.round(ageOf(sh.ts) / 1000),
    session: norm(sh.S),
    weekly: norm(sh.W),
    scoped: (sh.XL || []).map(l => ({...norm(l), name: l.name})),
});

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
    // Another machine (or the status bar on this one) may have already paid for this
    // data; reuse it rather than spending another request against the shared limit.
    const sh = readShared();
    if (sh && ageOf(sh.ts) < SHARED_TTL) return fromShared(sh);
    // Anything we can still answer from when the API is unavailable, at any age.
    const stale = () => (sh ? fromShared(sh) : null);

    const {tok, sub, source} = pickToken();
    if (!tok) return stale() || {ok: false, error: 'not-logged-in', hint: 'Run `claude` once to sign in on this machine.'};
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
    } catch (e) { return stale() || {ok: false, error: 'network', detail: String(e?.message || e)}; }

    if (res.status === 401 || res.status === 403)
        return stale() || {ok: false, error: 'auth-expired',
            hint: source === 'longlived' ? 'Long-lived token expired — run `claude setup-token`.' : 'Token expired — run `claude` once to refresh.'};
    if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        return stale() || {ok: false, error: 'rate-limited', retryAfterSeconds: ra ? Number(ra) : null,
            hint: 'Account-level rate limit (per token). Wait, or run `claude` on this machine to get a fresh token.'};
    }
    if (!res.ok) return stale() || {ok: false, error: `http-${res.status}`};

    const d = await res.json();
    const lim = Array.isArray(d.limits) ? d.limits : [];
    const session = norm(lim.find(l => l.kind === 'session'), d.five_hour);
    const weekly = norm(lim.find(l => l.kind === 'weekly_all'), d.seven_day);
    // Per-model weekly caps (Fable today, Opus before it). These are frequently the
    // binding constraint — the all-model weekly can sit low while one of these is
    // near 100% — so report them alongside, most-consumed first.
    const scoped = lim.filter(l => l.kind === 'weekly_scoped')
        .map(l => ({...norm(l), name: l.scope?.model?.display_name || l.scope?.surface || 'scoped'}))
        .sort((a, b) => b.percent - a.percent);

    // Publish for the other machines/apps sharing this account's request budget.
    const now = Date.now();
    writeShared({
        v: 1, ts: now, sub: sub || null,
        S: toShared(lim.find(l => l.kind === 'session'), d.five_hour),
        W: toShared(lim.find(l => l.kind === 'weekly_all'), d.seven_day),
        XL: lim.filter(l => l.kind === 'weekly_scoped')
            .map(l => ({...toShared(l), name: l.scope?.model?.display_name || l.scope?.surface || 'scoped'})),
    });

    return {ok: true, subscription: sub || null, fetchedAt: new Date(now).toISOString(), session, weekly, scoped};
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
            '• ' + fmt(u.weekly, 'Weekly'),
            ...(u.scoped || []).map(l => '• ' + fmt(l, `Weekly · ${l.name}`)),
            // say so rather than passing off a peer's reading as a live one
            ...(u.fromSharedCache ? [`(shared cache, ${u.cacheAgeSeconds}s old — reused to spare the account-level rate limit)`] : []),
    ].join('\n');
}

export function appendHistory(u) {
    if (!u.ok) return false;
    const row = {ts: u.fetchedAt, session: u.session?.percent ?? null, sessionResetsAt: u.session?.resetsAt ?? null,
        weekly: u.weekly?.percent ?? null, weeklyResetsAt: u.weekly?.resetsAt ?? null,
        scoped: (u.scoped || []).map(l => ({name: l.name, percent: l.percent, resetsAt: l.resetsAt}))};
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
