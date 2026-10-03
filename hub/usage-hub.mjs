#!/usr/bin/env node
// TokenBar hub — one machine polls Anthropic, every other bar reads from it.
//
// The usage limit is account-level, so each bar polling on its own spends the same
// budget N times over, and a 429 on one machine parks them all. With a hub, only this
// machine talks to Anthropic: it runs the GNOME extension's usage-fetch.mjs on a timer
// (so the throttle, the 429 cooldown and the token handling are the same code) and
// serves the resulting shared-cache entry over HTTP. The bars, the MCP server and Loop
// point $TOKENBAR_SHARED_CACHE / shared-cache-path at http://<hub>:8787/usage.json and
// fall back to fetching for themselves only when the hub is unreachable or quiet.
//
// Listens on all interfaces but only answers Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48)
// and loopback peers, so the reading never leaves the tailnet even on a shared LAN.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TOKENBAR_HUB_PORT || 8787);
// Fetcher: next to this file once installed, else the repo's copy.
const FETCH = [path.join(HERE, 'usage-fetch.mjs'),
    path.join(HERE, '..', 'linux', 'claude-usage-bar@addis.local', 'usage-fetch.mjs')].find(f => fs.existsSync(f));
const SHARED = process.env.TOKENBAR_HUB_FILE
    || path.join(os.homedir(), '.local', 'share', 'claude-usage', 'hub-shared.json');
// 5 min: ~12 requests/hour, well inside the budget, and the bars trust a hub reading
// for 10 min — one missed poll still doesn't send them to the API themselves.
const POLL_MS = 300_000;

function log(...a) { console.log(new Date().toISOString(), ...a); }

let busy = false;
function poll() {
    if (busy) return;
    busy = true;
    // No --force: the fetcher's own guards stay in charge, above all the 429 cooldown.
    // The hub's file is the fetcher's shared cache, so a success and a cooldown both land
    // there in the v1 shape every bar already reads.
    execFile(process.execPath, [FETCH], {
        env: {...process.env, TOKENBAR_SHARED_CACHE: SHARED},
        timeout: 30_000,
    }, (err, stdout) => {
        busy = false;
        if (err) return log('fetch failed:', err.message);
        try {
            const r = JSON.parse(stdout);
            if (!r.ok) log('fetch:', r.error, r.retryInSec ? `retry in ${r.retryInSec}s` : '');
            else if (r.stale) log('serving cache:', r.note, r.retryInSec ? `retry in ${r.retryInSec}s` : '');
        } catch { log('fetch: unparsable output'); }
    });
}

function isTailnetOrLocal(addr) {
    const a = (addr || '').replace(/^::ffff:/, '');
    if (a === '127.0.0.1' || a === '::1') return true;
    const m = a.match(/^100\.(\d+)\./);
    if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;   // 100.64.0.0/10
    return a.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

const server = http.createServer((req, res) => {
    if (!isTailnetOrLocal(req.socket.remoteAddress)) { res.writeHead(403).end(); return; }
    const url = (req.url || '').split('?')[0];
    if (req.method !== 'GET' || (url !== '/usage.json' && url !== '/')) { res.writeHead(404).end(); return; }
    let body;
    try { body = fs.readFileSync(SHARED, 'utf8'); JSON.parse(body); }
    catch { res.writeHead(503, {'Content-Type': 'application/json'}).end('{"error":"no reading yet"}'); return; }
    res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(body);
});

if (!FETCH) { console.error('usage-hub: usage-fetch.mjs not found'); process.exit(1); }
server.listen(PORT, () => log(`TokenBar hub on :${PORT}, serving ${SHARED}, fetching with ${FETCH}`));
poll();
setInterval(poll, POLL_MS);
