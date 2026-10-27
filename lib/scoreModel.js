// Pure scoreline model. Keep identical to util/scoreModel.js in the
// fpl-difficulty app: the app derives every probability from the lambdas
// fitted here, so both sides must use the same model (incl. DIXON_COLES_RHO).
//
// Goals for each side are Poisson with means lambdaHome/lambdaAway, with the
// Dixon-Coles low-score correction (rho) applied to 0-0, 1-0, 0-1 and 1-1.

export const DIXON_COLES_RHO = -0.1;
const MAX_GOALS = 10;
const MIN_LAMBDA = 0.1;
const MAX_LAMBDA = 4.5;

const poissonPmf = (lambda) => {
  const pmf = [Math.exp(-lambda)];
  for (let k = 1; k <= MAX_GOALS; k += 1) pmf.push((pmf[k - 1] * lambda) / k);
  return pmf;
};

const dixonColesTau = (h, a, lh, la, rho) => {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
};

export function scoreMatrix(lambdaHome, lambdaAway, rho = DIXON_COLES_RHO) {
  const ph = poissonPmf(lambdaHome);
  const pa = poissonPmf(lambdaAway);
  const matrix = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    const row = [];
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const p = Math.max(ph[h] * pa[a] * dixonColesTau(h, a, lambdaHome, lambdaAway, rho), 0);
      row.push(p);
      total += p;
    }
    matrix.push(row);
  }
  return matrix.map((row) => row.map((p) => p / total));
}

// totalsLine: a half-goal line (e.g. 2.5) to report P(over), or undefined.
export function summarizeMatrix(matrix, totalsLine) {
  let home = 0;
  let draw = 0;
  let away = 0;
  let homeZero = 0;
  let awayZero = 0;
  let over = 0;
  const scores = [];
  matrix.forEach((row, h) =>
    row.forEach((p, a) => {
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
      if (h === 0) homeZero += p;
      if (a === 0) awayZero += p;
      if (totalsLine !== undefined && h + a > totalsLine) over += p;
      scores.push([h, a, p]);
    }),
  );
  scores.sort((x, y) => y[2] - x[2]);
  return {
    home,
    draw,
    away,
    csHome: awayZero,
    csAway: homeZero,
    scoreHome: 1 - homeZero,
    scoreAway: 1 - awayZero,
    btts: 1 - homeZero - awayZero + matrix[0][0],
    over: totalsLine !== undefined ? over : undefined,
    topScores: scores.slice(0, 3),
  };
}

export function fixtureProbabilities(lambdaHome, lambdaAway, rho = DIXON_COLES_RHO) {
  return summarizeMatrix(scoreMatrix(lambdaHome, lambdaAway, rho));
}

// Bookmaker margin removal: scale implied probabilities (1/price) to sum to 1.
export function devig(prices) {
  const implied = prices.map((price) => (price > 1 ? 1 / price : 0));
  const total = implied.reduce((sum, p) => sum + p, 0);
  return total > 0 ? implied.map((p) => p / total) : null;
}

// Finds the lambdas whose scoreline model best reproduces the market:
// target = { home, draw, away, over?, totalsLine? } (margin-free probabilities).
// Coarse-to-fine grid search: deterministic, ~100ms per fixture.
export function fitLambdas(target, rho = DIXON_COLES_RHO) {
  const hasTotals = target.over !== undefined && target.totalsLine !== undefined;
  const error = (lh, la) => {
    const s = summarizeMatrix(scoreMatrix(lh, la, rho), hasTotals ? target.totalsLine : undefined);
    let err =
      (s.home - target.home) ** 2 + (s.draw - target.draw) ** 2 + (s.away - target.away) ** 2;
    if (hasTotals) err += (s.over - target.over) ** 2;
    return err;
  };
  const search = (centerH, centerA, halfWidth, step) => {
    let best = { lh: centerH, la: centerA, err: Infinity };
    for (let lh = centerH - halfWidth; lh <= centerH + halfWidth + 1e-9; lh += step) {
      if (lh < MIN_LAMBDA || lh > MAX_LAMBDA) continue;
      for (let la = centerA - halfWidth; la <= centerA + halfWidth + 1e-9; la += step) {
        if (la < MIN_LAMBDA || la > MAX_LAMBDA) continue;
        const err = error(lh, la);
        if (err < best.err) best = { lh, la, err };
      }
    }
    return best;
  };
  const coarse = search(2.3, 2.3, 2.2, 0.1);
  const medium = search(coarse.lh, coarse.la, 0.1, 0.01);
  const fine = search(medium.lh, medium.la, 0.01, 0.001);
  return { lambdaHome: fine.lh, lambdaAway: fine.la, error: fine.err };
}
