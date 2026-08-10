/**
 * Fehleraufschlüsselung gegen die GEKLÄRTE gemeinsame Fassung — und zum
 * Vergleich gegen die rohe, damit die Verschiebung sichtbar wird.
 *
 * 1. "nur Automatik": nach welcher Regel entstanden, mit Trefferquote.
 * 2. "nur gemeinsam": Entscheidungsgrund des Algorithmus und Zeitabstand.
 *
 * Der Anlass wird über Regelnamen, Ereignisart und Zeitabstand beschrieben,
 * nie über den Nachrichtentext.
 *
 * Aufruf: node scripts/fehleranalyse-geklaert.mjs <rounds> <chunks> <marks> <submissions> <resolutions>
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

const stats = {
  roh: { hit: new Map(), miss: new Map() },
  geklaert: { hit: new Map(), miss: new Map() },
};
const missedReasons = new Map();
const missedBuckets = new Map();
const missedRows = [];
const falseAlarmBuckets = new Map();
let totals = { roh: { p: 0, a: 0, c: 0 }, geklaert: { p: 0, a: 0, c: 0 } };

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
  const roundResolutions = toPositionalResolutions(
    resolutionsAll.filter((r) => Number(r.round) === Number(round)),
    positions,
  );

  const automaticResult = segmentConversationWindow(toSegmentationInput(messages));
  const boundaryByPosition = new Map();
  for (const boundary of automaticResult.boundaries) {
    const position = positions.get(boundary.beforeEventId);
    if (position !== undefined) boundaryByPosition.set(position, boundary);
  }
  const decisionByPosition = new Map();
  for (const decision of automaticResult.decisions) {
    const position = positions.get(decision.beforeEventId);
    if (position !== undefined) decisionByPosition.set(position, decision);
  }
  const automaticPositions = [...boundaryByPosition.keys()].sort((a, b) => a - b);

  const variants = {
    roh: combinedBoundary(comparison),
    geklaert: combinedBoundary(comparison, roundResolutions),
  };

  for (const [name, combined] of Object.entries(variants)) {
    const vs = pairSeams(automaticPositions, combined.cuts, TOLERANCE);
    totals[name].p += vs.pairs.length;
    totals[name].a += vs.onlyA.length;
    totals[name].c += vs.onlyB.length;
    for (const [autoPosition] of vs.pairs) {
      const boundary = boundaryByPosition.get(autoPosition);
      if (boundary) stats[name].hit.set(boundary.reason, (stats[name].hit.get(boundary.reason) || 0) + 1);
    }
    for (const position of vs.onlyA) {
      const boundary = boundaryByPosition.get(position);
      if (!boundary) continue;
      stats[name].miss.set(boundary.reason, (stats[name].miss.get(boundary.reason) || 0) + 1);
      if (name === 'geklaert') {
        const bucket = gapBucket(boundary.gapMinutes);
        falseAlarmBuckets.set(bucket, (falseAlarmBuckets.get(bucket) || 0) + 1);
      }
    }
    if (name !== 'geklaert') continue;
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
        gap: formatGap(gapMinutes),
        reason,
        kind: current?.kind ?? '?',
        wechsel: previous && current ? (previous.from !== current.from ? 'ja' : 'nein') : '?',
        geklaert: roundResolutions.some((r) => r.position === position && r.decision === 'cut') ? 'ja' : 'nein',
      });
    }
  }
}

const f1 = (t) => {
  const total = 2 * t.p + t.a + t.c;
  return total ? (2 * t.p) / total : null;
};
console.log(`Runden: ${readyRounds.length}`);
console.log(`roh      : getroffen ${totals.roh.p}, nur Automatik ${totals.roh.a}, nur gemeinsam ${totals.roh.c}, F1 ${f1(totals.roh).toFixed(4)}`);
console.log(`geklärt  : getroffen ${totals.geklaert.p}, nur Automatik ${totals.geklaert.a}, nur gemeinsam ${totals.geklaert.c}, F1 ${f1(totals.geklaert).toFixed(4)}\n`);

const label = {
  new_contact_attempt_after_pause: 'Anruf nach Pause',
  new_greeting_after_pause: 'Begrüßung nach Pause',
  previous_conversation_explicitly_closed: 'Abschluss davor',
  independent_opener_after_pause: 'Eigenständiger Einstieg',
  new_media_contact_after_long_pause: 'Medien nach langer Pause',
};
const allReasons = new Set([
  ...stats.geklaert.hit.keys(), ...stats.geklaert.miss.keys(),
  ...stats.roh.hit.keys(), ...stats.roh.miss.keys(),
]);

console.log('=== 1. Trefferquote je Regel: roh vs. geklärt ===');
console.log('Regel                      | roh Treffer/gesamt  Quote | geklärt Treffer/gesamt  Quote');
console.log('---------------------------+---------------------------+------------------------------');
for (const reason of allReasons) {
  const rh = stats.roh.hit.get(reason) || 0;
  const rm = stats.roh.miss.get(reason) || 0;
  const gh = stats.geklaert.hit.get(reason) || 0;
  const gm = stats.geklaert.miss.get(reason) || 0;
  const rq = rh + rm ? `${(100 * rh / (rh + rm)).toFixed(0)}%` : '—';
  const gq = gh + gm ? `${(100 * gh / (gh + gm)).toFixed(0)}%` : '—';
  console.log(
    `${(label[reason] || reason).padEnd(26)} | ${String(`${rh}/${rh + rm}`).padStart(16)}  ${rq.padStart(5)} | `
    + `${String(`${gh}/${gh + gm}`).padStart(20)}  ${gq.padStart(5)}`,
  );
}
console.log('\n  Zeitabstand der verbliebenen Fehlalarme (geklärt):');
for (const [bucket, count] of [...falseAlarmBuckets].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${bucket.padEnd(12)}: ${count}`);
}

console.log('\n=== 2. "nur gemeinsam" gegen die geklärte Fassung ===');
for (const [reason, count] of [...missedReasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.padEnd(30)}: ${count}`);
}
console.log('  Zeitabstand:');
for (const [bucket, count] of [...missedBuckets].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${bucket.padEnd(12)}: ${count}`);
}
console.log('\n  Einzelfälle (Spalte "geklärt" = erst durch eure Klärung zur Grenze geworden):');
console.log('  Runde | Abstand    | Grund des Algorithmus           | Art    | Wechsel | geklärt');
console.log('  ------+------------+---------------------------------+--------+---------+--------');
for (const r of missedRows) {
  console.log(
    `  ${String(r.round).padStart(5)} | ${r.gap.padEnd(10)} | ${r.reason.padEnd(31)} | `
    + `${r.kind.padEnd(6)} | ${r.wechsel.padEnd(7)} | ${r.geklaert}`,
  );
}
