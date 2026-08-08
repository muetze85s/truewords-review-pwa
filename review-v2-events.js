(() => {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function closeDrawer() {
    document.querySelector('[data-drawer]')?.classList.remove('is-open');
  }

  function closeModal() {
    document.querySelector('[data-detail-modal]')?.classList.remove('is-open');
  }

  function scrollChatToSituation(id, behavior = 'smooth') {
    const target = document.querySelector(
      `[data-message-situation="${Number(id)}"][data-situation-first="true"]`,
    );
    if (!target) return false;
    closeDrawer();
    target.scrollIntoView({ behavior, block: 'start' });
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

  // Explicit navigation must let the chat position drive the active situation.
  // Capturing here prevents the original click handler from setting a new active
  // situation before the smooth scroll has reached that situation. Otherwise the
  // scroll synchronizer can immediately switch back at the old viewport position.
  document.addEventListener('click', (event) => {
    const slider = event.target.closest?.('[data-slider-situation]');
    if (slider) {
      const id = Number(slider.dataset.sliderSituation || 0);
      if (id && scrollChatToSituation(id)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    const open = event.target.closest?.('[data-open-situation]');
    if (open) {
      const id = Number(open.dataset.openSituation || 0);
      if (id && scrollChatToSituation(id)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }, true);

  document.addEventListener('click', (event) => {
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
})();
