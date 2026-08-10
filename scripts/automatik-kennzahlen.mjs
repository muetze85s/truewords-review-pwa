/**
 * Rechnet die Kennzahlen der Übersicht (GET /api/agreement/summary) gegen die
 * echten Produktionsdaten nach und gibt AUSSCHLIESSLICH Zahlen aus.
 *
 * Die eigentliche Auswertung kommt aus denselben Modulen wie im Worker
 * (boundary-pairs-logic.mjs samt toSegmentationInput, segmentation-v4.mjs);
 * nachgebaut sind nur die D1-Ladefunktionen und toView aus
 * worker-boundary-pairs.ts.
 *
 * Aufruf: node scripts/automatik-kennzahlen.mjs <rounds> <chunks> <marks> <submissions>
 */
import { readFileSync } from 'node:fs';
import {
  compareReviewers,
  combinedBoundary,
  pairSeams,
  toSegmentationInput,
} from '../boundary-pairs-logic.mjs';
import { segmentConversationWindow } from '../segmentation-v4.mjs';

const [roundsPath, chunksPath, marksPath, submissionsPath] = process.argv.slice(2);

// Genau die Vorgaben, mit denen die Übersicht ohne Parameter rechnet:
// parseTolerance liest Number(null) === 0, und 0 ist erlaubt — die Vorgabe ist
// also 0, nicht 1. parseDoubtMode liefert 'skip'.
const TOLERANCE = 0;
const DOUBT_MODE = 'skip';

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
console.log(`gefilterte Gesamtfolge (ganzer Chat): ${sequence.length} Nachrichten`);

const byRound = new Map();
for (const row of submissions) {
  if (!byRound.has(row.round)) byRound.set(row.round, new Set());
  byRound.get(row.round).add(row.reviewer);
}
const readyRounds = [...byRound.entries()]
  .filter(([, reviewers]) => reviewers.has('Philipp') && reviewers.has('Lena'))
  .map(([round]) => round)
  .sort((a, b) => a - b);
console.log(`Runden mit beidseitiger Abgabe: ${readyRounds.length}\n`);

let totalPairs = 0;
let totalOnlyPhilipp = 0;
let totalOnlyLena = 0;
let totalAutoPairs = 0;
let totalAutoOnlyAuto = 0;
let totalAutoOnlyCombined = 0;
let totalAutomatic = 0;

const pad = (value, width) => String(value).padStart(width);
console.log('Runde | Autom. | Philipp | Lena | gemeinsam | Autom-Treffer | F1 Autom/gemeinsam | F1 P/L | kappa');
console.log('------+--------+---------+------+-----------+---------------+--------------------+--------+-------');

for (const round of readyRounds) {
  const row = rounds.find((r) => Number(r.round) === Number(round));
  if (!row) continue;
  const startIndex = sequence.findIndex((m) => rawId(m) === String(row.first_message_id));
  if (startIndex < 0) {
    console.log(`Runde ${round}: Startpunkt nicht gefunden`);
    continue;
  }
  const messages = sequence.slice(startIndex, startIndex + row.message_count).map(toView);
  const positions = seamPositions(messages);
  const totalSeams = Math.max(0, messages.length - 1);

  const philippRows = marks.filter((m) => Number(m.round) === Number(round) && m.reviewer === 'Philipp');
  const lenaRows = marks.filter((m) => Number(m.round) === Number(round) && m.reviewer === 'Lena');

  const comparison = compareReviewers(
    toPositionalMarks(philippRows, positions),
    toPositionalMarks(lenaRows, positions),
    { totalSeams, tolerance: TOLERANCE, doubtMode: DOUBT_MODE },
  );
  const combined = combinedBoundary(comparison);

  const automaticResult = segmentConversationWindow(toSegmentationInput(messages));
  const automaticPositions = automaticResult.boundaries
    .map((boundary) => positions.get(boundary.beforeEventId))
    .filter((position) => position !== undefined);
  const vsCombined = pairSeams(automaticPositions, combined.cuts, TOLERANCE);

  totalPairs += comparison.pairs.length;
  totalOnlyPhilipp += comparison.onlyA.length;
  totalOnlyLena += comparison.onlyB.length;
  totalAutoPairs += vsCombined.pairs.length;
  totalAutoOnlyAuto += vsCombined.onlyA.length;
  totalAutoOnlyCombined += vsCombined.onlyB.length;
  totalAutomatic += automaticResult.boundaries.length;

  const autoTotalRound = 2 * vsCombined.pairs.length + vsCombined.onlyA.length + vsCombined.onlyB.length;
  const f1Round = autoTotalRound ? (2 * vsCombined.pairs.length) / autoTotalRound : null;

  console.log(
    `${pad(round, 5)} | ${pad(automaticResult.boundaries.length, 6)} | `
    + `${pad(comparison.pairs.length + comparison.onlyA.length, 7)} | `
    + `${pad(comparison.pairs.length + comparison.onlyB.length, 4)} | `
    + `${pad(combined.cuts.length, 9)} | ${pad(vsCombined.pairs.length, 13)} | `
    + `${pad(f1Round === null ? '—' : f1Round.toFixed(2), 18)} | `
    + `${pad(comparison.agreementF1.toFixed(2), 6)} | ${pad(comparison.kappa.toFixed(2), 5)}`,
  );
}

const humanTotal = 2 * totalPairs + totalOnlyPhilipp + totalOnlyLena;
const autoTotal = 2 * totalAutoPairs + totalAutoOnlyAuto + totalAutoOnlyCombined;
console.log('\n=== Gesamt (wie in der Übersicht) ===');
console.log(`automaticBoundariesTotal      : ${totalAutomatic}`);
console.log(`combinedBoundaries (Paare P/L): ${totalPairs}`);
console.log(`agreementF1 Philipp/Lena      : ${humanTotal ? (2 * totalPairs / humanTotal).toFixed(4) : '—'}`);
console.log(`automaticVsCombined.agreementF1: ${autoTotal ? (2 * totalAutoPairs / autoTotal).toFixed(4) : '—'}`);
console.log(`  Automatik-Treffer gegen gemeinsame Fassung: ${totalAutoPairs}`);
console.log(`  nur Automatik                             : ${totalAutoOnlyAuto}`);
console.log(`  nur gemeinsame Fassung                    : ${totalAutoOnlyCombined}`);
