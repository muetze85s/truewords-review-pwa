interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

type Reviewer = 'Philipp' | 'Lena' | 'Admin';
type Owner = 'Philipp' | 'Lena';

type Situation = {
  id: number;
  label?: string;
  note?: string;
  kind?: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
};

type AnnotationPayload = {
  schemaVersion: string;
  datasetHash: string;
  datasetLabel?: string;
  reviewer?: string;
  exportedAt?: string;
  situations: Situation[];
  assignments: Record<string, number>;
  events?: unknown[];
  [key: string]: unknown;
};

type DatasetRow = {
  id: string;
  name: string;
  year: number;
  dataset_hash: string;
  chat_meta_json: string;
  annotations_json: string;
  owners_json: string;
  revision: number;
  is_active: number;
  created_at: string;
  updated_at: string;
};

type ChatChunkRow = {
  chunk_index: number;
  messages_json: string;
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function error(message: string, status = 400, details?: unknown): Response {
  return json({ ok: false, error: message, details }, status);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

async function secretEquals(provided: string, expected?: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function authenticate(request: Request, env: Env): Promise<Reviewer | null> {
  const token = bearerToken(request);
  if (await secretEquals(token, env.PHILIPP_REVIEW_TOKEN)) return 'Philipp';
  if (await secretEquals(token, env.LENA_REVIEW_TOKEN)) return 'Lena';
  if (await secretEquals(token, env.ADMIN_REVIEW_TOKEN)) return 'Admin';
  return null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validDatasetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{2,79}$/i.test(value);
}

function isAnnotationPayload(value: unknown): value is AnnotationPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<AnnotationPayload>;
  return (
    typeof payload.schemaVersion === 'string' &&
    Array.isArray(payload.situations) &&
    !!payload.assignments &&
    typeof payload.assignments === 'object'
  );
}

function normalizeAnnotations(
  payload: AnnotationPayload,
  datasetHash: string,
  datasetLabel: string,
): AnnotationPayload {
  const situations = payload.situations
    .map((situation) => ({
      ...situation,
      id: Number(situation.id),
      label: String(situation.label || ''),
      note: String(situation.note || ''),
      kind: String(situation.kind || 'training'),
      status: String(situation.status || 'open'),
      createdAt: String(situation.createdAt || new Date().toISOString()),
    }))
    .filter((situation) => Number.isInteger(situation.id) && situation.id > 0)
    .sort((a, b) => a.id - b.id);

  const validIds = new Set(situations.map((situation) => situation.id));
  const assignments = Object.fromEntries(
    Object.entries(payload.assignments)
      .map(([messageId, situationId]) => [String(messageId), Number(situationId)] as const)
      .filter(([, situationId]) => validIds.has(situationId)),
  );

  return {
    ...payload,
    schemaVersion: 'truewords-manual-segmentation/v2',
    datasetHash,
    datasetLabel,
    situations,
    assignments,
    events: Array.isArray(payload.events) ? payload.events.slice(-2000) : [],
  };
}

function initialOwners(situations: Situation[]): Record<string, Owner> {
  const sorted = [...situations].sort((a, b) => Number(a.id) - Number(b.id));
  const splitAt = Math.ceil(sorted.length / 2);
  return Object.fromEntries(
    sorted.map((situation, index) => [String(situation.id), index < splitAt ? 'Philipp' : 'Lena']),
  );
}

function parseOwners(value: string): Record<string, Owner> {
  const raw = JSON.parse(value || '{}') as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(raw).filter(([, owner]) => owner === 'Philipp' || owner === 'Lena'),
  ) as Record<string, Owner>;
}

function splitMessages(messages: unknown[], maximumBytes = 400_000): unknown[][] {
  const encoder = new TextEncoder();
  const chunks: unknown[][] = [];
  let current: unknown[] = [];
  let currentBytes = 2;

  for (const message of messages) {
    const messageBytes = encoder.encode(JSON.stringify(message)).byteLength + (current.length ? 1 : 0);
    if (messageBytes > 1_800_000) throw new Error('Eine einzelne Nachricht ist zu groß für den Prüfspeicher.');
    if (current.length && currentBytes + messageBytes > maximumBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(message);
    currentBytes += messageBytes;
  }

  if (current.length || !chunks.length) chunks.push(current);
  return chunks;
}

async function activeDataset(env: Env, requestedId?: string | null): Promise<DatasetRow | null> {
  const id = requestedId || env.ACTIVE_DATASET_ID;
  if (id) {
    const row = await env.DB.prepare('SELECT * FROM review_datasets WHERE id = ?1 LIMIT 1')
      .bind(id)
      .first<DatasetRow>();
    if (row) return row;
  }

  return env.DB.prepare(
    'SELECT * FROM review_datasets WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1',
  ).first<DatasetRow>();
}

async function loadChat(env: Env, dataset: DatasetRow): Promise<Record<string, unknown>> {
  const rows = await env.DB.prepare(
    'SELECT chunk_index, messages_json FROM review_chat_chunks WHERE dataset_id = ?1 ORDER BY chunk_index',
  ).bind(dataset.id).all<ChatChunkRow>();

  const messages = (rows.results || []).flatMap((row) => {
    const value = JSON.parse(row.messages_json);
    return Array.isArray(value) ? value : [];
  });

  return {
    ...(JSON.parse(dataset.chat_meta_json) as Record<string, unknown>),
    messages,
  };
}

async function bootstrap(
  request: Request,
  env: Env,
  reviewer: Reviewer,
  includeChat: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  const dataset = await activeDataset(env, url.searchParams.get('dataset'));
  if (!dataset) return error('Noch kein Prüfdatenbestand auf dem Server vorhanden.', 404);

  const annotations = JSON.parse(dataset.annotations_json) as AnnotationPayload;
  const owners = parseOwners(dataset.owners_json);
  const chat = includeChat ? await loadChat(env, dataset) : undefined;

  return json({
    ok: true,
    reviewer,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      year: dataset.year,
      hash: dataset.dataset_hash,
      revision: dataset.revision,
      updatedAt: dataset.updated_at,
    },
    owners,
    annotations,
    ...(includeChat ? { chat } : {}),
  });
}

async function importDataset(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > 25 * 1024 * 1024) return error('Importdatei ist größer als 25 MB.', 413);

  const body = await request.json<{
    datasetId?: unknown;
    name?: unknown;
    year?: unknown;
    chat?: unknown;
    annotations?: unknown;
  }>();

  if (!validDatasetId(body.datasetId)) return error('Ungültige datasetId.');
  if (!body.chat || typeof body.chat !== 'object') return error('Chatdaten fehlen.');
  if (!isAnnotationPayload(body.annotations)) return error('Markierungsdaten fehlen oder sind ungültig.');

  const chat = body.chat as Record<string, unknown>;
  if (!Array.isArray(chat.messages)) return error('Der Chat enthält keine Nachrichtenliste.');

  const name = String(body.name || body.datasetId);
  const year = Number(body.year || 2026);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return error('Ungültiges Jahr.');

  const chatText = JSON.stringify(chat);
  const datasetHash = await sha256Hex(chatText);
  const annotations = normalizeAnnotations(body.annotations, datasetHash, `${name} · ${year}`);
  const owners = initialOwners(annotations.situations);
  const { messages, ...chatMeta } = chat;
  const chunks = splitMessages(messages as unknown[]);
  const now = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE review_datasets SET is_active = 0 WHERE id <> ?1').bind(body.datasetId),
    env.DB.prepare(`
      INSERT INTO review_datasets (
        id, name, year, dataset_hash, chat_meta_json, annotations_json, owners_json,
        revision, is_active, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, ?8, ?8)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        year = excluded.year,
        dataset_hash = excluded.dataset_hash,
        chat_meta_json = excluded.chat_meta_json,
        annotations_json = excluded.annotations_json,
        owners_json = excluded.owners_json,
        revision = review_datasets.revision + 1,
        is_active = 1,
        updated_at = excluded.updated_at
    `).bind(
      body.datasetId,
      name,
      year,
      datasetHash,
      JSON.stringify(chatMeta),
      JSON.stringify(annotations),
      JSON.stringify(owners),
      now,
    ),
    env.DB.prepare('DELETE FROM review_chat_chunks WHERE dataset_id = ?1').bind(body.datasetId),
  ];

  chunks.forEach((chunk, index) => {
    statements.push(
      env.DB.prepare(
        'INSERT INTO review_chat_chunks (dataset_id, chunk_index, messages_json) VALUES (?1, ?2, ?3)',
      ).bind(body.datasetId, index, JSON.stringify(chunk)),
    );
  });

  statements.push(
    env.DB.prepare(
      'INSERT INTO review_events (dataset_id, reviewer, action, payload_json) VALUES (?1, ?2, ?3, ?4)',
    ).bind(
      body.datasetId,
      'Admin',
      'dataset_imported',
      JSON.stringify({
        year,
        messages: (messages as unknown[]).length,
        chunks: chunks.length,
        situations: annotations.situations.length,
        datasetHash,
      }),
    ),
  );

  await env.DB.batch(statements);

  return json({
    ok: true,
    datasetId: body.datasetId,
    datasetHash,
    messages: (messages as unknown[]).length,
    chunks: chunks.length,
    situations: annotations.situations.length,
    split: {
      Philipp: Object.values(owners).filter((owner) => owner === 'Philipp').length,
      Lena: Object.values(owners).filter((owner) => owner === 'Lena').length,
    },
  }, 201);
}

