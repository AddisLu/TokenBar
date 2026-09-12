#!/usr/bin/env node
// Fetch REAL Claude usage from Anthropic's official endpoint — the same one
// Claude Code's `/usage` command uses. Read-only: reads the OAuth access token
// from ~/.claude/.credentials.json and never writes it back (so it can't rotate
// the refresh token and log you out). Prints normalized JSON to stdout.
//
// Resilient to the endpoint's tight rate limit: caches the last good result and
// serves it (flagged `stale`) when the API returns 429 / errors, and skips the
// API entirely if the last success was very recent. resetsAt stays absolute so
// the panel recomputes countdowns live even from cache.
//
// The limiter has two tiers: a short burst window (Retry-After a few seconds)
// and an hour-long penalty (Retry-After ~3600). Requests made *during* the
// penalty restart that hour, so a client that keeps polling through a 429 never
// recovers — which is why `Retry-After` is honoured here as a hard cooldown:
// until it expires nothing below touches the network, not even a manual refresh.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.claude', '.credentials.json');
const CACHE = path.join(os.homedir(), '.cache', 'claude-usage-bar.json');
const URL = 'https://api.anthropic.com/api/oauth/usage';
const THROTTLE_MS = 240_000;  // reuse a recent success instead of re-hitting the API
// `--force` (the panel's "Refresh now") skips the freshness guards but never the
// cooldown — a manual retry during the penalty is exactly what extends the ban.
const FORCE = process.argv.includes('--force');

// Retry-After handling. Never wait less than a minute (a burst-window 429 means
// other consumers are already using the budget) and never park for more than an
// hour-and-change, so a bogus header can't disable the panel indefinitely.
const COOLDOWN_MIN_MS = 60_000, COOLDOWN_MAX_MS = 3_900_000, COOLDOWN_DEFAULT_MS = 300_000;
function cooldownUntil(res) {
    const raw = (res.headers.get('retry-after') || '').trim();
    let ms = COOLDOWN_DEFAULT_MS;
    if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n)) ms = n * 1000;                       // delta-seconds form
        else { const d = Date.parse(raw); if (!Number.isNaN(d)) ms = d - Date.now(); }   // HTTP-date form
    }
    return Date.now() + Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
}

function out(o) { process.stdout.write(JSON.stringify(o)); }
const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; } };
const writeCache = (o) => { try { fs.mkdirSync(path.dirname(CACHE), {recursive: true}); fs.writeFileSync(CACHE, JSON.stringify(o)); } catch {} };
const ageSec = (ts) => Math.round(ageOf(ts) / 1000);

// ---- shared cache (optional; for accounts used from several machines) ----
// The rate limit is account-level, so N machines each polling every 180s means N
// times the requests against one budget. Point every machine at the same synced
// file (Syncthing / Dropbox / a shared mount) and whichever polls first pays for
// the fetch; the rest reuse it. Unset → local-only, behaviour unchanged.
//   path from $TOKENBAR_SHARED_CACHE, else ~/.config/claude-usage-bar/shared-cache-path
// Format v1 is platform-neutral: {v,ts,sub,S,W,XL,blockedUntil} — same shape all
// four surfaces use. `blockedUntil` is the cooldown: one machine's 429 parks the
// others too, since the limit they'd hit is the same account's.
const SHARED_TTL = 240_000;   // matches THROTTLE_MS: one fetch per window, account-wide
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
// Remaining cooldown, clamped so a peer's skewed clock can't park us for a week.
const waitFor = (until) => (typeof until === 'number' && until > Date.now())
    ? Math.min(until - Date.now(), COOLDOWN_MAX_MS) : 0;

// Publish the cooldown to both caches. The shared entry is merged, never replaced,
// so peers keep the last good reading to draw from while everyone sits it out.
function recordCooldown(until, cache, sh) {
    writeCache({...(cache || {ts: 0, payload: null}), blockedUntil: until});
    if (sharedPath()) writeShared({...(sh || {v: 1, ts: 0}), v: 1, blockedUntil: until});
}

