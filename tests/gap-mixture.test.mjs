import assert from 'node:assert/strict';
import {
  logGapsFromTimestamps,
  fitGaussianMixture,
  decisionBoundaries,
  histogram,
  fitRange,
} from '../gap-mixture.mjs';

// --- log₁₀-Abstände ---------------------------------------------------------
{
  // 10 s, 100 s, 1000 s → 1, 2, 3
  const { values, clamped, minSeconds, maxSeconds } = logGapsFromTimestamps([0, 10, 110, 1110]);
  assert.deepEqual(values.map((value) => Math.round(value * 1e9) / 1e9), [1, 2, 3]);
  assert.equal(clamped, 0);
  assert.equal(minSeconds, 10);
  assert.equal(maxSeconds, 1000);
}
{
  // Gleiche Sekunde → auf 1 s angehoben (log 0), und gezählt.
  const { values, clamped } = logGapsFromTimestamps([100, 100, 100]);
  assert.deepEqual(values, [0, 0]);
  assert.equal(clamped, 2, 'beide Null-Abstände werden gemeldet');
}

// --- Deterministischer, reproduzierbarer Pseudo-Zufall für die Testdaten ----
function mulberry32(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normals(rng, count, mean, sd) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    // Box–Muller
    const u1 = Math.max(rng(), Number.MIN_VALUE);
    const u2 = rng();
    out.push(mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  return out;
}

// --- Eine echte Mischung wird wiedergefunden --------------------------------
{
  const rng = mulberry32(20260820);
  // Zwei klar getrennte Komponenten: Mittelwerte 1 und 4, Streuung 0,3.
  const values = [...normals(rng, 3000, 1, 0.3), ...normals(rng, 2000, 4, 0.3)];
  const fit = fitGaussianMixture(values, 2);

  assert.ok(fit.converged, 'EM konvergiert');
  assert.ok(Math.abs(fit.means[0] - 1) < 0.05, `Mittelwert 1 wiedergefunden (${fit.means[0]})`);
  assert.ok(Math.abs(fit.means[1] - 4) < 0.05, `Mittelwert 4 wiedergefunden (${fit.means[1]})`);
  assert.ok(Math.abs(fit.sigmas[0] - 0.3) < 0.05, 'Streuung 1 wiedergefunden');
  assert.ok(Math.abs(fit.sigmas[1] - 0.3) < 0.05, 'Streuung 2 wiedergefunden');
  assert.ok(Math.abs(fit.weights[0] - 0.6) < 0.05, `Gewicht 0,6 wiedergefunden (${fit.weights[0]})`);
  // Komponenten kommen nach Mittelwert sortiert zurück.
  assert.ok(fit.means[0] < fit.means[1], 'aufsteigend nach Mittelwert sortiert');

  // BIC bevorzugt hier k = 2 gegenüber k = 1.
  const { fits, bestK } = fitRange(values, { maxK: 4 });
  assert.equal(fits.length, 4);
  assert.ok(fits[1].bic < fits[0].bic, 'k=2 schlägt k=1');
  assert.ok([2, 3, 4].includes(bestK), `bestes k ist mindestens 2 (war ${bestK})`);

  // Entscheidungsgrenze liegt bei gleichen Streuungen und leicht ungleichen
  // Gewichten nahe der Mitte (2,5), jedenfalls klar zwischen den Mittelwerten.
  const boundaries = decisionBoundaries(fit);
  assert.equal(boundaries.length, 1);
  assert.ok(boundaries[0].log10 > 1 && boundaries[0].log10 < 4, 'Grenze liegt zwischen den Mittelwerten');
  assert.ok(Math.abs(boundaries[0].log10 - 2.5) < 0.3, `Grenze nahe der Mitte (${boundaries[0].log10})`);
}

// --- Eine einzelne Normalverteilung: BIC wählt k = 1 ------------------------
{
  const rng = mulberry32(7);
  const values = normals(rng, 4000, 2, 0.5);
  const { bestK } = fitRange(values, { maxK: 4 });
  assert.equal(bestK, 1, `homogene Daten → k = 1 (war ${bestK})`);
}

// --- BIC-Formel: −2·logL + (3k−1)·ln(n) -------------------------------------
{
  const rng = mulberry32(99);
  const values = normals(rng, 500, 0, 1);
  const fit = fitGaussianMixture(values, 2);
  const expected = -2 * fit.logLikelihood + (3 * 2 - 1) * Math.log(fit.n);
  assert.ok(Math.abs(fit.bic - expected) < 1e-9, 'BIC entspricht der Definition');
  assert.equal(fit.n, 500);
}

// --- Histogramm -------------------------------------------------------------
{
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const result = histogram(values, 5);
  assert.equal(result.bins, 5);
  assert.equal(result.min, 0);
  assert.equal(result.max, 10);
  assert.equal(result.width, 2);
  assert.equal(result.counts.reduce((sum, count) => sum + count, 0), values.length,
    'jeder Wert landet in genau einem Bin (auch das Maximum)');
  assert.equal(result.edges.length, 6);
  assert.equal(result.edges[5], 10);
}

// --- Randfälle --------------------------------------------------------------
{
  const empty = fitGaussianMixture([], 2);
  assert.equal(empty.n, 0);
  assert.ok(Number.isNaN(empty.bic), 'leere Daten liefern kein BIC');
  const oneValue = histogram([], 60);
  assert.equal(oneValue.counts.length, 60);

  // Entartete Daten (alle gleich): kein Absturz, Streuung auf der Untergrenze.
  const constant = fitGaussianMixture(new Array(100).fill(3), 2);
  assert.ok(constant.sigmas.every((sigma) => sigma > 0), 'Streuung bleibt positiv');
  assert.ok(constant.means.every((mean) => Math.abs(mean - 3) < 1e-6), 'Mittelwerte liegen auf dem Wert');
}

console.log('gap-mixture tests: PASS');
