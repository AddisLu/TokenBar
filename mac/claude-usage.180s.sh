#!/usr/bin/env bash
# SwiftBar plugin — REAL Claude usage from Anthropic's official endpoint.
# Reads the OAuth token from ~/.claude/.credentials.json (Linux) or the macOS
# Keychain (item "Claude Code-credentials"). Read-only; never writes it back.
# Draws a graphical progress bar (PNG) to match the Linux GNOME version.
# Resilient to the endpoint's tight rate limit: caches the last good result and
# keeps drawing the bar (countdowns recomputed live) when the API returns 429 /
# errors, and skips the API entirely if the last success was recent. A 429's
# Retry-After is honoured as a hard cooldown — the limiter's hour-long penalty
# restarts on every request made during it, so polling through one never recovers.
# <bitbar.title>Claude Usage</bitbar.title>
# <bitbar.desc>Real Claude session + weekly usage and reset (Max/Pro)</bitbar.desc>
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
NODE="$(command -v node)"
[ -x "$NODE" ] || { echo "◉ node?"; echo "---"; echo "node not found"; exit 0; }

CREDS="$(cat "$HOME/.claude/.credentials.json" 2>/dev/null)"
[ -z "$CREDS" ] && CREDS="$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null)"

CLAUDE_CREDS="$CREDS" "$NODE" --input-type=module <<'JS'
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.stdout.on('error', () => process.exit(0));
const line = (s) => process.stdout.write(s + '\n');
const bad = (m) => { line('○ Claude'); line('---'); line(m); process.exit(0); };

const CACHE = path.join(os.homedir(), '.cache', 'claude-usage-bar.json');
const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; } };
const writeCache = (o) => { try { fs.mkdirSync(path.dirname(CACHE), {recursive:true}); fs.writeFileSync(CACHE, JSON.stringify(o)); } catch {} };

// ---- shared cache (optional; for accounts used from several machines) ----
// The rate limit is account-level, so N machines each polling every 180s means N
// times the requests against one budget. Point every machine at the same synced
// file (iCloud Drive / Dropbox / Syncthing) and whichever polls first pays for the
// fetch; the rest reuse it. Total settles at roughly one request per SHARED_TTL
// regardless of machine count. Unset → local-only, behaviour unchanged.
//   path from $TOKENBAR_SHARED_CACHE, else ~/.config/claude-usage-bar/shared-cache-path
// Format v1 is platform-neutral: {v,ts,sub,S,W,XL,blockedUntil} — same shape all four
// surfaces use. blockedUntil is a 429 cooldown: the limit is per-account, so one
// machine's penalty has to park the others too.
const SHARED_TTL = 240_000;   // matches THROTTLE_MS: one fetch per window, account-wide
const THROTTLE_MS = 240_000;  // reuse a recent success instead of re-hitting the API
function sharedPath(){
  const e = (process.env.TOKENBAR_SHARED_CACHE || '').trim();
  if (e) return e;
  try { const p = fs.readFileSync(path.join(os.homedir(),'.config','claude-usage-bar','shared-cache-path'),'utf8').trim(); if (p) return p; } catch {}
  return null;
}
function readShared(){
  const p = sharedPath(); if (!p) return null;
  try { const o = JSON.parse(fs.readFileSync(p,'utf8')); if (o && o.v === 1 && typeof o.ts === 'number') return o; } catch {}
  return null;
}
function writeShared(o){
  const p = sharedPath(); if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), {recursive:true});
    const t = `${p}.tmp${process.pid}`;
    fs.writeFileSync(t, JSON.stringify(o));
    fs.renameSync(t, p);   // atomic, so a syncing peer never reads a half-written file
  } catch {}
}
// Another machine's clock may run ahead of ours; treat "written in the future" as fresh
// rather than as a wildly stale entry.
const ageOf = (ts) => Math.max(0, Date.now() - ts);

