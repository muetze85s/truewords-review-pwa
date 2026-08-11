/**
 * Baut aus einem Telegram-Export (result.json) eine zeitstempel.json:
 * ein Array mit einem Objekt pro Nachricht, das AUSSCHLIESSLICH den
 * Sekunden-Zeitstempel und "from" enthält — kein Text, keine Medien,
 * keine IDs, keine Inhalte. Reihenfolge wie im Original.
 *
 * Gedacht für die Analyse der tatsächlichen Pausenverteilung, um daraus
 * die Schwellen der automatischen Segmentierung abzuleiten. Weil nichts
 * Inhaltliches mitgeschrieben wird, ist die Ausgabe unbedenklich
 * weiterzugeben.
 *
 * Aufruf:
 *   node scripts/zeitstempel-export.mjs <result.json> [zeitstempel.json]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument) {
  throw new Error('Aufruf: node scripts/zeitstempel-export.mjs <result.json> [zeitstempel.json]');
}
const outputPath = resolve(outputArgument || 'zeitstempel.json');

/** Sekunden-Zeitstempel, tolerant gegenüber Zahl, Ziffernstring und ISO-Text. */
function seconds(message) {
  const raw = message?.date_unixtime ?? message?.timestamp ?? message?.date;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.floor(raw > 1e12 ? raw / 1000 : raw);
  }
  if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
    const value = Number(raw);
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/** Nur der Anzeigename, nie eine ID — und nie ein Inhalt. */
function fromName(message) {
  const value = message?.from;
  return typeof value === 'string' && value ? value : null;
}

const chat = JSON.parse(await readFile(resolve(inputArgument), 'utf8'));
const messages = Array.isArray(chat) ? chat : chat?.messages;
if (!Array.isArray(messages)) {
  throw new Error('Der Export enthält keine Nachrichtenliste (erwartet: { "messages": [...] }).');
}

// Bewusst KEIN Filter: Reihenfolge und Menge bleiben wie im Original, damit
// die Pausenverteilung exakt dem echten Verlauf entspricht.
const output = messages.map((message) => ({ t: seconds(message), from: fromName(message) }));

await writeFile(outputPath, `${JSON.stringify(output)}\n`, 'utf8');

const withTimestamp = output.filter((entry) => entry.t !== null);
const speakers = new Map();
for (const entry of output) {
  const key = entry.from ?? '(ohne Absender)';
  speakers.set(key, (speakers.get(key) || 0) + 1);
}

console.log(`geschrieben: ${outputPath}`);
console.log(`Nachrichten gesamt: ${output.length}`);
console.log(`davon mit gültigem Zeitstempel: ${withTimestamp.length}`);
console.log(`ohne gültigen Zeitstempel (t=null): ${output.length - withTimestamp.length}`);
for (const [name, count] of [...speakers].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name}: ${count}`);
}
if (withTimestamp.length > 1) {
  const first = withTimestamp[0].t;
  const last = withTimestamp[withTimestamp.length - 1].t;
  console.log(`Zeitraum: ${new Date(first * 1000).toISOString()} bis ${new Date(last * 1000).toISOString()}`);
}
