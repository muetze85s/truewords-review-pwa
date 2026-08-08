(() => {
  'use strict';

  let suppressScrollSyncUntil = 0;
  let observer = null;
  const TARGET_KEY = 'truewords-review-v2/pending-target';

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function suppressAutomaticScrollSync(milliseconds = 700) {
    suppressScrollSyncUntil = Math.max(suppressScrollSyncUntil, performance.now() + milliseconds);
  }

  function installScrollGuard() {
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll || scroll.dataset.explicitNavigationGuard === '1') return;
    scroll.dataset.explicitNavigationGuard = '1';
    scroll.addEventListener('scroll', (event) => {
      if (performance.now() < suppressScrollSyncUntil) event.stopImmediatePropagation();
    }, { capture: true, passive: true });
  }

  function restorePendingTarget() {
    const targetId = Number(sessionStorage.getItem(TARGET_KEY) || 0);
    if (!targetId) return;
    const button = document.querySelector(`[data-open-situation="${targetId}"]`);
    if (!button) return;
    sessionStorage.removeItem(TARGET_KEY);
    suppressAutomaticScrollSync(900);
    button.click();
  }

  function watchForWorkspace() {
    installScrollGuard();
    restorePendingTarget();
    if (observer) return;
    observer = new MutationObserver(() => {
      installScrollGuard();
      restorePendingTarget();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function closeDrawer() {
    document.querySelector('[data-drawer]')?.classList.remove('is-open');
  }

  function closeModal() {
    document.querySelector('[data-detail-modal]')?.classList.remove('is-open');
  }

  function navigateThroughCore(id) {
    const proxy = document.querySelector(`[data-slider-situation="${Number(id)}"]`);
    if (!proxy) return false;
    suppressAutomaticScrollSync();
    closeDrawer();
    proxy.click();
    return true;
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function reviewerFromPage(bootstrap) {
    const selected = document.getElementById('reviewer-select')?.value;
    if (selected === 'Philipp' || selected === 'Lena') return selected;
    return bootstrap?.user?.role === 'Lena' ? 'Lena' : 'Philipp';
  }

  function nextDisplayId(source, situations) {
    const current = String(source?.displayId || source?.id || '1');
    const base = current.match(/^\d+/u)?.[0] || String(source?.id || 1);
    const used = new Set(situations.map((item) => String(item?.displayId || item?.id || '')));
    for (let index = 0; index < 26; index += 1) {
      const candidate = `${base}${String.fromCharCode(65 + index)}`;
      if (!used.has(candidate)) return candidate;
    }
    let counter = 1;
    while (used.has(`${base}A${counter}`)) counter += 1;
    return `${base}A${counter}`;
  }

  async function persistSplit(messageId) {
    const bootstrap = await fetchJson('/api/review/bootstrap');
    const annotations = structuredClone(bootstrap.annotations || {});
    const messages = Array.isArray(bootstrap.messages) ? bootstrap.messages : [];
    const situations = Array.isArray(annotations.situations) ? annotations.situations : [];
    const assignments = annotations.assignments && typeof annotations.assignments === 'object'
      ? annotations.assignments
      : {};
    const reviewer = reviewerFromPage(bootstrap);
    const selectedIndex = messages.findIndex((message) => String(message?.id) === String(messageId));
    if (selectedIndex < 0) throw new Error('Die ausgewählte Nachricht wurde nicht gefunden.');
    const sourceId = Number(assignments[String(messageId)] || 0);
    if (!sourceId) throw new Error('Die Nachricht gehört zu keiner Situation.');
    if (bootstrap.owners?.[String(sourceId)] !== reviewer) throw new Error('Diese Situation wird von der anderen Person geprüft.');
    const source = situations.find((item) => Number(item.id) === sourceId);
    if (!source) throw new Error('Die Ausgangssituation wurde nicht gefunden.');

    const sourceIndexes = [];
    messages.forEach((message, index) => {
      if (Number(assignments[String(message?.id)] || 0) === sourceId) sourceIndexes.push(index);
    });
    if (!sourceIndexes.length || selectedIndex <= sourceIndexes[0]) {
      throw new Error('Eine neue Situation kann erst nach der ersten Nachricht beginnen.');
    }
    const sourceLast = sourceIndexes[sourceIndexes.length - 1];
    for (let index = sourceIndexes[0]; index <= sourceLast; index += 1) {
      const assigned = Number(assignments[String(messages[index]?.id)] || 0);
      if (assigned && assigned !== sourceId) throw new Error('Gestückelte Situationen sind nicht erlaubt.');
    }

    const maxId = Math.max(0, ...situations.map((item) => Number(item.id) || 0));
    const newId = maxId + 1;
    const displayId = nextDisplayId(source, situations);
    for (let index = selectedIndex; index <= sourceLast; index += 1) {
      if (Number(assignments[String(messages[index]?.id)] || 0) === sourceId) {
        assignments[String(messages[index].id)] = newId;
      }
    }

    source.status = 'open';
    source.truewordsNeedsCorrectedConfirmation = true;
    situations.push({
      ...source,
      id: newId,
      displayId,
      label: `Situation ${displayId}`,
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
    annotations.assignments = assignments;
    annotations.situations = situations;
    annotations.events = Array.isArray(annotations.events) ? annotations.events : [];
    annotations.events.push({
      type: 'situation_split',
      sourceSituationId: sourceId,
      newSituationId: newId,
      displayId,
      startMessageId: String(messageId),
      reviewer,
      at: new Date().toISOString(),
    });
    annotations.events = annotations.events.slice(-2000);

    await fetchJson('/api/state', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-truewords-reviewer': reviewer,
      },
      body: JSON.stringify({ datasetId: bootstrap.dataset.id, annotations }),
    });
    sessionStorage.setItem(TARGET_KEY, String(newId));
    location.reload();
  }

  function openEditor(button, addMode = false) {
    const situationId = Number(button.dataset.editDetail || button.dataset.addDetail || 0);
    if (!situationId) return;
    const row = addMode ? null : button.closest('.tw-detail');
    const label = row?.querySelector('dt')?.textContent?.trim() || '';
    const value = row?.querySelector('dd')?.textContent?.trim() || '';
    const originalKey = addMode ? '' : String(button.dataset.detailKey || '');
    const modal = document.querySelector('[data-detail-modal]');
    const card = document.querySelector('[data-modal-card]');
    if (!modal || !card) return;
    card.innerHTML = `<h3>${addMode ? 'Analysefeld hinzufügen' : 'Analysefeld bearbeiten'}</h3>
      <form id="detail-form" data-situation-id="${situationId}" data-original-key="${escapeHtml(originalKey)}">
        <div class="tw-field"><label>Feld</label><input name="label" value="${escapeHtml(label)}" required></div>
        <div class="tw-field"><label>Wert</label><textarea name="value" required>${escapeHtml(value)}</textarea></div>
        <div class="tw-modal-actions"><button class="tw-action" type="button" data-close-modal>Abbrechen</button><button class="tw-action primary" type="submit">Speichern</button></div>
      </form>`;
    modal.classList.add('is-open');
    card.querySelector('input')?.focus();
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-slider-situation], [data-open-situation], [data-nav="current"]')) {
      suppressAutomaticScrollSync();
    }
  }, true);

  document.addEventListener('click', (event) => {
    const split = event.target.closest?.('[data-split-here]');
    if (split) {
      event.preventDefault();
      event.stopPropagation();
      const messageId = String(split.dataset.splitHere || '');
      split.disabled = true;
      split.textContent = 'Wird geteilt …';
      persistSplit(messageId).catch((caught) => {
        split.disabled = false;
        split.textContent = 'Neue Situation ab hier';
        const toast = document.querySelector('[data-toast]');
        if (toast) {
          toast.textContent = caught?.message || 'Situation konnte nicht geteilt werden.';
          toast.classList.add('show');
          setTimeout(() => toast.classList.remove('show'), 2500);
        }
      });
      return;
    }

    const open = event.target.closest?.('[data-open-situation]');
    if (open) {
      const id = Number(open.dataset.openSituation || 0);
      if (id && navigateThroughCore(id)) event.preventDefault();
      return;
    }

    const edit = event.target.closest?.('[data-edit-detail]');
    if (edit) {
      event.preventDefault();
      openEditor(edit, false);
      return;
    }

    const add = event.target.closest?.('[data-add-detail]');
    if (add) {
      event.preventDefault();
      openEditor(add, true);
      return;
    }

    const close = event.target.closest?.('[data-close-modal]');
    if (close) {
      event.preventDefault();
      closeModal();
    }
  });

  watchForWorkspace();
})();
