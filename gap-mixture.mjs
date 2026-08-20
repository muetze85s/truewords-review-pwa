/**
 * Gauß-Mischmodelle über den Logarithmus der Nachrichtenabstände.
 *
 * Frage dahinter: Hat die Verteilung der Pausen zwischen zwei benachbarten
 * Nachrichten überhaupt eine natürliche Struktur — etwa „Tippen im Gespräch",
 * „Antwort nach Stunden", „nächster Tag" — oder ist sie ein einziges Kontinuum?
 * Antwortet BIC mit k = 1, gibt es keine trennenden Zeitschwellen; findet es
 * mehrere Komponenten, sind deren Entscheidungsgrenzen die einzigen
 * datengestützten Schwellwerte, die es gibt.
 *
 * Gerechnet wird auf log₁₀(Δt in Sekunden): Abstände sind über Größenordnungen
 * verteilt (Sekunden bis Wochen), erst der Logarithmus macht daraus etwas, das
 * eine Mischung aus Normalverteilungen sinnvoll beschreiben kann.
 *
 * Rein rechnend, ohne D1-/DOM-/Fetch-Aufrufe — direkt mit `node` testbar
 * (tests/gap-mixture.test.mjs) und vom Worker importierbar. Deterministisch:
 * die Startwerte kommen aus Quantilen, nicht aus Zufall, damit derselbe
 * Datenstand immer dasselbe Ergebnis liefert.
 */

const LOG_2PI = Math.log(2 * Math.PI);
// Untergrenze der Streuung: verhindert, dass eine Komponente auf einen einzigen
// Punkt kollabiert (Likelihood → ∞, klassische EM-Entartung).
const MIN_SIGMA = 1e-3;

/**
 * log₁₀ der Abstände zweier benachbarter Zeitstempel.
 *
 * Δt ≤ 0 (gleiche Sekunde, oder eine nicht monotone Reihenfolge) hat keinen
 * Logarithmus. Solche Abstände werden auf 1 s angehoben statt verworfen — sie
 * sind echte Ereignisse („zwei Nachrichten in derselben Sekunde") und würden
 * sonst genau den dichtesten Teil der Verteilung ausdünnen. Wie viele es waren,
 * meldet der Rückgabewert mit.
 *
 * @param {number[]} seconds  Zeitstempel in Sekunden, in Reihenfolge.
 * @returns {{ values: number[], clamped: number, minSeconds: number, maxSeconds: number }}
 */
