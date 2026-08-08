(() => {
  'use strict';

  let suppressScrollSyncUntil = 0;
  let observer = null;

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
      if (performance.now() < suppressScrollSyncUntil) {
        event.stopImmediatePropagation();
      }
    }, { capture: true, passive: true });
  }

  function watchForWorkspace() {
    installScrollGuard();
    if (observer) return;
    observer = new MutationObserver(installScrollGuard);
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

  // Mark explicit navigation before the core target listener runs. The scroll guard
  // then ignores only the programmatic scroll produced by that click. Ordinary
  // user scrolling continues to use the first/last-message activation rule.
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-slider-situation], [data-open-situation], [data-nav="current"]')) {
      suppressAutomaticScrollSync();
    }
  }, true);

  document.addEventListener('click', (event) => {
    // Situation cards are re-rendered whenever the active situation changes.
    // Their initial core listeners disappear with the old DOM node, so replacement
    // cards delegate to the persistent slider button, which owns the real app state.
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
