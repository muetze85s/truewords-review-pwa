(() => {
  'use strict';

  const continueButton = document.querySelector('[data-continue]');
  const uploadButton = document.querySelector('[data-upload]');
  const account = document.querySelector('[data-account]');
  const logout = document.querySelector('[data-logout]');

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

  async function start() {
    try {
      const auth = await fetchJson('/api/auth/me');
      const user = auth.user;
      if (!user) throw new Error('Nicht angemeldet.');
      account.textContent = `${user.role} · ${user.email}`;

      let destination = '/review.html';
      let label = 'Zum Prüfstand';
      if (user.role === 'Lena') {
        const quiz = await fetchJson('/api/situation-quiz/status');
        if (quiz.required) {
          destination = '/situation-quiz.html';
          label = 'Zum kurzen Situations-Quiz';
        }
      }

      continueButton.textContent = label;
      continueButton.dataset.destination = destination;
      continueButton.disabled = false;

      if (user.canUpload) uploadButton.hidden = false;
    } catch {
      location.replace('/login.html');
    }
  }

  continueButton.addEventListener('click', () => {
    const destination = continueButton.dataset.destination || '/review.html';
    location.replace(destination);
  });

  uploadButton.addEventListener('click', () => location.replace('/upload.html'));

  logout.addEventListener('click', async () => {
    await fetchJson('/api/auth/logout', { method: 'POST' }).catch(() => null);
    location.replace('/login.html');
  });

  start();
})();