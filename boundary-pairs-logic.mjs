/**
 * Reine Rechenlogik der Doppelprüfung: Rundenerzeugung, Paarung mit Toleranz,
 * Übereinstimmung und Cohens Kappa. Keine D1-/Fetch-Aufrufe, deshalb direkt
 * mit `node` testbar (siehe tests/boundary-pairs-logic.test.mjs) und ohne
 * Änderung vom Worker importierbar.
 */

/** Deterministischer 32-Bit-Hash für den Rundensamen. */
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: kleiner, seitenfreier PRNG — bei gleichem Samen immer dieselbe Folge. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Zieht einen überschneidungsfreien Startindex (0-basiert, Position in der
 * gefilterten Nachrichtenfolge) für eine Runde. Wirft, wenn nach maxAttempts
 * kein freier Platz gefunden wurde.
 */
export function pickRoundStart({
  datasetId,
  round,
  sequenceLength,
  windowSize = 100,
  existingRanges = [],
  maxAttempts = 200,
}) {
  if (sequenceLength < windowSize) {
    throw new Error('Die Nachrichtenfolge ist kürzer als eine Runde.');
  }
  const maxStart = sequenceLength - windowSize;
  const seed = hashSeed(`${datasetId}|${round}`);
  const rng = mulberry32(seed);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const start = Math.floor(rng() * (maxStart + 1));
    const overlaps = existingRanges.some(
      (range) => start < range.start + range.count && range.start < start + windowSize,
    );
    if (!overlaps) return start;
  }
  throw new Error(`Kein überschneidungsfreier Startpunkt nach ${maxAttempts} Versuchen gefunden.`);
}

/**
 * Gierige Paarung: jede Grenze aus a sucht sich das nächste noch freie b
 * innerhalb der Toleranz. Jedes b wird höchstens einmal vergeben.
 */
export function pairSeams(a, b, tolerance = 1) {
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  const usedB = new Array(sortedB.length).fill(false);
  const pairs = [];
  const onlyA = [];

  for (const position of sortedA) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < sortedB.length; index += 1) {
      if (usedB[index]) continue;
      const distance = Math.abs(position - sortedB[index]);
      if (distance <= tolerance && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      usedB[bestIndex] = true;
      pairs.push([position, sortedB[bestIndex]]);
    } else {
      onlyA.push(position);
    }
  }

  const onlyB = sortedB.filter((_, index) => !usedB[index]);
  return { pairs, onlyA, onlyB };
}

/** Übereinstimmung = 2 · Paare / (|A| + |B|). 1 bei völliger Einigkeit, 1 wenn beide leer sind. */
export function agreementF1({ pairs, onlyA, onlyB }) {
  const sizeA = pairs.length + onlyA.length;
  const sizeB = pairs.length + onlyB.length;
  const total = sizeA + sizeB;
  return total ? (2 * pairs.length) / total : 1;
}

/**
 * Cohens Kappa über alle n Zwischenräume des Fensters.
 * po = (Paare + keiner) / n
 * pe = pA·pB + (1−pA)·(1−pB)
 * κ  = (po − pe) / (1 − pe)
 */
export function cohensKappa({ pairs, onlyA, onlyB }, totalSeams) {
  const n = totalSeams;
  if (!n) return 1;
  const cutA = pairs.length + onlyA.length;
  const cutB = pairs.length + onlyB.length;
  const neither = n - pairs.length - onlyA.length - onlyB.length;
  const po = (pairs.length + neither) / n;
  const pA = cutA / n;
  const pB = cutB / n;
  const pe = pA * pB + (1 - pA) * (1 - pB);
  if (pe >= 1) return 1;
  return (po - pe) / (1 - pe);
}

/**
 * Wendet den doubt-Modus auf die Rohmarkierungen einer Person an und liefert
 * die Positionen, die als "Grenze" in die Paarung eingehen, sowie die
 * Positionen, die wegen doubt=skip komplett aus der Wertung genommen werden.
 */
