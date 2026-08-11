/**
 * Fährt den kompletten Server-Pfad einer Runde gegen die Produktionsdaten:
 * filteredSequence → loadRoundWindow → toView → seamPositions → buildRoundView
 * und zusätzlich den Schreibpfad von putMarks.
 *
 * Die Hilfsfunktionen sind wortgleich aus src/worker-boundary-pairs.ts kopiert;
 * das Skript prüft das beim Start, indem es die Quelle liest und die kopierten
 * Zeilen darin wiederfindet. Schlägt das fehl, bricht es ab, statt eine
 * veraltete Kopie zu messen.
 *
 * Gibt bei jedem Fehler den vollständigen Stacktrace aus, dazu die FELDTYPEN
 * der auslösenden Nachricht — niemals Nachrichteninhalte.
 *
 * Aufruf: node scripts/diagnose-runde.mjs <rounds> <chunks> <runde>
 */
import { readFileSync } from 'node:fs';
import { pickRoundStart, buildRoundView } from '../boundary-pairs-logic.mjs';

const [roundsPath, chunksPath, roundArg] = process.argv.slice(2);
const ROUND = Number(roundArg || 14);
const ROUND_WINDOW_SIZE = 100;
const MAX_MARKS_PER_ROUND = 60;

// ---------------------------------------- wortgleich aus dem Worker kopiert
function rawId(message) {
  const id = message.id;
  return id === undefined || id === null ? '' : String(id);
}
function flattenText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof part.text === 'string') {
      return part.text;
    }
    return '';
  }).join('');
}
function messageSeconds(message) {
  const raw = message.date_unixtime ?? message.date;
  if (typeof raw === 'number') return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
    const value = Number(raw);
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}
function isForwarded(message) {
  return Boolean(message.forwarded_from || message.forwarded_from_id || message.saved_from);
}
function isSticker(message) {
  if (message.sticker_emoji) return true;
  return /sticker/u.test(String(message.media_type || '').toLowerCase());
}
function isCallAction(action) {
  return /^(phone_call|video_call|voice_call)$/u.test(action.toLowerCase());
}
function isService(message) {
  const type = String(message.type || 'message');
  if (type === 'message') return false;
  const action = String(
    message.action || message.action_type || message.service_type || message.message_type || '',
  );
  return !isCallAction(action);
}
function isReviewable(message) {
  return !isForwarded(message) && !isSticker(message) && !isService(message);
}
function toView(message) {
  const action = String(message.action || message.service_type || '').toLowerCase();
  const kind = isCallAction(action)
    ? 'anruf'
    : (message.photo || message.file || message.media_type || message.mime_type)
      ? 'medien'
      : (flattenText(message.text).trim() ? 'text' : 'leer');
  const replyTo = message.reply_to_message_id;
  return {
    id: rawId(message),
    from: String(message.from || message.actor || message.sender || '?'),
    t: messageSeconds(message),
    text: String(message.truewords_original_text || flattenText(message.text) || '').trim(),
    kind,
    ...(replyTo === undefined || replyTo === null ? {} : { replyToId: String(replyTo) }),
  };
}
function seamPositions(messages) {
  const map = new Map();
  for (let index = 1; index < messages.length; index += 1) map.set(messages[index].id, index);
  return map;
}

// ------------------------------------------- Kopie gegen die Quelle prüfen
const workerSource = readFileSync(new URL('../src/worker-boundary-pairs.ts', import.meta.url), 'utf8');
const mustContain = [
  "const raw = (message.date_unixtime ?? message.date) as unknown;",
  "const action = String(message.action || message.service_type || '').toLowerCase();",
  "...(replyTo === undefined || replyTo === null ? {} : { replyToId: String(replyTo) }),",
  "for (let index = 1; index < messages.length; index += 1) map.set(messages[index].id, index);",
];
for (const needle of mustContain) {
  if (!workerSource.includes(needle)) {
    throw new Error(`Kopie veraltet — im Worker nicht gefunden: ${needle}`);
  }
}
const lineOf = (needle) => workerSource.slice(0, workerSource.indexOf(needle)).split('\n').length;
console.log('Kopie stimmt mit src/worker-boundary-pairs.ts überein.');
console.log(`  messageSeconds  -> Zeile ${lineOf(mustContain[0])}`);
console.log(`  toView          -> Zeile ${lineOf(mustContain[1])}`);
console.log(`  replyToId       -> Zeile ${lineOf(mustContain[2])}`);
console.log(`  seamPositions   -> Zeile ${lineOf(mustContain[3])}\n`);

/** Feldtypen einer Nachricht — nie Inhalte. */
function shapeOf(message) {
  const shape = {};
  for (const [key, value] of Object.entries(message || {})) {
    shape[key] = Array.isArray(value) ? `array(${value.length})` : (value === null ? 'null' : typeof value);
  }
  return shape;
}

function report(label, error, message, index) {
  console.log(`\n!!! FEHLER in ${label}${index === undefined ? '' : ` bei Index ${index}`}`);
  console.log(`    ${error.constructor.name}: ${error.message}`);
  console.log(`    Stack:\n${String(error.stack).split('\n').map((l) => `      ${l}`).join('\n')}`);
  if (message) {
    console.log(`    id: ${JSON.stringify(message.id)}`);
    console.log(`    Feldtypen: ${JSON.stringify(shapeOf(message))}`);
  }
}

// --------------------------------------------------------------- Ausführen
const rowsOf = (path) => JSON.parse(readFileSync(path, 'utf8'))[0]?.results || [];
const rounds = rowsOf(roundsPath);

