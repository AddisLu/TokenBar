#!/usr/bin/env node
// TokenBar usage alert — push a phone notification when a Claude limit crosses a threshold.
//
// Runs on the hub (install-alert.sh starts it every 5 min from a systemd timer) and
// reads the reading the hub already serves, so it never talks to Anthropic itself and
// costs the account nothing. Notifications go through ntfy (https://ntfy.sh): install
// the ntfy app and subscribe to the topic install-alert.sh prints.
//
// Each limit (session, weekly, each per-model weekly cap) alerts at most once per
// threshold per window: 80% → a normal push, 95% → a high-priority one; when the
// window resets, it starts over. It also warns once if the hub's reading goes stale
// (e.g. its Claude Code login lapsed), since the bars would then quietly fall back to
// fetching for themselves.
//
//   node usage-alert.mjs           check once, notify if needed
//   node usage-alert.mjs --test    send a test notification
//
// Config: TOKENBAR_NTFY_URL (or ~/.config/claude-usage-bar/ntfy-url), e.g.
// https://ntfy.sh/tokenbar-3f9c…; TOKENBAR_ALERT_AT, default "80,95".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const SHARED = process.env.TOKENBAR_HUB_FILE
    || path.join(HOME, '.local', 'share', 'claude-usage', 'hub-shared.json');
const STATE = path.join(HOME, '.local', 'share', 'claude-usage', 'alert-state.json');
const URL_FILE = path.join(HOME, '.config', 'claude-usage-bar', 'ntfy-url');
const THRESHOLDS = (process.env.TOKENBAR_ALERT_AT || '80,95')
    .split(',').map(Number).filter(n => n > 0 && n <= 100).sort((a, b) => a - b);
// The hub polls every 5 min; a 429 cooldown can legitimately hold a reading for up to
// ~65 min, so staleness only counts outside a cooldown.
const STALE_MS = 30 * 60_000;
// resets_at carries microseconds that drift between fetches; a real reset moves it by hours.
const NEW_WINDOW_MS = 10 * 60_000;

function log(...a) { console.log(...a); }

function ntfyUrl() {
    if (process.env.TOKENBAR_NTFY_URL?.trim()) return process.env.TOKENBAR_NTFY_URL.trim();
    try { return fs.readFileSync(URL_FILE, 'utf8').trim() || null; } catch { return null; }
}

async function push(url, {title, message, priority = 3, tags = []}) {
    const res = await fetch(url, {
        method: 'POST',
        body: message,
        // Header values must stay ASCII; the body carries anything else.
        headers: {Title: title, Priority: String(priority), Tags: tags.join(',')},
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

function countdown(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return 'now';
    const m = Math.round(ms / 60_000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, o) {
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(o, null, 1));
    fs.renameSync(`${p}.tmp`, p);
}

// Notifications to send for this reading, and the state to keep for the next run.
function evaluate(r, state, now) {
    const out = [];
    const next = {limits: {}, staleSent: false};

    const blocked = Number(r?.blockedUntil) > now;
    if (!r || (!blocked && now - Number(r.ts) > STALE_MS)) {
        next.limits = state.limits || {};
        next.staleSent = true;
        if (!state.staleSent) {
            const age = r ? `${Math.round((now - Number(r.ts)) / 60_000)} min old` : 'missing';
            out.push({title: 'TokenBar hub is stale', priority: 4, tags: ['warning'],
                message: `The hub's usage reading is ${age}. Check its Claude Code login ` +
                    `(journalctl -u claude-token-keepalive) and the tokenbar-hub service.`});
        }
        return {out, next};
    }

    const limits = [
        ['S', 'Session (5h)', r.S],
        ['W', 'Weekly', r.W],
        ...(r.XL || []).map(l => [`XL:${l.name}`, `${l.name} weekly`, l]),
    ];
    for (const [key, label, l] of limits) {
        if (!l || l.percent == null) continue;
        const pct = Math.round(Number(l.percent));
        const prev = state.limits?.[key];
        const sameWindow = prev && Math.abs(Date.parse(l.resets_at) - Date.parse(prev.resets_at)) < NEW_WINDOW_MS;
        const sent = sameWindow ? prev.sent : 0;
        const hit = THRESHOLDS.filter(t => pct >= t).pop() || 0;
        next.limits[key] = {resets_at: l.resets_at, sent: Math.max(sent, hit)};
        if (hit > sent) {
            const top = hit === THRESHOLDS[THRESHOLDS.length - 1];
            out.push({title: `Claude ${label} at ${pct}%`, priority: top ? 4 : 3,
                tags: [top ? 'rotating_light' : 'warning'],
                message: `${label} limit is ${pct}% used. Resets in ${countdown(l.resets_at)}.`});
        }
    }
    return {out, next};
}

async function main() {
    const url = ntfyUrl();
    if (!url) { console.error(`usage-alert: no ntfy URL — set TOKENBAR_NTFY_URL or write it to ${URL_FILE}`); process.exit(1); }

    if (process.argv.includes('--test')) {
        const r = readJson(SHARED);
        const s = r?.S ? `Session ${Math.round(r.S.percent)}%, weekly ${Math.round(r.W?.percent)}%` : 'no hub reading yet';
        await push(url, {title: 'TokenBar alerts are on', tags: ['white_check_mark'],
            message: `You'll be notified at ${THRESHOLDS.join('% and ')}% of each limit. Now: ${s}.`});
        log('test notification sent');
        return;
    }

    const state = readJson(STATE) || {};
    const {out, next} = evaluate(readJson(SHARED), state, Date.now());
    for (const n of out) {
        try { await push(url, n); log('sent:', n.title); }
        catch (e) {
            // Leave the state as it was so the next run retries this alert.
            console.error('usage-alert: push failed:', e.message);
            process.exit(1);
        }
    }
    writeJson(STATE, next);
    if (!out.length) log('no new alerts');
}

main();
