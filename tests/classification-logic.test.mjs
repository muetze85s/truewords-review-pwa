import assert from 'node:assert/strict';
import {
  deriveSituations,
  cohenKappaBinary,
  kappaAmpel,
  isReliable,
  agreementByKey,
  agreeClassificationResolutions,
  disputesForSituation,
} from '../classification-logic.mjs';
import { CLASSIFICATION_KEYS, isValidPatternKey, SELF_IMPLICATING_KEYS } from '../classification-classes.mjs';
import { QUALITY_FLAG_KEYS, isValidQualityFlag } from '../quality-flags.mjs';

// --- Situationsableitung -------------------------------------------------

{
  const ids = ['a', 'b', 'c', 'd', 'e'];
  // Grenze vor Index 2 (c) und vor Index 4 (e) → 3 Situationen: [a,b] [c,d] [e]
  const situations = deriveSituations(ids, [2, 4]);
  assert.equal(situations.length, 3, 'zwei Grenzen ergeben drei Situationen');
  assert.deepEqual(
    situations.map((s) => [s.startMessageId, s.endMessageId]),
    [['a', 'b'], ['c', 'd'], ['e', 'e']],
    'Spannen liegen inklusive zwischen den Grenzen',
  );
  assert.deepEqual(situations.map((s) => s.situationIndex), [0, 1, 2], 'stabiler 0-basierter Index nach Position');
  assert.equal(situations[0].messageCount, 2);
  assert.equal(situations[2].messageCount, 1);
}

{
  // Keine Grenze → eine Situation über das ganze Fenster.
  const situations = deriveSituations(['x', 'y', 'z'], []);
  assert.equal(situations.length, 1);
  assert.equal(situations[0].startMessageId, 'x');
  assert.equal(situations[0].endMessageId, 'z');
}

{
  // Grenzen an Rand (0, N) und Duplikate werden verworfen.
  const situations = deriveSituations(['x', 'y', 'z'], [0, 1, 1, 3, 99]);
  assert.equal(situations.length, 2, 'nur die innere Grenze bei 1 zählt');
  assert.deepEqual(situations.map((s) => s.startMessageId), ['x', 'y']);
}

{
  assert.deepEqual(deriveSituations([], [1, 2]), [], 'leeres Fenster → keine Situationen');
}

// --- Cohens Kappa (2×2) --------------------------------------------------

{
  // Perfekte Übereinstimmung mit Varianz → Kappa 1.
  const stat = cohenKappaBinary([[1, 1], [0, 0], [1, 1], [0, 0]]);
  assert.equal(stat.n, 4);
  assert.equal(stat.agreement, 1);
  assert.equal(stat.kappa, 1);
  assert.equal(stat.degenerate, false);
}

{
  // Beide sagen immer „nein" (Klasse kommt nie vor) → 0/0, Kappa n/a.
  const stat = cohenKappaBinary([[0, 0], [0, 0], [0, 0]]);
  assert.equal(stat.agreement, 1, 'roh stimmen sie überein');
  assert.equal(stat.degenerate, true, 'aber ohne Varianz als degeneriert markiert');
  assert.equal(stat.kappa, null, 'Punkt 3b: κ ist n/a (null), nicht 1');
}

{
  // Beide sagen immer „ja" → ebenfalls 0/0, Kappa n/a.
  const stat = cohenKappaBinary([[1, 1], [1, 1]]);
  assert.equal(stat.kappa, null, 'Punkt 3b: konstant-gleich → κ n/a');
  assert.equal(stat.degenerate, true);
}

{
  // Nur EIN Prüfer konstant (A nie, B mit Varianz) → echter Wert (κ=0), bleibt.
  const stat = cohenKappaBinary([[0, 1], [0, 0], [0, 1], [0, 0]]);
  assert.ok(stat.kappa !== null, 'gemischt ist kein 0/0');
  assert.ok(Math.abs(stat.kappa - 0) < 1e-9, 'A nie, B halb → κ=0');
}

{
  // Reiner Zufall: pe = 0.5, po = 0.5 → Kappa 0.
  const stat = cohenKappaBinary([[1, 1], [1, 0], [0, 1], [0, 0]]);
  assert.equal(stat.agreement, 0.5);
  assert.ok(Math.abs(stat.kappa - 0) < 1e-9, 'Kappa 0 bei Zufallsniveau');
}

{
  // Bekanntes Lehrbuchbeispiel: n=10, n11=4, n00=3, n10=2, n01=1.
  // po=0.7, pA=0.6, pB=0.5, pe=0.6*0.5+0.4*0.5=0.5, kappa=(0.7-0.5)/0.5=0.4
  const pairs = [
    ...Array(4).fill([1, 1]),
    ...Array(3).fill([0, 0]),
    ...Array(2).fill([1, 0]),
    ...Array(1).fill([0, 1]),
  ];
  const stat = cohenKappaBinary(pairs);
  assert.ok(Math.abs(stat.kappa - 0.4) < 1e-9, `erwartet 0.4, war ${stat.kappa}`);
  assert.equal(stat.aPositives, 6);
  assert.equal(stat.bPositives, 5);
}

