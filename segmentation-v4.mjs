const DEFAULT_SOURCE_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
const DEFAULT_TEST3_END_ID = 96295;
const DEFAULT_WINDOW_SIZE = 335;

function textValue(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

export function eventText(message) {
  return String(
    message?.truewords_original_text
    || textValue(message?.text)
    || message?.truewords_display_placeholder
    || '',
  ).trim();
}

export function timestamp(message) {
  const raw = message?.date_unixtime || message?.timestamp || message?.date;
  if (typeof raw === 'number') return raw > 1e12 ? raw / 1000 : raw;
  if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
    const value = Number(raw);
    return value > 1e12 ? value / 1000 : value;
  }
  return Date.parse(String(raw || '')) / 1000;
}

function speaker(message) {
  return String(message?.from || message?.actor || message?.sender || '');
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

const explicitClosurePattern = /(?:^|\b)(?:gute nacht|schlaf gut|bis später|bis morgen|melde mich später|meld mich später|muss los|muss jetzt los|ich geh schlafen|ich gehe schlafen|ich muss schlafen|wir sprechen später|reden wir später)(?:\b|[.!…😘❤️])/iu;
const greetingPattern = /^\s*(?:guten morgen|guten tag|guten abend|gute[nr]? morgen|moin|hallo|hey|hi|servus)\b/iu;
const independentOpenerPattern = /^\s*(?:übrigens|kurze frage|andere frage|anderes thema|apropos|ich wollte dir noch|ich wollte mal|sag mal|weißt du|weisst du|bist du|hast du|kannst du|könntest du|wie geht(?:'s| es)|wo bist du|wann bist du|was machst du)\b/iu;
const continuationPattern = /^\s*(?:ja|jep|jo|nein|nee|genau|stimmt|okay|ok|ach so|achso|klar|richtig|deshalb|darum|weil|also deswegen|hab ich|habe ich|bin ich|war ich|ist er|ist sie|sind wir)\b/iu;
const acknowledgementPattern = /^\s*(?:ok(?:ay)?|ja|nein|danke|alles klar|gut zu wissen|ah ok|ach so|achso|❤️|👍|😘|☺️|😊)\b/iu;

function hasQuestion(text) {
  return /\?/u.test(text) || /\b(?:bist|hast|willst|magst|kannst|könntest|wann|wo|wie|was|warum|soll|möchtest|kommst|gehts|geht es)\b.*[?.!…]?\s*$/iu.test(text);
}

function replyTargetId(message) {
  const value = message?.reply_to_message_id;
  return value == null ? '' : String(value);
}

function lastMeaningfulIndex(messages, fromIndex) {
  for (let index = fromIndex; index >= 0; index -= 1) {
    if (eventText(messages[index]) || eventKind(messages[index]) !== 'text') return index;
  }
  return -1;
}

function recentOpenQuestion(messages, startIndex, currentIndex) {
  const currentSpeaker = speaker(messages[currentIndex]);
  let inspected = 0;
  for (let index = currentIndex - 1; index >= startIndex && inspected < 8; index -= 1) {
    const text = eventText(messages[index]);
    if (!text) continue;
    inspected += 1;
    if (speaker(messages[index]) === currentSpeaker) continue;
    if (hasQuestion(text)) return true;
    return false;
  }
  return false;
}

export function boundaryDecision(messages, startIndex, currentIndex) {
  if (currentIndex <= startIndex) return { boundary: false, reason: 'start' };
  const previousIndex = lastMeaningfulIndex(messages, currentIndex - 1);
  if (previousIndex < startIndex) return { boundary: false, reason: 'no_previous_event' };

  const current = messages[currentIndex];
  const previous = messages[previousIndex];
  const currentText = eventText(current);
  const previousText = eventText(previous);
  const gapMinutes = (timestamp(current) - timestamp(previous)) / 60;
  const currentKind = eventKind(current);
  const previousKind = eventKind(previous);
  const target = replyTargetId(current);

  if (!Number.isFinite(gapMinutes) || gapMinutes < 0) {
    return { boundary: false, reason: 'invalid_gap', gapMinutes };
  }

  // Direkte Antwort innerhalb der aktuell offenen Konversation: keine Grenze,
  // unabhängig davon, ob Minuten, Stunden oder eine Nacht vergangen sind.
  if (target) {
    for (let index = startIndex; index < currentIndex; index += 1) {
      if (String(messages[index]?.id ?? '') === target) {
        return { boundary: false, reason: 'direct_reply_continuation', gapMinutes };
      }
    }
  }

  // Arbeit, Schlaf und unterschiedliche Verfügbarkeit erzeugen lange Pausen.
  // Eine noch offene Frage darf deshalb nicht durch die Uhr zerschnitten werden.
  if (recentOpenQuestion(messages, startIndex, currentIndex)) {
    return { boundary: false, reason: 'open_question_continuation', gapMinutes };
  }

  if (acknowledgementPattern.test(currentText) || continuationPattern.test(currentText)) {
    return { boundary: false, reason: 'linguistic_continuation', gapMinutes };
  }

  // Neuer Anruf nach einer echten Pause ist ein starkes Signal für eine neue
  // Kontaktaufnahme. Anruf und direkt folgende Erklärung bleiben zusammen.
  if (gapMinutes >= 60 && currentKind === 'call' && previousKind !== 'call') {
    return { boundary: true, reason: 'new_contact_attempt_after_pause', gapMinutes };
  }

  // Ein ausdrücklich beendeter Kommunikationsvorgang ist stärker als die Uhr.
  if (gapMinutes >= 15 && explicitClosurePattern.test(previousText)) {
    return { boundary: true, reason: 'previous_conversation_explicitly_closed', gapMinutes };
  }

  // Begrüßung oder klarer neuer Einstieg können nach einer längeren Pause eine
  // neue Konversation eröffnen. Die Pause ist nur Zusatzindiz, nie alleiniger Grund.
  if (gapMinutes >= 240 && greetingPattern.test(currentText)) {
    return { boundary: true, reason: 'new_greeting_after_pause', gapMinutes };
  }
  if (gapMinutes >= 240 && independentOpenerPattern.test(currentText)) {
    return { boundary: true, reason: 'independent_opener_after_pause', gapMinutes };
  }

  if (gapMinutes >= 12 * 60 && currentKind === 'media') {
    return { boundary: true, reason: 'new_media_contact_after_long_pause', gapMinutes };
  }

  return { boundary: false, reason: 'conversation_continues', gapMinutes };
}

export function segmentConversationWindow(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return { situations: [], assignments: {}, boundaries: [], decisions: [] };
  }
  const assignments = {};
  const situations = [];
  const boundaries = [];
  const decisions = [];
  let situationId = 1;
  let startIndex = 0;

  function close(endIndex) {
    const first = messages[startIndex];
    const last = messages[endIndex];
    for (let index = startIndex; index <= endIndex; index += 1) {
      assignments[String(messages[index]?.id)] = situationId;
    }
    const date = new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      timeZone: 'Asia/Bangkok',
    }).format(new Date(timestamp(first) * 1000));
    situations.push({
      id: situationId,
      label: `V4 ${String(situationId).padStart(2, '0')} · ${date}`,
      note: 'TrueWords V4: Konversationsgrenze nach Gesprächskontinuität; Zeit ist nur Indiz.',
      kind: 'unseen-validation',
      status: 'open',
      sourceStartId: String(first?.id ?? ''),
      sourceEndId: String(last?.id ?? ''),
      eventCount: endIndex - startIndex + 1,
    });
    situationId += 1;
    startIndex = endIndex + 1;
  }

  for (let index = 1; index < messages.length; index += 1) {
    const decision = boundaryDecision(messages, startIndex, index);
    decisions.push({
      beforeEventId: String(messages[index]?.id ?? ''),
      ...decision,
    });
    if (!decision.boundary) continue;
    boundaries.push({
      afterEventId: String(messages[index - 1]?.id ?? ''),
      beforeEventId: String(messages[index]?.id ?? ''),
      reason: decision.reason,
      gapMinutes: decision.gapMinutes,
    });
    close(index - 1);
  }
  close(messages.length - 1);
  return { situations, assignments, boundaries, decisions };
}

