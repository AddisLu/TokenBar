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
const ageSec = (ts) => Math.round((Date.now() - ts) / 1000);
const serveCache = (cache, note) => { out({...cache.payload, stale: true, note, cacheAgeSec: ageSec(cache.ts)}); process.exit(0); };

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
if (!tok) { out({ok: false, error: 'no-credentials'}); process.exit(0); }
// self-documenting: tells you exactly what to run if this token has expired
const authHint = tokSource === 'longlived'
    ? 'long-lived token expired → run: claude setup-token'
    : 'run Claude Code once to refresh';

// friendly label + sort rank per limit kind
function label(l) {
    switch (l.kind) {
        case 'session': return 'Session (5h)';
        case 'daily': return 'Daily';
        case 'weekly_all': return 'Weekly (all)';
        case 'weekly_scoped': return `Weekly · ${l.scope?.model?.display_name || l.scope?.surface || 'scoped'}`;
        default: return l.kind;
    }
}
const RANK = {session: 0, daily: 1, weekly_all: 2, weekly_scoped: 3};

const cache = readCache();
// Throttle guard: a very recent success is reused without touching the API.
if (cache && Date.now() - cache.ts < THROTTLE_MS) { out({...cache.payload}); process.exit(0); }

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
        out({ok: false, error: 'auth-expired', hint: authHint}); process.exit(0);
    }
    if (!res.ok) {
        if (cache) serveCache(cache, `http-${res.status}`);
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

    const payload = {ok: true, fetchedAt: new Date().toISOString(), subscription: sub || null, session, limits, credits};
    writeCache({ts: Date.now(), payload});
    out(payload);
} catch (e) {
    if (cache) serveCache(cache, 'offline');
    out({ok: false, error: 'network'});
}
