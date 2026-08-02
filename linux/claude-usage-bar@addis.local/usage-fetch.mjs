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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CRED = path.join(os.homedir(), '.claude', '.credentials.json');
const CACHE = path.join(os.homedir(), '.cache', 'claude-usage-bar.json');
const URL = 'https://api.anthropic.com/api/oauth/usage';
const THROTTLE_MS = 45_000;   // reuse a very recent success instead of re-hitting the API

function out(o) { process.stdout.write(JSON.stringify(o)); }
const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; } };
const writeCache = (o) => { try { fs.mkdirSync(path.dirname(CACHE), {recursive: true}); fs.writeFileSync(CACHE, JSON.stringify(o)); } catch {} };
const ageSec = (ts) => Math.round(ageOf(ts) / 1000);
const serveCache = (cache, note) => { out({...cache.payload, stale: true, note, cacheAgeSec: ageSec(cache.ts)}); process.exit(0); };

// ---- shared cache (optional; for accounts used from several machines) ----
// The rate limit is account-level, so N machines each polling every 180s means N
// times the requests against one budget. Point every machine at the same synced
// file (Syncthing / Dropbox / a shared mount) and whichever polls first pays for
// the fetch; the rest reuse it. Unset → local-only, behaviour unchanged.
//   path from $TOKENBAR_SHARED_CACHE, else ~/.config/claude-usage-bar/shared-cache-path
// Format v1 is platform-neutral: {v,ts,sub,S,W,XL} — same shape all four surfaces use.
const SHARED_TTL = 150_000;   // < the 180s poll, so single-machine freshness is unchanged
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
// Throttle guard: a very recent success is reused without touching the API.
if (cache && ageOf(cache.ts) < THROTTLE_MS) { out({...cache.payload}); process.exit(0); }

// Another machine may have already paid for this data — reuse it rather than
// spending a second request against the shared account-level limit. Its ts is kept
// verbatim so the next poll re-evaluates freshness correctly.
const sh = readShared();
if (sh && ageOf(sh.ts) < SHARED_TTL) {
    const payload = payloadFromShared(sh);
    writeCache({ts: sh.ts, payload});
    out(payload); process.exit(0);
}
// stale peer data is still better than a blank panel when the API is unavailable
const serveShared = (note) => { if (!sh) return; out({...payloadFromShared(sh), stale: true, note, cacheAgeSec: ageSec(sh.ts)}); process.exit(0); };

// Only now does a missing token matter — nothing above needed one.
if (!tok) {
    if (cache) serveCache(cache, 'no-credentials');
    serveShared('no-credentials');
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
        if (cache) serveCache(cache, authHint);
        serveShared(authHint);
        out({ok: false, error: 'auth-expired', hint: authHint}); process.exit(0);
    }
    if (!res.ok) {
        if (cache) serveCache(cache, `http-${res.status}`);
        serveShared(`http-${res.status}`);
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
    if (cache) serveCache(cache, 'offline');
    serveShared('offline');
    out({ok: false, error: 'network'});
}
