// Builds player-priors.json: each FPL player's last two seasons (from
// element-summary `history_past`), for the FPL Difficulty app to start its
// per-90 rates from instead of the position average. Run by
// .github/workflows/odds-projections.yml next to the projections build (one
// Pages site, so every deploy must carry both files).
//
// Env:
//   PREVIOUS_URL       the currently published player-priors.json; reused as is
//                      while it is younger than MAX_AGE_HOURS and the season matches
//   MAX_AGE_HOURS      default 20 (so one of the three daily runs rebuilds it)
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
const maxAgeMs = Number(env.MAX_AGE_HOURS || 20) * 60 * 60 * 1000;
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

  const fresh =
    previous?.season === season &&
    Date.now() - new Date(previous.generatedAt).getTime() < maxAgeMs;
  if (fresh) {
    await writeFile(outFile, JSON.stringify(previous));
    console.log(`Reused priors from ${previous.generatedAt} (${Object.keys(previous.players).length} players).`);
    return;
  }

  const elements = bootstrap.elements;
  const started = Date.now();
  const results = await mapLimited(elements, concurrency, (element) =>
    getJson(`${FPL_BASE}element-summary/${element.id}/`),
  );
  const failures = results.filter((r) => !r.ok).length;
  if (failures > elements.length * MAX_FAILURE_SHARE && previous?.players) {
    console.log(`${failures} of ${elements.length} requests failed; keeping the previous priors.`);
    await writeFile(outFile, JSON.stringify(previous));
    return;
  }

  const players = {};
  results.forEach((result, index) => {
    if (!result.ok) return;
    const seasons = (result.value.history_past || [])
      .slice(-SEASONS_KEPT)
      .reverse()
      .filter((s) => Number(s.minutes) > 0)
      .map((s) => ({ season: s.season_name, v: FIELDS.map((f) => round(s[f])) }));
    if (seasons.length) players[elements[index].id] = { code: elements[index].code, seasons };
  });

  const output = {
    version: 1,
    season,
    generatedAt: new Date().toISOString(),
    fields: FIELDS,
    players,
  };
  await writeFile(outFile, JSON.stringify(output));
  console.log(
    `Priors for ${Object.keys(players).length} of ${elements.length} players (${failures} failed) in ${Math.round((Date.now() - started) / 1000)}s.`,
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
