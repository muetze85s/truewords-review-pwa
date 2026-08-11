(() => {
  'use strict';

  const MAX_CHUNK_BYTES = 260_000;
  const form = document.getElementById('upload-form');
  const status = document.getElementById('status');
  const submit = document.getElementById('submit');
  const progressWrap = document.getElementById('progress-wrap');
  const progress = document.getElementById('progress');
  const progressLabel = document.getElementById('progress-label');
  const progressPercent = document.getElementById('progress-percent');
  const progressDetail = document.getElementById('progress-detail');

  function setStatus(text, state = 'idle') {
    status.textContent = text;
    status.dataset.state = state;
  }

  function setProgress(value, label, detail = '') {
    const safeValue = Math.max(0, Math.min(100, Math.round(value)));
    progressWrap.hidden = false;
    progress.value = safeValue;
    progressLabel.textContent = label;
    progressPercent.textContent = `${safeValue} %`;
    progressDetail.textContent = detail;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
      reader.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.max(1, Math.round((event.loaded / event.total) * 5));
        setProgress(percent, 'Datei wird gelesen …', `${formatBytes(event.loaded)} von ${formatBytes(event.total)}`);
      };
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsText(file);
    });
  }

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function yearRange(messages) {
    const years = messages
      .map((message) => String(message?.date || '').slice(0, 4))
      .filter((year) => /^\d{4}$/.test(year))
      .map(Number);
    if (!years.length) return { label: 'unbekannt', first: 2021, last: 2026 };
    const first = Math.min(...years);
    const last = Math.max(...years);
    return { label: first === last ? String(first) : `${first}–${last}`, first, last };
  }

  function makeChunks(messages) {
    const encoder = new TextEncoder();
    const chunks = [];
    let current = [];
    let currentBytes = 2;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const messageBytes = encoder.encode(JSON.stringify(message)).byteLength + (current.length ? 1 : 0);
      if (messageBytes > 650_000) {
        throw new Error(`Nachricht ${index + 1} ist zu groß für den Datenimport.`);
      }
      if (current.length && currentBytes + messageBytes > MAX_CHUNK_BYTES) {
        chunks.push(current);
        current = [];
        currentBytes = 2;
      }
      current.push(message);
      currentBytes += messageBytes;

      if (index % 3000 === 0 || index === messages.length - 1) {
        const preparation = messages.length ? (index + 1) / messages.length : 1;
        setProgress(
          8 + preparation * 4,
          'Datenblöcke werden vorbereitet …',
          `${(index + 1).toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} Nachrichten`,
        );
      }
    }

    if (current.length) chunks.push(current);
    return chunks;
  }

  async function api(path, token, body, retries = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        if (response.ok) return result;
        const failure = new Error(result.error || `HTTP ${response.status}`);
        failure.status = response.status;
        failure.details = result.details;
        if (response.status < 500 || attempt === retries) throw failure;
        lastError = failure;
      } catch (caught) {
        lastError = caught;
        if (caught?.status && caught.status < 500) throw caught;
        if (attempt === retries) throw caught;
      }
      await wait(attempt * 1200);
    }
    throw lastError || new Error('Server nicht erreichbar.');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;

    try {
      const token = document.getElementById('admin-token').value.trim();
      const datasetId = document.getElementById('dataset-id').value.trim();
      const name = document.getElementById('dataset-name').value.trim();
      const file = document.getElementById('chat-file').files?.[0];
      if (!token) throw new Error('Admin-Zugangscode fehlt.');
      if (!file) throw new Error('Bereinigter Rohchat fehlt.');

      setStatus('Import wird vorbereitet. Die Seite währenddessen geöffnet lassen.', 'working');
      setProgress(1, 'Datei wird gelesen …', file.name);
      const raw = await readFileText(file);

      setProgress(6, 'JSON wird geprüft …', `${formatBytes(file.size)} eingelesen`);
      let chat;
      try {
        chat = JSON.parse(raw);
      } catch {
        throw new Error('Der bereinigte Rohchat ist keine gültige JSON-Datei.');
      }
      if (!Array.isArray(chat.messages)) throw new Error('Der Chat enthält keine Nachrichtenliste.');
      if (!chat.messages.length) throw new Error('Der Chat enthält keine Nachrichten.');

      const years = yearRange(chat.messages);
      setProgress(7, 'Prüfsumme wird berechnet …', `${chat.messages.length.toLocaleString('de-DE')} Nachrichten aus ${years.label}`);
      const datasetHash = await sha256Hex(raw);
      const { messages, ...chatMeta } = chat;
      chatMeta.importedYearRange = years.label;
      chatMeta.sourceFileName = file.name;

      const chunks = makeChunks(messages);
      setProgress(12, 'Importsitzung wird angelegt …', `${chunks.length} Datenblöcke vorbereitet`);
      const started = await api('/api/admin/import/start', token, {
        datasetId,
        name,
        year: years.first,
        datasetHash,
        chatMeta,
        expectedChunks: chunks.length,
        expectedMessages: messages.length,
      });

      for (let index = 0; index < chunks.length; index += 1) {
        const base = 12;
        const span = 83;
        const before = base + (index / chunks.length) * span;
        setProgress(
          before,
          'Rohchat wird übertragen …',
          `Block ${index + 1} von ${chunks.length} · ${messages.length.toLocaleString('de-DE')} Nachrichten insgesamt`,
        );

        const result = await api('/api/admin/import/chunk', token, {
          datasetId,
          uploadId: started.uploadId,
          chunkIndex: index,
          messages: chunks[index],
        });

        const after = base + ((index + 1) / chunks.length) * span;
        setProgress(
          after,
          'Rohchat wird übertragen …',
          `${result.receivedMessages.toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} Nachrichten · Block ${index + 1}/${chunks.length}`,
        );
      }

      setProgress(97, 'Vollständigkeit wird geprüft …', 'Server prüft Block- und Nachrichtenzahl');
      const result = await api('/api/admin/import/finish', token, {
        datasetId,
        uploadId: started.uploadId,
      });

      document.getElementById('admin-token').value = '';
      setProgress(100, 'Import abgeschlossen', `${result.messages.toLocaleString('de-DE')} Nachrichten in ${result.chunks} Datenblöcken`);
      setStatus(
        `Import abgeschlossen: ${result.messages.toLocaleString('de-DE')} bereinigte Nachrichten aus ${years.label}. Der Prüfstand ist leer und enthält keine KI-Vorschläge.`,
        'ok',
      );
    } catch (caught) {
      const details = caught?.details;
      const suffix = details
        ? ` Empfangen: ${details.receivedMessages ?? '?'} von ${details.expectedMessages ?? '?'} Nachrichten.`
        : '';
      setStatus(`${caught?.message || 'Import fehlgeschlagen.'}${suffix}`, 'error');
      progressLabel.textContent = 'Import unterbrochen';
      progressDetail.textContent = 'Die Datei bleibt ausgewählt. Nach Behebung kann der Import erneut gestartet werden.';
    } finally {
      submit.disabled = false;
    }
  });
})();
