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

  let selected = null;

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

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
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

  async function inspectFile() {
    selected = null;
    const file = filesInput.files?.[0];
    if (!file) {
      detectedFiles.textContent = 'Noch keine Datei ausgewählt.';
      detectedFiles.dataset.state = 'idle';
      setStatus('Originalexport auswählen. Die Vorselektion wird danach automatisch neu erzeugt.');
      return;
    }

    submit.disabled = true;
    detectedFiles.textContent = 'Originalexport wird vollständig geprüft …';
    detectedFiles.dataset.state = 'working';
    setStatus('Datei wird lokal gelesen, gehasht und verlustfrei aufbereitet …', 'working');
    setProgress(1, 'Originalexport wird gelesen …', `${file.name} · ${formatBytes(file.size)}`);

    try {
      const pilot = window.TRUEWORDS_PILOT_V2;
      if (!pilot) throw new Error('Test-2-Logik wurde nicht geladen. Seite neu laden.');

      const rawText = await file.text();
      setProgress(3, 'SHA-256 wird berechnet …', `${formatBytes(file.size)} eingelesen`);
      const datasetHash = await sha256Hex(rawText);
      if (datasetHash !== pilot.EXPECTED_SHA256) {
        throw new Error('Falsche Datei: SHA-256 stimmt nicht mit dem bekannten Telegram-Originalexport überein.');
      }

      setProgress(5, 'JSON und Ereigniszahl werden geprüft …', 'Erwartet: 73.946 Exportereignisse');
      let chat;
      try {
        chat = JSON.parse(rawText);
      } catch {
        throw new Error('Der Telegram-Originalexport ist keine gültige JSON-Datei.');
      }

      const prepared = pilot.prepareOriginalChat(chat);
      if (prepared.chat.truewordsTimelinePreservation.silentLosses !== 0) {
        throw new Error('Integritätsfehler: Die Aufbereitung hat Ereignisse verloren.');
      }
      const annotations = pilot.generatePilot(prepared, datasetHash);
      const assigned = Object.keys(annotations.assignments).length;
      if (assigned !== pilot.PILOT_EVENTS || annotations.situations.length !== pilot.PILOT_SITUATIONS) {
        throw new Error('Test-2-Vorselektion ist unvollständig.');
      }

      selected = {
        file,
        rawText,
        datasetHash,
        prepared,
        annotations,
      };
      chat = null;

      detectedFiles.innerHTML = `
        <div><strong>Telegram-Originalexport:</strong> ${escapeHtml(file.name)} · ${formatBytes(file.size)}</div>
        <div><strong>Integrität:</strong> 73.946/73.946 Ereignisse · stille Verluste: 0</div>
        <div><strong>Prüfjahr:</strong> 2.494/2.494 Ereignisse aus 2026 erhalten</div>
        <div><strong>Neue Vorselektion:</strong> 29 Situationen · 250/250 Ereignisse zugeordnet · Platzhalter enthalten</div>`;
      detectedFiles.dataset.state = 'ok';
      setProgress(8, 'Test 2 ist vorbereitet', 'Originalexport und Vorselektion sind lokal geprüft');
      setStatus('Quelle vollständig. Test 2 kann jetzt hochgeladen und aktiviert werden.', 'ok');
    } catch (caught) {
      selected = null;
      detectedFiles.textContent = caught?.message || 'Dateiprüfung fehlgeschlagen.';
      detectedFiles.dataset.state = 'error';
      progressLabel.textContent = 'Vorbereitung abgebrochen';
      progressDetail.textContent = 'Nur der vollständige, unveränderte Telegram-Originalexport wird akzeptiert.';
      setStatus(caught?.message || 'Dateiprüfung fehlgeschlagen.', 'error');
    } finally {
      submit.disabled = false;
    }
  }

  function makeChunks(messages, report) {
    const encoder = new TextEncoder();
    const chunks = [];
    let current = [];
    let currentBytes = 2;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const messageBytes = encoder.encode(JSON.stringify(message)).byteLength + (current.length ? 1 : 0);
      if (messageBytes > 650_000) throw new Error(`Ereignis ${index + 1} ist zu groß für den Import.`);
      if (current.length && currentBytes + messageBytes > MAX_CHUNK_BYTES) {
        chunks.push(current);
        current = [];
        currentBytes = 2;
      }
      current.push(message);
      currentBytes += messageBytes;
      if (index % 3000 === 0 || index === messages.length - 1) {
        report(
          (index + 1) / messages.length,
          `${(index + 1).toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} Ereignissen vorbereitet`,
        );
      }
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  async function uploadRaw(entry, rangeStart, rangeEnd) {
    const datasetId = document.getElementById('dataset-id').value.trim();
    const name = document.getElementById('dataset-name').value.trim();
    const chat = entry.prepared.chat;
    const messages = chat.messages;
    const span = rangeEnd - rangeStart;
    const report = (fraction, label, detail) => setProgress(rangeStart + fraction * span, label, detail);

    report(0.01, 'Verlustfreier Ereignisstrom wird vorbereitet …', '73.946 Exportereignisse');
    const { messages: ignored, ...chatMeta } = chat;
    void ignored;
    chatMeta.importedYearRange = '2021–2026';
    chatMeta.reviewYear = 2026;
    chatMeta.reviewYearEvents = entry.prepared.reviewEvents.length;
    chatMeta.sourceFileName = entry.file.name;
    chatMeta.sourceIntegrity = {
      sha256: entry.datasetHash,
      sourceEntries: messages.length,
      preservedEntries: messages.length,
      silentLosses: 0,
    };

    const chunks = makeChunks(messages, (fraction, detail) => {
      report(0.02 + fraction * 0.08, 'Datenblöcke werden vorbereitet …', detail);
    });

    report(0.11, 'Importsitzung für Test 2 wird angelegt …', `${chunks.length} Datenblöcke`);
    const started = await apiPost('/api/admin/import/start', {
      datasetId,
      name,
      year: 2026,
      datasetHash: entry.datasetHash,
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
        'Originalereignisse werden übertragen …',
        `${result.receivedMessages.toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} Ereignissen · Block ${index + 1}/${chunks.length}`,
      );
    }

    report(0.97, 'Vollständigkeit wird serverseitig geprüft …', 'Ereignis- und Blockzahl müssen exakt stimmen');
    const result = await apiPost('/api/admin/import/finish', {
      datasetId,
      uploadId: started.uploadId,
    });
    if (Number(result.messages) !== messages.length) throw new Error('Server hat nicht alle Ereignisse bestätigt.');
    report(1, 'Verlustfreier Ereignisstrom gespeichert', `${result.messages.toLocaleString('de-DE')} Ereignisse · stille Verluste: 0`);
    return result;
  }

  async function uploadAnalysis(entry, rangeStart, rangeEnd) {
    const datasetId = document.getElementById('dataset-id').value.trim();
    const annotations = entry.annotations;
    const span = rangeEnd - rangeStart;

    setProgress(
      rangeStart + span * 0.1,
      'Neue Grenzvorschläge werden geprüft …',
      `${annotations.situations.length} Situationen · ${Object.keys(annotations.assignments).length} Ereignisse`,
    );
    const result = await apiPost('/api/admin/analysis-versions/import', {
      datasetId,
      versionId: annotations.versionId,
      label: annotations.versionLabel,
      source: 'heuristic-v2-lossless-event-stream',
      parameters: annotations.preselection,
      annotations,
    });
    setProgress(
      rangeEnd,
      'Test 2 aktiviert',
      `${result.situations} Situationen · ${result.assignments} Ereigniszuordnungen · Pilot v1 verworfen`,
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

  filesInput.addEventListener('change', inspectFile);
  skip?.addEventListener('click', (event) => event.preventDefault());
  logout.addEventListener('click', signOut);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selected) {
      setStatus('Zuerst den vollständigen Telegram-Originalexport auswählen und prüfen.', 'error');
      return;
    }

    submit.disabled = true;
    if (skip) skip.disabled = true;
    filesInput.disabled = true;
    setStatus('Test 2 wird erstellt. Seite geöffnet lassen.', 'working');

    try {
      await uploadRaw(selected, 8, 88);
      await uploadAnalysis(selected, 88, 100);
      setProgress(100, 'Test 2 ist bereit', 'Prüfansicht wird geöffnet …');
      setStatus('Test 2 wurde mit vollständigem Ereignisstrom aktiviert. Weiterleitung …', 'ok');
      setTimeout(() => location.replace('/review.html'), 900);
    } catch (caught) {
      const details = caught?.details;
      const countSuffix = details?.expectedMessages
        ? ` Empfangen: ${details.receivedMessages ?? '?'} von ${details.expectedMessages} Ereignissen.`
        : '';
      setStatus(`${caught?.message || 'Test 2 konnte nicht gestartet werden.'}${countSuffix}`, 'error');
      progressLabel.textContent = 'Test 2 unterbrochen';
      progressDetail.textContent = 'Die Originaldatei bleibt ausgewählt. Nach Behebung kann der Upload erneut gestartet werden.';
      submit.disabled = false;
      filesInput.disabled = false;
    }
  });

  currentUser().catch(() => location.replace('/login.html'));
})();
