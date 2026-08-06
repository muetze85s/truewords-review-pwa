(() => {
  'use strict';

  const MAX_CHUNK_BYTES = 260_000;
  const ORIGINAL_SOURCE_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
  const LOSSLESS_2026_SHA256 = '0501361af7e9fec8ba7ba24da45256db98479cfb600d1de30ece64c5ef057b44';
  const PRESELECTION_SHA256 = '0c4409bcf000157d038e8cefc66b022409189579c47669ad98444852d1e9c24e';
  const ORIGINAL_SOURCE_EVENTS = 73_946;
  const REVIEW_EVENTS = 2_494;
  const PRESELECTION_SITUATIONS = 28;
  const PRESELECTION_ASSIGNMENTS = 335;

  const form = document.getElementById('upload-form');
  const rawInput = document.getElementById('raw-file');
  const preselectionInput = document.getElementById('preselection-file');
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

  function parseJson(text, label) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} ist keine gültige JSON-Datei.`);
    }
  }

  function losslessChatFromOriginal(chat, pilot, sourceFileName) {
    const prepared = pilot.prepareOriginalChat(chat);
    const reviewEvents = prepared.reviewEvents;
    if (reviewEvents.length !== REVIEW_EVENTS) {
      throw new Error(`Der Originalexport enthält nicht exakt ${REVIEW_EVENTS.toLocaleString('de-DE')} Ereignisse aus 2026.`);
    }
    if (prepared.chat.truewordsTimelinePreservation.silentLosses !== 0) {
      throw new Error('Integritätsfehler: Die verlustfreie Aufbereitung hat Ereignisse verloren.');
    }

    return {
      schemaVersion: 'truewords-lossless-chat/v2',
      datasetHash: ORIGINAL_SOURCE_SHA256,
      datasetLabel: 'Philipp Sellin · 2026 · verlustfreier Ereignisstrom',
      source: {
        fileName: sourceFileName,
        chatName: chat.name,
        chatType: chat.type,
        chatId: chat.id,
        sourceEvents: ORIGINAL_SOURCE_EVENTS,
        sourceSha256: ORIGINAL_SOURCE_SHA256,
      },
      scope: {
        year: 2026,
        events: reviewEvents.length,
        firstEventId: String(reviewEvents[0]?.id ?? ''),
        lastEventId: String(reviewEvents.at(-1)?.id ?? ''),
        firstDate: reviewEvents[0]?.date,
        lastDate: reviewEvents.at(-1)?.date,
      },
      integrity: {
        silentLosses: 0,
        preservedEvents: reviewEvents.length,
        normalTextUnchanged: true,
        mediaAndServiceEventsPreserved: true,
        replyReferencesPreserved: true,
      },
      messages: reviewEvents,
    };
  }

  function validateLosslessChat(chat) {
    if (!chat || chat.schemaVersion !== 'truewords-lossless-chat/v2') {
      throw new Error('Die Rohchat-Datei ist nicht der verlustfreie Test-2-Rohchat.');
    }
    if (chat.datasetHash !== ORIGINAL_SOURCE_SHA256) {
      throw new Error('Der Rohchat gehört nicht zum bekannten Telegram-Originalexport.');
    }
    if (!Array.isArray(chat.messages) || chat.messages.length !== REVIEW_EVENTS) {
      throw new Error(`Der Rohchat muss exakt ${REVIEW_EVENTS.toLocaleString('de-DE')} Ereignisse aus 2026 enthalten.`);
    }
    if (Number(chat.integrity?.silentLosses) !== 0) {
      throw new Error('Der Rohchat meldet stille Verluste und wird abgelehnt.');
    }
    const ids = new Set();
    for (const message of chat.messages) {
      const id = String(message?.id ?? '');
      if (!id || ids.has(id)) throw new Error('Der Rohchat enthält fehlende oder doppelte Telegram-IDs.');
      ids.add(id);
      if (message?.truewords_timeline_preserved !== true) {
        throw new Error(`Ereignis ${id} ist nicht als chronologisch erhalten markiert.`);
      }
    }
    return ids;
  }

  function validatePreselection(annotations, messageIds) {
    if (!annotations || annotations.schemaVersion !== 'truewords-manual-segmentation/v2') {
      throw new Error('Die KI-Vorselektionsdatei hat nicht das erwartete Test-2-Format.');
    }
    if (annotations.datasetHash !== ORIGINAL_SOURCE_SHA256) {
      throw new Error('Rohchat und KI-Vorselektion gehören nicht zur selben Quelle.');
    }
    if (!Array.isArray(annotations.situations) || annotations.situations.length !== PRESELECTION_SITUATIONS) {
      throw new Error(`Die KI-Vorselektion muss exakt ${PRESELECTION_SITUATIONS} Situationen enthalten.`);
    }
    if (!annotations.assignments || typeof annotations.assignments !== 'object' || Array.isArray(annotations.assignments)) {
      throw new Error('Die KI-Vorselektionsdatei enthält keine gültigen Ereigniszuordnungen.');
    }

    const situationIds = new Set();
    for (const situation of annotations.situations) {
      const id = Number(situation?.id);
      if (!Number.isInteger(id) || id <= 0 || situationIds.has(id)) {
        throw new Error('Die KI-Vorselektion enthält ungültige oder doppelte Situations-IDs.');
      }
      situationIds.add(id);
    }

    const assignments = Object.entries(annotations.assignments);
    if (assignments.length !== PRESELECTION_ASSIGNMENTS) {
      throw new Error(`Die KI-Vorselektion muss exakt ${PRESELECTION_ASSIGNMENTS} Ereigniszuordnungen enthalten.`);
    }
    for (const [messageId, situationId] of assignments) {
      if (!messageIds.has(String(messageId))) {
        throw new Error(`Zugeordnetes Ereignis ${messageId} fehlt im verlustfreien Rohchat.`);
      }
      if (!situationIds.has(Number(situationId))) {
        throw new Error(`Ereignis ${messageId} verweist auf eine unbekannte Situation.`);
      }
    }

    const integrity = annotations.preselection?.integrity;
    if (integrity?.silentLosses !== 0 || integrity?.allPilotEventsAssigned !== true) {
      throw new Error('Die KI-Vorselektion besteht ihre Integritätsprüfung nicht.');
    }
  }

  async function inspectFiles() {
    selected = null;
    const rawFile = rawInput.files?.[0];
    const preselectionFile = preselectionInput.files?.[0];

    if (!rawFile && !preselectionFile) {
      detectedFiles.textContent = 'Noch keine Datei ausgewählt.';
      detectedFiles.dataset.state = 'idle';
      setStatus('Rohchat und KI-Vorselektionsdatei auswählen.');
      return;
    }
    if (!rawFile || !preselectionFile) {
      const missing = rawFile ? 'KI-Vorselektionsdatei' : 'verlustfreien Rohchat';
      detectedFiles.textContent = `Noch den ${missing} auswählen.`;
      detectedFiles.dataset.state = 'idle';
      setStatus(`Beide Dateien sind erforderlich. Es fehlt: ${missing}.`);
      return;
    }

    submit.disabled = true;
    detectedFiles.textContent = 'Rohchat und KI-Vorselektion werden vollständig geprüft …';
    detectedFiles.dataset.state = 'working';
    setStatus('Beide Dateien werden lokal gelesen, gehasht und gegeneinander geprüft …', 'working');
    setProgress(1, 'Dateien werden gelesen …', `${rawFile.name} · ${preselectionFile.name}`);

    try {
      const pilot = window.TRUEWORDS_PILOT_V2;
      if (!pilot) throw new Error('Test-2-Logik wurde nicht geladen. Seite neu laden.');

      const [rawText, preselectionText] = await Promise.all([
        rawFile.text(),
        preselectionFile.text(),
      ]);
      setProgress(3, 'SHA-256 wird berechnet …', `${formatBytes(rawFile.size)} + ${formatBytes(preselectionFile.size)}`);
      const [rawFileHash, preselectionFileHash] = await Promise.all([
        sha256Hex(rawText),
        sha256Hex(preselectionText),
      ]);

      let chat;
      if (rawFileHash === ORIGINAL_SOURCE_SHA256) {
        const original = parseJson(rawText, 'Der Telegram-Originalexport');
        if (!Array.isArray(original.messages) || original.messages.length !== ORIGINAL_SOURCE_EVENTS) {
          throw new Error('Der Telegram-Originalexport enthält nicht exakt 73.946 Exportereignisse.');
        }
        chat = losslessChatFromOriginal(original, pilot, rawFile.name);
      } else if (rawFileHash === LOSSLESS_2026_SHA256) {
        chat = parseJson(rawText, 'Der verlustfreie Rohchat');
      } else {
        throw new Error('Falscher Rohchat: Weder der vollständige Telegram-Originalexport noch die bereitgestellte verlustfreie 2026-Datei wurde erkannt.');
      }

      if (preselectionFileHash !== PRESELECTION_SHA256) {
        throw new Error('Falsche KI-Vorselektionsdatei: SHA-256 stimmt nicht mit der bereitgestellten Test-2-Datei überein.');
      }
      const annotations = parseJson(preselectionText, 'Die KI-Vorselektionsdatei');
      const messageIds = validateLosslessChat(chat);
      validatePreselection(annotations, messageIds);

      selected = {
        rawFile,
        preselectionFile,
        rawFileHash,
        preselectionFileHash,
        datasetHash: ORIGINAL_SOURCE_SHA256,
        chat,
        annotations,
      };

      detectedFiles.innerHTML = `
        <div><strong>Verlustfreier Rohchat:</strong> ${escapeHtml(rawFile.name)} · ${REVIEW_EVENTS.toLocaleString('de-DE')} Ereignisse</div>
        <div><strong>KI-Vorselektion:</strong> ${escapeHtml(preselectionFile.name)} · ${annotations.situations.length} Situationen · ${Object.keys(annotations.assignments).length} Zuordnungen</div>
        <div><strong>Integrität:</strong> gemeinsame Quelle bestätigt · stille Verluste: 0 · Platzhalter enthalten</div>`;
      detectedFiles.dataset.state = 'ok';
      setProgress(8, 'Test 2 ist vorbereitet', 'Rohchat und KI-Vorschläge sind lokal geprüft');
      setStatus('Beide Dateien sind vollständig. Test 2 kann hochgeladen und aktiviert werden.', 'ok');
    } catch (caught) {
      selected = null;
      detectedFiles.textContent = caught?.message || 'Dateiprüfung fehlgeschlagen.';
      detectedFiles.dataset.state = 'error';
      progressLabel.textContent = 'Vorbereitung abgebrochen';
      progressDetail.textContent = 'Rohchat und KI-Vorselektion müssen exakt zusammenpassen.';
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
      if (index % 300 === 0 || index === messages.length - 1) {
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
    const chat = entry.chat;
    const messages = chat.messages;
    const span = rangeEnd - rangeStart;
    const report = (fraction, label, detail) => setProgress(rangeStart + fraction * span, label, detail);

    report(0.01, 'Verlustfreier Ereignisstrom wird vorbereitet …', `${messages.length.toLocaleString('de-DE')} Ereignisse aus 2026`);
    const { messages: ignored, ...chatMeta } = chat;
    void ignored;
    chatMeta.importedYearRange = '2026';
    chatMeta.reviewYear = 2026;
    chatMeta.reviewYearEvents = messages.length;
    chatMeta.sourceFileName = entry.rawFile.name;
    chatMeta.sourceIntegrity = {
      sha256: entry.datasetHash,
      sourceSha256: ORIGINAL_SOURCE_SHA256,
      sourceFileHash: entry.rawFileHash,
      sourceEntries: ORIGINAL_SOURCE_EVENTS,
      uploadedEvents: messages.length,
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
      'KI-Vorselektion wird geprüft …',
      `${annotations.situations.length} Situationen · ${Object.keys(annotations.assignments).length} Ereignisse`,
    );
    const result = await apiPost('/api/admin/analysis-versions/import', {
      datasetId,
      versionId: 'pilot-v2-lossless-userfile',
      label: `KI-Vorselektion V2 · ${annotations.situations.length} Situationen`,
      source: 'chatgpt-ai-preselection-v2-lossless-upload',
      parameters: {
        ...(annotations.preselection || {}),
        sourceFileHash: entry.preselectionFileHash,
        sourceFileName: entry.preselectionFile.name,
      },
      annotations,
    });
    setProgress(
      rangeEnd,
      'Test 2 aktiviert',
      `${result.situations} Situationen · ${result.assignments} Ereigniszuordnungen · Test 1 bleibt gesperrt`,
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

  rawInput.addEventListener('change', inspectFiles);
  preselectionInput.addEventListener('change', inspectFiles);
  skip?.addEventListener('click', () => location.replace('/review.html'));
  logout.addEventListener('click', signOut);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selected) {
      setStatus('Zuerst den verlustfreien Rohchat und die KI-Vorselektionsdatei auswählen und prüfen.', 'error');
      return;
    }

    submit.disabled = true;
    if (skip) skip.disabled = true;
    rawInput.disabled = true;
    preselectionInput.disabled = true;
    setStatus('Test 2 wird erstellt. Seite geöffnet lassen.', 'working');

    try {
      await uploadRaw(selected, 8, 86);
      await uploadAnalysis(selected, 86, 100);
      setProgress(100, 'Test 2 ist bereit', 'Prüfansicht wird geöffnet …');
      setStatus('Test 2 wurde mit Rohchat und KI-Vorschlägen aktiviert. Weiterleitung …', 'ok');
      setTimeout(() => location.replace('/review.html'), 900);
    } catch (caught) {
      const details = caught?.details;
      const countSuffix = details?.expectedMessages
        ? ` Empfangen: ${details.receivedMessages ?? '?'} von ${details.expectedMessages} Ereignissen.`
        : '';
      setStatus(`${caught?.message || 'Test 2 konnte nicht gestartet werden.'}${countSuffix}`, 'error');
      progressLabel.textContent = 'Test 2 unterbrochen';
      progressDetail.textContent = 'Beide Dateien bleiben ausgewählt. Nach Behebung kann der Upload erneut gestartet werden.';
      submit.disabled = false;
      rawInput.disabled = false;
      preselectionInput.disabled = false;
      if (skip) skip.disabled = false;
    }
  });

  currentUser().catch(() => location.replace('/login.html'));
})();
