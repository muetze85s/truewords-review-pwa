(() => {
  'use strict';

  const form = document.getElementById('reset-form');
  const submit = document.getElementById('submit');
  const status = document.getElementById('status');

  function setStatus(text, state = 'idle') {
    status.textContent = text;
    status.dataset.state = state;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    setStatus('Passwort wird gesetzt …', 'working');

    try {
      const token = document.getElementById('admin-token').value.trim();
      if (!token) throw new Error('Admin-Zugangscode fehlt.');
      const role = document.getElementById('role').value;
      const newPassword = document.getElementById('new-password').value;

      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role, newPassword }),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || 'Passwort konnte nicht gesetzt werden.');

      document.getElementById('admin-token').value = '';
      document.getElementById('new-password').value = '';
      setStatus(`Passwort für ${role} gesetzt. Anmeldung wird geöffnet …`, 'ok');
      setTimeout(() => location.replace('/login.html'), 900);
    } catch (caught) {
      setStatus(caught?.message || 'Zurücksetzen fehlgeschlagen.', 'error');
    } finally {
      submit.disabled = false;
    }
  });
})();
