(() => {
  'use strict';

  const STATUS_LABELS = {
    open: 'offen',
    confirmed: 'bestätigt',
    corrected: 'korrigiert',
    unclear: 'unklar',
  };

  const PRIORITY_DETAIL_KEYS = [
    'classification',
    'direction',
    'patterns',
    'topics',
    'startingConcern',
    'course',
    'outcome',
    'repair',
    'confidence',
  ];

  const DEFAULT_DETAIL_LABELS = {
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

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatValue(value) {
    if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
    if (value && typeof value === 'object') {
      if ('value' in value) return formatValue(value.value);
      return Object.values(value).map((entry) => String(entry)).join(', ');
    }
    return String(value ?? '').trim();
  }

  function detailLabel(key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.label) {
      return String(value.label);
    }
    return DEFAULT_DETAIL_LABELS[key] || key;
  }

  function normalizeDetails(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const keys = Object.keys(raw);
    keys.sort((left, right) => {
      const leftIndex = PRIORITY_DETAIL_KEYS.indexOf(left);
      const rightIndex = PRIORITY_DETAIL_KEYS.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right, 'de');
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
    return keys
      .map((key) => {
        const rawValue = raw[key];
        const value = formatValue(rawValue);
        return value ? { key, label: detailLabel(key, rawValue), value } : null;
      })
      .filter(Boolean);
  }

  function normalizeSituation(input = {}) {
    const status = STATUS_LABELS[String(input.status || '').toLowerCase()] ? String(input.status).toLowerCase() : 'open';
    return {
      id: Number(input.id || 0),
      status,
      owner: String(input.owner || 'Unbekannt'),
      startDate: String(input.startDate || ''),
      startTime: String(input.startTime || ''),
      endTime: String(input.endTime || ''),
      messageCount: Number(input.messageCount || 0),
      details: normalizeDetails(input.details || input.analysis || {}),
    };
  }

  function renderDetail(detail, editable) {
    return `
      <div class="rv2-detail" data-detail-key="${escapeHtml(detail.key)}">
        <dt>${escapeHtml(detail.label)}</dt>
        <dd>${escapeHtml(detail.value)}</dd>
        ${editable ? `<button type="button" class="rv2-detail-edit" data-edit-detail="${escapeHtml(detail.key)}" aria-label="${escapeHtml(detail.label)} bearbeiten">Bearbeiten</button>` : ''}
      </div>`;
  }

  function renderSituationCard(input, options = {}) {
    const item = normalizeSituation(input);
    const active = Boolean(options.active);
    const editable = Boolean(options.editable);
    const statusLabel = STATUS_LABELS[item.status];
    const check = item.status === 'confirmed' || item.status === 'corrected' ? '✓' : '';
    const detailRows = active && item.details.length
      ? `<dl class="rv2-details">${item.details.map((detail) => renderDetail(detail, editable)).join('')}</dl>`
      : active
        ? '<div class="rv2-details-empty">Noch keine Analysefelder vorhanden.</div>'
        : '';

    return `
      <article class="rv2-situation-card status-${escapeHtml(item.status)} ${active ? 'is-active' : ''}"
        data-situation-id="${item.id}"
        data-status="${escapeHtml(item.status)}">
        <button type="button" class="rv2-main" data-open-situation="${item.id}">
          <div class="rv2-row rv2-row-primary">
            <strong class="rv2-number">${item.id}</strong>
            <span class="rv2-check" aria-label="${escapeHtml(statusLabel)}">${check}</span>
            ${active ? `<span class="rv2-status-text">${escapeHtml(statusLabel)}</span>` : ''}
            <span class="rv2-count">${item.messageCount} Nachr.</span>
          </div>
          <div class="rv2-row rv2-row-secondary">
            <span class="rv2-owner">${escapeHtml(item.owner)}</span>
            <span class="rv2-date">${escapeHtml(item.startDate)}</span>
          </div>
          ${active && (item.startTime || item.endTime) ? `<div class="rv2-time-range">${escapeHtml(item.startTime)}${item.startTime && item.endTime ? ' – ' : ''}${escapeHtml(item.endTime)}</div>` : ''}
        </button>
        ${active ? `<div class="rv2-active-details">${detailRows}<div class="rv2-editor-slot" data-editor-slot="${item.id}" hidden></div></div>` : ''}
      </article>`;
  }

  window.TRUEWORDS_REVIEW_V2 = Object.freeze({
    normalizeSituation,
    normalizeDetails,
    renderSituationCard,
    statusLabels: { ...STATUS_LABELS },
  });
})();
