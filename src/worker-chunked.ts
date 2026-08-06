import baseWorker from './worker-d1';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

type ImportSessionRow = {
  dataset_id: string;
  upload_id: string;
  expected_chunks: number;
  expected_messages: number;
  dataset_hash: string;
};

type ImportCountsRow = {
  chunks: number;
  messages: number;
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

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  return (await secretEquals(bearerToken(request), env.ADMIN_REVIEW_TOKEN))
    ? null
    : error('Nur der Admin darf Daten einspielen.', 403);
}

function validDatasetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{2,79}$/i.test(value);
}

function validUploadId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{20,80}$/i.test(value);
}

function positiveInteger(value: unknown, maximum: number): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= maximum ? number : null;
}

async function sessionFor(
  env: Env,
  datasetId: string,
  uploadId: string,
): Promise<ImportSessionRow | null> {
  return env.DB.prepare(`
    SELECT dataset_id, upload_id, expected_chunks, expected_messages, dataset_hash
    FROM review_import_sessions
    WHERE dataset_id = ?1 AND upload_id = ?2
    LIMIT 1
  `).bind(datasetId, uploadId).first<ImportSessionRow>();
}

async function importCounts(env: Env, datasetId: string): Promise<ImportCountsRow> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS chunks, COALESCE(SUM(message_count), 0) AS messages
    FROM review_chat_chunks
    WHERE dataset_id = ?1
  `).bind(datasetId).first<ImportCountsRow>();
  return {
    chunks: Number(row?.chunks || 0),
    messages: Number(row?.messages || 0),
  };
}

async function startImport(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    datasetId?: unknown;
    name?: unknown;
    year?: unknown;
    datasetHash?: unknown;
    chatMeta?: unknown;
    expectedChunks?: unknown;
    expectedMessages?: unknown;
  }>();

  if (!validDatasetId(body.datasetId)) return error('Ungültige Datensatz-ID.');
  const expectedChunks = positiveInteger(body.expectedChunks, 5000);
  const expectedMessages = positiveInteger(body.expectedMessages, 2_000_000);
  if (!expectedChunks || !expectedMessages) return error('Ungültige Importgröße.');
  if (typeof body.datasetHash !== 'string' || !/^[a-f0-9]{64}$/i.test(body.datasetHash)) {
    return error('Ungültiger Datensatz-Hash.');
  }
  if (!body.chatMeta || typeof body.chatMeta !== 'object' || Array.isArray(body.chatMeta)) {
    return error('Chat-Metadaten fehlen.');
  }

  const uploadId = crypto.randomUUID();
  const name = String(body.name || body.datasetId).slice(0, 240);
  const year = Number.isInteger(Number(body.year)) ? Number(body.year) : 2021;
  const now = new Date().toISOString();
  const annotations = {
    schemaVersion: 'truewords-manual-segmentation/v2',
    datasetHash: body.datasetHash,
    datasetLabel: name,
    reviewer: 'System',
    situations: [],
    assignments: {},
    events: [],
  };

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO review_datasets (
        id, name, year, dataset_hash, chat_meta_json, annotations_json, owners_json,
        revision, is_active, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', 1, 1, ?7, ?7)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        year = excluded.year,
        dataset_hash = excluded.dataset_hash,
        chat_meta_json = excluded.chat_meta_json,
        annotations_json = excluded.annotations_json,
        owners_json = '{}',
        revision = review_datasets.revision + 1,
        is_active = 1,
        updated_at = excluded.updated_at
    `).bind(
      body.datasetId,
      name,
      year,
      body.datasetHash,
      JSON.stringify(body.chatMeta),
      JSON.stringify(annotations),
      now,
    ),
    env.DB.prepare('DELETE FROM review_chat_chunks WHERE dataset_id = ?1').bind(body.datasetId),
    env.DB.prepare(`
      INSERT INTO review_import_sessions (
        dataset_id, upload_id, expected_chunks, expected_messages, dataset_hash, started_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      ON CONFLICT(dataset_id) DO UPDATE SET
        upload_id = excluded.upload_id,
        expected_chunks = excluded.expected_chunks,
        expected_messages = excluded.expected_messages,
        dataset_hash = excluded.dataset_hash,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).bind(
      body.datasetId,
      uploadId,
      expectedChunks,
      expectedMessages,
      body.datasetHash,
      now,
    ),
  ]);

  return json({
    ok: true,
    datasetId: body.datasetId,
    uploadId,
    expectedChunks,
    expectedMessages,
  }, 201);
}

async function uploadChunk(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > 900_000) return error('Datenblock ist zu groß.', 413);

  const body = await request.json<{
    datasetId?: unknown;
    uploadId?: unknown;
    chunkIndex?: unknown;
    messages?: unknown;
  }>();

  if (!validDatasetId(body.datasetId) || !validUploadId(body.uploadId)) {
    return error('Ungültige Importsitzung.');
  }
  const chunkIndex = Number(body.chunkIndex);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return error('Ungültige Blocknummer.');
  if (!Array.isArray(body.messages) || !body.messages.length) return error('Datenblock ist leer.');

  const session = await sessionFor(env, body.datasetId, body.uploadId);
  if (!session) return error('Importsitzung wurde nicht gefunden oder ist abgelaufen.', 409);
  if (chunkIndex >= session.expected_chunks) return error('Blocknummer liegt außerhalb des Imports.');

  const messagesJson = JSON.stringify(body.messages);
  const bytes = new TextEncoder().encode(messagesJson).byteLength;
  if (bytes > 700_000) return error('Datenblock überschreitet 700 KB.', 413);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO review_chat_chunks (dataset_id, chunk_index, messages_json, message_count)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(dataset_id, chunk_index) DO UPDATE SET
        messages_json = excluded.messages_json,
        message_count = excluded.message_count
    `).bind(body.datasetId, chunkIndex, messagesJson, body.messages.length),
    env.DB.prepare(`
      UPDATE review_import_sessions SET updated_at = ?1
      WHERE dataset_id = ?2 AND upload_id = ?3
    `).bind(new Date().toISOString(), body.datasetId, body.uploadId),
  ]);

  const counts = await importCounts(env, body.datasetId);
  return json({
    ok: true,
    chunkIndex,
    receivedChunks: counts.chunks,
    receivedMessages: counts.messages,
    expectedChunks: session.expected_chunks,
    expectedMessages: session.expected_messages,
  });
}

