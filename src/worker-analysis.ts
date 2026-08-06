import baseWorker from './worker-chunked';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
}

type Owner = 'Philipp' | 'Lena';

type Situation = {
  id: number;
  label?: string;
  note?: string;
  kind?: string;
  status?: string;
  createdAt?: string;
  sourceStartId?: string | number;
  [key: string]: unknown;
};

type OwnerAssignment = {
  schemaVersion?: unknown;
  strategy?: unknown;
  oddSituationOwner?: unknown;
  owners?: unknown;
};

type AnnotationPayload = {
  schemaVersion: string;
  datasetHash?: string;
  datasetLabel?: string;
  reviewer?: string;
  exportedAt?: string;
  situations: Situation[];
  assignments: Record<string, number>;
  owners?: Record<string, Owner>;
  ownerAssignment?: OwnerAssignment;
  events?: unknown[];
  preselection?: unknown;
  [key: string]: unknown;
};

type DatasetRow = {
  id: string;
  name: string;
  dataset_hash: string;
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

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{2,79}$/i.test(value);
}

function isAnnotationPayload(value: unknown): value is AnnotationPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<AnnotationPayload>;
  return (
    typeof payload.schemaVersion === 'string'
    && Array.isArray(payload.situations)
    && !!payload.assignments
    && typeof payload.assignments === 'object'
  );
}

function normalizeAnnotations(payload: AnnotationPayload, dataset: DatasetRow): AnnotationPayload {
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

  const ids = new Set(situations.map((situation) => situation.id));
  const assignments = Object.fromEntries(
    Object.entries(payload.assignments)
      .map(([messageId, situationId]) => [String(messageId), Number(situationId)] as const)
      .filter(([, situationId]) => ids.has(situationId)),
  );

  return {
    ...payload,
    schemaVersion: payload.schemaVersion,
    datasetHash: dataset.dataset_hash,
    datasetLabel: dataset.name,
    situations,
    assignments,
    events: Array.isArray(payload.events) ? payload.events.slice(-2000) : [],
  };
}

function chronologicalSituations(situations: Situation[]): Situation[] {
  return [...situations].sort((left, right) => {
    const leftStart = Number(left.sourceStartId);
    const rightStart = Number(right.sourceStartId);
    if (Number.isFinite(leftStart) && Number.isFinite(rightStart) && leftStart !== rightStart) {
      return leftStart - rightStart;
    }
    return Number(left.id) - Number(right.id);
  });
}

function expectedOwners(situations: Situation[]): Record<string, Owner> {
  const sorted = chronologicalSituations(situations);
  const splitAt = Math.ceil(sorted.length / 2);
  return Object.fromEntries(
    sorted.map((situation, index) => [
      String(situation.id),
      index < splitAt ? 'Philipp' : 'Lena',
    ]),
  );
}

function explicitOwners(payload: AnnotationPayload): Record<string, Owner> | null {
  const assignment = payload.ownerAssignment;
  if (!assignment) return null;
  if (
    assignment.schemaVersion !== 'truewords-owner-assignment/v1'
    || assignment.strategy !== 'chronological-half-split'
    || assignment.oddSituationOwner !== 'Philipp'
    || !assignment.owners
    || typeof assignment.owners !== 'object'
    || Array.isArray(assignment.owners)
  ) {
    throw new Error('Die Prüfaufteilung in der KI-Datei ist ungültig.');
  }

  const supplied = assignment.owners as Record<string, unknown>;
  const expected = expectedOwners(payload.situations);
  const expectedIds = Object.keys(expected).sort();
  const suppliedIds = Object.keys(supplied).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(suppliedIds)) {
    throw new Error('Die Prüfaufteilung deckt nicht exakt alle Situationen ab.');
  }

  for (const [id, owner] of Object.entries(expected)) {
    if (supplied[id] !== owner) {
      throw new Error(`Situation ${id} ist nicht gemäß Halbteilungsregel ${owner} zugeordnet.`);
    }
    if (payload.owners?.[id] && payload.owners[id] !== owner) {
      throw new Error(`Die Owner-Angaben für Situation ${id} widersprechen sich.`);
    }
  }
  return expected;
}

function ownersFor(payload: AnnotationPayload): {
  owners: Record<string, Owner>;
  source: 'explicit-owner-assignment' | 'legacy-half-split';
} {
  const explicit = explicitOwners(payload);
  return explicit
    ? { owners: explicit, source: 'explicit-owner-assignment' }
    : { owners: expectedOwners(payload.situations), source: 'legacy-half-split' };
}

