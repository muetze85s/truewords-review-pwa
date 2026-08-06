(() => {
  'use strict';

  const form = document.getElementById('upload-form');
  const status = document.getElementById('status');
  const submit = document.getElementById('submit');

  function setStatus(text, state = 'idle') {
    status.textContent = text;
    status.dataset.state = state;
  }

  async function readJson(input, label) {
    const file = input.files?.[0];
    if (!file) throw new Error(`${label} fehlt.`);
    try {
      return JSON.parse(await file.text());
    } catch {
      throw new Error(`${label} ist keine gültige JSON-Datei.`);
    }
  }

  function yearRange(messages) {
    const years = messages
      .map((message) => String(message?.date || '').slice(0, 4))
      .filter((year) => /^\d{4}$/.test(year))
      .map(Number);
    if (!years.length) return 'unbekannt';
    return `${Math.min(...years)}–${Math.max(...years)}`;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;

    try {
      const token = document.getElementById('admin-token').value.trim();
      const datasetId = document.getElementById('dataset-id').value.trim();
      const name = document.getElementById('dataset-name').value.trim();
      if (!token) throw new Error('Admin-Zugangscode fehlt.');

      setStatus('Bereinigter Rohchat wird lokal geprüft …', 'working');
      const chat = await readJson(document.getElementById('chat-file'), 'Bereinigter Rohchat');
      if (!Array.isArray(chat.messages)) {
        throw new Error('Der Chat enthält keine Nachrichtenliste.');
      }
      if (!chat.messages.length) throw new Error('Der Chat enthält keine Nachrichten.');

      const years = yearRange(chat.messages);
      const annotations = {
        schemaVersion: 'truewords-manual-segmentation/v2',
        datasetHash: '',
        datasetLabel: name,
        reviewer: 'System',
        situations: [],
        assignments: {},
        events: [],
      };

      setStatus(`${chat.messages.length} bereinigte Nachrichten aus ${years} werden übertragen …`, 'working');
      const response = await fetch('/api/admin/import', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          datasetId,
          name,
          year: 2026,
          chat,
          annotations,
        }),
      });

      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || `Import fehlgeschlagen: HTTP ${response.status}`);

      document.getElementById('admin-token').value = '';
      setStatus(
        `Import abgeschlossen: ${result.messages} bereinigte Nachrichten aus ${years}, ${result.chunks} Datenblöcke, leerer Prüfstand ohne KI-Vorschläge.`,
        'ok',
      );
    } catch (caught) {
      setStatus(caught?.message || 'Import fehlgeschlagen.', 'error');
    } finally {
      submit.disabled = false;
    }
  });
})();