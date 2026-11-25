// Whether the scheduled job has anything to do: true while an unplayed Premier
// League fixture kicks off within WINDOW_DAYS (default 21, longer than an
// international break). Between seasons nothing is due, so the job skips the
// odds requests and the Pages deploy, and starts again before GW1 by itself.
// If FPL can't be reached it says true (better a normal run than a missed one).
// Writes `active=true|false` to $GITHUB_OUTPUT when set.
import { appendFile } from "node:fs/promises";

const windowDays = Number(process.env.WINDOW_DAYS || 21);

async function isActive() {
  try {
    const response = await fetch("https://fantasy.premierleague.com/api/fixtures/", {
      headers: { "User-Agent": "fpl-odds-feed-season-check" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const fixtures = await response.json();
    const until = Date.now() + windowDays * 24 * 60 * 60 * 1000;
    const next = fixtures
      .filter((f) => !f.finished && f.kickoff_time)
      .map((f) => new Date(f.kickoff_time).getTime())
      .sort((a, b) => a - b)[0];
    console.log(next ? `Next unplayed fixture: ${new Date(next).toISOString()}` : "No unplayed fixtures.");
    return next !== undefined && next <= until;
  } catch (error) {
    console.log(`Season check failed (${error.message}); running anyway.`);
    return true;
  }
}

const active = await isActive();
console.log(active ? "Season active: running." : `Nothing within ${windowDays} days: skipping.`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `active=${active}\n`);