function ownersFor(situations) {
  const splitIndex = Math.ceil(situations.length / 2);
  const owners = Object.fromEntries(
    situations.map((situation, index) => [String(situation.id), index < splitIndex ? 'Philipp' : 'Lena']),
  );
  return {
    schemaVersion: 'truewords-owner-assignment/v1',
    strategy: 'chronological-half-split',
    oddSituationOwner: 'Philipp',
    situationCount: situations.length,
    splitIndex,
    owners,
  };
}

export function createTest4Preselection(reviewMessages, options = {}) {
  const sourceSha256 = options.sourceSha256 || DEFAULT_SOURCE_SHA256;
  const test3EndId = Number(options.test3EndId ?? DEFAULT_TEST3_END_ID);
  const windowSize = Number(options.windowSize ?? DEFAULT_WINDOW_SIZE);
  if (!Array.isArray(reviewMessages) || !reviewMessages.length) throw new Error('2026-Prüfstrom fehlt.');

  const startIndex = reviewMessages.findIndex((message) => Number(message?.id) > test3EndId);
  if (startIndex < 0) throw new Error(`Kein ungesehener Ereignisstrom nach Test 3 (ID ${test3EndId}) gefunden.`);
  const selected = reviewMessages.slice(startIndex, startIndex + windowSize);
  if (selected.length !== windowSize) {
    throw new Error(`Test 4 benötigt ${windowSize} ungesehene Ereignisse; gefunden wurden ${selected.length}.`);
  }

  const segmentation = segmentConversationWindow(selected);
  const ownerAssignment = ownersFor(segmentation.situations);
  const eventIds = selected.map((message) => String(message?.id ?? ''));
  const generatedAt = new Date().toISOString();

  return {
    schemaVersion: 'truewords-manual-segmentation/v4-unseen',
    datasetHash: sourceSha256,
    datasetLabel: 'Philipp & Lena · Test 4 · V4 ungesehener Ereignisstrom',
    reviewer: 'TrueWords Segmentation V4',
    exportedAt: generatedAt,
    situations: segmentation.situations,
    assignments: segmentation.assignments,
    messageOverrides: {},
    owners: ownerAssignment.owners,
    ownerAssignment,
    testFilter: {
      schemaVersion: 'truewords-test-filter/v1',
      source: {
        sourceSha256,
        sourceEvents: 73946,
      },
      selection: {
        strategy: 'next-unseen-window-after-test3',
        previousTestEndId: String(test3EndId),
        eventCount: selected.length,
        firstEventId: eventIds[0],
        lastEventId: eventIds.at(-1),
        firstDate: selected[0]?.date,
        lastDate: selected.at(-1)?.date,
        eventIds,
      },
    },
    preselection: {
      source: 'truewords-segmentation-v4-unseen',
      segmentationEngine: 'TrueWords Segmentation V4',
      boundarySource: 'local-deterministic-algorithm',
      externalLlmBoundaryGeneration: false,
      ruleModel: 'conversation-continuity-v1',
      definition: 'Situation = Konversation. Ein Gespräch kann über mehrere Konversationen verlaufen.',
      rules: {
        timeGapAloneCreatesBoundary: false,
        directReplyKeepsConversationOpen: true,
        openQuestionCanSurviveLongPause: true,
        explicitNewContactCanCreateBoundary: true,
        explicitClosureCanCreateBoundary: true,
        laterReferenceDoesNotReopenEarlierSituationAcrossInterveningSituation: true,
      },
      boundaries: segmentation.boundaries,
      integrity: {
        silentLosses: 0,
        selectedEvents: selected.length,
        assignments: Object.keys(segmentation.assignments).length,
        allSelectedEventsAssignedOrExcluded: Object.keys(segmentation.assignments).length === selected.length,
        fullOriginalRequired: true,
      },
    },
  };
}
