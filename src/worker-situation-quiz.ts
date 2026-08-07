import baseWorker from './worker-review-precision';

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
type SessionRow = {
  id: number;
  email: string;
  role: Role;
  can_upload: number;
};
type QuizAnswer = {
  scenarioId: string;
  decision: 'same' | 'new';
};
type QuizRow = {
  answers_json: string;
  completed_at: string;
};

const SESSION_COOKIE = 'tw_review_session_v2';
const QUIZ_VERSION = 1;
const QUIZ_IDS = new Set([
  'q01', 'q02', 'q03', 'q04', 'q05',
  'q06', 'q07', 'q08', 'q09', 'q10',
]);
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

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
  });
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
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sessionUser(request: Request, env: Env): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/iu.test(token)) return null;
  const row = await env.DB.prepare(`
    SELECT u.id, u.email, u.role, u.can_upload
    FROM review_sessions s
    JOIN review_users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.is_active = 1
    LIMIT 1
  `).bind(await sha256Hex(token), new Date().toISOString()).first<SessionRow>();
  if (!row) return null;
  return {
    id: Number(row.id),
    email: String(row.email),
    role: row.role,
    canUpload: Number(row.can_upload) === 1,
  };
}

async function quizRow(env: Env, reviewer: Role): Promise<QuizRow | null> {
  return env.DB.prepare(`
    SELECT answers_json, completed_at
    FROM review_situation_quiz_results
    WHERE reviewer = ?1 AND quiz_version = ?2
    LIMIT 1
  `).bind(reviewer, QUIZ_VERSION).first<QuizRow>();
}

async function quizCompleted(env: Env, reviewer: Role): Promise<boolean> {
  return Boolean(await quizRow(env, reviewer));
}

async function asset(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  return env.ASSETS.fetch(new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
  }));
}

function validAnswers(value: unknown): value is QuizAnswer[] {
  if (!Array.isArray(value) || value.length !== QUIZ_IDS.size) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const candidate = item as Record<string, unknown>;
    const scenarioId = String(candidate.scenarioId || '');
    const decision = String(candidate.decision || '');
    if (!QUIZ_IDS.has(scenarioId) || !['same', 'new'].includes(decision)) return false;
    if (ids.has(scenarioId)) return false;
    ids.add(scenarioId);
  }
  return ids.size === QUIZ_IDS.size;
}

async function quizApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/situation-quiz/')) return null;

  const user = await sessionUser(request, env);
  if (!user) return error('Nicht angemeldet.', 401);

  if (url.pathname === '/api/situation-quiz/status' && request.method === 'GET') {
    const completed = await quizCompleted(env, user.role);
    return json({
      ok: true,
      quizVersion: QUIZ_VERSION,
      user: { role: user.role, email: user.email },
      required: user.role === 'Lena' && !completed,
      completed,
    });
  }

  if (url.pathname === '/api/situation-quiz/submit' && request.method === 'POST') {
    if (user.role !== 'Lena') return error('Dieses Quiz ist für Lena vorgesehen.', 403);
    const body = await request.json<{ answers?: unknown; note?: unknown }>();
    if (!validAnswers(body.answers)) {
      return error('Bitte alle zehn Verläufe eindeutig als gleiche oder neue Situation einordnen.');
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    const now = new Date().toISOString();
    const payload = {
      quizVersion: QUIZ_VERSION,
      answers: body.answers,
      note,
      submittedAt: now,
    };
    await env.DB.prepare(`
      INSERT INTO review_situation_quiz_results (
        reviewer, quiz_version, answers_json, completed_at, created_at, updated_at
      ) VALUES ('Lena', ?1, ?2, ?3, ?3, ?3)
      ON CONFLICT(reviewer, quiz_version) DO UPDATE SET
        answers_json = excluded.answers_json,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).bind(QUIZ_VERSION, JSON.stringify(payload), now).run();
    return json({ ok: true, completed: true, completedAt: now });
  }

  if (url.pathname === '/api/situation-quiz/result' && request.method === 'GET') {
    if (user.role !== 'Philipp') return error('Nur Philipp kann die Kalibrierung auswerten.', 403);
    const row = await quizRow(env, 'Lena');
    if (!row) return json({ ok: true, completed: false, quizVersion: QUIZ_VERSION });
    let result: unknown = null;
    try {
      result = JSON.parse(row.answers_json);
    } catch {
      result = { raw: row.answers_json };
    }
    return json({
      ok: true,
      completed: true,
      quizVersion: QUIZ_VERSION,
      completedAt: row.completed_at,
      result,
    });
  }

  return error('Quiz-Endpunkt nicht gefunden.', 404);
}

async function quizPageGate(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const pathname = new URL(request.url).pathname;
  if (!['/', '/index.html', '/review.html', '/situation-quiz.html'].includes(pathname)) return null;

  const user = await sessionUser(request, env);

  if (pathname === '/situation-quiz.html') {
    if (!user) return redirect('/login.html');
    if (user.role !== 'Lena') return redirect(user.canUpload ? '/upload.html' : '/review.html');
    if (await quizCompleted(env, 'Lena')) return redirect('/review.html');
    return asset(request, env, '/situation-quiz.html');
  }

  if (user?.role === 'Lena' && !(await quizCompleted(env, 'Lena'))) {
    return redirect('/situation-quiz.html');
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const apiResponse = await quizApi(request, env);
      if (apiResponse) return apiResponse;
      const pageResponse = await quizPageGate(request, env);
      if (pageResponse) return pageResponse;
      return baseWorker.fetch(request, env);
    } catch (caught) {
      console.error('Situation quiz worker failed', caught);
      return error('Das Situations-Quiz konnte serverseitig nicht verarbeitet werden.', 500);
    }
  },
};
