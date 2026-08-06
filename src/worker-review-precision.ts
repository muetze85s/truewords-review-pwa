import baseWorker from './worker-source-integrity';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

type Role = 'Philipp' | 'Lena';
type Situation = Record<string, unknown> & { id: number };
type AnnotationPayload = Record<string, unknown> & {
  schemaVersion: string;
  situations: Situation[];
  assignments: Record<string, number>;
  events?: unknown[];
  messageOverrides?: Record<string, Record<string, unknown>>;
};
type DatasetRow = {
  id: string;
  name: string;
  dataset_hash: string;
  annotations_json: string;
  owners_json: string;
  revision: number;
};

type SessionRow = {
  role: Role;
  can_upload: number;
};

const SESSION_COOKIE = 'tw_review_session_v2';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function error(message: string, status = 400, details?: unknown): Response {
  return json({ ok: false, error: message, details }, status);
}

function cookieValue(request: Request, name: string): string {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function bearerToken(request: Request): string {
  return (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || '';
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function bearerRole(request: Request, env: Env): Promise<Role | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const provided = await sha256Hex(token);
  for (const [role, secret] of [
    ['Philipp', env.PHILIPP_REVIEW_TOKEN],
    ['Lena', env.LENA_REVIEW_TOKEN],
  ] as const) {
    if (secret && constantEqual(provided, await sha256Hex(secret))) return role;
  }
  return null;
}

async function sessionRole(request: Request, env: Env): Promise<{ role: Role; canUpload: boolean } | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/iu.test(token)) return null;
  const row = await env.DB.prepare(`
    SELECT u.role, u.can_upload
    FROM review_sessions s
    JOIN review_users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.is_active = 1
    LIMIT 1
  `).bind(await sha256Hex(token), new Date().toISOString()).first<SessionRow>();
  if (!row) return null;
  return { role: row.role, canUpload: Number(row.can_upload) === 1 };
}

async function actingReviewer(request: Request, env: Env): Promise<Role | null> {
  const session = await sessionRole(request, env);
  if (session) {
    const requested = request.headers.get('x-truewords-reviewer');
    if (requested === 'Philipp' || requested === 'Lena') {
      if (requested === session.role || session.canUpload) return requested;
      return null;
    }
    return session.role;
  }
  return bearerRole(request, env);
}

function validDatasetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{2,79}$/iu.test(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isAnnotations(value: unknown): value is AnnotationPayload {
  const payload = objectValue(value);
  return Boolean(
    payload
    && typeof payload.schemaVersion === 'string'
    && Array.isArray(payload.situations)
    && objectValue(payload.assignments),
  );
}

function parseOwners(value: string): Record<string, Role> {
  const raw = objectValue(JSON.parse(value || '{}')) || {};
  return Object.fromEntries(
    Object.entries(raw).filter(([, owner]) => owner === 'Philipp' || owner === 'Lena'),
  ) as Record<string, Role>;
}

function normalizeAnnotations(payload: AnnotationPayload, dataset: DatasetRow): AnnotationPayload {
  const situations = payload.situations
    .map((item) => ({
      ...item,
      id: Number(item.id),
      label: String(item.label || ''),
      note: String(item.note || ''),
      kind: String(item.kind || 'training'),
      status: String(item.status || 'open'),
      createdAt: String(item.createdAt || new Date().toISOString()),
    }))
    .filter((item) => Number.isInteger(item.id) && item.id > 0)
    .sort((left, right) => left.id - right.id);
  const validIds = new Set(situations.map((item) => item.id));
  const assignments = Object.fromEntries(
    Object.entries(payload.assignments)
      .map(([messageId, situationId]) => [String(messageId), Number(situationId)] as const)
      .filter(([, situationId]) => validIds.has(situationId)),
  );
  const messageOverrides = objectValue(payload.messageOverrides) || {};
  return {
    ...payload,
    schemaVersion: 'truewords-manual-segmentation/v2',
    datasetHash: dataset.dataset_hash,
    datasetLabel: dataset.name,
    situations,
    assignments,
    messageOverrides: Object.fromEntries(
      Object.entries(messageOverrides)
        .filter(([, override]) => objectValue(override))
        .map(([id, override]) => [String(id), override as Record<string, unknown>]),
    ),
    events: Array.isArray(payload.events) ? payload.events.slice(-2000) : [],
  };
}

function precisionEvents(payload: AnnotationPayload): Record<string, unknown>[] {
  return (Array.isArray(payload.events) ? payload.events : [])
    .map(objectValue)
    .filter((event): event is Record<string, unknown> => Boolean(event))
    .filter((event) => [
      'boundary_cross_owner_moved',
      'message_excluded_from_situation',
      'message_restored_to_situation',
    ].includes(String(event.type || '')));
}

function requiresPrecisionMerge(payload: AnnotationPayload): boolean {
  if (Object.keys(payload.messageOverrides || {}).length) return true;
  if (precisionEvents(payload).length) return true;
  return payload.situations.some((item) => item.truewordsNeedsCorrectedConfirmation === true);
}

function adjacentSituationIds(situations: Situation[], leftId: number, rightId: number): boolean {
  const ids = [...situations].sort((a, b) => Number(a.id) - Number(b.id)).map((item) => Number(item.id));
  const left = ids.indexOf(leftId);
  const right = ids.indexOf(rightId);
  return left >= 0 && right >= 0 && Math.abs(left - right) === 1;
}

function allowedCrossOwnerIds(
  current: AnnotationPayload,
  incoming: AnnotationPayload,
  reviewer: Role,
): Set<number> {
  const result = new Set<number>();
  for (const event of precisionEvents(incoming)) {
    if (event.type !== 'boundary_cross_owner_moved' || event.reviewer !== reviewer) continue;
    const source = Number(event.sourceSituationId || 0);
    const destination = Number(event.destinationSituationId || 0);
    const messageId = String(event.messageId || '');
    if (!source || !destination || !messageId) continue;
    if (!adjacentSituationIds(current.situations, source, destination)) continue;
    const currentSituationId = Number(current.assignments[messageId] || 0);
    const incomingSituationId = Number(incoming.assignments[messageId] || 0);
    if (![source, destination].includes(currentSituationId)) continue;
    if (![source, destination].includes(incomingSituationId)) continue;
    result.add(source);
    result.add(destination);
  }
  return result;
}

async function precisionMerge(request: Request, env: Env, reviewer: Role): Promise<Response> {
  const body = await request.json<{ datasetId?: unknown; annotations?: unknown }>();
  if (!validDatasetId(body.datasetId)) return error('Ungültige datasetId.');
  if (!isAnnotations(body.annotations)) return error('Ungültiger Prüfstand.');

  const dataset = await env.DB.prepare(`
    SELECT id, name, dataset_hash, annotations_json, owners_json, revision
    FROM review_datasets WHERE id = ?1 LIMIT 1
  `).bind(body.datasetId).first<DatasetRow>();
  if (!dataset) return error('Prüfdatenbestand nicht gefunden.', 404);

  const current = normalizeAnnotations(JSON.parse(dataset.annotations_json) as AnnotationPayload, dataset);
  const incoming = normalizeAnnotations(body.annotations, dataset);
  const owners = parseOwners(dataset.owners_json);
  const ownIds = new Set(
    Object.entries(owners)
      .filter(([, owner]) => owner === reviewer)
      .map(([id]) => Number(id)),
  );
  const crossIds = allowedCrossOwnerIds(current, incoming, reviewer);
  const editableIds = new Set<number>([...ownIds, ...crossIds]);
  const currentMap = new Map(current.situations.map((item) => [Number(item.id), item]));
  const incomingMap = new Map(incoming.situations.map((item) => [Number(item.id), item]));

  for (const [id, item] of incomingMap) {
    const itemOwner = owners[String(id)];
    if (itemOwner && itemOwner !== reviewer && !editableIds.has(id)) {
      if (JSON.stringify(item) !== JSON.stringify(currentMap.get(id))) {
        return error(`Situation ${id} gehört zum Bereich von ${itemOwner}.`, 409);
      }
    }
  }

  const newIds = [...incomingMap.keys()].filter((id) => !owners[String(id)]);
  newIds.forEach((id) => editableIds.add(id));

  const mergedSituations = current.situations.filter((item) => !editableIds.has(Number(item.id)));
  for (const [id, item] of incomingMap) {
    if (editableIds.has(id)) mergedSituations.push(item);
  }
  mergedSituations.sort((left, right) => Number(left.id) - Number(right.id));

  const mergedAssignments = { ...current.assignments };
  for (const [messageId, situationId] of Object.entries(mergedAssignments)) {
    if (editableIds.has(Number(situationId))) delete mergedAssignments[messageId];
  }
  for (const [messageId, rawSituationId] of Object.entries(incoming.assignments)) {
    const situationId = Number(rawSituationId);
    if (!editableIds.has(situationId)) continue;
    const existingId = Number(current.assignments[messageId] || 0);
    const existingOwner = owners[String(existingId)];
    if (existingOwner && existingOwner !== reviewer && !editableIds.has(existingId)) {
      return error('Eine Nachricht liegt bereits im nicht freigegebenen Bereich der anderen Person.', 409, {
        messageId,
        existingSituationId: existingId,
        existingOwner,
      });
    }
    mergedAssignments[messageId] = situationId;
  }

  const currentOverrides = current.messageOverrides || {};
  const incomingOverrides = incoming.messageOverrides || {};
  const mergedOverrides = { ...currentOverrides };
  for (const [messageId, override] of Object.entries(currentOverrides)) {
    const overrideSituationId = Number(override.situationId || current.assignments[messageId] || 0);
    if (editableIds.has(overrideSituationId)) delete mergedOverrides[messageId];
  }
  for (const [messageId, override] of Object.entries(incomingOverrides)) {
    const overrideSituationId = Number(override.situationId || incoming.assignments[messageId] || 0);
    if (editableIds.has(overrideSituationId)) mergedOverrides[messageId] = override;
  }

  const nextOwners = { ...owners };
  for (const id of newIds) nextOwners[String(id)] = reviewer;
  const assignedSituationIds = new Set(Object.values(mergedAssignments).map(Number));
  const emptyIds = mergedSituations
    .map((item) => Number(item.id))
    .filter((id) => !assignedSituationIds.has(id));
  const emptySet = new Set(emptyIds);
  const prunedSituations = mergedSituations.filter((item) => !emptySet.has(Number(item.id)));
  emptyIds.forEach((id) => delete nextOwners[String(id)]);

  const merged: AnnotationPayload = {
    ...current,
    ...incoming,
    datasetHash: dataset.dataset_hash,
    datasetLabel: dataset.name,
    situations: prunedSituations,
    assignments: mergedAssignments,
    messageOverrides: mergedOverrides,
    events: Array.isArray(incoming.events) ? incoming.events.slice(-2000) : [],
  };

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE review_datasets
      SET annotations_json = ?1, owners_json = ?2, revision = revision + 1, updated_at = ?3
      WHERE id = ?4
    `).bind(JSON.stringify(merged), JSON.stringify(nextOwners), now, dataset.id),
    env.DB.prepare(`
      INSERT INTO review_events (dataset_id, reviewer, action, payload_json)
      VALUES (?1, ?2, 'precision_review_state_saved', ?3)
    `).bind(dataset.id, reviewer, JSON.stringify({
      editableSituationIds: [...editableIds].sort((a, b) => a - b),
      crossOwnerSituationIds: [...crossIds].sort((a, b) => a - b),
      removedEmptySituationIds: emptyIds,
      messageOverrides: Object.keys(mergedOverrides).length,
    })),
  ]);

  return json({
    ok: true,
    datasetId: dataset.id,
    revision: dataset.revision + 1,
    updatedAt: now,
    removedEmptySituationIds: emptyIds,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/api/state' || request.method !== 'PUT') {
      return baseWorker.fetch(request, env);
    }

    let body: { annotations?: unknown };
    try {
      body = await request.clone().json();
    } catch {
      return baseWorker.fetch(request, env);
    }
    if (!isAnnotations(body.annotations) || !requiresPrecisionMerge(body.annotations)) {
      return baseWorker.fetch(request, env);
    }

    const reviewer = await actingReviewer(request, env);
    if (!reviewer) return error('Nicht angemeldet oder Prüferwechsel nicht erlaubt.', 401);
    try {
      return await precisionMerge(request, env, reviewer);
    } catch (caught) {
      console.error('Precision review merge failed', caught);
      return error(caught instanceof Error ? caught.message : 'Präzisionskorrektur konnte nicht gespeichert werden.', 500);
    }
  },
};
