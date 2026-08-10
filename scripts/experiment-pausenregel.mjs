/**
 * Simulation einer zusätzlichen Regel: "Pause >= X Stunden ist eine Grenze".
 *
 * Zwei Einbauorte, weil sie sich stark unterscheiden:
 *   unbedingt  — direkt nach der Gültigkeitsprüfung, also VOR den Sperren
 *                (offene Frage, direkte Antwort, sprachliche Fortsetzung).
 *                Das ist "unabhängig von Muster/Sprecher" im wörtlichen Sinn.
 *   nachrangig — nur dort, wo sonst keine Regel gegriffen hätte, also genau
 *                auf den conversation_continues-Fällen.
 *
 * segmentation-v4.mjs bleibt unangetastet: je Variante wird eine Kopie mit
 * genau dieser einen Einfügung nach /tmp geschrieben und dynamisch geladen.
 *
 * Gemessen wird gegen die GEKLÄRTE gemeinsame Fassung. Nur Zahlen.
 *
 * Aufruf: node scripts/experiment-pausenregel.mjs <rounds> <chunks> <marks> <submissions> <resolutions>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  compareReviewers,
  combinedBoundary,
  pairSeams,
  toSegmentationInput,
  toPositionalResolutions,
} from '../boundary-pairs-logic.mjs';

const [roundsPath, chunksPath, marksPath, submissionsPath, resolutionsPath] = process.argv.slice(2);
const TOLERANCE = 0;
const DOUBT_MODE = 'skip';
const HOURS = [4, 6, 8, 12];

const ANCHOR_UNCONDITIONAL = "    return { boundary: false, reason: 'invalid_gap', gapMinutes };\n  }\n";
const ANCHOR_FALLBACK = "  return { boundary: false, reason: 'conversation_continues', gapMinutes };";

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

// Fenster und geklärte gemeinsame Fassung sind von der Regel unabhängig.
const prepared = [];
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
  const combined = combinedBoundary(
    comparison,
    toPositionalResolutions(resolutionsAll.filter((r) => Number(r.round) === Number(round)), positions),
  );
  prepared.push({ round, messages, positions, combined });
}

const source = readFileSync(new URL('../segmentation-v4.mjs', import.meta.url), 'utf8');
if (source.split(ANCHOR_UNCONDITIONAL).length - 1 !== 1) throw new Error('Anker "unbedingt" nicht eindeutig');
if (source.split(ANCHOR_FALLBACK).length - 1 !== 1) throw new Error('Anker "nachrangig" nicht eindeutig');

async function loadVariant(kind, hours) {
  let variant;
  const rule = `  if (gapMinutes >= ${hours * 60}) return { boundary: true, reason: 'long_pause', gapMinutes };\n`;
  if (kind === 'unbedingt') {
    variant = source.replace(ANCHOR_UNCONDITIONAL, `${ANCHOR_UNCONDITIONAL}\n${rule}`);
  } else {
    variant = source.replace(ANCHOR_FALLBACK, `${rule}${ANCHOR_FALLBACK}`);
  }
  if (variant === source) throw new Error('Einfügung hat nichts verändert');
  const path = `/tmp/segmentation-${kind}-${hours}.mjs`;
  writeFileSync(path, variant, 'utf8');
  return (await import(path)).segmentConversationWindow;
}

function evaluate(segment) {
  let pairs = 0;
  let onlyAuto = 0;
  let onlyCombined = 0;
  let boundaries = 0;
  const hitPositions = new Map();
  const missedReasons = new Map();

  for (const entry of prepared) {
    const result = segment(toSegmentationInput(entry.messages));
    const reasonByPosition = new Map();
    for (const boundary of result.boundaries) {
      const position = entry.positions.get(boundary.beforeEventId);
      if (position !== undefined) reasonByPosition.set(position, boundary.reason);
    }
    const decisionByPosition = new Map();
    for (const decision of result.decisions) {
      const position = entry.positions.get(decision.beforeEventId);
      if (position !== undefined) decisionByPosition.set(position, decision.reason);
    }
    const automaticPositions = [...reasonByPosition.keys()].sort((a, b) => a - b);
    const vs = pairSeams(automaticPositions, entry.combined.cuts, TOLERANCE);
    pairs += vs.pairs.length;
    onlyAuto += vs.onlyA.length;
    onlyCombined += vs.onlyB.length;
    boundaries += result.boundaries.length;

    const hits = new Set(vs.pairs.map(([, combinedPosition]) => combinedPosition));
    hitPositions.set(entry.round, hits);
    const missed = new Map();
    for (const position of vs.onlyB) missed.set(position, decisionByPosition.get(position) || 'unbekannt');
    missedReasons.set(entry.round, missed);
  }

  const total = 2 * pairs + onlyAuto + onlyCombined;
  return {
    pairs, onlyAuto, onlyCombined, boundaries,
    f1: total ? (2 * pairs) / total : null,
    hitPositions, missedReasons,
  };
}

const { segmentConversationWindow } = await import('../segmentation-v4.mjs');
const baseline = evaluate(segmentConversationWindow);

// Die Grenzen, die heute an conversation_continues scheitern.
const pauseTargets = new Map();
let pauseTargetCount = 0;
for (const [round, missed] of baseline.missedReasons) {
  const set = new Set();
  for (const [position, reason] of missed) if (reason === 'conversation_continues') set.add(position);
  pauseTargets.set(round, set);
  pauseTargetCount += set.size;
}

console.log(`Runden: ${prepared.length} | Toleranz ${TOLERANCE}, doubt=${DOUBT_MODE}`);
console.log(`Grundlinie: Grenzen ${baseline.boundaries}, getroffen ${baseline.pairs}, `
  + `Fehlalarme ${baseline.onlyAuto}, übersehen ${baseline.onlyCombined}, F1 ${baseline.f1.toFixed(4)}`);
console.log(`davon übersehen mit Grund conversation_continues: ${pauseTargetCount}\n`);

for (const kind of ['unbedingt', 'nachrangig']) {
  console.log(`=== Einbau ${kind} ===`);
  console.log('   X | Grenzen | getroffen | Fehlalarme | übersehen |     F1 | davon der Pausen-Fälle');
  console.log('-----+---------+-----------+------------+-----------+--------+-----------------------');
  console.log(
    `  —  | ${String(baseline.boundaries).padStart(7)} | ${String(baseline.pairs).padStart(9)} | `
    + `${String(baseline.onlyAuto).padStart(10)} | ${String(baseline.onlyCombined).padStart(9)} | `
    + `${baseline.f1.toFixed(4)} | ${String(`0 von ${pauseTargetCount}`).padStart(22)}`,
  );
  for (const hours of HOURS) {
    const segment = await loadVariant(kind, hours);
    const result = evaluate(segment);
    let caught = 0;
    for (const [round, targets] of pauseTargets) {
      const hits = result.hitPositions.get(round) || new Set();
      for (const position of targets) if (hits.has(position)) caught += 1;
    }
    console.log(
      `${String(`${hours}h`).padStart(5)} | ${String(result.boundaries).padStart(7)} | ${String(result.pairs).padStart(9)} | `
      + `${String(result.onlyAuto).padStart(10)} | ${String(result.onlyCombined).padStart(9)} | `
      + `${result.f1.toFixed(4)} | ${String(`${caught} von ${pauseTargetCount}`).padStart(22)}`,
    );
  }
  console.log('');
}
