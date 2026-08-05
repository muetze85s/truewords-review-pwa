(() => {
  'use strict';

  const app = document.getElementById('app');
  if (!app) return;

  let scheduled = false;
  let advanceAfterSave = false;
  let autoCreateAfterBoundary = false;
  let autoCreateDeadline = 0;
  let autoCreateRunning = false;

  function isCompleted(button) {
    const text = button.querySelector('small')?.textContent || '';
    return /\b(bestätigt|korrigiert)\b/iu.test(text);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      organizeSituationList();
      autoCreateRange();
    });
  }

  function organizeSituationList() {
    const list = app.querySelector('.list');
    if (!list) return;

    const buttons = [...list.querySelectorAll('.sit')];
    if (!buttons.length) return;

    const open = buttons.filter(button => !isCompleted(button));
    const completed = buttons.filter(isCompleted);

    const openLabel = document.createElement('div');
    openLabel.className = 'tw-section-label';
    openLabel.textContent = `Offen / zu prüfen (${open.length})`;

    const details = document.createElement('details');
    details.className = 'tw-completed';

    const summary = document.createElement('summary');
    summary.textContent = `Bestätigt / erledigt (${completed.length})`;

    const completedList = document.createElement('div');
    completedList.className = 'tw-completed-list';
    completed.forEach(button => completedList.appendChild(button));
    details.append(summary, completedList);

    const activeCompleted = completed.some(button => button.classList.contains('active'));
    if (activeCompleted && !advanceAfterSave) details.open = true;

    list.replaceChildren(openLabel, ...open, details);

    if (advanceAfterSave) {
      advanceAfterSave = false;
      const nextOpen = open.find(button => !button.classList.contains('active')) || open[0];
      if (nextOpen) {
        setTimeout(() => nextOpen.click(), 0);
      } else {
        details.open = true;
      }
    }
  }

  function autoCreateRange() {
    if (!autoCreateAfterBoundary || autoCreateRunning) return;
    if (Date.now() > autoCreateDeadline) {
      autoCreateAfterBoundary = false;
      return;
    }

    const makeButton = app.querySelector('#make');
    if (!makeButton || makeButton.disabled) return;

    autoCreateAfterBoundary = false;
    autoCreateRunning = true;
    makeButton.click();
    setTimeout(() => {
      autoCreateRunning = false;
    }, 0);
  }

  app.addEventListener('click', event => {
    const boundaryButton = event.target.closest('[data-start], [data-end]');
    if (boundaryButton) {
      autoCreateAfterBoundary = true;
      autoCreateDeadline = Date.now() + 60000;
      return;
    }

    if (event.target.closest('#reset, #selectRange')) {
      autoCreateAfterBoundary = false;
      return;
    }

    const saveButton = event.target.closest('#saveMeta');
    if (!saveButton) return;
    const status = app.querySelector('#status')?.value;
    if (status === 'confirmed' || status === 'corrected') {
      advanceAfterSave = true;
    }
  }, true);

  new MutationObserver(schedule).observe(app, {
    childList: true,
    subtree: true
  });

  schedule();
})();
