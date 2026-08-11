(() => {
  'use strict';

  const EXPECTED_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
  const EXPECTED_ENTRIES = 73_946;
  const REVIEW_YEAR = 2026;
  const PILOT_EVENTS = 250;
  const PILOT_SITUATIONS = 29;
  const VERSION_ID = 'pilot-v2-lossless';
  const SEGMENTATION_VERSION = 'heuristic-v2-lossless-event-stream';

  function flattenText(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }

  function scalar(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    return '';
  }

  function unixSeconds(message, fallback = 0) {
    const raw = scalar(message?.date_unixtime || message?.timestamp || message?.date);
    if (/^\d{9,13}$/u.test(raw)) {
      const value = Number(raw);
      return raw.length > 10 ? Math.floor(value / 1000) : value;
    }
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
  }

  function eventYear(message) {
    const rawDate = scalar(message?.date || message?.timestamp);
    const match = rawDate.match(/^(\d{4})-/u);
    if (match) return Number(match[1]);
    const seconds = unixSeconds(message, Number.NaN);
    if (!Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000).getUTCFullYear();
  }

  function eventId(message, index) {
    const id = message?.id;
    if (id === null || id === undefined || id === '') {
      throw new Error(`Originale Telegram-ID fehlt bei Ereignis ${index + 1}.`);
    }
    return String(id);
  }

  function mediaType(message) {
    const explicit = scalar(message?.media_type);
    if (explicit) return explicit;
    if (message?.photo) return 'photo';
    if (message?.file) return 'file';
    if (message?.sticker_emoji) return 'sticker';
    if (message?.location_information) return 'location';
    if (message?.contact_information) return 'contact';
    if (message?.poll) return 'poll';
    const mime = scalar(message?.mime_type);
    return mime ? mime.split('/', 1)[0] : '';
  }

  function serviceType(message) {
    return scalar(
      message?.service_type
      || message?.action_type
      || message?.action
      || message?.message_type,
    );
  }

  function durationLabel(message) {
    const seconds = Number(message?.duration_seconds ?? message?.duration ?? message?.call_duration ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${Math.round(seconds)} Sek.`;
    return `${Math.round(seconds / 60)} Min.`;
  }

  function isCall(message, type, service) {
    const value = `${type} ${service} ${scalar(message?.type)}`.toLocaleLowerCase('de-DE');
    return /(?:^|[^\p{L}\p{N}])(phone_call|video_call|voice_call|call|anruf)(?:$|[^\p{L}\p{N}])/u.test(value);
  }

  function placeholderFor(message) {
    const type = mediaType(message);
    const service = serviceType(message);
    const lower = `${type} ${service}`.toLocaleLowerCase('de-DE');
    const duration = durationLabel(message);

    if (isCall(message, type, service)) return `[Anruf${duration ? ` · ${duration}` : ''}]`;
    if (message?.type && message.type !== 'message') {
      const label = service ? service.replace(/[_-]+/gu, ' ') : scalar(message.type);
      return `[Systemereignis${label ? `: ${label}` : ''}]`;
    }
    if (/sticker/u.test(lower)) return '[Sticker gesendet]';
    if (/photo|image|bild/u.test(lower) || message?.photo) return '[Bild gesendet]';
    if (/video_message|round_video|videonachricht/u.test(lower)) return `[Videonachricht${duration ? ` · ${duration}` : ''}]`;
    if (/video/u.test(lower)) return `[Video gesendet${duration ? ` · ${duration}` : ''}]`;
    if (/voice|voice_message|sprachnachricht/u.test(lower)) return `[Sprachnachricht${duration ? ` · ${duration}` : ''}]`;
    if (/audio|music/u.test(lower)) return `[Audiodatei${duration ? ` · ${duration}` : ''}]`;
    if (/animation|gif/u.test(lower)) return '[GIF/Animation gesendet]';
    if (/location|venue|geo|map/u.test(lower)) return '[Standort gesendet]';
    if (/contact/u.test(lower)) return '[Kontakt gesendet]';
    if (/poll/u.test(lower)) return '[Umfrage gesendet]';
    if (/file|document/u.test(lower) || message?.file) {
      return `[Datei gesendet${message?.file_name ? `: ${message.file_name}` : ''}]`;
    }
    return '[Nichttextliches Ereignis]';
  }

  function classifyEvent(message, text) {
    const type = mediaType(message);
    const service = serviceType(message);
    const forwarded = Boolean(
      message?.forwarded_from
      || message?.forwarded_from_id
      || message?.saved_from,
    );
    if (message?.type && message.type !== 'message') return 'metadata_only';
    if (isCall(message, type, service)) return 'metadata_only';
    if (forwarded) return 'excluded_with_reason';
    if (/sticker/u.test(`${type} ${service}`.toLocaleLowerCase('de-DE'))) return 'metadata_only';
    if (!text.trim() && (type || service)) return 'metadata_only';
    if (!text.trim()) return 'metadata_only';
    if (/^\s*(?:https?:\/\/|www\.)\S+\s*$/iu.test(text)) return 'excluded_with_reason';
    if (message?.via_bot) return 'unresolved_mapping';
    return 'assigned_to_situation';
  }

  function prepareMessage(message, index) {
    const originalText = flattenText(message?.text);
    const placeholder = originalText.trim() ? '' : placeholderFor(message);
    const primaryStatus = classifyEvent(message, originalText);
    return {
      ...message,
      id: message.id,
      text: originalText || placeholder,
      truewords_original_text: originalText,
      truewords_display_placeholder: placeholder || null,
      truewords_primary_status: primaryStatus,
      truewords_source_order: index,
      truewords_timeline_preserved: true,
      truewords_segmentation_eligible: true,
    };
  }

  function prepareOriginalChat(chat) {
    if (!chat || !Array.isArray(chat.messages)) {
      throw new Error('Der Telegram-Originalexport enthält keine Nachrichtenliste.');
    }
    if (chat.messages.length !== EXPECTED_ENTRIES) {
      throw new Error(`Falsche Chatquelle: erwartet ${EXPECTED_ENTRIES.toLocaleString('de-DE')}, erhalten ${chat.messages.length.toLocaleString('de-DE')} Exportereignisse.`);
    }

    const seen = new Set();
    const messages = chat.messages.map((message, index) => {
      const id = eventId(message, index);
      if (seen.has(id)) throw new Error(`Doppelte Telegram-ID ${id}.`);
      seen.add(id);
      return prepareMessage(message, index);
    });
    const reviewEvents = messages.filter((message) => eventYear(message) === REVIEW_YEAR);
    if (reviewEvents.length !== 2_494) {
      throw new Error(`2026-Prüfstrom unvollständig: erwartet 2.494, erhalten ${reviewEvents.length.toLocaleString('de-DE')} Ereignisse.`);
    }

    const statusCounts = reviewEvents.reduce((result, message) => {
      const status = message.truewords_primary_status;
      result[status] = (result[status] || 0) + 1;
      return result;
    }, {});

    return {
      chat: {
        ...chat,
        messages,
        truewordsTimelinePreservation: {
          version: 'truewords-pilot-v2-lossless/v1',
          sourceEntries: chat.messages.length,
          preservedEntries: messages.length,
          silentLosses: chat.messages.length - messages.length,
          reviewYear: REVIEW_YEAR,
          reviewYearEvents: reviewEvents.length,
          statusCounts,
        },
      },
      reviewEvents,
      statusCounts,
    };
  }

  function tokenSet(message) {
    const text = flattenText(message?.truewords_original_text || message?.text)
      .normalize('NFKC')
      .toLocaleLowerCase('de-DE')
      .replace(/https?:\/\/\S+/gu, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    if (!text) return new Set();
    return new Set(text.split(/\s+/u).filter((token) => token.length >= 3));
  }

  function jaccard(left, right) {
    if (!left.size || !right.size) return null;
    let common = 0;
    for (const token of left) if (right.has(token)) common += 1;
    return common / (left.size + right.size - common);
  }

  function directReply(current, previous) {
    return String(current?.reply_to_message_id ?? '') === String(previous?.id ?? '');
  }

  function repliesIntoRecentWindow(current, events, index) {
    const target = String(current?.reply_to_message_id ?? '');
    if (!target) return false;
    for (let cursor = Math.max(0, index - 12); cursor < index; cursor += 1) {
      if (String(events[cursor]?.id ?? '') === target) return true;
    }
    return false;
  }

  function boundaryCandidate(events, index) {
    const previous = events[index - 1];
    const current = events[index];
    const gap = Math.max(0, unixSeconds(current, index) - unixSeconds(previous, index - 1));
    const reasons = [];
    let score = 0;

    if (gap > 24 * 3600) { score += 5; reasons.push('mehr als 24 Stunden Abstand'); }
    else if (gap > 12 * 3600) { score += 4; reasons.push('mehr als 12 Stunden Abstand'); }
    else if (gap > 4 * 3600) { score += 3; reasons.push('mehr als 4 Stunden Abstand'); }
    else if (gap > 2 * 3600) { score += 2; reasons.push('mehr als 2 Stunden Abstand'); }
    else if (gap > 45 * 60) { score += 1; reasons.push('mehr als 45 Minuten Abstand'); }

    const previousDay = scalar(previous?.date).slice(0, 10);
    const currentDay = scalar(current?.date).slice(0, 10);
    if (previousDay && currentDay && previousDay !== currentDay) {
      score += 0.5;
      reasons.push('Tageswechsel');
    }

    if (directReply(current, previous)) {
      score -= 1.5;
      reasons.push('direkte Antwort spricht gegen Trennung');
    } else if (repliesIntoRecentWindow(current, events, index)) {
      score -= 1;
      reasons.push('Reply in den laufenden Abschnitt');
    }

    const previousStatus = previous?.truewords_primary_status;
    const currentStatus = current?.truewords_primary_status;
    if (previousStatus !== 'assigned_to_situation' || currentStatus !== 'assigned_to_situation') {
      score -= 0.8;
      reasons.push('Medien-/Metadatenereignis ist kein eigener Themenwechsel');
    }

    const currentText = flattenText(current?.truewords_original_text || current?.text).trim();
    if (/^(?:hallo|hey|hi|guten morgen|guten abend|moin|servus)\b/iu.test(currentText)) {
      score += 0.5;
      reasons.push('neuer Gesprächseinstieg');
    }

    const similarity = jaccard(tokenSet(previous), tokenSet(current));
    if (similarity !== null && similarity < 0.08) {
      score += 0.8;
      reasons.push('deutlicher lexikalischer Themenwechsel');
    } else if (similarity !== null && similarity < 0.2) {
      score += 0.4;
      reasons.push('leichter lexikalischer Themenwechsel');
    }

    if (currentText.length > 0 && currentText.length <= 12) {
      score -= 0.35;
      reasons.push('sehr kurze Reaktion spricht eher für Fortsetzung');
    }

    return { index, score: Math.round(score * 100) / 100, reasons, gap };
  }

  function formatPilotDay(message) {
    const date = new Date(unixSeconds(message) * 1000);
    if (Number.isNaN(date.getTime())) return 'Datum unbekannt';
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Asia/Bangkok',
      day: '2-digit',
      month: '2-digit',
    }).format(date);
  }

  function confidence(score) {
    if (score >= 5) return 'hoch';
    if (score >= 3.5) return 'mittel';
    return 'niedrig';
  }

  function generatePilot(prepared, datasetHash) {
    if (!prepared || !Array.isArray(prepared.reviewEvents)) {
      throw new Error('Der verlustfreie 2026-Ereignisstrom fehlt.');
    }
    if (datasetHash !== EXPECTED_SHA256) {
      throw new Error('SHA-256 des Telegram-Originalexports stimmt nicht überein.');
    }

    const events = prepared.reviewEvents.slice(0, PILOT_EVENTS);
    if (events.length !== PILOT_EVENTS) throw new Error('Zu wenige Ereignisse für Test 2.');

    const candidates = [];
    for (let index = 1; index < events.length; index += 1) {
      candidates.push(boundaryCandidate(events, index));
    }
    const selectedBoundaries = candidates
      .slice()
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, PILOT_SITUATIONS - 1)
      .sort((left, right) => left.index - right.index);
    const starts = [0, ...selectedBoundaries.map((candidate) => candidate.index)];
    const assignments = {};
    const situations = [];

    for (let situationIndex = 0; situationIndex < starts.length; situationIndex += 1) {
      const start = starts[situationIndex];
      const end = situationIndex + 1 < starts.length ? starts[situationIndex + 1] : events.length;
      const id = situationIndex + 1;
      const boundary = situationIndex === 0
        ? { score: null, reasons: ['Beginn des zweiten Kalibrierungsfensters'] }
        : selectedBoundaries[situationIndex - 1];
      const part = events.slice(start, end);
      for (const message of part) assignments[String(message.id)] = id;
      situations.push({
        id,
        label: `KI-Vorschlag ${String(id).padStart(2, '0')} · ${formatPilotDay(part[0])}`,
        note: `Test 2 · verlustfreier Ereignisstrom. Konfidenz: ${boundary.score === null ? 'Pilotstart' : confidence(boundary.score)}. Grund: ${boundary.reasons.join('; ')}${boundary.score === null ? '' : ` · Grenzscore ${boundary.score.toFixed(2)}`}.`,
        kind: 'training',
        status: 'open',
        createdAt: new Date().toISOString(),
        firstSourceId: String(part[0]?.id ?? ''),
        lastSourceId: String(part.at(-1)?.id ?? ''),
        eventCount: part.length,
      });
    }

    if (situations.length !== PILOT_SITUATIONS) throw new Error('Test 2 erzeugte nicht exakt 29 Situationen.');
    if (Object.keys(assignments).length !== PILOT_EVENTS) throw new Error('Test 2 deckt nicht alle 250 Ereignisse ab.');

    return {
      schemaVersion: 'truewords-manual-segmentation/v2',
      versionId: VERSION_ID,
      versionLabel: 'Pilot v2 · verlustfreier Ereignisstrom',
      datasetHash,
      datasetLabel: 'Philipp & Lena · Test 2 · 2026',
      reviewer: 'KI-Pilot Test 2',
      exportedAt: new Date().toISOString(),
      situations,
      assignments,
      events: [{
        type: 'pilot_v1_aborted',
        reason: 'lossy_preprocessing',
        at: new Date().toISOString(),
      }],
      preselection: {
        schemaVersion: SEGMENTATION_VERSION,
        versionId: VERSION_ID,
        reviewYear: REVIEW_YEAR,
        sourceEventsInYear: prepared.reviewEvents.length,
        selectedEvents: PILOT_EVENTS,
        selectedMessages: PILOT_EVENTS,
        suggestedSituations: PILOT_SITUATIONS,
        assignments: Object.keys(assignments).length,
        coveragePercent: 100,
        silentLosses: 0,
        includesMetadataPlaceholders: true,
        sourceStatusCounts: prepared.statusCounts,
        previousPilotStatus: 'aborted_lossy_preprocessing',
      },
    };
  }

  window.TRUEWORDS_PILOT_V2 = Object.freeze({
    EXPECTED_SHA256,
    EXPECTED_ENTRIES,
    REVIEW_YEAR,
    PILOT_EVENTS,
    PILOT_SITUATIONS,
    VERSION_ID,
    prepareOriginalChat,
    generatePilot,
  });
})();
