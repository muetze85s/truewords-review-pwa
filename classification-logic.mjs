/**
 * Reine Rechenlogik der Klassifizierungsstufe: Situationsableitung aus der
 * gemeinsamen Grenzfassung, Cohens Kappa (2×2) je Musterklasse, die
 * „beide-müssen-zustimmen"-Auflösung für Klassifizierungs-Streitfälle.
 *
 * Kein Toleranzabgleich (anders als bei den Grenzen): jede (Situation, Klasse)
 * ist ein klares Ja/Nein zwischen exakt zwei Prüfern. Keine D1-/DOM-/Fetch-
 * Aufrufe — direkt mit `node` testbar (tests/classification-logic.test.mjs) und
 * vom Worker wie von der Seite importierbar.
 */

/**
 * Leitet aus den Grenzpositionen (combinedBoundary.cuts, als Positionen im
 * Nachrichtenfenster) die Situationen ab: zusammenhängende Nachrichtenspannen
 * zwischen zwei aufeinanderfolgenden Grenzen.
 *
 * Eine Grenzposition p bedeutet: die Grenze liegt VOR der Nachricht mit Index p
 * (Nachricht p beginnt eine neue Situation) — exakt die Konvention aus
 * seamPositions()/combinedBoundary im Grenzen-Worker. Positionen ≤ 0 oder ≥ N
 * sind bedeutungslos und werden verworfen.
 *
 * @param {string[]} messageIds  IDs in Reihenfolge des Fensters.
 * @param {number[]} cutPositions  Grenzpositionen (0-basierte Indizes).
 * @returns Array von Situationen mit stabilem situationIndex (0-basiert, nach
 *          Position), Start-/End-Nachricht (inklusive) und Nachrichtenzahl.
 */
export function deriveSituations(messageIds, cutPositions) {
  const n = messageIds.length;
  if (n === 0) return [];
  const cuts = [...new Set(cutPositions)]
    .filter((position) => Number.isInteger(position) && position > 0 && position < n)
    .sort((a, b) => a - b);
  const boundaries = [0, ...cuts, n];
  const situations = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1]; // exklusiv
    if (end <= start) continue;
    situations.push({
      situationIndex: index,
      startPos: start,
      endPos: end - 1, // inklusiv
      startMessageId: messageIds[start],
      endMessageId: messageIds[end - 1],
      messageCount: end - start,
    });
  }
  return situations;
}

/**
 * Cohens Kappa für ein 2×2-Ja/Nein zwischen zwei Prüfern über n Situationen.
 * pairs: Array von [a, b] mit a,b truthy = „ja/present".
 *
 *   po = (beide ja + beide nein) / n
 *   pe = pA·pB + (1−pA)·(1−pB)   (pA/pB = Ja-Randanteile der beiden Prüfer)
 *   κ  = (po − pe) / (1 − pe)
 *
 * Bei fehlender Varianz (pe ≥ 1 — z. B. beide markieren nie) ist κ nicht
 * definiert; wie im Grenzen-Modul geben wir dann 1 zurück und melden über
 * `degenerate: true`, damit die Anzeige das nicht als echte Übereinstimmung
 * fehldeutet. Bei n = 0 ist alles null.
 */
