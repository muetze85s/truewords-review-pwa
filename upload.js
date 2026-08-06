(() => {
  'use strict';

  const MAX_CHUNK_BYTES = 260_000;
  const ORIGINAL_SOURCE_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
  const PRESELECTION_SHA256 = '14cb353ab24bf6bf7129452e18da375dd90481832bdb1e21eafaefba845f58d5';
  const ORIGINAL_SOURCE_EVENTS = 73_946;
  const REVIEW_EVENTS = 2_494;
  const FILTER_EVENTS = 335;
  const PRESELECTION_SITUATIONS = 12;
  const PRESELECTION_ASSIGNMENTS = 335;
  const DATASET_ID = 'philena-2026-pilot-v3-unseen';

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
    const safe = Math.max(0, Math.min(100, Math.round(value)));
    progressWrap.hidden = false;
    progress.value = safe;
    progressLabel.textContent = label;
    progressPercent.textContent = `${safe} %`;
    progressDetail.textContent = detail;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
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

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
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

  function losslessChatFromOriginal(original, pilot, sourceFileName) {
    if (!Array.isArray(original?.messages) || original.messages.length !== ORIGINAL_SOURCE_EVENTS) {
      throw new Error('Der vollständige Telegram-Originalexport muss exakt 73.946 Ereignisse enthalten.');
    }
    const prepared = pilot.prepareOriginalChat(original);
    const messages = prepared.reviewEvents;
    if (messages.length !== REVIEW_EVENTS) {
      throw new Error(`Die verlustfreie Aufbereitung muss exakt ${REVIEW_EVENTS.toLocaleString('de-DE')} Ereignisse aus 2026 ergeben.`);
    }
    if (prepared.chat.truewordsTimelinePreservation.silentLosses !== 0) {
      throw new Error('Integritätsfehler: Die verlustfreie Aufbereitung hat Ereignisse verloren.');
    }
    return {
      schemaVersion: 'truewords-lossless-chat/v3-full-source',
      datasetHash: ORIGINAL_SOURCE_SHA256,
      datasetLabel: 'Philipp & Lena · vollständiger Telegram-Originalexport · Prüfjahr 2026',
      source: {
        fileName: sourceFileName,
        chatName: original.name,
        chatType: original.type,
        chatId: original.id,
        sourceEvents: ORIGINAL_SOURCE_EVENTS,
        sourceSha256: ORIGINAL_SOURCE_SHA256,
      },
      scope: {
        year: 2026,
        events: messages.length,
        firstEventId: String(messages[0]?.id ?? ''),
        lastEventId: String(messages.at(-1)?.id ?? ''),
        firstDate: messages[0]?.date,
        lastDate: messages.at(-1)?.date,
      },
      integrity: {
        silentLosses: 0,
        preservedEvents: messages.length,
        normalTextUnchanged: true,
        mediaAndServiceEventsPreserved: true,
        replyReferencesPreserved: true,
        fullOriginalVerified: true,
      },
      messages,
    };
  }

  function validateOwners(annotations, situationIds) {
    const assignment = annotations?.ownerAssignment;
    if (
      assignment?.schemaVersion !== 'truewords-owner-assignment/v1'
      || assignment?.strategy !== 'chronological-half-split'
      || !assignment.owners
      || typeof assignment.owners !== 'object'
      || Array.isArray(assignment.owners)
    ) {
      throw new Error('Die KI-Datei enthält keine gültige Prüfaufteilung.');
    }
    const sorted = [...situationIds].sort((left, right) => left - right);
    const split = Math.ceil(sorted.length / 2);
    const expected = Object.fromEntries(
      sorted.map((id, index) => [String(id), index < split ? 'Philipp' : 'Lena']),
    );
    for (const id of sorted) {
      const owner = assignment.owners[String(id)];
      if (owner !== expected[String(id)]) {
        throw new Error(`Prüfaufteilung für Situation ${id} ist ungültig.`);
      }
      if (annotations.owners?.[String(id)] && annotations.owners[String(id)] !== owner) {
        throw new Error(`Doppelte Owner-Angabe für Situation ${id} widerspricht sich.`);
      }
    }
    return expected;
  }

  function validatePreselection(annotations, reviewMessageIds) {
    if (annotations?.schemaVersion !== 'truewords-manual-segmentation/v3-unseen') {
      throw new Error('Die KI-Datei hat nicht das erwartete Test-3-Format.');
    }
    if (annotations.datasetHash !== ORIGINAL_SOURCE_SHA256) {
      throw new Error('Rohchat und KI-Datei gehören nicht zur selben Originalquelle.');
    }
    if (!Array.isArray(annotations.situations) || annotations.situations.length !== PRESELECTION_SITUATIONS) {
      throw new Error(`Die KI-Datei muss exakt ${PRESELECTION_SITUATIONS} Situationen enthalten.`);
    }
    if (!annotations.assignments || typeof annotations.assignments !== 'object' || Array.isArray(annotations.assignments)) {
      throw new Error('Die KI-Datei enthält keine gültigen Ereigniszuordnungen.');
    }

    const situationIds = annotations.situations.map((item) => Number(item?.id));
    const uniqueSituationIds = new Set(situationIds);
    if (
      uniqueSituationIds.size !== PRESELECTION_SITUATIONS
      || situationIds.some((id) => !Number.isInteger(id) || id <= 0)
    ) {
      throw new Error('Die KI-Datei enthält ungültige oder doppelte Situations-IDs.');
    }
    const owners = validateOwners(annotations, uniqueSituationIds);

    const filter = annotations.testFilter;
    const eventIds = filter?.selection?.eventIds;
    if (
      filter?.schemaVersion !== 'truewords-test-filter/v1'
      || filter?.source?.sourceSha256 !== ORIGINAL_SOURCE_SHA256
      || Number(filter?.source?.sourceEvents) !== ORIGINAL_SOURCE_EVENTS
      || !Array.isArray(eventIds)
      || eventIds.length !== FILTER_EVENTS
      || Number(filter?.selection?.eventCount) !== FILTER_EVENTS
    ) {
      throw new Error('Der integrierte Testfilter ist unvollständig oder gehört nicht zur Originalquelle.');
    }

    const filteredIds = new Set(eventIds.map(String));
    if (filteredIds.size !== FILTER_EVENTS) throw new Error('Der Testfilter enthält doppelte Ereignis-IDs.');
    for (const id of filteredIds) {
      if (!reviewMessageIds.has(id)) throw new Error(`Testereignis ${id} fehlt im vollständigen Rohchat.`);
    }

    const assignments = Object.entries(annotations.assignments);
    if (assignments.length !== PRESELECTION_ASSIGNMENTS) {
      throw new Error(`Die KI-Datei muss exakt ${PRESELECTION_ASSIGNMENTS} Ereigniszuordnungen enthalten.`);
    }
    for (const [messageId, situationId] of assignments) {
      if (!filteredIds.has(String(messageId))) throw new Error(`Ereignis ${messageId} liegt außerhalb des Testfilters.`);
      if (!uniqueSituationIds.has(Number(situationId))) throw new Error(`Ereignis ${messageId} verweist auf eine unbekannte Situation.`);
    }

    const overrides = annotations.messageOverrides && typeof annotations.messageOverrides === 'object'
      ? Object.keys(annotations.messageOverrides)
      : [];
    const accounted = new Set([...assignments.map(([id]) => String(id)), ...overrides.map(String)]);
    if (accounted.size !== FILTER_EVENTS || [...filteredIds].some((id) => !accounted.has(id))) {
      throw new Error('Nicht alle Testereignisse sind zugeordnet oder begründet ausgeschlossen.');
    }

    const integrity = annotations.preselection?.integrity;
    if (
      Number(integrity?.silentLosses) !== 0
      || integrity?.allSelectedEventsAssignedOrExcluded !== true
      || integrity?.fullOriginalRequired !== true
    ) {
      throw new Error('Die KI-Datei besteht ihre Integritätsprüfung nicht.');
    }
    return { owners, filteredIds };
  }

  async function inspectFiles() {
    selected = null;
    const rawFile = rawInput.files?.[0];
    const preselectionFile = preselectionInput.files?.[0];
    if (!rawFile && !preselectionFile) {
      detectedFiles.textContent = 'Noch keine Datei ausgewählt.';
      detectedFiles.dataset.state = 'idle';
      setStatus('Vollständigen Telegram-Rohchat und KI-Datei auswählen.');
      return;
    }
    if (!rawFile || !preselectionFile) {
      const missing = rawFile ? 'KI-Vorselektionsdatei' : 'vollständigen Telegram-Rohchat';
      detectedFiles.textContent = `Noch den ${missing} auswählen.`;
      detectedFiles.dataset.state = 'idle';
      setStatus(`Beide Dateien sind erforderlich. Es fehlt: ${missing}.`);
      return;
    }

    submit.disabled = true;
    detectedFiles.textContent = 'Originalexport, Testfilter, Vorschläge und Prüfaufteilung werden geprüft …';
    detectedFiles.dataset.state = 'working';
    setStatus('Beide Dateien werden lokal gelesen und vollständig gegeneinander geprüft …', 'working');
    setProgress(1, 'Dateien werden gelesen …', `${rawFile.name} · ${preselectionFile.name}`);

    try {
      const pilot = window.TRUEWORDS_PILOT_V2;
      if (!pilot) throw new Error('Verlustfreie Aufbereitungslogik wurde nicht geladen. Seite neu laden.');
      const [rawText, preselectionText] = await Promise.all([rawFile.text(), preselectionFile.text()]);
      setProgress(3, 'SHA-256 wird berechnet …', `${formatBytes(rawFile.size)} + ${formatBytes(preselectionFile.size)}`);
      const [rawFileHash, preselectionFileHash] = await Promise.all([
        sha256Hex(rawText),
        sha256Hex(preselectionText),
      ]);
      if (rawFileHash !== ORIGINAL_SOURCE_SHA256) {
        throw new Error('Falscher Rohchat: Erforderlich ist immer der vollständige unveränderte Telegram-Originalexport mit 73.946 Ereignissen.');
      }
      if (preselectionFileHash !== PRESELECTION_SHA256) {
        throw new Error('Falsche KI-Datei: Verwende die Test-3-Datei mit integriertem Testfilter und Prüfaufteilung.');
      }

      const original = parseJson(rawText, 'Der Telegram-Originalexport');
      const annotations = parseJson(preselectionText, 'Die KI-Vorselektionsdatei');
      const chat = losslessChatFromOriginal(original, pilot, rawFile.name);
      const messageIds = new Set(chat.messages.map((message) => String(message?.id ?? '')));
      if (messageIds.size !== REVIEW_EVENTS) throw new Error('Der 2026-Ereignisstrom enthält fehlende oder doppelte IDs.');
      const validation = validatePreselection(annotations, messageIds);

      selected = {
        rawFile,
        preselectionFile,
        rawFileHash,
        preselectionFileHash,
        datasetHash: ORIGINAL_SOURCE_SHA256,
        chat,
        annotations,
        owners: validation.owners,
      };

      detectedFiles.innerHTML = `
        <div><strong>Vollständiger Telegram-Rohchat:</strong> ${escapeHtml(rawFile.name)} · ${ORIGINAL_SOURCE_EVENTS.toLocaleString('de-DE')} Originalereignisse</div>
        <div><strong>Verlustfreier Prüfstrom:</strong> ${REVIEW_EVENTS.toLocaleString('de-DE')} Ereignisse aus 2026 · stille Verluste: 0</div>
        <div><strong>Testfilter:</strong> ${FILTER_EVENTS} Ereignisse · IDs ${escapeHtml(annotations.testFilter.selection.firstEventId)}–${escapeHtml(annotations.testFilter.selection.lastEventId)}</div>
        <div><strong>KI-Vorselektion:</strong> ${annotations.situations.length} Situationen · ${Object.keys(annotations.assignments).length} Zuordnungen</div>
        <div><strong>Prüfaufteilung:</strong> Philipp 1–6 · Lena 7–12</div>`;
      detectedFiles.dataset.state = 'ok';
      setProgress(8, 'Test 3 ist vorbereitet', 'Originalquelle, Testfilter, KI-Vorschläge und Owner stimmen überein');
      setStatus('Beide Dateien sind vollständig. Test 3 kann hochgeladen und aktiviert werden.', 'ok');
    } catch (caught) {
      selected = null;
      detectedFiles.textContent = caught?.message || 'Dateiprüfung fehlgeschlagen.';
      detectedFiles.dataset.state = 'error';
      progressLabel.textContent = 'Vorbereitung abgebrochen';
      progressDetail.textContent = 'Vollständiger Originalexport und aktuelle KI-Datei müssen exakt zusammenpassen.';
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
      const bytes = encoder.encode(JSON.stringify(message)).byteLength + (current.length ? 1 : 0);
      if (bytes > 650_000) throw new Error(`Ereignis ${index + 1} ist zu groß für den Import.`);
      if (current.length && currentBytes + bytes > MAX_CHUNK_BYTES) {
        chunks.push(current);
        current = [];
        currentBytes = 2;
      }
      current.push(message);
      currentBytes += bytes;
      if (index % 300 === 0 || index === messages.length - 1) {
        report((index + 1) / messages.length, `${index + 1} von ${messages.length} Ereignissen vorbereitet`);
      }
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  async function uploadRaw(entry, rangeStart, rangeEnd) {
    const messages = entry.chat.messages;
    const span = rangeEnd - rangeStart;
    const report = (fraction, label, detail = '') => setProgress(rangeStart + fraction * span, label, detail);
    const { messages: ignored, ...chatMeta } = entry.chat;
    void ignored;
    chatMeta.importedYearRange = '2026';
    chatMeta.reviewYear = 2026;
    chatMeta.reviewYearEvents = messages.length;
    chatMeta.sourceFileName = entry.rawFile.name;
    chatMeta.testFilter = entry.annotations.testFilter;
    chatMeta.sourceIntegrity = {
      sha256: entry.datasetHash,
      sourceSha256: ORIGINAL_SOURCE_SHA256,
      sourceFileHash: entry.rawFileHash,
      sourceEntries: ORIGINAL_SOURCE_EVENTS,
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
      datasetId: DATASET_ID,
      name: 'Philipp & Lena · Test 3 · ungesehene V3-Validierung',
      year: 2026,
      datasetHash: entry.datasetHash,
      chatMeta,
      expectedChunks: chunks.length,
      expectedMessages: messages.length,
    });
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await apiPost('/api/admin/import/chunk', {
        datasetId: DATASET_ID,
        uploadId: started.uploadId,
        chunkIndex: index,
        messages: chunks[index],
      });
      report(
        0.11 + ((index + 1) / chunks.length) * 0.84,
        'Verlustfreie Ereignisse werden übertragen …',
        `${result.receivedMessages.toLocaleString('de-DE')} von ${messages.length.toLocaleString('de-DE')} · Block ${index + 1}/${chunks.length}`,
      );
    }
    report(0.97, 'Vollständigkeit wird serverseitig geprüft …');
    const result = await apiPost('/api/admin/import/finish', {
      datasetId: DATASET_ID,
      uploadId: started.uploadId,
    });
    if (Number(result.messages) !== messages.length) throw new Error('Server hat nicht alle Ereignisse bestätigt.');
    report(1, 'Vollständiger Prüfstrom gespeichert', `${result.messages.toLocaleString('de-DE')} Ereignisse · stille Verluste: 0`);
  }

  async function uploadAnalysis(entry, rangeStart, rangeEnd) {
    const annotations = entry.annotations;
    const span = rangeEnd - rangeStart;
    setProgress(
      rangeStart + span * 0.1,
      'KI-Datei wird geprüft …',
      `${annotations.situations.length} Situationen · Philipp 6 · Lena 6`,
    );
    const result = await apiPost('/api/admin/analysis-versions/import', {
      datasetId: DATASET_ID,
      versionId: 'pilot-v3-unseen-fullsource-owners',
      label: `KI-Vorselektion V3 · ${annotations.situations.length} Situationen · Test 3`,
      source: 'chatgpt-ai-preselection-v3-unseen-fullsource',
      parameters: {
        ...(annotations.preselection || {}),
        testFilter: annotations.testFilter,
        ownerAssignment: annotations.ownerAssignment,
        sourceFileHash: entry.preselectionFileHash,
        sourceFileName: entry.preselectionFile.name,
      },
      annotations,
    });
    setProgress(
      rangeEnd,
      'Test 3 aktiviert',
      `${result.situations} Situationen · Philipp ${result.split.Philipp} · Lena ${result.split.Lena}`,
    );
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
      setStatus('Zuerst den vollständigen Telegram-Rohchat und die aktuelle KI-Datei auswählen.', 'error');
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
      setStatus('Test 3 wurde mit vollständigem Rohchat, Testfilter, KI-Vorschlägen und Prüfaufteilung aktiviert.', 'ok');
      setTimeout(() => location.replace('/review.html'), 900);
    } catch (caught) {
      const details = caught?.details;
      const suffix = details?.expectedMessages
        ? ` Empfangen: ${details.receivedMessages ?? '?'} von ${details.expectedMessages} Ereignissen.`
        : '';
      setStatus(`${caught?.message || 'Test 3 konnte nicht gestartet werden.'}${suffix}`, 'error');
      progressLabel.textContent = 'Test 3 unterbrochen';
      progressDetail.textContent = 'Beide Dateien bleiben ausgewählt. Nach Behebung kann der Upload erneut gestartet werden.';
      submit.disabled = false;
      rawInput.disabled = false;
      preselectionInput.disabled = false;
      if (skip) skip.disabled = false;
    }
  });

  currentUser().catch(() => location.replace('/login.html'));
})();
