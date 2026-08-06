import appWorker from './worker-auth-fast';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

type DatasetRow = {
  id: string;
  name: string;
  dataset_hash: string;
  chat_meta_json: string;
  revision: number;
};

type ChunkRow = {
  messages_json: string;
  message_count: number;
};

const SESSION_COOKIE = 'tw_review_session';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function error(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

function cookieValue(request: Request, name: string): string {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
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

async function bearerAuthenticated(request: Request, env: Env): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const provided = await sha256Hex(token);
  const expected = await Promise.all(
    [env.PHILIPP_REVIEW_TOKEN, env.LENA_REVIEW_TOKEN, env.ADMIN_REVIEW_TOKEN]
      .filter((value): value is string => !!value)
      .map((value) => sha256Hex(value)),
  );
  return expected.some((value) => constantEqual(provided, value));
}

async function sessionAuthenticated(request: Request, env: Env): Promise<boolean> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/i.test(token)) return false;
  const row = await env.DB.prepare(`
    SELECT 1 AS valid
    FROM review_sessions s
    JOIN review_users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.is_active = 1
    LIMIT 1
  `).bind(await sha256Hex(token), new Date().toISOString()).first<{ valid: number }>();
  return Number(row?.valid || 0) === 1;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  return (await bearerAuthenticated(request, env)) || (await sessionAuthenticated(request, env));
}

function validDatasetId(value: string | null): value is string {
  return !!value && /^[a-z0-9][a-z0-9._-]{2,79}$/i.test(value);
}

function validChunkIndex(value: string | null): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 10_000 ? number : null;
}

async function datasetFor(env: Env, requestedId: string | null): Promise<DatasetRow | null> {
  const id = requestedId || env.ACTIVE_DATASET_ID;
  if (!validDatasetId(id)) return null;
  return env.DB.prepare(`
    SELECT id, name, dataset_hash, chat_meta_json, revision
    FROM review_datasets
    WHERE id = ?1
    LIMIT 1
  `).bind(id).first<DatasetRow>();
}

async function manifest(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return error('Nicht angemeldet.', 401);
  const url = new URL(request.url);
  const dataset = await datasetFor(env, url.searchParams.get('dataset'));
  if (!dataset) return error('Prüfdatenbestand nicht gefunden.', 404);

  const counts = await env.DB.prepare(`
    SELECT COUNT(*) AS chunk_count, COALESCE(SUM(message_count), 0) AS message_count
    FROM review_chat_chunks
    WHERE dataset_id = ?1
  `).bind(dataset.id).first<{ chunk_count: number; message_count: number }>();

  const chunkCount = Number(counts?.chunk_count || 0);
  const messageCount = Number(counts?.message_count || 0);
  if (!chunkCount || !messageCount) return error('Der Rohchat enthält keine gespeicherten Datenblöcke.', 404);

  return json({
    ok: true,
    datasetId: dataset.id,
    datasetName: dataset.name,
    datasetHash: dataset.dataset_hash,
    revision: dataset.revision,
    chatMeta: JSON.parse(dataset.chat_meta_json || '{}'),
    chunkCount,
    messageCount,
  });
}

async function chunk(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthenticated(request, env))) return error('Nicht angemeldet.', 401);
  const url = new URL(request.url);
  const datasetId = url.searchParams.get('dataset');
  const index = validChunkIndex(url.searchParams.get('index'));
  if (!validDatasetId(datasetId) || index === null) return error('Ungültige Chatblock-Anfrage.');

  const row = await env.DB.prepare(`
    SELECT messages_json, message_count
    FROM review_chat_chunks
    WHERE dataset_id = ?1 AND chunk_index = ?2
    LIMIT 1
  `).bind(datasetId, index).first<ChunkRow>();
  if (!row) return error('Chatblock wurde nicht gefunden.', 404);

  const messages = JSON.parse(row.messages_json);
  if (!Array.isArray(messages)) return error('Chatblock ist beschädigt.', 500);
  return json({
    ok: true,
    datasetId,
    index,
    messageCount: Number(row.message_count || messages.length),
    messages,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/chat/manifest' && request.method === 'GET') {
        return manifest(request, env);
      }
      if (url.pathname === '/api/chat/chunk' && request.method === 'GET') {
        return chunk(request, env);
      }
      return appWorker.fetch(request, env);
    } catch (caught) {
      console.error('Chat stream error', caught);
      return error('Chatdaten konnten nicht blockweise geladen werden.', 500);
    }
  },
};
