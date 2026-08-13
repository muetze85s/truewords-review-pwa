(() => {
  'use strict';

  const form = document.getElementById('transfer-form');
  const tokenInput = document.getElementById('admin-token');
  const submit = document.getElementById('submit');
  const statusBox = document.getElementById('status');
  const result = document.getElementById('result');

  const setStatus = (text, state = 'idle') => {
    statusBox.textContent = text;
    statusBox.dataset.state = state;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) { setStatus('Admin-Zugangscode fehlt.', 'error'); return; }
    submit.disabled = true;
    result.textContent = '';
    setStatus('Übertragung läuft … (Server prüft Frische + Anchor-Check)', 'working');

    try {
      const response = await fetch('/api/admin/transfer-boundaries', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ confirm: 'philena-4y' }),
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) {
        setStatus(data.error || `Übertragung fehlgeschlagen (HTTP ${response.status}).`, 'error');
        result.textContent = JSON.stringify(data, null, 2);
        submit.disabled = false;
        return;
      }
      const c = data.inserted || {};
      setStatus('Übertragung abgeschlossen. Sag Claude diese Zahlen.', 'ok');
      result.textContent =
        `nach philena-4y kopiert:\n` +
        `  Runden:        ${c.rounds}\n` +
        `  Markierungen:  ${c.marks}\n` +
        `  Abgaben:       ${c.submissions}\n` +
        `  Streitfälle:   ${c.resolutions}\n\n` +
        JSON.stringify(data, null, 2);
    } catch (caught) {
      setStatus((caught && caught.message) || 'Server nicht erreichbar.', 'error');
      submit.disabled = false;
    }
  });
})();
