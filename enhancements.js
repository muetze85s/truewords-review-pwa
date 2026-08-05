(() => {
  'use strict';

  const app = document.getElementById('app');
  if (!app) return;

  const VIEW_KEY = 'truewords-review-ui/view';
  let scheduled = false;
  let advanceAfterSave = false;
  let autoCreateAfterBoundary = false;
  let autoCreateDeadline = 0;
  let autoCreateRunning = false;
  let currentView = sessionStorage.getItem(VIEW_KEY) || 'chat';

  function setView(view) {
    currentView = ['situations', 'chat', 'review'].includes(view) ? view : 'chat';
    sessionStorage.setItem(VIEW_KEY, currentView);
    document.body.classList.remove('tw-view-situations', 'tw-view-chat', 'tw-view-review');
    document.body.classList.add(`tw-view-${currentView}`);
    app.querySelectorAll('[data-tw-view]').forEach(button => {
      const active = button.dataset.twView === currentView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }

  function isCompleted(button) {
    const text = button.querySelector('small')?.textContent || '';
    return /\b(bestätigt|korrigiert)\b/iu.test(text);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      simplifyHeader();
      simplifyWorkspace();
      organizeSituationList();
      simplifyEditor();
      autoCreateRange();
      setView(currentView);
    });
  }

  function simplifyHeader() {
    const header = app.querySelector('header');
    const actions = header?.querySelector('.actions');
    if (!header || !actions || actions.dataset.twSimple === '1') return;

    actions.dataset.twSimple = '1';
    const items = [...actions.children];
    const chatLabel = items.find(item => item.querySelector?.('#chat'));
    const otherItems = items.filter(item => item !== chatLabel);

    const menu = document.createElement('details');
    menu.className = 'tw-file-menu';
    const summary = document.createElement('summary');
    summary.textContent = 'Dateien & Export';
    const content = document.createElement('div');
    content.className = 'tw-file-menu-content';
    otherItems.forEach(item => content.appendChild(item));
    menu.append(summary, content);

    actions.replaceChildren(...(chatLabel ? [chatLabel] : []), menu);
  }

  function simplifyWorkspace() {
    const workspace = app.querySelector('.workspace');
    if (!workspace) return;

    const makeButton = app.querySelector('#make');
    if (makeButton) {
      makeButton.hidden = true;
      makeButton.setAttribute('aria-hidden', 'true');
      makeButton.tabIndex = -1;
    }

    const emptyButton = app.querySelector('#emptySit');
    if (emptyButton) {
      const wrapper = emptyButton.closest('.panelbody');
      if (wrapper) wrapper.hidden = true;
    }

    const metrics = app.querySelector('.metrics');
    if (metrics) metrics.hidden = true;

    let tabs = app.querySelector('.tw-tabs');
    if (!tabs) {
      tabs = document.createElement('nav');
      tabs.className = 'tw-tabs';
      tabs.setAttribute('aria-label', 'Prüfschritte');
      tabs.innerHTML = `
        <button type="button" data-tw-view="situations">1 · Situationen</button>
        <button type="button" data-tw-view="chat">2 · Chat prüfen</button>
        <button type="button" data-tw-view="review">3 · Bestätigen</button>`;
      workspace.before(tabs);
    }

    const bulk = app.querySelector('.bulk');
    if (bulk && !bulk.dataset.twHint) {
      bulk.dataset.twHint = '1';
      bulk.classList.add('tw-step-hint');
    }
  }

  function organizeSituationList() {
    const list = app.querySelector('.list');
    if (!list) return;

    const buttons = [...list.querySelectorAll('.sit')];
    if (!buttons.length) return;

    const signature = buttons
      .map(button => `${button.dataset.sit}:${isCompleted(button)}:${button.classList.contains('active')}`)
      .join('|');
    if (list.dataset.twSignature === signature) return;
    list.dataset.twSignature = signature;

    const open = buttons.filter(button => !isCompleted(button));
    const completed = buttons.filter(isCompleted);

    const openLabel = document.createElement('div');
    openLabel.className = 'tw-section-label';
    openLabel.textContent = `Noch zu prüfen (${open.length})`;

    const details = document.createElement('details');
    details.className = 'tw-completed';

    const summary = document.createElement('summary');
    summary.textContent = `Erledigt (${completed.length})`;

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
        setTimeout(() => {
          nextOpen.click();
          setView('review');
        }, 0);
      } else {
        details.open = true;
        setView('situations');
      }
    }
  }

  function simplifyEditor() {
    const grid = app.querySelector('.editorgrid');
    if (!grid || grid.dataset.twSimple === '1') return;
    grid.dataset.twSimple = '1';

    const labels = [...grid.querySelectorAll(':scope > label.field')];
    const statusLabel = labels.find(label => label.querySelector('#status'));
    const advancedLabels = labels.filter(label => label !== statusLabel);
    const saveButton = grid.querySelector('#saveMeta');
    const jumpButton = grid.querySelector('#jump');
    const advancedItems = [...grid.children].filter(item =>
      item !== statusLabel &&
      item !== saveButton &&
      item !== jumpButton
    );

    if (saveButton) saveButton.textContent = 'Prüfung speichern';
    if (jumpButton) jumpButton.textContent = 'Im Chat anzeigen';

    const intro = document.createElement('div');
    intro.className = 'tw-review-intro';
    intro.textContent = 'Grenzen prüfen, Status wählen und speichern.';

    const details = document.createElement('details');
    details.className = 'tw-editor-more';
    const summary = document.createElement('summary');
    summary.textContent = 'Weitere Angaben und Aktionen';
    const content = document.createElement('div');
    content.className = 'tw-editor-more-content';
    [...advancedLabels, ...advancedItems].forEach(item => content.appendChild(item));
    details.append(summary, content);

    grid.replaceChildren(
      intro,
      ...(statusLabel ? [statusLabel] : []),
      ...(saveButton ? [saveButton] : []),
      ...(jumpButton ? [jumpButton] : []),
      details
    );
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
    setView('review');
    setTimeout(() => {
      autoCreateRunning = false;
    }, 0);
  }

  app.addEventListener('click', event => {
    const viewButton = event.target.closest('[data-tw-view]');
    if (viewButton) {
      setView(viewButton.dataset.twView);
      return;
    }

    if (event.target.closest('.sit')) {
      setView('review');
      return;
    }

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

    if (event.target.closest('#chat')) {
      setView('chat');
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

  setView(currentView);
  schedule();
})();
