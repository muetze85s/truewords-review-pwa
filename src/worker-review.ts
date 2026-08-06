import portalWorker from './worker-auth-fast';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

type Role = 'Philipp' | 'Lena';

type SessionUser = {
  id: number;
  email: string;
  role: Role;
  canUpload: boolean;
};

type DatasetRow = {
  id: string;
  name: string;
  year: number;
  dataset_hash: string;
  annotations_json: string;
  owners_json: string;
  revision: number;
  updated_at: string;
};

type ChunkBoundsRow = {
  first_chunk: number | null;
  last_chunk: number | null;
};

type ChatChunkRow = {
  chunk_index: number;
  messages_json: string;
};

type AnnotationPayload = {
  schemaVersion: string;
  datasetHash?: string;
  datasetLabel?: string;
  situations: Array<Record<string, unknown> & { id: number }>;
  assignments: Record<string, number>;
  events?: unknown[];
  [key: string]: unknown;
};

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

async function authenticatedUser(request: Request, env: Env): Promise<SessionUser | Response> {
  const url = new URL(request.url);
  url.pathname = '/api/auth/me';
  url.search = '';
  const response = await portalWorker.fetch(
    new Request(url.toString(), {
      method: 'GET',
      headers: request.headers,
    }),
    env,
  );
  if (!response.ok) return response;
  const payload = await response.json<{ user?: SessionUser }>();
  return payload.user || error('Nicht angemeldet.', 401);
}

async function activeDataset(env: Env): Promise<DatasetRow | null> {
  if (env.ACTIVE_DATASET_ID) {
    const selected = await env.DB.prepare(`
      SELECT id, name, year, dataset_hash, annotations_json, owners_json, revision, updated_at
      FROM review_datasets
      WHERE id = ?1
      LIMIT 1
    `).bind(env.ACTIVE_DATASET_ID).first<DatasetRow>();
    if (selected) return selected;
  }

  return env.DB.prepare(`
    SELECT id, name, year, dataset_hash, annotations_json, owners_json, revision, updated_at
    FROM review_datasets
    WHERE is_active = 1
    ORDER BY updated_at DESC
    LIMIT 1
  `).first<DatasetRow>();
}

function parseAnnotations(dataset: DatasetRow): AnnotationPayload {
  const value = JSON.parse(dataset.annotations_json) as AnnotationPayload;
  if (!Array.isArray(value.situations) || !value.assignments || typeof value.assignments !== 'object') {
    throw new Error('Der aktive Prüfstand enthält keine gültigen Situationen.');
  }
  return value;
}

function parseOwners(value: string): Record<string, Role> {
  const raw = JSON.parse(value || '{}') as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(raw).filter(([, owner]) => owner === 'Philipp' || owner === 'Lena'),
  ) as Record<string, Role>;
}

function sourceId(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const id = (message as { id?: unknown }).id;
  return id === undefined || id === null ? '' : String(id);
}

async function reviewWindow(env: Env, dataset: DatasetRow, annotations: AnnotationPayload): Promise<unknown[]> {
  const assignedIds = Object.keys(annotations.assignments)
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);

  if (!assignedIds.length) return [];
  const firstId = assignedIds[0];
  const lastId = assignedIds.at(-1) as number;
  const firstNeedle = `\"id\":${firstId}`;
  const lastNeedle = `\"id\":${lastId}`;

  const bounds = await env.DB.prepare(`
    SELECT
      MIN(CASE WHEN instr(messages_json, ?2) > 0 THEN chunk_index END) AS first_chunk,
      MAX(CASE WHEN instr(messages_json, ?3) > 0 THEN chunk_index END) AS last_chunk
    FROM review_chat_chunks
    WHERE dataset_id = ?1
  `).bind(dataset.id, firstNeedle, lastNeedle).first<ChunkBoundsRow>();

  if (bounds?.first_chunk === null || bounds?.last_chunk === null) {
    throw new Error('Das Nachrichtenfenster der Vorschläge konnte nicht gefunden werden.');
  }

  const firstChunk = Math.max(0, Number(bounds.first_chunk) - 1);
  const lastChunk = Number(bounds.last_chunk) + 1;
  const rows = await env.DB.prepare(`
    SELECT chunk_index, messages_json
    FROM review_chat_chunks
    WHERE dataset_id = ?1 AND chunk_index BETWEEN ?2 AND ?3
    ORDER BY chunk_index
  `).bind(dataset.id, firstChunk, lastChunk).all<ChatChunkRow>();

  const messages = (rows.results || []).flatMap((row) => {
    const parsed = JSON.parse(row.messages_json);
    return Array.isArray(parsed) ? parsed : [];
  });

  const firstIndex = messages.findIndex((message) => sourceId(message) === String(firstId));
  const lastIndex = messages.findIndex((message) => sourceId(message) === String(lastId));
  if (firstIndex < 0 || lastIndex < firstIndex) {
    throw new Error('Die Nachrichten der Vorschläge sind im Rohchat nicht vollständig auffindbar.');
  }

  const start = Math.max(0, firstIndex - 24);
  const end = Math.min(messages.length, lastIndex + 25);
  return messages.slice(start, end);
}

async function reviewBootstrap(request: Request, env: Env): Promise<Response> {
  const user = await authenticatedUser(request, env);
  if (user instanceof Response) return user;

  const dataset = await activeDataset(env);
  if (!dataset) return error('Noch kein Prüfdatenbestand vorhanden.', 404);

  const annotations = parseAnnotations(dataset);
  if (!annotations.situations.length || !Object.keys(annotations.assignments).length) {
    return error('Für den aktiven Rohchat sind noch keine KI-Vorschläge aktiviert.', 409);
  }

  const messages = await reviewWindow(env, dataset, annotations);
  return json({
    ok: true,
    user,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      year: dataset.year,
      hash: dataset.dataset_hash,
      revision: dataset.revision,
      updatedAt: dataset.updated_at,
    },
    owners: parseOwners(dataset.owners_json),
    annotations,
    messages,
    window: {
      messages: messages.length,
      assigned: Object.keys(annotations.assignments).length,
      situations: annotations.situations.length,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/review/bootstrap' && request.method === 'GET') {
        return reviewBootstrap(request, env);
      }
      return portalWorker.fetch(request, env);
    } catch (caught) {
      console.error('Review workspace error', caught);
      return error(
        caught instanceof Error ? caught.message : 'Prüfansicht konnte nicht geladen werden.',
        500,
      );
    }
  },
};
