import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    result[key] = argv[index + 1];
    index += 1;
  }
  return result;
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function eventText(message) {
  return String(
    message?.truewords_original_text
    || textValue(message?.text)
    || message?.truewords_display_placeholder
    || '',
  ).trim();
}

function timestamp(message) {
  const raw = message?.date_unixtime || message?.timestamp || message?.date;
  if (typeof raw === 'number') return raw > 1e12 ? raw / 1000 : raw;
  if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
    const value = Number(raw);
    return value > 1e12 ? value / 1000 : value;
  }
  return Date.parse(String(raw || '')) / 1000;
}

function eventKind(message) {
  const placeholder = String(message?.truewords_display_placeholder || message?.text || '').toLocaleLowerCase('de-DE');
  const service = String(message?.truewords_service_type || message?.service_type || message?.action || '').toLocaleLowerCase('de-DE');
  if (placeholder.includes('anruf') || service.includes('call')) return 'call';
  if (message?.truewords_media_type || message?.media_type || message?.photo || message?.file || message?.truewords_display_placeholder) {
    return 'media';
  }
  return 'text';
}

function isPureLink(text) {
  return /^\s*(?:https?:\/\/|www\.)\S+\s*$/iu.test(text);
}

function structuredInfoScore(text) {
  let score = 0;
  const lower = text.toLocaleLowerCase('de-DE');
  if (text.length >= 1000) score += 1;
  if ((text.match(/(?:^|\n)\s*\d+[.)]/gu) || []).length >= 2) score += 1;
  if (['fazit:', 'woran erkennst', 'hauptursache', 'das passiert'].some((token) => lower.includes(token))) score += 1;
  return score;
}

function isOutlierCandidate(messages, index) {
  if (index <= 0) return false;
  const current = eventText(messages[index]);
  const previous = eventText(messages[index - 1]);
  return (
    structuredInfoScore(current) >= 2
    && isPureLink(previous)
    && previous.toLocaleLowerCase('de-DE').includes('chatgpt.com')
    && !messages[index]?.reply_to_message_id
  );
}

const acknowledgementPattern = /^\s*(?:danke(?:\s+dir)?|gut zu wissen|ah ok|ok(?:ay)?|❤️|👍)\b/iu;
const shortAcknowledgementPattern = /^\s*(?:ok(?:ay)?|ja|nein|danke|gut zu wissen|ah ok|hmm|❤️|👍|in\s+\d+\s*min)\s*[.!…😘🫶🏻❤️]*$/iu;
const genericCheckInPattern = /^\s*(?:na[, ]|wie ist die lage|wie is die lage)/iu;
const actionableQuestionPattern = /^\s*(?:bist|hast|willst|magst|kannst|könntest|wann|wo|wie|was|warum|soll|möchtest|kommst|gehts|geht es)\b/iu;

function buildInitialBoundaries(messages, assignments, startIndex, endIndex) {
  const boundaries = new Set();
  for (let index = startIndex; index < endIndex; index += 1) {
    const left = assignments[String(messages[index]?.id)];
    const right = assignments[String(messages[index + 1]?.id)];
    if (left != null && right != null && Number(left) !== Number(right)) boundaries.add(index);
  }
  return boundaries;
}

function extendTrailingMedia(messages, assignments, endIndex) {
  let cursor = endIndex;
  const lastAssigned = messages[endIndex];
  const lastSpeaker = String(lastAssigned?.from || lastAssigned?.actor || '');
  while (cursor + 1 < messages.length) {
    const next = messages[cursor + 1];
    const gap = timestamp(next) - timestamp(messages[cursor]);
    const speaker = String(next?.from || next?.actor || '');
    if (gap < 0 || gap > 120 || eventKind(next) !== 'media' || speaker !== lastSpeaker) break;
    cursor += 1;
  }
  return cursor;
}