async function importStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const datasetId = url.searchParams.get('dataset');
  const uploadId = url.searchParams.get('upload');
  if (!validDatasetId(datasetId) || !validUploadId(uploadId)) return error('Ungültige Importsitzung.');

  const session = await sessionFor(env, datasetId, uploadId);
  if (!session) return error('Importsitzung wurde nicht gefunden.', 404);
  const counts = await importCounts(env, datasetId);
  return json({
    ok: true,
    receivedChunks: counts.chunks,
    receivedMessages: counts.messages,
    expectedChunks: session.expected_chunks,
    expectedMessages: session.expected_messages,
  });
}

async function finishImport(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ datasetId?: unknown; uploadId?: unknown }>();
  if (!validDatasetId(body.datasetId) || !validUploadId(body.uploadId)) {
    return error('Ungültige Importsitzung.');
  }

  const session = await sessionFor(env, body.datasetId, body.uploadId);
  if (!session) return error('Importsitzung wurde nicht gefunden.', 404);
  const counts = await importCounts(env, body.datasetId);
  if (counts.chunks !== session.expected_chunks || counts.messages !== session.expected_messages) {
    return error('Import ist noch nicht vollständig.', 409, {
      receivedChunks: counts.chunks,
      expectedChunks: session.expected_chunks,
      receivedMessages: counts.messages,
      expectedMessages: session.expected_messages,
    });
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE review_datasets SET is_active = 0 WHERE id <> ?1').bind(body.datasetId),
    env.DB.prepare(`
      UPDATE review_datasets SET is_active = 1, updated_at = ?1 WHERE id = ?2
    `).bind(now, body.datasetId),
    env.DB.prepare(`
      INSERT INTO review_events (dataset_id, reviewer, action, payload_json)
      VALUES (?1, 'Admin', 'dataset_imported_chunked', ?2)
    `).bind(body.datasetId, JSON.stringify({
      messages: counts.messages,
      chunks: counts.chunks,
      datasetHash: session.dataset_hash,
    })),
    env.DB.prepare(`
      DELETE FROM review_import_sessions WHERE dataset_id = ?1 AND upload_id = ?2
    `).bind(body.datasetId, body.uploadId),
  ]);

  return json({
    ok: true,
    datasetId: body.datasetId,
    datasetHash: session.dataset_hash,
    messages: counts.messages,
    chunks: counts.chunks,
    situations: 0,
  });
}

async function handleChunkedImport(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/admin/import/')) return null;

  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  if (url.pathname === '/api/admin/import/start' && request.method === 'POST') {
    return startImport(request, env);
  }
  if (url.pathname === '/api/admin/import/chunk' && request.method === 'POST') {
    return uploadChunk(request, env);
  }
  if (url.pathname === '/api/admin/import/status' && request.method === 'GET') {
    return importStatus(request, env);
  }
  if (url.pathname === '/api/admin/import/finish' && request.method === 'POST') {
    return finishImport(request, env);
  }
  return error('Import-Endpunkt nicht gefunden.', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const handled = await handleChunkedImport(request, env);
      if (handled) return handled;
      return baseWorker.fetch(request, env);
    } catch (caught) {
      console.error('Chunked import error', caught);
      return error('Interner Serverfehler beim Datenimport.', 500);
    }
  },
};
