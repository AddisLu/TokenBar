#!/usr/bin/env bash
# Claude Usage — Raspberry Pi OS installer (labwc / wf-panel-pi tray icon)
# Run from the repo's rpi/ folder:   bash install-rpi.sh
# Safe to re-run. Installs the tray app, adds it to autostart, and (re)starts it.
set -u
echo "=== Claude Usage — Raspberry Pi OS installer ==="

HERE="$(cd "$(dirname "$0")" && pwd)"
FETCH_SRC="$HERE/../linux/claude-usage-bar@addis.local/usage-fetch.mjs"
DST="$HOME/.local/share/claude-usage-tray"
AUTOSTART="$HOME/.config/autostart/claude-usage-tray.desktop"

[ -f "$HERE/claude-usage-tray.py" ] || { echo "!! Missing claude-usage-tray.py (run this from the repo's rpi/ folder)"; exit 1; }
[ -f "$FETCH_SRC" ] || { echo "!! Missing $FETCH_SRC (the tray shares the GNOME extension's fetcher)"; exit 1; }

# --- 1. prerequisites ---
missing=()
command -v node >/dev/null 2>&1 || missing+=(nodejs)
python3 -c "from gi.repository import Gio" 2>/dev/null || missing+=(python3-gi)
python3 -c "import cairo" 2>/dev/null || missing+=(python3-cairo)
if [ ${#missing[@]} -gt 0 ]; then
    echo "• Installing: ${missing[*]}"
    sudo apt-get install -y --no-install-recommends "${missing[@]}" || { echo "!! apt-get failed"; exit 1; }
fi
echo "• node: $(node -v)"
[ -f "$HOME/.claude/.credentials.json" ] || [ -f "$HOME/.config/claude-usage-bar/token" ] \
    && echo "• Claude Code login: found" \
    || echo "!! Not logged in to Claude Code — run 'claude' once and sign in (or save a 'claude setup-token' token)."

# --- 2. install files ---
mkdir -p "$DST"
cp "$HERE/claude-usage-tray.py" "$FETCH_SRC" "$DST"/
chmod +x "$DST/claude-usage-tray.py"
echo "• Installed to: $DST"

# --- 3. autostart (labwc runs lxsession-xdg-autostart at login) ---
mkdir -p "$(dirname "$AUTOSTART")"
cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=Claude Usage
Comment=Claude session and weekly usage in the panel tray
Exec=$DST/claude-usage-tray.py
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
echo "• Autostart: $AUTOSTART"

# --- 4. (re)start now so the new version is picked up ---
pkill -f "$DST/claude-usage-tray.py" 2>/dev/null && sleep 1
if [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
    setsid "$DST/claude-usage-tray.py" >/dev/null 2>&1 < /dev/null &
    echo "• Started"
else
    echo "• No graphical session here — it will start at next login"
fi

echo
echo "Done. Look for the badge in the panel tray (top-right):  session % over a session bar and a weekly bar."
echo "Click it for reset times and 'Refresh now'."
