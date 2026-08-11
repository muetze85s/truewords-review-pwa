(() => {
  'use strict';

  const BOOTSTRAP_PATH = '/api/review/bootstrap';
  const STATE_PATH = '/api/state';
  const SELECT_KEY = 'truewords-review/precision-select';
  const SCROLL_KEY = 'truewords-review/precision-scroll';
  const REVIEWER_MODE_KEY = 'truewords-review/reviewer-mode';
  const snapshot = {
    payload: null,
    messageById: new Map(),
    messageIndex: new Map(),
    scheduled: false,
    restoring: false,
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const requestUrl = typeof args[0] === 'string'
        ? new URL(args[0], location.href)
        : new URL(args[0]?.url || '', location.href);
      const method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
      if ((requestUrl.pathname === BOOTSTRAP_PATH || requestUrl.pathname === STATE_PATH) && method === 'GET') {
        response.clone().json().then(rememberPayload).catch(() => null);
      }
    } catch {
      // The original request remains untouched.
    }
    return response;
  };

  function rememberPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.annotations) {
      snapshot.payload = {
        ...(snapshot.payload || {}),
        ...payload,
        annotations: payload.annotations,
        owners: payload.owners || snapshot.payload?.owners || {},
        messages: payload.messages || snapshot.payload?.messages || [],
      };
      rebuildMessageMaps();
      schedule();
    }
  }

  function rebuildMessageMaps() {
    snapshot.messageById.clear();
    snapshot.messageIndex.clear();
    const messages = snapshot.payload?.messages || [];
    messages.forEach((message, index) => {
      const id = messageId(message);
      if (!id) return;
      snapshot.messageById.set(id, message);
      snapshot.messageIndex.set(id, index);
    });
    for (const message of snapshot.payload?.replyMessages || []) {
      const id = messageId(message);
      if (id && !snapshot.messageById.has(id)) snapshot.messageById.set(id, message);
    }
  }

  function messageId(message) {
    return String(message?.id ?? '');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
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

  function durationLabel(message) {
    const raw = Number(message?.duration_seconds ?? message?.duration ?? message?.call_duration ?? 0);
    if (!Number.isFinite(raw) || raw <= 0) return '';
    return raw < 60 ? `${Math.round(raw)} Sek.` : `${Math.round(raw / 60)} Min.`;
  }

  function mediaPlaceholder(message) {
    const existing = String(message?.truewords_display_placeholder || '').trim();
    if (existing) return existing;
    const explicit = String(message?.truewords_media_type || message?.media_type || '').toLocaleLowerCase('de-DE');
    const mime = String(message?.mime_type || '').toLocaleLowerCase('de-DE');
    const service = String(
      message?.truewords_service_type
      || message?.service_type
      || message?.action_type
      || message?.action
      || '',
    ).toLocaleLowerCase('de-DE');
    const combined = `${explicit} ${mime} ${service} ${message?.type || ''}`;
    const duration = durationLabel(message);

    if (/(?:^|\W)(phone_call|video_call|voice_call|call|anruf)(?:$|\W)/u.test(combined)) {
      return `[Anruf${duration ? ` · ${duration}` : ''}]`;
    }
    if (/sticker/u.test(combined)) return '[Sticker gesendet]';
    if (message?.photo || /photo|image|bild/u.test(combined)) return '[Bild gesendet]';
    if (/video_message|round_video|videonachricht/u.test(combined)) {
      return `[Videonachricht${duration ? ` · ${duration}` : ''}]`;
    }
    if (/video/u.test(combined)) return `[Video gesendet${duration ? ` · ${duration}` : ''}]`;
    if (/voice|sprachnachricht/u.test(combined)) {
      return `[Sprachnachricht${duration ? ` · ${duration}` : ''}]`;
    }
    if (/audio|music/u.test(combined)) return `[Audiodatei${duration ? ` · ${duration}` : ''}]`;
    if (/animation|gif/u.test(combined)) return '[GIF/Animation gesendet]';
    if (/location|venue|geo|map/u.test(combined)) return '[Standort gesendet]';
    if (/contact/u.test(combined)) return '[Kontakt gesendet]';
    if (/poll/u.test(combined)) return '[Umfrage gesendet]';
    if (message?.file || /file|document|application\//u.test(combined)) {
      return `[Datei gesendet${message?.file_name ? `: ${message.file_name}` : ''}]`;
    }
    if (message?.type && message.type !== 'message') {
      return `[Systemereignis${service ? `: ${service.replace(/[_-]+/gu, ' ')}` : ''}]`;
    }
    return '';
  }

  function currentReviewer() {
    const active = document.querySelector('[data-reviewer-mode].active')?.dataset?.reviewerMode;
    if (active === 'Philipp' || active === 'Lena') return active;
    const stored = sessionStorage.getItem(REVIEWER_MODE_KEY);
    if (stored === 'Philipp' || stored === 'Lena') return stored;
    return snapshot.payload?.user?.role || 'Philipp';
  }

  function selectedSituationId() {
    const text = document.querySelector('.chat-head .eyebrow')?.textContent || '';
    const match = text.match(/Situation\s+(\d+)/iu);
    return match ? Number(match[1]) : 0;
  }

  function situations(annotations = snapshot.payload?.annotations) {
    return [...(annotations?.situations || [])].sort((left, right) => Number(left.id) - Number(right.id));
  }

  function situation(id, annotations = snapshot.payload?.annotations) {
    return situations(annotations).find((item) => Number(item.id) === Number(id)) || null;
  }

  function owner(id) {
    return snapshot.payload?.owners?.[String(id)] || 'Unbekannt';
  }

  function previousSituationId(id, annotations) {
    const all = situations(annotations);
    const index = all.findIndex((item) => Number(item.id) === Number(id));
    return index > 0 ? Number(all[index - 1].id) : 0;
  }

  function nextSituationId(id, annotations) {
    const all = situations(annotations);
    const index = all.findIndex((item) => Number(item.id) === Number(id));
    return index >= 0 && index < all.length - 1 ? Number(all[index + 1].id) : 0;
  }

  function cloneAnnotations() {
    return structuredClone(snapshot.payload?.annotations || {});
  }

  function appendEvent(annotations, event) {
    annotations.events = Array.isArray(annotations.events) ? annotations.events : [];
    annotations.events.push(event);
    annotations.events = annotations.events.slice(-2000);
  }

  function markSituationChanged(annotations, id) {
    const item = situation(id, annotations);
    if (!item) return;
    item.status = 'open';
    item.truewordsNeedsCorrectedConfirmation = true;
    delete item.reviewedAt;
    delete item.reviewedBy;
  }

  function assignedDomIds() {
    return [...document.querySelectorAll('#message-list .situation-messages .message.assigned[data-message-id]')]
      .filter((element) => !element.classList.contains('precision-excluded'))
      .map((element) => String(element.dataset.messageId || ''))
      .filter(Boolean);
  }

  function reconcileVisibleBoundaryEdits(annotations, selectedId) {
    const visibleIds = assignedDomIds();
    if (!visibleIds.length || !selectedId) return;
    const assignments = annotations.assignments || {};
    const visibleSet = new Set(visibleIds);
    const indices = visibleIds
      .map((id) => snapshot.messageIndex.get(id))
      .filter((index) => Number.isInteger(index));
    if (!indices.length) return;
    const first = Math.min(...indices);
    const last = Math.max(...indices);
    const previousId = previousSituationId(selectedId, annotations);
    const nextId = nextSituationId(selectedId, annotations);

    for (const [id, rawSituationId] of Object.entries({ ...assignments })) {
      if (Number(rawSituationId) !== Number(selectedId) || visibleSet.has(id)) continue;
      if (annotations.messageOverrides?.[id]) {
        delete assignments[id];
        continue;
      }
      const index = snapshot.messageIndex.get(id);
      if (!Number.isInteger(index)) continue;
      if (index < first && previousId) assignments[id] = previousId;
      else if (index > last && nextId) assignments[id] = nextId;
      else delete assignments[id];
    }
    visibleIds.forEach((id) => {
      assignments[id] = selectedId;
      if (annotations.messageOverrides) delete annotations.messageOverrides[id];
    });
  }

  async function saveAnnotations(annotations, selectionId, scrollEdge = '') {
    const reviewer = currentReviewer();
    const response = await nativeFetch(STATE_PATH, {
      method: 'PUT',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-truewords-reviewer': reviewer,
      },
      body: JSON.stringify({
        datasetId: snapshot.payload?.dataset?.id,
        annotations,
      }),
    });
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (selectionId) sessionStorage.setItem(SELECT_KEY, String(selectionId));
    if (scrollEdge) sessionStorage.setItem(SCROLL_KEY, scrollEdge);
    location.reload();
  }

  function boundaryDetails(action, annotations, selectedId) {
    const assignments = annotations.assignments || {};
    const assignedCards = [...document.querySelectorAll('#message-list .situation-messages .message.assigned[data-message-id]')]
      .filter((element) => !element.classList.contains('precision-excluded'));
    const before = document.querySelector('#message-list .context-zone.before [data-message-id]');
    const after = document.querySelector('#message-list .context-zone.after [data-message-id]');
    let messageElement = null;
    let sourceSituationId = 0;
    let destinationSituationId = 0;

    if (action === 'start-earlier') {
      messageElement = before;
      sourceSituationId = Number(assignments[messageElement?.dataset?.messageId] || previousSituationId(selectedId, annotations));
      destinationSituationId = selectedId;
    } else if (action === 'end-later') {
      messageElement = after;
      sourceSituationId = Number(assignments[messageElement?.dataset?.messageId] || nextSituationId(selectedId, annotations));
      destinationSituationId = selectedId;
    } else if (action === 'start-later') {
      messageElement = assignedCards[0] || null;
      sourceSituationId = selectedId;
      destinationSituationId = Number(assignments[before?.dataset?.messageId] || previousSituationId(selectedId, annotations));
    } else if (action === 'end-earlier') {
      messageElement = assignedCards.at(-1) || null;
      sourceSituationId = selectedId;
      destinationSituationId = Number(assignments[after?.dataset?.messageId] || nextSituationId(selectedId, annotations));
    }

    return {
      messageId: String(messageElement?.dataset?.messageId || ''),
      sourceSituationId,
      destinationSituationId,
    };
  }

  function isCrossOwner(details) {
    if (!details.messageId || !details.sourceSituationId || !details.destinationSituationId) return false;
    return owner(details.sourceSituationId) !== owner(details.destinationSituationId);
  }

  async function moveCrossOwnerBoundary(action) {
    const selectedId = selectedSituationId();
    if (!selectedId || owner(selectedId) !== currentReviewer()) return;
    const annotations = cloneAnnotations();
    reconcileVisibleBoundaryEdits(annotations, selectedId);
    const details = boundaryDetails(action, annotations, selectedId);
    if (!isCrossOwner(details)) return;

    const otherId = details.sourceSituationId === selectedId
      ? details.destinationSituationId
      : details.sourceSituationId;
    const otherOwner = owner(otherId);
    const direction = details.destinationSituationId === selectedId ? 'übernehmen' : 'abgeben';
    const accepted = confirm(
      `Die angrenzende Situation wird von ${otherOwner} geprüft. Nachricht ${details.messageId} trotzdem ${direction}? `
      + 'Beide Situationen werden danach als korrigiert/offen markiert.',
    );
    if (!accepted) return;

    annotations.assignments[details.messageId] = details.destinationSituationId;
    if (annotations.messageOverrides) delete annotations.messageOverrides[details.messageId];
    markSituationChanged(annotations, details.sourceSituationId);
    markSituationChanged(annotations, details.destinationSituationId);
    appendEvent(annotations, {
      type: 'boundary_cross_owner_moved',
      messageId: details.messageId,
      sourceSituationId: details.sourceSituationId,
      destinationSituationId: details.destinationSituationId,
      reviewer: currentReviewer(),
      at: new Date().toISOString(),
    });

    try {
      await saveAnnotations(
        annotations,
        selectedId,
        action.startsWith('end') ? 'end' : 'start',
      );
    } catch (caught) {
      alert(caught?.message || 'Die grenzüberschreitende Änderung konnte nicht gespeichert werden.');
    }
  }

  async function excludeMessage(id) {
    const selectedId = selectedSituationId();
    if (!selectedId || owner(selectedId) !== currentReviewer()) return;
    const annotations = cloneAnnotations();
    reconcileVisibleBoundaryEdits(annotations, selectedId);
    if (Number(annotations.assignments?.[id] || 0) !== selectedId) return;

    delete annotations.assignments[id];
    annotations.messageOverrides = annotations.messageOverrides && typeof annotations.messageOverrides === 'object'
      ? annotations.messageOverrides
      : {};
    annotations.messageOverrides[id] = {
      status: 'excluded_with_reason',
      reason: 'Nicht Teil dieser Situation',
      situationId: selectedId,
      reviewer: currentReviewer(),
      at: new Date().toISOString(),
    };
    markSituationChanged(annotations, selectedId);
    appendEvent(annotations, {
      type: 'message_excluded_from_situation',
      messageId: id,
      situationId: selectedId,
      reviewer: currentReviewer(),
      at: new Date().toISOString(),
    });

    try {
      await saveAnnotations(annotations, selectedId, 'message');
    } catch (caught) {
      alert(caught?.message || 'Die Nachricht konnte nicht aus der Situation genommen werden.');
    }
  }

  async function restoreMessage(id) {
    const selectedId = selectedSituationId();
    if (!selectedId || owner(selectedId) !== currentReviewer()) return;
    const annotations = cloneAnnotations();
    annotations.assignments = annotations.assignments || {};
    annotations.assignments[id] = selectedId;
    if (annotations.messageOverrides) delete annotations.messageOverrides[id];
    markSituationChanged(annotations, selectedId);
    appendEvent(annotations, {
      type: 'message_restored_to_situation',
      messageId: id,
      situationId: selectedId,
      reviewer: currentReviewer(),
      at: new Date().toISOString(),
    });

    try {
      await saveAnnotations(annotations, selectedId, 'message');
    } catch (caught) {
      alert(caught?.message || 'Die Nachricht konnte nicht wieder aufgenommen werden.');
    }
  }

  function nextOwnOpenSituationId(annotations, currentId) {
    const reviewer = currentReviewer();
    const open = situations(annotations).filter((item) => (
      owner(item.id) === reviewer
      && !['confirmed', 'corrected'].includes(String(item.status || 'open').toLocaleLowerCase('de-DE'))
    ));
    const index = open.findIndex((item) => Number(item.id) === Number(currentId));
    return Number((open[index + 1] || open[0])?.id || 0) || 0;
  }

  async function confirmCorrected(id) {
    const annotations = cloneAnnotations();
    const item = situation(id, annotations);
    if (!item || owner(id) !== currentReviewer()) return;
    item.status = 'corrected';
    item.reviewedBy = currentReviewer();
    item.reviewedAt = new Date().toISOString();
    delete item.truewordsNeedsCorrectedConfirmation;
    appendEvent(annotations, {
      type: 'situation_corrected',
      situationId: id,
      reviewer: currentReviewer(),
      at: item.reviewedAt,
    });

    try {
      await saveAnnotations(annotations, nextOwnOpenSituationId(annotations, id));
    } catch (caught) {
      alert(caught?.message || 'Die korrigierte Situation konnte nicht bestätigt werden.');
    }
  }

  function augmentMediaPlaceholders() {
    document.querySelectorAll('#message-list .message[data-message-id]').forEach((card) => {
      if (card.querySelector('.media-placeholder')) return;
      const message = snapshot.messageById.get(String(card.dataset.messageId || ''));
      if (!message) return;
      const placeholder = mediaPlaceholder(message);
      if (!placeholder) return;
      const text = textValue(message.text).trim();
      if (text === placeholder) return;
      const textElement = card.querySelector('.message-text');
      if (!textElement) return;
      const element = document.createElement('div');
      element.className = 'media-placeholder';
      element.textContent = placeholder;
      textElement.before(element);
    });
  }

  function augmentCrossOwnerButtons() {
    const selectedId = selectedSituationId();
    if (!selectedId || owner(selectedId) !== currentReviewer()) return;
    const annotations = snapshot.payload?.annotations;
    if (!annotations) return;
    document.querySelectorAll('[data-boundary]').forEach((button) => {
      const details = boundaryDetails(button.dataset.boundary, annotations, selectedId);
      if (isCrossOwner(details)) {
        button.disabled = false;
        button.classList.add('cross-owner-boundary');
        button.title = `Grenze in den Prüfbereich von ${owner(
          details.sourceSituationId === selectedId ? details.destinationSituationId : details.sourceSituationId,
        )} verschieben`;
      }
    });
  }

  function createExcludedCard(message, id) {
    const card = document.createElement('article');
    const mine = String(message?.from || '').toLocaleLowerCase('de-DE')
      .includes(currentReviewer().toLocaleLowerCase('de-DE'));
    card.className = `message context precision-excluded ${mine ? 'mine' : ''}`;
    card.dataset.messageId = id;
    const placeholder = mediaPlaceholder(message);
    const text = textValue(message?.text) || '[Nachricht ohne Text]';
    card.innerHTML = `
      <div class="message-meta">
        <strong>${escapeHtml(message?.from || 'Unbekannt')}</strong>
        <span>ID ${escapeHtml(id)}</span>
        <span class="context-badge">Aus Situation entfernt · bleibt Kontext</span>
      </div>
      ${placeholder && text.trim() !== placeholder ? `<div class="media-placeholder">${escapeHtml(placeholder)}</div>` : ''}
      <div class="message-text">${escapeHtml(text)}</div>
      <div class="message-inline-actions">
        <button type="button" data-restore-message="${escapeHtml(id)}">Wieder in Situation aufnehmen</button>
      </div>`;
    return card;
  }

  function augmentExcludedMessages() {
    const selectedId = selectedSituationId();
    const annotations = snapshot.payload?.annotations;
    const container = document.querySelector('#message-list .situation-messages');
    if (!selectedId || !annotations || !container) return;
    container.querySelectorAll('.precision-excluded').forEach((element) => element.remove());

    const assignedIds = Object.entries(annotations.assignments || {})
      .filter(([, id]) => Number(id) === selectedId)
      .map(([id]) => id)
      .filter((id) => snapshot.messageIndex.has(id))
      .sort((left, right) => snapshot.messageIndex.get(left) - snapshot.messageIndex.get(right));
    if (!assignedIds.length) return;
    const first = snapshot.messageIndex.get(assignedIds[0]);
    const last = snapshot.messageIndex.get(assignedIds.at(-1));
    const overrides = annotations.messageOverrides || {};

    Object.entries(overrides)
      .filter(([id, override]) => (
        Number(override?.situationId || 0) === selectedId
        && override?.status === 'excluded_with_reason'
        && snapshot.messageIndex.has(id)
        && snapshot.messageIndex.get(id) > first
        && snapshot.messageIndex.get(id) < last
      ))
      .sort(([left], [right]) => snapshot.messageIndex.get(left) - snapshot.messageIndex.get(right))
      .forEach(([id]) => {
        const index = snapshot.messageIndex.get(id);
        const nextCard = [...container.querySelectorAll('.message.assigned[data-message-id]')]
          .find((card) => snapshot.messageIndex.get(String(card.dataset.messageId || '')) > index);
        const card = createExcludedCard(snapshot.messageById.get(id), id);
        if (nextCard) nextCard.before(card);
        else container.append(card);
      });
  }

  function augmentMessageActions() {
    const selectedId = selectedSituationId();
    if (!selectedId || owner(selectedId) !== currentReviewer()) return;
    const cards = [...document.querySelectorAll('#message-list .situation-messages .message.assigned[data-message-id]')]
      .filter((element) => !element.classList.contains('precision-excluded'));
    cards.forEach((card, index) => {
      card.querySelector('.message-inline-actions')?.remove();
      if (index === 0 || index === cards.length - 1) return;
      const actions = document.createElement('div');
      actions.className = 'message-inline-actions';
      actions.innerHTML = `<button type="button" data-exclude-message="${escapeHtml(card.dataset.messageId)}">Nicht Teil dieser Situation</button>`;
      card.append(actions);
    });
  }

  function augmentCorrectedConfirmation() {
    const selectedId = selectedSituationId();
    const item = situation(selectedId);
    if (!item?.truewordsNeedsCorrectedConfirmation) return;
    const confirmButton = document.getElementById('confirm');
    if (confirmButton) {
      confirmButton.disabled = false;
      confirmButton.textContent = 'Korrigiert bestätigen';
      confirmButton.dataset.precisionCorrected = String(selectedId);
    }
    const checkbox = document.querySelector(`[data-confirm-id="${selectedId}"]`);
    if (checkbox) {
      checkbox.disabled = false;
      checkbox.dataset.precisionCorrected = String(selectedId);
      checkbox.title = 'Korrigierte Situation bestätigen';
    }
  }

  function restoreSelectionAndScroll() {
    if (snapshot.restoring) return;
    const targetId = Number(sessionStorage.getItem(SELECT_KEY) || 0);
    if (!targetId) return;
    const button = document.querySelector(`[data-situation-id="${targetId}"]`);
    if (!button) return;
    snapshot.restoring = true;
    sessionStorage.removeItem(SELECT_KEY);
    button.click();
    requestAnimationFrame(() => {
      const edge = sessionStorage.getItem(SCROLL_KEY);
      sessionStorage.removeItem(SCROLL_KEY);
      const list = document.getElementById('message-list');
      if (list && edge === 'end') list.scrollTop = list.scrollHeight;
      if (list && edge === 'start') list.scrollTop = 0;
      snapshot.restoring = false;
    });
  }

  function enhance() {
    if (!snapshot.payload?.annotations) return;
    restoreSelectionAndScroll();
    augmentExcludedMessages();
    augmentMediaPlaceholders();
    augmentCrossOwnerButtons();
    augmentMessageActions();
    augmentCorrectedConfirmation();
  }

  function schedule() {
    if (snapshot.scheduled) return;
    snapshot.scheduled = true;
    requestAnimationFrame(() => {
      snapshot.scheduled = false;
      enhance();
    });
  }

  document.addEventListener('click', (event) => {
    const boundary = event.target.closest?.('[data-boundary].cross-owner-boundary');
    if (boundary) {
      event.preventDefault();
      event.stopImmediatePropagation();
      moveCrossOwnerBoundary(boundary.dataset.boundary);
      return;
    }

    const exclude = event.target.closest?.('[data-exclude-message]');
    if (exclude) {
      event.preventDefault();
      event.stopImmediatePropagation();
      excludeMessage(String(exclude.dataset.excludeMessage || ''));
      return;
    }

    const restore = event.target.closest?.('[data-restore-message]');
    if (restore) {
      event.preventDefault();
      event.stopImmediatePropagation();
      restoreMessage(String(restore.dataset.restoreMessage || ''));
      return;
    }

    const corrected = event.target.closest?.('[data-precision-corrected]');
    if (corrected) {
      event.preventDefault();
      event.stopImmediatePropagation();
      confirmCorrected(Number(corrected.dataset.precisionCorrected));
    }
  }, true);

  const app = document.getElementById('review-app');
  if (app) {
    new MutationObserver(schedule).observe(app, { childList: true, subtree: true });
  }
  schedule();
})();
