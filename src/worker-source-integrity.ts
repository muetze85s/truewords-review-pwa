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
const PILOT_V2_DATASET_ID = 'philena-2026-pilot-v2';
const PILOT_V3_DATASET_ID = 'philena-2026-pilot-v3-unseen';
const ORIGINAL_SOURCE_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
const LOSSLESS_2026_FILE_SHA256 = '0501361af7e9fec8ba7ba24da45256db98479cfb600d1de30ece64c5ef057b44';
const V2_PRESELECTION_FILE_SHA256 = '0c4409bcf000157d038e8cefc66b022409189579c47669ad98444852d1e9c24e';
const V3_PRESELECTION_FILE_SHA256 = '14cb353ab24bf6bf7129452e18da375dd90481832bdb1e21eafaefba845f58d5';
const ORIGINAL_SOURCE_EVENTS = 73_946;
const REVIEW_YEAR_EVENTS = 2_494;
const V2_PRESELECTION_SITUATIONS = 28;
const V2_PRESELECTION_ASSIGNMENTS = 335;
const V3_TEST_EVENTS = 335;
const V3_PRESELECTION_SITUATIONS = 12;
const V3_PRESELECTION_ASSIGNMENTS = 335;
const V3_FIRST_EVENT_ID = '95911';
const V3_LAST_EVENT_ID = '96295';

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

function lowerHash(value: unknown): string {
  return String(value || '').toLocaleLowerCase('en-US');
}

function acceptedV2RawFileHash(value: unknown): boolean {
  const hash = lowerHash(value);
  return hash === ORIGINAL_SOURCE_SHA256 || hash === LOSSLESS_2026_FILE_SHA256;
}

function validHalfSplitOwners(annotations: Record<string, unknown>): boolean {
  const situations = Array.isArray(annotations.situations) ? annotations.situations : [];
  const assignment = objectValue(annotations.ownerAssignment);
  const owners = objectValue(assignment?.owners);
  const duplicateOwners = objectValue(annotations.owners);
  if (
    assignment?.schemaVersion !== 'truewords-owner-assignment/v1'
    || assignment?.strategy !== 'chronological-half-split'
    || assignment?.oddSituationOwner !== 'Philipp'
    || !owners
  ) return false;

  const ids = situations
    .map((item) => Number(objectValue(item)?.id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((left, right) => left - right);
  if (ids.length !== situations.length || new Set(ids).size !== ids.length) return false;
  if (Object.keys(owners).length !== ids.length) return false;
  const split = Math.ceil(ids.length / 2);
  return ids.every((id, index) => {
    const expected = index < split ? 'Philipp' : 'Lena';
    return owners[String(id)] === expected
      && (!duplicateOwners || duplicateOwners[String(id)] === expected);
  });
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
      error: 'Test 1 ist wegen verlustbehafteter Bereinigung gesperrt.',
      details: {
        pilotStatus: 'ABORTED_LOSSY_PREPROCESSING',
        allowedDatasetIds: [PILOT_V2_DATASET_ID, PILOT_V3_DATASET_ID],
      },
    }, 409);
  }

  if (body.datasetId === PILOT_V2_DATASET_ID) return validateV2Source(body);
  if (body.datasetId === PILOT_V3_DATASET_ID) return validateV3Source(body);
  return null;
}

function validateV2Source(body: {
  datasetHash?: unknown;
  expectedMessages?: unknown;
  chatMeta?: unknown;
}): Response | null {
  const chatMeta = objectValue(body.chatMeta);
  const integrity = objectValue(chatMeta?.sourceIntegrity);
  const valid = (
    lowerHash(body.datasetHash) === ORIGINAL_SOURCE_SHA256
    && Number(body.expectedMessages) === REVIEW_YEAR_EVENTS
    && Number(integrity?.sourceEntries) === ORIGINAL_SOURCE_EVENTS
    && Number(integrity?.uploadedEvents) === REVIEW_YEAR_EVENTS
    && Number(integrity?.preservedEntries) === REVIEW_YEAR_EVENTS
    && Number(integrity?.silentLosses) === 0
    && lowerHash(integrity?.sourceSha256) === ORIGINAL_SOURCE_SHA256
    && acceptedV2RawFileHash(integrity?.sourceFileHash)
  );
  return valid ? null : json({
    ok: false,
    error: 'Falscher oder unvollständiger Rohchat für Test 2.',
    details: {
      expectedMessages: REVIEW_YEAR_EVENTS,
      receivedMessages: Number(body.expectedMessages) || null,
    },
  }, 409);
}

