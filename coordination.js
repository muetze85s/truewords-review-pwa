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

  function situationId(button) {
    return Number(button.dataset.sit || 0);
  }

  function isCompleted(button) {
    const text = button.querySelector('small')?.textContent || '';
    return /\b(bestätigt|korrigiert)\b/iu.test(text);
  }

  function splitPlan(buttons) {
    const sorted = [...buttons].sort((a, b) => situationId(a) - situationId(b));
    const splitIndex = Math.ceil(sorted.length / 2);
    const philipp = sorted.slice(0, splitIndex);
    const lena = sorted.slice(splitIndex).reverse();
    const owner = new Map();
    philipp.forEach(button => owner.set(button, 'Philipp'));
    lena.forEach(button => owner.set(button, 'Lena'));
    return { sorted, philipp, lena, owner };
  }

  function planText(plan) {
    const pFirst = situationId(plan.philipp[0]);
    const pLast = situationId(plan.philipp.at(-1));
    const lFirst = situationId(plan.lena[0]);
    const lLast = situationId(plan.lena.at(-1));

    if (!plan.lena.length) return `Philipp prüft ${pFirst}–${pLast} von vorne.`;
    return `Philipp ${pFirst}–${pLast} vorwärts · Lena ${lFirst}–${lLast} rückwärts`;
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
        <span class="tw-reviewer-rule"></span>`;
      tabs.after(bar);
    }

    updateReviewerBar();
  }

  function updateReviewerBar(plan = null) {
    const current = reviewer();
    app.querySelectorAll('[data-tw-reviewer]').forEach(button => {
      const active = button.dataset.twReviewer === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    const buttons = [...app.querySelectorAll('.list .sit')];
    const currentPlan = plan || (buttons.length ? splitPlan(buttons) : null);
    const rule = app.querySelector('.tw-reviewer-rule');
    if (rule && currentPlan) rule.textContent = planText(currentPlan);
  }

  function ensureReviewerChoice() {
    if (localStorage.getItem(CONFIRMED_KEY) === '1') return;
    const buttons = [...app.querySelectorAll('.list .sit')];
    if (!buttons.length) return;
    if (document.querySelector('.tw-reviewer-overlay')) return;

    const plan = splitPlan(buttons);
    const overlay = document.createElement('div');
    overlay.className = 'tw-reviewer-overlay';
    overlay.innerHTML = `
      <div class="tw-reviewer-dialog" role="dialog" aria-modal="true" aria-labelledby="tw-reviewer-title">
        <h2 id="tw-reviewer-title">Wer prüft gerade?</h2>
        <p>${planText(plan)}. So arbeitet ihr von beiden Enden aufeinander zu.</p>
        <div class="tw-reviewer-dialog-actions">
          <button type="button" data-tw-reviewer="Philipp">Ich bin Philipp</button>
          <button type="button" data-tw-reviewer="Lena">Ich bin Lena</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    updateReviewerBar(plan);
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
      ? `Diese Situation gehört zur Hälfte von ${owner}.`
      : `Diese Situation gehört zu deiner Hälfte (${owner}).`;

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
    const plan = splitPlan(buttons);
    const signature = `${current}|${plan.sorted.map(button => `${button.dataset.sit}:${isCompleted(button)}:${button.classList.contains('active')}`).join('|')}`;
    if (!force && list.dataset.twOwnerSignature === signature) return;
    list.dataset.twOwnerSignature = signature;

    const ownOrder = current === 'Philipp' ? plan.philipp : plan.lena;
    const otherOrder = current === 'Philipp' ? plan.lena : plan.philipp;
    const mineOpen = [];
    const mineDone = [];

    ownOrder.forEach(button => {
      decorate(button, current, false);
      if (isCompleted(button)) mineDone.push(button);
      else mineOpen.push(button);
    });

    otherOrder.forEach(button => decorate(button, otherReviewer(), true));

    const ownLabel = sectionLabel(`Meine offenen Situationen · ${current} (${mineOpen.length})`);
    const doneSection = detailsSection('tw-completed', 'Meine erledigten Situationen', mineDone, false);
    const otherSection = detailsSection('tw-other-reviewer', `${otherReviewer()}s Hälfte · nur Übersicht`, otherOrder, false);

    list.replaceChildren(ownLabel, ...mineOpen, doneSection, otherSection);
    updateReviewerBar(plan);
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
