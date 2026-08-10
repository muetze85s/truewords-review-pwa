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
  const result = segmentConversationWindow([
    msg(1, 8, 'Lena', 'Kannst du heute beim Vermieter anrufen?'),
    msg(2, 12, 'Philipp Sellin', 'Ja, mache ich in der Mittagspause.'),
    msg(3, 16, 'Lena', 'Hat es geklappt?'),
    msg(4, 20, 'Philipp Sellin', 'Ja, Termin ist Donnerstag.'),
  ]);
  assert.equal(result.situations.length, 1, 'Vier-Stunden-Antwortpausen dürfen eine laufende Konversation nicht schneiden.');
}

{
  const result = segmentConversationWindow([
    msg(10, 8, 'Philipp Sellin', 'Die Hühner sind wieder da.'),
    msg(11, 8.1, 'Lena', 'Da bin ich froh.'),
    { ...msg(12, 10, 'Lena', ''), truewords_display_placeholder: '[Anruf · verpasst]', truewords_service_type: 'call' },
    msg(13, 10.03, 'Lena', 'Wollte kurz Zigarettenpause machen, schläfst du?'),
    msg(14, 16, 'Philipp Sellin', 'Ja, wie ein Stein.'),
  ]);
  assert.equal(result.situations.length, 2, 'Neuer Kontaktversuch nach ausgelaufener Konversation muss eine neue Situation eröffnen.');
  assert.equal(result.assignments['12'], 2);
  assert.equal(result.assignments['14'], 2, 'Späte Antwort auf offene Frage bleibt in derselben Konversation.');
}

{
  const result = segmentConversationWindow([
    msg(20, 8, 'Lena', 'Ich muss jetzt los. Wir sprechen später.'),
    msg(21, 13, 'Philipp Sellin', 'Guten Tag, bist du schon angekommen?'),
  ]);
  assert.equal(result.situations.length, 2, 'Expliziter Abschluss plus neuer Einstieg erzeugt eine Grenze.');
}

{
  const result = segmentConversationWindow([
    msg(30, 8, 'Lena', 'Ich denke noch darüber nach.'),
    msg(31, 20, 'Philipp Sellin', 'Das verstehe ich.'),
  ]);
  assert.equal(result.situations.length, 1, 'Eine lange Pause allein darf keine Grenze erzeugen.');
}

{
  // Regression: worker-boundary-pairs.ts feeds segmentConversationWindow
  // stripped-down messages for the automatic-segmentation comparison. If a
  // caller ever strips the timestamp too, close() formats an Invalid Date
  // via Intl.DateTimeFormat and throws "Invalid time value" instead of
  // producing a result — must not happen as long as date_unixtime is present.
  const result = segmentConversationWindow([
    { id: 1, date_unixtime: '1746864000' },
    { id: 2, date_unixtime: '1746864600' },
  ]);
  assert.equal(result.situations.length, 1);

  assert.throws(
    () => segmentConversationWindow([{ id: 1 }, { id: 2 }]),
    /Invalid time value/u,
    'messages without a timestamp must fail loudly, not silently — this documents why callers must always pass date_unixtime',
  );
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

console.log('segmentation-v4 tests: PASS');
