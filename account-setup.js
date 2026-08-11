(() => {
  'use strict';

  const form = document.getElementById('setup-form');
  const submit = document.getElementById('submit');
  const status = document.getElementById('status');

  function setStatus(text, state = 'idle') {
    status.textContent = text;
    status.dataset.state = state;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    setStatus('Konten werden sicher eingerichtet …', 'working');

    try {
      const token = document.getElementById('admin-token').value.trim();
      if (!token) throw new Error('Admin-Zugangscode fehlt.');

      const response = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          philippEmail: document.getElementById('philipp-email').value.trim(),
          philippPassword: document.getElementById('philipp-password').value,
          lenaEmail: document.getElementById('lena-email').value.trim(),
          lenaPassword: document.getElementById('lena-password').value,
        }),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || 'Konten konnten nicht gespeichert werden.');

      document.getElementById('admin-token').value = '';
      document.getElementById('philipp-password').value = '';
      document.getElementById('lena-password').value = '';
      setStatus('Konten gespeichert. Anmeldung wird geöffnet …', 'ok');
      setTimeout(() => location.replace('/login.html'), 900);
    } catch (caught) {
      setStatus(caught?.message || 'Einrichtung fehlgeschlagen.', 'error');
    } finally {
      submit.disabled = false;
    }
  });
})();