function calibrateBoundaries(messages, initialAssignments) {
  const assignedIndices = Object.keys(initialAssignments)
    .map((id) => messages.findIndex((message) => String(message?.id) === String(id)))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (!assignedIndices.length) throw new Error('V2 preselection contains no assignments found in the chat.');

  const startIndex = assignedIndices[0];
  const initialEndIndex = assignedIndices.at(-1);
  const endIndex = extendTrailingMedia(messages, initialAssignments, initialEndIndex);
  const boundaries = buildInitialBoundaries(messages, initialAssignments, startIndex, initialEndIndex);
  const excludedIndices = new Set();
  const changes = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    if (!isOutlierCandidate(messages, index)) continue;
    excludedIndices.add(index);
    boundaries.delete(index - 1);
    boundaries.delete(index);
    changes.push({ type: 'context_outlier_excluded', index });
  }

  for (const index of [...boundaries]) {
    const previous = messages[index];
    const current = messages[index + 1];
    const previousText = eventText(previous);
    const currentText = eventText(current);
    const gapMinutes = (timestamp(current) - timestamp(previous)) / 60;

    if (gapMinutes < 240) {
      boundaries.delete(index);
      changes.push({ type: 'merge_short_pause', index, gapMinutes });
      continue;
    }
    if (gapMinutes < 18 * 60 && (acknowledgementPattern.test(currentText) || shortAcknowledgementPattern.test(currentText))) {
      boundaries.delete(index);
      changes.push({ type: 'merge_acknowledgement_continuation', index, gapMinutes });
      continue;
    }
    if (gapMinutes < 18 * 60 && eventKind(previous) === 'call' && eventKind(current) === 'call') {
      boundaries.delete(index);
      changes.push({ type: 'merge_call_chain', index, gapMinutes });
      continue;
    }
    if (gapMinutes < 6 * 60 && genericCheckInPattern.test(currentText)) {
      boundaries.delete(index);
      changes.push({ type: 'merge_generic_checkin', index, gapMinutes });
    }
  }

  for (let index = startIndex; index < endIndex; index += 1) {
    if (boundaries.has(index) || excludedIndices.has(index) || excludedIndices.has(index + 1)) continue;
    const previousText = eventText(messages[index]);
    const currentText = eventText(messages[index + 1]);
    const gapMinutes = (timestamp(messages[index + 1]) - timestamp(messages[index])) / 60;
    if (
      gapMinutes <= 15
      && /^\s*gut zu wissen\b/iu.test(previousText)
      && actionableQuestionPattern.test(currentText)
      && currentText.includes('?')
    ) {
      boundaries.add(index);
      changes.push({ type: 'add_closure_to_new_question_boundary', index, gapMinutes });
    }
  }

  return { startIndex, initialEndIndex, endIndex, boundaries, excludedIndices, changes };
}

function buildPreselection(chat, v2, calibration) {
  const messages = chat.messages;
  const assignments = {};
  const overrides = {};
  const situations = [];
  let situationId = 1;
  let startIndex = calibration.startIndex;

  function closeSituation(endIndex) {
    const assigned = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      if (calibration.excludedIndices.has(index)) continue;
      const id = String(messages[index].id);
      assignments[id] = situationId;
      assigned.push(messages[index]);
    }
    if (assigned.length) {
      const first = assigned[0];
      const last = assigned.at(-1);
      const date = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Bangkok' })
        .format(new Date(timestamp(first) * 1000));
      situations.push({
        id: situationId,
        label: `V3 ${String(situationId).padStart(2, '0')} · ${date}`,
        note: 'Automatisch kalibrierter V3-Vorschlag aus Test-2-Regeln; erneut manuell zu prüfen.',
        kind: 'replay',
        status: 'open',
        sourceStartId: String(first.id),
        sourceEndId: String(last.id),
        eventCount: assigned.length,
      });
      situationId += 1;
    }
    startIndex = endIndex + 1;
  }

  for (let index = calibration.startIndex; index <= calibration.endIndex; index += 1) {
    if (calibration.excludedIndices.has(index)) {
      const id = String(messages[index].id);
      overrides[id] = {
        status: 'excluded_with_reason',
        reason: 'Automatischer Kontext-Ausreißer: strukturierter KI-/Infotext ohne Dialoganschluss',
        at: new Date().toISOString(),
      };
    }
    if (calibration.boundaries.has(index)) closeSituation(index);
  }
  closeSituation(calibration.endIndex);

  return {
    schemaVersion: 'truewords-manual-segmentation/v3-replay',
    datasetHash: v2.datasetHash || chat.datasetHash,
    datasetLabel: `${v2.datasetLabel || chat.datasetLabel || 'TrueWords'} · V3 Replay`,
    reviewer: 'TrueWords Segmentation V3 Replay',
    exportedAt: new Date().toISOString(),
    situations,
    assignments,
    messageOverrides: overrides,
    calibration: {
      sourceVersion: v2.preselection?.schemaVersion || v2.schemaVersion,
      pilotStartIndex: calibration.startIndex,
      initialPilotEndIndex: calibration.initialEndIndex,
      extendedPilotEndIndex: calibration.endIndex,
      boundaryCount: calibration.boundaries.size,
      situationCount: situations.length,
      excludedEventCount: calibration.excludedIndices.size,
      changes: calibration.changes,
      warning: 'Same-sample replay. Improvement must be confirmed on an unseen third pilot.',
    },
  };
}

