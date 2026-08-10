/**
 * Schlüsselt die Abweichungen zwischen Automatik und gemeinsamer Fassung auf.
 *
 * 1. "nur Automatik": nach welcher Regel ist die Grenze entstanden?
 * 2. "nur gemeinsam": welchen Entscheidungsgrund hat der Algorithmus an genau
 *    dieser Stelle geliefert, und wie groß war der Zeitabstand?
 *
 * Der Anlass wird über den Entscheidungsgrund und die Ereignisart beschrieben,
 * nie über den Nachrichtentext. Ausgabe sind ausschließlich Zahlen und
 * Regelnamen.
 *
 * Aufruf: node scripts/fehleranalyse.mjs <rounds> <chunks> <marks> <submissions>
 */
import { readFileSync } from 'node:fs';
import { compareReviewers, combinedBoundary, pairSeams, toSegmentationInput } from '../boundary-pairs-logic.mjs';
import { segmentConversationWindow } from '../segmentation-v4.mjs';

const [roundsPath, chunksPath, marksPath, submissionsPath] = process.argv.slice(2);
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

function gapBucket(minutes) {
  if (!Number.isFinite(minutes)) return 'unbekannt';
  if (minutes < 15) return '< 15 Min';
  if (minutes < 60) return '15–60 Min';
  if (minutes < 240) return '1–4 Std';
  if (minutes < 720) return '4–12 Std';
  return '> 12 Std';
}
function formatGap(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 60) return `${minutes.toFixed(0)} Min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} Std`;
  return `${(minutes / 1440).toFixed(1)} Tage`;
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
  .filter(([, r]) => r.has('Philipp') && r.has('Lena'))
  .map(([round]) => round)
  .sort((a, b) => a - b);

const onlyAutoReasons = new Map();
const onlyAutoGaps = new Map();
const missedReasons = new Map();
const missedBuckets = new Map();
const missedRows = [];
let pairsTotal = 0;
let onlyAutoTotal = 0;
let missedTotal = 0;
const pairedReasons = new Map();

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
  const combined = combinedBoundary(comparison);

  const automaticResult = segmentConversationWindow(toSegmentationInput(messages));
  const reasonByPosition = new Map();
  for (const boundary of automaticResult.boundaries) {
    const position = positions.get(boundary.beforeEventId);
    if (position !== undefined) reasonByPosition.set(position, boundary);
  }
  const decisionByPosition = new Map();
  for (const decision of automaticResult.decisions) {
    const position = positions.get(decision.beforeEventId);
    if (position !== undefined) decisionByPosition.set(position, decision);
  }

  const automaticPositions = [...reasonByPosition.keys()].sort((a, b) => a - b);
  const vs = pairSeams(automaticPositions, combined.cuts, TOLERANCE);
  pairsTotal += vs.pairs.length;
  onlyAutoTotal += vs.onlyA.length;
  missedTotal += vs.onlyB.length;

  for (const [autoPosition] of vs.pairs) {
    const boundary = reasonByPosition.get(autoPosition);
    if (boundary) pairedReasons.set(boundary.reason, (pairedReasons.get(boundary.reason) || 0) + 1);
  }

  for (const position of vs.onlyA) {
    const boundary = reasonByPosition.get(position);
    if (!boundary) continue;
    onlyAutoReasons.set(boundary.reason, (onlyAutoReasons.get(boundary.reason) || 0) + 1);
    const bucket = gapBucket(boundary.gapMinutes);
    onlyAutoGaps.set(bucket, (onlyAutoGaps.get(bucket) || 0) + 1);
  }

  for (const position of vs.onlyB) {
    const decision = decisionByPosition.get(position);
    const current = messages[position];
    const previous = messages[position - 1];
    const gapMinutes = decision?.gapMinutes ?? (current && previous ? (current.t - previous.t) / 60 : NaN);
    const reason = decision?.reason ?? 'keine Entscheidung';
    missedReasons.set(reason, (missedReasons.get(reason) || 0) + 1);
    missedBuckets.set(gapBucket(gapMinutes), (missedBuckets.get(gapBucket(gapMinutes)) || 0) + 1);
    missedRows.push({
      round,
      position,
      gap: formatGap(gapMinutes),
      reason,
      kind: current?.kind ?? '?',
      sprecherwechsel: previous && current ? (previous.from !== current.from ? 'ja' : 'nein') : '?',
    });
  }
}

console.log(`Runden: ${readyRounds.length} | getroffen ${pairsTotal} | nur Automatik ${onlyAutoTotal} | nur gemeinsam ${missedTotal}\n`);

console.log('=== 1. "nur Automatik" — nach welcher Regel entstanden? ===');
const ruleLabel = {
  new_contact_attempt_after_pause: 'Anruf nach Pause',
  new_greeting_after_pause: 'Begrüßung nach Pause',
  previous_conversation_explicitly_closed: 'Abschluss davor',
  independent_opener_after_pause: 'Eigenständiger Einstieg',
  new_media_contact_after_long_pause: 'Medien nach langer Pause',
};
for (const [reason, count] of [...onlyAutoReasons].sort((a, b) => b[1] - a[1])) {
  const treffer = pairedReasons.get(reason) || 0;
  const gesamt = treffer + count;
  console.log(
    `  ${(ruleLabel[reason] || reason).padEnd(26)}: ${String(count).padStart(3)} daneben von ${String(gesamt).padStart(3)} `
    + `(Trefferquote ${gesamt ? (100 * treffer / gesamt).toFixed(0) : '—'}%)`,
  );
}
console.log('  Zeitabstand der Fehlalarme:');
for (const [bucket, count] of [...onlyAutoGaps].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${bucket.padEnd(12)}: ${count}`);
}

console.log('\n=== 2. "nur gemeinsam" — warum fand die Automatik nichts? ===');
for (const [reason, count] of [...missedReasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(30)}: ${count}`);
}
console.log('  Zeitabstand der übersehenen Grenzen:');
for (const [bucket, count] of [...missedBuckets].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${bucket.padEnd(12)}: ${count}`);
}

console.log('\n  Einzelfälle:');
console.log('  Runde | Pos | Abstand    | Grund des Algorithmus           | Art    | Sprecherwechsel');
console.log('  ------+-----+------------+---------------------------------+--------+----------------');
for (const r of missedRows) {
  console.log(
    `  ${String(r.round).padStart(5)} | ${String(r.position).padStart(3)} | ${r.gap.padEnd(10)} | `
    + `${r.reason.padEnd(31)} | ${r.kind.padEnd(6)} | ${r.sprecherwechsel}`,
  );
}
