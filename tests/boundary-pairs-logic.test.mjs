import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  hashSeed,
  pickRoundStart,
  pairSeams,
  agreementF1,
  cohensKappa,
  resolveMarks,
  compareReviewers,
  combinedBoundary,
  buildRoundView,
  agreementGate,
  toSegmentationInput,
  toPositionalResolutions,
} from '../boundary-pairs-logic.mjs';
import { segmentConversationWindow } from '../segmentation-v4.mjs';

// --- Paarung mit Toleranz -----------------------------------------------

{
  const { pairs, onlyA, onlyB } = pairSeams([10], [10], 1);
  assert.equal(pairs.length, 1, 'identische Positionen müssen sich paaren');
  assert.equal(onlyA.length, 0);
  assert.equal(onlyB.length, 0);
}

{
  // Eine Grenze aus A liegt zwischen zwei nahen Kandidaten aus B — darf nur
  // mit einem gepaart werden, der andere bleibt übrig.
  const { pairs, onlyB } = pairSeams([10], [9, 11], 1);
  assert.equal(pairs.length, 1, 'a=10 darf nur einen der beiden Kandidaten binden');
  assert.equal(onlyB.length, 1, 'der zweite Kandidat aus B bleibt unpaarig');
}

{
  // Zwei Grenzen aus A konkurrieren um denselben Kandidaten aus B.
  const { pairs, onlyA } = pairSeams([10, 12], [11], 1);
  assert.equal(pairs.length, 1, 'b=11 darf nur einmal vergeben werden');
  assert.equal(onlyA.length, 1, 'die zweite Grenze aus A bleibt ohne Partner');
}

{
  const { pairs, onlyA, onlyB } = pairSeams([5, 20], [5, 21, 40], 1);
  assert.equal(pairs.length, 2);
  assert.deepEqual(onlyA, []);
  assert.deepEqual(onlyB, [40]);
}

{
  const pairing = pairSeams([], [], 1);
  assert.equal(agreementF1(pairing), 1, 'zwei leere Markierungen gelten als völlig einig');
}

// --- Cohens Kappa ---------------------------------------------------------

{
  // Identische Markierung über alle 10 Zwischenräume: kappa muss 1 sein.
  const pairing = pairSeams([2, 5, 8], [2, 5, 8], 1);
  assert.equal(cohensKappa(pairing, 10), 1);
}

{
  // Keine Übereinstimmung über Zufall hinaus -> kappa nahe 0 oder darunter,
  // jedenfalls klar kleiner als bei identischer Markierung.
  const pairing = pairSeams([1, 2, 3], [7, 8, 9], 0);
  const kappa = cohensKappa(pairing, 10);
  assert.ok(kappa < 0.5, `kappa sollte bei Uneinigkeit klein sein, war ${kappa}`);
}

// --- doubt-Modus -----------------------------------------------------------

{
  const marks = [
    { position: 5, mark: 'cut' },
    { position: 9, mark: 'doubt' },
  ];
  assert.deepEqual(resolveMarks(marks, 'skip'), { cuts: [5], excluded: [9] });
  assert.deepEqual(resolveMarks(marks, 'cut'), { cuts: [5, 9], excluded: [] });
  assert.deepEqual(resolveMarks(marks, 'none'), { cuts: [5], excluded: [] });
}

{
  const marksA = [{ position: 5, mark: 'cut' }, { position: 9, mark: 'doubt' }];
  const marksB = [{ position: 5, mark: 'cut' }, { position: 9, mark: 'cut' }];
  const result = compareReviewers(marksA, marksB, { totalSeams: 20, tolerance: 1, doubtMode: 'skip' });
  assert.equal(result.n, 19, 'ein doubt-markierter Zwischenraum wird aus n herausgenommen');
  assert.equal(result.pairs.length, 1);
}

// --- gemeinsame Fassung -----------------------------------------------------

{
  const pairing = pairSeams([10, 30], [11, 50], 1);
  const combined = combinedBoundary(pairing);
  assert.deepEqual(combined.cuts, [11], 'Paar (10,11) rundet auf die gemeinsame Position 11');
  assert.deepEqual(combined.uncertain, [30, 50]);
}

// --- geklärte Streitfälle fließen in die gemeinsame Fassung ein -------------

{
  // Ohne Auflösungen unverändertes Verhalten.
  const pairing = pairSeams([10, 30], [11, 50], 1);
  assert.deepEqual(combinedBoundary(pairing).cuts, [11]);
  assert.deepEqual(combinedBoundary(pairing).uncertain, [30, 50]);
}

