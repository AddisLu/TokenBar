#!/usr/bin/env bash
# One-shot macOS installer for the Claude Usage SwiftBar plugin.
# Run on the Mac:   bash install-claude-usage-mac.sh
# Safe to re-run. Does not hard-fail on missing prerequisites — it tells you.
set -u

echo "=== Claude Usage — macOS installer ==="

# --- 0. paths ---
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Use SwiftBar's configured plugin folder if set, else a sensible default.
PLUGDIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)"
if [ -z "${PLUGDIR:-}" ]; then
    PLUGDIR="$HOME/Library/Application Support/SwiftBar/Plugins"
    mkdir -p "$PLUGDIR"
    defaults write com.ameba.SwiftBar PluginDirectory "$PLUGDIR" 2>/dev/null || true
    echo "• Plugin folder: $PLUGDIR (created + registered)"
else
    mkdir -p "$PLUGDIR"
    echo "• Plugin folder: $PLUGDIR (from SwiftBar prefs)"
fi

PLUGIN="$PLUGDIR/claude-usage.60s.sh"

# --- 1. write the plugin ---
cat > "$PLUGIN" <<'PLUGIN_EOF'
#!/usr/bin/env bash
# SwiftBar plugin — REAL Claude usage from Anthropic's official endpoint.
# Reads the OAuth token from ~/.claude/.credentials.json (Linux) or the macOS
# Keychain (item "Claude Code-credentials"). Read-only; never writes it back.
# Draws a graphical progress bar (PNG) to match the Linux GNOME version.
# <bitbar.title>Claude Usage</bitbar.title>
# <bitbar.desc>Real Claude session + weekly usage and reset (Max/Pro)</bitbar.desc>
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
NODE="$(command -v node)"
[ -x "$NODE" ] || { echo "◉ node?"; echo "---"; echo "node not found"; exit 0; }

CREDS="$(cat "$HOME/.claude/.credentials.json" 2>/dev/null)"
[ -z "$CREDS" ] && CREDS="$(security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null)"

CLAUDE_CREDS="$CREDS" "$NODE" --input-type=module <<'JS'
import zlib from 'node:zlib';
process.stdout.on('error', () => process.exit(0));
const line = (s) => process.stdout.write(s + '\n');
const bad = (m) => { line('○ Claude'); line('---'); line(m); process.exit(0); };

let tok, sub;
try { const c = JSON.parse(process.env.CLAUDE_CREDS || '').claudeAiOauth; tok = c.accessToken; sub = c.subscriptionType; }
catch { bad('Not logged in to Claude Code'); }

