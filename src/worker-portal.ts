import appWorker from './worker-analysis';

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

type SessionUser = {
  id: number;
  email: string;
  role: Role;
  canUpload: boolean;
};

const SESSION_COOKIE = 'tw_review_session_v2';
const SESSION_SECONDS = 12 * 60 * 60;
const PASSWORD_ITERATIONS = 180_000;
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

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
  });
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

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]+$/i.test(value) || value.length % 2) throw new Error('Ungültiger Hexwert.');
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function randomHex(length = 32): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(length)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const salt = hexToBytes(saltHex).buffer as ArrayBuffer;
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
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

async function sessionUser(request: Request, env: Env): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(`
    SELECT u.id, u.email, u.role, u.can_upload,
           u.password_salt, u.password_hash, u.password_iterations
    FROM review_sessions s
    JOIN review_users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.is_active = 1
    LIMIT 1
  `).bind(tokenHash, now).first<UserRow>();
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    canUpload: Number(row.can_upload) === 1,
  };
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

async function setupStatus(env: Env): Promise<Response> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM review_users WHERE is_active = 1')
    .first<{ count: number }>();
  return json({ ok: true, configured: Number(row?.count || 0) === 2 });
}

async function setupAccounts(request: Request, env: Env): Promise<Response> {
  if (!(await secretEquals(bearerToken(request), env.ADMIN_REVIEW_TOKEN))) {
    return error('Admin-Zugangscode ist ungültig.', 403);
  }

  const body = await request.json<{
    philippEmail?: unknown;
    philippPassword?: unknown;
    lenaEmail?: unknown;
    lenaPassword?: unknown;
  }>();
  const philippEmail = normalizeEmail(body.philippEmail);
  const lenaEmail = normalizeEmail(body.lenaEmail);
  if (!validEmail(philippEmail) || !validEmail(lenaEmail)) return error('Beide E-Mail-Adressen müssen gültig sein.');
  if (philippEmail === lenaEmail) return error('Die Konten benötigen unterschiedliche E-Mail-Adressen.');
  if (!validPassword(body.philippPassword) || !validPassword(body.lenaPassword)) {
    return error('Jedes Passwort muss mindestens 12 Zeichen lang sein.');
  }

  const philippSalt = randomHex(24);
  const lenaSalt = randomHex(24);
  const [philippHash, lenaHash] = await Promise.all([
    hashPassword(body.philippPassword, philippSalt, PASSWORD_ITERATIONS),
    hashPassword(body.lenaPassword, lenaSalt, PASSWORD_ITERATIONS),
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
    `).bind(philippEmail, philippSalt, philippHash, PASSWORD_ITERATIONS, now),
    env.DB.prepare(`
      INSERT INTO review_users (
        email, role, can_upload, password_salt, password_hash, password_iterations,
        is_active, created_at, updated_at
      ) VALUES (?1, 'Lena', 0, ?2, ?3, ?4, 1, ?5, ?5)
    `).bind(lenaEmail, lenaSalt, lenaHash, PASSWORD_ITERATIONS, now),
  ]);

  return json({ ok: true, configured: true });
}

async function login(request: Request, env: Env): Promise<Response> {
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

  const candidate = await hashPassword(password, row.password_salt, Number(row.password_iterations));
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

async function logout(request: Request, env: Env): Promise<Response> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (/^[a-f0-9]{64}$/i.test(token)) {
    await env.DB.prepare('DELETE FROM review_sessions WHERE token_hash = ?1')
      .bind(await sha256Hex(token))
      .run();
  }
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}

async function authApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/auth/setup-status' && request.method === 'GET') return setupStatus(env);
  if (url.pathname === '/api/auth/setup' && request.method === 'POST') return setupAccounts(request, env);
  if (url.pathname === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await sessionUser(request, env);
    return user ? json({ ok: true, user }) : error('Nicht angemeldet.', 401);
  }
  return null;
}

async function asset(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  return env.ASSETS.fetch(new Request(url.toString(), { method: 'GET', headers: request.headers }));
}

async function routePage(request: Request, env: Env): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const routedPages = new Set([
    '/',
    '/index.html',
    '/login.html',
    '/upload.html',
    '/review.html',
    '/admin.html',
    '/analysis-import.html',
    '/account-setup.html',
  ]);
  if (!routedPages.has(pathname)) return null;
  if (pathname === '/account-setup.html') return asset(request, env, '/account-setup.html');

  const user = await sessionUser(request, env);
  if (pathname === '/' || pathname === '/index.html') {
    if (!user) return asset(request, env, '/login.html');
    return asset(request, env, user.canUpload ? '/upload.html' : '/review.html');
  }
  if (pathname === '/login.html') {
    return user ? redirect('/') : asset(request, env, '/login.html');
  }
  if (pathname === '/upload.html') {
    if (!user) return redirect('/login.html');
    return user.canUpload ? asset(request, env, '/upload.html') : redirect('/review.html');
  }
  if (pathname === '/review.html') {
    return user ? asset(request, env, '/review.html') : redirect('/login.html');
  }
  if (pathname === '/admin.html' || pathname === '/analysis-import.html') {
    if (!user) return redirect('/login.html');
    return redirect(user.canUpload ? '/upload.html' : '/review.html');
  }
  return null;
}

async function proxiedApiRequest(request: Request, env: Env): Promise<Request | Response> {
  if (bearerToken(request)) return request;
  const user = await sessionUser(request, env);
  if (!user) return request;

  const pathname = new URL(request.url).pathname;
  let secret: string | undefined;
  let actingReviewer: Role = user.role;
  const requestedReviewer = request.headers.get('x-truewords-reviewer');
  if (requestedReviewer === 'Philipp' || requestedReviewer === 'Lena') {
    if (requestedReviewer !== user.role && !user.canUpload) {
      return error('Dieses Konto darf den Prüfer nicht wechseln.', 403);
    }
    actingReviewer = requestedReviewer;
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!user.canUpload) return error('Nur Philipp darf Daten hochladen.', 403);
    secret = env.ADMIN_REVIEW_TOKEN;
  } else {
    secret = actingReviewer === 'Lena' ? env.LENA_REVIEW_TOKEN : env.PHILIPP_REVIEW_TOKEN;
  }
  if (!secret) return error('Serverzugang ist nicht vollständig konfiguriert.', 503);

  const headers = new Headers(request.headers);
  headers.delete('x-truewords-reviewer');
  headers.set('authorization', `Bearer ${secret}`);
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const authResponse = await authApi(request, env);
      if (authResponse) return authResponse;

      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        const proxied = await proxiedApiRequest(request, env);
        return proxied instanceof Response ? proxied : appWorker.fetch(proxied, env);
      }

      const page = await routePage(request, env);
      if (page) return page;
      return appWorker.fetch(request, env);
    } catch (caught) {
      console.error('Portal error', caught);
      return error('Interner Serverfehler.', 500);
    }
  },
};