{
  // Ein als 'cut' geklärter Streitfall muss in der gemeinsamen Fassung als
  // Grenze geführt werden — sonst bliebe die Klärungsarbeit wirkungslos.
  const pairing = pairSeams([10, 30], [11, 50], 1);
  const combined = combinedBoundary(pairing, [{ position: 30, decision: 'cut' }]);
  assert.ok(combined.cuts.includes(30), 'als cut geklärter Streitfall gehört in die gemeinsame Fassung');
  assert.ok(!combined.uncertain.includes(30), 'und ist danach nicht mehr unsicher');
  assert.deepEqual(combined.cuts, [11, 30], 'die Grenzen bleiben sortiert');
  assert.deepEqual(combined.uncertain, [50], 'der ungeklärte Streitfall bleibt unsicher');
}

{
  // 'no_cut' nimmt den strittigen Zwischenraum endgültig heraus.
  const pairing = pairSeams([10, 30], [11, 50], 1);
  const combined = combinedBoundary(pairing, [
    { position: 30, decision: 'no_cut' },
    { position: 50, decision: 'no_cut' },
  ]);
  assert.deepEqual(combined.cuts, [11], 'als no_cut geklärte Streitfälle werden keine Grenzen');
  assert.deepEqual(combined.uncertain, [], 'und gelten als erledigt, nicht als unsicher');
}

{
  // 'open' ändert nichts — der Streitfall bleibt offen.
  const pairing = pairSeams([10, 30], [11, 50], 1);
  const combined = combinedBoundary(pairing, [{ position: 30, decision: 'open' }]);
  assert.deepEqual(combined.cuts, [11]);
  assert.deepEqual(combined.uncertain, [30, 50], 'offen geklärt heißt weiterhin unsicher');
}

{
  // Die Auflösungen kommen aus D1 mit seam_message_id und müssen erst auf
  // Positionen im Fenster übersetzt werden — wie die Markierungen auch.
  const positions = new Map([['1030', 30], ['1050', 50]]);
  const resolutions = toPositionalResolutions(
    [
      { seam_message_id: '1030', decision: 'cut' },
      { seam_message_id: '1050', decision: 'no_cut' },
      { seam_message_id: '9999', decision: 'cut' },
    ],
    positions,
  );
  assert.deepEqual(
    resolutions,
    [{ position: 30, decision: 'cut' }, { position: 50, decision: 'no_cut' }],
    'Auflösungen außerhalb des Fensters werden verworfen',
  );

  const combined = combinedBoundary(pairSeams([10, 30], [11, 50], 1), resolutions);
  assert.deepEqual(combined.cuts, [11, 30]);
  assert.deepEqual(combined.uncertain, []);
}

{
  // Die Inter-Rater-Zahl darf sich durch Auflösungen NICHT verändern: sie
  // misst, wie einig beide OHNE Absprache waren, und ist genau deshalb die
  // ehrliche Obergrenze. compareReviewers kennt die Auflösungen nicht.
  const marksA = [{ position: 10, mark: 'cut' }, { position: 30, mark: 'cut' }];
  const marksB = [{ position: 11, mark: 'cut' }];
  const before = compareReviewers(marksA, marksB, { totalSeams: 99, tolerance: 1 });
  const combined = combinedBoundary(before, [{ position: 30, decision: 'cut' }]);
  const after = compareReviewers(marksA, marksB, { totalSeams: 99, tolerance: 1 });
  assert.equal(after.agreementF1, before.agreementF1, 'die Übereinstimmung der Prüfenden bleibt unberührt');
  assert.equal(after.kappa, before.kappa, 'auch kappa bleibt unberührt');
  assert.ok(combined.cuts.includes(30), 'nur die gemeinsame Fassung nimmt die Klärung auf');
}

// --- Rundenerzeugung: reproduzierbar und überschneidungsfrei ---------------

{
  const first = pickRoundStart({ datasetId: 'philena-2026-pilot-v4-unseen', round: 1, sequenceLength: 5000 });
  const second = pickRoundStart({ datasetId: 'philena-2026-pilot-v4-unseen', round: 1, sequenceLength: 5000 });
  assert.equal(first, second, 'derselbe Same muss denselben Startpunkt liefern');
}

{
  const other = pickRoundStart({ datasetId: 'philena-2026-pilot-v4-unseen', round: 2, sequenceLength: 5000 });
  const first = pickRoundStart({ datasetId: 'philena-2026-pilot-v4-unseen', round: 1, sequenceLength: 5000 });
  assert.notEqual(first, other, 'unterschiedliche Runden sollten praktisch nie denselben Samen ziehen');
}

{
  // Runde 2 darf nicht mit der bereits gespeicherten Runde 1 überlappen.
  const round1Start = pickRoundStart({ datasetId: 'ds', round: 1, sequenceLength: 400, windowSize: 100 });
  const round2Start = pickRoundStart({
    datasetId: 'ds',
    round: 2,
    sequenceLength: 400,
    windowSize: 100,
    existingRanges: [{ start: round1Start, count: 100 }],
  });
  const overlaps = round2Start < round1Start + 100 && round1Start < round2Start + 100;
  assert.equal(overlaps, false, 'Runde 2 darf nicht mit Runde 1 überlappen');
}