export function logGapsFromTimestamps(seconds) {
  const values = [];
  let clamped = 0;
  let minSeconds = Infinity;
  let maxSeconds = -Infinity;
  for (let index = 1; index < seconds.length; index += 1) {
    const previous = seconds[index - 1];
    const current = seconds[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    let delta = current - previous;
    if (delta < 1) { delta = 1; clamped += 1; }
    if (delta < minSeconds) minSeconds = delta;
    if (delta > maxSeconds) maxSeconds = delta;
    values.push(Math.log10(delta));
  }
  return {
    values,
    clamped,
    minSeconds: Number.isFinite(minSeconds) ? minSeconds : 0,
    maxSeconds: Number.isFinite(maxSeconds) ? maxSeconds : 0,
  };
}

/** Quantil eines bereits sortierten Feldes (lineare Interpolation). */
function quantileSorted(sorted, p) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * EM-Anpassung einer eindimensionalen Gauß-Mischung mit k Komponenten.
 *
 * Startwerte deterministisch aus Quantilen: die Mittelwerte sitzen bei
 * (i+0,5)/k, die Streuungen bei der globalen Streuung geteilt durch k, die
 * Gewichte gleichverteilt. Abgebrochen wird, sobald sich die Log-Likelihood um
 * weniger als `tolerance` ändert.
 *
 * @param {number[]} values
 * @param {number} k
 * @param {{ maxIterations?: number, tolerance?: number }} [options]
 * @returns {{ k: number, weights: number[], means: number[], sigmas: number[],
 *   logLikelihood: number, bic: number, aic: number, iterations: number,
 *   converged: boolean, n: number }}
 */
export function fitGaussianMixture(values, k, options = {}) {
  const maxIterations = options.maxIterations ?? 300;
  // Relative Toleranz: konvergiert, wenn sich die Log-Likelihood um weniger
  // als tolerance·max(1, |logL|) ändert. Eine absolute Schwelle (früher 1e-8)
  // ist bei |logL| in den Zehntausenden nie erreichbar — die Fits liefen dann
  // grundlos bis zum Iterationslimit und galten als „nicht konvergiert".
  const tolerance = options.tolerance ?? 1e-7;
  const n = values.length;
  if (!n || k < 1) {
    return { k, weights: [], means: [], sigmas: [], logLikelihood: NaN, bic: NaN, aic: NaN, iterations: 0, converged: false, n };
  }

  const sorted = [...values].sort((a, b) => a - b);
  let mean = 0;
  for (const value of values) mean += value;
  mean /= n;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  variance = variance / n;
  const globalSigma = Math.max(Math.sqrt(variance), MIN_SIGMA);

  const weights = new Array(k).fill(1 / k);
  const means = new Array(k);
  const sigmas = new Array(k).fill(Math.max(globalSigma / Math.max(1, k), MIN_SIGMA));
  for (let component = 0; component < k; component += 1) {
    means[component] = quantileSorted(sorted, (component + 0.5) / k);
  }

  const responsibilities = new Float64Array(n * k);
  let logLikelihood = -Infinity;
  let iterations = 0;
  let converged = false;

  for (; iterations < maxIterations; iterations += 1) {
    // --- E-Schritt: Zuständigkeiten, stabilisiert über den Log-Sum-Exp-Trick.
    let nextLogLikelihood = 0;
    const logWeights = weights.map((weight) => Math.log(Math.max(weight, Number.MIN_VALUE)));
    const logSigmas = sigmas.map((sigma) => Math.log(sigma));
    const logs = new Float64Array(k); // wiederverwendet — keine Allokation je Punkt
    for (let index = 0; index < n; index += 1) {
      const value = values[index];
      let maxLog = -Infinity;
      for (let component = 0; component < k; component += 1) {
        const z = (value - means[component]) / sigmas[component];
        const log = logWeights[component] - logSigmas[component] - 0.5 * LOG_2PI - 0.5 * z * z;
        logs[component] = log;
        if (log > maxLog) maxLog = log;
      }
      let sum = 0;
      for (let component = 0; component < k; component += 1) sum += Math.exp(logs[component] - maxLog);
      const logSum = maxLog + Math.log(sum);
      nextLogLikelihood += logSum;
      for (let component = 0; component < k; component += 1) {
        responsibilities[index * k + component] = Math.exp(logs[component] - logSum);
      }
    }

    // --- M-Schritt: Gewichte, Mittelwerte, Streuungen neu setzen.
    for (let component = 0; component < k; component += 1) {
      let mass = 0;
      let weightedSum = 0;
      for (let index = 0; index < n; index += 1) {
        const responsibility = responsibilities[index * k + component];
        mass += responsibility;
        weightedSum += responsibility * values[index];
      }
      if (mass <= Number.MIN_VALUE) {
        // Leergelaufene Komponente: an der globalen Lage neu ansetzen statt NaN.
        weights[component] = Number.MIN_VALUE;
        means[component] = mean;
        sigmas[component] = globalSigma;
        continue;
      }
      const newMean = weightedSum / mass;
      let weightedVariance = 0;
      for (let index = 0; index < n; index += 1) {
        weightedVariance += responsibilities[index * k + component] * (values[index] - newMean) ** 2;
      }
      weights[component] = mass / n;
      means[component] = newMean;
      sigmas[component] = Math.max(Math.sqrt(weightedVariance / mass), MIN_SIGMA);
    }

    const threshold = tolerance * Math.max(1, Math.abs(nextLogLikelihood));
    if (Number.isFinite(logLikelihood) && Math.abs(nextLogLikelihood - logLikelihood) < threshold) {
      logLikelihood = nextLogLikelihood;
      converged = true;
      iterations += 1;
      break;
    }
    logLikelihood = nextLogLikelihood;
  }

  // Freie Parameter: k Mittelwerte + k Streuungen + (k−1) Gewichte.
  const parameters = 3 * k - 1;
  const bic = -2 * logLikelihood + parameters * Math.log(n);
  const aic = -2 * logLikelihood + 2 * parameters;

  // Nach Mittelwert sortiert zurückgeben — „Komponente 1" ist immer die
  // schnellste, damit Grenzen und Jahresvergleiche vergleichbar bleiben.
  const order = means.map((value, index) => index).sort((a, b) => means[a] - means[b]);
  return {
    k,
    weights: order.map((index) => weights[index]),
    means: order.map((index) => means[index]),
    sigmas: order.map((index) => sigmas[index]),
    logLikelihood,
    bic,
    aic,
    iterations,
    converged,
    n,
  };
}

/** log der gewichteten Dichte einer Komponente an der Stelle x. */
function logWeightedDensity(x, weight, mean, sigma) {
  const z = (x - mean) / sigma;
  return Math.log(Math.max(weight, Number.MIN_VALUE)) - Math.log(sigma) - 0.5 * LOG_2PI - 0.5 * z * z;
}

/**
 * Entscheidungsgrenzen zwischen je zwei benachbarten Komponenten: die Stelle,
 * an der die gewichteten Dichten gleich groß sind — links davon gewinnt die
 * schnellere, rechts die langsamere Komponente.
 *
 * Bestimmt per Bisektion zwischen den beiden Mittelwerten. Das ist robust auch
 * dann, wenn die analytische Lösung (quadratische Gleichung) entartet, weil
 * beide Streuungen gleich sind. Liegt im Intervall kein Vorzeichenwechsel —
 * möglich, wenn eine Komponente die andere komplett überdeckt —, gibt es für
 * dieses Paar keine Grenze (null).
 *
 * @param {{ weights: number[], means: number[], sigmas: number[] }} fit
 * @returns {Array<{ between: [number, number], log10: number | null }>}
 */
export function decisionBoundaries(fit) {
  const out = [];
  for (let index = 0; index + 1 < fit.means.length; index += 1) {
    const left = index;
    const right = index + 1;
    const f = (x) => logWeightedDensity(x, fit.weights[left], fit.means[left], fit.sigmas[left])
      - logWeightedDensity(x, fit.weights[right], fit.means[right], fit.sigmas[right]);
    let low = fit.means[left];
    let high = fit.means[right];
    const fLow = f(low);
    const fHigh = f(high);
    if (!(Number.isFinite(fLow) && Number.isFinite(fHigh)) || fLow * fHigh > 0) {
      out.push({ between: [left, right], log10: null });
      continue;
    }
    for (let step = 0; step < 200; step += 1) {
      const mid = (low + high) / 2;
      if (f(low) * f(mid) <= 0) high = mid; else low = mid;
    }
    out.push({ between: [left, right], log10: (low + high) / 2 });
  }
  return out;
}

/**
 * Histogramm über log₁₀(Δt) mit fester Bin-Zahl.
 *
 * @param {number[]} values
 * @param {number} bins
 * @returns {{ bins: number, min: number, max: number, width: number, counts: number[], edges: number[] }}
 */
export function histogram(values, bins) {
  const count = Math.max(1, Math.floor(bins));
  const counts = new Array(count).fill(0);
  if (!values.length) return { bins: count, min: 0, max: 0, width: 0, counts, edges: [] };
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const width = (max - min) / count || 1;
  for (const value of values) {
    let bin = Math.floor((value - min) / width);
    if (bin < 0) bin = 0;
    if (bin >= count) bin = count - 1; // der Maximalwert fällt in den letzten Bin
    counts[bin] += 1;
  }
  const edges = new Array(count + 1);
  for (let index = 0; index <= count; index += 1) edges[index] = min + index * width;
  return { bins: count, min, max, width, counts, edges };
}

/**
 * Fittet k = 1…maxK und wählt das Modell mit dem kleinsten BIC.
 *
 * @param {number[]} values
 * @param {{ maxK?: number, maxIterations?: number, tolerance?: number }} [options]
 * @returns {{ fits: ReturnType<typeof fitGaussianMixture>[], bestK: number }}
 */
export function fitRange(values, options = {}) {
  const maxK = options.maxK ?? 4;
  const fits = [];
  for (let k = 1; k <= maxK; k += 1) fits.push(fitGaussianMixture(values, k, options));
  let bestK = 0;
  let bestBic = Infinity;
  for (const fit of fits) {
    if (Number.isFinite(fit.bic) && fit.bic < bestBic) { bestBic = fit.bic; bestK = fit.k; }
  }
  return { fits, bestK };
}
