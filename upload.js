(() => {
  'use strict';

  const MAX_CHUNK_BYTES = 260_000;
  const form = document.getElementById('upload-form');
  const filesInput = document.getElementById('data-files');
  const detectedFiles = document.getElementById('detected-files');
  const status = document.getElementById('status');
  const submit = document.getElementById('submit');
  const skip = document.getElementById('skip');
  const logout = document.getElementById('logout');
  const progressWrap = document.getElementById('progress-wrap');
  const progress = document.getElementById('progress');
  const progressLabel = document.getElementById('progress-label');
  const progressPercent = document.getElementById('progress-percent');
  const progressDetail = document.getElementById('progress-detail');

  let selected = [];

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

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      const failure = new Error(result.error || `HTTP ${response.status}`);
      failure.status = response.status;
      failure.details = result.details;
      throw failure;
    }
    return result;
  }

  async function apiPost(path, body, retries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        return await fetchJson(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (caught) {
        lastError = caught;
        if ((caught?.status && caught.status < 500) || attempt === retries) throw caught;
        await wait(attempt * 1000);
      }
    }
    throw lastError || new Error('Server nicht erreichbar.');
  }

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function detectType(data) {
    const raw = data && typeof data === 'object' && Array.isArray(data.messages);
    const analysis = data && typeof data === 'object'
      && Array.isArray(data.situations)
      && data.assignments
      && typeof data.assignments === 'object'
      && !Array.isArray(data.assignments);
    if (raw && !analysis) return 'raw';
    if (analysis && !raw) return 'analysis';
    return null;
  }

  function typeLabel(type) {
    return type === 'raw' ? 'Bereinigter Rohchat' : 'KI-/Algorithmusvorschläge';
  }

  function renderDetected() {
    if (!selected.length) {
      detectedFiles.textContent = 'Noch keine Datei ausgewählt.';
      detectedFiles.dataset.state = 'idle';
      return;
    }
    detectedFiles.innerHTML = selected
      .map((entry) => `<div><strong>${typeLabel(entry.type)}:</strong> ${escapeHtml(entry.file.name)} · ${formatBytes(entry.file.size)}</div>`)
      .join('');
    detectedFiles.dataset.state = 'ok';
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function inspectFiles() {
    selected = [];
    const files = [...(filesInput.files || [])];
    if (!files.length) {
      renderDetected();
      setStatus('Dateien auswählen oder direkt zur Prüfung wechseln.');
      return;
    }

    submit.disabled = true;
    detectedFiles.textContent = 'Dateien werden geprüft …';
    detectedFiles.dataset.state = 'working';

    try {
      for (const file of files) {
        const rawText = await file.text();
        let data;
        try {
          data = JSON.parse(rawText);
        } catch {
          throw new Error(`${file.name} ist keine gültige JSON-Datei.`);
        }
        const type = detectType(data);
        if (!type) throw new Error(`${file.name} wurde weder als Rohchat noch als Vorschlagsdatei erkannt.`);
        if (selected.some((entry) => entry.type === type)) {
          throw new Error(`Es kann nur eine Datei vom Typ „${typeLabel(type)}“ gleichzeitig hochgeladen werden.`);
        }
        selected.push({ file, rawText, data, type });
      }
      selected.sort((left, right) => (left.type === 'raw' ? -1 : 1) - (right.type === 'raw' ? -1 : 1));
      renderDetected();
      setStatus(`${selected.length} Datei${selected.length === 1 ? '' : 'en'} automatisch erkannt.`, 'ok');
    } catch (caught) {
      selected = [];
      detectedFiles.textContent = caught?.message || 'Dateierkennung fehlgeschlagen.';
      detectedFiles.dataset.state = 'error';
      setStatus('Bitte eine gültige Rohchat- oder Vorschlagsdatei auswählen.', 'error');
    } finally {
      submit.disabled = false;
    }
  }

  function yearRange(messages) {
    const years = messages
      .map((message) => String(message?.date || '').slice(0, 4))
      .filter((year) => /^\d{4}$/.test(year))
      .map(Number);
    if (!years.length) return { label: 'unbekannt', first: 2021 };
    const first = Math.min(...years);
    const last = Math.max(...years);
    return { label: first === last ? String(first) : `${first}–${last}`, first };
  }

  function makeChunks(messages, report) {
    const encoder = new TextEncoder();
    const chunks = [];
    let current = [];
    let currentBytes = 2;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const messageBytes = encoder.encode(JSON.stringify(message)).byteLength + (current.length ? 1 : 0);
      if (messageBytes > 650_000) throw new Error(`Nachricht ${index + 1} ist zu groß für den Import.`);
      if (current.length && currentBytes + messageBytes > MAX_CHUNK_BYTES) {
        chunks.push(current);
        current = [];
        currentBytes = 2;
      }
      current.push(message);
      currentBytes += messageBytes;
      if (index % 3000 === 0 || index === messages.length - 1) {
        report((index + 1) / messages.length, `${(index + 1).toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} Nachrichten vorbereitet`);
      }
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  async function uploadRaw(entry, rangeStart, rangeEnd) {
    const datasetId = document.getElementById('dataset-id').value.trim();
    const name = document.getElementById('dataset-name').value.trim();
    const chat = entry.data;
    if (!Array.isArray(chat.messages) || !chat.messages.length) throw new Error('Der Rohchat enthält keine Nachrichten.');

    const span = rangeEnd - rangeStart;
    const report = (fraction, label, detail) => setProgress(rangeStart + fraction * span, label, detail);
    report(0.01, 'Rohchat wird vorbereitet …', entry.file.name);

    const years = yearRange(chat.messages);
    const datasetHash = await sha256Hex(entry.rawText);
    const { messages, ...chatMeta } = chat;
    chatMeta.importedYearRange = years.label;
    chatMeta.sourceFileName = entry.file.name;

    const chunks = makeChunks(messages, (fraction, detail) => {
      report(0.02 + fraction * 0.08, 'Rohchat wird vorbereitet …', detail);
    });

    report(0.11, 'Importsitzung wird angelegt …', `${chunks.length} Datenblöcke`);
    const started = await apiPost('/api/admin/import/start', {
      datasetId,
      name,
      year: years.first,
      datasetHash,
      chatMeta,
      expectedChunks: chunks.length,
      expectedMessages: messages.length,
    });

    for (let index = 0; index < chunks.length; index += 1) {
      const result = await apiPost('/api/admin/import/chunk', {
        datasetId,
        uploadId: started.uploadId,
        chunkIndex: index,
        messages: chunks[index],
      });
      report(
        0.11 + ((index + 1) / chunks.length) * 0.84,
        'Rohchat wird übertragen …',
        `${result.receivedMessages.toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} Nachrichten · Block ${index + 1}/${chunks.length}`,
      );
    }

    report(0.97, 'Rohchat wird geprüft …', 'Vollständigkeit der Datenblöcke');
    const result = await apiPost('/api/admin/import/finish', {
      datasetId,
      uploadId: started.uploadId,
    });
    report(1, 'Rohchat gespeichert', `${result.messages.toLocaleString('de-DE')} Nachrichten aus ${years.label}`);
    return result;
  }

  function sanitizeId(value) {
    const cleaned = String(value || '')
      .toLocaleLowerCase('de-DE')
      .normalize('NFKD')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    return cleaned.length >= 3 ? cleaned : `analyse-${Date.now()}`;
  }

  function analysisIdentity(entry) {
    const data = entry.data;
    const preselection = data.preselection && typeof data.preselection === 'object' ? data.preselection : {};
    const schema = String(preselection.schemaVersion || data.schemaVersion || 'analyse');
    const explicit = data.versionId || data.analysisVersion || preselection.versionId || preselection.version;
    const pilot = Number(preselection.suggestedSituations || 0) === 29 && Number(preselection.selectedMessages || 0) === 250;
    const versionId = sanitizeId(explicit || (pilot ? 'pilot-v1' : `${schema}-${Date.now()}`));
    const label = String(
      data.versionLabel
      || data.label
      || preselection.label
      || (pilot ? 'Pilot v1 · lokale Heuristik' : entry.file.name.replace(/\.json$/i, '')),
    ).slice(0, 240);
    return { versionId, label };
  }

  async function uploadAnalysis(entry, rangeStart, rangeEnd) {
    const datasetId = document.getElementById('dataset-id').value.trim();
    const annotations = entry.data;
    if (!Array.isArray(annotations.situations) || !annotations.situations.length) {
      throw new Error('Die Vorschlagsdatei enthält keine Situationen.');
    }
    if (!annotations.assignments || typeof annotations.assignments !== 'object') {
      throw new Error('Die Vorschlagsdatei enthält keine Nachrichtenzuordnungen.');
    }

    const span = rangeEnd - rangeStart;
    setProgress(rangeStart + span * 0.1, 'Vorschläge werden geprüft …', `${annotations.situations.length} Situationen erkannt`);
    const identity = analysisIdentity(entry);
    const result = await apiPost('/api/admin/analysis-versions/import', {
      datasetId,
      versionId: identity.versionId,
      label: identity.label,
      source: 'automatic-file-import',
      parameters: annotations.preselection || {},
      annotations,
    });
    setProgress(
      rangeEnd,
      'Vorschläge gespeichert',
      `${result.situations} Situationen · ${result.assignments} Nachrichtenzuordnungen · ${identity.label}`,
    );
    return result;
  }

  async function currentUser() {
    const result = await fetchJson('/api/auth/me');
    if (!result.user?.canUpload) {
      location.replace('/review.html');
      return null;
    }
    document.getElementById('account-email').textContent = result.user.email;
    return result.user;
  }

  async function signOut() {
    await fetchJson('/api/auth/logout', { method: 'POST' }).catch(() => null);
    location.replace('/login.html');
  }

  filesInput.addEventListener('change', inspectFiles);
  skip.addEventListener('click', () => location.assign('/review.html'));
  logout.addEventListener('click', signOut);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selected.length) {
      location.assign('/review.html');
      return;
    }

    submit.disabled = true;
    skip.disabled = true;
    filesInput.disabled = true;
    setStatus('Upload läuft. Die Seite geöffnet lassen.', 'working');

    try {
      const raw = selected.find((entry) => entry.type === 'raw');
      const analysis = selected.find((entry) => entry.type === 'analysis');

      if (raw && analysis) {
        await uploadRaw(raw, 0, 85);
        await uploadAnalysis(analysis, 85, 100);
      } else if (raw) {
        await uploadRaw(raw, 0, 100);
      } else if (analysis) {
        await uploadAnalysis(analysis, 0, 100);
      }

      setProgress(100, 'Upload abgeschlossen', 'Prüfung wird geöffnet …');
      setStatus('Alle ausgewählten Daten wurden gespeichert. Weiterleitung zur Prüfung …', 'ok');
      setTimeout(() => location.replace('/review.html'), 900);
    } catch (caught) {
      const details = caught?.details;
      const suffix = details?.expectedMessages
        ? ` Empfangen: ${details.receivedMessages ?? '?'} von ${details.expectedMessages} Nachrichten.`
        : '';
      setStatus(`${caught?.message || 'Upload fehlgeschlagen.'}${suffix}`, 'error');
      progressLabel.textContent = 'Upload unterbrochen';
      progressDetail.textContent = 'Die Dateien bleiben ausgewählt. Der Upload kann erneut gestartet werden.';
      submit.disabled = false;
      skip.disabled = false;
      filesInput.disabled = false;
    }
  });

  currentUser().catch(() => location.replace('/login.html'));
})();
