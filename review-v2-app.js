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
    lastScrollTop: 0,
    headerHidden: false,
    sliderTimer: 0,
    sliderSuppressUntil: 0,
    pollTimer: 0,
    toastTimer: 0,
  };

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

  function isPhilipp(message) {
    return speaker(message).toLocaleLowerCase('de-DE').includes('philipp');
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
    const dateLabel = new Intl.DateTimeFormat('de-DE', {
      timeZone: accountTimeZone(),
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    }).format(date);
    const time = new Intl.DateTimeFormat('de-DE', {
      timeZone: accountTimeZone(),
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
    return { date: dateLabel, time };
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
    const sources = [item?.analysis, item?.details, item?.reviewDetails];
    for (const source of sources) {
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
    const keys = Object.keys(merged).sort((a, b) => {
      const ai = DETAIL_PRIORITY.indexOf(a);
      const bi = DETAIL_PRIORITY.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b, 'de');
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return keys.map((key) => {
      const entry = merged[key];
      const value = Array.isArray(entry.value)
        ? entry.value.join(', ')
        : typeof entry.value === 'object'
          ? JSON.stringify(entry.value)
          : String(entry.value);
      return { key, label: entry.label, value };
    });
  }

  function initials() {
    return activeReviewer() === 'Lena' ? 'L' : 'P';
  }

  function icon(name) {
    const paths = {
      list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
      target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      moon: '<path d="M20 15.5A8.5 8.5 0 118.5 4 7 7 0 0020 15.5z"/>',
      logout: '<path d="M10 5H5v14h5M13 8l4 4-4 4M17 12H9"/>',
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
    const stored = localStorage.getItem(THEME_KEY) || 'system';
    if (stored === 'dark' || stored === 'light') return stored;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    document.documentElement.dataset.theme = resolvedTheme();
    const themeButton = document.querySelector('[data-nav="theme"]');
    if (themeButton) themeButton.innerHTML = icon(resolvedTheme() === 'dark' ? 'sun' : 'moon');
  }

  function toggleTheme() {
    localStorage.setItem(THEME_KEY, resolvedTheme() === 'dark' ? 'light' : 'dark');
    applyTheme();
  }

  function completionStats() {
    const all = orderedSituations();
    const done = all.filter(isDone).length;
    return { all: all.length, done, percent: all.length ? Math.round((done / all.length) * 100) : 0 };
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
      <button class="tw-situation-main" type="button" data-open-situation="${item.id}">
        <div class="tw-sit-row">
          <span class="tw-sit-number">${escapeHtml(displayId(item))}</span>
          <span class="tw-sit-check">${done ? '✓' : ''}</span>
          <span class="tw-sit-status">${active ? escapeHtml(statusLabel(item)) : ''}</span>
          <span class="tw-sit-count">${meta.count} Nachr.</span>
        </div>
        <div class="tw-sit-sub"><strong>${escapeHtml(owner(item.id))}</strong><span>${escapeHtml(meta.date)}</span></div>
        <div class="tw-sit-time">${escapeHtml(meta.fullDate)} · ${escapeHtml(meta.startTime)}${meta.endTime ? ` – ${escapeHtml(meta.endTime)}` : ''}</div>
      </button>
      ${active ? detailHtml(item) : ''}
    </article>`;
  }

  function renderSituationList(targetSelector = '[data-situation-list]') {
    const target = document.querySelector(targetSelector);
    if (!target) return;
    const situations = orderedSituations();
    target.innerHTML = situations.length ? situations.map(situationCard).join('') : '<div class="tw-empty">Keine Situationen vorhanden.</div>';
  }

  function replyPreview(message) {
    const replyId = String(Number(message?.reply_to_message_id || 0) || '');
    if (!replyId) return '';
    const original = state.messages.find((candidate) => messageId(candidate) === replyId) || state.replyMessages.get(replyId);
    if (!original) return `<div class="tw-reply"><strong>Antwort auf ${escapeHtml(replyId)}</strong>Originalnachricht nicht im Prüfbereich.</div>`;
    const originalText = textValue(original.text) || '[Nachricht ohne Text]';
    return `<div class="tw-reply"><strong>${escapeHtml(speaker(original))} · ${escapeHtml(formatParts(original).time)}</strong>${escapeHtml(originalText.slice(0, 180))}${originalText.length > 180 ? '…' : ''}</div>`;
  }

  function renderMessage(message, index, ranges, previousDate) {
    const id = assignment(message);
    const range = id ? ranges.get(id) : null;
    const parts = formatParts(message);
    const dateMarker = parts.date && parts.date !== previousDate ? `<div class="tw-day"><span>${escapeHtml(parts.date)}</span></div>` : '';
    const item = id ? situation(id) : null;
    const groupLabel = range && index === range.first
      ? `<div class="tw-group-label" data-group-start="${id}">Situation ${escapeHtml(displayId(item || id))}</div>` : '';
    const active = id && Number(id) === Number(state.activeId);
    const selected = messageId(message) === state.selectedMessageId;
    const splitAllowed = selected && active && isMine(id) && range && index > range.first;
    const menu = selected ? `<div class="tw-message-menu">${splitAllowed ? `<button class="tw-action" type="button" data-split-here="${escapeHtml(messageId(message))}">Neue Situation ab hier</button>` : '<span></span>'}</div>` : '';
    const who = isPhilipp(message) ? 'philipp' : 'lena';
    const boundaryStart = range && index === range.first
      ? `<div class="tw-boundary ${active && isMine(id) ? 'is-active' : ''}" data-boundary-start="${id}"><span>Anfang · Situation ${escapeHtml(displayId(item || id))}</span><div class="tw-boundary-actions"><button class="tw-action" type="button" data-boundary="start-earlier">← früher</button><button class="tw-action" type="button" data-boundary="start-later">später →</button></div></div>` : '';
    return `${dateMarker}${groupLabel}${boundaryStart}<div class="tw-message-wrap ${who} ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}" data-message-wrap="${escapeHtml(messageId(message))}" data-message-situation="${id || ''}" ${range && index === range.first ? 'data-situation-first="true"' : ''} ${range && index === range.last ? 'data-situation-last="true"' : ''}>
      <article class="tw-message" data-message-id="${escapeHtml(messageId(message))}">
        <div class="tw-message-meta"><strong>${escapeHtml(speaker(message))}</strong><span>${escapeHtml(parts.time)}</span></div>
        ${replyPreview(message)}
        <div class="tw-message-text">${escapeHtml(textValue(message.text) || `[${message.media_type || message.file || 'Nachricht ohne Text'}]`)}</div>
      </article>${menu}
    </div>`;
  }

  function renderEnd(item) {
    const active = Number(item.id) === Number(state.activeId);
    const done = isDone(item);
    const mine = isMine(item.id);
    return `<div class="tw-boundary ${active && mine ? 'is-active' : ''}" data-boundary-end="${item.id}"><span>Ende · Situation ${escapeHtml(displayId(item))}</span><div class="tw-boundary-actions"><button class="tw-action" type="button" data-boundary="end-earlier">← früher</button><button class="tw-action" type="button" data-boundary="end-later">später →</button></div></div>
      <div class="tw-end-card ${active ? 'is-active' : ''}" data-end-card="${item.id}"><div class="tw-end-copy"><strong>Situation ${escapeHtml(displayId(item))}</strong><span>${escapeHtml(statusLabel(item))} · ${situationMessages(item.id).length} Nachrichten</span></div>${mine ? `<button class="tw-confirm ${done ? 'done' : ''}" type="button" data-confirm="${item.id}">${done ? 'Bestätigung zurücknehmen' : 'Situation bestätigen'}</button>` : `<span class="tw-sit-status">${escapeHtml(owner(item.id))} prüft</span>`}</div>`;
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
    const slider = document.querySelector('[data-situation-slider]');
    if (!slider) return;
    slider.innerHTML = orderedSituations().map((item) => `<button type="button" class="tw-slider-item ${Number(item.id) === Number(state.activeId) ? 'is-active' : ''}" data-slider-situation="${item.id}"><strong>${escapeHtml(displayId(item))}</strong><span>${escapeHtml(situationMeta(item).date)}</span></button>`).join('');
  }

  function renderHeaderBits() {
    const item = situation(state.activeId);
    if (!item) return;
    const meta = situationMeta(item);
    const stats = completionStats();
    const summary = document.querySelector('[data-mobile-summary]');
    if (summary) summary.innerHTML = `<strong>Situation ${escapeHtml(displayId(item))} · ${escapeHtml(statusLabel(item))}</strong><span>${escapeHtml(owner(item.id))} · ${meta.count} Nachr. · ${escapeHtml(meta.date)} · ${escapeHtml(meta.startTime)} – ${escapeHtml(meta.endTime)}</span>`;
    const head = document.querySelector('[data-chat-head-main]');
    if (head) head.innerHTML = `<strong>Situation ${escapeHtml(displayId(item))} · ${escapeHtml(statusLabel(item))}</strong><span>${escapeHtml(owner(item.id))} · ${meta.count} Nachrichten · ${escapeHtml(meta.fullDate)} · ${escapeHtml(meta.startTime)} – ${escapeHtml(meta.endTime)} · ${escapeHtml(accountTimeLabel())}</span>`;
    const progress = document.querySelector('[data-progress]');
    if (progress) {
      const circumference = 2 * Math.PI * 16;
      const dash = (stats.percent / 100) * circumference;
      progress.innerHTML = `<div class="tw-progress-ring" aria-label="${stats.percent}% abgeschlossen"><svg width="42" height="42" viewBox="0 0 42 42"><circle cx="21" cy="21" r="16" fill="none" stroke="var(--line)" stroke-width="5"/><circle cx="21" cy="21" r="16" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${dash} ${circumference - dash}" transform="rotate(-90 21 21)"/></svg></div><div class="tw-progress-copy"><strong>${stats.done}/${stats.all}</strong><span>geprüft</span></div>`;
    }
    const sync = document.querySelector('[data-sync-label]');
    if (sync) sync.textContent = `Revision ${state.dataset?.revision || 0}`;
  }

  function renderWorkspace() {
    const stats = completionStats();
    app.innerHTML = `<div class="tw-app ${state.headerHidden ? 'is-header-hidden' : ''}" data-app-shell>
      <header class="tw-topbar">
        <div class="tw-brand"><div class="tw-logo" aria-hidden="true"></div><div class="tw-brand-copy"><strong>TrueWords</strong><span>${escapeHtml(state.dataset?.name || 'Prüfstand')}</span></div></div>
        <div class="tw-mobile-summary" data-mobile-summary></div>
        <div class="tw-top-actions">${reviewerControl()}<button class="tw-icon-btn" type="button" data-nav="theme" aria-label="Darstellung wechseln"></button><button class="tw-profile" type="button" data-profile aria-label="Profil">${initials()}</button></div>
      </header>
      <nav class="tw-slider" data-situation-slider aria-label="Situationen"></nav>
      <main class="tw-main"><div class="tw-workspace">
        <aside class="tw-sidebar"><div class="tw-sidebar-head"><div><h2>Situationen</h2><span>${stats.all} gesamt · ${stats.done} geprüft</span></div><div class="tw-sync-dot" data-sync-dot></div></div><div class="tw-situation-list" data-situation-list></div></aside>
        <section class="tw-chat-card"><div class="tw-chat-head"><div class="tw-chat-head-main" data-chat-head-main></div><div class="tw-progress" data-progress></div></div><div class="tw-chat-scroll" data-chat-scroll><div class="tw-chat-stream" data-chat-stream></div></div></section>
      </div></main>
      <nav class="tw-bottom-nav" aria-label="Prüfstand Navigation"><button type="button" data-nav="situations" aria-label="Situationen">${icon('list')}</button><button class="is-active" type="button" data-nav="current" aria-label="Aktuelle Situation">${icon('target')}</button><button type="button" data-nav="theme" aria-label="Darstellung wechseln">${icon(resolvedTheme() === 'dark' ? 'sun' : 'moon')}</button><button type="button" data-nav="logout" aria-label="Abmelden">${icon('logout')}</button></nav>
      <div class="tw-drawer" data-drawer><div class="tw-scrim" data-close-drawer></div><section class="tw-drawer-panel"><div class="tw-drawer-head"><h3>Situationen</h3><button class="tw-icon-btn" type="button" data-close-drawer aria-label="Schließen">${icon('close')}</button></div><div class="tw-drawer-body"><div class="tw-situation-list" data-drawer-list></div></div></section></div>
      <div class="tw-modal" data-detail-modal><div class="tw-scrim" data-close-modal></div><section class="tw-modal-card" data-modal-card></section></div>
      <div class="tw-toast" data-toast></div>
    </div>`;
    renderSituationList();
    renderSituationList('[data-drawer-list]');
    renderChat();
    renderSlider();
    renderHeaderBits();
    applyTheme();
    bindWorkspace();
    requestAnimationFrame(() => {
      scrollSidebarActive();
      centerSlider(false);
    });
  }

  function setSync(mode, text) {
    const dot = document.querySelector('[data-sync-dot]');
    if (dot) dot.className = `tw-sync-dot ${mode === 'working' ? 'working' : mode === 'error' ? 'error' : ''}`;
    if (text) toast(text);
  }

  function toast(text) {
    const node = document.querySelector('[data-toast]');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
  }

  function scrollSidebarActive() {
    document.querySelector(`[data-situation-card="${state.activeId}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function centerSlider(smooth = true) {
    const item = document.querySelector(`[data-slider-situation="${state.activeId}"]`);
    if (!item) return;
    state.sliderSuppressUntil = performance.now() + 350;
    item.scrollIntoView({ inline: 'center', block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
  }

  function updateActiveVisuals() {
    document.querySelectorAll('[data-situation-card]').forEach((node) => node.classList.toggle('is-active', Number(node.dataset.situationCard) === Number(state.activeId)));
    renderSituationList();
    renderSituationList('[data-drawer-list]');
    document.querySelectorAll('[data-slider-situation]').forEach((node) => node.classList.toggle('is-active', Number(node.dataset.sliderSituation) === Number(state.activeId)));
    document.querySelectorAll('[data-message-situation]').forEach((node) => node.classList.toggle('is-active', Number(node.dataset.messageSituation) === Number(state.activeId)));
    document.querySelectorAll('[data-boundary-start],[data-boundary-end]').forEach((node) => {
      const id = Number(node.dataset.boundaryStart || node.dataset.boundaryEnd || 0);
      node.classList.toggle('is-active', id === Number(state.activeId) && isMine(id));
    });
    document.querySelectorAll('[data-end-card]').forEach((node) => node.classList.toggle('is-active', Number(node.dataset.endCard) === Number(state.activeId)));
    renderHeaderBits();
    scrollSidebarActive();
    centerSlider();
  }

  function setActive(id, { center = true } = {}) {
    if (!situation(id)) return;
    if (Number(state.activeId) === Number(id)) return;
    state.activeId = Number(id);
    state.selectedMessageId = '';
    updateActiveVisuals();
    if (!center) state.sliderSuppressUntil = performance.now() + 100;
  }

  function scrollToSituation(id, behavior = 'smooth') {
    const target = document.querySelector(`[data-message-situation="${Number(id)}"][data-situation-first="true"]`);
    if (!target) return;
    state.activeId = Number(id);
    updateActiveVisuals();
    target.scrollIntoView({ behavior, block: 'start' });
  }

  function findNeighborSituation(id, direction) {
    const ordered = orderedSituations();
    const index = ordered.findIndex((item) => Number(item.id) === Number(id));
    if (index < 0) return null;
    return direction === 'previous' ? ordered[index - 1] || null : ordered[index + 1] || null;
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

  async function splitAt(messageIdValue) {
    const index = state.messages.findIndex((message) => messageId(message) === String(messageIdValue));
    if (index < 0) return;
    const sourceId = assignment(state.messages[index]);
    const source = situation(sourceId);
    const range = rangeFor(sourceId);
    if (!source || !range || index <= range.first || !isMine(sourceId)) return;
    const maxId = Math.max(0, ...(state.annotations.situations || []).map((item) => Number(item.id) || 0));
    const newId = maxId + 1;
    const newDisplayId = nextTemporaryDisplayId(sourceId);
    for (let cursor = index; cursor <= range.last; cursor += 1) {
      if (assignment(state.messages[cursor]) === sourceId) state.annotations.assignments[messageId(state.messages[cursor])] = newId;
    }
    const newSituation = {
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
    };
    state.annotations.situations.push(newSituation);
    state.owners[String(newId)] = activeReviewer();
    markChanged(sourceId, newId);
    appendEvent({ type: 'situation_split', sourceSituationId: sourceId, newSituationId: newId, displayId: newDisplayId, startMessageId: String(messageIdValue) });
    state.activeId = newId;
    state.selectedMessageId = '';
    await saveState(`Situation ${newDisplayId} angelegt`);
    renderWorkspace();
    requestAnimationFrame(() => scrollToSituation(newId, 'auto'));
  }

  function boundaryCapability(action) {
    const id = Number(state.activeId);
    const range = rangeFor(id);
    if (!range || !isMine(id)) return null;
    const currentCount = range.count;
    if ((action === 'start-later' || action === 'end-earlier') && currentCount <= 1) return null;
    if (action === 'start-earlier' && range.first <= 0) return null;
    if (action === 'end-later' && range.last >= state.messages.length - 1) return null;
    return range;
  }

  async function shiftBoundary(action) {
    const id = Number(state.activeId);
    const range = boundaryCapability(action);
    if (!range) return;
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
      appendEvent({ type: 'boundary_cross_owner_moved', sourceSituationId: sourceId || id, destinationSituationId: destinationId || id, messageId: messageId(moved) });
    }
    markChanged(id, neighborId);
    const removed = pruneEmptySituations();
    removed.forEach((removedId) => appendEvent({ type: 'empty_situation_removed', situationId: removedId }));
    appendEvent({ type: 'boundary_moved', situationId: id, action, messageId: messageId(moved), sourceSituationId: sourceId, destinationSituationId: destinationId });
    await saveState('Grenze gespeichert');
    renderWorkspace();
    requestAnimationFrame(() => focusBoundary(id, action.startsWith('end') ? 'end' : 'start'));
  }

  function focusBoundary(id, edge) {
    const range = rangeFor(id);
    if (!range) return;
    const message = edge === 'end' ? state.messages[range.last] : state.messages[range.first];
    const node = document.querySelector(`[data-message-wrap="${CSS.escape(messageId(message))}"]`);
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!node || !scroll) return;
    if (edge === 'end') {
      const top = node.offsetTop + node.offsetHeight - scroll.clientHeight + 28;
      scroll.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    } else {
      node.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    node.classList.add('is-selected');
    setTimeout(() => node.classList.remove('is-selected'), 800);
  }

  async function toggleConfirmation(id) {
    const item = situation(id);
    if (!item || !isMine(id)) return;
    if (isDone(item)) {
      item.status = 'open';
      item.truewordsNeedsCorrectedConfirmation = true;
      appendEvent({ type: 'situation_reopened', situationId: Number(id) });
      state.modified.add(Number(id));
      state.dirty = true;
      await saveState('Situation wieder geöffnet');
      renderWorkspace();
      requestAnimationFrame(() => scrollToSituation(id, 'auto'));
      return;
    }
    const corrected = Boolean(item.truewordsNeedsCorrectedConfirmation || state.modified.has(Number(id)));
    item.status = corrected ? 'corrected' : 'confirmed';
    item.reviewedBy = activeReviewer();
    item.reviewedAt = new Date().toISOString();
    item.truewordsNeedsCorrectedConfirmation = false;
    appendEvent({ type: corrected ? 'situation_corrected' : 'situation_confirmed', situationId: Number(id) });
    state.dirty = true;
    await saveState(corrected ? 'Korrektur bestätigt' : 'Situation bestätigt');
    state.modified.delete(Number(id));
    const next = orderedSituations().find((candidate) => isMine(candidate.id) && !isDone(candidate) && Number(candidate.id) !== Number(id));
    renderWorkspace();
    if (next) requestAnimationFrame(() => scrollToSituation(next.id, 'auto'));
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
    modal.classList.add('is-open');
    card.querySelector('input')?.focus();
  }

  function closeModal() {
    document.querySelector('[data-detail-modal]')?.classList.remove('is-open');
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
    renderWorkspace();
    requestAnimationFrame(() => scrollToSituation(item.id, 'auto'));
  }

  function selectMessage(id) {
    state.selectedMessageId = state.selectedMessageId === String(id) ? '' : String(id);
    const scroll = document.querySelector('[data-chat-scroll]');
    const top = scroll?.scrollTop || 0;
    renderChat();
    if (scroll) scroll.scrollTop = top;
    const selected = document.querySelector(`[data-message-wrap="${CSS.escape(state.selectedMessageId)}"]`);
    selected?.scrollIntoView({ block: 'nearest' });
  }

  function handleScroll() {
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll) return;
    const current = scroll.scrollTop;
    const direction = current >= state.lastScrollTop ? 'down' : 'up';
    const delta = current - state.lastScrollTop;
    state.lastScrollTop = current;
    if (window.innerWidth <= MOBILE_BREAKPOINT) {
      const hide = direction === 'down' && delta > 2 && current > 80;
      const show = direction === 'up' && delta < -2;
      const next = hide ? true : show ? false : state.headerHidden;
      if (next !== state.headerHidden) {
        state.headerHidden = next;
        document.querySelector('[data-app-shell]')?.classList.toggle('is-header-hidden', next);
      }
    }
    syncActiveFromScroll(direction);
  }

  function syncActiveFromScroll(direction) {
    const ordered = orderedSituations();
    if (!ordered.length) return;
    let index = Math.max(0, ordered.findIndex((item) => Number(item.id) === Number(state.activeId)));
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll) return;
    const rect = scroll.getBoundingClientRect();
    const anchor = rect.top + (window.innerWidth <= MOBILE_BREAKPOINT ? (state.headerHidden ? 58 : 108) : 20);
    if (direction === 'down') {
      while (index < ordered.length - 1) {
        const next = ordered[index + 1];
        const first = document.querySelector(`[data-message-situation="${next.id}"][data-situation-first="true"]`);
        if (!first || first.getBoundingClientRect().top > anchor) break;
        index += 1;
      }
    } else {
      while (index > 0) {
        const previous = ordered[index - 1];
        const last = document.querySelector(`[data-message-situation="${previous.id}"][data-situation-last="true"]`);
        if (!last || last.getBoundingClientRect().bottom < anchor) break;
        index -= 1;
      }
    }
    if (Number(ordered[index].id) !== Number(state.activeId)) {
      state.activeId = Number(ordered[index].id);
      state.selectedMessageId = '';
      updateActiveVisuals();
    }
  }

  function snapSlider() {
    if (window.innerWidth > MOBILE_BREAKPOINT || performance.now() < state.sliderSuppressUntil) return;
    const slider = document.querySelector('[data-situation-slider]');
    if (!slider) return;
    const rect = slider.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    let best = null;
    let bestDistance = Infinity;
    slider.querySelectorAll('[data-slider-situation]').forEach((node) => {
      const itemRect = node.getBoundingClientRect();
      const distance = Math.abs((itemRect.left + itemRect.width / 2) - center);
      if (distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    });
    if (best && Number(best.dataset.sliderSituation) !== Number(state.activeId)) scrollToSituation(Number(best.dataset.sliderSituation));
  }

  function openDrawer() {
    document.querySelector('[data-drawer]')?.classList.add('is-open');
    renderSituationList('[data-drawer-list]');
    requestAnimationFrame(() => document.querySelector(`[data-drawer-list] [data-situation-card="${state.activeId}"]`)?.scrollIntoView({ block: 'center' }));
  }

  function closeDrawer() {
    document.querySelector('[data-drawer]')?.classList.remove('is-open');
  }

  async function signOut() {
    await fetchJson('/api/auth/logout', { method: 'POST' }).catch(() => null);
    location.replace('/login.html');
  }

  function bindWorkspace() {
    document.getElementById('reviewer-select')?.addEventListener('change', (event) => {
      const next = event.target.value;
      if (!['Philipp', 'Lena'].includes(next) || !canSwitchReviewer()) return;
      state.reviewerMode = next;
      sessionStorage.setItem(REVIEWER_KEY, next);
      const first = orderedSituations().find((item) => owner(item.id) === next && !isDone(item)) || orderedSituations().find((item) => owner(item.id) === next) || orderedSituations()[0];
      state.activeId = Number(first?.id || 0);
      renderWorkspace();
      requestAnimationFrame(() => state.activeId && scrollToSituation(state.activeId, 'auto'));
    });

    document.querySelectorAll('[data-open-situation]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = Number(button.dataset.openSituation);
      closeDrawer();
      scrollToSituation(id);
    }));
    document.querySelectorAll('[data-slider-situation]').forEach((button) => button.addEventListener('click', () => scrollToSituation(Number(button.dataset.sliderSituation))));
    document.querySelectorAll('[data-message-id]').forEach((button) => button.addEventListener('click', () => selectMessage(button.dataset.messageId)));
    document.querySelectorAll('[data-split-here]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      splitAt(button.dataset.splitHere).catch((caught) => toast(caught?.message || 'Teilen fehlgeschlagen'));
    }));
    document.querySelectorAll('[data-boundary]').forEach((button) => button.addEventListener('click', () => shiftBoundary(button.dataset.boundary).catch((caught) => toast(caught?.message || 'Grenzänderung fehlgeschlagen'))));
    document.querySelectorAll('[data-confirm]').forEach((button) => button.addEventListener('click', () => toggleConfirmation(Number(button.dataset.confirm)).catch((caught) => toast(caught?.message || 'Bestätigung fehlgeschlagen'))));
    document.querySelectorAll('[data-edit-detail]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      openDetailModal(Number(button.dataset.editDetail), button.dataset.detailKey);
    }));
    document.querySelectorAll('[data-add-detail]').forEach((button) => button.addEventListener('click', (event) => {
      event.stopPropagation();
      openDetailModal(Number(button.dataset.addDetail));
    }));
    document.querySelectorAll('[data-close-modal]').forEach((node) => node.addEventListener('click', closeModal));
    document.querySelectorAll('[data-close-drawer]').forEach((node) => node.addEventListener('click', closeDrawer));
    document.querySelector('[data-detail-modal]')?.addEventListener('submit', (event) => {
      if (event.target?.id !== 'detail-form') return;
      event.preventDefault();
      saveDetail(event.target).catch((caught) => toast(caught?.message || 'Speichern fehlgeschlagen'));
    });
    document.querySelectorAll('[data-nav="theme"]').forEach((button) => button.addEventListener('click', toggleTheme));
    document.querySelector('[data-nav="situations"]')?.addEventListener('click', openDrawer);
    document.querySelector('[data-nav="current"]')?.addEventListener('click', () => scrollToSituation(state.activeId));
    document.querySelector('[data-nav="logout"]')?.addEventListener('click', signOut);
    document.querySelector('[data-profile]')?.addEventListener('click', signOut);
    const scroll = document.querySelector('[data-chat-scroll]');
    scroll?.addEventListener('scroll', () => requestAnimationFrame(handleScroll), { passive: true });
    const slider = document.querySelector('[data-situation-slider]');
    slider?.addEventListener('scroll', () => {
      clearTimeout(state.sliderTimer);
      state.sliderTimer = setTimeout(snapSlider, 140);
    }, { passive: true });
  }

  async function poll() {
    if (!state.dataset || state.dirty || state.saving || document.hidden) return;
    try {
      const result = await fetchJson(`/api/state?dataset=${encodeURIComponent(state.dataset.id)}`);
      const revision = Number(result.dataset?.revision || 0);
      if (revision <= Number(state.dataset.revision || 0)) return;
      state.annotations = result.annotations;
      state.owners = result.owners || state.owners;
      state.dataset.revision = revision;
      if (!situation(state.activeId)) state.activeId = Number(orderedSituations()[0]?.id || 0);
      renderWorkspace();
      setSync('ok', `Aktualisiert · Revision ${revision}`);
    } catch (caught) {
      setSync('error', caught?.message || 'Synchronisierung fehlgeschlagen');
    }
  }

  function renderError(message) {
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
      const first = orderedSituations().find((item) => isMine(item.id) && !isDone(item)) || orderedSituations().find((item) => isMine(item.id)) || orderedSituations()[0];
      state.activeId = Number(first?.id || 0);
      state.selectedMessageId = '';
      state.modified.clear();
      state.dirty = false;
      state.headerHidden = false;
      renderWorkspace();
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

  boot();
})();