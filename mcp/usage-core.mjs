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
// Format v1 is platform-neutral: {v,ts,sub,S,W,XL,blockedUntil} — same shape the
// status bars use. `blockedUntil` is a 429 cooldown published account-wide: the
// limit is per-account, so one consumer's penalty has to park all of them.
const SHARED_TTL = 240_000;
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

// ---- 429 cooldown ----
// The limiter has two tiers: a short burst window (Retry-After a few seconds) and
// an hour-long penalty (Retry-After ~3600) that *restarts* on every request made
// while it is in force. So a 429 has to be an actual stop, not a hint: until it
// expires, no fetch happens — not from this process, not from a peer reading the
// shared file. Bounds keep a bogus header from parking the tool indefinitely.
const COOLDOWN_MIN_MS = 60_000, COOLDOWN_MAX_MS = 3_900_000, COOLDOWN_DEFAULT_MS = 300_000;
let cooldownUntil = 0;   // in-process; the MCP server is long-lived, so this alone
                         // already stops a busy session from re-hitting the API
function cooldownFrom(res) {
    const raw = (res.headers.get('retry-after') || '').trim();
    let ms = COOLDOWN_DEFAULT_MS;
    if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n)) ms = n * 1000;                       // delta-seconds form
        else { const d = Date.parse(raw); if (!Number.isNaN(d)) ms = d - Date.now(); }   // HTTP-date form
    }
    return Date.now() + Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
}
// Remaining cooldown, clamped so a peer's skewed clock can't park us for a week.
const waitFor = (until) => (typeof until === 'number' && until > Date.now())
    ? Math.min(until - Date.now(), COOLDOWN_MAX_MS) : 0;
// ---- cross-tool cache (shared with loop-engineering's readUsage) ----
// Same file and {reading, ts} envelope that tool uses, so whichever of us fetched
// last serves the other and the two MCP servers don't each pay for a request.
// `blockedUntil` rides alongside as a sibling key; a reader that only knows
// {reading, ts} simply ignores it.
const XTOOL_FILE = process.env.CLAUDE_USAGE_CACHE
    ?? path.join(os.homedir(), '.local', 'share', 'claude-usage', 'usage-cache.json');
function readXTool() { try { return JSON.parse(fs.readFileSync(XTOOL_FILE, 'utf8')); } catch { return null; } }
function writeXTool(o) {
    try { fs.mkdirSync(path.dirname(XTOOL_FILE), {recursive: true}); fs.writeFileSync(XTOOL_FILE, JSON.stringify(o)); } catch {}
}

// Publish the cooldown to both caches, without disturbing the last good reading
// either one's readers draw from.
function publishCooldown(until, sh, xt) {
    if (sharedPath()) writeShared({...(sh || {v: 1, ts: 0}), v: 1, blockedUntil: until});
    writeXTool({...(xt || {ts: 0}), blockedUntil: until});
}
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
    const xt = readXTool();
    const shHasData = !!(sh && sh.ts > 0 && (sh.S || sh.W));
    const xtHasData = !!(xt && xt.reading?.ok && typeof xt.ts === 'number');
    // Newest reading either cache can offer, whoever paid for it.
    const best = (() => {
        const a = shHasData ? {ts: sh.ts, get: () => fromShared(sh)} : null;
        const b = xtHasData ? {ts: xt.ts, get: () => ({...xt.reading, source: 'cache', fromSharedCache: true,
            cacheAgeSeconds: Math.round(ageOf(xt.ts) / 1000)})} : null;
        if (a && b) return a.ts >= b.ts ? a : b;
        return a || b || null;
    })();
    if (best && ageOf(best.ts) < SHARED_TTL) return best.get();
    // Anything we can still answer from when the API is unavailable, at any age.
    const stale = () => (best ? best.get() : null);

    // Cooldown in force (ours or a peer's): answer from cache and make no request.
    const wait = waitFor(Math.max(cooldownUntil, sh?.blockedUntil ?? 0, xt?.blockedUntil ?? 0));
    if (wait > 0) {
        const retryAfterSeconds = Math.ceil(wait / 1000);
        const s = stale();
        return s ? {...s, rateLimited: true, retryAfterSeconds}
                 : {ok: false, error: 'rate-limited', retryAfterSeconds,
                    hint: 'Account-level rate limit. Backing off — no request will be made until it expires.'};
    }

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
        // Park every consumer of this account, here and on the other machines.
        cooldownUntil = cooldownFrom(res);
        publishCooldown(cooldownUntil, sh, xt);
        const retryAfterSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
        const s = stale();
        return s ? {...s, rateLimited: true, retryAfterSeconds}
                 : {ok: false, error: 'rate-limited', retryAfterSeconds,
                    hint: 'Account-level rate limit. Backing off — no request will be made until it expires.'};
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
    // Omitting blockedUntil clears any cooldown: the budget is evidently back.
    const now = Date.now();
    cooldownUntil = 0;
    writeShared({
        v: 1, ts: now, sub: sub || null,
        S: toShared(lim.find(l => l.kind === 'session'), d.five_hour),
        W: toShared(lim.find(l => l.kind === 'weekly_all'), d.seven_day),
        XL: lim.filter(l => l.kind === 'weekly_scoped')
            .map(l => ({...toShared(l), name: l.scope?.model?.display_name || l.scope?.surface || 'scoped'})),
    });

    const reading = {ok: true, subscription: sub || null, fetchedAt: new Date(now).toISOString(), session, weekly, scoped};
    writeXTool({reading, ts: now});   // blockedUntil dropped: the budget is evidently back
    return reading;
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
            // say plainly that the numbers are frozen, and for how long
            ...(u.rateLimited ? [`(rate-limited by the usage endpoint — not retrying for ${Math.ceil((u.retryAfterSeconds || 0) / 60)}m)`] : []),
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
