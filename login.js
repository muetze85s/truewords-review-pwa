(() => {
  'use strict';

  const form = document.getElementById('login-form');
  const submit = document.getElementById('submit');
  const status = document.getElementById('status');
  const setupNote = document.getElementById('setup-note');

  function setStatus(text, state = 'idle') {
    status.textContent = text;
    status.dataset.state = state;
  }

  async function checkSetup() {
    try {
      const response = await fetch('/api/auth/setup-status', { cache: 'no-store' });
      const result = await response.json();
      setupNote.hidden = result.configured !== false;
    } catch {
      setupNote.hidden = true;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    setStatus('Anmeldung wird geprüft …', 'working');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value.trim(),
          password: document.getElementById('password').value,
        }),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || 'Anmeldung fehlgeschlagen.');

      setStatus('Angemeldet. Seite wird geöffnet …', 'ok');
      if (result.user?.role === 'Lena') {
        location.replace('/situation-quiz.html');
      } else {
        location.replace(result.user?.canUpload ? '/upload.html' : '/review.html');
      }
    } catch (caught) {
      setStatus(caught?.message || 'Anmeldung fehlgeschlagen.', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  checkSetup();
})();