{
  assert.throws(
    () => pickRoundStart({ datasetId: 'ds', round: 1, sequenceLength: 50, windowSize: 100 }),
    /kürzer/u,
  );
}

{
  // Kein freier Platz mehr: Fenster passt nur genau einmal hinein.
  assert.throws(
    () => pickRoundStart({
      datasetId: 'ds',
      round: 3,
      sequenceLength: 100,
      windowSize: 100,
      existingRanges: [{ start: 0, count: 100 }],
      maxAttempts: 5,
    }),
    /Startpunkt/u,
  );
}

assert.ok(hashSeed('a') !== hashSeed('b'), 'unterschiedliche Eingaben sollten unterschiedliche Samen ergeben');

// --- Blindheit: nur Philipp hat abgegeben, Lena ruft ab ---------------------

{
  const philippMarks = [{ seamMessageId: '20', mark: 'cut' }, { seamMessageId: '55', mark: 'doubt' }];
  const lenaMarks = [{ seamMessageId: '30', mark: 'cut' }];

  const view = buildRoundView({
    reviewer: 'Lena',
    messages: [{ id: '1' }],
    philippMarks,
    lenaMarks,
    philippSubmittedAt: '2026-08-10T07:00:00Z',
    lenaSubmittedAt: null,
  });

  assert.deepEqual(view.marks, lenaMarks, 'Lena darf nur ihre eigenen Markierungen sehen');
  assert.equal(view.submitted, false, 'Lena selbst hat noch nicht abgegeben');
  assert.equal(view.otherSubmitted, true, 'dass Philipp abgegeben hat, darf sichtbar sein');

  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('"20"'), 'Philipps Zwischenraum 20 darf in Lenas Antwort nicht auftauchen');
  assert.ok(!serialized.includes('"55"'), 'Philipps Zwischenraum 55 darf in Lenas Antwort nicht auftauchen');
}

{
  // Rollen vertauscht: Philipp ruft ab, nur Lena hat abgegeben.
  const philippMarks = [{ seamMessageId: '9', mark: 'cut' }];
  const lenaMarks = [{ seamMessageId: '41', mark: 'cut' }];

  const view = buildRoundView({
    reviewer: 'Philipp',
    messages: [],
    philippMarks,
    lenaMarks,
    philippSubmittedAt: null,
    lenaSubmittedAt: '2026-08-10T07:00:00Z',
  });

  assert.deepEqual(view.marks, philippMarks);
  assert.ok(!JSON.stringify(view).includes('"41"'), 'Lenas Zwischenraum 41 darf in Philipps Antwort nicht auftauchen');
}

{
  // Nach beidseitiger Abgabe bleibt /api/rounds/:round trotzdem blind —
  // der Vergleich läuft ausschließlich über /agreement.
  const view = buildRoundView({
    reviewer: 'Lena',
    messages: [],
    philippMarks: [{ seamMessageId: '77', mark: 'cut' }],
    lenaMarks: [{ seamMessageId: '30', mark: 'cut' }],
    philippSubmittedAt: '2026-08-10T07:00:00Z',
    lenaSubmittedAt: '2026-08-10T08:00:00Z',
  });
  assert.ok(!JSON.stringify(view).includes('"77"'));
}

// --- Blindheit: /agreement bleibt gesperrt, solange nicht beide abgegeben haben ---

{
  const gate = agreementGate({ reviewer: 'Lena', philippSubmittedAt: '2026-08-10T07:00:00Z', lenaSubmittedAt: null });
  assert.deepEqual(gate, { waitingFor: 'Lena' }, 'wer selbst noch nicht abgegeben hat, wartet auf sich selbst');
}

{
  const gate = agreementGate({ reviewer: 'Philipp', philippSubmittedAt: '2026-08-10T07:00:00Z', lenaSubmittedAt: null });
  assert.deepEqual(gate, { waitingFor: 'Lena' }, 'Philipp hat abgegeben, wartet also auf Lena');
}

{
  const gate = agreementGate({ reviewer: 'Philipp', philippSubmittedAt: '2026-08-10T07:00:00Z', lenaSubmittedAt: '2026-08-10T08:00:00Z' });
  assert.equal(gate, null, 'beide abgegeben -> Vergleich freigegeben');
}

// --- Automatik-Verdrahtung: getSummary/getAgreement füttern die Segmentierung ---

