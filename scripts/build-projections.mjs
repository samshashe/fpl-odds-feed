// Builds team-projections.json from bookmaker odds (The Odds API) for the
// GitHub Pages feed the FPL Difficulty app reads. Run by
// .github/workflows/odds-projections.yml.
//
// Env:
//   ODDS_API_KEY   required unless ODDS_JSON is set
//   ODDS_REGIONS   bookmaker region(s), default "eu" (each region costs 1 credit per market)
//   PREVIOUS_URL   the currently published file; kept fixtures + opening lines come from it
//   OUT_DIR        output directory, default "site"
//   ODDS_JSON / FPL_BOOTSTRAP_JSON / FPL_FIXTURES_JSON / PREVIOUS_JSON
//                  local file paths used instead of the network (offline testing)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { devig, fitLambdas } from "../lib/scoreModel.js";

const FPL_BASE = "https://fantasy.premierleague.com/api/";
const ODDS_URL = "https://api.the-odds-api.com/v4/sports/soccer_epl/odds";
const MATCH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const NAME_ALIASES = {
  "man city": "manchester city",
  "man utd": "manchester united",
  "nottm forest": "nottingham forest",
  spurs: "tottenham",
  wolves: "wolverhampton",
  "sheffield utd": "sheffield united",
};

const env = process.env;
const round = (value, digits = 3) => Number(value.toFixed(digits));

