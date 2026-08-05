(() => {
  'use strict';

  const YEAR = 2026;
  const form = document.getElementById('upload-form');
  const status = document.getElementById('status');
  const submit = document.getElementById('submit');

  function setStatus(text, state = 'idle') {
    status.textContent = text;
    status.dataset.state = state;
  }

  function messageYear(message) {
    const raw = message?.date ?? message?.date_unixtime;
    const numeric = /^\d{9,13}$/.test(String(raw));
    const date = new Date(
      numeric
        ? String(raw).length > 10
          ? Number(raw)
          : Number(raw) * 1000
        : raw,
    );
    return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;

    try {
      const token = document.getElementById('admin-token').value.trim();
      const datasetId = document.getElementById('dataset-id').value.trim();
      const name = document.getElementById('dataset-name').value.trim();
      if (!token) throw new Error('Admin-Zugangscode fehlt.');

      setStatus('Dateien werden lokal gelesen und auf 2026 reduziert …', 'working');
      const [chat, annotations] = await Promise.all([
        readJson(document.getElementById('chat-file'), 'Telegram-Export'),
        readJson(document.getElementById('annotations-file'), 'KI-Vorselektion'),
      ]);

      if (!Array.isArray(chat.messages)) {
        throw new Error('Der Telegram-Export enthält keine Nachrichtenliste.');
      }
      if (!Array.isArray(annotations.situations) || !annotations.assignments) {
        throw new Error('Die Vorselektionsdatei enthält keine gültigen Situationen.');
      }

      const selected = chat.messages.filter((message) => messageYear(message) === YEAR);
      const filteredChat = {
        ...chat,
        name: `${chat.name || name} · ${YEAR}`,
        messages: selected,
      };

      setStatus(`${selected.length} Einträge aus 2026 werden verschlüsselt übertragen …`, 'working');
      const response = await fetch('/api/admin/import', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          datasetId,
          name,
          year: YEAR,
          chat: filteredChat,
          annotations,
        }),
      });

      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || `Import fehlgeschlagen: HTTP ${response.status}`);

      document.getElementById('admin-token').value = '';
      setStatus(
        `Import abgeschlossen: ${selected.length} Einträge, ${result.situations} Situationen. Philipp ${result.split.Philipp}, Lena ${result.split.Lena}.`,
        'ok',
      );
    } catch (caught) {
      setStatus(caught?.message || 'Import fehlgeschlagen.', 'error');
    } finally {
      submit.disabled = false;
    }
  });
})();
