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

PLUGIN="$PLUGDIR/claude-usage.180s.sh"
rm -f "$PLUGDIR/claude-usage.60s.sh" "$PLUGDIR/claude-usage.120s.sh"  # drop older-interval copies so we don't run two

# --- 1. install the plugin ---
# Copied from the sibling file rather than embedded here, so there is exactly one
# copy of the plugin source in the repo (same as the Linux/Windows installers).
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-usage.180s.sh"
if [ ! -f "$SRC" ]; then
    echo "!! Cannot find $SRC"
    echo "   Run this script from a checkout of the repo:  cd mac && bash install-claude-usage-mac.sh"
    exit 1
fi
cp "$SRC" "$PLUGIN"
chmod +x "$PLUGIN"
echo "• Plugin installed: $PLUGIN"

# --- 2. prerequisite checks ---
if command -v node >/dev/null 2>&1; then
    echo "• node: $(node -v)"
else
    echo "!! node NOT found — install it:  brew install node"
fi

# On macOS the token lives in the Keychain, not the file — check both.
if [ -f "$HOME/.claude/.credentials.json" ] || security find-generic-password -s 'Claude Code-credentials' -w >/dev/null 2>&1; then
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
    # `make login item` appends unconditionally, so a re-run would add a duplicate —
    # check first to keep this script genuinely safe to re-run.
    if osascript -e 'tell application "System Events" to get name of every login item' 2>/dev/null | tr ',' '\n' | grep -qx ' *SwiftBar *'; then
        echo "• SwiftBar already in Login Items (left as-is)"
    else
        osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$SWIFTBAR\", hidden:false}" >/dev/null 2>&1 \
            && echo "• Added SwiftBar to Login Items (starts on boot)" \
            || echo "• Could not add SwiftBar to Login Items — add it manually in System Settings › General › Login Items"
    fi
    open -a "$SWIFTBAR" 2>/dev/null
    open "swiftbar://refreshall" 2>/dev/null
    echo "• SwiftBar launched / refreshed"
fi

echo
echo "Done. Look at your menu bar for:  ◉ NN% ████░░ H:MM · W NN%  (· X NN% if you have a per-model weekly cap)"
echo "If SwiftBar asks for a plugins folder, choose: $PLUGDIR"
