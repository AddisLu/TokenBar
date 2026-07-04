#!/usr/bin/env bash
# Claude Usage — Linux installer (GNOME Shell top-bar extension)
# Run from the repo's linux/ folder:   bash install-linux.sh
# Safe to re-run. Installs the extension, enables it, and checks prerequisites.
set -u
echo "=== Claude Usage — Linux (GNOME) installer ==="

UUID="claude-usage-bar@addis.local"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DST="$HOME/.local/share/gnome-shell/extensions/$UUID"

[ -d "$SRC" ] || { echo "!! Missing $SRC (run this from the repo's linux/ folder)"; exit 1; }

# --- 1. install files ---
mkdir -p "$DST"
cp "$SRC"/extension.js "$SRC"/usage-fetch.mjs "$SRC"/metadata.json "$SRC"/stylesheet.css "$DST"/
echo "• Installed to: $DST"

# --- 2. prerequisites ---
command -v node >/dev/null 2>&1 && echo "• node: $(node -v)" || echo "!! node NOT found — install nodejs (needed for the usage fetch)."
[ -f "$HOME/.claude/.credentials.json" ] && echo "• Claude Code login: found" || echo "!! Not logged in to Claude Code — run 'claude' once and sign in."

# --- 3. enable (GNOME auto-loads enabled extensions at every login) ---
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$UUID" 2>/dev/null && echo "• Enabled via gnome-extensions" || true
fi
# also register in gsettings so it survives a shell restart / re-login
cur="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '@as []')"
if ! printf '%s' "$cur" | grep -q "$UUID"; then
    new="$(python3 - "$cur" "$UUID" <<'PY'
import ast,sys
try: lst=ast.literal_eval(sys.argv[1])
except Exception: lst=[]
if not isinstance(lst,list): lst=[]
if sys.argv[2] not in lst: lst.append(sys.argv[2])
print(repr(lst))
PY
)"
    gsettings set org.gnome.shell enabled-extensions "$new" && echo "• Registered in enabled-extensions"
else
    echo "• Already in enabled-extensions"
fi

echo
echo "Done. Reload GNOME Shell to load it now:"
echo "  • X11:     Alt+F2 → type 'r' → Enter"
echo "  • Wayland: log out and back in"
echo "Then look at the top-right of the panel for:  ◉ [bar] NN% · H:MM  W NN%"
