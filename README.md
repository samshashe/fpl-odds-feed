# fpl-odds-feed

Bookmaker-derived Premier League projections for the FPL Difficulty app's
**Difficulty > Odds** view, published as a static JSON file:

https://samshashe.github.io/fpl-odds-feed/team-projections.json

## How it works

`.github/workflows/odds-projections.yml` runs three times a day (and on demand):

1. Fetches EPL 1X2 and over/under odds from [The Odds API](https://the-odds-api.com)
   (`soccer_epl`, markets `h2h,totals`, region `eu`: 2 credits per run, ~180 of
   the free 500/month).
2. Removes the bookmaker margin and averages across bookmakers.
3. Fits Dixon-Coles Poisson goal means (`lambdaHome`, `lambdaAway`) per fixture
   (`lib/scoreModel.js`).
4. Matches each event to its FPL fixture id by team name + kickoff time
   (`fantasy.premierleague.com/api/`).
5. Merges with the currently published file (keeps current-gameweek fixtures after
   bookmakers close their markets, and the first-seen `opening` lambdas) and deploys
   `team-projections.json` to GitHub Pages.

The API key only lives in this repo's Actions secrets; the app never sees it.

## Setup

1. Get a free key at https://the-odds-api.com.
2. Settings > Secrets and variables > Actions > New repository secret:
   `ODDS_API_KEY`.
3. Settings > Pages > Build and deployment > Source: **GitHub Actions**.
4. Actions > Odds projections > Run workflow. Check the log for
   `Unmatched odds events` - add any missing name mapping to `NAME_ALIASES` in
   `scripts/build-projections.mjs`.

GitHub disables scheduled workflows after 60 days without repository activity;
re-enable it from the Actions tab if that happens.

## Output

```json
{
  "version": 1, "season": "2026", "generatedAt": "...", "source": "the-odds-api", "regions": "eu",
  "fixtures": {
    "<fpl fixture id>": {
      "id": 91, "event": 10, "kickoff": "...", "home": 14, "away": 15,
      "lambdaHome": 2.129, "lambdaAway": 0.963,
      "market": { "home": 0.633, "draw": 0.21, "away": 0.157, "over": 0.595, "totalsLine": 2.5 },
      "books": 12, "opening": { "lambdaHome": 2.0, "lambdaAway": 0.8, "at": "..." }, "updatedAt": "..."
    }
  }
}
```

## Local run

```sh
ODDS_API_KEY=... node scripts/build-projections.mjs   # writes site/team-projections.json
```

Offline: set `ODDS_JSON`, `FPL_BOOTSTRAP_JSON`, `FPL_FIXTURES_JSON` (and optionally
`PREVIOUS_JSON`) to local files instead of fetching.

`lib/scoreModel.js` must stay identical to `util/scoreModel.js` in the app repo.
