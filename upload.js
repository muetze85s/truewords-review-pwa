import { createTest4Preselection } from './segmentation-v4.mjs';

const MAX_CHUNK_BYTES = 260_000;
const ORIGINAL_SOURCE_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
const TEST4_STORAGE_SHA256 = '116606d56c7815fb7e68fa58a71e7ee23875f43a3eb1c618e39028d464644f43';
const ORIGINAL_SOURCE_EVENTS = 73_946;
const REVIEW_EVENTS = 2_494;
const FILTER_EVENTS = 335;
const DATASET_ID = 'philena-2026-pilot-v4-unseen';
const DATASET_NAME = 'Philipp & Lena · Test 4 · V4 ungesehener Ereignisstrom';
const VERSION_ID = 'pilot-v4-unseen-fullsource-owners';

const form = document.getElementById('upload-form');
const rawInput = document.getElementById('raw-file');
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
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store' });
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
      await wait(attempt * 900);
    }
  }
  throw lastError || new Error('Server nicht erreichbar.');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Der Telegram-Originalexport ist keine gültige JSON-Datei.');
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
    schemaVersion: 'truewords-lossless-chat/v4-full-source',
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

function validateTest4(annotations, reviewIds) {
  if (annotations?.schemaVersion !== 'truewords-manual-segmentation/v4-unseen') {
    throw new Error('V4 hat kein gültiges Test-4-Format erzeugt.');
  }
  if (annotations?.preselection?.source !== 'truewords-segmentation-v4-unseen') {
    throw new Error('V4-Provenienz fehlt.');
  }
  if (annotations?.preselection?.externalLlmBoundaryGeneration !== false) {
    throw new Error('Test 4 darf keine externe Sprach-KI für Grenzen verwenden.');
  }
  if (annotations?.preselection?.rules?.timeGapAloneCreatesBoundary !== false) {
    throw new Error('V4-Regel verletzt: Zeitabstand darf keine alleinige Grenze erzeugen.');
  }
  const eventIds = annotations?.testFilter?.selection?.eventIds;
  if (!Array.isArray(eventIds) || eventIds.length !== FILTER_EVENTS) {
    throw new Error(`Test 4 muss exakt ${FILTER_EVENTS} neue Ereignisse enthalten.`);
  }
  const unique = new Set(eventIds.map(String));
  if (unique.size !== FILTER_EVENTS) throw new Error('Test 4 enthält doppelte Ereignis-IDs.');
  for (const id of unique) if (!reviewIds.has(id)) throw new Error(`Test-4-Ereignis ${id} fehlt im vollständigen Prüfstrom.`);
  if (String(annotations.testFilter.selection.previousTestEndId) !== '96295') {
    throw new Error('Test 4 beginnt nicht nach dem eingefrorenen Test-3-Bereich.');
  }
  if (Object.keys(annotations.assignments || {}).length !== FILTER_EVENTS) {
    throw new Error('Nicht alle Test-4-Ereignisse sind einer Situation zugeordnet.');
  }
  if (!Array.isArray(annotations.situations) || !annotations.situations.length) {
    throw new Error('V4 hat keine Situationen erzeugt.');
  }
  return annotations;
}

