import baseWorker from './worker-source-integrity-v4';
import {
  pairSeams,
  agreementF1,
  cohensKappa,
  resolveMarks,
  compareReviewers,
  combinedBoundary,
  pickRoundStart,
  buildRoundView,
  agreementGate,
  toSegmentationInput,
  toPositionalResolutions,
} from '../boundary-pairs-logic.mjs';
import { segmentConversationWindow } from '../segmentation-v4.mjs';
import type { BoundaryMark, DoubtMode } from '../boundary-pairs-logic.d.mts';

/**
 * Doppelprüfung der Situationsgrenzen.
 *
 * Eigener, paralleler Datenpfad zum Eigentümermodell in worker-d1.ts: kein
 * Eigentümerbegriff, kein Merge, jeder Prüfer schreibt ausschließlich eigene
 * Zeilen. Konflikte sind dadurch konstruktionsbedingt ausgeschlossen.
 *
 * Blindheit ist eine Servereigenschaft: GET /api/rounds/:round liefert nie
 * die Markierungen der anderen Person, solange nicht beide abgegeben haben —
 * nur ob sie abgegeben hat.
 *
 * Der Prüfername kommt ausschließlich aus der vorhandenen Sessionprüfung
 * (tw_review_session_v2). review_users lässt darüber ohnehin nur Philipp
 * und Lena zu (siehe migrations/0004_email_auth.sql), ein Admin kann sich
 * hierüber nicht anmelden und daher auch nicht markieren.
 */

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

type DatasetRow = { id: string; year: number };

type RawMessage = Record<string, unknown>;

type ViewMessage = {
  id: string;
  from: string;
  t: number;
  text: string;
  kind: 'text' | 'medien' | 'anruf' | 'leer';
  /** Nur für die automatische Segmentierung: ohne die Antwortbeziehung
   *  schneidet sie mitten in laufenden Wechselreden. */
  replyToId?: string;
};

type RoundRow = {
  dataset_id: string;
  round: number;
  first_message_id: string;
  message_count: number;
};

type MarkRow = { seam_message_id: string; mark: 'cut' | 'doubt' };

type ResolutionRow = {
  seam_message_id: string;
  /** Durch CHECK in review_boundary_resolutions auf diese drei Werte begrenzt. */
  decision: 'cut' | 'no_cut' | 'open';
  note: string | null;
  decided_by: string;
  decided_at: string;
};

const SESSION_COOKIE = 'tw_review_session_v2';
const ROUND_WINDOW_SIZE = 100;
const MAX_MARKS_PER_ROUND = 60;
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

async function asset(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = '';
  return env.ASSETS.fetch(new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
  }));
}

// ------------------------------------------------------ gefilterte Folge

function rawId(message: RawMessage): string {
  const id = message.id;
  return id === undefined || id === null ? '' : String(id);
}

function flattenText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      return (part as { text: string }).text;
    }
    return '';
  }).join('');
}

function messageSeconds(message: RawMessage): number {
  const raw = (message.date_unixtime ?? message.date) as unknown;
  if (typeof raw === 'number') return raw > 1e12 ? Math.floor(raw / 1000) : raw;
  if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
    const value = Number(raw);
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function isForwarded(message: RawMessage): boolean {
  return Boolean(message.forwarded_from || message.forwarded_from_id || message.saved_from);
}

function isSticker(message: RawMessage): boolean {
  if (message.sticker_emoji) return true;
  return /sticker/u.test(String(message.media_type || '').toLowerCase());
}

function isCallAction(action: string): boolean {
  return /^(phone_call|video_call|voice_call)$/u.test(action.toLowerCase());
}

/** Service-Ereignisse (Beitritt, Pin, Namensänderung, …) — Anrufe zählen nicht dazu. */
function isService(message: RawMessage): boolean {
  const type = String(message.type || 'message');
  if (type === 'message') return false;
  const action = String(
    message.action || message.action_type || message.service_type || message.message_type || '',
  );
  return !isCallAction(action);
}

/** Ganzer Chat, ohne Weiterleitungen, Sticker und Service-Ereignisse — keine Jahresgrenze mehr. */
function isReviewable(message: RawMessage): boolean {
  return !isForwarded(message)
    && !isSticker(message)
    && !isService(message);
}

/** Reines Rauschen ganz ohne Zeitsignal: Sticker oder Umfrage ohne jeden Text. */
function isNoiseWithoutSignal(message: RawMessage): boolean {
  if (flattenText(message.text).trim()) return false;
  if (message.poll) return true;
  return isSticker(message);
}

/**
 * Weiter Filter für die Filter-Migrationsmessung (`/api/admin/filter-check`):
 * verwirft nur reines Rauschen ohne Zeitsignal und echte Verwaltungs-Ereignisse
 * (Beitritt, Pin, Namensänderung) — Anrufe, Medien und Weiterleitungen bleiben
 * drin. Ob sie an unseren Daten tatsächlich Grenzsignale sind, soll die Messung
 * zeigen, nicht eine Annahme aus der Hauptapp (die Anrufe z. B. verwirft).
 */
function isReviewableBroad(message: RawMessage): boolean {
  if (isNoiseWithoutSignal(message)) return false;
  const type = String(message.type || 'message');
  if (type !== 'message') {
    const action = String(
      message.action || message.action_type || message.service_type || message.message_type || '',
    );
    return isCallAction(action);
  }
  return true;
}

function toView(message: RawMessage): ViewMessage {
  const action = String(message.action || message.service_type || '').toLowerCase();
  const kind: ViewMessage['kind'] = isCallAction(action)
    ? 'anruf'
    : (message.photo || message.file || message.media_type || message.mime_type)
      ? 'medien'
      : (flattenText(message.text).trim() ? 'text' : 'leer');
  const replyTo = message.reply_to_message_id;
  return {
    id: rawId(message),
    from: String(message.from || message.actor || message.sender || '?'),
    t: messageSeconds(message),
    text: String(message.truewords_original_text || flattenText(message.text) || '').trim(),
    kind,
    ...(replyTo === undefined || replyTo === null ? {} : { replyToId: String(replyTo) }),
  };
}

async function filteredSequenceUsing(
  env: Env,
  datasetId: string,
  predicate: (message: RawMessage) => boolean,
): Promise<RawMessage[]> {
  const rows = await env.DB.prepare(`
    SELECT messages_json FROM review_chat_chunks WHERE dataset_id = ?1 ORDER BY chunk_index
  `).bind(datasetId).all<{ messages_json: string }>();

  const out: RawMessage[] = [];
  for (const row of rows.results || []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.messages_json);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const message of parsed) {
      if (message && typeof message === 'object' && predicate(message as RawMessage)) {
        out.push(message as RawMessage);
      }
    }
  }
  return out;
}