// Rebuild this extension's payload shape from a shared entry. Countdowns are
// recomputed from the absolute resetsAt by the panel, so age doesn't distort them.
function payloadFromShared(sh) {
    const mk = (x, kind, group) => x && ({
        kind, group,
        label: kind === 'session' ? 'Session (5h)' : kind === 'weekly_all' ? 'Weekly (all)' : `Weekly · ${x.name || 'scoped'}`,
        scopeName: kind === 'weekly_scoped' ? (x.name || 'scoped') : null,
        percent: Math.round(x.percent ?? 0),
        resetsAt: x.resets_at ?? null,
        severity: x.severity ?? 'normal',
        isActive: false,
    });
    const limits = [
        mk(sh.S, 'session', 'session'),
        mk(sh.W, 'weekly_all', 'weekly'),
        ...(sh.XL || []).map(l => mk(l, 'weekly_scoped', 'weekly')),
    ].filter(Boolean);
    return {
        ok: true, fetchedAt: new Date(sh.ts).toISOString(), subscription: sh.sub ?? null,
        session: limits.find(l => l.kind === 'session') || limits[0] || null,
        limits, credits: null, fromSharedCache: true, sharedAgeSec: ageSec(sh.ts),
    };
}

// Token priority:
//  1. long-lived token from `claude setup-token`, saved to ~/.config/claude-usage-bar/token
//     (never expires soon → no 8h refresh dance)
//  2. CLAUDE_CODE_OAUTH_TOKEN env var
//  3. short-lived OAuth accessToken from ~/.claude/.credentials.json (fallback)
const TOKEN_FILE = path.join(os.homedir(), '.config', 'claude-usage-bar', 'token');
let credTok, credExp, sub;
try { const c = JSON.parse(fs.readFileSync(CRED, 'utf8')).claudeAiOauth; credTok = c.accessToken; credExp = c.expiresAt; sub = c.subscriptionType; } catch {}
let longTok;
try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) longTok = t; } catch {}
if (!longTok && process.env.CLAUDE_CODE_OAUTH_TOKEN) longTok = process.env.CLAUDE_CODE_OAUTH_TOKEN.trim();

// Prefer the short-lived session token while it's still fresh (auto-renewed by
// normal Claude Code use); fall back to the long-lived setup-token when it's stale
// (idle machine). Active machines never depend on the long-lived token; idle ones
// stay covered — self-healing with minimal upkeep.
let tok, tokSource;
if (credTok && credExp && Date.now() < credExp - 60000) { tok = credTok; tokSource = 'session'; }
else if (longTok) { tok = longTok; tokSource = 'longlived'; }
else if (credTok) { tok = credTok; tokSource = 'session'; }
// NB: a missing token is not fatal here — the shared cache is consulted first, so a
// machine that never signs in can still display a peer's reading. Checked below.
// self-documenting: tells you exactly what to run if this token has expired
const authHint = tokSource === 'longlived'
    ? 'long-lived token expired → run: claude setup-token'
    : 'run Claude Code once to refresh';

// friendly label + sort rank per limit kind
const scopeName = (l) => l.scope?.model?.display_name || l.scope?.surface || 'scoped';
function label(l) {
    switch (l.kind) {
        case 'session': return 'Session (5h)';
        case 'daily': return 'Daily';
        case 'weekly_all': return 'Weekly (all)';
        case 'weekly_scoped': return `Weekly · ${scopeName(l)}`;
        default: return l.kind;
    }
}
const RANK = {session: 0, daily: 1, weekly_all: 2, weekly_scoped: 3};

const cache = readCache();
const sh = readShared();
// A cache written by an older version (or by a cooldown with nothing cached yet)
// has no payload — usable only as a cooldown record.
const haveCache = !!(cache && cache.payload && cache.ts > 0);
const haveShared = !!(sh && sh.ts > 0 && (sh.S || sh.W));

// Throttle guard: a recent success is reused without touching the API.
if (!FORCE && haveCache && ageOf(cache.ts) < THROTTLE_MS) { out({...cache.payload}); process.exit(0); }

// Another machine may have already paid for this data — reuse it rather than
// spending a second request against the shared account-level limit. Its ts is kept
// verbatim so the next poll re-evaluates freshness correctly.
if (!FORCE && haveShared && ageOf(sh.ts) < SHARED_TTL) {
    const payload = payloadFromShared(sh);
    writeCache({ts: sh.ts, payload, blockedUntil: sh.blockedUntil});
    out(payload); process.exit(0);
}
// When the API is unavailable, draw from whichever copy was fetched most recently —
// ours or a peer's. Preferring our own would show this machine's staler numbers while
// a newer reading sat in the shared file, so the bars would disagree with each other.
const freshest = () => {
    const a = haveCache ? {ts: cache.ts, payload: cache.payload} : null;
    const b = haveShared ? {ts: sh.ts, payload: payloadFromShared(sh)} : null;
    if (a && b) return a.ts >= b.ts ? a : b;
    return a || b || null;
};
const serveFreshest = (note, extra) => {
    const f = freshest(); if (!f) return;
    out({...f.payload, stale: true, note, cacheAgeSec: ageSec(f.ts), ...extra}); process.exit(0);
};

