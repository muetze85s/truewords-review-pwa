(() => {
  'use strict';

  const THEME_KEY = 'truewords/theme';
  const VALID_THEMES = new Set(['system', 'light', 'dark']);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let scheduled = false;

  function preference() {
    const stored = localStorage.getItem(THEME_KEY);
    return VALID_THEMES.has(stored) ? stored : 'system';
  }

  function applyTheme(value = preference()) {
    const selected = VALID_THEMES.has(value) ? value : 'system';
    localStorage.setItem(THEME_KEY, selected);
    const resolved = selected === 'system'
      ? (media.matches ? 'dark' : 'light')
      : selected;
    document.documentElement.dataset.themePreference = selected;
    document.documentElement.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      resolved === 'dark' ? '#121716' : '#f6f2ec',
    );
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      const active = button.dataset.themeChoice === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function person(value) {
    const text = String(value || '').toLocaleLowerCase('de-DE');
    if (text.includes('philipp')) return 'Philipp';
    if (text.includes('lena')) return 'Lena';
    return '';
  }

  function decoratePeople(root = document) {
    root.querySelectorAll?.('.message').forEach((card) => {
      const name = card.querySelector('.message-meta strong')?.textContent;
      const speaker = person(name);
      if (speaker) card.dataset.speaker = speaker;
    });

    root.querySelectorAll?.('.reply-preview').forEach((preview) => {
      const speaker = person(preview.querySelector('.reply-meta')?.textContent);
      if (speaker) preview.dataset.speaker = speaker;
    });

    root.querySelectorAll?.('.owner-badge').forEach((badge) => {
      const owner = person(badge.textContent);
      if (!owner) return;
      badge.dataset.owner = owner;
      badge.closest('.situation-row')?.setAttribute('data-owner', owner);
    });

    root.querySelectorAll?.('[data-reviewer-mode]').forEach((button) => {
      const owner = person(button.dataset.reviewerMode || button.textContent);
      if (owner) button.dataset.owner = owner;
    });
  }

  function themeControl() {
    const wrapper = document.createElement('div');
    wrapper.className = 'tw-theme-switcher';
    wrapper.setAttribute('role', 'group');
    wrapper.setAttribute('aria-label', 'Darstellung');
    wrapper.innerHTML = `
      <span>Darstellung</span>
      <button type="button" data-theme-choice="light">Hell</button>
      <button type="button" data-theme-choice="dark">Dunkel</button>
      <button type="button" data-theme-choice="system">System</button>`;
    wrapper.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-theme-choice]');
      if (!button) return;
      applyTheme(button.dataset.themeChoice);
    });
    return wrapper;
  }

  function ensureControl() {
    if (document.querySelector('.tw-theme-switcher')) return;
    const host = document.querySelector('.account-nav')
      || document.querySelector('.header .account')
      || document.querySelector('.card .account')
      || document.body;
    host.append(themeControl());
    applyTheme();
  }

  function enhance() {
    scheduled = false;
    ensureControl();
    decoratePeople();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhance);
  }

  applyTheme();
  media.addEventListener?.('change', () => {
    if (preference() === 'system') applyTheme('system');
  });
  document.addEventListener('DOMContentLoaded', schedule, { once: true });
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  schedule();
})();