async function loadJson({ file, url, headers, optional = false }) {
  try {
    if (file) return JSON.parse(await readFile(file, "utf8"));
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.split("?")[0]}`);
    const remaining = response.headers.get("x-requests-remaining");
    if (remaining !== null) {
      console.log(
        `Odds API credits used: ${response.headers.get("x-requests-used")}, remaining: ${remaining}`,
      );
    }
    return await response.json();
  } catch (error) {
    if (optional) {
      console.log(`Skipping optional source: ${error.message}`);
      return null;
    }
    throw error;
  }
}

const canonicalName = (name) => {
  const cleaned = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return NAME_ALIASES[cleaned] || cleaned;
};

const namesMatch = (a, b) => {
  const tokensA = canonicalName(a).split(" ");
  const tokensB = canonicalName(b).split(" ");
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shorter.every((token) => longer.includes(token));
};

const average = (list) => list.reduce((sum, v) => sum + v, 0) / list.length;

// Margin-free 1X2 and over/under probabilities averaged across bookmakers.
function marketTarget(event) {
  const h2h = [];
  const totalsByLine = new Map();
  for (const bookmaker of event.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      const price = (name, point) =>
        market.outcomes.find((o) => o.name === name && (point === undefined || o.point === point))?.price;
      if (market.key === "h2h") {
        const probs = devig([price(event.home_team), price("Draw"), price(event.away_team)]);
        if (probs && probs.every((p) => p > 0)) h2h.push(probs);
      } else if (market.key === "totals") {
        const lines = new Set(market.outcomes.map((o) => o.point).filter((p) => p % 1 === 0.5));
        for (const line of lines) {
          const probs = devig([price("Over", line), price("Under", line)]);
          if (!probs || !probs.every((p) => p > 0)) continue;
          if (!totalsByLine.has(line)) totalsByLine.set(line, []);
          totalsByLine.get(line).push(probs[0]);
        }
      }
    }
  }
  if (!h2h.length) return null;
  const target = {
    home: average(h2h.map((p) => p[0])),
    draw: average(h2h.map((p) => p[1])),
    away: average(h2h.map((p) => p[2])),
    books: h2h.length,
  };
  const [line, overs] =
    [...totalsByLine.entries()].sort(
      (a, b) => b[1].length - a[1].length || Math.abs(a[0] - 2.5) - Math.abs(b[0] - 2.5),
    )[0] || [];
  if (line !== undefined) {
    target.totalsLine = line;
    target.over = average(overs);
  }
  return target;
}

function findFplFixture(event, fplFixtures, teamsById) {
  const commence = new Date(event.commence_time).getTime();
  const candidates = fplFixtures.filter(
    (f) =>
      f.kickoff_time &&
      !f.finished &&
      Math.abs(new Date(f.kickoff_time).getTime() - commence) <= MATCH_WINDOW_MS &&
      namesMatch(teamsById.get(f.team_h)?.name || "", event.home_team) &&
      namesMatch(teamsById.get(f.team_a)?.name || "", event.away_team),
  );
  candidates.sort(
    (a, b) =>
      Math.abs(new Date(a.kickoff_time).getTime() - commence) -
      Math.abs(new Date(b.kickoff_time).getTime() - commence),
  );
  return candidates[0];
}

async function main() {
  const regions = env.ODDS_REGIONS || "eu";
  if (!env.ODDS_JSON && !env.ODDS_API_KEY) throw new Error("ODDS_API_KEY is not set");
  const fplHeaders = { "User-Agent": "fpl-difficulty-odds-job" };

  const [bootstrap, fplFixtures, oddsEvents, previous] = await Promise.all([
    loadJson({ file: env.FPL_BOOTSTRAP_JSON, url: `${FPL_BASE}bootstrap-static/`, headers: fplHeaders }),
    loadJson({ file: env.FPL_FIXTURES_JSON, url: `${FPL_BASE}fixtures/`, headers: fplHeaders }),
    loadJson({
      file: env.ODDS_JSON,
      url: `${ODDS_URL}?apiKey=${env.ODDS_API_KEY}&regions=${regions}&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`,
    }),
    env.PREVIOUS_JSON || env.PREVIOUS_URL
      ? loadJson({ file: env.PREVIOUS_JSON, url: env.PREVIOUS_URL, optional: true })
      : null,
  ]);

  const teamsById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const season = String(bootstrap.events?.[0]?.deadline_time || "").slice(0, 4);
  const currentEvent =
    bootstrap.events.find((e) => e.is_current)?.id ?? bootstrap.events.find((e) => e.is_next)?.id ?? 1;
  const now = new Date().toISOString();
  const previousFixtures = previous?.season === season ? previous.fixtures || {} : {};

  const fixtures = {};
  for (const [id, record] of Object.entries(previousFixtures)) {
    if (record.event >= currentEvent) fixtures[id] = record;
  }

  const unmatched = [];
  let fitted = 0;
  for (const event of oddsEvents) {
    const fplFixture = findFplFixture(event, fplFixtures, teamsById);
    if (!fplFixture) {
      unmatched.push(`${event.home_team} v ${event.away_team} (${event.commence_time})`);
      continue;
    }
    if (fplFixture.started) continue;
    const target = marketTarget(event);
    if (!target) continue;
    const { lambdaHome, lambdaAway } = fitLambdas(target);
    const current = { lambdaHome: round(lambdaHome), lambdaAway: round(lambdaAway) };
    const prior = previousFixtures[fplFixture.id];
    fixtures[fplFixture.id] = {
      id: fplFixture.id,
      event: fplFixture.event,
      kickoff: fplFixture.kickoff_time,
      home: fplFixture.team_h,
      away: fplFixture.team_a,
      ...current,
      market: {
        home: round(target.home),
        draw: round(target.draw),
        away: round(target.away),
        ...(target.over !== undefined && { over: round(target.over), totalsLine: target.totalsLine }),
      },
      books: target.books,
      opening: prior?.opening || { ...current, at: now },
      updatedAt: now,
    };
    fitted += 1;
  }

  console.log(`Fitted ${fitted} of ${oddsEvents.length} odds events; ${Object.keys(fixtures).length} fixtures published.`);
  if (unmatched.length) console.log(`Unmatched odds events:\n  ${unmatched.join("\n  ")}`);

  const outDir = env.OUT_DIR || "site";
  await mkdir(outDir, { recursive: true });
  const output = { version: 1, season, generatedAt: now, source: "the-odds-api", regions, fixtures };
  await writeFile(path.join(outDir, "team-projections.json"), JSON.stringify(output));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
