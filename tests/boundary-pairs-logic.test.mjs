import assert from 'node:assert/strict';
import {
  hashSeed,
  pickRoundStart,
  pairSeams,
  agreementF1,
  cohensKappa,
  resolveMarks,
  compareReviewers,
  combinedBoundary,
} from '../boundary-pairs-logic.mjs';

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

console.log('boundary-pairs-logic tests: PASS');