export function cohenKappaBinary(pairs) {
  const n = pairs.length;
  if (n === 0) {
    return { n: 0, agreement: null, kappa: null, degenerate: true, n11: 0, n10: 0, n01: 0, n00: 0, aPositives: 0, bPositives: 0 };
  }
  let n11 = 0;
  let n10 = 0;
  let n01 = 0;
  let n00 = 0;
  for (const [a, b] of pairs) {
    const av = a ? 1 : 0;
    const bv = b ? 1 : 0;
    if (av && bv) n11 += 1;
    else if (av && !bv) n10 += 1;
    else if (!av && bv) n01 += 1;
    else n00 += 1;
  }
  const po = (n11 + n00) / n;
  const pA = (n11 + n10) / n;
  const pB = (n11 + n01) / n;
  const pe = pA * pB + (1 - pA) * (1 - pB);
  // Punkt 3b: pe >= 1 heißt beide Prüfer sind konstant UND gleich (beide immer
  // „nein" = Klasse kommt nie vor, oder beide immer „ja"). Kappa ist dann 0/0,
  // also unbestimmt → n/a (null), NICHT 1. So verschwindet die Klasse aus den
  // Ampeln/Aggregaten, statt eine Scheingenauigkeit von κ=1 vorzutäuschen.
  // (Nur EIN Prüfer konstant, der andere mit Varianz, ist ein echter Wert —
  // meist κ=0 — und bleibt erhalten.)
  const kappa = pe >= 1 ? null : (po - pe) / (1 - pe);
  // Keine Varianz bei mindestens einem Prüfer → Kappa ohne Aussagekraft.
  const degenerate = pA === 0 || pA === 1 || pB === 0 || pB === 1;
  return { n, agreement: po, kappa, degenerate, n11, n10, n01, n00, aPositives: n11 + n10, bPositives: n11 + n01 };
}

/** Ampel nach Prüfprotokoll-Schwellen: < 0,60 rot, 0,60–0,80 gelb, > 0,80 grün. */
export function kappaAmpel(kappa) {
  if (kappa === null || kappa === undefined || Number.isNaN(kappa)) return 'none';
  if (kappa < 0.60) return 'red';
  if (kappa <= 0.80) return 'yellow';
  return 'green';
}

/** Ab wie vielen Situationen gilt Kappa als belastbar (sonst „noch nicht belastbar"). */
export const MIN_RELIABLE_SITUATIONS = 20;

export function isReliable(n, minReliable = MIN_RELIABLE_SITUATIONS) {
  return n >= minReliable;
}

/**
 * Indexiert Mark-Zeilen ({ situation_id, pattern_key/flag_key, present }) auf
 * `${situation_id}|${key}` → present (0/1). Berücksichtigt nur Situationen aus
 * idSet. Doppelte Zeilen: die letzte gewinnt (sollte durch UNIQUE nie auftreten).
 */
function indexMarks(rows, idSet, keyField) {
  const map = new Map();
  for (const row of rows || []) {
    const sid = Number(row.situation_id);
    if (idSet && !idSet.has(sid)) continue;
    const key = row[keyField];
    map.set(`${sid}|${key}`, row.present ? 1 : 0);
  }
  return map;
}

/**
 * Kernauswertung: je Klasse ein Kappa/Übereinstimmung/Ampel-Ergebnis über die
 * Situationen, die BEIDE Prüfer abgegeben haben (situationIds). Fehlt zu einer
 * abgegebenen Situation eine Zeile für eine Klasse, gilt sie als „nein" (0) —
 * beim Abgeben werden ohnehin alle Klassen geschrieben, das ist nur die
 * defensive Vorgabe.
 *
 * Liefert je Klasse aus `keys` ein Objekt mit key, n, agreementPercent (0..1),
 * kappa, degenerate, reliable, ampel und den Ja-Zählungen beider Prüfer.
 * Ist situationIds leer (z. B. Lena noch nicht freigeschaltet → keine
 * gemeinsamen Abgaben), stehen n = 0 und kappa = null — „noch keine
 * Vergleichsdaten", kein Fehler, kein Nullwert.
 */
export function agreementByKey({ situationIds, marksA, marksB, keys, keyField = 'pattern_key', minReliable = MIN_RELIABLE_SITUATIONS }) {
  const ids = (situationIds || []).map(Number);
  const idSet = new Set(ids);
  const aMap = indexMarks(marksA, idSet, keyField);
  const bMap = indexMarks(marksB, idSet, keyField);
  return keys.map((key) => {
    const pairs = ids.map((sid) => [aMap.get(`${sid}|${key}`) ?? 0, bMap.get(`${sid}|${key}`) ?? 0]);
    const stat = cohenKappaBinary(pairs);
    const reliable = isReliable(stat.n, minReliable);
    return {
      key,
      n: stat.n,
      agreementPercent: stat.agreement,
      kappa: stat.kappa,
      degenerate: stat.degenerate,
      reliable,
      // „insufficient" = zu wenige Situationen für eine belastbare Aussage.
      ampel: reliable ? kappaAmpel(stat.kappa) : 'insufficient',
      aPositives: stat.aPositives,
      bPositives: stat.bPositives,
    };
  });
}