function validateV3Source(body: {
  datasetHash?: unknown;
  expectedMessages?: unknown;
  chatMeta?: unknown;
}): Response | null {
  const chatMeta = objectValue(body.chatMeta);
  const integrity = objectValue(chatMeta?.sourceIntegrity);
  const testFilter = objectValue(chatMeta?.testFilter);
  const filterSource = objectValue(testFilter?.source);
  const selection = objectValue(testFilter?.selection);
  const eventIds = Array.isArray(selection?.eventIds) ? selection.eventIds.map(String) : [];
  const messages = Number(body.expectedMessages);

  const valid = (
    lowerHash(body.datasetHash) === ORIGINAL_SOURCE_SHA256
    && messages === REVIEW_YEAR_EVENTS
    && Number(integrity?.sourceEntries) === ORIGINAL_SOURCE_EVENTS
    && Number(integrity?.uploadedEvents) === REVIEW_YEAR_EVENTS
    && Number(integrity?.preservedEntries) === REVIEW_YEAR_EVENTS
    && Number(integrity?.silentLosses) === 0
    && lowerHash(integrity?.sourceSha256) === ORIGINAL_SOURCE_SHA256
    && lowerHash(integrity?.sourceFileHash) === ORIGINAL_SOURCE_SHA256
    && integrity?.fullOriginalVerified === true
    && testFilter?.schemaVersion === 'truewords-test-filter/v1'
    && lowerHash(filterSource?.sourceSha256) === ORIGINAL_SOURCE_SHA256
    && Number(filterSource?.sourceEvents) === ORIGINAL_SOURCE_EVENTS
    && selection?.mode === 'exact_event_ids'
    && Number(selection?.eventCount) === V3_TEST_EVENTS
    && String(selection?.firstEventId) === V3_FIRST_EVENT_ID
    && String(selection?.lastEventId) === V3_LAST_EVENT_ID
    && eventIds.length === V3_TEST_EVENTS
    && new Set(eventIds).size === V3_TEST_EVENTS
    && eventIds[0] === V3_FIRST_EVENT_ID
    && eventIds.at(-1) === V3_LAST_EVENT_ID
  );
  if (valid) return null;

  return json({
    ok: false,
    error: 'Falscher oder unvollständiger Rohchat für Test 3. Erforderlich ist der vollständige Telegram-Originalexport; der Prüfserver speichert daraus den vollständigen verlustfreien 2026-Ereignisstrom.',
    details: {
      sourceIntegrity: 'FAIL',
      expectedMessages: REVIEW_YEAR_EVENTS,
      receivedMessages: Number.isFinite(messages) ? messages : null,
      expectedSourceEvents: ORIGINAL_SOURCE_EVENTS,
      receivedSourceEvents: Number(integrity?.sourceEntries) || null,
      expectedSourceFileSha256: ORIGINAL_SOURCE_SHA256,
      receivedSourceFileSha256: lowerHash(integrity?.sourceFileHash) || null,
      expectedFilterEvents: V3_TEST_EVENTS,
      receivedFilterEvents: eventIds.length,
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

  if (body.datasetId === PILOT_V2_DATASET_ID) return validateV2Preselection(body);
  if (body.datasetId === PILOT_V3_DATASET_ID) return validateV3Preselection(body);
  return null;
}

function validateV2Preselection(body: {
  versionId?: unknown;
  source?: unknown;
  parameters?: unknown;
  annotations?: unknown;
}): Response | null {
  const parameters = objectValue(body.parameters);
  const annotations = objectValue(body.annotations);
  const situations = Array.isArray(annotations?.situations) ? annotations.situations : [];
  const assignments = objectValue(annotations?.assignments);
  const preselection = objectValue(annotations?.preselection);
  const integrity = objectValue(preselection?.integrity);
  const valid = (
    body.versionId === 'pilot-v2-lossless-userfile'
    && body.source === 'chatgpt-ai-preselection-v2-lossless-upload'
    && lowerHash(parameters?.sourceFileHash) === V2_PRESELECTION_FILE_SHA256
    && lowerHash(annotations?.datasetHash) === ORIGINAL_SOURCE_SHA256
    && situations.length === V2_PRESELECTION_SITUATIONS
    && Object.keys(assignments || {}).length === V2_PRESELECTION_ASSIGNMENTS
    && Number(integrity?.silentLosses) === 0
    && integrity?.allPilotEventsAssigned === true
  );
  return valid ? null : json({
    ok: false,
    error: 'Falsche oder unvollständige KI-Vorselektionsdatei für Test 2.',
  }, 409);
}

function validateV3Preselection(body: {
  versionId?: unknown;
  source?: unknown;
  parameters?: unknown;
  annotations?: unknown;
}): Response | null {
  const parameters = objectValue(body.parameters);
  const annotations = objectValue(body.annotations);
  const situations = Array.isArray(annotations?.situations) ? annotations.situations : [];
  const assignments = objectValue(annotations?.assignments);
  const overrides = objectValue(annotations?.messageOverrides);
  const preselection = objectValue(annotations?.preselection);
  const integrity = objectValue(preselection?.integrity);
  const testFilter = objectValue(annotations?.testFilter);
  const filterSource = objectValue(testFilter?.source);
  const selection = objectValue(testFilter?.selection);
  const eventIds = Array.isArray(selection?.eventIds) ? selection.eventIds.map(String) : [];
  const accounted = new Set([
    ...Object.keys(assignments || {}).map(String),
    ...Object.keys(overrides || {}).map(String),
  ]);

  const valid = (
    body.versionId === 'pilot-v3-unseen-fullsource-owners'
    && body.source === 'chatgpt-ai-preselection-v3-unseen-fullsource'
    && lowerHash(parameters?.sourceFileHash) === V3_PRESELECTION_FILE_SHA256
    && annotations?.schemaVersion === 'truewords-manual-segmentation/v3-unseen'
    && lowerHash(annotations?.datasetHash) === ORIGINAL_SOURCE_SHA256
    && situations.length === V3_PRESELECTION_SITUATIONS
    && Object.keys(assignments || {}).length === V3_PRESELECTION_ASSIGNMENTS
    && validHalfSplitOwners(annotations || {})
    && testFilter?.schemaVersion === 'truewords-test-filter/v1'
    && lowerHash(filterSource?.sourceSha256) === ORIGINAL_SOURCE_SHA256
    && Number(filterSource?.sourceEvents) === ORIGINAL_SOURCE_EVENTS
    && selection?.mode === 'exact_event_ids'
    && Number(selection?.eventCount) === V3_TEST_EVENTS
    && eventIds.length === V3_TEST_EVENTS
    && new Set(eventIds).size === V3_TEST_EVENTS
    && eventIds[0] === V3_FIRST_EVENT_ID
    && eventIds.at(-1) === V3_LAST_EVENT_ID
    && accounted.size === V3_TEST_EVENTS
    && eventIds.every((id) => accounted.has(id))
    && Number(integrity?.silentLosses) === 0
    && integrity?.allSelectedEventsAssignedOrExcluded === true
    && integrity?.fullOriginalRequired === true
  );
  if (valid) return null;

  return json({
    ok: false,
    error: 'Falsche oder unvollständige KI-Vorselektionsdatei für Test 3. Testfilter und Prüfaufteilung müssen integriert sein.',
    details: {
      preselectionIntegrity: 'FAIL',
      expectedFileSha256: V3_PRESELECTION_FILE_SHA256,
      receivedFileSha256: lowerHash(parameters?.sourceFileHash) || null,
      expectedSituations: V3_PRESELECTION_SITUATIONS,
      receivedSituations: situations.length,
      expectedAssignments: V3_PRESELECTION_ASSIGNMENTS,
      receivedAssignments: Object.keys(assignments || {}).length,
      ownerAssignmentValid: validHalfSplitOwners(annotations || {}),
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