{
  const empty = cohenKappaBinary([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.kappa, null);
  assert.equal(empty.agreement, null);
}

// --- Ampel + Belastbarkeit ----------------------------------------------

{
  assert.equal(kappaAmpel(0.59), 'red');
  assert.equal(kappaAmpel(0.60), 'yellow', 'Grenze 0,60 gehört zu gelb');
  assert.equal(kappaAmpel(0.80), 'yellow', 'Grenze 0,80 gehört zu gelb');
  assert.equal(kappaAmpel(0.81), 'green');
  assert.equal(kappaAmpel(null), 'none');
  assert.equal(isReliable(19), false);
  assert.equal(isReliable(20), true);
}

// --- agreementByKey ------------------------------------------------------

{
  const keys = ['whataboutism_candidate', 'repair_offer'];
  const marksA = [
    { situation_id: 1, pattern_key: 'whataboutism_candidate', present: 1 },
    { situation_id: 2, pattern_key: 'whataboutism_candidate', present: 0 },
    { situation_id: 1, pattern_key: 'repair_offer', present: 1 },
    { situation_id: 2, pattern_key: 'repair_offer', present: 1 },
  ];
  const marksB = [
    { situation_id: 1, pattern_key: 'whataboutism_candidate', present: 1 },
    { situation_id: 2, pattern_key: 'whataboutism_candidate', present: 0 },
    { situation_id: 1, pattern_key: 'repair_offer', present: 0 },
    { situation_id: 2, pattern_key: 'repair_offer', present: 1 },
  ];
  const result = agreementByKey({ situationIds: [1, 2], marksA, marksB, keys });
  const wa = result.find((r) => r.key === 'whataboutism_candidate');
  assert.equal(wa.n, 2);
  assert.equal(wa.agreementPercent, 1, 'beide einig bei whataboutism');
  const repair = result.find((r) => r.key === 'repair_offer');
  assert.equal(repair.agreementPercent, 0.5, 'eine Abweichung bei repair_offer');
  // Wenige Situationen → als nicht belastbar markiert.
  assert.equal(wa.reliable, false);
  assert.equal(wa.ampel, 'insufficient');
}

{
  // Keine gemeinsamen Abgaben (z. B. Lena nicht freigeschaltet) → n=0, kein Fehler.
  const result = agreementByKey({ situationIds: [], marksA: [], marksB: [], keys: ['topic_shift'] });
  assert.equal(result[0].n, 0);
  assert.equal(result[0].kappa, null);
  assert.equal(result[0].ampel, 'insufficient');
}

// --- Beide-müssen-zustimmen (Auflösung) ----------------------------------

{
  // Beide setzen present=1 → geklärt.
  const agreed = agreeClassificationResolutions([
    { situation_id: 5, pattern_key: 'topic_shift', decided_by: 'Philipp', resolved_present: 1 },
    { situation_id: 5, pattern_key: 'topic_shift', decided_by: 'Lena', resolved_present: 1 },
  ]);
  assert.equal(agreed.length, 1);
  assert.equal(agreed[0].resolved, true);
  assert.equal(agreed[0].resolvedPresent, 1);
}

{
  // Nur einer hat abgestimmt → offen.
  const agreed = agreeClassificationResolutions([
    { situation_id: 5, pattern_key: 'topic_shift', decided_by: 'Philipp', resolved_present: 1 },
  ]);
  assert.equal(agreed[0].resolved, false);
  assert.equal(agreed[0].resolvedPresent, null);
  assert.equal(agreed[0].philipp, 1);
  assert.equal(agreed[0].lena, null);
}

{
  // Uneinig → offen.
  const agreed = agreeClassificationResolutions([
    { situation_id: 6, pattern_key: 'topic_shift', decided_by: 'Philipp', resolved_present: 1 },
    { situation_id: 6, pattern_key: 'topic_shift', decided_by: 'Lena', resolved_present: 0 },
  ]);
  assert.equal(agreed[0].resolved, false);
}

// --- Streitfälle einer Situation ----------------------------------------

{
  const marksA = [
    { situation_id: 7, pattern_key: 'topic_shift', present: 1 },
    { situation_id: 7, pattern_key: 'repair_offer', present: 1 },
  ];
  const marksB = [
    { situation_id: 7, pattern_key: 'topic_shift', present: 0 },
    { situation_id: 7, pattern_key: 'repair_offer', present: 1 },
  ];
  const disputes = disputesForSituation({
    situationId: 7,
    marksA,
    marksB,
    resolutions: [],
    keys: ['topic_shift', 'repair_offer'],
  });
  assert.equal(disputes.length, 1, 'nur topic_shift weicht ab');
  assert.equal(disputes[0].key, 'topic_shift');
  assert.equal(disputes[0].philipp, 1);
  assert.equal(disputes[0].lena, 0);
  assert.equal(disputes[0].resolved, false);
}

// --- Konsistenz der Klassen-Konstanten -----------------------------------

{
  assert.equal(CLASSIFICATION_KEYS.length, 20, 'genau 20 Inhaltsklassen');
  assert.equal(new Set(CLASSIFICATION_KEYS).size, 20, 'keine doppelten Keys');
  assert.equal(QUALITY_FLAG_KEYS.length, 3, 'genau 3 Zuschnitt-Flags');
  assert.ok(isValidPatternKey('whataboutism_candidate'));
  assert.ok(!isValidPatternKey('not_a_real_situation'), 'Zuschnitt-Flag ist keine Inhaltsklasse');
  assert.ok(isValidQualityFlag('incomplete'));
  assert.ok(SELF_IMPLICATING_KEYS.includes('responsibility_shift'));
  assert.ok(!SELF_IMPLICATING_KEYS.includes('repair_offer'));
}

console.log('classification-logic tests: PASS');
