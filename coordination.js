(() => {
  'use strict';

  const app = document.getElementById('app');
  if (!app) return;

  const REVIEWER_KEY = 'truewords-review-2026/reviewer';
  const CONFIRMED_KEY = 'truewords-review-ui/reviewer-confirmed';
  let scheduled = false;

  function reviewer() {
    return localStorage.getItem(REVIEWER_KEY) === 'Lena' ? 'Lena' : 'Philipp';
  }

  function otherReviewer() {
    return reviewer() === 'Philipp' ? 'Lena' : 'Philipp';
  }

  function ownerFor(button) {
    const id = Number(button.dataset.sit || 0);
    return id % 2 === 0 ? 'Lena' : 'Philipp';
  }

  function isCompleted(button) {
    const text = button.querySelector('small')?.textContent || '';
    return /\b(bestätigt|korrigiert)\b/iu.test(text);
  }

  function setReviewer(name) {
    const next = name === 'Lena' ? 'Lena' : 'Philipp';
    localStorage.setItem(REVIEWER_KEY, next);
    localStorage.setItem(CONFIRMED_KEY, '1');

    const sourceSelect = app.querySelector('#reviewer');
    if (sourceSelect) {
      sourceSelect.value = next;
      sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    document.querySelector('.tw-reviewer-overlay')?.remove();
    updateReviewerBar();
    organizeSituationList(true);
  }

  function ensureReviewerBar() {
    const tabs = app.querySelector('.tw-tabs');
    if (!tabs) return;

    let bar = app.querySelector('.tw-reviewer-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'tw-reviewer-bar';
      bar.innerHTML = `
        <strong>Ich prüfe als:</strong>
        <button type="button" data-tw-reviewer="Philipp">Philipp</button>
        <button type="button" data-tw-reviewer="Lena">Lena</button>
        <span class="tw-reviewer-rule">Aufteilung: Philipp ungerade · Lena gerade</span>`;
      tabs.after(bar);
    }

    updateReviewerBar();
  }

  function updateReviewerBar() {
    const current = reviewer();
    app.querySelectorAll('[data-tw-reviewer]').forEach(button => {
      const active = button.dataset.twReviewer === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function ensureReviewerChoice() {
    if (localStorage.getItem(CONFIRMED_KEY) === '1') return;
    if (!app.querySelector('.list .sit')) return;
    if (document.querySelector('.tw-reviewer-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'tw-reviewer-overlay';
    overlay.innerHTML = `
      <div class="tw-reviewer-dialog" role="dialog" aria-modal="true" aria-labelledby="tw-reviewer-title">
        <h2 id="tw-reviewer-title">Wer prüft gerade?</h2>
        <p>Damit Philipp und Lena nicht dieselben Situationen bearbeiten, wird die Liste fest aufgeteilt.</p>
        <div class="tw-reviewer-dialog-actions">
          <button type="button" data-tw-reviewer="Philipp">Ich bin Philipp</button>
          <button type="button" data-tw-reviewer="Lena">Ich bin Lena</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    updateReviewerBar();
  }

  function sectionLabel(text) {
    const label = document.createElement('div');
    label.className = 'tw-section-label tw-owner-label';
    label.textContent = text;
    return label;
  }

  function detailsSection(className, title, buttons, open = false) {
    const details = document.createElement('details');
    details.className = className;
    details.open = open;

    const summary = document.createElement('summary');
    summary.textContent = `${title} (${buttons.length})`;

    const content = document.createElement('div');
    buttons.forEach(button => content.appendChild(button));
    details.append(summary, content);
    return details;
  }

  function decorate(button, owner, locked) {
    button.disabled = locked;
    button.classList.toggle('tw-locked-for-reviewer', locked);
    button.title = locked
      ? `Diese Situation ist ${owner} zugeteilt.`
      : `Diese Situation ist dir (${owner}) zugeteilt.`;

    let badge = button.querySelector('.tw-owner-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tw-owner-badge';
      button.appendChild(badge);
    }
    badge.textContent = owner;
  }

  function organizeSituationList(force = false) {
    const list = app.querySelector('.list');
    if (!list) return;

    const buttons = [...list.querySelectorAll('.sit')];
    if (!buttons.length) return;

    const current = reviewer();
    const signature = `${current}|${buttons.map(button => `${button.dataset.sit}:${isCompleted(button)}:${button.classList.contains('active')}`).join('|')}`;
    if (!force && list.dataset.twOwnerSignature === signature) return;
    list.dataset.twOwnerSignature = signature;

    const mineOpen = [];
    const mineDone = [];
    const other = [];

    buttons
      .sort((a, b) => Number(a.dataset.sit) - Number(b.dataset.sit))
      .forEach(button => {
        const owner = ownerFor(button);
        const mine = owner === current;
        decorate(button, owner, !mine);
        if (!mine) other.push(button);
        else if (isCompleted(button)) mineDone.push(button);
        else mineOpen.push(button);
      });

    const ownLabel = sectionLabel(`Meine offenen Situationen · ${current} (${mineOpen.length})`);
    const done = detailsSection('tw-completed', 'Meine erledigten Situationen', mineDone, false);
    const other = detailsSection('tw-other-reviewer', `${otherReviewer()}s Bereich · nur Übersicht`, other, false);

    list.replaceChildren(ownLabel, ...mineOpen, done, other);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureReviewerBar();
      ensureReviewerChoice();
      organizeSituationList();
    });
  }

  app.addEventListener('click', event => {
    const button = event.target.closest('[data-tw-reviewer]');
    if (!button) return;
    setReviewer(button.dataset.twReviewer);
  }, true);

  app.addEventListener('change', event => {
    if (event.target?.id !== 'reviewer') return;
    localStorage.setItem(CONFIRMED_KEY, '1');
    updateReviewerBar();
    organizeSituationList(true);
  });

  new MutationObserver(schedule).observe(app, {
    childList: true,
    subtree: true
  });

  schedule();
})();
