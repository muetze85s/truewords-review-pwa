import portalWorker from './worker-portal';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

type Role = 'Philipp' | 'Lena';

type UserRow = {
  id: number;
  email: string;
  role: Role;
  can_upload: number;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
};

const SESSION_COOKIE = 'tw_review_session_v2';
const SESSION_SECONDS = 12 * 60 * 60;
const FAST_HMAC_MARKER = 1;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function error(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(length = 32): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(length)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function constantEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function secretEquals(provided: string, expected?: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const [left, right] = await Promise.all([sha256Hex(provided), sha256Hex(expected)]);
  return constantEqual(left, right);
}

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLocaleLowerCase('de-DE');
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 256;
}

async function passwordKey(pepper: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function passwordVerifier(key: CryptoKey, password: string, salt: string): Promise<string> {
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${salt}\u0000${password}`),
  );
  return bytesToHex(new Uint8Array(signed));
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

async function setupAccounts(request: Request, env: Env): Promise<Response> {
  if (!(await secretEquals(bearerToken(request), env.ADMIN_REVIEW_TOKEN))) {
    return error('Admin-Zugangscode ist ungültig.', 403);
  }
  if (!env.ADMIN_REVIEW_TOKEN) return error('Servergeheimnis fehlt.', 503);

  const body = await request.json<{
    philippEmail?: unknown;
    philippPassword?: unknown;
    lenaEmail?: unknown;
    lenaPassword?: unknown;
  }>();
  const philippEmail = normalizeEmail(body.philippEmail);
  const lenaEmail = normalizeEmail(body.lenaEmail);
  if (!validEmail(philippEmail) || !validEmail(lenaEmail)) {
    return error('Beide E-Mail-Adressen müssen gültig sein.');
  }
  if (philippEmail === lenaEmail) return error('Die Konten benötigen unterschiedliche E-Mail-Adressen.');
  if (!validPassword(body.philippPassword) || !validPassword(body.lenaPassword)) {
    return error('Jedes Passwort muss mindestens 12 Zeichen lang sein.');
  }

  const philippSalt = randomHex(24);
  const lenaSalt = randomHex(24);
  const key = await passwordKey(env.ADMIN_REVIEW_TOKEN);
  const [philippHash, lenaHash] = await Promise.all([
    passwordVerifier(key, body.philippPassword, philippSalt),
    passwordVerifier(key, body.lenaPassword, lenaSalt),
  ]);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare('DELETE FROM review_sessions'),
    env.DB.prepare('DELETE FROM review_users'),
    env.DB.prepare(`
      INSERT INTO review_users (
        email, role, can_upload, password_salt, password_hash, password_iterations,
        is_active, created_at, updated_at
      ) VALUES (?1, 'Philipp', 1, ?2, ?3, ?4, 1, ?5, ?5)
    `).bind(philippEmail, philippSalt, philippHash, FAST_HMAC_MARKER, now),
    env.DB.prepare(`
      INSERT INTO review_users (
        email, role, can_upload, password_salt, password_hash, password_iterations,
        is_active, created_at, updated_at
      ) VALUES (?1, 'Lena', 0, ?2, ?3, ?4, 1, ?5, ?5)
    `).bind(lenaEmail, lenaSalt, lenaHash, FAST_HMAC_MARKER, now),
  ]);

  return json({ ok: true, configured: true });
}

async function login(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_REVIEW_TOKEN) return error('Servergeheimnis fehlt.', 503);
  const body = await request.json<{ email?: unknown; password?: unknown }>();
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!validEmail(email) || !password) return error('E-Mail oder Passwort ist falsch.', 401);

  const row = await env.DB.prepare(`
    SELECT id, email, role, can_upload, password_salt, password_hash, password_iterations
    FROM review_users
    WHERE email = ?1 COLLATE NOCASE AND is_active = 1
    LIMIT 1
  `).bind(email).first<UserRow>();
  if (!row) return error('E-Mail oder Passwort ist falsch.', 401);
  if (Number(row.password_iterations) !== FAST_HMAC_MARKER) {
    return error('Die Konten müssen über die Einrichtungsseite einmal neu gespeichert werden.', 409);
  }

  const key = await passwordKey(env.ADMIN_REVIEW_TOKEN);
  const candidate = await passwordVerifier(key, password, row.password_salt);
  if (!constantEqual(candidate, row.password_hash)) return error('E-Mail oder Passwort ist falsch.', 401);

  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM review_sessions WHERE expires_at <= ?1').bind(now.toISOString()),
    env.DB.prepare(`
      INSERT INTO review_sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?4)
    `).bind(tokenHash, row.id, expiresAt, now.toISOString()),
  ]);

  return json(
    {
      ok: true,
      user: {
        email: row.email,
        role: row.role,
        canUpload: Number(row.can_upload) === 1,
      },
    },
    200,
    { 'set-cookie': sessionCookie(token) },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/auth/setup' && request.method === 'POST') {
        return setupAccounts(request, env);
      }
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        return login(request, env);
      }
      return portalWorker.fetch(request, env);
    } catch (caught) {
      console.error('Fast authentication error', caught);
      return error('Konten konnten serverseitig nicht verarbeitet werden.', 500);
    }
  },
};
