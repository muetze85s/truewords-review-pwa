import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hauptappBoundaries, toNormalizedEvents, participantsOf } from '../hauptapp-segmentierung.mjs';
import { SITUATION_DEFAULTS } from '../vendor/truewords-app/sequential-communication-analysis.ts';

// --- Die Kopie muss unverändert bleiben ------------------------------------

{
  // Wird die Kopie bearbeitet, misst der Prüfstand nicht mehr die Hauptanwendung.
  // Die Prüfsumme steht in vendor/truewords-app/HERKUNFT.md.
  const quelle = readFileSync(new URL('../vendor/truewords-app/sequential-communication-analysis.ts', import.meta.url));
  const summe = createHash('sha256').update(quelle).digest('hex');
  assert.equal(
    summe,
    '2ba3692ec9499f793d7f8a721fbe1fa7a1b9a550b73ce818b12d80e2a4180ecd',
    'die Kopie aus der Hauptanwendung wurde verändert — Herkunft und Prüfsumme in vendor/truewords-app/HERKUNFT.md nachziehen und die Messung wiederholen',
  );
}

{
  // Die Vorgaben der Hauptanwendung sind das, wogegen wir messen. Ändern sie sich
  // beim nächsten Kopieren, sollen die Kennzahlen nicht stillschweigend wandern.
  assert.deepEqual({ ...SITUATION_DEFAULTS }, {
    inactivityMs: 15 * 60_000,
    maxMessages: 40,
    maxOpenMs: 6 * 60 * 60_000,
    maxCharacters: 24_000,
  });
}

// --- Übersetzung unserer Nachrichten ---------------------------------------

const basis = Date.parse('2026-05-10T08:00:00Z') / 1000;
const nachricht = (id, minuten, from, text, extra = {}) => ({
  id: String(id), from, t: basis + minuten * 60, text, kind: 'text', ...extra,
});

{
  const messages = [
    nachricht(1, 0, 'Person A', 'Erste Nachricht'),
    nachricht(2, 5, 'Person B', 'Zweite Nachricht'),
  ];
  assert.deepEqual(participantsOf(messages), ['Person A', 'Person B']);

  const events = toNormalizedEvents(messages);
  assert.equal(events[0].senderUserId, 'Person A');
  assert.equal(events[0].recipientUserId, 'Person B', 'der Empfänger ist der jeweils andere');
  assert.equal(events[1].senderUserId, 'Person B');
  assert.equal(events[1].recipientUserId, 'Person A');
  assert.ok(events[0].sentAt instanceof Date, 'sentAt muss ein Date sein');
  assert.equal(events[0].sentAt.getTime(), basis * 1000, 'unsere Sekunden werden zu Millisekunden');
  assert.equal(events[0].replyToId, null, 'ohne Antwortbezug bleibt das Feld null');
  assert.equal(events[0].source, 'chat_import');
}

{
  // Antwortbezug wird durchgereicht — die Hauptanwendung verknüpft darüber
  // aufeinanderfolgende Situationen.
  const events = toNormalizedEvents([
    nachricht(1, 0, 'Person A', 'Frage?'),
    nachricht(2, 5, 'Person B', 'Antwort.', { replyToId: '1' }),
  ]);
  assert.equal(events[1].replyToId, '1');
}

{
  // Anrufe und Medien haben bei uns keinen Text. Der bleibt leer, statt einen
  // Ersatztext zu erfinden — sonst verfälschte er Zeichenzählung und Abschlussmuster.
  const events = toNormalizedEvents([
    { id: '1', from: 'Person A', t: basis, text: '', kind: 'anruf' },
    { id: '2', from: 'Person B', t: basis + 60, text: '', kind: 'medien' },
  ]);
  assert.equal(events[0].text, '');
  assert.equal(events[1].text, '');
}

// --- Grenzen der Hauptanwendung als Zwischenraum-Positionen ----------------

{
  // 15 Minuten Pause ist die Vorgabe der Hauptanwendung: darunter keine Grenze,
  // darüber eine.
  const eng = hauptappBoundaries([
    nachricht(1, 0, 'Person A', 'Eins'),
    nachricht(2, 10, 'Person B', 'Zwei'),
  ]);
  assert.deepEqual(eng.positions, [], 'zehn Minuten liegen unter der Schwelle');

  const weit = hauptappBoundaries([
    nachricht(1, 0, 'Person A', 'Eins'),
    nachricht(2, 20, 'Person B', 'Zwei'),
  ]);
  assert.deepEqual(weit.positions, [1], 'zwanzig Minuten liegen darüber');
  assert.equal(weit.situations, 2);
  assert.equal(weit.closeReasons.inactivity, 1);
}

{
  // Mehrere Grenzen im Fenster, aufsteigend und als Position der jeweils ersten
  // Nachricht der neuen Situation.
  const result = hauptappBoundaries([
    nachricht(1, 0, 'Person A', 'Eins'),
    nachricht(2, 2, 'Person B', 'Zwei'),
    nachricht(3, 60, 'Person A', 'Drei'),
    nachricht(4, 62, 'Person B', 'Vier'),
    nachricht(5, 200, 'Person A', 'Fünf'),
  ]);
  assert.deepEqual(result.positions, [2, 4]);
  assert.equal(result.situations, 3);
}

{
  // Das ausdrückliche Abschlussmuster der Hauptanwendung schließt eine Situation
  // auch ohne Pause — ab der zweiten Nachricht.
  const result = hauptappBoundaries([
    nachricht(1, 0, 'Person A', 'Wie machen wir es?'),
    nachricht(2, 1, 'Person B', 'Okay, dann machen wir das so'),
    nachricht(3, 2, 'Person A', 'Noch etwas anderes'),
  ]);
  assert.deepEqual(result.positions, [2], 'nach dem Abschluss beginnt eine neue Situation');
  assert.equal(result.closeReasons.explicit_candidate, 1);
}

{
  // Randfälle dürfen nicht werfen.
  assert.deepEqual(hauptappBoundaries([]).positions, []);
  assert.deepEqual(hauptappBoundaries([nachricht(1, 0, 'Person A', 'Allein')]).positions, []);
}

{
  // Positionen müssen im gültigen Bereich liegen: 1..n-1, nie 0.
  const messages = [];
  for (let index = 0; index < 30; index += 1) {
    messages.push(nachricht(1000 + index, index * 20, index % 2 ? 'Person A' : 'Person B', `Nachricht ${index}`));
  }
  const result = hauptappBoundaries(messages);
  assert.ok(result.positions.length > 0, 'bei 20 Minuten Abstand muss die Hauptanwendung schneiden');
  for (const position of result.positions) {
    assert.ok(position >= 1 && position <= messages.length - 1, `Position ${position} liegt außerhalb 1..${messages.length - 1}`);
  }
  assert.deepEqual([...result.positions].sort((a, b) => a - b), result.positions, 'Positionen müssen aufsteigend sein');
}

console.log('hauptapp-segmentierung tests: PASS');