/**
 * Beide-müssen-zustimmen für Klassifizierungs-Streitfälle — strukturell wie
 * agreeResolutions() bei den Grenzen, aber je (Situation, Klasse) statt je Naht
 * und mit einem binären present statt cut/no_cut/open.
 *
 * Erwartet Zeilen { situation_id, pattern_key (oder flag_key), decided_by,
 * resolved_present }. Geklärt gilt nur, wenn BEIDE Prüfer denselben
 * resolved_present (0 oder 1) gesetzt haben. Liefert je (Situation, Klasse)
 * { situation_id, key, resolved, resolvedPresent, philipp, lena }.
 */
export function agreeClassificationResolutions(rows, keyField = 'pattern_key') {
  const byPair = new Map();
  for (const row of rows || []) {
    if (row.decided_by !== 'Philipp' && row.decided_by !== 'Lena') continue;
    const sid = Number(row.situation_id);
    const key = row[keyField];
    const mapKey = `${sid}|${key}`;
    if (!byPair.has(mapKey)) byPair.set(mapKey, { situation_id: sid, key, Philipp: null, Lena: null });
    byPair.get(mapKey)[row.decided_by] = row.resolved_present ? 1 : 0;
  }
  const out = [];
  for (const entry of byPair.values()) {
    const philipp = entry.Philipp;
    const lena = entry.Lena;
    const agreed = philipp !== null && lena !== null && philipp === lena;
    out.push({
      situation_id: entry.situation_id,
      key: entry.key,
      resolved: agreed,
      resolvedPresent: agreed ? philipp : null,
      philipp,
      lena,
    });
  }
  return out;
}

/**
 * Krippendorffs Alpha (nominal, binär) über beliebig viele Kodierer — das für
 * >2 Kodierer vorgesehene Maß (Prüfprotokoll), sobald der LLM als dritter Rater
 * dazukommt. `units` ist je Situation ein Array der Ratings (0/1; fehlende Rater
 * als null/undefined). Einheiten mit weniger als zwei vorhandenen Ratings zählen
 * nicht.
 *
 *   α = 1 − D_o / D_e,   D_o = (o01+o10)/n,   D_e = 2·n0·n1 / (n·(n−1))
 *
 * Ohne Varianz (alle gleich, z. B. Klasse kommt nie vor) ist α 0/0 und damit
 * nicht definiert → n/a (null), degenerate=true. (Punkt-3b-konsistent zur
 * Kappa-Behandlung: keine Scheingenauigkeit von α=1 für eine nie auftretende
 * Klasse.)
 */
export function krippendorffAlphaBinary(units) {
  const o = [[0, 0], [0, 0]];
  let n = 0;
  for (const unit of units || []) {
    const values = (unit || []).filter((value) => value === 0 || value === 1);
    const m = values.length;
    if (m < 2) continue;
    for (let i = 0; i < m; i += 1) {
      for (let j = 0; j < m; j += 1) {
        if (i === j) continue;
        o[values[i]][values[j]] += 1 / (m - 1);
      }
    }
    n += m;
  }
  if (n < 2) return { alpha: null, n, degenerate: true };
  const n0 = o[0][0] + o[0][1];
  const n1 = o[1][0] + o[1][1];
  const observedDisagreement = o[0][1] + o[1][0]; // = Do·n
  if (n0 === 0 || n1 === 0) return { alpha: null, n, degenerate: true };
  const expectedDisagreement = (2 * n0 * n1) / (n - 1); // = De·n
  if (expectedDisagreement === 0) return { alpha: null, n, degenerate: true };
  return { alpha: 1 - observedDisagreement / expectedDisagreement, n, degenerate: false };
}

