(() => {
  'use strict';

  const STATE_PATH = '/api/state';
  const SELECT_KEY = 'truewords-review/precision-select';
  const SCROLL_KEY = 'truewords-review/precision-scroll';
  const REVIEWER_MODE_KEY = 'truewords-review/reviewer-mode';
  const snapshot = {
    payload: null,
    messageIndex: new Map(),
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const url = typeof args[0] === 'string'
        ? new URL(args[0], location.href)
        : new URL(args[0]?.url || '', location.href);
      const method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
      if ((url.pathname === '/api/review/bootstrap' || url.pathname === STATE_PATH) && method === 'GET') {
        response.clone().json().then(remember).catch(() => null);
      }
    } catch {
      // Original request remains authoritative.
    }
    return response;
  };

  function remember(payload) {
    if (!payload?.annotations) return;
    snapshot.payload = {
      ...(snapshot.payload || {}),
      ...payload,
      annotations: payload.annotations,
      owners: payload.owners || snapshot.payload?.owners || {},
      messages: payload.messages || snapshot.payload?.messages || [],
    };
    snapshot.messageIndex.clear();
    (snapshot.payload.messages || []).forEach((message, index) => {
      const id = String(message?.id ?? '');
      if (id) snapshot.messageIndex.set(id, index);
    });
  }

  function currentReviewer() {
    const active = document.querySelector('[data-reviewer-mode].active')?.dataset?.reviewerMode;
    if (active === 'Philipp' || active === 'Lena') return active;
    const stored = sessionStorage.getItem(REVIEWER_MODE_KEY);
    if (stored === 'Philipp' || stored === 'Lena') return stored;
    return snapshot.payload?.user?.role || 'Philipp';
  }

  function owner(id) {
    return snapshot.payload?.owners?.[String(id)] || 'Unbekannt';
  }

  function selectedSituationId() {
    const text = document.querySelector('.chat-head .eyebrow')?.textContent || '';
    return Number(text.match(/Situation\s+(\d+)/iu)?.[1] || 0);
  }

  function situations(annotations) {
    return [...(annotations?.situations || [])].sort((left, right) => Number(left.id) - Number(right.id));
  }

  function adjacentSituationId(id, direction, annotations) {
    const all = situations(annotations);
    const index = all.findIndex((item) => Number(item.id) === Number(id));
    if (index < 0) return 0;
    if (direction === 'previous') return index > 0 ? Number(all[index - 1].id) : 0;
    return index < all.length - 1 ? Number(all[index + 1].id) : 0;
  }

  function situation(id, annotations) {
    return situations(annotations).find((item) => Number(item.id) === Number(id)) || null;
  }

  function markChanged(annotations, id) {
    const item = situation(id, annotations);
    if (!item) return;
    item.status = 'open';
    item.truewordsNeedsCorrectedConfirmation = true;
    delete item.reviewedAt;
    delete item.reviewedBy;
  }

  function appendEvent(annotations, event) {
    annotations.events = Array.isArray(annotations.events) ? annotations.events : [];
    annotations.events.push(event);
    annotations.events = annotations.events.slice(-2000);
  }

  function visibleAssignedIds() {
    return [...document.querySelectorAll('#message-list .situation-messages .message.assigned[data-message-id]')]
      .filter((element) => !element.classList.contains('precision-excluded'))
      .map((element) => String(element.dataset.messageId || ''))
      .filter(Boolean);
  }

  function reconcileVisibleBoundaryEdits(annotations, selectedId) {
    const visibleIds = visibleAssignedIds();
    if (!visibleIds.length) return;
    const assignments = annotations.assignments || {};
    const visibleSet = new Set(visibleIds);
    const indices = visibleIds
      .map((id) => snapshot.messageIndex.get(id))
      .filter((index) => Number.isInteger(index));
    if (!indices.length) return;

    const first = Math.min(...indices);
    const last = Math.max(...indices);
    const previousId = adjacentSituationId(selectedId, 'previous', annotations);
    const nextId = adjacentSituationId(selectedId, 'next', annotations);

    for (const [id, rawSituationId] of Object.entries({ ...assignments })) {
      if (Number(rawSituationId) !== selectedId || visibleSet.has(id)) continue;
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

  function boundaryDetails(action, annotations, selectedId) {
    const assignments = annotations.assignments || {};
    const assigned = [...document.querySelectorAll('#message-list .situation-messages .message.assigned[data-message-id]')]
      .filter((element) => !element.classList.contains('precision-excluded'));
    const before = document.querySelector('#message-list .context-zone.before [data-message-id]');
    const after = document.querySelector('#message-list .context-zone.after [data-message-id]');
    let element = null;
    let destinationSituationId = 0;
    let boundarySituationId = 0;

    if (action === 'start-earlier') {
      element = before;
      destinationSituationId = selectedId;
      boundarySituationId = adjacentSituationId(selectedId, 'previous', annotations);
    } else if (action === 'end-later') {
      element = after;
      destinationSituationId = selectedId;
      boundarySituationId = adjacentSituationId(selectedId, 'next', annotations);
    } else if (action === 'start-later') {
      element = assigned[0] || null;
      destinationSituationId = Number(assignments[before?.dataset?.messageId] || adjacentSituationId(selectedId, 'previous', annotations));
      boundarySituationId = destinationSituationId;
    } else if (action === 'end-earlier') {
      element = assigned.at(-1) || null;
      destinationSituationId = Number(assignments[after?.dataset?.messageId] || adjacentSituationId(selectedId, 'next', annotations));
      boundarySituationId = destinationSituationId;
    }

    const id = String(element?.dataset?.messageId || '');
    return {
      messageId: id,
      actualSourceSituationId: Number(assignments[id] || 0),
      boundarySituationId,
      destinationSituationId,
    };
  }

  function isCrossOwner(details, selectedId) {
    if (!details.messageId || !details.destinationSituationId || !details.boundarySituationId) return false;
    const selectedOwner = owner(selectedId);
    return owner(details.boundarySituationId) !== selectedOwner;
  }

  async function save(annotations, selectedId, action) {
    const response = await nativeFetch(STATE_PATH, {
      method: 'PUT',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-truewords-reviewer': currentReviewer(),
      },
      body: JSON.stringify({
        datasetId: snapshot.payload?.dataset?.id,
        annotations,
      }),
    });
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    sessionStorage.setItem(SELECT_KEY, String(selectedId));
    sessionStorage.setItem(SCROLL_KEY, action.startsWith('end') ? 'end' : 'start');
    location.reload();
  }

  async function moveAcrossBoundary(action) {
    const selectedId = selectedSituationId();
    if (!snapshot.payload?.annotations || !selectedId || owner(selectedId) !== currentReviewer()) return;

    const annotations = structuredClone(snapshot.payload.annotations);
    reconcileVisibleBoundaryEdits(annotations, selectedId);
    const details = boundaryDetails(action, annotations, selectedId);
    if (!isCrossOwner(details, selectedId)) return;

    const otherOwner = owner(details.boundarySituationId);
    const unassigned = details.actualSourceSituationId === 0;
    const direction = details.destinationSituationId === selectedId ? 'in deine Situation übernehmen' : 'aus deiner Situation abgeben';
    const explanation = unassigned
      ? `Die Nachricht ${details.messageId} ist noch keiner Situation zugeordnet, liegt aber am Übergang zu ${otherOwner}s Prüfbereich.`
      : `Die Nachricht ${details.messageId} gehört derzeit zu einer Situation im Prüfbereich von ${otherOwner}.`;
    const accepted = confirm(`${explanation}\n\nTrotzdem ${direction}?`);
    if (!accepted) return;

    annotations.assignments = annotations.assignments || {};
    annotations.assignments[details.messageId] = details.destinationSituationId;
    if (annotations.messageOverrides) delete annotations.messageOverrides[details.messageId];

    markChanged(annotations, details.destinationSituationId);
    if (details.actualSourceSituationId && details.actualSourceSituationId !== details.destinationSituationId) {
      markChanged(annotations, details.actualSourceSituationId);
    }

    appendEvent(annotations, {
      type: 'boundary_cross_owner_moved',
      messageId: details.messageId,
      sourceSituationId: details.actualSourceSituationId,
      boundarySituationId: details.boundarySituationId,
      destinationSituationId: details.destinationSituationId,
      reviewer: currentReviewer(),
      sourceWasUnassigned: unassigned,
      at: new Date().toISOString(),
    });

    try {
      await save(annotations, selectedId, action);
    } catch (caught) {
      alert(caught?.message || 'Die Grenze konnte nicht über den Prüfbereich hinaus verschoben werden.');
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-boundary]');
    if (!button || !snapshot.payload?.annotations) return;
    const selectedId = selectedSituationId();
    const preview = structuredClone(snapshot.payload.annotations);
    reconcileVisibleBoundaryEdits(preview, selectedId);
    const details = boundaryDetails(button.dataset.boundary, preview, selectedId);
    if (!isCrossOwner(details, selectedId)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    moveAcrossBoundary(button.dataset.boundary);
  }, true);
})();
