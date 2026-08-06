(() => {
  'use strict';

  const MAX_CHUNK_BYTES = 260_000;
  const ORIGINAL_SOURCE_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
  const PRESELECTION_SHA256 = 'fce30f5883eeef31d5e5bb565fa6904a2ab3e3a56ac462bca692212a4fdc7a2c';
  const ORIGINAL_SOURCE_EVENTS = 73_946;
  const REVIEW_YEAR_EVENTS = 2_494;
  const TEST_EVENTS = 335;
  const PRESELECTION_SITUATIONS = 12;
  const PRESELECTION_ASSIGNMENTS = 335;
  const DATASET_ID = 'philena-2026-pilot-v3-unseen';
  const VERSION_ID = 'pilot-v3-unseen-fullsource-userfile';

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

  function validatePreselection(annotations) {
    if (!annotations || annotations.schemaVersion !== 'truewords-manual-segmentation/v3-unseen') {
      throw new Error('Die KI-Vorselektionsdatei hat nicht das erwartete Test-3-Format.');
    }
    if (annotations.datasetHash !== ORIGINAL_SOURCE_SHA256) {
      throw new Error('Die KI-Vorselektion gehört nicht zum vollständigen Telegram-Originalexport.');
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
      if (!situationIds.has(Number(situationId))) {
        throw new Error(`Ereignis ${messageId} verweist auf eine unbekannte Situation.`);
      }
    }

    const filter = annotations.testFilter;
    const selection = filter?.selection;
    if (filter?.schemaVersion !== 'truewords-test-filter/v1') {
      throw new Error('Der Testfilter fehlt in der KI-Vorselektionsdatei.');
    }
    if (
      filter?.source?.sourceSha256 !== ORIGINAL_SOURCE_SHA256
      || Number(filter?.source?.sourceEvents) !== ORIGINAL_SOURCE_EVENTS
    ) {
      throw new Error('Der integrierte Testfilter verweist nicht auf den vollständigen Telegram-Originalexport.');
    }
    if (selection?.mode !== 'exact_event_ids' || !Array.isArray(selection?.eventIds)) {
      throw new Error('Der integrierte Testfilter enthält keine exakte Ereignisliste.');
    }
    const eventIds = selection.eventIds.map(String);
    if (eventIds.length !== TEST_EVENTS || new Set(eventIds).size !== TEST_EVENTS) {
      throw new Error(`Der Testfilter muss exakt ${TEST_EVENTS} eindeutige Ereignisse enthalten.`);
    }
    if (
      String(selection.firstEventId) !== eventIds[0]
      || String(selection.lastEventId) !== eventIds.at(-1)
      || Number(selection.eventCount) !== TEST_EVENTS
    ) {
      throw new Error('Start, Ende und Ereigniszahl des Testfilters sind inkonsistent.');
    }

    const assignedOrExcluded = new Set([
      ...Object.keys(annotations.assignments).map(String),
      ...Object.keys(annotations.messageOverrides || {}).map(String),
    ]);
    for (const eventId of eventIds) {
      if (!assignedOrExcluded.has(eventId)) {
        throw new Error(`Testereignis ${eventId} ist weder einer Situation noch dem Kontext zugeordnet.`);
      }
    }
    if (assignedOrExcluded.size !== TEST_EVENTS) {
      throw new Error('Die KI-Datei enthält Zuordnungen außerhalb des integrierten Testfilters.');
    }

    const integrity = annotations.preselection?.integrity;
    if (
      Number(integrity?.silentLosses) !== 0
      || integrity?.allNonExcludedEventsAssigned !== true
      || integrity?.fullOriginalRequired !== true
    ) {
      throw new Error('Die KI-Vorselektion besteht ihre Integritätsprüfung nicht.');
    }

    return { eventIds, situationIds };
  }

  function filteredChatFromOriginal(original, pilot, sourceFileName, annotations) {
    if (!Array.isArray(original.messages) || original.messages.length !== ORIGINAL_SOURCE_EVENTS) {
      throw new Error(`Der Telegram-Originalexport muss exakt ${ORIGINAL_SOURCE_EVENTS.toLocaleString('de-DE')} Exportereignisse enthalten.`);
    }

    const prepared = pilot.prepareOriginalChat(original);
    const reviewEvents = prepared.reviewEvents;
    if (reviewEvents.length !== REVIEW_YEAR_EVENTS) {
      throw new Error(`Der Originalexport enthält nicht exakt ${REVIEW_YEAR_EVENTS.toLocaleString('de-DE')} Ereignisse aus 2026.`);
    }
    if (prepared.chat.truewordsTimelinePreservation.silentLosses !== 0) {
      throw new Error('Integritätsfehler: Die verlustfreie Aufbereitung hat Ereignisse verloren.');
    }

    const { eventIds } = validatePreselection(annotations);
    const selectedSet = new Set(eventIds);
    const selectedMessages = reviewEvents.filter((message) => selectedSet.has(String(message.id)));
    const selectedIds = selectedMessages.map((message) => String(message.id));

    if (selectedMessages.length !== TEST_EVENTS) {
      const found = new Set(selectedIds);
      const missing = eventIds.filter((id) => !found.has(id));
      throw new Error(`Der vollständige Rohchat enthält nicht alle Testereignisse. Fehlend: ${missing.slice(0, 5).join(', ') || 'unbekannt'}.`);
    }
    if (selectedIds.some((id, index) => id !== eventIds[index])) {
      throw new Error('Die Ereignisreihenfolge im Testfilter stimmt nicht mit dem Originalchat überein.');
    }

    return {
      schemaVersion: 'truewords-lossless-chat/v3-unseen',
      datasetHash: ORIGINAL_SOURCE_SHA256,
      datasetLabel: 'Philipp & Lena · Test 3 · ungesehener verlustfreier Ereignisstrom',
      source: {
        fileName: sourceFileName,
        chatName: original.name,
        chatType: original.type,
        chatId: original.id,
        sourceEvents: ORIGINAL_SOURCE_EVENTS,
        sourceSha256: ORIGINAL_SOURCE_SHA256,
      },
      scope: {
        purpose: 'unseen-validation',
        selectionMode: 'exact_event_ids',
        year: 2026,
        reviewYearEvents: REVIEW_YEAR_EVENTS,
        events: selectedMessages.length,
        firstEventId: selectedIds[0],
        lastEventId: selectedIds.at(-1),
        firstDate: selectedMessages[0]?.date,
        lastDate: selectedMessages.at(-1)?.date,
      },
      integrity: {
        silentLosses: 0,
        preservedEvents: selectedMessages.length,
        selectedEventsExpected: TEST_EVENTS,
        normalTextUnchanged: true,
        mediaAndServiceEventsPreserved: true,
        replyReferencesPreserved: true,
        fullOriginalVerified: true,
      },
      messages: selectedMessages,
    };
  }

  async function inspectFiles() {
    selected = null;
    const rawFile = rawInput.files?.[0];
    const preselectionFile = preselectionInput.files?.[0];

    if (!rawFile && !preselectionFile) {
      detectedFiles.textContent = 'Noch keine Datei ausgewählt.';
      detectedFiles.dataset.state = 'idle';
      setStatus('Vollständigen Rohchat und KI-Vorselektionsdatei auswählen.');
      return;
    }
    if (!rawFile || !preselectionFile) {
      const missing = rawFile ? 'KI-Vorselektionsdatei' : 'vollständigen Telegram-Originalexport';
      detectedFiles.textContent = `Noch den ${missing} auswählen.`;
      detectedFiles.dataset.state = 'idle';
      setStatus(`Beide Dateien sind erforderlich. Es fehlt: ${missing}.`);
      return;
    }

    submit.disabled = true;
    detectedFiles.textContent = 'Originalexport, KI-Vorschläge und integrierter Testfilter werden geprüft …';
    detectedFiles.dataset.state = 'working';
    setStatus('Beide Dateien werden lokal gelesen, gehasht und gegeneinander geprüft …', 'working');
    setProgress(1, 'Dateien werden gelesen …', `${rawFile.name} · ${preselectionFile.name}`);

    try {
      const pilot = window.TRUEWORDS_PILOT_V2;
      if (!pilot) throw new Error('Verlustfreie Importlogik wurde nicht geladen. Seite neu laden.');

      const [rawText, preselectionText] = await Promise.all([
        rawFile.text(),
        preselectionFile.text(),
      ]);
      setProgress(3, 'SHA-256 wird berechnet …', `${formatBytes(rawFile.size)} + ${formatBytes(preselectionFile.size)}`);
      const [rawFileHash, preselectionFileHash] = await Promise.all([
        sha256Hex(rawText),
        sha256Hex(preselectionText),
      ]);

      if (rawFileHash !== ORIGINAL_SOURCE_SHA256) {
        throw new Error('Falscher Rohchat: Für jeden Test ist immer der vollständige, unveränderte Telegram-Originalexport erforderlich.');
      }
      if (preselectionFileHash !== PRESELECTION_SHA256) {
        throw new Error('Falsche KI-Vorselektionsdatei: Verwende die Test-3-Datei mit integriertem Testfilter.');
      }

      const original = parseJson(rawText, 'Der Telegram-Originalexport');
      const annotations = parseJson(preselectionText, 'Die KI-Vorselektionsdatei');
      validatePreselection(annotations);
      const chat = filteredChatFromOriginal(original, pilot, rawFile.name, annotations);
      const messageIds = new Set(chat.messages.map((message) => String(message.id)));

      for (const messageId of Object.keys(annotations.assignments)) {
        if (!messageIds.has(String(messageId))) {
          throw new Error(`Zugeordnetes Ereignis ${messageId} fehlt im Testfenster des vollständigen Rohchats.`);
        }
      }

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
        <div><strong>Vollständiger Rohchat:</strong> ${escapeHtml(rawFile.name)} · ${ORIGINAL_SOURCE_EVENTS.toLocaleString('de-DE')} Exportereignisse</div>
        <div><strong>Integrierter Testfilter:</strong> IDs ${escapeHtml(chat.scope.firstEventId)}–${escapeHtml(chat.scope.lastEventId)} · ${TEST_EVENTS} Ereignisse</div>
        <div><strong>KI-Vorselektion:</strong> ${escapeHtml(preselectionFile.name)} · ${annotations.situations.length} Situationen · ${Object.keys(annotations.assignments).length} Zuordnungen</div>
        <div><strong>Integrität:</strong> Originalquelle bestätigt · stille Verluste: 0 · Platzhalter enthalten</div>`;
      detectedFiles.dataset.state = 'ok';
      setProgress(8, 'Test 3 ist vorbereitet', 'Vollständiger Rohchat, Testfilter und KI-Vorschläge sind lokal geprüft');
      setStatus('Beide Dateien sind vollständig. Test 3 kann hochgeladen und aktiviert werden.', 'ok');
    } catch (caught) {
      selected = null;
      detectedFiles.textContent = caught?.message || 'Dateiprüfung fehlgeschlagen.';
      detectedFiles.dataset.state = 'error';
      progressLabel.textContent = 'Vorbereitung abgebrochen';
      progressDetail.textContent = 'Vollständiger Originalexport und KI-Datei mit Testfilter müssen exakt zusammenpassen.';
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
      if (index % 100 === 0 || index === messages.length - 1) {
        report(
          (index + 1) / messages.length,
          `${(index + 1).toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} Testereignissen vorbereitet`,
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

    report(0.01, 'Testfenster wird aus dem vollständigen Rohchat vorbereitet …', `${messages.length.toLocaleString('de-DE')} Ereignisse`);
    const { messages: ignored, ...chatMeta } = chat;
    void ignored;
    chatMeta.reviewYear = 2026;
    chatMeta.reviewYearEvents = REVIEW_YEAR_EVENTS;
    chatMeta.sourceFileName = entry.rawFile.name;
    chatMeta.testFilter = entry.annotations.testFilter;
    chatMeta.sourceIntegrity = {
      sha256: entry.datasetHash,
      sourceSha256: ORIGINAL_SOURCE_SHA256,
      sourceFileHash: entry.rawFileHash,
      sourceEntries: ORIGINAL_SOURCE_EVENTS,
      reviewYearEvents: REVIEW_YEAR_EVENTS,
      uploadedEvents: messages.length,
      preservedEntries: messages.length,
      silentLosses: 0,
      fullOriginalVerified: true,
    };

    const chunks = makeChunks(messages, (fraction, detail) => {
      report(0.02 + fraction * 0.08, 'Datenblöcke werden vorbereitet …', detail);
    });

    report(0.11, 'Importsitzung für Test 3 wird angelegt …', `${chunks.length} Datenblöcke`);
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
        'Gefilterte Originalereignisse werden übertragen …',
        `${result.receivedMessages.toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} Ereignissen · Block ${index + 1}/${chunks.length}`,
      );
    }

    report(0.97, 'Vollständigkeit wird serverseitig geprüft …', 'Originalquelle, Testfilter und Ereigniszahl müssen exakt stimmen');
    const result = await apiPost('/api/admin/import/finish', {
      datasetId,
      uploadId: started.uploadId,
    });
    if (Number(result.messages) !== messages.length) throw new Error('Server hat nicht alle Testereignisse bestätigt.');
    report(1, 'Testfenster gespeichert', `${result.messages.toLocaleString('de-DE')} Ereignisse · stille Verluste: 0`);
    return result;
  }

  async function uploadAnalysis(entry, rangeStart, rangeEnd) {
    const datasetId = document.getElementById('dataset-id').value.trim();
    const annotations = entry.annotations;
    const span = rangeEnd - rangeStart;

    setProgress(
      rangeStart + span * 0.1,
      'KI-Vorselektion und Testfilter werden geprüft …',
      `${annotations.situations.length} Situationen · ${Object.keys(annotations.assignments).length} Ereignisse`,
    );
    const result = await apiPost('/api/admin/analysis-versions/import', {
      datasetId,
      versionId: VERSION_ID,
      label: `KI-Vorselektion V3 · Test 3 · ${annotations.situations.length} Situationen`,
      source: 'chatgpt-ai-preselection-v3-unseen-fullsource-upload',
      parameters: {
        ...(annotations.preselection || {}),
        testFilter: annotations.testFilter,
        sourceFileHash: entry.preselectionFileHash,
        sourceFileName: entry.preselectionFile.name,
      },
      annotations,
    });
    setProgress(
      rangeEnd,
      'Test 3 aktiviert',
      `${result.situations} Situationen · ${result.assignments} Ereigniszuordnungen`,
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
      setStatus('Zuerst den vollständigen Telegram-Originalexport und die KI-Datei mit integriertem Testfilter auswählen.', 'error');
      return;
    }

    submit.disabled = true;
    if (skip) skip.disabled = true;
    rawInput.disabled = true;
    preselectionInput.disabled = true;
    setStatus('Test 3 wird erstellt. Seite geöffnet lassen.', 'working');

    try {
      await uploadRaw(selected, 8, 86);
      await uploadAnalysis(selected, 86, 100);
      setProgress(100, 'Test 3 ist bereit', 'Prüfansicht wird geöffnet …');
      setStatus('Test 3 wurde aus dem vollständigen Rohchat und den gefilterten KI-Vorschlägen aktiviert. Weiterleitung …', 'ok');
      setTimeout(() => location.replace('/review.html'), 900);
    } catch (caught) {
      const details = caught?.details;
      const countSuffix = details?.expectedMessages
        ? ` Empfangen: ${details.receivedMessages ?? '?'} von ${details.expectedMessages} Ereignissen.`
        : '';
      setStatus(`${caught?.message || 'Test 3 konnte nicht gestartet werden.'}${countSuffix}`, 'error');
      progressLabel.textContent = 'Test 3 unterbrochen';
      progressDetail.textContent = 'Beide Dateien bleiben ausgewählt. Nach Behebung kann der Upload erneut gestartet werden.';
      submit.disabled = false;
      rawInput.disabled = false;
      preselectionInput.disabled = false;
      if (skip) skip.disabled = false;
    }
  });

  if (document.getElementById('dataset-id')) document.getElementById('dataset-id').value = DATASET_ID;
  currentUser().catch(() => location.replace('/login.html'));
})();