/**
 * Selbstimplikations-Auswertung: je Klasse getrennt Kappa berechnen für die
 * Situationen, in denen Philipp der wahrscheinliche Träger des Musters ist,
 * versus die, in denen Lena es ist. Ein deutlicher Abfall bei genau einer
 * Trägerschaft ist der objektive Bias-Beleg (Handoff 8.2).
 *
 * @param {{ situations: Array<{id:number|string, bearer:'Philipp'|'Lena'|null}>,
 *           marksP: MarkRowLike[], marksL: MarkRowLike[], keys: string[], keyField?: string }} input
 */
export function selfImplicationSplit({ situations, marksP, marksL, keys, keyField = 'pattern_key' }) {
  const philippIds = (situations || []).filter((s) => s.bearer === 'Philipp').map((s) => Number(s.id));
  const lenaIds = (situations || []).filter((s) => s.bearer === 'Lena').map((s) => Number(s.id));
  const byPhilipp = agreementByKey({ situationIds: philippIds, marksA: marksP, marksB: marksL, keys, keyField });
  const byLena = agreementByKey({ situationIds: lenaIds, marksA: marksP, marksB: marksL, keys, keyField });
  const lenaMap = new Map(byLena.map((entry) => [entry.key, entry]));
  return byPhilipp.map((p) => {
    const l = lenaMap.get(p.key);
    const pk = p.kappa;
    const lk = l ? l.kappa : null;
    return {
      key: p.key,
      philippBearer: { n: p.n, kappa: pk },
      lenaBearer: { n: l ? l.n : 0, kappa: lk },
      // Betrag des Abfalls, falls beide belastbar (informativ, kein Automatismus).
      gap: (pk === null || lk === null) ? null : Math.abs(pk - lk),
    };
  });
}

/**
 * Freigabe-Entscheidung je Klasse für den automatischen Dauerbetrieb:
 * Kappa Mensch-Mensch ≥ hhMin UND Kappa Mensch-LLM ≥ hlMin (Handoff 3, Punkt 3).
 * Rein rechnerisch — die tatsächliche Freischaltung setzt der Betreiber.
 */
export function autoEnableDecision(kappaHH, kappaHL, { hhMin = 0.60, hlMin = 0.60 } = {}) {
  const hhOk = typeof kappaHH === 'number' && kappaHH >= hhMin;
  const hlOk = typeof kappaHL === 'number' && kappaHL >= hlMin;
  return {
    eligible: hhOk && hlOk,
    humanHumanOk: hhOk,
    humanLlmOk: hlOk,
    hhMin,
    hlMin,
  };
}

/**
 * Findet die Streitfälle einer Situation: Klassen, bei denen sich die beiden
 * abgegebenen Markierungen unterscheiden, mit ihrem Klärungsstand aus den
 * Auflösungen. Reine Verrechnung — der Worker liefert die Rohdaten.
 *
 * @returns je abweichender Klasse { key, philipp, lena, resolved, resolvedPresent }.
 */
export function disputesForSituation({ situationId, marksA, marksB, resolutions, keys, keyField = 'pattern_key' }) {
  const idSet = new Set([Number(situationId)]);
  const aMap = indexMarks(marksA, idSet, keyField);
  const bMap = indexMarks(marksB, idSet, keyField);
  const agreed = new Map(
    agreeClassificationResolutions(resolutions, keyField)
      .filter((entry) => entry.situation_id === Number(situationId))
      .map((entry) => [entry.key, entry]),
  );
  const disputes = [];
  for (const key of keys) {
    const a = aMap.get(`${Number(situationId)}|${key}`) ?? 0;
    const b = bMap.get(`${Number(situationId)}|${key}`) ?? 0;
    if (a === b) continue;
    const resolution = agreed.get(key) || null;
    disputes.push({
      key,
      philipp: a,
      lena: b,
      resolved: resolution ? resolution.resolved : false,
      resolvedPresent: resolution ? resolution.resolvedPresent : null,
      votes: {
        philipp: resolution ? resolution.philipp : null,
        lena: resolution ? resolution.lena : null,
      },
    });
  }
  return disputes;
}
