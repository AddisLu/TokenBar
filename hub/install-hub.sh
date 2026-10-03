#!/usr/bin/env bash
# TokenBar hub — installer (Linux with systemd; meant for an always-on box on the tailnet)
# Run from the repo's hub/ folder:   bash install-hub.sh
# Safe to re-run. Installs the hub as a system service that starts at boot (no login
# needed), and points this machine's own bars at it.
set -u
echo "=== TokenBar hub installer ==="

HERE="$(cd "$(dirname "$0")" && pwd)"
FETCH_SRC="$HERE/../linux/claude-usage-bar@addis.local/usage-fetch.mjs"
DST="$HOME/.local/share/tokenbar-hub"
UNIT=/etc/systemd/system/tokenbar-hub.service
PORT="${TOKENBAR_HUB_PORT:-8787}"

[ -f "$FETCH_SRC" ] || { echo "!! Missing $FETCH_SRC"; exit 1; }
NODE="$(command -v node)" || { echo "!! node not found — install nodejs first"; exit 1; }
echo "• node: $($NODE -v)"
[ -f "$HOME/.config/claude-usage-bar/token" ] \
    && echo "• long-lived token: found" \
    || echo "!! No long-lived token. The hub then relies on this machine's Claude Code login, which
   expires ~8 h after Claude Code was last used here. On an always-on hub, run
   'claude setup-token' and save the token to ~/.config/claude-usage-bar/token (chmod 600)."

# --- 1. install files ---
mkdir -p "$DST"
cp "$HERE/usage-hub.mjs" "$FETCH_SRC" "$DST"/
echo "• Installed to: $DST"

# --- 2. system service: starts at boot, restarts on failure ---
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=TokenBar hub — serves Claude usage to the bars on the tailnet
Wants=network-online.target
After=network-online.target tailscaled.service

[Service]
User=$USER
Environment=HOME=$HOME
Environment=TOKENBAR_HUB_PORT=$PORT
ExecStart=$NODE $DST/usage-hub.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable tokenbar-hub.service >/dev/null 2>&1
sudo systemctl restart tokenbar-hub.service
sleep 2
systemctl is-active --quiet tokenbar-hub.service && echo "• Service: running, enabled at boot" \
    || { echo "!! Service failed to start:"; sudo journalctl -u tokenbar-hub -n 20 --no-pager; exit 1; }

# --- 3. this machine's own bars read the hub too (no second fetcher on the hub box) ---
mkdir -p "$HOME/.config/claude-usage-bar"
echo "http://127.0.0.1:$PORT/usage.json" > "$HOME/.config/claude-usage-bar/shared-cache-path"
echo "• Local bars → http://127.0.0.1:$PORT/usage.json"

NAME="$(tailscale status --self --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).Self.DNSName.split(".")[0])}catch{}})')"
IP="$(tailscale ip -4 2>/dev/null | head -1)"
echo
echo "Done. On every other machine, point its bar at the hub:"
echo "  macOS / Linux:  mkdir -p ~/.config/claude-usage-bar && echo 'http://${NAME:-<hub>}:$PORT/usage.json' > ~/.config/claude-usage-bar/shared-cache-path"
echo "  Windows:        mkdir -Force \"\$env:USERPROFILE\\.config\\claude-usage-bar\" >\$null; Set-Content \"\$env:USERPROFILE\\.config\\claude-usage-bar\\shared-cache-path\" 'http://${NAME:-<hub>}:$PORT/usage.json'"
[ -n "$IP" ] && echo "  (or by IP: http://$IP:$PORT/usage.json)"