function boundaryPositions(messages, assignments, overrides = {}, startIndex = 0, endIndex = messages.length - 1) {
  const result = new Set();
  let previousAssignedIndex = null;
  let previousSituation = null;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const id = String(messages[index]?.id);
    if (overrides[id]) continue;
    const situationId = assignments[id];
    if (situationId == null) continue;
    if (previousAssignedIndex != null && Number(situationId) !== Number(previousSituation)) {
      result.add(previousAssignedIndex);
    }
    previousAssignedIndex = index;
    previousSituation = situationId;
  }
  return result;
}

function scoreBoundaries(predicted, gold) {
  const truePositive = [...predicted].filter((value) => gold.has(value)).length;
  const falsePositive = predicted.size - truePositive;
  const falseNegative = gold.size - truePositive;
  const precision = predicted.size ? truePositive / predicted.size : 0;
  const recall = gold.size ? truePositive / gold.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { truePositive, falsePositive, falseNegative, precision, recall, f1 };
}

const args = parseArgs(process.argv.slice(2));
if (!args.chat || !args.preselection || !args.out) {
  throw new Error('Usage: node scripts/segment-pilot-v3.mjs --chat lossless.json --preselection v2.json --out v3.json [--gold completed-review-state.json] [--report report.json]');
}

const chat = JSON.parse(fs.readFileSync(args.chat, 'utf8'));
const v2 = JSON.parse(fs.readFileSync(args.preselection, 'utf8'));
if (!Array.isArray(chat.messages)) throw new Error('Chat messages are missing.');
if (!v2.assignments || typeof v2.assignments !== 'object') throw new Error('V2 assignments are missing.');

const calibration = calibrateBoundaries(chat.messages, v2.assignments);
const v3 = buildPreselection(chat, v2, calibration);
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(v3, null, 2));

const report = {
  generatedAt: new Date().toISOString(),
  input: {
    events: chat.messages.length,
    v2Situations: v2.situations?.length || 0,
    v2Assignments: Object.keys(v2.assignments).length,
  },
  output: {
    v3Situations: v3.situations.length,
    v3Assignments: Object.keys(v3.assignments).length,
    excludedEvents: Object.keys(v3.messageOverrides).length,
  },
};

if (args.gold) {
  const goldState = JSON.parse(fs.readFileSync(args.gold, 'utf8'));
  const gold = goldState.annotations || goldState;
  const startIndex = calibration.startIndex;
  const endIndex = calibration.endIndex;
  const v2BoundarySet = boundaryPositions(chat.messages, v2.assignments, {}, startIndex, calibration.initialEndIndex);
  const v3BoundarySet = boundaryPositions(chat.messages, v3.assignments, v3.messageOverrides, startIndex, endIndex);
  const goldBoundarySet = boundaryPositions(chat.messages, gold.assignments || {}, gold.messageOverrides || {}, startIndex, endIndex);
  report.evaluation = {
    scope: 'same-sample replay',
    goldSituations: gold.situations?.length || 0,
    v2: scoreBoundaries(v2BoundarySet, goldBoundarySet),
    v3: scoreBoundaries(v3BoundarySet, goldBoundarySet),
    caution: 'This verifies regression on Test 2, not generalization. Use a new Test 3 for independent accuracy.',
  };
}

if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
