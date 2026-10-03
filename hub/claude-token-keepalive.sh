#!/usr/bin/env bash
# Keep this machine's Claude Code login fresh so the TokenBar hub never serves stale
# usage. The OAuth access token lasts ~8 h and is only refreshed when Claude Code runs,
# and a `claude setup-token` token can't stand in: it lacks the user:profile scope the
# usage endpoint requires (403). install-hub.sh runs this hourly from a systemd timer.
# 1) `claude auth status` costs nothing; 2) if the token still expires within 90 min,
# a one-word Haiku prompt forces Claude Code to refresh it.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
CRED="$HOME/.claude/.credentials.json"
mins_left() { node -e 'try{const c=require(process.argv[1]).claudeAiOauth;console.log(Math.round((c.expiresAt-Date.now())/60000))}catch{console.log(-1)}' "$CRED"; }

before=$(mins_left)
claude auth status >/dev/null 2>&1
after=$(mins_left)
if [ "$after" -lt 90 ]; then
    cd "$HOME" && timeout 120 claude -p --model haiku "Reply with just: ok" >/dev/null 2>&1
    echo "token: ${before} min → auth status → ${after} min → prompt → $(mins_left) min left"
else
    echo "token: ${after} min left (no refresh needed)"
fi
