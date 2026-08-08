(() => {
  'use strict';

  const BASE_KEY = 'truewords/theme';
  const USER_PREFIX = 'truewords/theme/user/';
  const VALID = new Set(['system', 'light', 'dark']);
  let userStorageKey = '';

  function normalizedPreference(value) {
    return VALID.has(value) ? value : 'system';
  }

  function userKey(user) {
    const role = String(user?.role || 'user').trim().toLocaleLowerCase('de-DE');
    const email = String(user?.email || '').trim().toLocaleLowerCase('de-DE');
    return `${USER_PREFIX}${role}:${email}`;
  }

  function resolved(preference) {
    if (preference === 'light' || preference === 'dark') return preference;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function apply(preference) {
    const selected = normalizedPreference(preference);
    const theme = resolved(selected);
    localStorage.setItem(BASE_KEY, selected);
    document.documentElement.dataset.themePreference = selected;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#121214' : '#f3f4f6',
    );
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      const active = button.dataset.themeChoice === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function persistCurrentChoice() {
    if (!userStorageKey) return;
    const selected = normalizedPreference(localStorage.getItem(BASE_KEY));
    localStorage.setItem(userStorageKey, selected);
  }

  // Vor der Anmeldung gilt immer die Systemeinstellung. Eine Auswahl eines
  // vorher angemeldeten Kontos darf nicht auf dem Login-Bildschirm durchscheinen.
  localStorage.removeItem(BASE_KEY);
  apply('system');

  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('[data-theme-choice], [data-nav="theme"]')) return;
    setTimeout(persistCurrentChoice, 0);
  }, true);

  fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null)
    .then((payload) => {
      if (!payload?.user) return;
      userStorageKey = userKey(payload.user);
      const selected = normalizedPreference(localStorage.getItem(userStorageKey));
      apply(selected);
      window.dispatchEvent(new CustomEvent('truewords:user-theme-ready', {
        detail: { preference: selected, user: payload.user },
      }));
    })
    .catch(() => null);
})();
