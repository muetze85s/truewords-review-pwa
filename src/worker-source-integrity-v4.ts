import baseWorker from './worker-situation-quiz';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

type Owner = 'Philipp' | 'Lena';

const TEST4_DATASET_ID = 'philena-2026-pilot-v4-unseen';
const TEST4_VERSION_ID = 'pilot-v4-unseen-fullsource-owners';
const TEST4_STORAGE_SHA256 = '116606d56c7815fb7e68fa58a71e7ee23875f43a3eb1c618e39028d464644f43';
const ORIGINAL_SOURCE_SHA256 = '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822';
const ORIGINAL_SOURCE_EVENTS = 73_946;
const REVIEW_EVENTS = 2_494;
const TEST4_EVENTS = 335;
const TEST3_LAST_EVENT_ID = 96295;

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

function validTest4Filter(value: unknown): boolean {
  const filter = objectValue(value);
  const source = objectValue(filter?.source);
  const selection = objectValue(filter?.selection);
  const eventIds = Array.isArray(selection?.eventIds) ? selection.eventIds.map(String) : [];
  const numericIds = eventIds.map(Number);
  return (
    filter?.schemaVersion === 'truewords-test-filter/v1'
    && lowerHash(source?.sourceSha256) === ORIGINAL_SOURCE_SHA256
    && Number(source?.sourceEvents) === ORIGINAL_SOURCE_EVENTS
    && selection?.strategy === 'next-unseen-window-after-test3'
    && Number(selection?.previousTestEndId) === TEST3_LAST_EVENT_ID
    && Number(selection?.eventCount) === TEST4_EVENTS
    && eventIds.length === TEST4_EVENTS
    && new Set(eventIds).size === TEST4_EVENTS
    && numericIds.every((id) => Number.isInteger(id) && id > TEST3_LAST_EVENT_ID)
    && numericIds.every((id, index) => index === 0 || id > numericIds[index - 1])
    && String(selection?.firstEventId) === eventIds[0]
    && String(selection?.lastEventId) === eventIds.at(-1)
  );
}

function validHalfSplitOwners(annotations: Record<string, unknown>): boolean {
  const situations = Array.isArray(annotations.situations) ? annotations.situations : [];
  const assignment = objectValue(annotations.ownerAssignment);
  const owners = objectValue(assignment?.owners);
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
  if (!ids.length || ids.length !== situations.length || new Set(ids).size !== ids.length) return false;
  if (Object.keys(owners).length !== ids.length) return false;
  const split = Math.ceil(ids.length / 2);
  return ids.every((id, index) => {
    const expected: Owner = index < split ? 'Philipp' : 'Lena';
    return owners[String(id)] === expected;
  });
}

async function validateTest4Source(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/import/start' || request.method !== 'POST') return null;
  let body: Record<string, unknown>;
  try {
    body = await request.clone().json<Record<string, unknown>>();
  } catch {
    return null;
  }
  if (body.datasetId !== TEST4_DATASET_ID) return null;

  const chatMeta = objectValue(body.chatMeta);
  const integrity = objectValue(chatMeta?.sourceIntegrity);
  const valid = (
    lowerHash(body.datasetHash) === TEST4_STORAGE_SHA256
    && Number(body.expectedMessages) === REVIEW_EVENTS
    && lowerHash(integrity?.sourceSha256) === ORIGINAL_SOURCE_SHA256
    && Number(integrity?.sourceEvents) === ORIGINAL_SOURCE_EVENTS
    && Number(integrity?.reviewEvents) === REVIEW_EVENTS
    && Number(integrity?.silentLosses) === 0
    && validTest4Filter(chatMeta?.test4)
  );
  return valid ? null : json({
    ok: false,
    error: 'Falscher oder unvollständiger Rohchat für Test 4.',
    details: {
      expectedDatasetId: TEST4_DATASET_ID,
      expectedMessages: REVIEW_EVENTS,
      expectedSourceEvents: ORIGINAL_SOURCE_EVENTS,
      test3LastEventId: TEST3_LAST_EVENT_ID,
      test4Events: TEST4_EVENTS,
    },
  }, 409);
}

async function validateTest4Preselection(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/analysis-versions/import' || request.method !== 'POST') return null;
  let body: Record<string, unknown>;
  try {
    body = await request.clone().json<Record<string, unknown>>();
  } catch {
    return null;
  }
  if (body.datasetId !== TEST4_DATASET_ID) return null;

  const annotations = objectValue(body.annotations);
  const preselection = objectValue(annotations?.preselection);
  const rules = objectValue(preselection?.rules);
  const integrity = objectValue(preselection?.integrity);
  const situations = Array.isArray(annotations?.situations) ? annotations.situations : [];
  const assignments = objectValue(annotations?.assignments);

  const valid = (
    body.versionId === TEST4_VERSION_ID
    && body.source === 'truewords-segmentation-v4-unseen'
    && annotations?.schemaVersion === 'truewords-manual-segmentation/v4-unseen'
    && lowerHash(annotations?.datasetHash) === ORIGINAL_SOURCE_SHA256
    && situations.length > 0
    && situations.length <= TEST4_EVENTS
    && Object.keys(assignments || {}).length === TEST4_EVENTS
    && validHalfSplitOwners(annotations || {})
    && validTest4Filter(annotations?.testFilter)
    && preselection?.source === 'truewords-segmentation-v4-unseen'
    && preselection?.segmentationEngine === 'TrueWords Segmentation V4'
    && preselection?.boundarySource === 'local-deterministic-algorithm'
    && preselection?.externalLlmBoundaryGeneration === false
    && preselection?.ruleModel === 'conversation-continuity-v1'
    && rules?.timeGapAloneCreatesBoundary === false
    && rules?.directReplyKeepsConversationOpen === true
    && rules?.openQuestionCanSurviveLongPause === true
    && rules?.laterReferenceDoesNotReopenEarlierSituationAcrossInterveningSituation === true
    && Number(integrity?.silentLosses) === 0
    && Number(integrity?.selectedEvents) === TEST4_EVENTS
    && Number(integrity?.assignments) === TEST4_EVENTS
    && integrity?.allSelectedEventsAssignedOrExcluded === true
    && integrity?.fullOriginalRequired === true
  );

  return valid ? null : json({
    ok: false,
    error: 'Ungültige V4-Segmentierung für Test 4.',
    details: {
      expectedSource: 'truewords-segmentation-v4-unseen',
      expectedRuleModel: 'conversation-continuity-v1',
      timeGapAloneCreatesBoundary: false,
      expectedAssignments: TEST4_EVENTS,
    },
  }, 409);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sourceBlocked = await validateTest4Source(request);
    if (sourceBlocked) return sourceBlocked;
    const preselectionBlocked = await validateTest4Preselection(request);
    if (preselectionBlocked) return preselectionBlocked;
    return baseWorker.fetch(request, env);
  },
};
