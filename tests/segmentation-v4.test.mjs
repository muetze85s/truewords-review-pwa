import assert from 'node:assert/strict';
import { segmentConversationWindow } from '../segmentation-v4.mjs';

function msg(id, hour, from, text, extra = {}) {
  return {
    id,
    from,
    date: new Date(Date.parse('2026-05-10T00:00:00Z') + hour * 3600_000).toISOString().replace('.000Z', ''),
    date_unixtime: String((Date.parse('2026-05-10T00:00:00Z') + hour * 3600_000) / 1000),
    text,
    ...extra,
  };
}

{
  // Dieser Fall hielt früher als eine Situation zusammen: ein laufender
  // Austausch mit vier Stunden Antwortlatenz. Mit PAUSE_BOUNDARY_HOURS = 3
  // zerfällt er in vier — das ist der Preis der Pausenregel und zugleich die
  // konkrete Gestalt eines Teils ihrer Fehlalarme. Bewusst so festgehalten,
  // damit die Auswirkung sichtbar bleibt und nicht unbemerkt kippt, falls
  // jemand an der Schwelle dreht.
  const result = segmentConversationWindow([
    msg(1, 8, 'Lena', 'Kannst du heute beim Vermieter anrufen?'),
    msg(2, 12, 'Philipp Sellin', 'Ja, mache ich in der Mittagspause.'),
    msg(3, 16, 'Lena', 'Hat es geklappt?'),
    msg(4, 20, 'Philipp Sellin', 'Ja, Termin ist Donnerstag.'),
  ]);
  assert.equal(
    result.situations.length,
    4,
    'Antwortpausen über der Schwelle schneiden jetzt auch eine laufende Konversation',
  );

  // Bei zwei Stunden Latenz bleibt derselbe Austausch zusammen.
  const enger = segmentConversationWindow([
    msg(1, 8, 'Lena', 'Kannst du heute beim Vermieter anrufen?'),
    msg(2, 10, 'Philipp Sellin', 'Ja, mache ich in der Mittagspause.'),
    msg(3, 12, 'Lena', 'Hat es geklappt?'),
    msg(4, 14, 'Philipp Sellin', 'Ja, Termin ist Donnerstag.'),
  ]);
  assert.equal(enger.situations.length, 1, 'unterhalb der Schwelle bleibt der Austausch eine Situation');
}

{
  const result = segmentConversationWindow([
    msg(10, 8, 'Philipp Sellin', 'Die Hühner sind wieder da.'),
    msg(11, 8.1, 'Lena', 'Da bin ich froh.'),
    { ...msg(12, 10, 'Lena', ''), truewords_display_placeholder: '[Anruf · verpasst]', truewords_service_type: 'call' },
    msg(13, 10.03, 'Lena', 'Wollte kurz Zigarettenpause machen, schläfst du?'),
    msg(14, 16, 'Philipp Sellin', 'Ja, wie ein Stein.'),
  ]);
  assert.equal(result.situations.length, 3, 'Neuer Kontaktversuch nach ausgelaufener Konversation muss eine neue Situation eröffnen.');
  assert.equal(result.assignments['12'], 2, 'der Anruf eröffnet weiterhin die zweite Situation');
  // Früher blieb diese späte Antwort in derselben Konversation, weil eine
  // offene Frage vorausging. Knapp sechs Stunden liegen jetzt über der
  // Pausenschwelle — die offene Frage hält das nicht mehr zusammen. Genau
  // dieses Verhalten war der Anlass für die Regel.
  assert.equal(result.assignments['14'], 3, 'späte Antwort über der Schwelle eröffnet eine neue Situation');
}

{
  const result = segmentConversationWindow([
    msg(20, 8, 'Lena', 'Ich muss jetzt los. Wir sprechen später.'),
    msg(21, 13, 'Philipp Sellin', 'Guten Tag, bist du schon angekommen?'),
  ]);
  assert.equal(result.situations.length, 2, 'Expliziter Abschluss plus neuer Einstieg erzeugt eine Grenze.');
}

// --- Pause als eigenständige Grenze (PAUSE_BOUNDARY_HOURS) -----------------
//
// Bis hierher galt: "Eine lange Pause allein darf keine Grenze erzeugen."
// Diese Definition ist bewusst aufgegeben — die Fehleranalyse hat gezeigt,
// dass 16 der 27 übersehenen Grenzen genau solche reinen Pausen waren.

