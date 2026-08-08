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

console.log('segmentation-v4 tests: PASS');
