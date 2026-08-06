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
const PHILENA_PILOT_SOURCE = Object.freeze({
  datasetId: 'philena-2026-pilot-v2',
  sha256: '5bb863d1b1a68e0ada83933bc069fbb923cd4d98074308bcbdb47581b7791822',
  entries: 73_946,
});

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function validatePilotSource(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/import/start' || request.method !== 'POST') return null;

  let body: {
    datasetId?: unknown;
    datasetHash?: unknown;
    expectedMessages?: unknown;
  };
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }

  if (body.datasetId === ABORTED_DATASET_ID) {
    return json({
      ok: false,
      error: 'Test 1 ist wegen verlustbehafteter Bereinigung gesperrt. Verwende ausschließlich den neuen Test-2-Datensatz.',
      details: {
        pilotStatus: 'ABORTED_LOSSY_PREPROCESSING',
        requiredDatasetId: PHILENA_PILOT_SOURCE.datasetId,
      },
    }, 409);
  }

  if (body.datasetId !== PHILENA_PILOT_SOURCE.datasetId) return null;

  const hash = String(body.datasetHash || '').toLocaleLowerCase('en-US');
  const entries = Number(body.expectedMessages);
  const hashMatches = hash === PHILENA_PILOT_SOURCE.sha256;
  const countMatches = entries === PHILENA_PILOT_SOURCE.entries;
  if (hashMatches && countMatches) return null;

  return json({
    ok: false,
    error: 'Falsche Chatquelle für Test 2. Erforderlich ist der vollständige, unveränderte Telegram-Originalexport; eine bereinigte, gefilterte oder gekürzte Datei wird abgelehnt.',
    details: {
      sourceIntegrity: 'FAIL',
      expectedMessages: PHILENA_PILOT_SOURCE.entries,
      receivedMessages: Number.isFinite(entries) ? entries : null,
      expectedSha256: PHILENA_PILOT_SOURCE.sha256,
      receivedSha256: /^[a-f0-9]{64}$/iu.test(hash) ? hash : null,
    },
  }, 409);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const blocked = await validatePilotSource(request);
    if (blocked) return blocked;
    return reviewWorker.fetch(request, env);
  },
};
