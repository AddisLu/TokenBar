#!/usr/bin/env bash
# TokenBar usage alert — installer (run on the hub, after install-hub.sh)
# Run from the repo's hub/ folder:   bash install-alert.sh
# Safe to re-run. Every 5 min, checks the hub's reading and pushes a phone notification
# through ntfy when a limit crosses 80% / 95% (override: TOKENBAR_ALERT_AT=70,90).
set -u
echo "=== TokenBar usage alert installer ==="

HERE="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/.local/share/tokenbar-hub"
URL_FILE="$HOME/.config/claude-usage-bar/ntfy-url"
AT="${TOKENBAR_ALERT_AT:-80,95}"

NODE="$(command -v node)" || { echo "!! node not found — install nodejs first"; exit 1; }
systemctl is-active --quiet tokenbar-hub.service \
    || { echo "!! tokenbar-hub isn't running here — run install-hub.sh first"; exit 1; }

# --- 1. install file ---
mkdir -p "$DST"
cp "$HERE/usage-alert.mjs" "$DST"/
echo "• Installed to: $DST/usage-alert.mjs"

# --- 2. ntfy topic ---
# ntfy.sh topics are public to anyone who knows the name, so the name is the secret:
# a random one, kept across re-runs. Point the file at a self-hosted ntfy to use that.
mkdir -p "$(dirname "$URL_FILE")"
if [ ! -s "$URL_FILE" ]; then
    echo "https://ntfy.sh/tokenbar-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$URL_FILE"
    chmod 600 "$URL_FILE"
fi
NTFY_URL="$(cat "$URL_FILE")"
echo "• ntfy topic: $NTFY_URL"

# --- 3. timer: every 5 min, the hub's own poll interval ---
sudo tee /etc/systemd/system/tokenbar-alert.service >/dev/null <<UNIT
[Unit]
Description=TokenBar usage alert — notify when a Claude limit crosses a threshold
Wants=network-online.target
After=network-online.target tokenbar-hub.service

[Service]
Type=oneshot
User=$USER
Environment=HOME=$HOME
Environment=TOKENBAR_ALERT_AT=$AT
ExecStart=$NODE $DST/usage-alert.mjs
UNIT
sudo tee /etc/systemd/system/tokenbar-alert.timer >/dev/null <<'UNIT'
[Unit]
Description=TokenBar usage alert, every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now tokenbar-alert.timer >/dev/null 2>&1
systemctl is-active --quiet tokenbar-alert.timer && echo "• Timer: every 5 min, alerts at ${AT//,/% and }%" \
    || { echo "!! Timer failed to start"; exit 1; }

# --- 4. test push ---
TOKENBAR_ALERT_AT="$AT" "$NODE" "$DST/usage-alert.mjs" --test >/dev/null \
    && echo "• Test notification sent" || echo "!! Test notification failed — check the network / ntfy URL"

echo
echo "Done. On your phone: install the ntfy app, tap +, and subscribe to"
echo "  ${NTFY_URL#https://ntfy.sh/}   (server: ntfy.sh)"
echo "Then send another test:  node $DST/usage-alert.mjs --test"
echo "Logs: journalctl -u tokenbar-alert -n 20 · remove: sudo systemctl disable --now tokenbar-alert.timer"