{
  // Zwölf Stunden ohne Muster, ohne Sprecherwechselsignal: schneidet jetzt.
  const result = segmentConversationWindow([
    msg(30, 8, 'Lena', 'Ich denke noch darüber nach.'),
    msg(31, 20, 'Philipp Sellin', 'Das verstehe ich.'),
  ]);
  assert.equal(result.situations.length, 2, 'eine Pause über der Schwelle erzeugt eine Grenze');
  assert.equal(result.boundaries[0].reason, 'long_pause');
}

{
  // Unabhängig vom Muster: derselbe Abstand mit einer Fortsetzungsfloskel,
  // die sonst linguistic_continuation auslösen würde.
  const result = segmentConversationWindow([
    msg(40, 8, 'Lena', 'Ich denke noch darüber nach.'),
    msg(41, 16, 'Philipp Sellin', 'Ja, genau so sehe ich das auch.'),
  ]);
  assert.equal(result.boundaries.length, 1, 'ein Fortsetzungsmuster darf die Pausenregel nicht aushebeln');
  assert.equal(result.boundaries[0].reason, 'long_pause');
}

{
  // Unabhängig vom Sprecher: dieselbe Person nach langer Pause.
  const result = segmentConversationWindow([
    msg(50, 8, 'Lena', 'Ich schaue nachher noch mal nach.'),
    msg(51, 18, 'Lena', 'Der Zug fuhr pünktlich ab.'),
  ]);
  assert.equal(result.boundaries.length, 1, 'auch ohne Sprecherwechsel schneidet die Pausenregel');
  assert.equal(result.boundaries[0].reason, 'long_pause');
}

{
  // Unabhängig vom Antwortbezug: eine direkte Antwort nach langer Pause
  // eröffnet ebenfalls eine neue Situation.
  const result = segmentConversationWindow([
    msg(60, 8, 'Lena', 'Kannst du morgen beim Vermieter anrufen?'),
    { ...msg(61, 20, 'Philipp Sellin', 'Habe ich erledigt.'), reply_to_message_id: 60 },
  ]);
  assert.equal(result.boundaries.length, 1, 'auch ein Antwortbezug hält die Konversation nicht über die Schwelle');
  assert.equal(result.boundaries[0].reason, 'long_pause');
}

{
  // Unterhalb der Schwelle bleibt alles beim Alten: zwei Stunden Pause
  // ohne weiteres Signal schneiden weiterhin nicht.
  const result = segmentConversationWindow([
    msg(70, 8, 'Lena', 'Ich denke noch darüber nach.'),
    msg(71, 10, 'Philipp Sellin', 'Das verstehe ich.'),
  ]);
  assert.equal(result.situations.length, 1, 'unterhalb der Schwelle erzeugt eine Pause weiterhin keine Grenze');
}

{
  // Regression: worker-boundary-pairs.ts feeds segmentConversationWindow
  // stripped-down messages for the automatic-segmentation comparison.
  const result = segmentConversationWindow([
    { id: 1, date_unixtime: '1746864000' },
    { id: 2, date_unixtime: '1746864600' },
  ]);
  assert.equal(result.situations.length, 1);
}

{
  // Regression: a single broken timestamp must never block the whole
  // overview. close() formats the first message of each situation via
  // Intl.DateTimeFormat, which throws "Invalid time value" on an invalid
  // date — that used to take down GET /api/agreement/summary completely.
  // Now the raw value is passed through instead of throwing.
  const brokenTimestamps = [null, undefined, '', '   ', 'kaputt', 'NaN', {}, []];
  for (const broken of brokenTimestamps) {
    const result = segmentConversationWindow([
      { id: 1, date_unixtime: broken },
      { id: 2, date_unixtime: broken },
    ]);
    assert.equal(
      result.situations.length,
      1,
      `ungültiger Zeitstempel ${JSON.stringify(broken)} darf die Auswertung nicht sprengen`,
    );
    assert.ok(
      result.situations[0].label.startsWith('V4 01 · '),
      'die Situation muss trotzdem eine Beschriftung bekommen',
    );
  }
}

