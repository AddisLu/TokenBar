#!/usr/bin/env node
// Daily logger — fetch current Claude usage and append a snapshot to the history
// file (~/.local/share/claude-usage-mcp/history.jsonl). Run on a timer/cron.
// This is the starter "daily automated task" for this project; swap in your own by
// pointing the schedule at a different script (e.g. `claude -p "<your task>"`).
import { fetchUsage, humanSummary, appendHistory, HISTORY } from './usage-core.mjs';

const u = await fetchUsage();
const ok = appendHistory(u);
// stderr = human log (visible in journalctl); stdout stays clean
console.error(`[claude-usage log] ${new Date().toISOString()}`);
console.error(humanSummary(u));
console.error(ok ? `→ appended to ${HISTORY}` : `→ NOT logged (${u.error || 'unknown'})`);
process.exit(0);
