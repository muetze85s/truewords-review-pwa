(() => {
  'use strict';

  // Eigener, getrennter Datensatz — bewusst NICHT die Basis-id. Sichtbar im UI.
  const DATASET_ID = 'philena-4y';
  const DATASET_NAME = 'Philipp & Lena · 4 Jahre (Vollverlauf)';
  const MAX_CHUNK_BYTES = 260_000; // server-seitiges Blocklimit ist 700 KB; großer Puffer.

  const form = document.getElementById('upload-form');
  const tokenInput = document.getElementById('admin-token');
  const rawInput = document.getElementById('raw-file');
  const submit = document.getElementById('submit');
  const detected = document.getElementById('detected');
  const statusBox = document.getElementById('status');
  const progress = document.getElementById('progress');
  const progressLabel = document.getElementById('progress-label');

  let selected = null; // { chat, messages, datasetHash, year }

  const setStatus = (text, state = 'idle') => {
    statusBox.textContent = text;
    statusBox.dataset.state = state;
  };
  const setProgress = (value, label) => {
    progress.hidden = false;
    progress.value = Math.max(0, Math.min(100, Math.round(value)));
    progressLabel.textContent = label || '';
  };
  const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function deriveYear(messages) {
    for (const message of messages) {
      const raw = message && (message.date || message.date_unixtime);
      if (raw === undefined || raw === null) continue;
      let year;
      if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
        const seconds = Number(raw) > 1e12 ? Number(raw) / 1000 : Number(raw);
        year = new Date(seconds * 1000).getUTCFullYear();
      } else {
        const parsed = Date.parse(String(raw));
        if (!Number.isFinite(parsed)) continue;
        year = new Date(parsed).getUTCFullYear();
      }
      if (year >= 2000 && year <= 2100) return year;
    }
    return 2022;
  }

  function chunksFor(messages) {
    const encoder = new TextEncoder();
    const chunks = [];
    let chunk = [];
    let bytes = 2;
    for (const message of messages) {
      const encoded = encoder.encode(JSON.stringify(message)).byteLength + (chunk.length ? 1 : 0);
      if (chunk.length && bytes + encoded > MAX_CHUNK_BYTES) {
        chunks.push(chunk);
        chunk = [];
        bytes = 2;
      }
      chunk.push(message);
      bytes += encoded;
    }
    if (chunk.length) chunks.push(chunk);
    return chunks;
  }

  async function apiPost(path, body, retries = 3) {
    const token = tokenInput.value.trim();
    let lastError;
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
        if (!response.ok) {
          const failure = new Error(result.error || `HTTP ${response.status}`);
          failure.status = response.status;
          throw failure;
        }
        return result;
      } catch (caught) {
        lastError = caught;
        if ((caught && caught.status && caught.status < 500) || attempt === retries) throw caught;
        await wait(attempt * 900);
      }
    }
    throw lastError || new Error('Server nicht erreichbar.');
  }

  rawInput.addEventListener('change', async () => {
    selected = null;
    submit.disabled = true;
    const file = rawInput.files && rawInput.files[0];
    if (!file) { detected.textContent = ''; return; }
    try {
      setStatus('Datei wird gelesen und geprüft …', 'working');
      const text = await file.text();
      const chat = JSON.parse(text);
      if (!chat || typeof chat !== 'object' || Array.isArray(chat) || !Array.isArray(chat.messages)) {
        throw new Error('Kein gültiger Telegram-Export (keine messages-Liste).');
      }
      const datasetHash = await sha256Hex(text);
      const year = deriveYear(chat.messages);
      const chunks = chunksFor(chat.messages);
      selected = { chat, messages: chat.messages, datasetHash, year, chunkCount: chunks.length };
      detected.dataset.state = 'ok';
      detected.innerHTML =
        `<div><strong>${chat.messages.length.toLocaleString('de-DE')}</strong> Rohnachrichten · ${formatBytes(file.size)}</div>` +
        `<div>${chunks.length} Datenblöcke · erstes Jahr ~${year}</div>` +
        `<div>Ziel: <strong>${DATASET_ID}</strong> · Hash ${datasetHash.slice(0, 12)}…</div>`;
      setStatus('Bereit zum Hochladen nach philena-4y.', 'ok');
      submit.disabled = false;
    } catch (caught) {
      detected.dataset.state = 'error';
      detected.textContent = (caught && caught.message) || 'Dateiprüfung fehlgeschlagen.';
      setStatus('Es wurde nichts hochgeladen.', 'error');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selected) return;
    if (!tokenInput.value.trim()) { setStatus('Admin-Zugangscode fehlt.', 'error'); return; }
    submit.disabled = true;

    try {
      const { chat, messages, datasetHash, year } = selected;
      const chunks = chunksFor(messages);
      const { messages: _drop, ...chatMeta } = chat;

      setProgress(4, `Datensatz ${DATASET_ID} wird angelegt …`);
      const started = await apiPost('/api/admin/import/start', {
        datasetId: DATASET_ID,
        name: DATASET_NAME,
        year,
        datasetHash,
        chatMeta: { ...chatMeta, source: 'four-year-fullhistory' },
        expectedChunks: chunks.length,
        expectedMessages: messages.length,
      });

      for (let index = 0; index < chunks.length; index += 1) {
        await apiPost('/api/admin/import/chunk', {
          datasetId: DATASET_ID,
          uploadId: started.uploadId,
          chunkIndex: index,
          messages: chunks[index],
        });
        setProgress(6 + ((index + 1) / chunks.length) * 84, `Block ${index + 1} von ${chunks.length} gespeichert`);
      }

      setProgress(94, 'Import wird abgeschlossen …');
      const finished = await apiPost('/api/admin/import/finish', {
        datasetId: DATASET_ID,
        uploadId: started.uploadId,
      });

      setProgress(100, 'Fertig.');
      setStatus(
        `philena-4y eingespielt: ${Number(finished.messages).toLocaleString('de-DE')} Nachrichten in ${finished.chunks} Blöcken. ` +
        'Die Basis wurde nicht berührt. Sag Claude Bescheid — dann läuft der Anchor-Check.',
        'ok',
      );
    } catch (caught) {
      setStatus((caught && caught.message) || 'Import fehlgeschlagen.', 'error');
      submit.disabled = false;
    }
  });
})();