async function filteredSequence(env: Env, datasetId: string): Promise<RawMessage[]> {
  return filteredSequenceUsing(env, datasetId, isReviewable);
}

async function activeDataset(env: Env): Promise<DatasetRow | null> {
  return env.DB.prepare('SELECT id, year FROM review_datasets WHERE id = ?1 LIMIT 1')
    .bind(env.ACTIVE_DATASET_ID)
    .first<DatasetRow>();
}

// ------------------------------------------------------------- Runden

/**
 * Lädt (und legt bei Bedarf deterministisch an) das Fenster einer Runde.
 * Einmal in review_rounds gespeichert, wird der Startpunkt nie neu gezogen.
 */
async function loadRoundWindow(
  env: Env,
  dataset: DatasetRow,
  round: number,
): Promise<{ round: RoundRow; messages: ViewMessage[] }> {
  const sequence = await filteredSequence(env, dataset.id);
  if (sequence.length < ROUND_WINDOW_SIZE) {
    throw new Error('Die gefilterte Nachrichtenfolge ist kürzer als eine Runde.');
  }

  let row = await env.DB.prepare(`
    SELECT dataset_id, round, first_message_id, message_count
    FROM review_rounds WHERE dataset_id = ?1 AND round = ?2
  `).bind(dataset.id, round).first<RoundRow>();

  if (!row) {
    const otherRounds = await env.DB.prepare(`
      SELECT first_message_id, message_count FROM review_rounds WHERE dataset_id = ?1
    `).bind(dataset.id).all<{ first_message_id: string; message_count: number }>();

    const idIndex = new Map(sequence.map((message, index) => [rawId(message), index]));
    const existingRanges = (otherRounds.results || []).map((existing) => {
      const start = idIndex.get(existing.first_message_id);
      if (start === undefined) {
        throw new Error('Eine bestehende Runde ist in der aktuellen Nachrichtenfolge nicht mehr auffindbar.');
      }
      return { start, count: existing.message_count };
    });

    const start = pickRoundStart({
      datasetId: dataset.id,
      round,
      sequenceLength: sequence.length,
      windowSize: ROUND_WINDOW_SIZE,
      existingRanges,
    });
    const firstMessageId = rawId(sequence[start]);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO review_rounds (dataset_id, round, first_message_id, message_count, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(dataset_id, round) DO NOTHING
    `).bind(dataset.id, round, firstMessageId, ROUND_WINDOW_SIZE, now).run();

    row = await env.DB.prepare(`
      SELECT dataset_id, round, first_message_id, message_count
      FROM review_rounds WHERE dataset_id = ?1 AND round = ?2
    `).bind(dataset.id, round).first<RoundRow>();
  }
  if (!row) throw new Error('Runde konnte nicht angelegt werden.');

  const startIndex = sequence.findIndex((message) => rawId(message) === row!.first_message_id);
  if (startIndex < 0) {
    throw new Error('Der Startpunkt der Runde ist in der Nachrichtenfolge nicht mehr auffindbar.');
  }
  const messages = sequence.slice(startIndex, startIndex + row.message_count).map(toView);
  return { round: row, messages };
}

/** Zwischenraum-Position (1..n) je Nachrichten-ID danach, sowie die Umkehrung. */
function seamPositions(messages: ViewMessage[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let index = 1; index < messages.length; index += 1) map.set(messages[index].id, index);
  return map;
}

async function loadMarks(env: Env, datasetId: string, round: number, reviewer: Role): Promise<MarkRow[]> {
  const rows = await env.DB.prepare(`
    SELECT seam_message_id, mark FROM review_boundary_marks
    WHERE dataset_id = ?1 AND round = ?2 AND reviewer = ?3
  `).bind(datasetId, round, reviewer).all<MarkRow>();
  return rows.results || [];
}

async function submittedAt(env: Env, datasetId: string, round: number, reviewer: Role): Promise<string | null> {
  const row = await env.DB.prepare(`
    SELECT submitted_at FROM review_round_submissions WHERE dataset_id = ?1 AND round = ?2 AND reviewer = ?3
  `).bind(datasetId, round, reviewer).first<{ submitted_at: string }>();
  return row?.submitted_at ?? null;
}

function toPositionalMarks(rows: MarkRow[], positions: Map<string, number>): BoundaryMark[] {
  const out: BoundaryMark[] = [];
  for (const row of rows) {
    const position = positions.get(row.seam_message_id);
    if (position !== undefined) out.push({ position, mark: row.mark });
  }
  return out;
}

function parseTolerance(url: URL): number {
  const value = Number(url.searchParams.get('tol'));
  return [0, 1, 2].includes(value) ? value : 1;
}

function parseDoubtMode(url: URL): DoubtMode {
  const raw = url.searchParams.get('doubt');
  return raw === 'cut' || raw === 'none' ? raw : 'skip';
}

// -------------------------------------------------------------- Endpunkte

async function getRound(env: Env, dataset: DatasetRow, round: number, reviewer: Role): Promise<Response> {
  const { messages } = await loadRoundWindow(env, dataset, round);
  const [philippMarks, lenaMarks, philippSubmittedAt, lenaSubmittedAt] = await Promise.all([
    loadMarks(env, dataset.id, round, 'Philipp'),
    loadMarks(env, dataset.id, round, 'Lena'),
    submittedAt(env, dataset.id, round, 'Philipp'),
    submittedAt(env, dataset.id, round, 'Lena'),
  ]);

  const view = buildRoundView({
    reviewer,
    messages,
    philippMarks: philippMarks.map((row) => ({ seamMessageId: row.seam_message_id, mark: row.mark })),
    lenaMarks: lenaMarks.map((row) => ({ seamMessageId: row.seam_message_id, mark: row.mark })),
    philippSubmittedAt,
    lenaSubmittedAt,
  });
  return json({ round, ...view });
}

async function putMarks(request: Request, env: Env, dataset: DatasetRow, round: number, reviewer: Role): Promise<Response> {
  if (await submittedAt(env, dataset.id, round, reviewer)) {
    return error('Diese Runde ist bereits abgegeben und kann nicht mehr geändert werden.', 409);
  }

  let body: { marks?: unknown };
  try {
    body = await request.json();
  } catch {
    return error('Ungültige Anfrage.');
  }
  if (!Array.isArray(body.marks)) return error('Markierungen fehlen.');
  if (body.marks.length > MAX_MARKS_PER_ROUND) return error('Unplausibel viele Markierungen für eine Runde.', 422);

  const { messages } = await loadRoundWindow(env, dataset, round);
  const positions = seamPositions(messages);

  const seen = new Set<string>();
  const clean: { seamMessageId: string; mark: 'cut' | 'doubt' }[] = [];
  for (const raw of body.marks) {
    if (!raw || typeof raw !== 'object') return error('Ungültige Markierung.', 422);
    const entry = raw as Record<string, unknown>;
    const seamMessageId = String(entry.seamMessageId || '');
    const mark = String(entry.mark || '');
    if (!positions.has(seamMessageId)) return error(`Zwischenraum ${seamMessageId} liegt nicht in dieser Runde.`, 422);
    if (mark !== 'cut' && mark !== 'doubt') return error('Markierung muss cut oder doubt sein.', 422);
    if (seen.has(seamMessageId)) return error('Zwischenraum doppelt markiert.', 422);
    seen.add(seamMessageId);
    clean.push({ seamMessageId, mark });
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM review_boundary_marks WHERE dataset_id = ?1 AND round = ?2 AND reviewer = ?3')
      .bind(dataset.id, round, reviewer),
  ];
  for (const entry of clean) {
    statements.push(
      env.DB.prepare(`
        INSERT INTO review_boundary_marks
          (dataset_id, round, reviewer, seam_message_id, mark, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      `).bind(dataset.id, round, reviewer, entry.seamMessageId, entry.mark, now),
    );
  }
  await env.DB.batch(statements);

  return json({ ok: true, saved: clean.length });
}

async function submitRound(env: Env, dataset: DatasetRow, round: number, reviewer: Role): Promise<Response> {
  const existing = await submittedAt(env, dataset.id, round, reviewer);
  if (existing) return json({ ok: true, submitted: true, submittedAt: existing });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO review_round_submissions (dataset_id, round, reviewer, submitted_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(dataset_id, round, reviewer) DO NOTHING
  `).bind(dataset.id, round, reviewer, now).run();

  return json({ ok: true, submitted: true, submittedAt: now });
}

async function getAgreement(request: Request, env: Env, dataset: DatasetRow, round: number, reviewer: Role): Promise<Response> {
  const url = new URL(request.url);
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);

  const [philippSubmitted, lenaSubmitted] = await Promise.all([
    submittedAt(env, dataset.id, round, 'Philipp'),
    submittedAt(env, dataset.id, round, 'Lena'),
  ]);
  const gate = agreementGate({ reviewer, philippSubmittedAt: philippSubmitted, lenaSubmittedAt: lenaSubmitted });
  if (gate) {
    return json({
      ok: false,
      error: 'Der Vergleich wird erst freigeschaltet, wenn beide Prüfer abgegeben haben.',
      waitingFor: gate.waitingFor,
    }, 403);
  }

  const { messages } = await loadRoundWindow(env, dataset, round);
  const positions = seamPositions(messages);
  const positionToId = new Map<number, string>();
  for (const [id, position] of positions) positionToId.set(position, id);
  const totalSeams = Math.max(0, messages.length - 1);

  const [philippMarks, lenaMarks] = await Promise.all([
    loadMarks(env, dataset.id, round, 'Philipp'),
    loadMarks(env, dataset.id, round, 'Lena'),
  ]);
  const marksPhilipp = toPositionalMarks(philippMarks, positions);
  const marksLena = toPositionalMarks(lenaMarks, positions);

  const comparison = compareReviewers(marksPhilipp, marksLena, { totalSeams, tolerance, doubtMode });

  // Vor der gemeinsamen Fassung geladen: die geklärten Streitfälle gehören
  // hinein, sonst bliebe die Klärungsarbeit ohne Wirkung auf die Kennzahlen.
  const resolutionRows = await env.DB.prepare(`
    SELECT seam_message_id, decision, note, decided_by, decided_at
    FROM review_boundary_resolutions WHERE dataset_id = ?1 AND round = ?2
  `).bind(dataset.id, round).all<ResolutionRow>();
  const resolutionList = resolutionRows.results || [];
  const resolutions = new Map(resolutionList.map((row) => [row.seam_message_id, row]));
  const combined = combinedBoundary(comparison, toPositionalResolutions(resolutionList, positions));

  const automaticResult = segmentConversationWindow(
    toSegmentationInput(messages),
  );
  const automaticPositions = automaticResult.boundaries
    .map((boundary) => positions.get(boundary.beforeEventId))
    .filter((position): position is number => position !== undefined);
  const cutsPhilipp = resolveMarks(marksPhilipp, doubtMode).cuts;
  const cutsLena = resolveMarks(marksLena, doubtMode).cuts;
  const vsPhilipp = pairSeams(automaticPositions, cutsPhilipp, tolerance);
  const vsLena = pairSeams(automaticPositions, cutsLena, tolerance);
  const vsCombined = pairSeams(automaticPositions, combined.cuts, tolerance);

  const philippByPosition = new Map(marksPhilipp.map((mark) => [mark.position, mark.mark]));
  const lenaByPosition = new Map(marksLena.map((mark) => [mark.position, mark.mark]));

  /** Wer hat diesen Zwischenraum wie markiert — für die Anzeige im Kontext um einen Streitfall. */
  function seamMarks(position: number) {
    return {
      position,
      seamMessageId: positionToId.get(position) as string,
      philipp: philippByPosition.get(position) || null,
      lena: lenaByPosition.get(position) || null,
    };
  }

  /** Nachrichten vor und nach der strittigen Naht. Genug, dass der
   *  Gesprächsverlauf beurteilbar ist, ohne die halbe Runde zu wiederholen. */
  const CONTEXT_RADIUS = 6;

  function disputeEntry(position: number, setBy: Role) {
    const seamMessageId = positionToId.get(position) as string;
    const before = messages[position - 1];
    const after = messages[position];
    const resolution = resolutions.get(seamMessageId);

    const contextStart = Math.max(0, position - CONTEXT_RADIUS);
    const contextEnd = Math.min(messages.length, position + CONTEXT_RADIUS);
    const context = messages.slice(contextStart, contextEnd);
    const seams = [];
    for (let seamPosition = contextStart + 1; seamPosition <= contextEnd - 1; seamPosition += 1) {
      seams.push(seamMarks(seamPosition));
    }

    return {
      seamMessageId,
      position,
      setBy,
      before,
      after,
      context,
      seams,
      pauseSeconds: Math.max(0, after.t - before.t),
      decision: resolution?.decision || 'open',
      note: resolution?.note || '',
      decidedBy: resolution?.decided_by || null,
      decidedAt: resolution?.decided_at || null,
    };
  }

  // Offene Streitfälle zuerst, geklärte ans Ende — serverseitig sortiert,
  // damit beide Partner exakt dieselbe Reihenfolge sehen.
  const disputes = [
    ...comparison.onlyA.map((position) => disputeEntry(position, 'Philipp')),
    ...comparison.onlyB.map((position) => disputeEntry(position, 'Lena')),
  ].sort((a, b) => {
    const aResolved = a.decision !== 'open' ? 1 : 0;
    const bResolved = b.decision !== 'open' ? 1 : 0;
    if (aResolved !== bResolved) return aResolved - bResolved;
    return a.position - b.position;
  });

  return json({
    ok: true,
    round,
    reviewer,
    tolerance,
    doubtMode,
    n: comparison.n,
    agreementF1: comparison.agreementF1,
    kappa: comparison.kappa,
    automatic: {
      vsPhilipp: { agreementF1: agreementF1(vsPhilipp), kappa: cohensKappa(vsPhilipp, totalSeams) },
      vsLena: { agreementF1: agreementF1(vsLena), kappa: cohensKappa(vsLena, totalSeams) },
      vsCombined: { agreementF1: agreementF1(vsCombined), kappa: cohensKappa(vsCombined, totalSeams) },
    },
    // Roh-Diagnose: wie viele Grenzen die Automatik überhaupt gesetzt hat, unabhängig
    // vom Vergleich. 0 bei >0 menschlichen Grenzen erklärt sofort eine 0.00-Übereinstimmung.
    automaticRaw: { boundaryCount: automaticResult.boundaries.length, totalSeams },
    messages,
    combined: {
      cuts: combined.cuts.map((position) => positionToId.get(position)).filter(Boolean),
      uncertain: combined.uncertain.map((position) => positionToId.get(position)).filter(Boolean),
    },
    disputes,
  });
}

async function resolveDispute(request: Request, env: Env, dataset: DatasetRow, round: number, reviewer: Role): Promise<Response> {
  const [philippSubmitted, lenaSubmitted] = await Promise.all([
    submittedAt(env, dataset.id, round, 'Philipp'),
    submittedAt(env, dataset.id, round, 'Lena'),
  ]);
  const gate = agreementGate({ reviewer, philippSubmittedAt: philippSubmitted, lenaSubmittedAt: lenaSubmitted });
  if (gate) {
    return json({
      ok: false,
      error: 'Streitfälle können erst geklärt werden, wenn beide Prüfer abgegeben haben.',
      waitingFor: gate.waitingFor,
    }, 403);
  }

  let body: { seamMessageId?: unknown; decision?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return error('Ungültige Anfrage.');
  }
  const seamMessageId = String(body.seamMessageId || '');
  const decision = String(body.decision || '');
  if (!['cut', 'no_cut', 'open'].includes(decision)) return error('Ungültige Entscheidung.', 422);

  const { messages } = await loadRoundWindow(env, dataset, round);
  const positions = seamPositions(messages);
  if (!positions.has(seamMessageId)) return error('Dieser Zwischenraum liegt nicht in dieser Runde.', 422);

  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO review_boundary_resolutions
      (dataset_id, round, seam_message_id, decision, note, decided_by, decided_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(dataset_id, round, seam_message_id) DO UPDATE SET
      decision = excluded.decision,
      note = excluded.note,
      decided_by = excluded.decided_by,
      decided_at = excluded.decided_at
  `).bind(dataset.id, round, seamMessageId, decision, note, reviewer, now).run();

  return json({ ok: true, seamMessageId, decision, note, decidedBy: reviewer, decidedAt: now });
}

async function getSummary(env: Env, dataset: DatasetRow, reviewer: Role, url: URL): Promise<Response> {
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);

  const submissionRows = await env.DB.prepare(`
    SELECT round, reviewer FROM review_round_submissions WHERE dataset_id = ?1
  `).bind(dataset.id).all<{ round: number; reviewer: Role }>();
  const byRound = new Map<number, Set<Role>>();
  for (const row of submissionRows.results || []) {
    if (!byRound.has(row.round)) byRound.set(row.round, new Set());
    byRound.get(row.round)?.add(row.reviewer);
  }
  const readyRounds = [...byRound.entries()]
    .filter(([, reviewers]) => reviewers.has('Philipp') && reviewers.has('Lena'))
    .map(([round]) => round)
    .sort((a, b) => a - b);

  let totalPairs = 0;
  let totalOnlyPhilipp = 0;
  let totalOnlyLena = 0;
  let totalAutoPairs = 0;
  let totalAutoOnlyAuto = 0;
  let totalAutoOnlyCombined = 0;
  let openDisputes = 0;
  let resolvedDisputes = 0;
  let totalAutomaticBoundaries = 0;
  const perRound: Array<{
    round: number;
    philippCuts: number;
    lenaCuts: number;
    agreementF1: number;
    kappa: number;
    disputes: number;
    resolved: number;
    automaticBoundaryCount: number;
  }> = [];

  for (const round of readyRounds) {
    const { messages } = await loadRoundWindow(env, dataset, round);
    const positions = seamPositions(messages);
    const totalSeams = Math.max(0, messages.length - 1);
    const [philippMarks, lenaMarks] = await Promise.all([
      loadMarks(env, dataset.id, round, 'Philipp'),
      loadMarks(env, dataset.id, round, 'Lena'),
    ]);
    const comparison = compareReviewers(
      toPositionalMarks(philippMarks, positions),
      toPositionalMarks(lenaMarks, positions),
      { totalSeams, tolerance, doubtMode },
    );
    // Vor der gemeinsamen Fassung geladen: die geklärten Streitfälle gehören
    // hinein, sonst bliebe die Klärungsarbeit ohne Wirkung auf die Kennzahlen.
    const resolutionRows = await env.DB.prepare(`
      SELECT seam_message_id, decision FROM review_boundary_resolutions
      WHERE dataset_id = ?1 AND round = ?2
    `).bind(dataset.id, round).all<{ seam_message_id: string; decision: 'cut' | 'no_cut' | 'open' }>();
    const resolutionList = resolutionRows.results || [];
    const combined = combinedBoundary(comparison, toPositionalResolutions(resolutionList, positions));

    const automaticResult = segmentConversationWindow(
      toSegmentationInput(messages),
    );
    const automaticPositions = automaticResult.boundaries
      .map((boundary) => positions.get(boundary.beforeEventId))
      .filter((position): position is number => position !== undefined);
    const vsCombined = pairSeams(automaticPositions, combined.cuts, tolerance);

    totalPairs += comparison.pairs.length;
    totalOnlyPhilipp += comparison.onlyA.length;
    totalOnlyLena += comparison.onlyB.length;
    totalAutoPairs += vsCombined.pairs.length;
    totalAutoOnlyAuto += vsCombined.onlyA.length;
    totalAutoOnlyCombined += vsCombined.onlyB.length;
    totalAutomaticBoundaries += automaticResult.boundaries.length;

    const resolvedCount = resolutionList.filter((row) => row.decision !== 'open').length;
    const disputeCount = comparison.onlyA.length + comparison.onlyB.length;
    openDisputes += Math.max(0, disputeCount - resolvedCount);
    resolvedDisputes += resolvedCount;

    perRound.push({
      round,
      philippCuts: comparison.pairs.length + comparison.onlyA.length,
      lenaCuts: comparison.pairs.length + comparison.onlyB.length,
      agreementF1: comparison.agreementF1,
      kappa: comparison.kappa,
      disputes: disputeCount,
      resolved: resolvedCount,
      automaticBoundaryCount: automaticResult.boundaries.length,
    });
  }

  const humanTotal = 2 * totalPairs + totalOnlyPhilipp + totalOnlyLena;
  const autoTotal = 2 * totalAutoPairs + totalAutoOnlyAuto + totalAutoOnlyCombined;

  return json({
    ok: true,
    reviewer,
    tolerance,
    doubtMode,
    roundsReady: readyRounds.length,
    combinedBoundaries: totalPairs,
    lowData: totalPairs < 40,
    agreementF1: humanTotal ? (2 * totalPairs) / humanTotal : null,
    automaticVsCombined: {
      agreementF1: autoTotal ? (2 * totalAutoPairs) / autoTotal : null,
    },
    automaticBoundariesTotal: totalAutomaticBoundaries,
    disputes: { open: openDisputes, resolved: resolvedDisputes },
    perRound,
  });
}

/**
 * Nur-Lese-Kennzahlen zur Filter-Migration (`isReviewable` → `isReviewableBroad`):
 * ausschließlich Zählungen. Kein Nachrichtentext, kein Name — auch nicht, um ihn
 * intern zu lesen und wegzulassen; die Runden-Fenster werden nur über IDs und
 * Positionen verglichen.
 */
async function getFilterMigrationCheck(env: Env, dataset: DatasetRow, url: URL): Promise<Response> {
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);

  const [oldSequence, newSequence] = await Promise.all([
    filteredSequenceUsing(env, dataset.id, isReviewable),
    filteredSequenceUsing(env, dataset.id, isReviewableBroad),
  ]);
  const oldIds = new Set(oldSequence.map(rawId));
  const newIds = new Set(newSequence.map(rawId));
  let addedByNew = 0;
  let removedByNew = 0;
  for (const id of newIds) if (!oldIds.has(id)) addedByNew += 1;
  for (const id of oldIds) if (!newIds.has(id)) removedByNew += 1;

  const oldIndex = new Map(oldSequence.map((message, index) => [rawId(message), index]));
  const newIndex = new Map(newSequence.map((message, index) => [rawId(message), index]));

  const roundRows = await env.DB.prepare(`
    SELECT dataset_id, round, first_message_id, message_count FROM review_rounds
    WHERE dataset_id = ?1 ORDER BY round
  `).bind(dataset.id).all<RoundRow>();
  const rounds = roundRows.results || [];

  const submissionRows = await env.DB.prepare(`
    SELECT round, reviewer FROM review_round_submissions WHERE dataset_id = ?1
  `).bind(dataset.id).all<{ round: number; reviewer: Role }>();
  const readyByRound = new Map<number, Set<Role>>();
  for (const row of submissionRows.results || []) {
    if (!readyByRound.has(row.round)) readyByRound.set(row.round, new Set());
    readyByRound.get(row.round)?.add(row.reviewer);
  }

  const failedRounds: number[] = [];
  let disputesTotal = 0;
  let disputesStillMatched = 0;
  // Grenzsignal-Zähler je Ereignisart. `all` ist die Vergleichsbasis: dieselbe
  // Messung über ALLE Nachrichten, damit „häufiger als eine beliebige
  // Nachricht" für jede Richtung und Toleranz sauber definiert ist.
  //  - endsSituation: Grenze unmittelbar NACH dem Ereignis (Ereignis schließt ab)
  //  - startsSituation: Grenze unmittelbar DAVOR (Ereignis eröffnet)
  // tol0 = exakte Naht, tol1 = ±1-Naht-Fenster.
  type SignalBucket = {
    total: number;
    endsTol0: number; endsTol1: number;
    startsTol0: number; startsTol1: number;
  };
  const emptyBucket = (): SignalBucket => ({
    total: 0, endsTol0: 0, endsTol1: 0, startsTol0: 0, startsTol1: 0,
  });
  const signal = { call: emptyBucket(), media: emptyBucket(), all: emptyBucket() };
  let oldPairs = 0, oldOnlyAuto = 0, oldOnlyHuman = 0, oldBoundaryTotal = 0;
  let newPairs = 0, newOnlyAuto = 0, newOnlyHuman = 0, newBoundaryTotal = 0;
  let roundsCompared = 0;

  for (const roundRow of rounds) {
    const oldStart = oldIndex.get(roundRow.first_message_id);
    const newStart = newIndex.get(roundRow.first_message_id);
    if (newStart === undefined) failedRounds.push(roundRow.round);
    if (oldStart === undefined) continue;

    const ready = readyByRound.get(roundRow.round);
    if (!ready || !ready.has('Philipp') || !ready.has('Lena')) continue;

    const oldMessages = oldSequence.slice(oldStart, oldStart + roundRow.message_count).map(toView);
    const oldPositions = seamPositions(oldMessages);

    const [philippMarks, lenaMarks, resolutionRows] = await Promise.all([
      loadMarks(env, dataset.id, roundRow.round, 'Philipp'),
      loadMarks(env, dataset.id, roundRow.round, 'Lena'),
      env.DB.prepare(`
        SELECT seam_message_id, decision FROM review_boundary_resolutions
        WHERE dataset_id = ?1 AND round = ?2
      `).bind(dataset.id, roundRow.round).all<{ seam_message_id: string; decision: 'cut' | 'no_cut' | 'open' }>(),
    ]);
    const resolutionList = resolutionRows.results || [];
    const oldComparison = compareReviewers(
      toPositionalMarks(philippMarks, oldPositions),
      toPositionalMarks(lenaMarks, oldPositions),
      { totalSeams: Math.max(0, oldMessages.length - 1), tolerance, doubtMode },
    );
    const oldCombined = combinedBoundary(oldComparison, toPositionalResolutions(resolutionList, oldPositions));

    disputesTotal += oldComparison.onlyA.length + oldComparison.onlyB.length;
    if (newStart !== undefined) {
      const newPositionsForDisputes = seamPositions(newSequence.slice(newStart, newStart + roundRow.message_count).map(toView));
      const oldPositionToId = new Map<number, string>();
      for (const [id, position] of oldPositions) oldPositionToId.set(position, id);
      for (const position of [...oldComparison.onlyA, ...oldComparison.onlyB]) {
        const seamId = oldPositionToId.get(position);
        if (seamId && newPositionsForDisputes.has(seamId)) disputesStillMatched += 1;
      }
    }

    // Nahtposition p = Lücke zwischen Nachricht[p-1] und Nachricht[p]; eine
    // kombinierte Grenze bei p heißt: Nachricht[p] beginnt eine neue Situation.
    // Für Nachricht[index]: Naht danach = index+1, Naht davor = index.
    const cuts = oldCombined.cuts;
    const cutWithin = (lo: number, hi: number): boolean => {
      for (const cut of cuts) if (cut >= lo && cut <= hi) return true;
      return false;
    };
    for (let index = 0; index < oldMessages.length; index += 1) {
      const endSeam = index + 1;
      const startSeam = index;
      const bump = (bucket: SignalBucket): void => {
        bucket.total += 1;
        if (cutWithin(endSeam, endSeam)) bucket.endsTol0 += 1;
        if (cutWithin(endSeam - 1, endSeam + 1)) bucket.endsTol1 += 1;
        if (cutWithin(startSeam, startSeam)) bucket.startsTol0 += 1;
        if (cutWithin(startSeam - 1, startSeam + 1)) bucket.startsTol1 += 1;
      };
      bump(signal.all);
      const kind = oldMessages[index].kind;
      if (kind === 'anruf') bump(signal.call);
      else if (kind === 'medien') bump(signal.media);
    }

    const oldAuto = segmentConversationWindow(toSegmentationInput(oldMessages));
    const oldAutoPositions = oldAuto.boundaries
      .map((boundary) => oldPositions.get(boundary.beforeEventId))
      .filter((position): position is number => position !== undefined);
    const oldVsCombined = pairSeams(oldAutoPositions, oldCombined.cuts, tolerance);
    oldPairs += oldVsCombined.pairs.length;
    oldOnlyAuto += oldVsCombined.onlyA.length;
    oldOnlyHuman += oldVsCombined.onlyB.length;
    oldBoundaryTotal += oldAuto.boundaries.length;

    if (newStart === undefined) continue;
    roundsCompared += 1;
    const newMessages = newSequence.slice(newStart, newStart + roundRow.message_count).map(toView);
    const newPositions = seamPositions(newMessages);
    const newComparison = compareReviewers(
      toPositionalMarks(philippMarks, newPositions),
      toPositionalMarks(lenaMarks, newPositions),
      { totalSeams: Math.max(0, newMessages.length - 1), tolerance, doubtMode },
    );
    const newCombined = combinedBoundary(newComparison, toPositionalResolutions(resolutionList, newPositions));
    const newAuto = segmentConversationWindow(toSegmentationInput(newMessages));
    const newAutoPositions = newAuto.boundaries
      .map((boundary) => newPositions.get(boundary.beforeEventId))
      .filter((position): position is number => position !== undefined);
    const newVsCombined = pairSeams(newAutoPositions, newCombined.cuts, tolerance);
    newPairs += newVsCombined.pairs.length;
    newOnlyAuto += newVsCombined.onlyA.length;
    newOnlyHuman += newVsCombined.onlyB.length;
    newBoundaryTotal += newAuto.boundaries.length;
  }

  const f1 = (pairs: number, onlyA: number, onlyB: number): number | null => {
    const denominator = 2 * pairs + onlyA + onlyB;
    return denominator ? (2 * pairs) / denominator : null;
  };

  const rate = (matched: number, total: number): number | null => (total ? matched / total : null);
  const signalReport = (bucket: SignalBucket) => ({
    total: bucket.total,
    endsSituation: {
      tol0: { count: bucket.endsTol0, rate: rate(bucket.endsTol0, bucket.total) },
      tol1: { count: bucket.endsTol1, rate: rate(bucket.endsTol1, bucket.total) },
    },
    startsSituation: {
      tol0: { count: bucket.startsTol0, rate: rate(bucket.startsTol0, bucket.total) },
      tol1: { count: bucket.startsTol1, rate: rate(bucket.startsTol1, bucket.total) },
    },
  });

  return json({
    ok: true,
    tolerance,
    doubtMode,
    messageCounts: {
      old: oldSequence.length,
      new: newSequence.length,
      addedByNew,
      removedByNew,
    },
    rounds: {
      total: rounds.length,
      loadOk: rounds.length - failedRounds.length,
      failedRounds,
      readyRoundsCompared: roundsCompared,
    },
    disputes: {
      total: disputesTotal,
      stillMatched: disputesStillMatched,
    },
    automatic: {
      old: { agreementF1: f1(oldPairs, oldOnlyAuto, oldOnlyHuman), boundariesTotal: oldBoundaryTotal },
      new: { agreementF1: f1(newPairs, newOnlyAuto, newOnlyHuman), boundariesTotal: newBoundaryTotal },
    },
    boundarySignal: {
      note: 'endsSituation = Grenze direkt nach dem Ereignis, startsSituation = Grenze direkt davor; tol0 exakt, tol1 ±1 Naht. rate mit baseline derselben Richtung/Toleranz vergleichen.',
      calls: signalReport(signal.call),
      media: signalReport(signal.media),
      baseline: {
        endsSituation: {
          tol0: rate(signal.all.endsTol0, signal.all.total),
          tol1: rate(signal.all.endsTol1, signal.all.total),
        },
        startsSituation: {
          tol0: rate(signal.all.startsTol0, signal.all.total),
          tol1: rate(signal.all.startsTol1, signal.all.total),
        },
      },
    },
  });
}

// ----------------------------------------------------------- Verdrahtung

async function boundaryPairsApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !url.pathname.startsWith('/api/rounds/')
    && url.pathname !== '/api/agreement/summary'
    && url.pathname !== '/api/admin/filter-check'
  ) return null;

  const user = await sessionUser(request, env);
  if (!user) return error('Nicht angemeldet.', 401);

  const dataset = await activeDataset(env);
  if (!dataset) return error('Kein aktiver Prüfdatenbestand.', 404);

  try {
    if (url.pathname === '/api/agreement/summary' && request.method === 'GET') {
      return await getSummary(env, dataset, user.role, url);
    }

    if (url.pathname === '/api/admin/filter-check' && request.method === 'GET') {
      return await getFilterMigrationCheck(env, dataset, url);
    }

    const match = url.pathname.match(/^\/api\/rounds\/(\d+)(\/marks|\/submit|\/agreement|\/resolve)?$/u);
    if (!match) return error('Endpunkt nicht gefunden.', 404);
    const round = Number(match[1]);
    if (!Number.isInteger(round) || round < 1) return error('Ungültige Runde.', 422);
    const suffix = match[2] || '';

    if (suffix === '' && request.method === 'GET') return await getRound(env, dataset, round, user.role);
    if (suffix === '/marks' && request.method === 'PUT') return await putMarks(request, env, dataset, round, user.role);
    if (suffix === '/submit' && request.method === 'POST') return await submitRound(env, dataset, round, user.role);
    if (suffix === '/agreement' && request.method === 'GET') return await getAgreement(request, env, dataset, round, user.role);
    if (suffix === '/resolve' && request.method === 'POST') return await resolveDispute(request, env, dataset, round, user.role);
    return error('Endpunkt nicht gefunden.', 404);
  } catch (caught) {
    console.error('Boundary pairs API error', caught);
    return error(caught instanceof Error ? caught.message : 'Runde konnte nicht verarbeitet werden.', 500);
  }
}

async function boundaryPairsPageGate(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (new URL(request.url).pathname !== '/doppelpruefung.html') return null;
  const user = await sessionUser(request, env);
  if (!user) return redirect('/login.html');
  return asset(request, env, '/doppelpruefung.html');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const apiResponse = await boundaryPairsApi(request, env);
      if (apiResponse) return apiResponse;
      const pageResponse = await boundaryPairsPageGate(request, env);
      if (pageResponse) return pageResponse;
      return baseWorker.fetch(request, env);
    } catch (caught) {
      console.error('Boundary pairs worker failed', caught);
      return error('Die Doppelprüfung konnte serverseitig nicht verarbeitet werden.', 500);
    }
  },
};
