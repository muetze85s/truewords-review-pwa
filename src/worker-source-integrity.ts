import reviewWorker from './worker-review';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

const ABORTED_DATASET_ID = 'philena-2026';
const PILOT_DATASET_ID = 'philena-2026-pilot-v2';
const ORIGINAL_SOURCE_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
const LOSSLESS_2026_FILE_SHA256 = '0501361af7e9fec8ba7ba24da45256db98479cfb600d1de30ece64c5ef057b44';
const PRESELECTION_FILE_SHA256 = '0c4409bcf000157d038e8cefc66b022409189579c47669ad98444852d1e9c24e';
const ORIGINAL_SOURCE_EVENTS = 73_946;
const REVIEW_EVENTS = 2_494;
const PRESELECTION_SITUATIONS = 28;
const PRESELECTION_ASSIGNMENTS = 335;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function acceptedRawFileHash(value: unknown): boolean {
  const hash = String(value || '').toLocaleLowerCase('en-US');
  return hash === ORIGINAL_SOURCE_SHA256 || hash === LOSSLESS_2026_FILE_SHA256;
}

async function validatePilotSource(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/import/start' || request.method !== 'POST') return null;

  let body: {
    datasetId?: unknown;
    datasetHash?: unknown;
    expectedMessages?: unknown;
    chatMeta?: unknown;
  };
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }

  if (body.datasetId === ABORTED_DATASET_ID) {
    return json({
      ok: false,
      error: 'Test 1 ist wegen verlustbehafteter Bereinigung gesperrt. Verwende ausschließlich den neuen Test-2-Datensatz.',
      details: {
        pilotStatus: 'ABORTED_LOSSY_PREPROCESSING',
        requiredDatasetId: PILOT_DATASET_ID,
      },
    }, 409);
  }

  if (body.datasetId !== PILOT_DATASET_ID) return null;

  const chatMeta = objectValue(body.chatMeta);
  const sourceIntegrity = objectValue(chatMeta?.sourceIntegrity);
  const hash = String(body.datasetHash || '').toLocaleLowerCase('en-US');
  const messages = Number(body.expectedMessages);
  const sourceEntries = Number(sourceIntegrity?.sourceEntries);
  const uploadedEvents = Number(sourceIntegrity?.uploadedEvents);
  const preservedEntries = Number(sourceIntegrity?.preservedEntries);
  const silentLosses = Number(sourceIntegrity?.silentLosses);
  const sourceSha256 = String(sourceIntegrity?.sourceSha256 || '').toLocaleLowerCase('en-US');
  const sourceFileHash = String(sourceIntegrity?.sourceFileHash || '').toLocaleLowerCase('en-US');

  const valid = (
    hash === ORIGINAL_SOURCE_SHA256
    && messages === REVIEW_EVENTS
    && sourceEntries === ORIGINAL_SOURCE_EVENTS
    && uploadedEvents === REVIEW_EVENTS
    && preservedEntries === REVIEW_EVENTS
    && silentLosses === 0
    && sourceSha256 === ORIGINAL_SOURCE_SHA256
    && acceptedRawFileHash(sourceFileHash)
  );
  if (valid) return null;

  return json({
    ok: false,
    error: 'Falscher oder unvollständiger Rohchat für Test 2. Erforderlich sind 2.494 verlustfrei erhaltene Ereignisse aus dem bekannten Telegram-Originalexport.',
    details: {
      sourceIntegrity: 'FAIL',
      expectedMessages: REVIEW_EVENTS,
      receivedMessages: Number.isFinite(messages) ? messages : null,
      expectedSourceEvents: ORIGINAL_SOURCE_EVENTS,
      receivedSourceEvents: Number.isFinite(sourceEntries) ? sourceEntries : null,
      expectedDatasetSha256: ORIGINAL_SOURCE_SHA256,
      receivedDatasetSha256: /^[a-f0-9]{64}$/iu.test(hash) ? hash : null,
      acceptedSourceFileHashes: [ORIGINAL_SOURCE_SHA256, LOSSLESS_2026_FILE_SHA256],
      receivedSourceFileHash: /^[a-f0-9]{64}$/iu.test(sourceFileHash) ? sourceFileHash : null,
      expectedSilentLosses: 0,
      receivedSilentLosses: Number.isFinite(silentLosses) ? silentLosses : null,
    },
  }, 409);
}

async function validatePilotPreselection(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/analysis-versions/import' || request.method !== 'POST') return null;

  let body: {
    datasetId?: unknown;
    versionId?: unknown;
    source?: unknown;
    parameters?: unknown;
    annotations?: unknown;
  };
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }

  if (body.datasetId !== PILOT_DATASET_ID) return null;

  const parameters = objectValue(body.parameters);
  const annotations = objectValue(body.annotations);
  const situations = Array.isArray(annotations?.situations) ? annotations.situations : [];
  const assignments = objectValue(annotations?.assignments);
  const preselection = objectValue(annotations?.preselection);
  const integrity = objectValue(preselection?.integrity);
  const sourceFileHash = String(parameters?.sourceFileHash || '').toLocaleLowerCase('en-US');
  const datasetHash = String(annotations?.datasetHash || '').toLocaleLowerCase('en-US');

  const valid = (
    body.versionId === 'pilot-v2-lossless-userfile'
    && body.source === 'chatgpt-ai-preselection-v2-lossless-upload'
    && sourceFileHash === PRESELECTION_FILE_SHA256
    && datasetHash === ORIGINAL_SOURCE_SHA256
    && situations.length === PRESELECTION_SITUATIONS
    && Object.keys(assignments || {}).length === PRESELECTION_ASSIGNMENTS
    && Number(integrity?.silentLosses) === 0
    && integrity?.allPilotEventsAssigned === true
  );
  if (valid) return null;

  return json({
    ok: false,
    error: 'Falsche oder unvollständige KI-Vorselektionsdatei für Test 2.',
    details: {
      preselectionIntegrity: 'FAIL',
      expectedFileSha256: PRESELECTION_FILE_SHA256,
      receivedFileSha256: /^[a-f0-9]{64}$/iu.test(sourceFileHash) ? sourceFileHash : null,
      expectedSituations: PRESELECTION_SITUATIONS,
      receivedSituations: situations.length,
      expectedAssignments: PRESELECTION_ASSIGNMENTS,
      receivedAssignments: Object.keys(assignments || {}).length,
      expectedDatasetSha256: ORIGINAL_SOURCE_SHA256,
      receivedDatasetSha256: /^[a-f0-9]{64}$/iu.test(datasetHash) ? datasetHash : null,
    },
  }, 409);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sourceBlocked = await validatePilotSource(request);
    if (sourceBlocked) return sourceBlocked;
    const preselectionBlocked = await validatePilotPreselection(request);
    if (preselectionBlocked) return preselectionBlocked;
    return reviewWorker.fetch(request, env);
  },
};