// ---- 429 cooldown ----
// Two tiers: a short burst window (Retry-After a few seconds) and an hour-long
// penalty (Retry-After ~3600) that restarts on every request made while it holds.
// So we stop completely until it expires — SwiftBar's Refresh included. Bounds keep
// a bogus header from parking the plugin indefinitely.
const COOLDOWN_MIN_MS = 60_000, COOLDOWN_MAX_MS = 3_900_000, COOLDOWN_DEFAULT_MS = 300_000;
function cooldownFrom(res){
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

// A missing token is not fatal here — the shared cache is consulted first (below), so
// a Mac that never signs in can still display a peer's reading. Checked before fetching.
let tok, sub;
try { const c = JSON.parse(process.env.CLAUDE_CREDS || '').claudeAiOauth; tok = c.accessToken; sub = c.subscriptionType; } catch {}

// ---- tiny PNG encoder (RGBA) ----
function crc32(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}
function chunk(t,d){const ty=Buffer.from(t,'ascii');const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const cr=Buffer.alloc(4);cr.writeUInt32BE(crc32(Buffer.concat([ty,d])));return Buffer.concat([l,ty,d,cr]);}
function png(W,H,rgba){const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=6;const raw=Buffer.alloc((W*4+1)*H);for(let y=0;y<H;y++){raw[y*(W*4+1)]=0;rgba.copy(raw,y*(W*4+1)+1,y*W*4,(y+1)*W*4);}const idat=zlib.deflateSync(raw,{level:9});return Buffer.concat([sig,chunk('IHDR',ih),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);}
// Final PNG is W0xH0 px; SwiftBar shows it at ~W0/2 x H0/2 pt on Retina (crisp,
// 1:1 device pixels). Drawn supersampled (SS) then box-downscaled for smooth
// anti-aliased edges. Compact + slim bars so it doesn't dominate the menu bar.
// `segs` is [{pct,col,w}] — two bars normally, three when the account also has a
// scoped weekly cap (a per-model limit such as Fable). W0 follows the segments so
// the bar only grows on accounts that actually have one.
function barsPNG(segs){
  const H0=44,SS=4,m=4,gap=8;
  const W0=m*2+segs.reduce((a,s)=>a+s.w,0)+gap*(segs.length-1);
  const W=W0*SS,H=H0*SS,img=Buffer.alloc(W*H*4,0);
  const set=(x,y,r,g,b,a)=>{if(x<0||y<0||x>=W||y>=H)return;const i=(y*W+x)*4,A=a/255,iA=1-A,sa=img[i+3]/255;img[i]=Math.round(r*A+img[i]*iA);img[i+1]=Math.round(g*A+img[i+1]*iA);img[i+2]=Math.round(b*A+img[i+2]*iA);img[i+3]=Math.round((A+sa*iA)*255);};
  const rr=(x0,y0,w,h,rad,r,g,b,a)=>{x0*=SS;y0*=SS;w*=SS;h*=SS;rad*=SS;for(let y=0;y<h;y++)for(let x=0;x<w;x++){let ins=true;const cx=Math.min(x,w-1-x),cy=Math.min(y,h-1-y);if(cx<rad&&cy<rad){const dx=rad-cx,dy=rad-cy;if(dx*dx+dy*dy>rad*rad)ins=false;}if(ins)set(x0+x,y0+y,r,g,b,a);}};
  const bh=13,by=(H0-bh)/2,rad=bh/2;
  let x=m;
  for(const s of segs){
    rr(x,by,s.w,bh,rad,255,255,255,46);
    rr(x,by,Math.max(bh,Math.round(s.w*Math.min(100,s.pct)/100)),bh,rad,...s.col,255);
    x+=s.w+gap;
  }
  // box-average downscale SS→1
  const out=Buffer.alloc(W0*H0*4),n=SS*SS;
  for(let y=0;y<H0;y++)for(let x=0;x<W0;x++){let r=0,g=0,b=0,a=0;for(let dy=0;dy<SS;dy++)for(let dx=0;dx<SS;dx++){const i=((y*SS+dy)*W+(x*SS+dx))*4;r+=img[i];g+=img[i+1];b+=img[i+2];a+=img[i+3];}const o=(y*W0+x)*4;out[o]=Math.round(r/n);out[o+1]=Math.round(g/n);out[o+2]=Math.round(b/n);out[o+3]=Math.round(a/n);}
  return png(W0,H0,out).toString('base64');}
const GREEN=[46,194,126],ORANGE=[255,120,0],RED=[224,27,36];
const rgb=(p,sev)=>(sev==='critical'||p>=90)?RED:(sev==='warning'||p>=70)?ORANGE:GREEN;
const cd=(iso)=>{if(!iso)return 'n/a';let ms=new Date(iso)-Date.now();if(ms<=0)return 'now';const m=Math.floor(ms/60000),h=Math.floor(m/60);return h>0?`${h}:${String(m%60).padStart(2,'0')}`:`${m}m`;};
const clock=(iso)=>iso?new Date(iso).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'}):'n/a';

// Draw the menu bar + dropdown from S/W/XL. Countdowns are recomputed live, so even
// a cached S/W shows an accurate reset timer. `note` (optional) is shown dimmed
// in the dropdown to explain a stale/fallback state.
// XL holds the scoped weekly limits (per-model caps such as Fable). The menu bar
// has room for one, so it shows the most-consumed — that's the one that will cut
// you off first — tagged with the model's initial; the dropdown lists them all.
function render(S, W, XL, note){
  const scoped=(XL||[]).slice().sort((a,b)=>(b.percent??0)-(a.percent??0));
  const X=scoped[0]||null, xp=Math.round(X?.percent??0);
  const sp=Math.round(S?.percent??0), wp=Math.round(W?.percent??0);
  const segs=X
    ? [{pct:sp,col:rgb(sp,S?.severity),w:50},{pct:wp,col:rgb(wp,W?.severity),w:40},{pct:xp,col:rgb(xp,X.severity),w:40}]
    : [{pct:sp,col:rgb(sp,S?.severity),w:56},{pct:wp,col:rgb(wp,W?.severity),w:48}];
  const tag=X?((X.name||'S')[0]||'S').toUpperCase():'';
  line(`${sp}% ${cd(S?.resets_at)}  ·  W ${wp}%${X?`  ·  ${tag} ${xp}%`:''} | image=${barsPNG(segs)}`);
  line('---');
  line(`Claude${sub?' — '+sub:''}`);
  if (note) line(`${note} | color=orange`);
  line(`Session (5h): ${sp}%   resets ${clock(S?.resets_at)} (in ${cd(S?.resets_at)})`);
  line(`Weekly: ${wp}%   resets ${clock(W?.resets_at)} (in ${cd(W?.resets_at)})`);
  for (const l of scoped)
    line(`Weekly · ${l.name}: ${Math.round(l.percent??0)}%   resets ${clock(l.resets_at)} (in ${cd(l.resets_at)})`);
  line('---');
  line('Refresh | refresh=true');
  process.exit(0);
}
const staleNote = (ts) => `⚠ API throttled — cached ${Math.round(ageOf(ts)/1000)}s ago`;
// A cooldown is not a dead end: say when we'll try again, so the frozen numbers
// and a Refresh that deliberately does nothing both make sense.
const coolNote = (ts, wait) => `⚠ rate-limited — retrying in ${cd(new Date(Date.now()+wait).toISOString())}, cached ${Math.round(ageOf(ts)/1000)}s ago`;

const cache = readCache();
// Throttle guard: reuse a recent success and don't hit the API.
if (cache && cache.ts > 0 && ageOf(cache.ts) < THROTTLE_MS) render(cache.S, cache.W, cache.XL);

// Another machine may have already paid for this data — reuse it rather than
// spending a second request against the shared account-level limit. Its ts is kept
// verbatim so "cached Ns ago" stays honest and the next poll re-evaluates correctly.
const sh = readShared();
if (!sub && sh?.sub) sub = sh.sub;   // peer knows the plan even if we have no creds
const shHasData = !!(sh && sh.ts > 0 && (sh.S || sh.W));
if (shHasData && ageOf(sh.ts) < SHARED_TTL) {
  writeCache({sub: sh.sub ?? sub, S: sh.S, W: sh.W, XL: sh.XL, ts: sh.ts, blockedUntil: sh.blockedUntil});
  render(sh.S, sh.W, sh.XL);
}

// newest of whatever we can still draw from when the API is unavailable
const fallback = () => {
  const a = (cache && cache.ts > 0 && (cache.S || cache.W)) ? {S:cache.S, W:cache.W, XL:cache.XL, ts:cache.ts} : null;
  const b = shHasData ? {S:sh.S, W:sh.W, XL:sh.XL, ts:sh.ts} : null;
  if (a && b) return a.ts >= b.ts ? a : b;
  return a || b || null;
};
// Publish a cooldown to both caches. The shared entry is merged, never replaced, so
// peers keep the last good reading to draw from while everyone sits it out.
function recordCooldown(until){
  writeCache({...(cache || {ts:0}), sub: cache?.sub ?? sub, blockedUntil: until});
  if (sharedPath()) writeShared({...(sh || {v:1, ts:0}), v:1, blockedUntil: until});
}

// Cooldown in force (ours or a peer's): draw what we have and make no request —
// each one during the penalty pushes the hour out again.
const wait = Math.max(waitFor(cache?.blockedUntil), waitFor(sh?.blockedUntil));
if (wait > 0) {
  const f = fallback();
  if (f) render(f.S, f.W, f.XL, coolNote(f.ts, wait));
  bad(`Rate-limited — retrying in ${cd(new Date(Date.now()+wait).toISOString())}`);
}

// Only now does a missing token matter — nothing above needed one.
if (!tok) {
  const f = fallback();
  if (f) render(f.S, f.W, f.XL, '⚠ Not signed in on this Mac — showing shared data');
  bad('Not logged in to Claude Code');
}

try {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {Authorization:`Bearer ${tok}`,'anthropic-beta':'oauth-2025-04-20','anthropic-version':'2023-06-01','Accept':'application/json','User-Agent':'claude-cli/usage-bar'},
    signal: AbortSignal.timeout(15000),
  });
  if (res.status===401||res.status===403) {
    const f = fallback();
    if (f) render(f.S, f.W, f.XL, '⚠ Token expired — run Claude Code once');
    bad('Token expired — run Claude Code once');
  }
  if (res.status === 429) {
    const until = cooldownFrom(res);
    recordCooldown(until);
    const f = fallback();
    if (f) render(f.S, f.W, f.XL, coolNote(f.ts, until - Date.now()));
    bad(`Rate-limited — retrying in ${cd(new Date(until).toISOString())}`);
  }
  if (!res.ok) {
    const f = fallback();
    if (f) render(f.S, f.W, f.XL, staleNote(f.ts));
    bad('HTTP '+res.status);
  }
  const d = await res.json();
  const lim = Array.isArray(d.limits)?d.limits:[];
  const S = lim.find(l=>l.kind==='session') || (d.five_hour&&{percent:d.five_hour.utilization,resets_at:d.five_hour.resets_at,severity:'normal'});
  const W = lim.find(l=>l.kind==='weekly_all') || (d.seven_day&&{percent:d.seven_day.utilization,resets_at:d.seven_day.resets_at,severity:'normal'});
  // Per-model weekly caps (Fable today, Opus before it). Flattened to a plain name
  // here so a cached copy stays renderable without re-reading the scope object.
  const XL = lim.filter(l=>l.kind==='weekly_scoped').map(l=>({
    percent:l.percent, resets_at:l.resets_at, severity:l.severity??'normal',
    name:l.scope?.model?.display_name||l.scope?.surface||'scoped',
  }));
  const now = Date.now();
  // omitting blockedUntil clears any cooldown: the budget is evidently back
  writeCache({sub, S, W, XL, ts: now});
  writeShared({v:1, ts: now, sub, S, W, XL});
  render(S, W, XL);
} catch(e) {
  const f = fallback();
  if (f) render(f.S, f.W, f.XL, staleNote(f.ts));
  bad('Network error');
}
JS
