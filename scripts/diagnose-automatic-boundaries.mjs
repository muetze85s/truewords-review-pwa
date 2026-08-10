// Throwaway diagnostic: prints ONLY aggregate counts, never message text.
// Reads /tmp/rounds.json, /tmp/chunks.json, /tmp/marks.json (produced by the
// workflow step before this one) and reports, per round: how many boundaries
// segmentConversationWindow finds raw, vs. how many survive the
// positions.get(beforeEventId) lookup used by getSummary/getAgreement.
import { readFileSync } from 'node:fs';
import { segmentConversationWindow } from '../segmentation-v4.mjs';

function rawId(message) {
  return message?.id === undefined || message?.id === null ? '' : String(message.id);
}

function messageSeconds(message) {
  const raw = message?.date_unixtime ?? message?.date;
  if (typeof raw === 'number') return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
    const value = Number(raw);
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function messageYear(message) {
  const seconds = messageSeconds(message);
  if (!seconds) return null;
  return new Date(seconds * 1000).getUTCFullYear();
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
// Matches the CURRENTLY DEPLOYED worker (year filter still active; the
// point-7 change removing it hasn't shipped yet at diagnostic time).
function isReviewable(message, year) {
  return messageYear(message) === year && !isForwarded(message) && !isSticker(message) && !isService(message);
}

function rowsOf(dump) {
  return dump[0]?.results || [];
}

const roundsDump = JSON.parse(readFileSync('/tmp/rounds.json', 'utf8'));
const chunksDump = JSON.parse(readFileSync('/tmp/chunks.json', 'utf8'));
const marksDump = JSON.parse(readFileSync('/tmp/marks.json', 'utf8'));

const rounds = rowsOf(roundsDump);
const chunkRows = rowsOf(chunksDump);
const marks = rowsOf(marksDump);

let allMessages = [];
for (const row of chunkRows) {
  const parsed = JSON.parse(row.messages_json);
  if (Array.isArray(parsed)) allMessages = allMessages.concat(parsed);
}
const sequence = allMessages.filter((m) => m && typeof m === 'object' && isReviewable(m, 2026));
console.log(`Gesamte Sequenz (2026, ohne Weiterleitungen/Sticker/Service): ${sequence.length} Nachrichten`);

for (const round of rounds) {
  const startIndex = sequence.findIndex((m) => rawId(m) === String(round.first_message_id));
  if (startIndex < 0) {
    console.log(`Runde ${round.round}: first_message_id ${round.first_message_id} NICHT in der Sequenz gefunden!`);
    continue;
  }
  const windowMessages = sequence.slice(startIndex, startIndex + round.message_count);

  const positions = new Map();
  for (let i = 1; i < windowMessages.length; i += 1) positions.set(rawId(windowMessages[i]), i);

  const automaticResult = segmentConversationWindow(
    windowMessages.map((m) => ({ id: rawId(m), date_unixtime: m.date_unixtime ?? m.date })),
  );
  const rawCount = automaticResult.boundaries.length;
  const mapped = automaticResult.boundaries
    .map((b) => positions.get(b.beforeEventId))
    .filter((p) => p !== undefined);
  const mappedCount = mapped.length;

  const ownMarks = marks.filter((m) => String(m.round) === String(round.round));
  const philippMarks = ownMarks.filter((m) => m.reviewer === 'Philipp').length;
  const lenaMarks = ownMarks.filter((m) => m.reviewer === 'Lena').length;

  console.log(
    `Runde ${round.round}: Fenster ${windowMessages.length} Nachrichten, ${positions.size} Zwischenräume | `
    + `Automatik roh=${rawCount} gemappt=${mappedCount}${rawCount !== mappedCount ? '  <<< MISMATCH' : ''} | `
    + `Philipp markiert=${philippMarks} Lena markiert=${lenaMarks}`,
  );
}