{
  // Same, but in the exact shape getSummary/getAgreement build in
  // worker-boundary-pairs.ts ({ id, date_unixtime: message.t }) and with the
  // broken timestamp sitting in the middle of an otherwise healthy window —
  // that is the case that actually reaches production.
  const base = Date.parse('2026-05-10T00:00:00Z') / 1000;
  const messages = [];
  for (let index = 0; index < 20; index += 1) {
    messages.push({ id: String(1000 + index), date_unixtime: String(base + index * 300) });
  }
  messages[7].date_unixtime = null;
  messages[12].date_unixtime = 'kaputt';
  messages[15].date_unixtime = '';

  const result = segmentConversationWindow(messages);
  assert.ok(result.situations.length >= 1, 'die Auswertung muss durchlaufen');
  assert.equal(Object.keys(result.assignments).length, messages.length, 'jede Nachricht braucht eine Zuordnung');
  for (const situation of result.situations) {
    assert.ok(situation.label, 'jede Situation braucht eine Beschriftung');
  }

  // Und der Nachschlag, den getSummary danach macht, muss weiter funktionieren.
  const positions = new Map();
  for (let index = 1; index < messages.length; index += 1) positions.set(messages[index].id, index);
  const mapped = result.boundaries
    .map((boundary) => positions.get(boundary.beforeEventId))
    .filter((position) => position !== undefined);
  assert.equal(mapped.length, result.boundaries.length, 'jede gefundene Grenze muss auf eine Position abbildbar bleiben');
}

{
  // Regression: with real gaps present (date_unixtime in seconds, matching
  // worker-boundary-pairs.ts's ViewMessage.t), the automatic comparison must
  // actually be able to find a boundary — not just avoid crashing. A silent
  // unit mismatch (e.g. milliseconds instead of seconds) would make every
  // gap huge or every gap ~0 without throwing, quietly producing 0 boundaries
  // forever and a permanently 0.00 "Automatik" score.
  const base = Date.parse('2026-05-10T00:00:00Z') / 1000;
  const messages = [
    { id: '1', date_unixtime: String(base), text: 'Kannst du heute beim Vermieter anrufen?' },
    { id: '2', date_unixtime: String(base + 200), text: 'Ja, mache ich.' },
    { id: '3', date_unixtime: String(base + 300), text: 'Ich muss jetzt los, wir sprechen später.' },
    { id: '4', date_unixtime: String(base + 8 * 3600), text: 'Guten Abend, bist du schon zu Hause?' },
  ];
  const result = segmentConversationWindow(messages);
  assert.ok(result.boundaries.length >= 1, 'ein expliziter Abschluss plus spätere Begrüßung muss eine Grenze erzeugen');
  assert.equal(result.boundaries[0].beforeEventId, '4');
}

// --- Rückblick auf offene Fragen (OPEN_QUESTION_LOOKBACK) ------------------

// Beide Fälle bleiben bewusst unter PAUSE_BOUNDARY_HOURS — oberhalb der
// Schwelle schneidet die Pausenregel ohnehin, dann prüfte der Test sie statt
// des Rückblicks.

{
  // Eine offene Frage der Gegenseite, die unmittelbar vorausgeht, muss eine
  // Grenze weiterhin verhindern — das ist der Zweck der Bremse. Ohne sie
  // würde hier der ausdrückliche Abschluss eine Grenze setzen.
  const result = segmentConversationWindow([
    msg(1, 0, 'Lena', 'Ich muss jetzt los, kannst du morgen beim Vermieter anrufen?'),
    msg(2, 2, 'Philipp Sellin', 'Der Zug fuhr pünktlich ab.'),
  ]);
  assert.equal(
    result.situations.length,
    1,
    'eine direkt vorausgehende offene Frage muss die Grenze weiterhin unterdrücken',
  );
}

{
  // Liegt die Frage dagegen mehrere eigene Nachrichten zurück, greift die
  // Bremse nicht mehr, und der ausdrückliche Abschluss setzt die Grenze.
  // Mit dem früheren Fenster von 8 wurde auch dieser Fall noch unterdrückt.
  const result = segmentConversationWindow([
    msg(10, 0, 'Lena', 'Kannst du morgen beim Vermieter anrufen?'),
    msg(11, 0.1, 'Philipp Sellin', 'Der Zug fuhr pünktlich ab.'),
    msg(12, 0.2, 'Philipp Sellin', 'Ich muss jetzt los, wir sprechen später.'),
    msg(13, 2, 'Philipp Sellin', 'Die Katze lag auf der Fensterbank.'),
  ]);
  assert.equal(
    result.situations.length,
    2,
    'eine mehrere Wortwechsel zurückliegende Frage darf die Grenze nicht mehr unterdrücken',
  );
  assert.equal(result.boundaries[0].beforeEventId, '13');
  assert.equal(result.boundaries[0].reason, 'previous_conversation_explicitly_closed');
}

console.log('segmentation-v4 tests: PASS');