async function importAnalysisVersion(request: Request, env: Env): Promise<Response> {
  if (!(await secretEquals(bearerToken(request), env.ADMIN_REVIEW_TOKEN))) {
    return error('Nur der Admin darf Analyseversionen einspielen.', 403);
  }

  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > 2_000_000) return error('Analyseversion ist größer als 2 MB.', 413);

  const body = await request.json<{
    datasetId?: unknown;
    versionId?: unknown;
    label?: unknown;
    source?: unknown;
    parameters?: unknown;
    annotations?: unknown;
  }>();

  if (!validId(body.datasetId)) return error('Ungültige Datensatz-ID.');
  if (!validId(body.versionId)) return error('Ungültige Versions-ID.');
  if (!isAnnotationPayload(body.annotations)) return error('Ungültige Vorschlagsdatei.');

  const dataset = await env.DB.prepare(`
    SELECT id, name, dataset_hash FROM review_datasets WHERE id = ?1 LIMIT 1
  `).bind(body.datasetId).first<DatasetRow>();
  if (!dataset) return error('Der Rohchat-Datensatz wurde nicht gefunden.', 404);

  let annotations: AnnotationPayload;
  let ownerResult: ReturnType<typeof ownersFor>;
  try {
    annotations = normalizeAnnotations(body.annotations, dataset);
    ownerResult = ownersFor(annotations);
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : 'Prüfaufteilung ist ungültig.', 409);
  }

  if (!annotations.situations.length) return error('Die Vorschlagsdatei enthält keine Situationen.');
  if (!Object.keys(annotations.assignments).length) return error('Die Vorschlagsdatei enthält keine Zuordnungen.');

  annotations.ownerAssignment = {
    schemaVersion: 'truewords-owner-assignment/v1',
    strategy: 'chronological-half-split',
    oddSituationOwner: 'Philipp',
    situationCount: annotations.situations.length,
    splitIndex: Math.ceil(annotations.situations.length / 2),
    owners: ownerResult.owners,
  };
  annotations.owners = ownerResult.owners;

  const label = String(body.label || body.versionId).slice(0, 240);
  const source = String(body.source || 'pilot-v1').slice(0, 120);
  const parameters = body.parameters && typeof body.parameters === 'object'
    ? body.parameters
    : annotations.preselection || {};
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE review_analysis_versions SET is_active = 0
      WHERE dataset_id = ?1
    `).bind(dataset.id),
    env.DB.prepare(`
      INSERT INTO review_analysis_versions (
        id, dataset_id, label, source, schema_version, parameters_json,
        annotations_json, is_active, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)
      ON CONFLICT(id) DO UPDATE SET
        dataset_id = excluded.dataset_id,
        label = excluded.label,
        source = excluded.source,
        schema_version = excluded.schema_version,
        parameters_json = excluded.parameters_json,
        annotations_json = excluded.annotations_json,
        is_active = 1,
        updated_at = excluded.updated_at
    `).bind(
      body.versionId,
      dataset.id,
      label,
      source,
      annotations.schemaVersion,
      JSON.stringify(parameters),
      JSON.stringify(annotations),
      now,
    ),
    env.DB.prepare(`
      UPDATE review_datasets
      SET annotations_json = ?1, owners_json = ?2, revision = revision + 1, updated_at = ?3
      WHERE id = ?4
    `).bind(JSON.stringify(annotations), JSON.stringify(ownerResult.owners), now, dataset.id),
    env.DB.prepare(`
      INSERT INTO review_events (dataset_id, reviewer, action, payload_json)
      VALUES (?1, 'Admin', 'analysis_version_activated', ?2)
    `).bind(dataset.id, JSON.stringify({
      versionId: body.versionId,
      label,
      source,
      situations: annotations.situations.length,
      assignments: Object.keys(annotations.assignments).length,
      ownerAssignmentSource: ownerResult.source,
      owners: ownerResult.owners,
    })),
  ]);

  return json({
    ok: true,
    datasetId: dataset.id,
    versionId: body.versionId,
    label,
    situations: annotations.situations.length,
    assignments: Object.keys(annotations.assignments).length,
    ownerAssignmentSource: ownerResult.source,
    split: {
      Philipp: Object.values(ownerResult.owners).filter((owner) => owner === 'Philipp').length,
      Lena: Object.values(ownerResult.owners).filter((owner) => owner === 'Lena').length,
    },
  }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/admin/analysis-versions/import' && request.method === 'POST') {
        return importAnalysisVersion(request, env);
      }
      return baseWorker.fetch(request, env);
    } catch (caught) {
      console.error('Analysis version import error', caught);
      return error('Interner Serverfehler beim Import der Analyseversion.', 500);
    }
  },
};
