(() => {
  'use strict';

  const app = document.getElementById('review-app');
  const SHOW_COMPLETED_KEY = 'truewords-review/show-completed';
  const state = {
    user: null,
    dataset: null,
    owners: {},
    annotations: null,
    messages: [],
    selectedId: null,
    modified: new Set(),
    dirty: false,
    saving: false,
    showCompleted: sessionStorage.getItem(SHOW_COMPLETED_KEY) === '1',
    scrollTarget: null,
    pollTimer: null,
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function messageId(message) {
    return String(message?.id ?? '');
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

  function speaker(message) {
    return String(message?.from || message?.actor || 'Unbekannt');
  }

  function isOwnMessage(message) {
    const name = speaker(message).toLocaleLowerCase('de-DE');
    return state.user?.role === 'Lena' ? name.includes('lena') : name.includes('philipp');
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function short(value, length = 54) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      const failure = new Error(payload.error || `HTTP ${response.status}`);
      failure.status = response.status;
      failure.details = payload.details;
      throw failure;
    }
    return payload;
  }

  function situations() {
    return [...(state.annotations?.situations || [])]
      .sort((left, right) => Number(left.id) - Number(right.id));
  }

  function situation(id) {
    return situations().find((item) => Number(item.id) === Number(id)) || null;
  }

  function owner(id) {
    return state.owners[String(id)] || 'Unbekannt';
  }

  function isMine(id) {
    return owner(id) === state.user?.role;
  }

  function assignment(message) {
    return Number(state.annotations?.assignments?.[messageId(message)] || 0);
  }

  function situationMessages(id) {
    return state.messages.filter((message) => assignment(message) === Number(id));
  }

  function statusValue(item) {
    const value = String(item?.status || 'open').toLocaleLowerCase('de-DE');
    return ['confirmed', 'corrected', 'unclear'].includes(value) ? value : 'open';
  }

  function isDone(item) {
    return ['confirmed', 'corrected'].includes(statusValue(item));
  }

  function statusLabel(item) {
    return {
      open: 'Offen',
      confirmed: 'Bestätigt',
      corrected: 'Korrigiert',
      unclear: 'Unklar',
    }[statusValue(item)];
  }

  function openSituations() {
    return situations().filter((item) => !isDone(item));
  }

  function completedSituations() {
    return situations().filter(isDone);
  }

  function listSituations() {
    return situations().filter((item) => state.showCompleted || !isDone(item));
  }

  function selectedSituation() {
    return situation(state.selectedId);
  }

  function firstOwnSelection() {
    const mine = openSituations().filter((item) => isMine(item.id));
    const preferred = mine.find((item) => statusValue(item) === 'open' || statusValue(item) === 'unclear');
    return Number((preferred || mine[0] || openSituations()[0])?.id || 0) || null;
  }

  function nextOwnOpenSituation(currentId) {
    const mine = openSituations().filter((item) => isMine(item.id));
    const currentIndex = mine.findIndex((item) => Number(item.id) === Number(currentId));
    return mine.slice(currentIndex + 1)[0] || mine[0] || openSituations()[0] || null;
  }

  function ownerStats() {
    const result = {
      Philipp: { situations: 0, messages: 0, done: 0 },
      Lena: { situations: 0, messages: 0, done: 0 },
    };
    situations().forEach((item) => {
      const assignedOwner = owner(item.id);
      if (!result[assignedOwner]) return;
      result[assignedOwner].situations += 1;
      result[assignedOwner].messages += situationMessages(item.id).length;
      if (isDone(item)) result[assignedOwner].done += 1;
    });
    return result;
  }

  function setSync(text, status = 'ok') {
    const element = document.getElementById('sync-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.state = status;
  }

  function cleanLabel(item) {
    return String(item.label || `Situation ${item.id}`)
      .replace(/^KI-Vorschlag\s*\d*\s*·?\s*/iu, '');
  }

  function situationRow(item) {
    const messages = situationMessages(item.id);
    const first = messages[0];
    const last = messages.at(-1);
    const currentOwner = owner(item.id);
    const mine = isMine(item.id);
    const active = Number(item.id) === Number(state.selectedId);
    const done = isDone(item);
    const changed = state.modified.has(Number(item.id));
    const canConfirm = mine && messages.length && !done;
    const checkLabel = done
      ? `${statusLabel(item)}. Zum Korrigieren Situation öffnen.`
      : canConfirm
        ? `Situation ${item.id} bestätigen`
        : `Situation ${item.id} wird von ${currentOwner} geprüft`;

    return `
      <div class="situation-row status-${statusValue(item)} ${active ? 'active' : ''} ${mine ? '' : 'other-owner'}">
        <button type="button"
          class="situation-check ${done ? 'done' : ''} ${changed ? 'changed' : ''}"
          data-confirm-id="${Number(item.id)}"
          aria-label="${escapeHtml(checkLabel)}"
          title="${escapeHtml(checkLabel)}"
          ${canConfirm ? '' : 'disabled'}>${done ? '✓' : ''}</button>
        <button type="button" class="situation-button" data-situation-id="${Number(item.id)}">
          <span class="situation-title">${Number(item.id)} · ${escapeHtml(cleanLabel(item))}</span>
          <span class="situation-meta">${messages.length} Nachrichten · ${escapeHtml(statusLabel(item))}</span>
          <span class="situation-range">${first ? `${escapeHtml(formatDate(first.date))} – ${escapeHtml(formatDate(last.date))}` : 'Keine Nachrichten zugeordnet'}</span>
          <span class="owner-badge ${mine ? 'mine' : ''}">${escapeHtml(currentOwner)}</span>
        </button>
      </div>`;
  }

  function messageCard(message, context = false) {
    const text = textValue(message?.text) || `[${message?.media_type || message?.file || 'Nachricht ohne Text'}]`;
    return `
      <article class="message ${isOwnMessage(message) ? 'mine' : ''} ${context ? 'context' : ''}"
        data-message-id="${escapeHtml(messageId(message))}">
        <div class="message-meta">
          <strong>${escapeHtml(speaker(message))}</strong>
          <span>${escapeHtml(formatDate(message?.date))}</span>
          <span>ID ${escapeHtml(messageId(message))}</span>
        </div>
        <div class="message-text">${escapeHtml(text)}</div>
      </article>`;
  }

  function contextMessages(id) {
    const assigned = situationMessages(id);
    if (!assigned.length) return { before: null, after: null };
    const firstIndex = state.messages.findIndex((message) => messageId(message) === messageId(assigned[0]));
    const lastIndex = state.messages.findIndex((message) => messageId(message) === messageId(assigned.at(-1)));
    return {
      before: firstIndex > 0 ? state.messages[firstIndex - 1] : null,
      after: lastIndex >= 0 && lastIndex < state.messages.length - 1 ? state.messages[lastIndex + 1] : null,
    };
  }

  function canTake(message, selectedId) {
    if (!message) return false;
    const existingId = assignment(message);
    if (!existingId || existingId === Number(selectedId)) return true;
    return owner(existingId) === state.user?.role;
  }

  function previousSituationId(id) {
    const all = situations();
    const index = all.findIndex((item) => Number(item.id) === Number(id));
    return index > 0 ? Number(all[index - 1].id) : 0;
  }

  function nextSituationId(id) {
    const all = situations();
    const index = all.findIndex((item) => Number(item.id) === Number(id));
    return index >= 0 && index < all.length - 1 ? Number(all[index + 1].id) : 0;
  }

  function boundaryCapabilities(id) {
    const current = situationMessages(id);
    if (!current.length || !isMine(id)) {
      return { startEarlier: false, startLater: false, endEarlier: false, endLater: false };
    }
    const firstIndex = state.messages.findIndex((message) => messageId(message) === messageId(current[0]));
    const lastIndex = state.messages.findIndex((message) => messageId(message) === messageId(current.at(-1)));
    const before = firstIndex > 0 ? state.messages[firstIndex - 1] : null;
    const after = lastIndex < state.messages.length - 1 ? state.messages[lastIndex + 1] : null;
    const previousId = assignment(before) || previousSituationId(id);
    const nextId = assignment(after) || nextSituationId(id);
    return {
      startEarlier: canTake(before, id),
      startLater: current.length > 1 && (!previousId || owner(previousId) === state.user?.role),
      endEarlier: current.length > 1 && (!nextId || owner(nextId) === state.user?.role),
      endLater: canTake(after, id),
    };
  }

  function emptyChatPanel() {
    const ownOpen = openSituations().filter((item) => isMine(item.id)).length;
    const message = ownOpen
      ? 'Wähle links eine offene Situation aus.'
      : 'Alle dir zugeordneten Situationen sind bestätigt. Über „Erledigte anzeigen“ kannst du sie später erneut öffnen und korrigieren.';
    return `
      <section class="panel chat-panel empty-chat">
        <div class="empty-chat-content">
          <div class="empty-check">✓</div>
          <h2>${ownOpen ? 'Situation auswählen' : 'Eigener Prüfbereich abgeschlossen'}</h2>
          <p>${escapeHtml(message)}</p>
        </div>
      </section>`;
  }

  function chatPanel(selected) {
    if (!selected) return emptyChatPanel();

    const messages = situationMessages(selected.id);
    const context = contextMessages(selected.id);
    const capabilities = boundaryCapabilities(selected.id);
    const mine = isMine(selected.id);
    const changed = state.modified.has(Number(selected.id));
    const note = String(selected.note || 'KI-Vorschlag zur manuellen Grenzprüfung.');

    return `
      <section class="panel chat-panel">
        <div class="chat-head">
          <div>
            <div class="eyebrow">Situation ${Number(selected.id)}</div>
            <h2>${escapeHtml(String(selected.label || `Situation ${selected.id}`))}</h2>
            <p>${escapeHtml(short(note, 220))}</p>
          </div>
          <div class="head-badges">
            <span class="owner-badge ${mine ? 'mine' : ''}">${escapeHtml(owner(selected.id))}</span>
            <span class="status-badge">${escapeHtml(statusLabel(selected))}</span>
          </div>
        </div>

        <div class="boundary-box">
          <div class="boundary-row">
            <strong>Anfang</strong>
            <span class="boundary-value">${messages[0] ? escapeHtml(formatDate(messages[0].date)) : 'leer'}</span>
            <button type="button" data-boundary="start-earlier" ${capabilities.startEarlier ? '' : 'disabled'}>← früher</button>
            <button type="button" data-boundary="start-later" ${capabilities.startLater ? '' : 'disabled'}>später →</button>
          </div>
          <div class="boundary-row">
            <strong>Ende</strong>
            <span class="boundary-value">${messages.at(-1) ? escapeHtml(formatDate(messages.at(-1).date)) : 'leer'}</span>
            <button type="button" data-boundary="end-earlier" ${capabilities.endEarlier ? '' : 'disabled'}>← früher</button>
            <button type="button" data-boundary="end-later" ${capabilities.endLater ? '' : 'disabled'}>später →</button>
          </div>
        </div>

        <div class="message-list" id="message-list">
          ${context.before ? '<div class="context-label">Nachricht davor</div>' + messageCard(context.before, true) : ''}
          <div class="context-label">Diese Situation · ${messages.length} Nachrichten</div>
          ${messages.length ? messages.map((message) => messageCard(message)).join('') : '<p>Dieser Situation sind keine Nachrichten zugeordnet.</p>'}
          ${context.after ? '<div class="context-label">Nachricht danach</div>' + messageCard(context.after, true) : ''}
        </div>

        <div class="review-actions">
          <div class="review-note">
            ${mine
              ? changed
                ? 'Grenze geändert. Das Häkchen links oder diese Schaltfläche speichert die Situation als korrigiert.'
                : isDone(selected)
                  ? 'Diese Situation ist erledigt. Verschiebe Anfang oder Ende, um sie erneut zu korrigieren.'
                  : 'Bestätigen über das Häkchen links in der Situationsliste oder hier.'
              : `Nur Ansicht: Diese Situation wird von ${escapeHtml(owner(selected.id))} geprüft.`}
          </div>
          <button id="confirm" class="confirm" type="button" ${mine && messages.length && !isDone(selected) ? '' : 'disabled'}>
            ${changed ? 'Korrigiert bestätigen' : 'Situation bestätigen'}
          </button>
        </div>
      </section>`;
  }

  function renderWorkspace() {
    const selected = selectedSituation();
    const stats = ownerStats();
    const open = openSituations();
    const completed = completedSituations();
    const visible = listSituations();

    app.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div class="brand">
            <div class="logo">TW</div>
            <div><div class="eyebrow">Gemeinsame Prüf-PWA</div><h1>Situationen prüfen</h1></div>
          </div>
          <nav class="account-nav">
            <span class="account-email">${escapeHtml(state.user.email)}</span>
            ${state.user.canUpload ? '<a class="button" href="/upload.html">Uploads</a>' : ''}
            <button id="logout" type="button">Abmelden</button>
          </nav>
        </header>
        <div class="summarybar">
          <span><strong>${escapeHtml(state.dataset.name)}</strong> · ${open.length} offen / ${situations().length} gesamt</span>
          <span>Philipp: ${stats.Philipp.done}/${stats.Philipp.situations} erledigt · Lena: ${stats.Lena.done}/${stats.Lena.situations}</span>
          <span id="sync-status" class="sync-status" data-state="${state.dirty ? 'working' : 'ok'}">${state.dirty ? 'Änderungen noch nicht bestätigt' : `Synchronisiert · Revision ${state.dataset.revision}`}</span>
        </div>

        <main class="review-grid">
          <aside class="panel situation-panel">
            <div class="panel-head">
              <div><div class="eyebrow">Offene Vorschläge</div><h2>Situationen</h2></div>
              <span class="count-pill">${open.length}</span>
            </div>
            <div class="list-controls">
              <span>Häkchen links = bestätigen</span>
              <button id="toggle-completed" type="button" class="secondary small">
                ${state.showCompleted ? 'Erledigte ausblenden' : `Erledigte anzeigen (${completed.length})`}
              </button>
            </div>
            <div class="list-legend">
              <span class="legend-item"><i class="legend-dot open"></i> offen</span>
              <span class="legend-item"><i class="legend-dot confirmed"></i> bestätigt</span>
              <span class="legend-item"><i class="legend-dot corrected"></i> korrigiert</span>
              <span class="legend-item"><i class="legend-dot unclear"></i> unklar</span>
            </div>
            <div class="situation-list">
              ${visible.length ? visible.map(situationRow).join('') : '<div class="list-empty">Keine offenen Situationen mehr.</div>'}
            </div>
          </aside>

          ${chatPanel(selected)}
        </main>
      </div>`;

    bindWorkspace();
    requestAnimationFrame(restoreScrollPosition);
  }

  function restoreScrollPosition() {
    const selectedButton = document.querySelector(`.situation-button[data-situation-id="${Number(state.selectedId)}"]`);
    selectedButton?.scrollIntoView({ block: 'nearest' });

    if (!state.scrollTarget) return;
    const target = [...document.querySelectorAll('#message-list [data-message-id]')]
      .find((element) => element.dataset.messageId === state.scrollTarget.messageId);
    const list = document.getElementById('message-list');
    if (target && list) {
      if (state.scrollTarget.edge === 'end') {
        list.scrollTop = Math.max(0, target.offsetTop + target.offsetHeight - list.clientHeight + 18);
      } else {
        list.scrollTop = Math.max(0, target.offsetTop - 18);
      }
      target.classList.add('boundary-focus');
      setTimeout(() => target.classList.remove('boundary-focus'), 900);
    }
    state.scrollTarget = null;
  }

  function bindWorkspace() {
    document.getElementById('logout')?.addEventListener('click', signOut);
    document.getElementById('toggle-completed')?.addEventListener('click', () => {
      state.showCompleted = !state.showCompleted;
      sessionStorage.setItem(SHOW_COMPLETED_KEY, state.showCompleted ? '1' : '0');
      if (!state.showCompleted && selectedSituation() && isDone(selectedSituation())) {
        state.selectedId = firstOwnSelection();
      }
      renderWorkspace();
    });

    document.querySelectorAll('[data-situation-id]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedId = Number(button.dataset.situationId);
        state.scrollTarget = null;
        renderWorkspace();
      });
    });

    document.querySelectorAll('[data-confirm-id]').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const id = Number(button.dataset.confirmId);
        if (!id || button.disabled) return;
        state.selectedId = id;
        await confirmSituation(id);
      });
    });

    document.querySelectorAll('[data-boundary]').forEach((button) => {
      button.addEventListener('click', () => shiftBoundary(button.dataset.boundary));
    });
    document.getElementById('confirm')?.addEventListener('click', () => confirmSituation(Number(state.selectedId)));
  }

  function markModified(...ids) {
    ids.filter(Boolean).forEach((id) => {
      const item = situation(id);
      if (item && isDone(item)) item.status = 'open';
      state.modified.add(Number(id));
    });
    state.dirty = true;
  }

  function removeEmptyOwnSituations(exceptId = 0) {
    const emptyIds = situations()
      .filter((item) => (
        Number(item.id) !== Number(exceptId)
        && isMine(item.id)
        && situationMessages(item.id).length === 0
      ))
      .map((item) => Number(item.id));

    if (!emptyIds.length) return [];
    const emptySet = new Set(emptyIds);
    state.annotations.situations = state.annotations.situations
      .filter((item) => !emptySet.has(Number(item.id)));

    emptyIds.forEach((emptyId) => {
      delete state.owners[String(emptyId)];
      state.modified.delete(emptyId);
    });

    state.annotations.events = Array.isArray(state.annotations.events)
      ? state.annotations.events
      : [];
    const at = new Date().toISOString();
    emptyIds.forEach((emptyId) => {
      state.annotations.events.push({
        type: 'empty_situation_removed',
        situationId: emptyId,
        reviewer: state.user.role,
        at,
      });
    });
    state.annotations.events = state.annotations.events.slice(-2000);
    state.dirty = true;
    return emptyIds;
  }

  function shiftBoundary(action) {
    const id = Number(state.selectedId);
    const current = situationMessages(id);
    if (!isMine(id) || !current.length) return;

    const firstIndex = state.messages.findIndex((message) => messageId(message) === messageId(current[0]));
    const lastIndex = state.messages.findIndex((message) => messageId(message) === messageId(current.at(-1)));
    const assignments = state.annotations.assignments;
    let movedMessage = null;
    let destinationId = 0;

    if (action === 'start-earlier') {
      movedMessage = state.messages[firstIndex - 1];
      if (!canTake(movedMessage, id)) return;
      destinationId = assignment(movedMessage);
      assignments[messageId(movedMessage)] = id;
    }

    if (action === 'start-later' && current.length > 1) {
      movedMessage = current[0];
      const before = state.messages[firstIndex - 1];
      destinationId = assignment(before) || previousSituationId(id);
      if (destinationId && owner(destinationId) !== state.user.role) return;
      if (destinationId) assignments[messageId(movedMessage)] = destinationId;
      else delete assignments[messageId(movedMessage)];
    }

    if (action === 'end-earlier' && current.length > 1) {
      movedMessage = current.at(-1);
      const after = state.messages[lastIndex + 1];
      destinationId = assignment(after) || nextSituationId(id);
      if (destinationId && owner(destinationId) !== state.user.role) return;
      if (destinationId) assignments[messageId(movedMessage)] = destinationId;
      else delete assignments[messageId(movedMessage)];
    }

    if (action === 'end-later') {
      movedMessage = state.messages[lastIndex + 1];
      if (!canTake(movedMessage, id)) return;
      destinationId = assignment(movedMessage);
      assignments[messageId(movedMessage)] = id;
    }

    if (!movedMessage) return;
    markModified(id, destinationId && destinationId !== id ? destinationId : 0);
    removeEmptyOwnSituations(id);

    const updated = situationMessages(id);
    const boundaryMessage = action.startsWith('end') ? updated.at(-1) : updated[0];
    state.scrollTarget = boundaryMessage
      ? { messageId: messageId(boundaryMessage), edge: action.startsWith('end') ? 'end' : 'start' }
      : null;
    renderWorkspace();
  }

  async function saveState() {
    if (state.saving) return;
    state.saving = true;
    setSync('Wird gespeichert …', 'working');
    try {
      const result = await fetchJson('/api/state', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          datasetId: state.dataset.id,
          annotations: state.annotations,
        }),
      });
      state.dataset.revision = Number(result.revision || state.dataset.revision + 1);
      state.dirty = false;
      setSync(`Gespeichert · Revision ${state.dataset.revision}`, 'ok');
    } finally {
      state.saving = false;
    }
  }

  async function confirmSituation(id) {
    const item = situation(id);
    if (!item || !isMine(item.id) || state.saving || isDone(item)) return;
    if (!situationMessages(item.id).length) return;

    const corrected = state.modified.has(Number(item.id));
    item.status = corrected ? 'corrected' : 'confirmed';
    item.reviewedBy = state.user.role;
    item.reviewedAt = new Date().toISOString();
    state.annotations.events = Array.isArray(state.annotations.events) ? state.annotations.events : [];
    state.annotations.events.push({
      type: corrected ? 'situation_corrected' : 'situation_confirmed',
      situationId: Number(item.id),
      reviewer: state.user.role,
      at: item.reviewedAt,
    });
    state.annotations.events = state.annotations.events.slice(-2000);
    state.dirty = true;

    try {
      await saveState();
      state.modified.delete(Number(item.id));
      const next = nextOwnOpenSituation(item.id);
      state.selectedId = next ? Number(next.id) : null;
      state.scrollTarget = null;
      renderWorkspace();
    } catch (caught) {
      item.status = corrected ? 'open' : 'open';
      setSync(caught?.message || 'Speichern fehlgeschlagen.', 'error');
      alert(caught?.message || 'Die Bestätigung konnte nicht gespeichert werden.');
      renderWorkspace();
    }
  }

  async function poll() {
    if (!state.dataset || state.dirty || state.saving || document.hidden) return;
    try {
      const result = await fetchJson(`/api/state?dataset=${encodeURIComponent(state.dataset.id)}`);
      const remoteRevision = Number(result.dataset?.revision || 0);
      if (remoteRevision <= Number(state.dataset.revision)) return;
      state.annotations = result.annotations;
      state.owners = result.owners || state.owners;
      state.dataset.revision = remoteRevision;
      if (state.selectedId && !situation(state.selectedId)) state.selectedId = firstOwnSelection();
      renderWorkspace();
      setSync(`Aktualisiert · Revision ${remoteRevision}`, 'ok');
    } catch (caught) {
      setSync(caught?.message || 'Synchronisierung fehlgeschlagen.', 'error');
    }
  }

  async function signOut() {
    await fetchJson('/api/auth/logout', { method: 'POST' }).catch(() => null);
    location.replace('/login.html');
  }

  function renderError(message) {
    app.innerHTML = `
      <main class="error-screen">
        <section class="error-card">
          <div class="eyebrow">Prüfstand nicht verfügbar</div>
          <h1>Laden fehlgeschlagen</h1>
          <p>${escapeHtml(message)}</p>
          <div class="error-actions">
            <button class="primary" type="button" id="retry">Erneut laden</button>
            <a class="button" href="/upload.html">Zu den Uploads</a>
            <a class="button" href="/login.html">Zur Anmeldung</a>
          </div>
        </section>
      </main>`;
    document.getElementById('retry')?.addEventListener('click', boot);
  }

  async function boot() {
    try {
      const result = await fetchJson('/api/review/bootstrap');
      state.user = result.user;
      state.dataset = result.dataset;
      state.owners = result.owners || {};
      state.annotations = result.annotations;
      state.messages = result.messages || [];
      state.selectedId = firstOwnSelection();
      state.modified.clear();
      state.dirty = false;
      state.scrollTarget = null;
      renderWorkspace();
      clearInterval(state.pollTimer);
      state.pollTimer = setInterval(poll, 15000);
    } catch (caught) {
      if (caught?.status === 401) {
        location.replace('/login.html');
        return;
      }
      renderError(caught?.message || 'Die KI-Vorschläge konnten nicht geladen werden.');
    }
  }

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });

  boot();
})();