function chunksFor(messages) {
  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = [];
  let bytes = 2;
  for (const message of messages) {
    const encodedBytes = encoder.encode(JSON.stringify(message)).byteLength + (chunk.length ? 1 : 0);
    if (chunk.length && bytes + encodedBytes > MAX_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(message);
    bytes += encodedBytes;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

async function inspectFile() {
  selected = null;
  submit.disabled = true;
  const rawFile = rawInput.files?.[0];
  if (!rawFile) {
    detectedFiles.textContent = 'Noch keine Datei ausgewählt.';
    detectedFiles.dataset.state = 'idle';
    setStatus('Vollständigen Telegram-Originalexport auswählen.');
    return;
  }

  detectedFiles.textContent = 'Originalquelle und V4-Testfenster werden geprüft …';
  detectedFiles.dataset.state = 'working';
  setStatus('Datei wird lokal gelesen. Es wird nichts hochgeladen, bevor die Integritätsprüfung abgeschlossen ist.', 'working');
  setProgress(2, 'Originalquelle wird geprüft …', `${rawFile.name} · ${formatBytes(rawFile.size)}`);

  try {
    const pilot = window.TRUEWORDS_PILOT_V2;
    if (!pilot) throw new Error('Verlustfreie Aufbereitungslogik wurde nicht geladen. Seite neu laden.');
    const rawText = await rawFile.text();
    setProgress(4, 'SHA-256 wird berechnet …', 'Vollständiger Originalexport');
    const rawFileHash = await sha256Hex(rawText);
    if (rawFileHash !== ORIGINAL_SOURCE_SHA256) {
      throw new Error('Falscher Rohchat: Erforderlich ist der vollständige unveränderte Telegram-Originalexport mit 73.946 Ereignissen.');
    }
    const original = parseJson(rawText);
    const chat = losslessChatFromOriginal(original, pilot, rawFile.name);
    const reviewIds = new Set(chat.messages.map((message) => String(message?.id ?? '')));
    if (reviewIds.size !== REVIEW_EVENTS) throw new Error('Der 2026-Prüfstrom enthält fehlende oder doppelte IDs.');

    setProgress(7, 'TrueWords V4 segmentiert Test 4 …', 'Zeitabstände werden niemals allein als Grenze verwendet');
    const annotations = validateTest4(
      createTest4Preselection(chat.messages, { sourceSha256: ORIGINAL_SOURCE_SHA256 }),
      reviewIds,
    );
    const split = annotations.ownerAssignment.splitIndex;
    const lenaCount = annotations.situations.length - split;

    selected = { rawFile, rawFileHash, chat, annotations };
    detectedFiles.innerHTML = `
      <div><strong>Originalquelle:</strong> ${escapeHtml(rawFile.name)} · ${ORIGINAL_SOURCE_EVENTS.toLocaleString('de-DE')} Ereignisse · SHA-256 bestätigt</div>
      <div><strong>Verlustfreier Prüfstrom 2026:</strong> ${REVIEW_EVENTS.toLocaleString('de-DE')} Ereignisse · stille Verluste: 0</div>
      <div><strong>Test 4:</strong> ${FILTER_EVENTS} neue Ereignisse · IDs ${escapeHtml(annotations.testFilter.selection.firstEventId)}–${escapeHtml(annotations.testFilter.selection.lastEventId)}</div>
      <div><strong>TrueWords V4:</strong> ${annotations.situations.length} Situationsvorschläge · ${Object.keys(annotations.assignments).length} Zuordnungen</div>
      <div><strong>Prüfaufteilung:</strong> Philipp ${split} · Lena ${lenaCount}</div>`;
    detectedFiles.dataset.state = 'ok';
    submit.disabled = false;
    setProgress(10, 'Test 4 ist lokal vorbereitet', `${annotations.situations.length} Situationen · ${FILTER_EVENTS} Ereignisse`);
    setStatus('Integritätsprüfung bestanden. Test 4 kann jetzt als eigener Prüfstand aktiviert werden.', 'ok');
  } catch (caught) {
    selected = null;
    detectedFiles.textContent = caught?.message || 'Dateiprüfung fehlgeschlagen.';
    detectedFiles.dataset.state = 'error';
    setStatus(caught?.message || 'Dateiprüfung fehlgeschlagen.', 'error');
    progressLabel.textContent = 'Vorbereitung abgebrochen';
    progressDetail.textContent = 'Es wurden keine Daten verändert.';
  }
}

async function uploadSelected() {
  if (!selected) throw new Error('Originalexport zuerst vollständig prüfen.');
  const { chat, annotations } = selected;
  const chunks = chunksFor(chat.messages);

  setProgress(14, 'Eigener Test-4-Datensatz wird angelegt …', `${chunks.length} Datenblöcke`);
  const started = await apiPost('/api/admin/import/start', {
    datasetId: DATASET_ID,
    name: DATASET_NAME,
    year: 2026,
    datasetHash: TEST4_STORAGE_SHA256,
    chatMeta: {
      ...chat,
      messages: undefined,
      sourceIntegrity: {
        sourceSha256: ORIGINAL_SOURCE_SHA256,
        sourceEvents: ORIGINAL_SOURCE_EVENTS,
        reviewEvents: REVIEW_EVENTS,
        silentLosses: 0,
      },
      test4: annotations.testFilter,
    },
    expectedChunks: chunks.length,
    expectedMessages: chat.messages.length,
  });

  for (let index = 0; index < chunks.length; index += 1) {
    await apiPost('/api/admin/import/chunk', {
      datasetId: DATASET_ID,
      uploadId: started.uploadId,
      chunkIndex: index,
      messages: chunks[index],
    });
    const fraction = (index + 1) / chunks.length;
    setProgress(18 + fraction * 58, 'Verlustfreier Prüfstrom wird gespeichert …', `Block ${index + 1} von ${chunks.length}`);
  }

  setProgress(80, 'Rohchat-Import wird abgeschlossen …', 'Test 3 bleibt gespeichert und wird nicht überschrieben');
  await apiPost('/api/admin/import/finish', { datasetId: DATASET_ID, uploadId: started.uploadId });

  setProgress(86, 'V4-Vorschläge werden aktiviert …', `${annotations.situations.length} Situationen`);
  const result = await apiPost('/api/admin/analysis-versions/import', {
    datasetId: DATASET_ID,
    versionId: VERSION_ID,
    label: `TrueWords-Segmentierungsalgorithmus V4 · ${annotations.situations.length} Situationen · Test 4`,
    source: 'truewords-segmentation-v4-unseen',
    parameters: {
      segmentationEngine: 'TrueWords Segmentation V4',
      boundarySource: 'local-deterministic-algorithm',
      externalLlmBoundaryGeneration: false,
      ruleModel: 'conversation-continuity-v1',
      timeGapAloneCreatesBoundary: false,
      testFilter: annotations.testFilter,
    },
    annotations,
  });

  setProgress(100, 'Test 4 aktiviert', `${result.situations} Situationen · Philipp ${result.split.Philipp} · Lena ${result.split.Lena}`);
  setStatus('Test 4 ist aktiv. Vor der Prüfung wird die aktualisierte Situationsdefinition geöffnet.', 'ok');
}

async function currentUser() {
  const result = await fetchJson('/api/auth/me');
  if (!result.user?.canUpload) {
    location.replace('/review.html');
    return null;
  }
  document.getElementById('account-email').textContent = result.user.email || result.user.role || 'Philipp';
  return result.user;
}

rawInput.addEventListener('change', () => inspectFile());
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submit.disabled = true;
  try {
    await uploadSelected();
    await wait(650);
    location.href = '/situation-info.html';
  } catch (caught) {
    setStatus(caught?.message || 'Test 4 konnte nicht aktiviert werden.', 'error');
    progressLabel.textContent = 'Aktivierung fehlgeschlagen';
    progressDetail.textContent = 'Test 3 wurde nicht verändert.';
    submit.disabled = !selected;
  }
});
skip.addEventListener('click', () => { location.href = '/situation-info.html'; });
logout.addEventListener('click', async () => {
  try { await fetchJson('/api/auth/logout', { method: 'POST' }); } catch {}
  location.replace('/login.html');
});

currentUser().catch(() => location.replace('/login.html'));
