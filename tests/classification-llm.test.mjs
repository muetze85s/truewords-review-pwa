import assert from 'node:assert/strict';
import {
  anonymizeSituation,
  buildClassificationPrompt,
  parseClassificationJson,
} from '../classification-llm.mjs';
import {
  krippendorffAlphaBinary,
  selfImplicationSplit,
  autoEnableDecision,
  cohenKappaBinary,
} from '../classification-logic.mjs';

// --- Anonymisierung ------------------------------------------------------

{
  const messages = [
    { from: 'Philipp', text: 'Hallo Lena, du hast nicht angerufen.', kind: 'text', t: 1700000000 },
    { from: 'Lena', text: 'Philipp, ich war beschäftigt.', kind: 'text', t: 1700000300 },
    { from: 'Philipp', text: '', kind: 'anruf', t: 1700000600 },
  ];
  const { text, labelCount } = anonymizeSituation(messages);
  assert.equal(labelCount, 2, 'zwei Absender → zwei Labels');
  assert.ok(text.includes('Person A:'), 'erster Absender ist Person A');
  assert.ok(text.includes('Person B:'), 'zweiter Absender ist Person B');
  assert.ok(!/Philipp/u.test(text), 'kein Klarname Philipp im Ergebnis (auch im Text ersetzt)');
  assert.ok(!/Lena/u.test(text), 'kein Klarname Lena im Ergebnis');
  assert.ok(!/1700000000/u.test(text), 'keine Zeitstempel');
  assert.ok(text.includes('[Anruf]'), 'Anruf als Platzhalter');
}

{
  // Reihenfolge bestimmt das Label, nicht die Identität: startet Lena, ist sie Person A.
  const { text } = anonymizeSituation([
    { from: 'Lena', text: 'Fang ich an.', kind: 'text' },
    { from: 'Philipp', text: 'Ok.', kind: 'text' },
  ]);
  assert.ok(text.startsWith('Person A: Fang ich an.'), 'erster Absender (Lena) = Person A');
}

// --- Prompt-Bau ----------------------------------------------------------

{
  const { system, user } = buildClassificationPrompt({
    situationText: 'Person A: X\nPerson B: Y',
    codebookSection: '### whataboutism_candidate\nDefinition ...',
    keys: ['whataboutism_candidate', 'topic_shift'],
  });
  assert.ok(system.includes('whataboutism_candidate'), 'Keys stehen im System-Prompt');
  assert.ok(system.includes('Definition ...'), 'Kodierhandbuch-Abschnitt eingebettet');
  assert.ok(/JSON/u.test(system), 'JSON-Format verlangt');
  assert.ok(user.includes('Person A: X'), 'Situation im User-Prompt');
}

// --- JSON-Parsen ---------------------------------------------------------

const KEYS = ['whataboutism_candidate', 'topic_shift', 'repair_offer'];

{
  const r = parseClassificationJson('{"whataboutism_candidate": true, "topic_shift": false, "repair_offer": true}', KEYS);
  assert.deepEqual(r.classes, { whataboutism_candidate: 1, topic_shift: 0, repair_offer: 1 });
}

{
  // Markdown-Fences + Prosa drumherum werden gestrippt.
  const r = parseClassificationJson('```json\n{"topic_shift": true}\n```', KEYS);
  assert.equal(r.classes.topic_shift, 1);
  assert.equal(r.classes.whataboutism_candidate, 0, 'fehlender Schlüssel → 0');
}

{
  // Kaputtes JSON → null (Fehlschlag, NICHT „alles false").
  assert.equal(parseClassificationJson('total kaputt, kein json', KEYS), null);
  assert.equal(parseClassificationJson('', KEYS), null);
  // Objekt ohne einen einzigen erwarteten Schlüssel → null.
  assert.equal(parseClassificationJson('{"irgendwas": true}', KEYS), null);
}

// --- Krippendorffs Alpha -------------------------------------------------