let all = [];
let parseFehler = 0;
for (const row of rowsOf(chunksPath)) {
  try {
    const parsed = JSON.parse(row.messages_json);
    if (Array.isArray(parsed)) all = all.concat(parsed);
  } catch (error) {
    parseFehler += 1;
    report('JSON.parse eines Chunks', error);
  }
}
console.log(`Rohnachrichten: ${all.length}, Chunk-Parsefehler: ${parseFehler}`);

// isReviewable über alles — findet Ausreißer, die schon beim Filtern kippen.
const sequence = [];
let filterFehler = 0;
all.forEach((message, index) => {
  try {
    if (message && typeof message === 'object' && isReviewable(message)) sequence.push(message);
  } catch (error) {
    filterFehler += 1;
    if (filterFehler <= 5) report('isReviewable', error, message, index);
  }
});
console.log(`gefilterte Folge: ${sequence.length}, Fehler beim Filtern: ${filterFehler}`);

// toView über die GESAMTE Folge — findet jeden krummen Datensatz, nicht nur
// die in Runde ${ROUND}.
let viewFehler = 0;
sequence.forEach((message, index) => {
  try {
    toView(message);
  } catch (error) {
    viewFehler += 1;
    if (viewFehler <= 10) report('toView (gesamte Folge)', error, message, index);
  }
});
console.log(`toView über alle ${sequence.length} Nachrichten: ${viewFehler} Fehler`);

// ------------------------------------------------------ Fenster der Runde
console.log(`\n=== Runde ${ROUND} ===`);
const row = rounds.find((r) => Number(r.round) === ROUND);
console.log(`in review_rounds gespeichert: ${row ? 'ja' : 'NEIN — würde jetzt erst angelegt'}`);

let startIndex = -1;
if (row) {
  console.log(`  first_message_id: ${JSON.stringify(row.first_message_id)} (${typeof row.first_message_id}), message_count: ${row.message_count}`);
  startIndex = sequence.findIndex((m) => rawId(m) === String(row.first_message_id));
  console.log(`  Startpunkt in der Folge: ${startIndex}${startIndex < 0 ? '  <<< NICHT GEFUNDEN — loadRoundWindow würde werfen' : ''}`);
} else {
  try {
    const idIndex = new Map(sequence.map((message, index) => [rawId(message), index]));
    const existingRanges = rounds.map((existing) => {
      const start = idIndex.get(String(existing.first_message_id));
      if (start === undefined) {
        throw new Error(`Bestehende Runde ${existing.round} nicht mehr auffindbar (first_message_id ${existing.first_message_id})`);
      }
      return { start, count: existing.message_count };
    });
    startIndex = pickRoundStart({
      datasetId: 'philena-2026-pilot-v4-unseen',
      round: ROUND,
      sequenceLength: sequence.length,
      windowSize: ROUND_WINDOW_SIZE,
      existingRanges,
    });
    console.log(`  pickRoundStart liefert Startpunkt ${startIndex}`);
  } catch (error) {
    report('pickRoundStart / existingRanges', error);
  }
}

if (startIndex >= 0) {
  const windowRaw = sequence.slice(startIndex, startIndex + (row ? row.message_count : ROUND_WINDOW_SIZE));
  console.log(`  Fenster: ${windowRaw.length} Nachrichten`);

  const messages = [];
  let fensterFehler = 0;
  windowRaw.forEach((message, index) => {
    try {
      messages.push(toView(message));
    } catch (error) {
      fensterFehler += 1;
      report('toView (Fenster)', error, message, index);
    }
  });
  console.log(`  toView im Fenster: ${fensterFehler} Fehler`);

  // Auffälligkeiten im Fenster, die keinen Fehler werfen, aber Folgeprobleme
  // machen können — reine Zahlen.
  const auffaellig = {
    ohneId: messages.filter((m) => !m.id).length,
    tNull: messages.filter((m) => !m.t).length,
    doppelteIds: messages.length - new Set(messages.map((m) => m.id)).size,
    kinds: messages.reduce((acc, m) => ({ ...acc, [m.kind]: (acc[m.kind] || 0) + 1 }), {}),
    mitReplyToId: messages.filter((m) => m.replyToId !== undefined).length,
  };
  console.log(`  Auffälligkeiten: ${JSON.stringify(auffaellig)}`);

  try {
    const positions = seamPositions(messages);
    console.log(`  seamPositions: ${positions.size} Zwischenräume`);
    const view = buildRoundView({
      reviewer: 'Philipp',
      messages,
      philippMarks: [],
      lenaMarks: [],
      philippSubmittedAt: null,
      lenaSubmittedAt: null,
    });
    const serialized = JSON.stringify(view);
    console.log(`  buildRoundView + JSON.stringify: ok, ${serialized.length} Zeichen`);

    // Schreibpfad: putMarks prüft jede seamMessageId gegen positions.
    const beispiel = [...positions.keys()].slice(0, 3).map((seamMessageId) => ({ seamMessageId, mark: 'cut' }));
    let abgelehnt = 0;
    for (const entry of beispiel) {
      const seamMessageId = String(entry.seamMessageId || '');
      const mark = String(entry.mark || '');
      if (!positions.has(seamMessageId) || !['cut', 'doubt'].includes(mark)) abgelehnt += 1;
    }
    console.log(`  putMarks-Prüfung an ${beispiel.length} Beispielen: ${abgelehnt} abgelehnt (max ${MAX_MARKS_PER_ROUND} Markierungen)`);
  } catch (error) {
    report('seamPositions / buildRoundView / putMarks', error);
  }
}

console.log('\nDiagnose beendet.');