// Cooldown: we (or a peer) were told to back off. Show what we have and, crucially,
// make no request — each one during the penalty pushes the hour out again.
const wait = Math.max(waitFor(cache?.blockedUntil), waitFor(sh?.blockedUntil));
if (wait > 0) {
    const extra = {rateLimited: true, retryInSec: Math.ceil(wait / 1000)};
    serveFreshest('rate-limited', extra);
    out({ok: false, error: 'rate-limited', ...extra}); process.exit(0);
}

// Only now does a missing token matter — nothing above needed one.
if (!tok) {
    serveFreshest('no-credentials');
    out({ok: false, error: 'no-credentials'}); process.exit(0);
}

try {
    const res = await fetch(URL, {
        headers: {
            'Authorization': `Bearer ${tok}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'anthropic-version': '2023-06-01',
            'User-Agent': 'claude-cli/usage-bar',
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
        serveFreshest(authHint);
        out({ok: false, error: 'auth-expired', hint: authHint}); process.exit(0);
    }
    if (res.status === 429) {
        const until = cooldownUntil(res);
        recordCooldown(until, cache, sh);
        const extra = {rateLimited: true, retryInSec: Math.ceil((until - Date.now()) / 1000)};
        serveFreshest('rate-limited', extra);
        out({ok: false, error: 'rate-limited', ...extra}); process.exit(0);
    }
    if (!res.ok) {
        serveFreshest(`http-${res.status}`);
        out({ok: false, error: `http-${res.status}`}); process.exit(0);
    }
    const d = await res.json();

    let lim = Array.isArray(d.limits) ? d.limits.slice() : [];
    // Fallbacks if the limits[] array is ever absent.
    if (!lim.length) {
        if (d.five_hour) lim.push({kind: 'session', group: 'session', percent: d.five_hour.utilization, resets_at: d.five_hour.resets_at, severity: 'normal', is_active: true});
        if (d.seven_day) lim.push({kind: 'weekly_all', group: 'weekly', percent: d.seven_day.utilization, resets_at: d.seven_day.resets_at, severity: 'normal', is_active: false});
    }

    const limits = lim.map(l => ({
        kind: l.kind,
        group: l.group,
        label: label(l),
        // bare model/surface name for scoped caps (Fable today, Opus before it) —
        // the panel needs it without having to parse it back out of `label`
        scopeName: l.kind === 'weekly_scoped' ? scopeName(l) : null,
        percent: Math.round(l.percent ?? 0),
        resetsAt: l.resets_at ?? null,
        severity: l.severity ?? 'normal',
        isActive: !!l.is_active,
    })).sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9));

    // panel bar tracks the session (5h) limit; fall back to the first limit
    const session = limits.find(l => l.kind === 'session') || limits[0] || null;

    // pay-as-you-go extra-usage credits, only if the user enabled them
    let credits = null;
    const eu = d.extra_usage;
    if (eu && eu.is_enabled) {
        credits = {
            percent: Math.round(eu.utilization ?? 0),
            usedCredits: eu.used_credits ?? 0,
            monthlyLimit: eu.monthly_limit ?? null,
            currency: eu.currency ?? 'USD',
        };
    }

    const now = Date.now();
    const payload = {ok: true, fetchedAt: new Date(now).toISOString(), subscription: sub || null, session, limits, credits};
    // a success clears the cooldown on both caches (blockedUntil simply omitted)
    writeCache({ts: now, payload});
    // Publish for the other machines/apps sharing this account's request budget.
    const flat = (l) => l && ({percent: Math.round(l.percent ?? 0), resets_at: l.resetsAt ?? null, severity: l.severity ?? 'normal'});
    writeShared({
        v: 1, ts: now, sub: sub || null,
        S: flat(limits.find(l => l.kind === 'session')),
        W: flat(limits.find(l => l.kind === 'weekly_all')),
        XL: limits.filter(l => l.kind === 'weekly_scoped').map(l => ({...flat(l), name: l.scopeName || 'scoped'})),
    });
    out(payload);
} catch (e) {
    serveFreshest('offline');
    out({ok: false, error: 'network'});
}
