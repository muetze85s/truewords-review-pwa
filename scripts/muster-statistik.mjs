/**
 * Zählt, wie oft die Textmuster und Regeln von segmentation-v4.mjs auf den
 * echten Daten überhaupt greifen. Gibt AUSSCHLIESSLICH Zahlen aus, niemals
 * Nachrichtentext.
 *
 * Die Muster werden nicht abgeschrieben, sondern zur Laufzeit aus
 * segmentation-v4.mjs gelesen — so kann die Statistik nicht von der
 * tatsächlich eingesetzten Fassung abweichen.
 *
 * Aufruf: node scripts/muster-statistik.mjs <chunks-dump.json>
 */
import { readFileSync } from 'node:fs';
import { eventText, timestamp, segmentConversationWindow } from '../segmentation-v4.mjs';

const [dumpPath] = process.argv.slice(2);
if (!dumpPath) throw new Error('Aufruf: node scripts/muster-statistik.mjs <chunks-dump.json>');

// ---------------------------------------------- Muster aus der Quelle holen
const source = readFileSync(new URL('../segmentation-v4.mjs', import.meta.url), 'utf8');
function pattern(name) {
  const match = source.match(new RegExp(`const ${name} = (/.*/[a-z]*);`, 'u'));
  if (!match) throw new Error(`Muster ${name} nicht in segmentation-v4.mjs gefunden.`);
  const body = match[1].slice(1, match[1].lastIndexOf('/'));
  const flags = match[1].slice(match[1].lastIndexOf('/') + 1);
  return new RegExp(body, flags);
}
const explicitClosure = pattern('explicitClosurePattern');
const greeting = pattern('greetingPattern');
const independentOpener = pattern('independentOpenerPattern');
const continuation = pattern('continuationPattern');
const acknowledgement = pattern('acknowledgementPattern');

function hasQuestion(text) {
  return /\?/u.test(text) || /\b(?:bist|hast|willst|magst|kannst|könntest|wann|wo|wie|was|warum|soll|möchtest|kommst|gehts|geht es)\b.*[?.!…]?\s*$/iu.test(text);
}
function eventKind(message) {
  const placeholder = String(message?.truewords_display_placeholder || message?.text || '').toLocaleLowerCase('de-DE');
  const service = String(message?.truewords_service_type || message?.service_type || message?.action || '').toLocaleLowerCase('de-DE');
  if (placeholder.includes('anruf') || service.includes('call')) return 'call';
  if (message?.truewords_media_type || message?.media_type || message?.photo || message?.file || message?.truewords_display_placeholder) return 'media';
  return 'text';
}

// ------------------------------------------------------- Nachrichten laden
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const rows = [...(dump[0]?.results || [])].sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index));
const messages = [];
for (const row of rows) {
  const parsed = JSON.parse(row.messages_json);
  if (Array.isArray(parsed)) for (const m of parsed) if (m && typeof m === 'object') messages.push(m);
}

// ------------------------------------- A) Treffer je Muster, nachrichtenweise
const texts = messages.map((m) => eventText(m));
const withText = texts.filter((t) => t).length;
const count = (regex) => texts.reduce((sum, t) => sum + (t && regex.test(t) ? 1 : 0), 0);

console.log('=== A) Textmuster-Treffer über alle Nachrichten ===');
console.log(`Nachrichten gesamt: ${messages.length}`);
console.log(`davon mit Text: ${withText}`);
const hits = {
  explicitClosure: count(explicitClosure),
  greeting: count(greeting),
  independentOpener: count(independentOpener),
  continuation: count(continuation),
  acknowledgement: count(acknowledgement),
  frage: texts.reduce((s, t) => s + (t && hasQuestion(t) ? 1 : 0), 0),
};
for (const [name, value] of Object.entries(hits)) {
  console.log(`  ${name.padEnd(18)}: ${String(value).padStart(5)}  (${(100 * value / messages.length).toFixed(2)}% aller Nachrichten)`);
}
const kinds = { text: 0, call: 0, media: 0 };
for (const m of messages) kinds[eventKind(m)] += 1;
console.log(`  Art text/call/media: ${kinds.text}/${kinds.call}/${kinds.media}`);

// -------------------------- B) Was würde die Regel rein rechnerisch auslösen
console.log('\n=== B) Regelbedingungen je Übergang (Muster UND Zeitschwelle) ===');
const t = messages.map((m) => timestamp(m));
let closureRule = 0;
let greetingRule = 0;
let openerRule = 0;
let callRule = 0;
let mediaRule = 0;
let usable = 0;
for (let i = 1; i < messages.length; i += 1) {
  const gap = (t[i] - t[i - 1]) / 60;
  if (!Number.isFinite(gap) || gap < 0) continue;
  usable += 1;
  const cur = texts[i];
  const prev = texts[i - 1];
  if (gap >= 15 && prev && explicitClosure.test(prev)) closureRule += 1;
  if (gap >= 240 && cur && greeting.test(cur)) greetingRule += 1;
  if (gap >= 240 && cur && independentOpener.test(cur)) openerRule += 1;
  if (gap >= 60 && eventKind(messages[i]) === 'call' && eventKind(messages[i - 1]) !== 'call') callRule += 1;
  if (gap >= 720 && eventKind(messages[i]) === 'media') mediaRule += 1;
}
console.log(`auswertbare Übergänge: ${usable}`);
console.log(`  Abschluss   (>=15min + Muster auf VORheriger): ${closureRule}`);
console.log(`  Begrüßung   (>=240min + Muster auf aktueller): ${greetingRule}`);
console.log(`  Einstieg    (>=240min + Muster auf aktueller): ${openerRule}`);
console.log(`  Anruf       (>=60min + call nach nicht-call) : ${callRule}`);
console.log(`  Medien      (>=720min + media)               : ${mediaRule}`);
console.log(`  Summe potenzieller Grenzen: ${closureRule + greetingRule + openerRule + callRule + mediaRule}`);

// ----------------------- C) Was die Funktion tatsächlich entscheidet (Gründe)
function reasonHistogram(window) {
  const result = segmentConversationWindow(window);
  const histogram = new Map();
  for (const decision of result.decisions) {
    histogram.set(decision.reason, (histogram.get(decision.reason) || 0) + 1);
  }
  return { histogram, boundaries: result.boundaries.length };
}

console.log('\n=== C) Tatsächliche Entscheidungsgründe, ganze Folge ===');
const whole = reasonHistogram(messages);
console.log(`gefundene Grenzen: ${whole.boundaries}`);
for (const [reason, value] of [...whole.histogram].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(38)}: ${String(value).padStart(5)}`);
}

console.log('\n=== D) Dieselbe Auswertung in 100er-Fenstern (wie im Prüfstand) ===');
const totals = new Map();
let windowBoundaries = 0;
let windowCount = 0;
for (let start = 0; start + 100 <= messages.length; start += 100) {
  const { histogram, boundaries } = reasonHistogram(messages.slice(start, start + 100));
  windowBoundaries += boundaries;
  windowCount += 1;
  for (const [reason, value] of histogram) totals.set(reason, (totals.get(reason) || 0) + value);
}
console.log(`Fenster: ${windowCount}, gefundene Grenzen insgesamt: ${windowBoundaries}`);
for (const [reason, value] of [...totals].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(38)}: ${String(value).padStart(5)}`);
}