{
  // Drei Rater, perfekte Übereinstimmung mit Varianz → α = 1.
  const a = krippendorffAlphaBinary([[1, 1, 1], [0, 0, 0], [1, 1, 1], [0, 0, 0]]);
  assert.equal(a.alpha, 1);
  assert.equal(a.degenerate, false);
}

{
  // Keine Varianz (alle 0, Klasse kommt nie vor) → 0/0, α n/a (null).
  const a = krippendorffAlphaBinary([[0, 0, 0], [0, 0]]);
  assert.equal(a.degenerate, true);
  assert.equal(a.alpha, null, 'Punkt 3b: α ist n/a (null), nicht 1');
}

{
  // Bekannter Wert: zwei Units, ein Rater weicht ab. Gegen cohenKappa (2 Rater)
  // ist Alpha nicht identisch, aber es muss zwischen -1 und 1 liegen und sinken,
  // wenn Uneinigkeit steigt.
  const agree = krippendorffAlphaBinary([[1, 1], [0, 0], [1, 1], [0, 0]]);
  const disagree = krippendorffAlphaBinary([[1, 0], [0, 1], [1, 1], [0, 0]]);
  assert.ok(agree.alpha > disagree.alpha, 'mehr Uneinigkeit → kleineres Alpha');
  assert.ok(disagree.alpha <= 1 && disagree.alpha >= -1);
}

{
  // Einheiten mit nur einem vorhandenen Rating fallen raus.
  const a = krippendorffAlphaBinary([[1], [1, 1], [0, 0]]);
  assert.equal(a.n, 4, 'nur die zwei paarbaren Units zählen (2+2 Ratings)');
}

// --- Selbstimplikations-Split -------------------------------------------

{
  const situations = [
    { id: 1, bearer: 'Philipp' },
    { id: 2, bearer: 'Philipp' },
    { id: 3, bearer: 'Lena' },
    { id: 4, bearer: 'Lena' },
  ];
  // Bei Philipp-Trägerschaft sind sie uneinig, bei Lena-Trägerschaft einig.
  const marksP = [
    { situation_id: 1, pattern_key: 'responsibility_shift', present: 1 },
    { situation_id: 2, pattern_key: 'responsibility_shift', present: 1 },
    { situation_id: 3, pattern_key: 'responsibility_shift', present: 1 },
    { situation_id: 4, pattern_key: 'responsibility_shift', present: 0 },
  ];
  const marksL = [
    { situation_id: 1, pattern_key: 'responsibility_shift', present: 0 },
    { situation_id: 2, pattern_key: 'responsibility_shift', present: 0 },
    { situation_id: 3, pattern_key: 'responsibility_shift', present: 1 },
    { situation_id: 4, pattern_key: 'responsibility_shift', present: 0 },
  ];
  const split = selfImplicationSplit({ situations, marksP, marksL, keys: ['responsibility_shift'] });
  const entry = split[0];
  assert.equal(entry.philippBearer.n, 2);
  assert.equal(entry.lenaBearer.n, 2);
  // Bei Lena-Trägerschaft stimmen sie überein (beide 1 / beide 0), bei Philipp nicht.
  assert.equal(entry.lenaBearer.kappa, 1);
  assert.ok(entry.philippBearer.kappa < entry.lenaBearer.kappa, 'Abfall bei Philipp-Trägerschaft');
}

// --- Auto-Freigabe -------------------------------------------------------

{
  assert.equal(autoEnableDecision(0.7, 0.65).eligible, true);
  assert.equal(autoEnableDecision(0.55, 0.9).eligible, false, 'HH unter Schwelle');
  assert.equal(autoEnableDecision(0.9, 0.5).eligible, false, 'HL unter Schwelle');
  assert.equal(autoEnableDecision(null, 0.9).eligible, false, 'kein HH-Wert');
  assert.equal(autoEnableDecision(0.67, 0.6, { hhMin: 0.67 }).eligible, true, 'exakt an der Schwelle');
}

// sanity: cohenKappaBinary noch importierbar (Regressionsschutz)
assert.equal(typeof cohenKappaBinary, 'function');

console.log('classification-llm tests: PASS');