{
  // Diese Nachrichten haben genau die Form, die toView() in
  // worker-boundary-pairs.ts erzeugt (id/from/t/text/kind/replyToId) — der
  // Test läuft also über dieselbe Verdrahtung wie GET /api/agreement/summary,
  // nicht über handgebaute Segmentierungs-Eingaben.
  const base = Date.parse('2026-05-10T06:00:00Z') / 1000;
  const view = [];
  let clock = base;
  const push = (from, text, kind = 'text', extra = {}) => {
    view.push({ id: String(1000 + view.length), from, t: clock, text, kind, ...extra });
  };

  for (let index = 0; index < 6; index += 1) {
    push(index % 2 ? 'Lena' : 'Philipp Sellin', 'Der Zug fuhr pünktlich ab.');
    clock += 300;
  }
  clock += 8 * 3600;
  push('Lena', 'Guten Morgen, schön von dir zu lesen.');
  clock += 300;
  push('Philipp Sellin', 'Die Katze lag wieder auf der Fensterbank.');
  clock += 2 * 3600;
  push('Lena', '', 'anruf');
  clock += 300;
  push('Lena', 'Ich muss jetzt los, wir sprechen später.');
  clock += 3600;
  push('Philipp Sellin', 'Der Termin beim Vermieter steht.');

  const input = toSegmentationInput(view);

  // Die Felder, ohne die segmentation-v4.mjs blind ist, müssen ankommen.
  assert.equal(input[0].text, 'Der Zug fuhr pünktlich ab.', 'Text muss durchgereicht werden');
  assert.equal(input[0].from, 'Philipp Sellin', 'Absender muss durchgereicht werden');
  assert.equal(input[0].date_unixtime, base, 'Zeitstempel muss durchgereicht werden');
  assert.equal(input[8].truewords_service_type, 'call', "kind 'anruf' muss als call ankommen");

  const result = segmentConversationWindow(input);
  assert.ok(
    result.boundaries.length > 0,
    `die Automatik muss über die echte Verdrahtung Grenzen finden, fand aber ${result.boundaries.length}`,
  );
  assert.ok(
    !result.decisions.every((decision) => decision.reason === 'no_previous_event'),
    'no_previous_event für jeden Übergang heißt: der Segmentierung fehlen Text und Art',
  );

  // Gegenprobe: genau die alte Verdrahtung (nur id + Zeitstempel). Ohne Text
  // gilt keine Nachricht als bedeutsam, boundaryDecision steigt vor jeder
  // Regel aus — daher dauerhaft 0 Grenzen und eine Automatik von 0,00.
  const gestrippt = segmentConversationWindow(
    view.map((message) => ({ id: message.id, date_unixtime: message.t })),
  );
  assert.equal(gestrippt.boundaries.length, 0, 'die alte Verdrahtung konnte gar keine Grenze finden');
}

{
  // reply_to_message_id muss ankommen, sonst greift direct_reply_continuation
  // nicht und die Automatik schneidet mitten in laufenden Wechselreden.
  const input = toSegmentationInput([
    { id: '1', from: 'Lena', t: 1000, text: 'Frage?', kind: 'text' },
    { id: '2', from: 'Philipp Sellin', t: 2000, text: 'Antwort.', kind: 'text', replyToId: '1' },
    { id: '3', from: 'Lena', t: 3000, text: 'Foto', kind: 'medien' },
  ]);
  assert.equal(input[1].reply_to_message_id, '1', 'Antwortbeziehung muss durchgereicht werden');
  assert.equal(input[2].truewords_media_type, 'media', "kind 'medien' muss als media ankommen");
  assert.equal(input[0].reply_to_message_id, undefined, 'ohne Antwortbeziehung bleibt das Feld weg');
}

{
  // Beide Aufrufstellen (getAgreement UND getSummary) müssen über
  // toSegmentationInput gehen. Genau hier ist der Fehler entstanden: die
  // Abbildung stand zweimal wörtlich im Code, und eine der beiden Stellen
  // wurde beim Beheben übersehen — die Übersicht blieb bei 0,00, während der
  // Rundenvergleich schon richtig rechnete. Ein Unit-Test über die reine
  // Logik kann das nicht sehen, deshalb wird hier die Quelle geprüft.
  const worker = readFileSync(new URL('../src/worker-boundary-pairs.ts', import.meta.url), 'utf8');
  const calls = worker.match(/segmentConversationWindow\(/gu) || [];
  assert.equal(calls.length, 2, 'erwartet werden genau zwei Aufrufe der Segmentierung');
  assert.equal(
    (worker.match(/toSegmentationInput\(messages\)/gu) || []).length,
    2,
    'beide Aufrufstellen müssen toSegmentationInput benutzen',
  );
  assert.ok(
    !/date_unixtime:\s*message\.t/u.test(worker),
    'keine Aufrufstelle darf die Nachrichten noch selbst auf id und Zeitstempel zusammenstreichen',
  );
}

console.log('boundary-pairs-logic tests: PASS');
