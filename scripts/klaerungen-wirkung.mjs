/**
 * Misst, was die geklärten Streitfälle an den Kennzahlen ändern.
 *
 * Rechnet dieselben Runden zweimal: einmal mit der rohen gemeinsamen Fassung
 * (nur ursprüngliche Markierungen) und einmal mit der geklärten (Auflösungen
 * eingerechnet). Die Inter-Rater-Zahl wird zusätzlich in beiden Läufen
 * ausgegeben, um zu belegen, dass sie sich NICHT verändert.
 *
 * Ausgabe sind ausschließlich Zahlen.
 *
 * Aufruf: node scripts/klaerungen-wirkung.mjs <rounds> <chunks> <marks> <submissions> <resolutions>
 */
import { readFileSync } from 'node:fs';
import {
  compareReviewers,
  combinedBoundary,
  pairSeams,
  toSegmentationInput,
  toPositionalResolutions,
} from '../boundary-pairs-logic.mjs';
import { segmentConversationWindow } from '../segmentation-v4.mjs';

const [roundsPath, chunksPath, marksPath, submissionsPath, resolutionsPath] = process.argv.slice(2);
const TOLERANCE = 0;
const DOUBT_MODE = 'skip';

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
const resolutionsAll = rowsOf(resolutionsPath);

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
  .filter(([, r]) => r.has('Philipp') && r.has('Lena'))
  .map(([round]) => round)
  .sort((a, b) => a - b);

const decisionCounts = new Map();
for (const row of resolutionsAll) decisionCounts.set(row.decision, (decisionCounts.get(row.decision) || 0) + 1);
console.log(`Auflösungen gesamt: ${resolutionsAll.length}`);
for (const [decision, count] of [...decisionCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${decision}: ${count}`);
}
console.log(`Runden mit beidseitiger Abgabe: ${readyRounds.length}\n`);

const totals = {
  roh: { pairs: 0, onlyAuto: 0, onlyCombined: 0, cuts: 0, uncertain: 0 },
  geklaert: { pairs: 0, onlyAuto: 0, onlyCombined: 0, cuts: 0, uncertain: 0 },
};
let interPairs = 0;
let interOnlyA = 0;
let interOnlyB = 0;
const rows = [];

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
  interPairs += comparison.pairs.length;
  interOnlyA += comparison.onlyA.length;
  interOnlyB += comparison.onlyB.length;

  const roundResolutions = toPositionalResolutions(
    resolutionsAll.filter((r) => Number(r.round) === Number(round)),
    positions,
  );

  const automaticResult = segmentConversationWindow(toSegmentationInput(messages));
  const automaticPositions = automaticResult.boundaries
    .map((boundary) => positions.get(boundary.beforeEventId))
    .filter((position) => position !== undefined);

  const variants = {
    roh: combinedBoundary(comparison),
    geklaert: combinedBoundary(comparison, roundResolutions),
  };
  const rowOut = { round, resolutions: roundResolutions.length };
  for (const [name, combined] of Object.entries(variants)) {
    const vs = pairSeams(automaticPositions, combined.cuts, TOLERANCE);
    totals[name].pairs += vs.pairs.length;
    totals[name].onlyAuto += vs.onlyA.length;
    totals[name].onlyCombined += vs.onlyB.length;
    totals[name].cuts += combined.cuts.length;
    totals[name].uncertain += combined.uncertain.length;
    rowOut[name] = { cuts: combined.cuts.length, hits: vs.pairs.length };
  }
  rows.push(rowOut);
}

const f1 = (t) => {
  const total = 2 * t.pairs + t.onlyAuto + t.onlyCombined;
  return total ? (2 * t.pairs) / total : null;
};
const interTotal = 2 * interPairs + interOnlyA + interOnlyB;

console.log('=== Gemeinsame Fassung ===');
console.log(`                       roh   geklärt`);
console.log(`Grenzen             : ${String(totals.roh.cuts).padStart(4)}   ${String(totals.geklaert.cuts).padStart(7)}`);
console.log(`noch unsicher       : ${String(totals.roh.uncertain).padStart(4)}   ${String(totals.geklaert.uncertain).padStart(7)}`);
console.log('\n=== Automatik gegen gemeinsame Fassung ===');
console.log(`                       roh   geklärt`);
console.log(`getroffen           : ${String(totals.roh.pairs).padStart(4)}   ${String(totals.geklaert.pairs).padStart(7)}`);
console.log(`nur Automatik       : ${String(totals.roh.onlyAuto).padStart(4)}   ${String(totals.geklaert.onlyAuto).padStart(7)}`);
console.log(`nur gemeinsam       : ${String(totals.roh.onlyCombined).padStart(4)}   ${String(totals.geklaert.onlyCombined).padStart(7)}`);
console.log(`F1                  : ${f1(totals.roh).toFixed(4)}   ${f1(totals.geklaert).toFixed(4)}`);
console.log('\n=== Übereinstimmung Philipp/Lena (muss unberührt bleiben) ===');
console.log(`F1: ${(2 * interPairs / interTotal).toFixed(4)}  — von den Auflösungen unabhängig berechnet`);

console.log('\nJe Runde (Grenzen der gemeinsamen Fassung / davon von der Automatik getroffen):');
console.log('Runde | Auflösungen |   roh    | geklärt');
console.log('------+-------------+----------+---------');
for (const r of rows) {
  console.log(
    `${String(r.round).padStart(5)} | ${String(r.resolutions).padStart(11)} | `
    + `${String(`${r.roh.cuts} / ${r.roh.hits}`).padStart(8)} | ${String(`${r.geklaert.cuts} / ${r.geklaert.hits}`).padStart(7)}`,
  );
}
