/**
 * Experiment: Wie stark bremst recentOpenQuestion?
 *
 * Variiert AUSSCHLIESSLICH die Fenstergröße von recentOpenQuestion
 * (inspected < N) und misst je Wert die Automatik gegen die gemeinsame
 * Fassung über alle Runden mit beidseitiger Abgabe.
 *
 * segmentation-v4.mjs selbst wird NICHT verändert: für jeden Wert wird eine
 * Kopie des Moduls mit genau dieser einen ersetzten Zahl nach /tmp geschrieben
 * und dynamisch geladen. Der Unterschied zwischen den Läufen ist damit
 * nachweislich nur dieser Parameter — das Skript prüft das auch.
 *
 * Gibt ausschließlich Zahlen aus, nie Nachrichtentext.
 *
 * Aufruf: node scripts/experiment-openquestion.mjs <rounds> <chunks> <marks> <submissions>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { compareReviewers, combinedBoundary, pairSeams, toSegmentationInput } from '../boundary-pairs-logic.mjs';

const [roundsPath, chunksPath, marksPath, submissionsPath] = process.argv.slice(2);

const TOLERANCE = 0;
const DOUBT_MODE = 'skip';
const LOOKBACKS = [8, 4, 2, 1];
const ORIGINAL = 'inspected < 8';

// ---------------------------------------- 1:1 aus worker-boundary-pairs.ts
function rawId(message) {
  const id = message.id;
  return id === undefined || id === null ? '' : String(id);
}
function flattenText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
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
  const action = String(message.action || message.action_type || message.service_type || message.message_type || '');
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
function toPositionalMarks(rows, positions) {
  const out = [];
  for (const row of rows) {
    const position = positions.get(row.seam_message_id);
    if (position !== undefined) out.push({ position, mark: row.mark });
  }
  return out;
}

// ------------------------------------------------------------ Daten laden
const rowsOf = (path) => JSON.parse(readFileSync(path, 'utf8'))[0]?.results || [];
const rounds = rowsOf(roundsPath);
const marks = rowsOf(marksPath);
const submissions = rowsOf(submissionsPath);

let all = [];
for (const row of rowsOf(chunksPath)) {
  const parsed = JSON.parse(row.messages_json);
  if (Array.isArray(parsed)) all = all.concat(parsed);
}
const sequence = all.filter((m) => m && typeof m === 'object' && isReviewable(m));

const byRound = new Map();
for (const row of submissions) {
  if (!byRound.has(row.round)) byRound.set(row.round, new Set());
  byRound.get(row.round).add(row.reviewer);
}
const readyRounds = [...byRound.entries()]
  .filter(([, reviewers]) => reviewers.has('Philipp') && reviewers.has('Lena'))
  .map(([round]) => round)
  .sort((a, b) => a - b);

console.log(`gefilterte Gesamtfolge: ${sequence.length} Nachrichten`);
console.log(`Runden mit beidseitiger Abgabe: ${readyRounds.length}`);
console.log(`Toleranz ${TOLERANCE}, doubt=${DOUBT_MODE}\n`);

// Die Fenster und die gemeinsame Fassung hängen NICHT vom Parameter ab —
// einmal berechnet, für alle Varianten identisch.
const perRound = [];
for (const round of readyRounds) {
  const row = rounds.find((r) => Number(r.round) === Number(round));
  if (!row) continue;
  const startIndex = sequence.findIndex((m) => rawId(m) === String(row.first_message_id));
  if (startIndex < 0) continue;
  const messages = sequence.slice(startIndex, startIndex + row.message_count).map(toView);
  const positions = seamPositions(messages);
  const comparison = compareReviewers(
    toPositionalMarks(marks.filter((m) => Number(m.round) === Number(round) && m.reviewer === 'Philipp'), positions),
    toPositionalMarks(marks.filter((m) => Number(m.round) === Number(round) && m.reviewer === 'Lena'), positions),
    { totalSeams: Math.max(0, messages.length - 1), tolerance: TOLERANCE, doubtMode: DOUBT_MODE },
  );
  perRound.push({ round, messages, positions, combined: combinedBoundary(comparison) });
}

// ------------------------------------------- Varianten des Moduls erzeugen
const source = readFileSync(new URL('../segmentation-v4.mjs', import.meta.url), 'utf8');
const occurrences = source.split(ORIGINAL).length - 1;
if (occurrences !== 1) {
  throw new Error(`Erwartet genau ein Vorkommen von "${ORIGINAL}", gefunden: ${occurrences}`);
}

async function loadVariant(lookback) {
  const variant = source.replace(ORIGINAL, `inspected < ${lookback}`);
  // Beweis, dass sich wirklich nur diese eine Stelle unterscheidet.
  if (variant.length - source.length !== String(lookback).length - 1) {
    throw new Error('unerwartete Abweichung in der Variante');
  }
  const path = `/tmp/segmentation-lookback-${lookback}.mjs`;
  writeFileSync(path, variant, 'utf8');
  return (await import(path)).segmentConversationWindow;
}

// --------------------------------------------------------------- Messung
const results = [];
for (const lookback of LOOKBACKS) {
  const segment = await loadVariant(lookback);
  let pairs = 0;
  let onlyAuto = 0;
  let onlyCombined = 0;
  let automatic = 0;
  const rows = [];

  for (const entry of perRound) {
    const automaticResult = segment(toSegmentationInput(entry.messages));
    const automaticPositions = automaticResult.boundaries
      .map((boundary) => entry.positions.get(boundary.beforeEventId))
      .filter((position) => position !== undefined);
    const vs = pairSeams(automaticPositions, entry.combined.cuts, TOLERANCE);
    pairs += vs.pairs.length;
    onlyAuto += vs.onlyA.length;
    onlyCombined += vs.onlyB.length;
    automatic += automaticResult.boundaries.length;
    rows.push({ round: entry.round, automatic: automaticResult.boundaries.length, hits: vs.pairs.length });
  }

  const total = 2 * pairs + onlyAuto + onlyCombined;
  results.push({
    lookback,
    automatic,
    pairs,
    onlyAuto,
    onlyCombined,
    f1: total ? (2 * pairs) / total : null,
    rows,
  });
}

console.log('Fenster | Grenzen | getroffen | zu viele | übersehen | F1 Autom./gemeinsam');
console.log('--------+---------+-----------+----------+-----------+--------------------');
for (const r of results) {
  console.log(
    `${String(r.lookback).padStart(7)} | ${String(r.automatic).padStart(7)} | ${String(r.pairs).padStart(9)} | `
    + `${String(r.onlyAuto).padStart(8)} | ${String(r.onlyCombined).padStart(9)} | `
    + `${(r.f1 === null ? '—' : r.f1.toFixed(4)).padStart(19)}`,
  );
}

console.log('\nGefundene Grenzen je Runde:');
console.log(`Runde      | ${perRound.map((e) => String(e.round).padStart(4)).join(' |')}`);
console.log(`gemeinsam  | ${perRound.map((e) => String(e.combined.cuts.length).padStart(4)).join(' |')}`);
for (const r of results) {
  console.log(`Fenster ${String(r.lookback).padStart(2)} | ${r.rows.map((x) => String(x.automatic).padStart(4)).join(' |')}`);
}
