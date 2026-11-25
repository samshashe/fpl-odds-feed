// Builds player-priors.json: each FPL player's last two seasons (from
// element-summary `history_past`), for the FPL Difficulty app to start its
// per-90 rates from instead of the position average. Run by
// .github/workflows/odds-projections.yml next to the projections build (one
// Pages site, so every deploy must carry both files).
//
// Past seasons don't change, so within a season it's incremental: players
// already in the published file (or listed in `noHistory`) are kept and only
// new ones (e.g. January signings) are fetched; nothing new = no requests.
// A full rebuild happens when the season changes or with FULL_REBUILD=1.
//
// Env:
//   PREVIOUS_URL       the currently published player-priors.json
//   FULL_REBUILD       "1" to refetch every player
//   OUT_DIR            output directory, default "site"
//   CONCURRENCY        parallel element-summary requests, default 6
//   FPL_BOOTSTRAP_JSON / PREVIOUS_JSON  local files instead of the network
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FPL_BASE = "https://fantasy.premierleague.com/api/";
const HEADERS = { "User-Agent": "fpl-difficulty-priors-job" };
const SEASONS_KEPT = 2;
const MAX_FAILURE_SHARE = 0.1;
// Order of each season's values in the output (kept short: ~700 players).
const FIELDS = [
  "minutes",
  "starts",
  "goals_scored",
  "assists",
  "expected_goals",
  "expected_assists",
  "expected_goals_conceded",
  "clean_sheets",
  "bonus",
  "yellow_cards",
  "red_cards",
  "saves",
  "defensive_contribution",
  "total_points",
];

const env = process.env;
const concurrency = Number(env.CONCURRENCY || 6);
const outDir = env.OUT_DIR || "site";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, { attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: HEADERS });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(1000 * attempt);
    }
  }
}

async function loadPrevious() {
  try {
    if (env.PREVIOUS_JSON) return JSON.parse(await readFile(env.PREVIOUS_JSON, "utf8"));
    if (env.PREVIOUS_URL) return await getJson(env.PREVIOUS_URL, { attempts: 1 });
  } catch (error) {
    console.log(`No previous priors: ${error.message}`);
  }
  return null;
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try {
          results[index] = { ok: true, value: await fn(items[index]) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    }),
  );
  return results;
}

const round = (value) => Math.round(Number(value || 0) * 100) / 100;

let previousForFallback = null;

async function main() {
  previousForFallback = await loadPrevious();
  const bootstrap = env.FPL_BOOTSTRAP_JSON
    ? JSON.parse(await readFile(env.FPL_BOOTSTRAP_JSON, "utf8"))
    : await getJson(`${FPL_BASE}bootstrap-static/`);
  const season = String(bootstrap.events?.[0]?.deadline_time || "").slice(0, 4);
  const previous = previousForFallback;
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "player-priors.json");

  const full = env.FULL_REBUILD === "1" || previous?.season !== season || !previous?.players;
  const kept = full ? {} : previous.players;
  const noHistory = new Set(full ? [] : previous.noHistory || []);
  const elements = bootstrap.elements;
  const todo = elements.filter((e) => !kept[e.id] && !noHistory.has(e.id));
  if (!full && !todo.length) {
    await writeFile(outFile, JSON.stringify(previous));
    console.log(`No new players; reused priors from ${previous.generatedAt}.`);
    return;
  }

  const started = Date.now();
  const results = await mapLimited(todo, concurrency, (element) =>
    getJson(`${FPL_BASE}element-summary/${element.id}/`),
  );
  const failures = results.filter((r) => !r.ok).length;
  if (full && failures > todo.length * MAX_FAILURE_SHARE && previous?.players) {
    console.log(`${failures} of ${todo.length} requests failed; keeping the previous priors.`);
    await writeFile(outFile, JSON.stringify(previous));
    return;
  }

  const current = new Set(elements.map((e) => e.id));
  const players = Object.fromEntries(
    Object.entries(kept).filter(([id]) => current.has(Number(id))),
  );
  results.forEach((result, index) => {
    if (!result.ok) return;
    const element = todo[index];
    const seasons = (result.value.history_past || [])
      .slice(-SEASONS_KEPT)
      .reverse()
      .filter((s) => Number(s.minutes) > 0)
      .map((s) => ({ season: s.season_name, v: FIELDS.map((f) => round(s[f])) }));
    if (seasons.length) players[element.id] = { code: element.code, seasons };
    else noHistory.add(element.id);
  });

  const output = {
    version: 1,
    season,
    generatedAt: new Date().toISOString(),
    fields: FIELDS,
    players,
    noHistory: [...noHistory].filter((id) => current.has(id)).sort((a, b) => a - b),
  };
  await writeFile(outFile, JSON.stringify(output));
  console.log(
    `${full ? "Full rebuild" : "Incremental"}: fetched ${todo.length} (${failures} failed, retried next run); priors for ${Object.keys(players).length} of ${elements.length} players in ${Math.round((Date.now() - started) / 1000)}s.`,
  );
}

// Never take the Pages deploy (and the odds file) down with it: on any
// error re-publish the previous priors when there are some.
main().catch(async (error) => {
  console.error(error.message);
  if (previousForFallback?.players) {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, "player-priors.json"),
      JSON.stringify(previousForFallback),
    );
    console.log("Kept the previously published priors.");
    return;
  }
  process.exit(1);
});