// ---- tiny PNG encoder (RGBA) ----
function crc32(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}
function chunk(t,d){const ty=Buffer.from(t,'ascii');const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const cr=Buffer.alloc(4);cr.writeUInt32BE(crc32(Buffer.concat([ty,d])));return Buffer.concat([l,ty,d,cr]);}
function png(W,H,rgba){const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=6;const raw=Buffer.alloc((W*4+1)*H);for(let y=0;y<H;y++){raw[y*(W*4+1)]=0;rgba.copy(raw,y*(W*4+1)+1,y*W*4,(y+1)*W*4);}const idat=zlib.deflateSync(raw,{level:9});return Buffer.concat([sig,chunk('IHDR',ih),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);}
// Final PNG is W0xH0 px; SwiftBar shows it at ~W0/2 x H0/2 pt on Retina (crisp,
// 1:1 device pixels). Drawn supersampled (SS) then box-downscaled for smooth
// anti-aliased edges. Compact + slim bars so it doesn't dominate the menu bar.
function barsPNG(sPct,sCol,wPct,wCol){
  const W0=124,H0=44,SS=4,W=W0*SS,H=H0*SS,img=Buffer.alloc(W*H*4,0);
  const set=(x,y,r,g,b,a)=>{if(x<0||y<0||x>=W||y>=H)return;const i=(y*W+x)*4,A=a/255,iA=1-A,sa=img[i+3]/255;img[i]=Math.round(r*A+img[i]*iA);img[i+1]=Math.round(g*A+img[i+1]*iA);img[i+2]=Math.round(b*A+img[i+2]*iA);img[i+3]=Math.round((A+sa*iA)*255);};
  const rr=(x0,y0,w,h,rad,r,g,b,a)=>{x0*=SS;y0*=SS;w*=SS;h*=SS;rad*=SS;for(let y=0;y<h;y++)for(let x=0;x<w;x++){let ins=true;const cx=Math.min(x,w-1-x),cy=Math.min(y,h-1-y);if(cx<rad&&cy<rad){const dx=rad-cx,dy=rad-cy;if(dx*dx+dy*dy>rad*rad)ins=false;}if(ins)set(x0+x,y0+y,r,g,b,a);}};
  const bh=13,by=(H0-bh)/2,rad=bh/2,m=4,w1=56,gap=8,w2=48,x2=m+w1+gap;
  rr(m,by,w1,bh,rad,255,255,255,46);  rr(m,by,Math.max(bh,Math.round(w1*Math.min(100,sPct)/100)),bh,rad,...sCol,255);
  rr(x2,by,w2,bh,rad,255,255,255,46); rr(x2,by,Math.max(bh,Math.round(w2*Math.min(100,wPct)/100)),bh,rad,...wCol,255);
  // box-average downscale SS→1
  const out=Buffer.alloc(W0*H0*4),n=SS*SS;
  for(let y=0;y<H0;y++)for(let x=0;x<W0;x++){let r=0,g=0,b=0,a=0;for(let dy=0;dy<SS;dy++)for(let dx=0;dx<SS;dx++){const i=((y*SS+dy)*W+(x*SS+dx))*4;r+=img[i];g+=img[i+1];b+=img[i+2];a+=img[i+3];}const o=(y*W0+x)*4;out[o]=Math.round(r/n);out[o+1]=Math.round(g/n);out[o+2]=Math.round(b/n);out[o+3]=Math.round(a/n);}
  return png(W0,H0,out).toString('base64');}
const GREEN=[46,194,126],ORANGE=[255,120,0],RED=[224,27,36];
const rgb=(p,sev)=>(sev==='critical'||p>=90)?RED:(sev==='warning'||p>=70)?ORANGE:GREEN;

try {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {Authorization:`Bearer ${tok}`,'anthropic-beta':'oauth-2025-04-20','anthropic-version':'2023-06-01','Accept':'application/json','User-Agent':'claude-cli/usage-bar'},
    signal: AbortSignal.timeout(15000),
  });
  if (res.status===401||res.status===403) bad('Token expired — run Claude Code once');
  if (!res.ok) bad('HTTP '+res.status);
  const d = await res.json();
  const lim = Array.isArray(d.limits)?d.limits:[];
  const S = lim.find(l=>l.kind==='session') || (d.five_hour&&{percent:d.five_hour.utilization,resets_at:d.five_hour.resets_at,severity:'normal'});
  const W = lim.find(l=>l.kind==='weekly_all') || (d.seven_day&&{percent:d.seven_day.utilization,resets_at:d.seven_day.resets_at,severity:'normal'});
  const cd=(iso)=>{if(!iso)return 'n/a';let ms=new Date(iso)-Date.now();if(ms<=0)return 'now';const m=Math.floor(ms/60000),h=Math.floor(m/60);return h>0?`${h}:${String(m%60).padStart(2,'0')}`:`${m}m`;};
  const clock=(iso)=>iso?new Date(iso).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'}):'n/a';
  const sp=Math.round(S?.percent??0),wp=Math.round(W?.percent??0);
  const b64=barsPNG(sp,rgb(sp,S?.severity),wp,rgb(wp,W?.severity));
  // menu bar: graphical bars (image) + readable numbers (text)
  line(`${sp}% ${cd(S?.resets_at)}  ·  W ${wp}% | image=${b64}`);
  line('---');
  line(`Claude${sub?' — '+sub:''}`);
  line(`Session (5h): ${sp}%   resets ${clock(S?.resets_at)} (in ${cd(S?.resets_at)})`);
  line(`Weekly: ${wp}%   resets ${clock(W?.resets_at)} (in ${cd(W?.resets_at)})`);
  line('---');
  line('Refresh | refresh=true');
} catch(e) { bad('Network error'); }
JS
PLUGIN_EOF
chmod +x "$PLUGIN"
echo "• Plugin installed: $PLUGIN"

# --- 2. prerequisite checks ---
if command -v node >/dev/null 2>&1; then
    echo "• node: $(node -v)"
else
    echo "!! node NOT found — install it:  brew install node"
fi

if [ -f "$HOME/.claude/.credentials.json" ]; then
    echo "• Claude Code login: found"
else
    echo "!! Not logged in to Claude Code on this Mac — run 'claude' once and sign in."
fi

SWIFTBAR="/Applications/SwiftBar.app"
[ -d "$SWIFTBAR" ] || SWIFTBAR="$(mdfind "kMDItemCFBundleIdentifier == 'com.ameba.SwiftBar'" 2>/dev/null | head -1)"
if [ -n "${SWIFTBAR:-}" ] && [ -d "$SWIFTBAR" ]; then
    echo "• SwiftBar: $SWIFTBAR"
else
    echo "!! SwiftBar not installed — install it:  brew install --cask swiftbar"
    echo "   (then re-run this script)"
fi

# --- 3. quick self-test ---
echo "=== plugin test output ==="
bash "$PLUGIN"

# --- 4. launch at login + start now ---
if [ -n "${SWIFTBAR:-}" ] && [ -d "$SWIFTBAR" ]; then
    osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$SWIFTBAR\", hidden:false}" >/dev/null 2>&1 \
        && echo "• Added SwiftBar to Login Items (starts on boot)" \
        || echo "• (Login item may already exist — fine)"
    open -a "$SWIFTBAR" 2>/dev/null
    open "swiftbar://refreshall" 2>/dev/null
    echo "• SwiftBar launched / refreshed"
fi

echo
echo "Done. Look at your menu bar for:  ◉ NN% ████░░ H:MM · W NN%"
echo "If SwiftBar asks for a plugins folder, choose: $PLUGDIR"