function situationMap(payload: AnnotationPayload): Map<number, Situation> {
  return new Map(payload.situations.map((situation) => [Number(situation.id), situation]));
}

async function mergeReviewerState(
  request: Request,
  env: Env,
  reviewer: Exclude<Reviewer, 'Admin'>,
): Promise<Response> {
  const body = await request.json<{ datasetId?: unknown; annotations?: unknown }>();
  if (!validDatasetId(body.datasetId)) return error('Ungültige datasetId.');
  if (!isAnnotationPayload(body.annotations)) return error('Ungültiger Prüfstand.');

  const dataset = await activeDataset(env, body.datasetId);
  if (!dataset || dataset.id !== body.datasetId) return error('Prüfdatenbestand nicht gefunden.', 404);

  const current = JSON.parse(dataset.annotations_json) as AnnotationPayload;
  const incoming = normalizeAnnotations(body.annotations, dataset.dataset_hash, dataset.name);
  const currentSituations = situationMap(current);
  const incomingSituations = situationMap(incoming);
  const owners = parseOwners(dataset.owners_json);
  const ownExistingIds = new Set(
    Object.entries(owners)
      .filter(([, owner]) => owner === reviewer)
      .map(([id]) => Number(id)),
  );

  for (const [id, incomingSituation] of incomingSituations) {
    const owner = owners[String(id)];
    if (owner && owner !== reviewer) {
      const currentSituation = currentSituations.get(id);
      if (JSON.stringify(incomingSituation) !== JSON.stringify(currentSituation)) {
        return error(`Situation ${id} gehört zum Bereich von ${owner}.`, 409, {
          situationId: id,
          owner,
        });
      }
    }
  }

  const newSituationIds = [...incomingSituations.keys()].filter((id) => !owners[String(id)]);
  const mergedSituations = current.situations.filter(
    (situation) => !ownExistingIds.has(Number(situation.id)),
  );
  for (const [id, situation] of incomingSituations) {
    if (ownExistingIds.has(id) || newSituationIds.includes(id)) mergedSituations.push(situation);
  }
  mergedSituations.sort((a, b) => Number(a.id) - Number(b.id));

  const ownedAfterMerge = new Set<number>([...ownExistingIds, ...newSituationIds]);
  const mergedAssignments = { ...current.assignments };
  for (const [messageId, situationId] of Object.entries(mergedAssignments)) {
    if (ownedAfterMerge.has(Number(situationId))) delete mergedAssignments[messageId];
  }

  for (const [messageId, rawSituationId] of Object.entries(incoming.assignments)) {
    const situationId = Number(rawSituationId);
    if (!ownedAfterMerge.has(situationId)) continue;
    const existingSituationId = Number(current.assignments[messageId] || 0);
    const existingOwner = owners[String(existingSituationId)];
    if (existingOwner && existingOwner !== reviewer) {
      return error('Eine Nachricht liegt bereits im Bereich der anderen Person.', 409, {
        messageId,
        existingSituationId,
        existingOwner,
        requestedSituationId: situationId,
      });
    }
    mergedAssignments[messageId] = situationId;
  }

  const nextOwners = { ...owners };
  for (const id of ownExistingIds) {
    if (!incomingSituations.has(id)) delete nextOwners[String(id)];
  }
  for (const id of newSituationIds) nextOwners[String(id)] = reviewer;

  const assignedSituationIds = new Set(
    Object.values(mergedAssignments)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
  const removedEmptySituationIds = mergedSituations
    .map((situation) => Number(situation.id))
    .filter((id) => !assignedSituationIds.has(id));
  const removedEmptySet = new Set(removedEmptySituationIds);
  const prunedSituations = mergedSituations.filter(
    (situation) => !removedEmptySet.has(Number(situation.id)),
  );
  for (const id of removedEmptySituationIds) delete nextOwners[String(id)];

  const merged: AnnotationPayload = {
    ...current,
    datasetHash: dataset.dataset_hash,
    datasetLabel: dataset.name,
    situations: prunedSituations,
    assignments: mergedAssignments,
    events: Array.isArray(current.events) ? current.events.slice(-2000) : [],
  };

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE review_datasets
      SET annotations_json = ?1, owners_json = ?2, revision = revision + 1, updated_at = ?3
      WHERE id = ?4
    `).bind(JSON.stringify(merged), JSON.stringify(nextOwners), now, dataset.id),
    env.DB.prepare(
      'INSERT INTO review_events (dataset_id, reviewer, action, payload_json) VALUES (?1, ?2, ?3, ?4)',
    ).bind(
      dataset.id,
      reviewer,
      'review_state_saved',
      JSON.stringify({
        situations: [...ownedAfterMerge]
          .filter((id) => !removedEmptySet.has(id))
          .sort((a, b) => a - b),
        newSituationIds: newSituationIds.filter((id) => !removedEmptySet.has(id)),
        removedEmptySituationIds,
      }),
    ),
  ]);

  const updated = await activeDataset(env, dataset.id);
  return json({
    ok: true,
    datasetId: dataset.id,
    revision: updated?.revision ?? dataset.revision + 1,
    updatedAt: updated?.updated_at ?? now,
    removedEmptySituationIds,
  });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true, service: 'truewords-review-sync', storage: 'd1' });
  }

  const reviewer = await authenticate(request, env);
  if (!reviewer) return error('Nicht angemeldet.', 401);

  if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
    return bootstrap(request, env, reviewer, true);
  }
  if (url.pathname === '/api/state' && request.method === 'GET') {
    return bootstrap(request, env, reviewer, false);
  }
  if (url.pathname === '/api/admin/import' && request.method === 'POST') {
    if (reviewer !== 'Admin') return error('Nur der Admin darf Daten einspielen.', 403);
    return importDataset(request, env);
  }
  if (url.pathname === '/api/state' && request.method === 'PUT') {
    if (reviewer === 'Admin') return error('Adminzugang ist nicht als Prüfer verwendbar.', 403);
    return mergeReviewerState(request, env, reviewer);
  }

  return error('API-Endpunkt nicht gefunden.', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': url.origin,
            'access-control-allow-headers': 'authorization, content-type',
            'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
            'access-control-max-age': '600',
          },
        });
      }
      if (url.pathname.startsWith('/api/')) return handleApi(request, env);
      return env.ASSETS.fetch(request);
    } catch (caught) {
      console.error('Review API error', caught);
      return error('Interner Serverfehler.', 500);
    }
  },
};