export function resolveMarks(marks, doubtMode = 'skip') {
  const cuts = [];
  const excluded = [];
  for (const entry of marks) {
    if (entry.mark === 'cut') {
      cuts.push(entry.position);
    } else if (entry.mark === 'doubt') {
      if (doubtMode === 'cut') cuts.push(entry.position);
      else if (doubtMode === 'skip') excluded.push(entry.position);
      // doubtMode === 'none' -> weder Grenze noch ausgeschlossen
    }
  }
  return { cuts, excluded };
}

/**
 * Vergleicht die Markierungen zweier Prüfer für ein Fenster mit n
 * Zwischenräumen. doubt=skip nimmt Zwischenräume, die irgendjemand als
 * unsicher markiert hat, komplett aus n heraus.
 */
export function compareReviewers(marksA, marksB, { totalSeams, tolerance = 1, doubtMode = 'skip' }) {
  const resolvedA = resolveMarks(marksA, doubtMode);
  const resolvedB = resolveMarks(marksB, doubtMode);
  const excludedSet = new Set([...resolvedA.excluded, ...resolvedB.excluded]);
  const cutsA = resolvedA.cuts.filter((position) => !excludedSet.has(position));
  const cutsB = resolvedB.cuts.filter((position) => !excludedSet.has(position));
  const n = totalSeams - excludedSet.size;

  const pairing = pairSeams(cutsA, cutsB, tolerance);
  return {
    ...pairing,
    n,
    excluded: [...excludedSet],
    agreementF1: agreementF1(pairing),
    kappa: cohensKappa(pairing, n),
  };
}

/**
 * Gemeinsame Fassung: von beiden gesetzte Grenzen (Paare) gelten als Grenze,
 * nur einseitig gesetzte als unsicher. Maßstab für den Automatik-Vergleich.
 */
export function combinedBoundary({ pairs, onlyA, onlyB }) {
  return {
    cuts: pairs.map(([a, b]) => Math.round((a + b) / 2)),
    uncertain: [...onlyA, ...onlyB].sort((x, y) => x - y),
  };
}

/**
 * Formt die Antwort von GET /api/rounds/:round. Nimmt bewusst BEIDE
 * Markierungslisten und BEIDE Abgabezeiten entgegen (genau das, was der
 * Worker aus D1 laden könnte) und muss trotzdem garantieren, dass niemals
 * die Markierungen der jeweils anderen Person im Ergebnis landen — nur ob
 * sie abgegeben hat. Das ist die Blindheit als Servereigenschaft.
 */
export function buildRoundView({ reviewer, messages, philippMarks, lenaMarks, philippSubmittedAt, lenaSubmittedAt }) {
  const own = reviewer === 'Philipp' ? philippMarks : lenaMarks;
  const ownSubmittedAt = reviewer === 'Philipp' ? philippSubmittedAt : lenaSubmittedAt;
  const otherSubmittedAt = reviewer === 'Philipp' ? lenaSubmittedAt : philippSubmittedAt;
  return {
    ok: true,
    reviewer,
    messages,
    seams: Math.max(0, messages.length - 1),
    marks: own,
    submitted: Boolean(ownSubmittedAt),
    submittedAt: ownSubmittedAt || null,
    otherSubmitted: Boolean(otherSubmittedAt),
  };
}

/**
 * Entscheidet, ob GET .../agreement freigegeben werden darf. Liefert null,
 * wenn beide abgegeben haben (Vergleich darf berechnet werden), sonst das
 * Blockade-Objekt mit waitingFor — nie Markierungsdaten.
 */
export function agreementGate({ reviewer, philippSubmittedAt, lenaSubmittedAt }) {
  const missing = [];
  if (!philippSubmittedAt) missing.push('Philipp');
  if (!lenaSubmittedAt) missing.push('Lena');
  if (!missing.length) return null;
  return { waitingFor: missing.includes(reviewer) ? reviewer : missing[0] };
}
