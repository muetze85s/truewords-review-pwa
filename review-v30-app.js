(() => {
  'use strict';

  const app = document.getElementById('review-app');
  const THEME_KEY = 'truewords/theme';
  const REVIEWER_KEY = 'truewords-review/reviewer-mode';
  const MOBILE_BREAKPOINT = 840;
  const ACCOUNT_TIME_ZONES = {
    Philipp: { zone: 'Asia/Bangkok', label: 'Thailand' },
    Lena: { zone: 'Europe/Berlin', label: 'Deutschland' },
  };
  const DETAIL_LABELS = {
    classification: 'Klassifizierung',
    direction: 'Richtung',
    patterns: 'Muster',
    topics: 'Themen',
    startingConcern: 'Ausgangsanliegen',
    course: 'Verlauf',
    outcome: 'Ergebnis',
    repair: 'Reparatur',
    confidence: 'Sicherheit',
  };
  const DETAIL_PRIORITY = Object.keys(DETAIL_LABELS);

  const state = {
    user: null,
    dataset: null,
    annotations: null,
    owners: {},
    messages: [],
    replyMessages: new Map(),
    activeId: 0,
    reviewerMode: null,
    selectedMessageId: '',
    modified: new Set(),
    saving: false,
    dirty: false,
    pollTimer: 0,
    toastTimer: 0,
    chatFrame: 0,
    chatSyncTimer: 0,
    embla: null,
    emblaPointer: false,
    emblaSyncing: false,
    fadeObserver: null,
    suppressChatSyncUntil: 0,
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function firstName(value) {
    return String(value || '').trim().split(/\s+/u)[0] || '';
  }

  function textValue(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return String(part.text || '');
      return '';
    }).join('');
  }

  function messageId(message) {
    return String(message?.id ?? '');
  }

  function speaker(message) {
    return String(message?.from || message?.speaker || message?.actor || 'Unbekannt');
  }

  function speakerKey(message) {
    const name = speaker(message).toLocaleLowerCase('de-DE');
    return name.includes('lena') ? 'lena' : 'philipp';
  }

  function activeReviewer() {
    return state.reviewerMode || state.user?.role || 'Philipp';
  }

  function canSwitchReviewer() {
    return Boolean(state.user?.canUpload);
  }

  function accountTimeZone() {
    return ACCOUNT_TIME_ZONES[activeReviewer()]?.zone
      || Intl.DateTimeFormat().resolvedOptions().timeZone
      || 'UTC';
  }

  function accountTimeLabel() {
    const configured = ACCOUNT_TIME_ZONES[activeReviewer()];
    return configured ? `${configured.label} · ${configured.zone}` : accountTimeZone();
  }

  function messageDate(message) {
    const unix = Number(message?.date_unixtime);
    if (Number.isFinite(unix) && unix > 0) return new Date(unix * 1000);
    return new Date(String(message?.date || ''));
  }

  function formatParts(message) {
    const date = messageDate(message);
    if (Number.isNaN(date.getTime())) return { date: '', time: '' };
    return {
      date: new Intl.DateTimeFormat('de-DE', {
        timeZone: accountTimeZone(),
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
      }).format(date),
      time: new Intl.DateTimeFormat('de-DE', {
        timeZone: accountTimeZone(),
        hour: '2-digit',
        minute: '2-digit',
      }).format(date),
    };
  }

  function shortDate(message) {
    const value = formatParts(message).date;
    return value ? value.replace(/(\.\d{2})$/, '.') : '';
  }

  function assignment(message) {
    return Number(state.annotations?.assignments?.[messageId(message)] || 0);
  }

  function situation(id) {
    return (state.annotations?.situations || []).find((item) => Number(item.id) === Number(id)) || null;
  }

  function owner(id) {
    return state.owners[String(id)] || 'Unbekannt';
  }

  function isMine(id) {
    return owner(id) === activeReviewer();
  }

  function statusValue(item) {
    const value = String(item?.status || 'open').toLocaleLowerCase('de-DE');
    return ['confirmed', 'corrected', 'unclear'].includes(value) ? value : 'open';
  }

  function statusLabel(item) {
    return {
      open: 'offen',
      confirmed: 'bestätigt',
      corrected: 'korrigiert',
      unclear: 'unklar',
    }[statusValue(item)];
  }

  function isDone(item) {
    return ['confirmed', 'corrected'].includes(statusValue(item));
  }

  function situationMessages(id) {
    return state.messages.filter((message) => assignment(message) === Number(id));
  }

  function rangeFor(id) {
    const indexes = [];
    state.messages.forEach((message, index) => {
      if (assignment(message) === Number(id)) indexes.push(index);
    });
    if (!indexes.length) return null;
    return { first: indexes[0], last: indexes[indexes.length - 1], count: indexes.length };
  }

  function orderedSituations() {
    const firstIndexes = new Map();
    state.messages.forEach((message, index) => {
      const id = assignment(message);
      if (id && !firstIndexes.has(id)) firstIndexes.set(id, index);
    });
    return [...(state.annotations?.situations || [])]
      .filter((item) => firstIndexes.has(Number(item.id)))
      .sort((a, b) => (firstIndexes.get(Number(a.id)) ?? Infinity) - (firstIndexes.get(Number(b.id)) ?? Infinity));
  }

  function displayId(itemOrId) {
    const item = typeof itemOrId === 'object' ? itemOrId : situation(itemOrId);
    return String(item?.displayId || item?.id || itemOrId || '');
  }

  function situationMeta(item) {
    const messages = situationMessages(item.id);
    const first = messages[0];
    const last = messages.at(-1);
    const firstParts = first ? formatParts(first) : { date: '', time: '' };
    const lastParts = last ? formatParts(last) : { date: '', time: '' };
    return {
      count: messages.length,
      date: first ? shortDate(first) : '',
      fullDate: firstParts.date,
      startTime: firstParts.time,
      endTime: lastParts.time,
    };
  }

  function combinedDetails(item) {
    const merged = {};
    for (const source of [item?.analysis, item?.details, item?.reviewDetails]) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      Object.entries(source).forEach(([key, raw]) => {
        if (raw === undefined || raw === null || raw === '') return;
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
          merged[key] = { label: String(raw.label || DETAIL_LABELS[key] || key), value: raw.value };
        } else {
          merged[key] = { label: DETAIL_LABELS[key] || key, value: raw };
        }
      });
    }
    return Object.keys(merged)
      .sort((a, b) => {
        const ai = DETAIL_PRIORITY.indexOf(a);
        const bi = DETAIL_PRIORITY.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b, 'de');
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      })
      .map((key) => {
        const entry = merged[key];
        const value = Array.isArray(entry.value)
          ? entry.value.join(', ')
          : typeof entry.value === 'object'
            ? JSON.stringify(entry.value)
            : String(entry.value);
        return { key, label: entry.label, value };
      });
  }

  function completionStats() {
    const all = orderedSituations();
    const done = all.filter(isDone).length;
    return { all: all.length, done, percent: all.length ? Math.round((done / all.length) * 100) : 0 };
  }

  function icon(name) {
    const paths = {
      list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      moon: '<path d="M20 15.5A8.5 8.5 0 118.5 4 7 7 0 0020 15.5z"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      chevron: '<path d="M8 10l4 4 4-4"/>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
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

  function resolvedTheme() {
    const preference = localStorage.getItem(THEME_KEY) || document.documentElement.dataset.themePreference || 'system';
    if (preference === 'dark' || preference === 'light') return preference;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121214' : '#f3f4f6');
    const button = document.querySelector('[data-nav="theme"]');
    if (button) button.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  }

  function toggleTheme() {
    const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    document.documentElement.dataset.themePreference = next;
    applyTheme();
  }

  function reviewerControl() {
    if (!canSwitchReviewer()) {
      return `<div class="tw-pill" aria-label="Prüfer"><span>${escapeHtml(activeReviewer())}</span></div>`;
    }
    return `<label class="tw-pill" aria-label="Prüfer wechseln">
      <select id="reviewer-select">
        <option value="Philipp" ${activeReviewer() === 'Philipp' ? 'selected' : ''}>Philipp</option>
        <option value="Lena" ${activeReviewer() === 'Lena' ? 'selected' : ''}>Lena</option>
      </select>${icon('chevron')}
    </label>`;
  }

  function detailHtml(item) {
    const details = combinedDetails(item);
    if (!details.length) {
      return `<div class="tw-details"><div class="tw-empty">Noch keine Analysefelder.</div>${isMine(item.id) ? `<button class="tw-add-detail" type="button" data-add-detail="${item.id}">+ Analysefeld hinzufügen</button>` : ''}</div>`;
    }
    return `<dl class="tw-details">${details.map((detail) => `<div class="tw-detail">
      <dt>${escapeHtml(detail.label)}</dt><dd>${escapeHtml(detail.value)}</dd>
      ${isMine(item.id) ? `<button type="button" class="tw-mini-edit" data-edit-detail="${item.id}" data-detail-key="${escapeHtml(detail.key)}">Bearbeiten</button>` : ''}
    </div>`).join('')}${isMine(item.id) ? `<button class="tw-add-detail" type="button" data-add-detail="${item.id}">+ Analysefeld hinzufügen</button>` : ''}</dl>`;
  }

  function situationCard(item) {
    const meta = situationMeta(item);
    const active = Number(item.id) === Number(state.activeId);
    const done = isDone(item);
    return `<article class="tw-situation ${active ? 'is-active' : ''}" data-situation-card="${item.id}" data-status="${statusValue(item)}">
      <div class="tw-situation-row">
        <button class="tw-situation-open" type="button" data-open-situation="${item.id}">
          <div class="tw-sit-row">
            <span class="tw-sit-number">${escapeHtml(displayId(item))}</span>
            <span class="tw-sit-status">${escapeHtml(statusLabel(item))}</span>
            <span class="tw-sit-count">${meta.count} Nachr.</span>
          </div>
          <div class="tw-sit-sub"><strong>${escapeHtml(owner(item.id))}</strong><span>${escapeHtml(meta.date)}</span></div>
          <div class="tw-sit-time">${escapeHtml(meta.fullDate)} · ${escapeHtml(meta.startTime)}${meta.endTime ? ` – ${escapeHtml(meta.endTime)}` : ''}</div>
        </button>
        ${isMine(item.id) ? `<button class="tw-sit-check" type="button" data-card-confirm="${item.id}" aria-label="Situation ${escapeHtml(displayId(item))} ${done ? 'wieder öffnen' : 'bestätigen'}">${done ? '✓' : ''}</button>` : '<span class="tw-sit-check is-disabled" aria-hidden="true"></span>'}
      </div>
      ${detailHtml(item)}
    </article>`;
  }

  function renderSituationList(selector) {
    const target = document.querySelector(selector);
    if (!target) return;
    const before = target.scrollTop;
    target.innerHTML = orderedSituations().map(situationCard).join('') || '<div class="tw-empty">Keine Situationen vorhanden.</div>';
    target.scrollTop = before;
  }

  function replyPreview(message) {
    const replyId = String(Number(message?.reply_to_message_id || 0) || '');
    if (!replyId) return '';
    const original = state.messages.find((candidate) => messageId(candidate) === replyId) || state.replyMessages.get(replyId);
    if (!original) return `<div class="tw-reply"><strong>Antwort auf ${escapeHtml(replyId)}</strong>Originalnachricht nicht im Prüfbereich.</div>`;
    const originalText = textValue(original.text) || '[Nachricht ohne Text]';
    return `<div class="tw-reply"><strong>${escapeHtml(firstName(speaker(original)))} · ${escapeHtml(formatParts(original).time)}</strong>${escapeHtml(originalText.slice(0, 180))}${originalText.length > 180 ? '…' : ''}</div>`;
  }

  function renderMessage(message, index, ranges, previousDate) {
    const id = assignment(message);
    const range = id ? ranges.get(id) : null;
    const parts = formatParts(message);
    const item = id ? situation(id) : null;
    const dateMarker = parts.date && parts.date !== previousDate ? `<div class="tw-day" data-fade-node><span>${escapeHtml(parts.date)}</span></div>` : '';
    const groupStart = range && index === range.first;
    const active = id && Number(id) === Number(state.activeId);
    const selected = messageId(message) === state.selectedMessageId;
    const splitAllowed = selected && active && isMine(id) && range && index > range.first;
    const menu = selected ? `<div class="tw-message-menu">${splitAllowed ? `<button class="tw-action" type="button" data-split-here="${escapeHtml(messageId(message))}">Neue Situation ab hier</button>` : '<span></span>'}</div>` : '';
    const who = speakerKey(message);
    const boundaryStart = groupStart
      ? `<div class="tw-boundary ${active && isMine(id) ? 'is-active' : ''}" data-boundary-start="${id}" data-fade-node><span>Anfang · Situation ${escapeHtml(displayId(item || id))}</span><div class="tw-boundary-actions"><button class="tw-action" type="button" data-boundary="start-earlier">← früher</button><button class="tw-action" type="button" data-boundary="start-later">später →</button></div></div>` : '';
    const sentinel = groupStart ? `<div class="tw-situation-sentinel" data-situation-sentinel="${id}" aria-hidden="true"></div>` : '';
    return `${dateMarker}${sentinel}${boundaryStart}<div class="tw-message-wrap ${who} ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}" data-message-wrap="${escapeHtml(messageId(message))}" data-message-situation="${id || ''}" ${groupStart ? 'data-situation-first="true"' : ''} ${range && index === range.last ? 'data-situation-last="true"' : ''} data-fade-node>
      <article class="tw-message" data-message-id="${escapeHtml(messageId(message))}">
        <div class="tw-message-meta"><strong>${escapeHtml(firstName(speaker(message)))}</strong><span>${escapeHtml(parts.time)}</span></div>
        ${replyPreview(message)}
        <div class="tw-message-text">${escapeHtml(textValue(message.text) || `[${message.media_type || message.file || 'Nachricht ohne Text'}]`)}</div>
      </article>${menu}
    </div>`;
  }

  function renderEnd(item) {
    const active = Number(item.id) === Number(state.activeId);
    const mine = isMine(item.id);
    const done = isDone(item);
    return `<div class="tw-boundary ${active && mine ? 'is-active' : ''}" data-boundary-end="${item.id}" data-fade-node>
      <span>Ende · Situation ${escapeHtml(displayId(item))}</span>
      <div class="tw-boundary-actions">
        ${mine ? `<button class="tw-action" type="button" data-boundary="end-earlier">← früher</button><button class="tw-action" type="button" data-boundary="end-later">später →</button><button class="tw-confirm ${done ? 'done' : ''}" type="button" data-confirm="${item.id}">${done ? 'Bestätigung zurücknehmen' : 'Situation bestätigen'}</button>` : `<span class="tw-boundary-owner">${escapeHtml(owner(item.id))} prüft</span>`}
      </div>
    </div><div class="tw-end-card" data-end-card="${item.id}" aria-hidden="true"></div>`;
  }

  function renderChat() {
    const stream = document.querySelector('[data-chat-stream]');
    if (!stream) return;
    const ranges = new Map();
    orderedSituations().forEach((item) => ranges.set(Number(item.id), rangeFor(item.id)));
    let previousDate = '';
    const html = [];
    state.messages.forEach((message, index) => {
      const parts = formatParts(message);
      html.push(renderMessage(message, index, ranges, previousDate));
      previousDate = parts.date || previousDate;
      const id = assignment(message);
      const range = id ? ranges.get(id) : null;
      if (range && index === range.last) {
        const item = situation(id);
        if (item) html.push(renderEnd(item));
      }
    });
    stream.innerHTML = html.join('');
  }

  function renderSlider() {
    const container = document.querySelector('[data-situation-slider-container]');
    if (!container) return;
    container.innerHTML = orderedSituations().map((item) => `<div class="tw-embla-slide"><button type="button" class="tw-slider-item ${Number(item.id) === Number(state.activeId) ? 'is-active' : ''}" data-slider-situation="${item.id}" data-status="${statusValue(item)}"><strong>${escapeHtml(displayId(item))}</strong><span>${escapeHtml(situationMeta(item).date)}</span></button></div>`).join('');
  }

  function renderHeaderBits() {
    const item = situation(state.activeId);
    if (!item) return;
    const meta = situationMeta(item);
    const stats = completionStats();
    const summary = document.querySelector('[data-mobile-summary]');
    if (summary) summary.innerHTML = `<strong>Situation ${escapeHtml(displayId(item))} · ${escapeHtml(statusLabel(item))}</strong><span>${escapeHtml(owner(item.id))} · ${meta.count} Nachr. · ${escapeHtml(meta.date)}</span>`;
    const head = document.querySelector('[data-chat-head-main]');
    if (head) head.innerHTML = `<strong>Situation ${escapeHtml(displayId(item))} · ${escapeHtml(statusLabel(item))}</strong><span>${escapeHtml(owner(item.id))} · ${meta.count} Nachrichten · ${escapeHtml(meta.fullDate)} · ${escapeHtml(meta.startTime)} – ${escapeHtml(meta.endTime)} · ${escapeHtml(accountTimeLabel())}</span>`;
    const progress = document.querySelector('[data-progress]');
    if (progress) progress.innerHTML = `<div class="tw-progress-ring" aria-label="${stats.percent}% abgeschlossen"><span>${stats.percent}%</span></div><div class="tw-progress-copy"><strong>${stats.done}/${stats.all}</strong><span>geprüft</span></div>`;
    const statsNode = document.querySelector('[data-sidebar-stats]');
    if (statsNode) statsNode.textContent = `${stats.all} gesamt · ${stats.done} geprüft`;
  }

  function destroyTransientUi() {
    state.embla?.destroy?.();
    state.embla = null;
    state.fadeObserver?.disconnect?.();
    state.fadeObserver = null;
    if (state.chatFrame) cancelAnimationFrame(state.chatFrame);
    state.chatFrame = 0;
    clearTimeout(state.chatSyncTimer);
    state.chatSyncTimer = 0;
  }

  function captureViewport() {
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll) return null;
    const scrollRect = scroll.getBoundingClientRect();
    const selected = state.selectedMessageId
      ? document.querySelector(`[data-message-wrap="${CSS.escape(state.selectedMessageId)}"]`)
      : null;
    const selectedRect = selected?.getBoundingClientRect();
    let best = selected && selectedRect && selectedRect.bottom >= scrollRect.top && selectedRect.top <= scrollRect.bottom
      ? selected
      : null;
    if (!best) {
      const anchorY = scrollRect.top + scrollRect.height * 0.34;
      let bestDistance = Infinity;
      scroll.querySelectorAll('[data-message-wrap]').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.bottom < scrollRect.top || rect.top > scrollRect.bottom) return;
        const point = Math.min(Math.max(anchorY, rect.top), rect.bottom);
        const distance = Math.abs(point - anchorY);
        if (distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      });
    }
    return {
      messageId: String(best?.dataset.messageWrap || ''),
      relativeTop: best ? best.getBoundingClientRect().top - scrollRect.top : null,
      scrollTop: scroll.scrollTop,
      activeId: state.activeId,
      selectedMessageId: state.selectedMessageId,
    };
  }

  function restoreViewport(snapshot) {
    if (!snapshot) return;
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll) return;
    const anchor = snapshot.messageId ? document.querySelector(`[data-message-wrap="${CSS.escape(snapshot.messageId)}"]`) : null;
    if (anchor && Number.isFinite(snapshot.relativeTop)) {
      const scrollRect = scroll.getBoundingClientRect();
      const current = anchor.getBoundingClientRect().top - scrollRect.top;
      scroll.scrollTop += current - snapshot.relativeTop;
    } else if (Number.isFinite(snapshot.scrollTop)) {
      scroll.scrollTop = snapshot.scrollTop;
    }
  }

  function renderWorkspace({ viewport = null } = {}) {
    destroyTransientUi();
    document.documentElement.dataset.reviewer = activeReviewer().toLocaleLowerCase('de-DE');
    const stats = completionStats();
    app.innerHTML = `<div class="tw-app" data-app-shell>
      <header class="tw-topbar">
        <div class="tw-brand"><div class="tw-logo" aria-hidden="true"></div><div class="tw-brand-copy"><strong>TrueWords</strong><span>${escapeHtml(state.dataset?.name || 'Prüfstand')}</span></div></div>
        <div class="tw-mobile-summary" data-mobile-summary></div>
        <div class="tw-top-actions">${reviewerControl()}<button class="tw-icon-btn" type="button" data-nav="theme" aria-label="Darstellung wechseln"></button><button class="tw-profile" type="button" data-profile aria-label="Profil">${activeReviewer() === 'Lena' ? 'L' : 'P'}</button></div>
      </header>
      <nav class="tw-slider" data-situation-slider aria-label="Situationen"><div class="tw-embla-viewport" data-embla-viewport><div class="tw-embla-container" data-situation-slider-container></div></div></nav>
      <main class="tw-main"><div class="tw-workspace">
        <aside class="tw-sidebar"><div class="tw-sidebar-head"><div><h2>Situationen</h2><span data-sidebar-stats>${stats.all} gesamt · ${stats.done} geprüft</span></div><div class="tw-sync-dot" data-sync-dot></div></div><div class="tw-situation-list" data-situation-list></div></aside>
        <section class="tw-chat-card"><div class="tw-chat-head"><div class="tw-chat-head-main" data-chat-head-main></div><div class="tw-progress" data-progress></div></div><div class="tw-chat-scroll" data-chat-scroll><div class="tw-chat-stream" data-chat-stream></div></div></section>
      </div></main>
      <button class="tw-mobile-list-fab" type="button" data-open-drawer aria-label="Situationsliste öffnen">${icon('list')}</button>
      <dialog class="tw-drawer" data-drawer><section class="tw-drawer-panel"><div class="tw-sheet-handle" aria-hidden="true"></div><div class="tw-drawer-head"><h3>Situationen</h3><button class="tw-icon-btn" type="button" data-close-drawer aria-label="Schließen">${icon('close')}</button></div><div class="tw-drawer-body"><div class="tw-situation-list" data-drawer-list></div></div></section></dialog>
      <dialog class="tw-modal" data-detail-modal><section class="tw-modal-card" data-modal-card></section></dialog>
      <div class="tw-toast" data-toast></div>
    </div>`;
    renderSituationList('[data-situation-list]');
    renderSituationList('[data-drawer-list]');
    renderChat();
    renderSlider();
    renderHeaderBits();
    applyTheme();
    bindWorkspace();
    initEmbla();
    initFadeObserver();
    requestAnimationFrame(() => {
      if (viewport) {
        state.suppressChatSyncUntil = performance.now() + 80;
        restoreViewport(viewport);
        requestAnimationFrame(() => restoreViewport(viewport));
      }
      centerSituationLists(false);
      syncSliderToActive(true);
      updateFadeFallback();
    });
  }

  function toast(text) {
    const node = document.querySelector('[data-toast]');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => node.classList.remove('show'), 1900);
  }

  function setSync(mode, text) {
    const dot = document.querySelector('[data-sync-dot]');
    if (dot) dot.className = `tw-sync-dot ${mode === 'working' ? 'working' : mode === 'error' ? 'error' : ''}`;
    if (text) toast(text);
  }

  function centerList(selector, smooth = true) {
    const list = document.querySelector(selector);
    const card = list?.querySelector(`[data-situation-card="${state.activeId}"]`);
    if (!list || !card || list.clientHeight <= 0) return;
    const padding = Math.max(24, Math.ceil(list.clientHeight / 2));
    list.style.paddingTop = `${padding}px`;
    list.style.paddingBottom = `${padding}px`;
    const target = card.offsetTop - (list.clientHeight - card.offsetHeight) / 2;
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTo({ top: Math.min(max, Math.max(0, target)), behavior: smooth ? 'smooth' : 'auto' });
  }

  function centerSituationLists(smooth = true) {
    centerList('[data-situation-list]', smooth);
    const drawer = document.querySelector('[data-drawer]');
    if (drawer?.open) centerList('[data-drawer-list]', smooth);
  }

  function syncSliderToActive(jump = false) {
    if (!state.embla) return;
    const ordered = orderedSituations();
    const index = ordered.findIndex((item) => Number(item.id) === Number(state.activeId));
    if (index < 0 || state.embla.selectedScrollSnap() === index) return;
    state.emblaSyncing = true;
    state.embla.scrollTo(index, jump);
    requestAnimationFrame(() => { state.emblaSyncing = false; });
  }

  function updateActiveVisuals({ smoothList = true, syncSlider = true } = {}) {
    document.querySelectorAll('[data-situation-card]').forEach((node) => node.classList.toggle('is-active', Number(node.dataset.situationCard) === Number(state.activeId)));
    document.querySelectorAll('[data-slider-situation]').forEach((node) => node.classList.toggle('is-active', Number(node.dataset.sliderSituation) === Number(state.activeId)));
    document.querySelectorAll('[data-message-situation]').forEach((node) => node.classList.toggle('is-active', Number(node.dataset.messageSituation) === Number(state.activeId)));
    document.querySelectorAll('[data-boundary-start],[data-boundary-end]').forEach((node) => {
      const id = Number(node.dataset.boundaryStart || node.dataset.boundaryEnd || 0);
      node.classList.toggle('is-active', id === Number(state.activeId) && isMine(id));
    });
    renderHeaderBits();
    centerSituationLists(smoothList);
    if (syncSlider) syncSliderToActive(false);
  }

  function setActive(id, { source = 'manual', smoothList = true } = {}) {
    if (!situation(id)) return;
    const changed = Number(state.activeId) !== Number(id);
    state.activeId = Number(id);
    if (changed) updateActiveVisuals({ smoothList, syncSlider: source !== 'slider' });
    else if (source !== 'slider') syncSliderToActive(false);
  }

  function scrollChatToSituation(id, behavior = 'auto') {
    const target = document.querySelector(`[data-message-situation="${Number(id)}"][data-situation-first="true"]`);
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!target || !scroll) return;
    setActive(id, { source: 'manual' });
    state.suppressChatSyncUntil = behavior === 'smooth' ? performance.now() + 520 : 0;
    const scrollRect = scroll.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = Math.max(0, scroll.scrollTop + targetRect.top - scrollRect.top - 12);
    scroll.scrollTo({ top, behavior });
  }

  function activeFromChatPosition() {
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll) return;
    if (performance.now() < state.suppressChatSyncUntil) {
      clearTimeout(state.chatSyncTimer);
      state.chatSyncTimer = setTimeout(activeFromChatPosition, Math.max(16, state.suppressChatSyncUntil - performance.now() + 8));
      return;
    }
    const scrollRect = scroll.getBoundingClientRect();
    const anchor = scroll.scrollTop + scroll.clientHeight * 0.34;
    let candidate = Number(orderedSituations()[0]?.id || 0);
    document.querySelectorAll('[data-situation-sentinel]').forEach((node) => {
      const absoluteTop = scroll.scrollTop + node.getBoundingClientRect().top - scrollRect.top;
      if (absoluteTop <= anchor + 1) candidate = Number(node.dataset.situationSentinel || candidate);
    });
    if (candidate && candidate !== Number(state.activeId)) setActive(candidate, { source: 'scroll' });
  }

  function onChatScroll() {
    if (state.chatFrame) return;
    state.chatFrame = requestAnimationFrame(() => {
      state.chatFrame = 0;
      activeFromChatPosition();
    });
  }

  function initEmbla() {
    if (window.innerWidth > MOBILE_BREAKPOINT) return;
    const viewport = document.querySelector('[data-embla-viewport]');
    if (!viewport || typeof window.EmblaCarousel !== 'function') return;
    state.embla = window.EmblaCarousel(viewport, {
      align: 'center',
      containScroll: false,
      loop: false,
      dragFree: false,
      skipSnaps: false,
      duration: 22,
    });
    state.embla.on('pointerDown', () => { state.emblaPointer = true; });
    state.embla.on('settle', () => { state.emblaPointer = false; });
    state.embla.on('select', () => {
      if (state.emblaSyncing || !state.emblaPointer) return;
      const item = orderedSituations()[state.embla.selectedScrollSnap()];
      if (item) scrollChatToSituation(item.id, 'auto');
    });
    syncSliderToActive(true);
  }

  function updateFadeFallback() {
    if ('IntersectionObserver' in window) return;
    document.querySelectorAll('[data-fade-node]').forEach((node) => node.style.setProperty('--tw-flow-opacity', '1'));
  }

  function initFadeObserver() {
    state.fadeObserver?.disconnect?.();
    state.fadeObserver = null;
    if (!('IntersectionObserver' in window)) return;
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll) return;
    state.fadeObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const ratio = Math.max(0.16, Math.min(1, entry.intersectionRatio * 1.35));
        entry.target.style.setProperty('--tw-flow-opacity', ratio.toFixed(3));
      });
    }, {
      root: scroll,
      threshold: [0, 0.1, 0.25, 0.45, 0.7, 1],
      rootMargin: '-2% 0px -2% 0px',
    });
    document.querySelectorAll('[data-fade-node]').forEach((node) => state.fadeObserver.observe(node));
  }

  function selectMessage(id) {
    const next = state.selectedMessageId === String(id) ? '' : String(id);
    const viewport = captureViewport();
    state.selectedMessageId = next;
    renderChat();
    bindChatActions();
    initFadeObserver();
    requestAnimationFrame(() => restoreViewport(viewport));
  }

  function nextTemporaryDisplayId(sourceId) {
    const source = situation(sourceId);
    const base = String(displayId(source)).match(/^\d+/u)?.[0] || String(sourceId);
    const used = new Set((state.annotations.situations || []).map((item) => displayId(item)));
    for (let index = 0; index < 26; index += 1) {
      const candidate = `${base}${String.fromCharCode(65 + index)}`;
      if (!used.has(candidate)) return candidate;
    }
    let counter = 1;
    while (used.has(`${base}A${counter}`)) counter += 1;
    return `${base}A${counter}`;
  }

  function markChanged(...ids) {
    ids.filter(Boolean).forEach((rawId) => {
      const id = Number(rawId);
      const item = situation(id);
      if (!item) return;
      if (isDone(item)) item.status = 'open';
      item.truewordsNeedsCorrectedConfirmation = true;
      state.modified.add(id);
    });
    state.dirty = true;
  }

  function appendEvent(event) {
    state.annotations.events = Array.isArray(state.annotations.events) ? state.annotations.events : [];
    state.annotations.events.push({ ...event, reviewer: activeReviewer(), at: new Date().toISOString() });
    state.annotations.events = state.annotations.events.slice(-2000);
  }

  function pruneEmptySituations() {
    const assignedIds = new Set(Object.values(state.annotations.assignments || {}).map(Number));
    const removed = [];
    state.annotations.situations = (state.annotations.situations || []).filter((item) => {
      const keep = assignedIds.has(Number(item.id));
      if (!keep) removed.push(Number(item.id));
      return keep;
    });
    removed.forEach((id) => {
      delete state.owners[String(id)];
      state.modified.delete(id);
    });
    return removed;
  }

  async function saveState(message = 'Gespeichert') {
    if (state.saving) return;
    state.saving = true;
    setSync('working');
    try {
      const result = await fetchJson('/api/state', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-truewords-reviewer': activeReviewer() },
        body: JSON.stringify({ datasetId: state.dataset.id, annotations: state.annotations }),
      });
      state.dataset.revision = Number(result.revision || Number(state.dataset.revision || 0) + 1);
      state.dirty = false;
      setSync('ok', `${message} · Revision ${state.dataset.revision}`);
      renderHeaderBits();
      return result;
    } catch (caught) {
      setSync('error', caught?.message || 'Speichern fehlgeschlagen');
      throw caught;
    } finally {
      state.saving = false;
    }
  }

  async function toggleConfirmation(id) {
    const item = situation(id);
    if (!item || !isMine(id)) return;
    const viewport = captureViewport();
    if (isDone(item)) {
      item.status = 'open';
      item.truewordsNeedsCorrectedConfirmation = true;
      state.modified.add(Number(id));
      appendEvent({ type: 'situation_reopened', situationId: Number(id) });
      state.dirty = true;
      await saveState('Situation wieder geöffnet');
    } else {
      const corrected = Boolean(item.truewordsNeedsCorrectedConfirmation || state.modified.has(Number(id)));
      item.status = corrected ? 'corrected' : 'confirmed';
      item.reviewedBy = activeReviewer();
      item.reviewedAt = new Date().toISOString();
      item.truewordsNeedsCorrectedConfirmation = false;
      appendEvent({ type: corrected ? 'situation_corrected' : 'situation_confirmed', situationId: Number(id) });
      state.dirty = true;
      await saveState(corrected ? 'Korrektur bestätigt' : 'Situation bestätigt');
      state.modified.delete(Number(id));
    }
    renderWorkspace({ viewport });
  }

  async function splitAt(messageIdValue) {
    const index = state.messages.findIndex((message) => messageId(message) === String(messageIdValue));
    if (index < 0) return;
    const sourceId = assignment(state.messages[index]);
    const source = situation(sourceId);
    const range = rangeFor(sourceId);
    if (!source || !range || index <= range.first || !isMine(sourceId)) return;
    const viewport = captureViewport();
    const maxId = Math.max(0, ...(state.annotations.situations || []).map((item) => Number(item.id) || 0));
    const newId = maxId + 1;
    const newDisplayId = nextTemporaryDisplayId(sourceId);
    for (let cursor = index; cursor <= range.last; cursor += 1) {
      if (assignment(state.messages[cursor]) === sourceId) state.annotations.assignments[messageId(state.messages[cursor])] = newId;
    }
    state.annotations.situations.push({
      ...source,
      id: newId,
      displayId: newDisplayId,
      label: `Situation ${newDisplayId}`,
      status: 'open',
      reviewedAt: null,
      reviewedBy: null,
      analysis: {},
      details: {},
      reviewDetails: {},
      temporary: true,
      splitFrom: sourceId,
      truewordsNeedsCorrectedConfirmation: true,
      createdAt: new Date().toISOString(),
    });
    state.owners[String(newId)] = activeReviewer();
    markChanged(sourceId, newId);
    appendEvent({ type: 'situation_split', sourceSituationId: sourceId, newSituationId: newId, displayId: newDisplayId, startMessageId: String(messageIdValue) });
    state.activeId = newId;
    state.selectedMessageId = String(messageIdValue);
    await saveState(`Situation ${newDisplayId} angelegt`);
    renderWorkspace({ viewport });
  }

  function findNeighborSituation(id, direction) {
    const ordered = orderedSituations();
    const index = ordered.findIndex((item) => Number(item.id) === Number(id));
    if (index < 0) return null;
    return direction === 'previous' ? ordered[index - 1] || null : ordered[index + 1] || null;
  }

  function boundaryCapability(action) {
    const id = Number(state.activeId);
    const range = rangeFor(id);
    if (!range || !isMine(id)) return null;
    if ((action === 'start-later' || action === 'end-earlier') && range.count <= 1) return null;
    if (action === 'start-earlier' && range.first <= 0) return null;
    if (action === 'end-later' && range.last >= state.messages.length - 1) return null;
    return range;
  }

  async function shiftBoundary(action) {
    const id = Number(state.activeId);
    const range = boundaryCapability(action);
    if (!range) return;
    const viewport = captureViewport();
    let moved = null;
    let sourceId = 0;
    let destinationId = 0;
    if (action === 'start-earlier') {
      moved = state.messages[range.first - 1];
      sourceId = assignment(moved);
      destinationId = id;
      state.annotations.assignments[messageId(moved)] = id;
    } else if (action === 'start-later') {
      moved = state.messages[range.first];
      const neighbor = state.messages[range.first - 1];
      destinationId = assignment(neighbor) || Number(findNeighborSituation(id, 'previous')?.id || 0);
      sourceId = id;
      if (destinationId) state.annotations.assignments[messageId(moved)] = destinationId;
      else delete state.annotations.assignments[messageId(moved)];
    } else if (action === 'end-earlier') {
      moved = state.messages[range.last];
      const neighbor = state.messages[range.last + 1];
      destinationId = assignment(neighbor) || Number(findNeighborSituation(id, 'next')?.id || 0);
      sourceId = id;
      if (destinationId) state.annotations.assignments[messageId(moved)] = destinationId;
      else delete state.annotations.assignments[messageId(moved)];
    } else if (action === 'end-later') {
      moved = state.messages[range.last + 1];
      sourceId = assignment(moved);
      destinationId = id;
      state.annotations.assignments[messageId(moved)] = id;
    }
    if (!moved) return;
    const neighborId = sourceId === id ? destinationId : sourceId;
    if (neighborId && owner(neighborId) !== activeReviewer()) {
      appendEvent({
        type: 'boundary_cross_owner_moved',
        sourceSituationId: sourceId || id,
        destinationSituationId: destinationId || id,
        messageId: messageId(moved),
      });
    }
    markChanged(id, neighborId);
    const removed = pruneEmptySituations();
    removed.forEach((removedId) => appendEvent({ type: 'empty_situation_removed', situationId: removedId }));
    appendEvent({ type: 'boundary_moved', situationId: id, action, messageId: messageId(moved), sourceSituationId: sourceId, destinationSituationId: destinationId });
    await saveState('Grenze gespeichert');
    if (!situation(state.activeId)) state.activeId = Number(findNeighborSituation(id, 'previous')?.id || orderedSituations()[0]?.id || 0);
    renderWorkspace({ viewport });
  }

  function openDrawer() {
    const drawer = document.querySelector('[data-drawer]');
    if (!drawer) return;
    drawer.classList.add('is-open');
    if (!drawer.open) drawer.showModal();
    requestAnimationFrame(() => centerList('[data-drawer-list]', false));
  }

  function closeDrawer() {
    const drawer = document.querySelector('[data-drawer]');
    if (!drawer) return;
    drawer.classList.remove('is-open');
    if (drawer.open) drawer.close();
  }

  function openDetailModal(situationId, key = '') {
    const item = situation(situationId);
    if (!item || !isMine(item.id)) return;
    const details = combinedDetails(item);
    const current = details.find((entry) => entry.key === key);
    const modal = document.querySelector('[data-detail-modal]');
    const card = document.querySelector('[data-modal-card]');
    if (!modal || !card) return;
    card.innerHTML = `<h3>${current ? 'Analysefeld bearbeiten' : 'Analysefeld hinzufügen'}</h3>
      <form id="detail-form" data-situation-id="${item.id}" data-original-key="${escapeHtml(key)}">
        <div class="tw-field"><label>Feld</label><input name="label" value="${escapeHtml(current?.label || '')}" required></div>
        <div class="tw-field"><label>Wert</label><textarea name="value" required>${escapeHtml(current?.value || '')}</textarea></div>
        <div class="tw-modal-actions"><button class="tw-action" type="button" data-close-modal>Abbrechen</button><button class="tw-action primary" type="submit">Speichern</button></div>
      </form>`;
    card.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
    if (!modal.open) modal.showModal();
    card.querySelector('input')?.focus();
  }

  function closeModal() {
    const modal = document.querySelector('[data-detail-modal]');
    if (modal?.open) modal.close();
  }

  async function saveDetail(form) {
    const item = situation(Number(form.dataset.situationId));
    if (!item || !isMine(item.id)) return;
    const data = new FormData(form);
    const label = String(data.get('label') || '').trim();
    const value = String(data.get('value') || '').trim();
    if (!label || !value) return;
    const originalKey = String(form.dataset.originalKey || '');
    const key = originalKey || label.toLocaleLowerCase('de-DE').replace(/[^a-z0-9äöüß]+/giu, '_').replace(/^_+|_+$/gu, '') || `feld_${Date.now()}`;
    item.reviewDetails = item.reviewDetails && typeof item.reviewDetails === 'object' ? item.reviewDetails : {};
    item.reviewDetails[key] = { label, value };
    markChanged(item.id);
    appendEvent({ type: 'situation_detail_corrected', situationId: Number(item.id), key, label });
    closeModal();
    await saveState('Analysefeld gespeichert');
    renderSituationList('[data-situation-list]');
    renderSituationList('[data-drawer-list]');
    bindSituationActions();
    centerSituationLists(false);
  }

  async function signOut() {
    await fetchJson('/api/auth/logout', { method: 'POST' }).catch(() => null);
    location.replace('/login.html');
  }

  function bindSituationActions() {
    document.querySelectorAll('[data-open-situation]').forEach((button) => {
      button.onclick = () => {
        closeDrawer();
        scrollChatToSituation(Number(button.dataset.openSituation), 'auto');
      };
    });
    document.querySelectorAll('[data-card-confirm]').forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        toggleConfirmation(Number(button.dataset.cardConfirm)).catch((caught) => toast(caught?.message || 'Bestätigung fehlgeschlagen'));
      };
    });
    document.querySelectorAll('[data-edit-detail]').forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        openDetailModal(Number(button.dataset.editDetail), button.dataset.detailKey);
      };
    });
    document.querySelectorAll('[data-add-detail]').forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        openDetailModal(Number(button.dataset.addDetail));
      };
    });
  }

  function bindChatActions() {
    document.querySelectorAll('[data-message-id]').forEach((button) => {
      button.onclick = () => selectMessage(button.dataset.messageId);
    });
    document.querySelectorAll('[data-split-here]').forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        splitAt(button.dataset.splitHere).catch((caught) => toast(caught?.message || 'Teilen fehlgeschlagen'));
      };
    });
    document.querySelectorAll('[data-boundary]').forEach((button) => {
      button.onclick = () => shiftBoundary(button.dataset.boundary).catch((caught) => toast(caught?.message || 'Grenzänderung fehlgeschlagen'));
    });
    document.querySelectorAll('[data-confirm]').forEach((button) => {
      button.onclick = () => toggleConfirmation(Number(button.dataset.confirm)).catch((caught) => toast(caught?.message || 'Bestätigung fehlgeschlagen'));
    });
  }

  function bindWorkspace() {
    bindSituationActions();
    bindChatActions();
    document.querySelectorAll('[data-slider-situation]').forEach((button) => {
      button.onclick = () => scrollChatToSituation(Number(button.dataset.sliderSituation), 'auto');
    });
    document.getElementById('reviewer-select')?.addEventListener('change', (event) => {
      const next = event.target.value;
      if (!['Philipp', 'Lena'].includes(next) || !canSwitchReviewer()) return;
      state.reviewerMode = next;
      sessionStorage.setItem(REVIEWER_KEY, next);
      const first = orderedSituations().find((item) => owner(item.id) === next && !isDone(item))
        || orderedSituations().find((item) => owner(item.id) === next)
        || orderedSituations()[0];
      state.activeId = Number(first?.id || 0);
      state.selectedMessageId = '';
      renderWorkspace();
      requestAnimationFrame(() => state.activeId && scrollChatToSituation(state.activeId, 'auto'));
    });
    document.querySelector('[data-nav="theme"]')?.addEventListener('click', toggleTheme);
    document.querySelector('[data-profile]')?.addEventListener('click', signOut);
    document.querySelector('[data-open-drawer]')?.addEventListener('click', openDrawer);
    document.querySelector('[data-close-drawer]')?.addEventListener('click', closeDrawer);
    document.querySelector('[data-drawer]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeDrawer();
    });
    document.querySelector('[data-detail-modal]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeModal();
    });
    document.querySelector('[data-detail-modal]')?.addEventListener('submit', (event) => {
      if (event.target?.id !== 'detail-form') return;
      event.preventDefault();
      saveDetail(event.target).catch((caught) => toast(caught?.message || 'Speichern fehlgeschlagen'));
    });
    document.querySelector('[data-chat-scroll]')?.addEventListener('scroll', onChatScroll, { passive: true });
  }

  async function poll() {
    if (!state.dataset || state.dirty || state.saving || document.hidden) return;
    try {
      const result = await fetchJson(`/api/state?dataset=${encodeURIComponent(state.dataset.id)}`);
      const revision = Number(result.dataset?.revision || 0);
      if (revision <= Number(state.dataset.revision || 0)) return;
      const viewport = captureViewport();
      state.annotations = result.annotations;
      state.owners = result.owners || state.owners;
      state.dataset.revision = revision;
      if (!situation(state.activeId)) state.activeId = Number(orderedSituations()[0]?.id || 0);
      renderWorkspace({ viewport });
      setSync('ok', `Aktualisiert · Revision ${revision}`);
    } catch (caught) {
      setSync('error', caught?.message || 'Synchronisierung fehlgeschlagen');
    }
  }

  function renderError(message) {
    destroyTransientUi();
    app.innerHTML = `<main class="tw-error"><section class="tw-error-card"><div class="tw-loading-mark">TW</div><h1>Prüfstand nicht verfügbar</h1><p>${escapeHtml(message)}</p><button class="tw-action primary" type="button" id="retry">Erneut laden</button></section></main>`;
    document.getElementById('retry')?.addEventListener('click', boot);
  }

  async function boot() {
    applyTheme();
    try {
      const result = await fetchJson('/api/review/bootstrap');
      state.user = result.user;
      state.dataset = result.dataset;
      state.annotations = result.annotations;
      state.owners = result.owners || {};
      state.messages = result.messages || [];
      state.replyMessages = new Map((result.replyMessages || []).map((message) => [messageId(message), message]));
      const storedReviewer = sessionStorage.getItem(REVIEWER_KEY);
      state.reviewerMode = result.user.canUpload && ['Philipp', 'Lena'].includes(storedReviewer) ? storedReviewer : result.user.role;
      const first = orderedSituations().find((item) => isMine(item.id) && !isDone(item))
        || orderedSituations().find((item) => isMine(item.id))
        || orderedSituations()[0];
      state.activeId = Number(first?.id || 0);
      state.selectedMessageId = '';
      state.modified.clear();
      state.dirty = false;
      renderWorkspace();
      requestAnimationFrame(() => state.activeId && scrollChatToSituation(state.activeId, 'auto'));
      clearInterval(state.pollTimer);
      state.pollTimer = setInterval(poll, 15000);
    } catch (caught) {
      if (caught?.status === 401) {
        location.replace('/login.html');
        return;
      }
      renderError(caught?.message || 'Die Prüfdaten konnten nicht geladen werden.');
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
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme();
  });
  window.addEventListener('truewords:user-theme-ready', applyTheme);

  boot();
})();
