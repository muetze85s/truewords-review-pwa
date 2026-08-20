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
  agreeResolutions,
} from '../boundary-pairs-logic.mjs';
import { segmentConversationWindow } from '../segmentation-v4.mjs';
import { logGapsFromTimestamps, fitRange, decisionBoundaries, histogram } from '../gap-mixture.mjs';
import { hourlyAggregates } from '../daily-rhythm.mjs';
import type { SegmentationOptions } from '../segmentation-v4.d.mts';
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

/** Admin-Gate über den ADMIN_REVIEW_TOKEN (Bearer) — konstantzeitiger Vergleich. */
async function adminAuthorized(request: Request, env: Env): Promise<boolean> {
  const provided = (request.headers.get('authorization') || '')
    .match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || '';
  const expected = env.ADMIN_REVIEW_TOKEN;
  if (!provided || !expected) return false;
  const [left, right] = await Promise.all([sha256Hex(provided), sha256Hex(expected)]);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
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

// Modul-Cache der geparsten, gefilterten Nachrichtenfolge je Datensatz (Punkt 2).
// Der teure Teil von filteredSequence ist das Lesen + JSON.parse ALLER Chunks —
// das lief bisher bei jedem Runden-/Übersichts-/Streitfall-/Klassifizierungs-
// Aufruf neu. Der Cache lebt im Worker-Isolate und wird gegen einen billigen
// Fingerprint (Chunk-Anzahl + Gesamt-Bytelänge) validiert: ändert sich nichts
// (kein Import), wird die geparste Folge wiederverwendet, sonst neu geladen.
// Die Folge wird nur gelesen (slice/findIndex/map) und nie mutiert, daher ist
// das Teilen derselben Referenz über Aufrufe hinweg sicher.
type SequenceCacheEntry = { fingerprint: string; sequence: RawMessage[] };
const sequenceCache = new Map<string, SequenceCacheEntry>();
const SEQUENCE_CACHE_MAX = 3;

async function sequenceFingerprint(env: Env, datasetId: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(messages_json)), 0) AS bytes FROM review_chat_chunks WHERE dataset_id = ?1',
  ).bind(datasetId).first<{ c: number; bytes: number }>();
  return `${Number(row?.c || 0)}:${Number(row?.bytes || 0)}`;
}

async function filteredSequence(env: Env, datasetId: string): Promise<RawMessage[]> {
  const fingerprint = await sequenceFingerprint(env, datasetId);
  const cached = sequenceCache.get(datasetId);
  if (cached && cached.fingerprint === fingerprint) return cached.sequence;

  const sequence = await filteredSequenceUsing(env, datasetId, isReviewable);
  // Speicher begrenzen: bei Überlauf den am längsten nicht neu geschriebenen
  // Eintrag (ältester Insert-Platz) verwerfen. In der Praxis 1–2 Datensätze.
  if (!sequenceCache.has(datasetId) && sequenceCache.size >= SEQUENCE_CACHE_MAX) {
    const oldest = sequenceCache.keys().next().value;
    if (oldest !== undefined) sequenceCache.delete(oldest);
  }
  sequenceCache.set(datasetId, { fingerprint, sequence });
  return sequence;
}

// Datensätze, in denen keine NEUEN Runden mehr angelegt werden dürfen.
// Bestehende Runden bleiben voll lesbar; nur das Nachziehen weiterer Runden
// ist gesperrt. Einfrieren = „Grenzarbeit hier abgeschlossen".
const FROZEN_DATASETS = new Set<string>(['philena-2026-pilot-v4-unseen']);

// Erlaubte Datensatz-IDs für den ?dataset=-Schalter (defensiv, gegen SQL-/Pfad-Spielereien).
const DATASET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,79}$/iu;

/**
 * Liefert den aktiven Datensatz. Ohne `requestedId` gilt env.ACTIVE_DATASET_ID.
 * Mit gültiger, existierender `requestedId` wird auf diesen Datensatz umgeschaltet –
 * so lässt sich per ?dataset= zwischen philena-2026 und philena-4y wechseln,
 * ganz ohne Redeploy. Ungültige/unbekannte IDs fallen still auf den Standard zurück.
 */
async function activeDataset(env: Env, requestedId?: string | null): Promise<DatasetRow | null> {
  const wanted = requestedId && DATASET_ID_PATTERN.test(requestedId) ? requestedId : null;
  if (wanted && wanted !== env.ACTIVE_DATASET_ID) {
    const row = await env.DB.prepare('SELECT id, year FROM review_datasets WHERE id = ?1 LIMIT 1')
      .bind(wanted)
      .first<DatasetRow>();
    if (row) return row;
  }
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
  // Globale Positions-Ordinalzahlen aktuell halten (billiger COUNT-Schnellpfad,
  // wenn nichts Neues) — nutzt die ohnehin geladene Folge, kein Extra-Parse.
  // Nicht-fatal: schlägt der (append-only) Backfill fehl, lädt die Runde
  // trotzdem; die Anzeige fällt auf die alte Nummerierung zurück.
  try { await ensureMessageOrdinals(env, dataset.id, sequence); } catch (caught) { console.error('Ordinal-Backfill (Runde) fehlgeschlagen — nicht fatal', caught); }

  let row = await env.DB.prepare(`
    SELECT dataset_id, round, first_message_id, message_count
    FROM review_rounds WHERE dataset_id = ?1 AND round = ?2
  `).bind(dataset.id, round).first<RoundRow>();

  if (!row) {
    if (FROZEN_DATASETS.has(dataset.id)) {
      throw new Error(`Datensatz „${dataset.id}" ist eingefroren – es werden keine neuen Runden mehr angelegt.`);
    }
    const otherRounds = await env.DB.prepare(`
      SELECT first_message_id, message_count FROM review_rounds WHERE dataset_id = ?1
    `).bind(dataset.id).all<{ first_message_id: string; message_count: number }>();

    // Runden, deren first_message_id in der aktuellen Folge nicht mehr auftaucht
    // (z. B. additiv aus einem anderen Datensatz übertragene Runden, deren
    // Start-Nachricht in diesem Datensatz nicht vorkommt), können hier nicht
    // überschneiden — sie fließen einfach nicht in die Kollisionsprüfung ein,
    // statt das Anlegen JEDER neuen Runde zu blockieren.
    const idIndex = new Map(sequence.map((message, index) => [rawId(message), index]));
    const existingRanges: Array<{ start: number; count: number }> = [];
    for (const existing of otherRounds.results || []) {
      const start = idIndex.get(existing.first_message_id);
      if (start === undefined) {
        console.error(`Runde mit first_message_id ${existing.first_message_id} nicht in der Folge von ${dataset.id} auffindbar — aus der Kollisionsprüfung ausgenommen.`);
        continue;
      }
      existingRanges.push({ start, count: existing.message_count });
    }

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
    throw new Error(
      `Runde ${round} (${dataset.id}): Startpunkt „${row.first_message_id}" ist in der aktuellen Nachrichtenfolge nicht auffindbar. `
      + 'Möglich, wenn diese Runde additiv aus einem anderen Datensatz übertragen wurde.',
    );
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
  // Number(null) ist 0 — ein fehlender Parameter sah dadurch wie eine
  // gültige, absichtlich strikte Toleranz von 0 aus und fiel NIE auf den
  // beabsichtigten Standard 1 zurück (der Fallback griff nur bei wirklich
  // ungültigen Werten wie "abc"). Betraf jeden Aufrufer, der ?tol= nicht
  // mitschickt: /api/overview (Übersicht) und den Schwellwert-Optimizer —
  // beide liefen seither mit strikter statt der überall sonst genutzten
  // Toleranz 1, was Runden mit Ein-Positions-Abweichung fälschlich als
  // Streitfall zählte.
  const raw = url.searchParams.get('tol');
  if (raw === null) return 1;
  const value = Number(raw);
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
  // Globale Grenz-Nummern der Nähte dieses Fensters: In der Runden-Ansicht sind
  // die Grenzen selbst der Arbeitsgegenstand, deshalb trägt jede GESETZTE
  // Grenze ihre Nummer direkt an der Linie (nicht nur in der Kopfzeile).
  // Naht = die Nachricht NACH der Grenze, also genügen die Message-Ordinalzahlen.
  const ordinalMap = await messageOrdinals(env, dataset.id, messages.map((message) => message.id));
  const ordinals: Record<string, number> = {};
  for (const [id, ordinal] of ordinalMap) ordinals[id] = ordinal;
  return json({ round, ...view, ordinals });
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

  // Inkrementell speichern (Punkt 2): nur den Unterschied schreiben, statt bei
  // jedem (debounced) Speichern ALLE Markierungen der Runde zu löschen und neu
  // einzufügen. Ein typisches Speichern kippt eine einzige Naht → eine einzige
  // Insert-/Update-/Delete-Zeile statt „DELETE alle + bis zu 60 INSERTs".
  const existingRows = await loadMarks(env, dataset.id, round, reviewer);
  const existing = new Map(existingRows.map((row) => [row.seam_message_id, row.mark]));
  const desired = new Map(clean.map((entry) => [entry.seamMessageId, entry.mark]));

  const toUpsert = clean.filter((entry) => existing.get(entry.seamMessageId) !== entry.mark);
  const toDelete = [...existing.keys()].filter((id) => !desired.has(id));

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (toDelete.length) {
    // ≤ MAX_MARKS_PER_ROUND (60) IDs + 3 feste Binds ⇒ sicher unter D1s 100er-Limit.
    const placeholders = toDelete.map((_, index) => `?${index + 4}`).join(',');
    statements.push(
      env.DB.prepare(
        `DELETE FROM review_boundary_marks WHERE dataset_id = ?1 AND round = ?2 AND reviewer = ?3 AND seam_message_id IN (${placeholders})`,
      ).bind(dataset.id, round, reviewer, ...toDelete),
    );
  }
  for (const entry of toUpsert) {
    statements.push(
      env.DB.prepare(`
        INSERT INTO review_boundary_marks
          (dataset_id, round, reviewer, seam_message_id, mark, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(dataset_id, round, reviewer, seam_message_id) DO UPDATE SET
          mark = excluded.mark, updated_at = excluded.updated_at
      `).bind(dataset.id, round, reviewer, entry.seamMessageId, entry.mark, now),
    );
  }
  if (statements.length) await env.DB.batch(statements);

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

/**
 * Punkt 7: billiger „Zustands-Stempel" einer Runde für leichtgewichtiges
 * Polling. Ändert sich der Stempel, hat sich beim Partner etwas getan (Abgabe
 * oder Streitfall-Stimme) → die Seite lädt die Runde neu (über den normalen,
 * blind-gegateten Endpunkt, Blindheit bleibt gewahrt). Bewusst OHNE
 * filteredSequence/Runden-Fenster — nur zwei indizierte Zählungen/Max über
 * Abgaben und Streitfall-Entscheidungen dieser Runde. Marks fließen NICHT ein
 * (blind bis zur Abgabe; ihre Änderung soll keine Reaktion auslösen).
 */
async function getRoundState(env: Env, dataset: DatasetRow, round: number): Promise<Response> {
  const [sub, res] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS c, COALESCE(MAX(submitted_at), '') AS m FROM review_round_submissions WHERE dataset_id = ?1 AND round = ?2",
    ).bind(dataset.id, round).first<{ c: number; m: string }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS c, COALESCE(MAX(decided_at), '') AS m FROM review_boundary_resolutions WHERE dataset_id = ?1 AND round = ?2",
    ).bind(dataset.id, round).first<{ c: number; m: string }>(),
  ]);
  const stamp = `${Number(sub?.c || 0)}:${sub?.m || ''}|${Number(res?.c || 0)}:${res?.m || ''}`;
  return json({ ok: true, stamp });
}

/**
 * Baut den vollständigen Vergleichs-/Streitfall-Datensatz aus einem bereits
 * geladenen Runden-Fenster. Ausgelagert aus getAgreement(), damit
 * resolveDispute() nach dem Speichern einer Entscheidung denselben Datensatz
 * zurückgeben kann, OHNE das Runden-Fenster (loadRoundWindow → filteredSequence,
 * liest den kompletten gefilterten Chat neu ein) ein zweites Mal zu laden —
 * das war bei jedem einzelnen Streitfall-Klick spürbar langsam, weil vorher
 * sowohl resolveDispute() als auch der anschließende getAgreement()-Aufruf
 * vom Browser je einmal filteredSequence() ausgelöst haben.
 */
async function buildAgreementPayload(
  env: Env,
  dataset: DatasetRow,
  round: number,
  reviewer: Role,
  tolerance: number,
  doubtMode: DoubtMode,
  messages: ViewMessage[],
): Promise<Record<string, unknown>> {
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
  // Auftrag 2: zwei Prüfer-Stimmen je Naht → eine gemeinsame Entscheidung.
  const agreed = agreeResolutions(resolutionRows.results || []);
  const resolutions = new Map(agreed.map((entry) => [entry.seam_message_id, entry]));
  const combined = combinedBoundary(comparison, toPositionalResolutions(agreed, positions));

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
      resolved: resolution?.resolved || false,
      // Auftrag 2, Punkt 4: Einzelstimmen für „wer hat schon entschieden".
      votes: {
        philipp: resolution?.philipp ?? null,
        lena: resolution?.lena ?? null,
      },
      note: resolution ? (resolution.notes[reviewer] || '') : '',
    };
  }

  const disputeEntries = [
    ...comparison.onlyA.map((position) => disputeEntry(position, 'Philipp')),
    ...comparison.onlyB.map((position) => disputeEntry(position, 'Lena')),
  ];

  // Global stabile Grenz-Nummer je Streitfall = Ordinalzahl der Naht-Nachricht
  // (Punkt 1). Ersetzt die frühere runden-lokale 1..k-Zählung, die in jeder
  // Runde bei 1 neu begann und sich beim Klären verschob. Fallback auf die
  // runden-lokale Reihenfolge nur, falls die Ordinalzahlen für diese Naht noch
  // nicht gebackfillt sind — dann bleibt die Anzeige wenigstens nicht leer.
  const disputeOrdinals = await messageOrdinals(
    env,
    dataset.id,
    disputeEntries.map((entry) => entry.seamMessageId),
  );
  const numberByPosition = new Map(
    [...disputeEntries].sort((a, b) => a.position - b.position).map((entry, index) => [entry.position, index + 1]),
  );

  // Offene Streitfälle zuerst, geklärte ans Ende — serverseitig sortiert,
  // damit beide Partner exakt dieselbe Reihenfolge sehen.
  const disputes = disputeEntries
    .map((entry) => ({
      ...entry,
      // Globale Grenz-Nummer (bevorzugt) bzw. runden-lokaler Fallback.
      number: disputeOrdinals.get(entry.seamMessageId) ?? numberByPosition.get(entry.position) ?? null,
    }))
    .sort((a, b) => {
      const aResolved = a.decision !== 'open' ? 1 : 0;
      const bResolved = b.decision !== 'open' ? 1 : 0;
      if (aResolved !== bResolved) return aResolved - bResolved;
      return a.position - b.position;
    });

  return {
    ok: true,
    round,
    reviewer,
    tolerance,
    doubtMode,
    n: comparison.n,
    // F0 = rohe Übereinstimmung Philipp/Lena dieser Runde (Konsistenz mit Übersicht/Aggregat).
    f0: comparison.agreementF1,
    kappa: comparison.kappa,
    automatic: {
      vsPhilipp: { agreementF1: agreementF1(vsPhilipp), kappa: cohensKappa(vsPhilipp, totalSeams) },
      vsLena: { agreementF1: agreementF1(vsLena), kappa: cohensKappa(vsLena, totalSeams) },
      // F1 = Automatik vs. GT (F0-Paare + geklärte Streitfälle) dieser Runde.
      // Punkt 3: ohne Grenz-Wahrheit (GT=0) ist F1 n/a (null), nicht 0.
      vsCombined: { f1: combined.cuts.length === 0 ? null : agreementF1(vsCombined), kappa: cohensKappa(vsCombined, totalSeams) },
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
  };
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
  const payload = await buildAgreementPayload(env, dataset, round, reviewer, tolerance, doubtMode, messages);
  return json(payload);
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
  // Auftrag 2: jeder Prüfer schreibt seine EIGENE Stimme. decided_by ist Teil
  // des Primärschlüssels, ON CONFLICT trifft nur die eigene Zeile — die Stimme
  // der anderen Person bleibt unangetastet. Geklärt gilt erst, wenn beide
  // dieselbe Nicht-open-Entscheidung gesetzt haben (siehe agreeResolutions).
  await env.DB.prepare(`
    INSERT INTO review_boundary_resolutions
      (dataset_id, round, seam_message_id, decision, note, decided_by, decided_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(dataset_id, round, seam_message_id, decided_by) DO UPDATE SET
      decision = excluded.decision,
      note = excluded.note,
      decided_at = excluded.decided_at
  `).bind(dataset.id, round, seamMessageId, decision, note, reviewer, now).run();

  // Punkt: liefert den aktualisierten Vergleichsdatensatz direkt mit zurück,
  // statt dass der Browser danach noch einmal komplett neu laden muss — spart
  // sowohl den zweiten filteredSequence()-Lauf als auch einen ganzen
  // Request/Response-Umlauf, genau an der Stelle, die sich beim Klären eines
  // Streitfalls spürbar langsam angefühlt hat.
  const url = new URL(request.url);
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);
  const agreement = await buildAgreementPayload(env, dataset, round, reviewer, tolerance, doubtMode, messages);

  return json({ ok: true, seamMessageId, decision, note, decidedBy: reviewer, decidedAt: now, agreement });
}

/**
 * Wie getOverview(): lädt die gefilterte Nachrichtenfolge und alle
 * Runden/Abgaben/Markierungen/Streitfälle EINMAL in Bulk-Queries statt pro
 * Runde. Wird von refreshLiveF1() im Browser nach JEDER Markierung erneut
 * aufgerufen (debounced) — die alte Schleife mit loadRoundWindow() +
 * 2×loadMarks() + Streitfall-Query + vollem Algorithmus-Lauf pro Runde war
 * hier besonders teuer, weil sie auf dem Tippweg lag, nicht nur beim Laden
 * der Übersicht.
 */
async function getSummary(env: Env, dataset: DatasetRow, reviewer: Role, url: URL): Promise<Response> {
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);

  const [sequence, roundRows, submissionRows, allMarks, allResolutions] = await Promise.all([
    filteredSequence(env, dataset.id),
    env.DB.prepare(
      'SELECT round, first_message_id, message_count FROM review_rounds WHERE dataset_id = ?1 ORDER BY round',
    ).bind(dataset.id).all<RoundRow>(),
    env.DB.prepare(
      'SELECT round, reviewer FROM review_round_submissions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: Role }>(),
    env.DB.prepare(
      'SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: Role; seam_message_id: string; mark: string }>(),
    env.DB.prepare(
      'SELECT round, seam_message_id, decided_by, decision FROM review_boundary_resolutions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; seam_message_id: string; decided_by: string; decision: 'cut' | 'no_cut' | 'open' }>(),
  ]);

  const seqIndex = new Map<string, number>();
  for (let index = 0; index < sequence.length; index += 1) seqIndex.set(rawId(sequence[index]), index);

  const byRound = new Map<number, Set<Role>>();
  for (const row of submissionRows.results || []) {
    if (!byRound.has(row.round)) byRound.set(row.round, new Set());
    byRound.get(row.round)?.add(row.reviewer);
  }
  const readyRounds = [...byRound.entries()]
    .filter(([, reviewers]) => reviewers.has('Philipp') && reviewers.has('Lena'))
    .map(([round]) => round)
    .sort((a, b) => a - b);

  const roundMeta = new Map<number, RoundRow>();
  for (const row of roundRows.results || []) roundMeta.set(row.round, row);

  const marksByRound = new Map<number, { philipp: MarkRow[]; lena: MarkRow[] }>();
  for (const row of allMarks.results || []) {
    if (!marksByRound.has(row.round)) marksByRound.set(row.round, { philipp: [], lena: [] });
    const entry = marksByRound.get(row.round)!;
    const markRow: MarkRow = { seam_message_id: row.seam_message_id, mark: row.mark as 'cut' | 'doubt' };
    if (row.reviewer === 'Philipp') entry.philipp.push(markRow);
    else if (row.reviewer === 'Lena') entry.lena.push(markRow);
  }

  const resByRound = new Map<number, Array<{ seam_message_id: string; decided_by: string; decision: 'cut' | 'no_cut' | 'open' }>>();
  for (const row of allResolutions.results || []) {
    if (!resByRound.has(row.round)) resByRound.set(row.round, []);
    resByRound.get(row.round)!.push(row);
  }

  let totalPairs = 0;
  let totalOnlyPhilipp = 0;
  let totalOnlyLena = 0;
  let totalAutoPairs = 0;
  let totalAutoOnlyAuto = 0;
  let totalAutoOnlyCombined = 0;
  let openDisputes = 0;
  let resolvedDisputes = 0;
  // GT (Ground Truth) = combinedBoundary-Menge (F0-Paare + geklärte Streitfälle).
  // Keine Kennzahl, sondern eine Mengengröße — daher Summe, kein Mittelwert.
  let gtTotal = 0;
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
    const roundRow = roundMeta.get(round);
    // Additiv aus einem anderen Datensatz übertragene Runden können ihren
    // Startpunkt in der aktuellen Folge nicht wiederfinden — wie in
    // getOverview() übersprungen statt die gesamte Anfrage scheitern zu lassen.
    const startIdx = roundRow ? seqIndex.get(roundRow.first_message_id) : undefined;
    if (!roundRow || startIdx === undefined) continue;

    const messages = sequence.slice(startIdx, startIdx + roundRow.message_count).map(toView);
    const positions = seamPositions(messages);
    const totalSeams = Math.max(0, messages.length - 1);
    const marks = marksByRound.get(round) || { philipp: [], lena: [] };
    const comparison = compareReviewers(
      toPositionalMarks(marks.philipp, positions),
      toPositionalMarks(marks.lena, positions),
      { totalSeams, tolerance, doubtMode },
    );
    // Die geklärten Streitfälle gehören in die gemeinsame Fassung, sonst
    // bliebe die Klärungsarbeit ohne Wirkung auf die Kennzahlen.
    const resolutions = resByRound.get(round) || [];
    const agreed = agreeResolutions(resolutions);
    const combined = combinedBoundary(comparison, toPositionalResolutions(agreed, positions));

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
    // Punkt 3: Runden ohne Grenz-Wahrheit (GT=0) fließen NICHT ins F1-Aggregat
    // ein (sonst zählte die Automatik dort nur „Fehltreffer" gegen eine leere
    // Wahrheit). F0/GT-Summe bleiben davon unberührt.
    if (combined.cuts.length > 0) {
      totalAutoPairs += vsCombined.pairs.length;
      totalAutoOnlyAuto += vsCombined.onlyA.length;
      totalAutoOnlyCombined += vsCombined.onlyB.length;
    }
    totalAutomaticBoundaries += automaticResult.boundaries.length;
    gtTotal += combined.cuts.length;

    // Auftrag 2: geklärt = beide einig (resolved), nicht mehr „eine Entscheidung".
    const resolvedCount = agreed.filter((entry) => entry.resolved).length;
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
    // Historischer Name, zählt trotz der Bezeichnung nur rohe F0-Paare, nicht
    // die volle GT-Menge (Paare + geklärte Streitfälle) — das ist gtTotal.
    // Belassen für Rückwärtskompatibilität, nicht mit gtTotal verwechseln.
    combinedBoundaries: totalPairs,
    lowData: totalPairs < 40,
    f0: humanTotal ? (2 * totalPairs) / humanTotal : null,
    gtTotal,
    automaticVsCombined: {
      f1: autoTotal ? (2 * totalAutoPairs) / autoTotal : null,
    },
    automaticBoundariesTotal: totalAutomaticBoundaries,
    disputes: { open: openDisputes, resolved: resolvedDisputes },
    perRound,
  });
}

/** Kleinste Runde ≥1, die diese Person noch NICHT abgegeben hat (erste Lücke). */
function nextUnsubmittedRound(submitted: Set<number>): number {
  let round = 1;
  while (submitted.has(round)) round += 1;
  return round;
}

/**
 * Schneller Übersichts-Endpunkt: lädt die gefilterte Nachrichtenfolge EINMAL
 * und alle Runden/Abgaben/Markierungen/Streitfälle in 4 parallelen Bulk-Queries.
 * Eliminiert das N+1 der alten getOverview (jede Runde einzeln über
 * loadRoundWindow → filteredSequence). Ergebnis: pro Runde Abgabestatus,
 * offene/geklärte Streitfälle, Farbcode für die Tabelle.
 */
async function getOverview(env: Env, dataset: DatasetRow, reviewer: Role, url: URL): Promise<Response> {
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);

  const [sequence, roundRows, submissionRows, allMarks, allResolutions] = await Promise.all([
    filteredSequence(env, dataset.id),
    env.DB.prepare(
      'SELECT round, first_message_id, message_count FROM review_rounds WHERE dataset_id = ?1 ORDER BY round',
    ).bind(dataset.id).all<RoundRow>(),
    env.DB.prepare(
      'SELECT round, reviewer FROM review_round_submissions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: string }>(),
    env.DB.prepare(
      'SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: string; seam_message_id: string; mark: string }>(),
    env.DB.prepare(
      'SELECT round, seam_message_id, decided_by, decision FROM review_boundary_resolutions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; seam_message_id: string; decided_by: string; decision: string }>(),
  ]);

  // Globale Positions-Ordinalzahlen aktuell halten, solange die Folge ohnehin
  // geladen ist (billiger COUNT-Schnellpfad, wenn nichts Neues). Die Übersicht
  // ist die Startseite nach dem Login → Nummern sind vor dem ersten
  // Runden-Öffnen gefüllt. Nicht-fatal: schlägt der Backfill fehl, lädt die
  // Übersicht trotzdem (append-only, setzt sich beim nächsten Laden fort).
  try { await ensureMessageOrdinals(env, dataset.id, sequence); } catch (caught) { console.error('Ordinal-Backfill (Übersicht) fehlgeschlagen — nicht fatal', caught); }

  const seqIndex = new Map<string, number>();
  for (let index = 0; index < sequence.length; index += 1) seqIndex.set(rawId(sequence[index]), index);

  const philippSubmitted = new Set<number>();
  const lenaSubmitted = new Set<number>();
  for (const row of submissionRows.results || []) {
    if (row.reviewer === 'Philipp') philippSubmitted.add(row.round);
    else if (row.reviewer === 'Lena') lenaSubmitted.add(row.round);
  }

  const marksByRound = new Map<number, { philipp: MarkRow[]; lena: MarkRow[] }>();
  for (const row of allMarks.results || []) {
    if (!marksByRound.has(row.round)) marksByRound.set(row.round, { philipp: [], lena: [] });
    const entry = marksByRound.get(row.round)!;
    const markRow: MarkRow = { seam_message_id: row.seam_message_id, mark: row.mark as 'cut' | 'doubt' };
    if (row.reviewer === 'Philipp') entry.philipp.push(markRow);
    else if (row.reviewer === 'Lena') entry.lena.push(markRow);
  }

  const resByRound = new Map<number, Array<{ seam_message_id: string; decided_by: string; decision: string }>>();
  for (const row of allResolutions.results || []) {
    if (!resByRound.has(row.round)) resByRound.set(row.round, []);
    resByRound.get(row.round)!.push(row);
  }

  const existingRounds = (roundRows.results || []).sort((a, b) => a.round - b.round);

  const rounds: Array<{
    round: number;
    philippSubmitted: boolean;
    lenaSubmitted: boolean;
    openDisputes: number;
    resolvedDisputes: number;
    f0: number | null;
    f1: number | null;
    gtSize: number | null;
    unresolvable: boolean;
    done: boolean;
  }> = [];

  // Gepoolte Aggregate (f0Aggregate/f1Aggregate/gtTotal) für die Übersicht-
  // Kopfzeile — vormals ein zweiter Aufruf von getSummary() aus loadOverview()
  // im Browser, jetzt aus denselben ohnehin schon bulk-geladenen Runden hier
  // mitgezählt statt die komplette Berechnung ein zweites Mal anzustoßen.
  let pooledPairs = 0;
  let pooledOnlyPhilipp = 0;
  let pooledOnlyLena = 0;
  let pooledAutoPairs = 0;
  let pooledAutoOnlyAuto = 0;
  let pooledAutoOnlyCombined = 0;
  let gtTotal = 0;

  for (const roundRow of existingRounds) {
    const pSub = philippSubmitted.has(roundRow.round);
    const lSub = lenaSubmitted.has(roundRow.round);
    let open = 0;
    let resolved = 0;
    let f0: number | null = null;
    let f1: number | null = null;
    let gtSize: number | null = null;
    // Punkt 18/19: Runden, deren Startpunkt in der aktuellen Nachrichtenfolge
    // nicht auffindbar ist (z. B. additiv übertragene Runden aus einem
    // anderen Datensatz), zeigen sonst still F1/Streitfälle = 0/– vor, ohne
    // dass klar wird, dass hier gar nicht gerechnet werden konnte.
    let unresolvable = false;

    if (pSub && lSub) {
      const startIdx = seqIndex.get(roundRow.first_message_id);
      if (startIdx === undefined) unresolvable = true;
      if (startIdx !== undefined) {
        const messages = sequence.slice(startIdx, startIdx + roundRow.message_count).map(toView);
        const positions = seamPositions(messages);
        const totalSeams = Math.max(0, messages.length - 1);
        const marks = marksByRound.get(roundRow.round) || { philipp: [], lena: [] };
        const marksP = toPositionalMarks(marks.philipp, positions);
        const marksL = toPositionalMarks(marks.lena, positions);
        const comparison = compareReviewers(marksP, marksL, { totalSeams, tolerance, doubtMode });
        f0 = comparison.agreementF1;

        const resolutions = resByRound.get(roundRow.round) || [];
        const agreed = agreeResolutions(resolutions);
        const combined = combinedBoundary(comparison, toPositionalResolutions(agreed, positions));
        gtSize = combined.cuts.length;
        const autoResult = segmentConversationWindow(toSegmentationInput(messages));
        const autoPositions = autoResult.boundaries
          .map((b: { beforeEventId: string }) => positions.get(b.beforeEventId))
          .filter((p: number | undefined): p is number => p !== undefined);
        const vsCombined = pairSeams(autoPositions, combined.cuts, tolerance);
        // Punkt 3: Ohne Grenz-Wahrheit (GT=0) ist F1 nicht definiert → n/a
        // (null), NICHT 0. Solche Runden zählen auch nicht ins F1-Aggregat.
        // GT>0 und die Automatik trifft nichts = echte 0 (bleibt).
        f1 = gtSize === 0 ? null : agreementF1(vsCombined);

        pooledPairs += comparison.pairs.length;
        pooledOnlyPhilipp += comparison.onlyA.length;
        pooledOnlyLena += comparison.onlyB.length;
        if (gtSize > 0) {
          pooledAutoPairs += vsCombined.pairs.length;
          pooledAutoOnlyAuto += vsCombined.onlyA.length;
          pooledAutoOnlyCombined += vsCombined.onlyB.length;
        }
        gtTotal += gtSize;

        const resolvedSeams = new Set(agreed.filter((entry) => entry.resolved).map((entry) => entry.seam_message_id));
        const positionToId = new Map<number, string>();
        for (const [id, pos] of positions) positionToId.set(pos, id);
        for (const pos of [...comparison.onlyA, ...comparison.onlyB]) {
          const seamId = positionToId.get(pos);
          if (seamId && resolvedSeams.has(seamId)) resolved += 1;
          else if (seamId) open += 1;
        }
      }
    }

    rounds.push({
      round: roundRow.round,
      philippSubmitted: pSub,
      lenaSubmitted: lSub,
      openDisputes: open,
      resolvedDisputes: resolved,
      f0,
      f1,
      gtSize,
      unresolvable,
      // Punkt 3: verschwindet aus der Standardansicht der Übersicht — beide
      // abgegeben UND keine offenen Streitfälle. Unresolvable Runden bleiben
      // bewusst sichtbar, da ihr Streitfall-Status nicht berechenbar ist.
      done: pSub && lSub && !unresolvable && open === 0,
    });
  }

  const allRoundNums = existingRounds.map((row) => row.round);

  const pooledHumanTotal = 2 * pooledPairs + pooledOnlyPhilipp + pooledOnlyLena;
  const pooledAutoTotal = 2 * pooledAutoPairs + pooledAutoOnlyAuto + pooledAutoOnlyCombined;

  return json({
    ok: true,
    reviewer,
    dataset: dataset.id,
    tolerance,
    doubtMode,
    totalRounds: allRoundNums.length,
    readyRounds: allRoundNums.filter((round) => philippSubmitted.has(round) && lenaSubmitted.has(round)).length,
    f0Aggregate: pooledHumanTotal ? (2 * pooledPairs) / pooledHumanTotal : null,
    f1Aggregate: pooledAutoTotal ? (2 * pooledAutoPairs) / pooledAutoTotal : null,
    gtTotal,
    reviewers: {
      Philipp: {
        submitted: philippSubmitted.size,
        open: allRoundNums.filter((round) => !philippSubmitted.has(round)).length,
        nextRound: nextUnsubmittedRound(philippSubmitted),
      },
      Lena: {
        submitted: lenaSubmitted.size,
        open: allRoundNums.filter((round) => !lenaSubmitted.has(round)).length,
        nextRound: nextUnsubmittedRound(lenaSubmitted),
      },
    },
    rounds,
  });
}

/**
 * Nur-Lese-Diagnose: zeigt für ausgewählte Runden (Default: alle) die aktuell
 * OFFENEN Streitfälle im Detail — Naht-ID plus Philipps und Lenas jeweilige
 * Markierung. Anlass: nach der Marks-Rückstellung (Runden 1–17 auf den
 * eingefrorenen Basis-Stand) könnten Nähte, die vorher wegen des inzwischen
 * behobenen Speicher-Race unmarkiert wirkten (und daher gar nicht als
 * Streitfall auftauchten), jetzt echte neue Abweichungen zeigen — Philipp und
 * Lena hatten diese also nie zu Gesicht bekommen, obwohl sie „ihre" Runde
 * bereits als komplett geklärt in Erinnerung haben. Rein lesend, gleiche
 * Bulk-Lade-Technik wie getOverview (ein filteredSequence-Aufruf statt einer
 * pro Runde).
 */
async function getDisputeCheck(env: Env, dataset: DatasetRow, url: URL): Promise<Response> {
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);
  const roundsFilter = parseRoundsParam(url);

  const [sequence, roundRows, submissionRows, allMarks, allResolutions] = await Promise.all([
    filteredSequence(env, dataset.id),
    env.DB.prepare(
      'SELECT round, first_message_id, message_count FROM review_rounds WHERE dataset_id = ?1 ORDER BY round',
    ).bind(dataset.id).all<RoundRow>(),
    env.DB.prepare(
      'SELECT round, reviewer FROM review_round_submissions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: string }>(),
    env.DB.prepare(
      'SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: string; seam_message_id: string; mark: string }>(),
    env.DB.prepare(
      'SELECT round, seam_message_id, decided_by, decision FROM review_boundary_resolutions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; seam_message_id: string; decided_by: string; decision: string }>(),
  ]);

  // Globale Positions-Ordinalzahlen aktuell halten, solange die Folge ohnehin
  // geladen ist (billiger COUNT-Schnellpfad, wenn nichts Neues). Die Übersicht
  // ist die Startseite nach dem Login → Nummern sind vor dem ersten
  // Runden-Öffnen gefüllt. Nicht-fatal: schlägt der Backfill fehl, lädt die
  // Übersicht trotzdem (append-only, setzt sich beim nächsten Laden fort).
  try { await ensureMessageOrdinals(env, dataset.id, sequence); } catch (caught) { console.error('Ordinal-Backfill (Übersicht) fehlgeschlagen — nicht fatal', caught); }

  const seqIndex = new Map<string, number>();
  for (let index = 0; index < sequence.length; index += 1) seqIndex.set(rawId(sequence[index]), index);

  const philippSubmitted = new Set<number>();
  const lenaSubmitted = new Set<number>();
  for (const row of submissionRows.results || []) {
    if (row.reviewer === 'Philipp') philippSubmitted.add(row.round);
    else if (row.reviewer === 'Lena') lenaSubmitted.add(row.round);
  }

  const marksByRound = new Map<number, { philipp: MarkRow[]; lena: MarkRow[] }>();
  for (const row of allMarks.results || []) {
    if (!marksByRound.has(row.round)) marksByRound.set(row.round, { philipp: [], lena: [] });
    const entry = marksByRound.get(row.round)!;
    const markRow: MarkRow = { seam_message_id: row.seam_message_id, mark: row.mark as 'cut' | 'doubt' };
    if (row.reviewer === 'Philipp') entry.philipp.push(markRow);
    else if (row.reviewer === 'Lena') entry.lena.push(markRow);
  }

  const resByRound = new Map<number, Array<{ seam_message_id: string; decided_by: string; decision: string }>>();
  for (const row of allResolutions.results || []) {
    if (!resByRound.has(row.round)) resByRound.set(row.round, []);
    resByRound.get(row.round)!.push(row);
  }

  const existingRounds = (roundRows.results || [])
    .filter((row) => !roundsFilter || roundsFilter.has(row.round))
    .sort((a, b) => a.round - b.round);

  const rounds = existingRounds.map((roundRow) => {
    const pSub = philippSubmitted.has(roundRow.round);
    const lSub = lenaSubmitted.has(roundRow.round);
    const openSeams: Array<{
      seamMessageId: string;
      philipp: string | null;
      lena: string | null;
      votes: Array<{ decidedBy: string; decision: string }>;
    }> = [];
    let resolvedCount = 0;
    let f0: number | null = null;
    let unresolvable = false;

    const startIdx = seqIndex.get(roundRow.first_message_id);
    if (startIdx === undefined) unresolvable = true;
    if (pSub && lSub && startIdx !== undefined) {
      const messages = sequence.slice(startIdx, startIdx + roundRow.message_count).map(toView);
      const positions = seamPositions(messages);
      const totalSeams = Math.max(0, messages.length - 1);
      const marks = marksByRound.get(roundRow.round) || { philipp: [], lena: [] };
      const marksP = toPositionalMarks(marks.philipp, positions);
      const marksL = toPositionalMarks(marks.lena, positions);
      const comparison = compareReviewers(marksP, marksL, { totalSeams, tolerance, doubtMode });
      f0 = comparison.agreementF1;

      const resolutions = resByRound.get(roundRow.round) || [];
      const agreed = agreeResolutions(resolutions);
      const resolvedSeams = new Set(agreed.filter((entry) => entry.resolved).map((entry) => entry.seam_message_id));

      // Für offene Nähte zusätzlich zeigen, OB überhaupt schon eine Entscheidung
      // gespeichert ist (nur einer von beiden, oder beide aber uneins) statt
      // pauschal "offen" — das unterscheidet "nie angeschaut" von "angeschaut,
      // aber (noch) nicht deckungsgleich entschieden".
      const votesBySeam = new Map<string, Array<{ decidedBy: string; decision: string }>>();
      for (const row of resolutions) {
        if (!votesBySeam.has(row.seam_message_id)) votesBySeam.set(row.seam_message_id, []);
        votesBySeam.get(row.seam_message_id)!.push({ decidedBy: row.decided_by, decision: row.decision });
      }

      const positionToId = new Map<number, string>();
      for (const [id, pos] of positions) positionToId.set(pos, id);
      const philippBySeam = new Map(marks.philipp.map((m) => [m.seam_message_id, m.mark]));
      const lenaBySeam = new Map(marks.lena.map((m) => [m.seam_message_id, m.mark]));

      for (const pos of [...comparison.onlyA, ...comparison.onlyB]) {
        const seamId = positionToId.get(pos);
        if (!seamId) continue;
        if (resolvedSeams.has(seamId)) { resolvedCount += 1; continue; }
        openSeams.push({
          seamMessageId: seamId,
          philipp: philippBySeam.get(seamId) || null,
          lena: lenaBySeam.get(seamId) || null,
          votes: votesBySeam.get(seamId) || [],
        });
      }
    }

    return {
      round: roundRow.round,
      philippSubmitted: pSub,
      lenaSubmitted: lSub,
      unresolvable,
      f0,
      openCount: openSeams.length,
      resolvedCount,
      openSeams,
    };
  });

  return json({ ok: true, datasetId: dataset.id, tolerance, doubtMode, rounds });
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
        SELECT seam_message_id, decided_by, decision FROM review_boundary_resolutions
        WHERE dataset_id = ?1 AND round = ?2
      `).bind(dataset.id, roundRow.round).all<{ seam_message_id: string; decided_by: string; decision: 'cut' | 'no_cut' | 'open' }>(),
    ]);
    const resolutionList = agreeResolutions(resolutionRows.results || []);
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

/**
 * Nur-Lese-Prüfung, ob sich die Grenzen der Basis (ACTIVE_DATASET_ID) additiv
 * nach einem zweiten Datensatz übertragen ließen — pro Runde wird geprüft, ob
 * deren Anker (first_message_id) und alle zugehörigen Mark-/Streitfall-IDs im
 * gleich großen Fenster der Zielsequenz wieder auftauchen. Geprüft wird gegen
 * isReviewable, weil genau dieser Filter im Live-Lader (loadRoundWindow) läuft.
 * Ausschließlich Zählungen, kein Nachrichtentext, kein Name.
 */
type AnchorReport = {
  present: boolean;
  allGreen: boolean;
  baseDatasetId: string;
  targetDatasetId: string;
  error?: string;
  [key: string]: unknown;
};

async function computeAnchorReport(env: Env): Promise<AnchorReport> {
  const baseId = env.ACTIVE_DATASET_ID;
  const targetId = 'philena-4y';

  const targetRow = await env.DB.prepare('SELECT id FROM review_datasets WHERE id = ?1 LIMIT 1')
    .bind(targetId).first<{ id: string }>();
  if (!targetRow) {
    return {
      present: false,
      allGreen: false,
      baseDatasetId: baseId,
      targetDatasetId: targetId,
      error: `Datensatz ${targetId} ist noch nicht importiert.`,
    };
  }

  const [targetStrict, targetBroad] = await Promise.all([
    filteredSequenceUsing(env, targetId, isReviewable),
    filteredSequenceUsing(env, targetId, isReviewableBroad),
  ]);
  const idToIndex = new Map<string, number>();
  targetStrict.forEach((message, index) => {
    const id = rawId(message);
    if (id && !idToIndex.has(id)) idToIndex.set(id, index);
  });

  const [roundRows, markRows, resolutionRows, targetRoundRows, targetMarkCounts, targetResolutionCounts] = await Promise.all([
    env.DB.prepare(`
      SELECT dataset_id, round, first_message_id, message_count FROM review_rounds
      WHERE dataset_id = ?1 ORDER BY round
    `).bind(baseId).all<RoundRow>(),
    env.DB.prepare(`
      SELECT round, seam_message_id FROM review_boundary_marks WHERE dataset_id = ?1
    `).bind(baseId).all<{ round: number; seam_message_id: string }>(),
    env.DB.prepare(`
      SELECT round, seam_message_id, decided_by, decision FROM review_boundary_resolutions WHERE dataset_id = ?1
    `).bind(baseId).all<{ round: number; seam_message_id: string; decided_by: string; decision: string }>(),
    // Ziel-Datensatz (philena-4y): gleiche Tabellen, andere dataset_id — kein
    // separater „alter" Speicher, nur eine zweite Zeile je seam/Runde hier.
    env.DB.prepare(`
      SELECT round, message_count FROM review_rounds WHERE dataset_id = ?1
    `).bind(targetId).all<{ round: number; message_count: number }>(),
    env.DB.prepare(`
      SELECT round, COUNT(*) AS n FROM review_boundary_marks WHERE dataset_id = ?1 GROUP BY round
    `).bind(targetId).all<{ round: number; n: number }>(),
    env.DB.prepare(`
      SELECT round, COUNT(*) AS n FROM review_boundary_resolutions WHERE dataset_id = ?1 GROUP BY round
    `).bind(targetId).all<{ round: number; n: number }>(),
  ]);
  const rounds = roundRows.results || [];

  const marksByRound = new Map<number, string[]>();
  for (const row of markRows.results || []) {
    if (!marksByRound.has(row.round)) marksByRound.set(row.round, []);
    marksByRound.get(row.round)?.push(row.seam_message_id);
  }
  // Nach Auftrag 2 gibt es bis zu zwei Zeilen je Naht — für die Anker-Prüfung
  // interessiert nur die Naht-ID (eindeutig), fürs „geklärt" die Übereinstimmung.
  const resolutionRowsByRound = new Map<number, Array<{ seam_message_id: string; decided_by: string; decision: string }>>();
  let rawResolutionRows = 0;
  for (const row of resolutionRows.results || []) {
    rawResolutionRows += 1;
    if (!resolutionRowsByRound.has(row.round)) resolutionRowsByRound.set(row.round, []);
    resolutionRowsByRound.get(row.round)?.push(row);
  }
  const resolutionsByRound = new Map<number, string[]>();
  let resolutionsResolved = 0;
  for (const [round, rows] of resolutionRowsByRound) {
    const agreed = agreeResolutions(rows);
    resolutionsByRound.set(round, agreed.map((entry) => entry.seam_message_id));
    resolutionsResolved += agreed.filter((entry) => entry.resolved).length;
  }

  const failedRounds: number[] = [];
  let roundsLoadable = 0;
  let marksTotal = 0, marksMatched = 0;
  let resolutionsTotal = 0, resolutionsMatched = 0;

  for (const roundRow of rounds) {
    const startIndex = idToIndex.get(roundRow.first_message_id);
    let windowIds: Set<string> | null = null;
    if (startIndex === undefined) {
      failedRounds.push(roundRow.round);
    } else {
      roundsLoadable += 1;
      windowIds = new Set(
        targetStrict.slice(startIndex, startIndex + roundRow.message_count).map(rawId),
      );
    }
    for (const seam of marksByRound.get(roundRow.round) || []) {
      marksTotal += 1;
      if (windowIds?.has(seam)) marksMatched += 1;
    }
    for (const seam of resolutionsByRound.get(roundRow.round) || []) {
      resolutionsTotal += 1;
      if (windowIds?.has(seam)) resolutionsMatched += 1;
    }
  }

  const allGreen = failedRounds.length === 0
    && marksMatched === marksTotal
    && resolutionsMatched === resolutionsTotal;

  // Abweichungs-Tabelle je Runde: „alt" und „neu" sind dieselbe Tabelle in
  // derselben D1 — nur nach dataset_id gefiltert (philena-2026-pilot-v4-unseen
  // vs. philena-4y). Kein separates altes Backup, kein zweites Schema.
  const targetMessageCountByRound = new Map((targetRoundRows.results || []).map((r) => [r.round, r.message_count]));
  const targetMarksByRound = new Map((targetMarkCounts.results || []).map((r) => [r.round, r.n]));
  const targetResolutionsByRound = new Map((targetResolutionCounts.results || []).map((r) => [r.round, r.n]));
  const failedRoundSet = new Set(failedRounds);
  const perRound = rounds.map((roundRow) => {
    const oldMarks = (marksByRound.get(roundRow.round) || []).length;
    // Rohe Zeilenzahl (wie targetResolutionCounts), NICHT die nach Auftrag-2-
    // Regel deduplizierte resolutionsByRound — sonst vergleicht man Äpfel mit
    // Birnen: seit Migration 0008 hat jede Naht bis zu zwei Zeilen (Philipp +
    // Lena), was hier sonst wie ein "verdoppelt" aussehender Fehler wirkt.
    const oldResolutions = (resolutionRowsByRound.get(roundRow.round) || []).length;
    const newMarks = targetMarksByRound.get(roundRow.round) ?? 0;
    const newResolutions = targetResolutionsByRound.get(roundRow.round) ?? 0;
    const newMessageCount = targetMessageCountByRound.get(roundRow.round) ?? 0;
    return {
      round: roundRow.round,
      anchored: !failedRoundSet.has(roundRow.round),
      messageCount: { old: roundRow.message_count, new: newMessageCount },
      marks: { old: oldMarks, new: newMarks, diff: newMarks - oldMarks },
      resolutions: { old: oldResolutions, new: newResolutions, diff: newResolutions - oldResolutions },
    };
  });

  return {
    present: true,
    allGreen,
    baseDatasetId: baseId,
    targetDatasetId: targetId,
    checkedFilter: 'isReviewable (Live-Lader)',
    messageCounts: {
      targetIsReviewable: targetStrict.length,
      targetIsReviewableBroad: targetBroad.length,
    },
    rounds: { total: rounds.length, loadable: roundsLoadable, failed: failedRounds },
    marks: { total: marksTotal, matched: marksMatched },
    resolutions: {
      total: resolutionsTotal,
      matched: resolutionsMatched,
      resolved: resolutionsResolved,
      rawRows: rawResolutionRows,
    },
    perRound,
  };
}

async function getAnchorCheck(env: Env): Promise<Response> {
  const report = await computeAnchorReport(env);
  return json({ ok: report.present, ...report }, report.present ? 200 : 404);
}

/**
 * Nur-Lese-Diagnose (Handoff Punkt 8): der Marks-Nachtrag (applyMarksBackfill,
 * siehe unten) hat für gemeinsam geklärte Streitfälle die Entscheidung
 * rückwirkend in review_boundary_marks BEIDER Reviewer geschrieben — dadurch
 * zeigen die ersten 17 Runden in philena-4y künstlich F0=1 für genau diese
 * Nähte. Der Nachtrag wirkte nur auf env.ACTIVE_DATASET_ID, das zum Zeitpunkt
 * des Nachtrags bereits 'philena-4y' war — der eingefrorene alte Datensatz
 * 'philena-2026-pilot-v4-unseen' blieb unangetastet und enthält daher noch
 * die ursprünglichen, echten Einzelmarkierungen. Vergleicht beide Datensätze
 * Naht für Naht: wo im alten Datensatz GENAU EIN Reviewer markiert hat
 * (= ursprünglicher Streitfall) und im neuen BEIDE (= durch den Nachtrag
 * überschrieben), lässt sich die echte rohe F0 vor dem Nachtrag aus den
 * alten Rohdaten rekonstruieren.
 */
/** Parst "11-17,3" zu einem Set { 3, 11, 12, ..., 17 }. Leer/ungültig → null (kein Detail). */
function parseRoundsParam(url: URL): Set<number> | null {
  const raw = url.searchParams.get('rounds');
  if (!raw) return null;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/u);
    if (rangeMatch) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      for (let round = Math.min(from, to); round <= Math.max(from, to); round += 1) out.add(round);
      continue;
    }
    const single = Number(trimmed);
    if (Number.isInteger(single) && single > 0) out.add(single);
  }
  return out.size ? out : null;
}

async function getF0Reconstruction(env: Env, url: URL): Promise<Response> {
  const oldId = 'philena-2026-pilot-v4-unseen';
  const newId = 'philena-4y';
  const detailRounds = parseRoundsParam(url);

  const [oldDataset, newDataset] = await Promise.all([
    env.DB.prepare('SELECT id, year FROM review_datasets WHERE id = ?1 LIMIT 1').bind(oldId).first<DatasetRow>(),
    env.DB.prepare('SELECT id, year FROM review_datasets WHERE id = ?1 LIMIT 1').bind(newId).first<DatasetRow>(),
  ]);
  if (!oldDataset) return error(`Datensatz „${oldId}" nicht gefunden.`, 404);
  if (!newDataset) return error(`Datensatz „${newId}" nicht gefunden.`, 404);

  const [oldRoundRows, oldMarkRows, newMarkRows, newResolutionRows] = await Promise.all([
    env.DB.prepare(
      'SELECT round, first_message_id, message_count FROM review_rounds WHERE dataset_id = ?1 ORDER BY round',
    ).bind(oldId).all<RoundRow>(),
    env.DB.prepare(
      'SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1',
    ).bind(oldId).all<{ round: number; reviewer: Role; seam_message_id: string; mark: 'cut' | 'doubt' }>(),
    env.DB.prepare(
      'SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1',
    ).bind(newId).all<{ round: number; reviewer: Role; seam_message_id: string; mark: 'cut' | 'doubt' }>(),
    // Nur für die Detailansicht (?rounds=) gebraucht: zeigt, ob eine im alten
    // Datensatz strittige Naht im neuen inzwischen eine Resolution hat — auch
    // wenn sie NICHT über das enge „genau einer → beide"-Muster erkannt wurde.
    env.DB.prepare(
      'SELECT round, seam_message_id, decided_by, decision FROM review_boundary_resolutions WHERE dataset_id = ?1',
    ).bind(newId).all<{ round: number; seam_message_id: string; decided_by: string; decision: 'cut' | 'no_cut' | 'open' }>(),
  ]);

  type SeamVotes = { philipp?: 'cut' | 'doubt'; lena?: 'cut' | 'doubt' };
  const byRoundAndKey = (rows: Array<{ round: number; reviewer: Role; seam_message_id: string; mark: 'cut' | 'doubt' }>) => {
    const map = new Map<number, Map<string, SeamVotes>>();
    for (const row of rows) {
      if (!map.has(row.round)) map.set(row.round, new Map());
      const bySeam = map.get(row.round)!;
      const entry = bySeam.get(row.seam_message_id) || {};
      if (row.reviewer === 'Philipp') entry.philipp = row.mark;
      else if (row.reviewer === 'Lena') entry.lena = row.mark;
      bySeam.set(row.seam_message_id, entry);
    }
    return map;
  };
  const oldByRound = byRoundAndKey(oldMarkRows.results || []);
  const newByRound = byRoundAndKey(newMarkRows.results || []);

  const newResolutionsByRound = new Map<number, Array<{ seam_message_id: string; decided_by: string; decision: 'cut' | 'no_cut' | 'open' }>>();
  for (const row of newResolutionRows.results || []) {
    if (!newResolutionsByRound.has(row.round)) newResolutionsByRound.set(row.round, []);
    newResolutionsByRound.get(row.round)!.push(row);
  }

  const perRound: Array<{
    round: number;
    originalDisputes: number;
    overwrittenByBackfill: number;
    trueOldF0: number | null;
    currentNewF0: number | null;
    idMismatch: number;
    seams?: Array<{
      seamMessageId: string;
      originalSetter: string;
      originalMark: string;
      newPhilipp: string | null;
      newLena: string | null;
      newCount: number;
      resolutionDecision: string | null;
      resolutionResolved: boolean;
      resolutionVotes: { philipp: string | null; lena: string | null };
    }>;
  }> = [];
  let idChecked = 0;
  let idMismatchTotal = 0;

  for (const roundRow of oldRoundRows.results || []) {
    const round = roundRow.round;
    const { messages: oldMessages } = await loadRoundWindow(env, oldDataset, round);
    const oldPositions = seamPositions(oldMessages);
    const oldTotalSeams = Math.max(0, oldMessages.length - 1);

    const oldSeamVotes = oldByRound.get(round) || new Map<string, SeamVotes>();
    const newSeamVotes = newByRound.get(round) || new Map<string, SeamVotes>();
    const wantDetail = detailRounds?.has(round) ?? false;
    const resolutionsForRound = wantDetail ? agreeResolutions(newResolutionsByRound.get(round) || []) : [];
    const resolutionBySeam = new Map(resolutionsForRound.map((entry) => [entry.seam_message_id, entry]));

    const philippOldMarks: MarkRow[] = [];
    const lenaOldMarks: MarkRow[] = [];
    let originalDisputes = 0;
    let overwritten = 0;
    let roundMismatch = 0;
    const seamDetails: NonNullable<(typeof perRound)[number]['seams']> = [];

    for (const [seamId, votes] of oldSeamVotes) {
      idChecked += 1;
      // seam_message_id muss im Runden-Fenster des alten Datensatzes auffindbar
      // sein — sonst ist der Naht-Abgleich zwischen den Datensätzen nicht möglich.
      if (!oldPositions.has(seamId)) { roundMismatch += 1; idMismatchTotal += 1; continue; }
      if (votes.philipp) philippOldMarks.push({ seam_message_id: seamId, mark: votes.philipp });
      if (votes.lena) lenaOldMarks.push({ seam_message_id: seamId, mark: votes.lena });

      const oldCount = (votes.philipp ? 1 : 0) + (votes.lena ? 1 : 0);
      if (oldCount === 1) {
        originalDisputes += 1;
        const newVotes = newSeamVotes.get(seamId);
        const newCount = newVotes ? (newVotes.philipp ? 1 : 0) + (newVotes.lena ? 1 : 0) : 0;
        if (newCount === 2) overwritten += 1;

        if (wantDetail) {
          const resolution = resolutionBySeam.get(seamId);
          seamDetails.push({
            seamMessageId: seamId,
            originalSetter: votes.philipp ? 'Philipp' : 'Lena',
            originalMark: votes.philipp || votes.lena || '',
            newPhilipp: newVotes?.philipp ?? null,
            newLena: newVotes?.lena ?? null,
            newCount,
            resolutionDecision: resolution?.decision ?? null,
            resolutionResolved: resolution?.resolved ?? false,
            resolutionVotes: { philipp: resolution?.philipp ?? null, lena: resolution?.lena ?? null },
          });
        }
      }
    }

    const philippNewMarks: MarkRow[] = [];
    const lenaNewMarks: MarkRow[] = [];
    for (const [seamId, votes] of newSeamVotes) {
      if (!oldPositions.has(seamId)) continue;
      if (votes.philipp) philippNewMarks.push({ seam_message_id: seamId, mark: votes.philipp });
      if (votes.lena) lenaNewMarks.push({ seam_message_id: seamId, mark: votes.lena });
    }

    // Beide Vergleiche laufen bewusst über dieselben (alten) Positionen — der
    // Datensatz-Transfer hat first_message_id/message_count unverändert
    // übernommen, die Runden-Fenster sind also identisch.
    const trueOld = compareReviewers(
      toPositionalMarks(philippOldMarks, oldPositions),
      toPositionalMarks(lenaOldMarks, oldPositions),
      { totalSeams: oldTotalSeams, tolerance: 1, doubtMode: 'skip' },
    );
    const currentNew = compareReviewers(
      toPositionalMarks(philippNewMarks, oldPositions),
      toPositionalMarks(lenaNewMarks, oldPositions),
      { totalSeams: oldTotalSeams, tolerance: 1, doubtMode: 'skip' },
    );

    perRound.push({
      round,
      originalDisputes,
      overwrittenByBackfill: overwritten,
      trueOldF0: trueOld.agreementF1,
      currentNewF0: currentNew.agreementF1,
      idMismatch: roundMismatch,
      ...(wantDetail ? { seams: seamDetails } : {}),
    });
  }

  return json({
    ok: true,
    oldDatasetId: oldId,
    newDatasetId: newId,
    idChecked,
    idMismatchTotal,
    affectedRounds: perRound.filter((r) => r.overwrittenByBackfill > 0).length,
    // ?rounds=11-17 (Komma-Liste/Bereiche) liefert für diese Runden zusätzlich
    // eine Naht-für-Naht-Aufschlüsselung (perRound[].seams) statt nur der
    // Rundenzahlen — u. a. um Fälle wie Runde 12 zu klären, wo currentNewF0
    // von trueOldF0 abweicht, ohne dass overwrittenByBackfill das erklärt.
    detailRounds: detailRounds ? [...detailRounds].sort((a, b) => a - b) : null,
    perRound,
  });
}

/**
 * Nur-Lese-Plan (kein Schreib-Endpunkt): zeigt, was nötig wäre, um
 * review_boundary_marks in philena-4y für die Runden 1–17 exakt wieder auf
 * den Stand des eingefrorenen Basis-Datensatzes philena-2026-pilot-v4-unseen
 * zu bringen — unabhängig davon, OB die Abweichung durch den Marks-Nachtrag
 * (cut- oder no_cut-Richtung, siehe applyMarksBackfill) oder durch den
 * inzwischen behobenen Wettlauf beim Speichern (siehe saveMarks-Fix)
 * entstanden ist: reiner Zeilenabgleich (dataset_id, round, reviewer,
 * seam_message_id, mark), keine Neuberechnung nötig.
 *
 * review_boundary_resolutions bleibt in diesem Plan unangetastet — die
 * gemeinsam geklärten Streitfälle bleiben geklärt (GT/F1 unverändert), nur
 * die ROHEN Einzelmarkierungen (F0) würden auf den ursprünglichen,
 * unabhängigen Stand zurückgesetzt.
 */
type MarksRestoreRow = { reviewer: Role; seamMessageId: string; mark: 'cut' | 'doubt' };
type MarksRestoreRound = { round: number; unchanged: number; toAdd: MarksRestoreRow[]; toRemove: MarksRestoreRow[] };
type MarksRestorePlan = {
  oldDatasetId: string;
  newDatasetId: string;
  totals: { toAdd: number; toRemove: number; roundsAffected: number; roundsChecked: number };
  rounds: MarksRestoreRound[];
};

async function computeMarksRestorePlan(env: Env): Promise<MarksRestorePlan | { notFound: string }> {
  const oldId = 'philena-2026-pilot-v4-unseen';
  const newId = 'philena-4y';

  const [oldDataset, newDataset] = await Promise.all([
    env.DB.prepare('SELECT id, year FROM review_datasets WHERE id = ?1 LIMIT 1').bind(oldId).first<DatasetRow>(),
    env.DB.prepare('SELECT id, year FROM review_datasets WHERE id = ?1 LIMIT 1').bind(newId).first<DatasetRow>(),
  ]);
  if (!oldDataset) return { notFound: oldId };
  if (!newDataset) return { notFound: newId };

  type Row = { round: number; reviewer: Role; seam_message_id: string; mark: 'cut' | 'doubt' };
  const [oldRoundRows, oldMarkRows, newMarkRows] = await Promise.all([
    env.DB.prepare('SELECT round FROM review_rounds WHERE dataset_id = ?1 ORDER BY round').bind(oldId).all<{ round: number }>(),
    env.DB.prepare('SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1').bind(oldId).all<Row>(),
    env.DB.prepare('SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1').bind(newId).all<Row>(),
  ]);

  const oldRoundNums = new Set((oldRoundRows.results || []).map((r) => r.round));
  const key = (r: Row) => `${r.round}|${r.reviewer}|${r.seam_message_id}`;

  const oldMap = new Map((oldMarkRows.results || []).filter((r) => oldRoundNums.has(r.round)).map((r) => [key(r), r]));
  const newMap = new Map((newMarkRows.results || []).filter((r) => oldRoundNums.has(r.round)).map((r) => [key(r), r]));

  const perRound = new Map<number, { toAdd: Row[]; toRemove: Row[]; unchanged: number }>();
  for (const round of oldRoundNums) perRound.set(round, { toAdd: [], toRemove: [], unchanged: 0 });

  const seenKeys = new Set<string>();
  for (const [k, oldRow] of oldMap) {
    seenKeys.add(k);
    const bucket = perRound.get(oldRow.round);
    if (!bucket) continue;
    const newRow = newMap.get(k);
    if (!newRow) { bucket.toAdd.push(oldRow); continue; }
    if (newRow.mark !== oldRow.mark) { bucket.toRemove.push(newRow); bucket.toAdd.push(oldRow); continue; }
    bucket.unchanged += 1;
  }
  for (const [k, newRow] of newMap) {
    if (seenKeys.has(k)) continue;
    const bucket = perRound.get(newRow.round);
    if (bucket) bucket.toRemove.push(newRow);
  }

  const rounds: MarksRestoreRound[] = [...perRound.entries()].sort((a, b) => a[0] - b[0]).map(([round, bucket]) => ({
    round,
    unchanged: bucket.unchanged,
    toAdd: bucket.toAdd.map((r) => ({ reviewer: r.reviewer, seamMessageId: r.seam_message_id, mark: r.mark })),
    toRemove: bucket.toRemove.map((r) => ({ reviewer: r.reviewer, seamMessageId: r.seam_message_id, mark: r.mark })),
  }));

  const totalToAdd = rounds.reduce((sum, r) => sum + r.toAdd.length, 0);
  const totalToRemove = rounds.reduce((sum, r) => sum + r.toRemove.length, 0);

  return {
    oldDatasetId: oldId,
    newDatasetId: newId,
    totals: {
      toAdd: totalToAdd,
      toRemove: totalToRemove,
      roundsAffected: rounds.filter((r) => r.toAdd.length > 0 || r.toRemove.length > 0).length,
      roundsChecked: rounds.length,
    },
    rounds,
  };
}

async function getMarksRestorePlan(env: Env): Promise<Response> {
  const plan = await computeMarksRestorePlan(env);
  if ('notFound' in plan) return error(`Datensatz „${plan.notFound}" nicht gefunden.`, 404);
  return json({
    ok: true,
    ...plan,
    note: 'Reiner Plan, keine Schreiboperation. review_boundary_resolutions bleibt unberührt — nur review_boundary_marks würde für diese Runden auf den alten Stand zurückgesetzt.',
  });
}

/**
 * Wendet den Marks-Rückstell-Plan tatsächlich an: review_boundary_marks für
 * die Runden 1–17 in philena-4y wird zeilenweise auf den Stand des
 * eingefrorenen Basis-Datensatzes zurückgesetzt (DELETE der abweichenden/
 * überzähligen Zeilen, INSERT/UPSERT der fehlenden). review_boundary_resolutions
 * bleibt unangetastet. Der Plan wird bei jedem Aufruf frisch neu berechnet
 * (keine gecachten Daten vom Client übernommen), damit die Anwendung nicht
 * auf einem veralteten Stand basiert.
 */
async function applyMarksRestore(request: Request, env: Env): Promise<Response> {
  if (!(await adminAuthorized(request, env))) {
    return error('Nur der Admin darf die Marks-Rückstellung auslösen.', 403);
  }
  let body: { confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return error('Ungültige Anfrage.');
  }
  if (body.confirm !== 'restore-rounds-1-17') {
    return error("Bestätigung fehlt: confirm muss 'restore-rounds-1-17' sein.", 400);
  }

  const plan = await computeMarksRestorePlan(env);
  if ('notFound' in plan) return error(`Datensatz „${plan.notFound}" nicht gefunden.`, 404);

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const round of plan.rounds) {
    for (const row of round.toRemove) {
      statements.push(env.DB.prepare(`
        DELETE FROM review_boundary_marks WHERE dataset_id = ?1 AND round = ?2 AND reviewer = ?3 AND seam_message_id = ?4
      `).bind(plan.newDatasetId, round.round, row.reviewer, row.seamMessageId));
    }
    for (const row of round.toAdd) {
      statements.push(env.DB.prepare(`
        INSERT INTO review_boundary_marks (dataset_id, round, reviewer, seam_message_id, mark, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(dataset_id, round, reviewer, seam_message_id) DO UPDATE SET mark = ?5, updated_at = ?6
      `).bind(plan.newDatasetId, round.round, row.reviewer, row.seamMessageId, row.mark, now));
    }
  }

  if (statements.length > 0) await env.DB.batch(statements);

  return json({
    ok: true,
    applied: statements.length,
    oldDatasetId: plan.oldDatasetId,
    newDatasetId: plan.newDatasetId,
    totals: plan.totals,
    rounds: plan.rounds,
  });
}

/**
 * Additive Übertragung der Grenzdaten der Basis nach philena-4y. Reine
 * INSERT … SELECT: die Basis-id steht ausschließlich in der FROM-Zeile
 * (nur Lesen), geschrieben wird ausnahmslos mit 'philena-4y'. Vier Sicherungen:
 * Admin-Token, Bestätigungsflag, Frische-Prüfung (Ziel muss leer sein) und
 * eine interne Re-Verifikation des Anchor-Checks (schreibt nur bei allGreen).
 */
async function transferBoundaries(request: Request, env: Env): Promise<Response> {
  if (!(await adminAuthorized(request, env))) {
    return error('Nur der Admin darf die Übertragung auslösen.', 403);
  }

  let body: { confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return error('Ungültige Anfrage.');
  }
  if (body.confirm !== 'philena-4y') {
    return error("Bestätigung fehlt: confirm muss 'philena-4y' sein.", 400);
  }

  const baseId = env.ACTIVE_DATASET_ID;
  const targetId = 'philena-4y';

  const report = await computeAnchorReport(env);
  if (!report.present) return error('philena-4y ist nicht importiert.', 404);
  if (!report.allGreen) {
    return json({ ok: false, error: 'Anchor-Check nicht grün — keine Übertragung.', anchor: report }, 409);
  }

  const before = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM review_rounds WHERE dataset_id = ?1) AS rounds,
      (SELECT COUNT(*) FROM review_boundary_marks WHERE dataset_id = ?1) AS marks,
      (SELECT COUNT(*) FROM review_round_submissions WHERE dataset_id = ?1) AS submissions,
      (SELECT COUNT(*) FROM review_boundary_resolutions WHERE dataset_id = ?1) AS resolutions
  `).bind(targetId).first<{ rounds: number; marks: number; submissions: number; resolutions: number }>();
  const existingTotal = Number(before?.rounds || 0) + Number(before?.marks || 0)
    + Number(before?.submissions || 0) + Number(before?.resolutions || 0);
  if (existingTotal > 0) {
    return json({
      ok: false,
      error: 'philena-4y enthält bereits Grenzdaten — Übertragung abgebrochen.',
      existing: before,
    }, 409);
  }

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO review_rounds (dataset_id, round, first_message_id, message_count, created_at)
      SELECT ?1, round, first_message_id, message_count, created_at
      FROM review_rounds WHERE dataset_id = ?2
    `).bind(targetId, baseId),
    env.DB.prepare(`
      INSERT INTO review_boundary_marks (dataset_id, round, reviewer, seam_message_id, mark, created_at, updated_at)
      SELECT ?1, round, reviewer, seam_message_id, mark, created_at, updated_at
      FROM review_boundary_marks WHERE dataset_id = ?2
    `).bind(targetId, baseId),
    env.DB.prepare(`
      INSERT INTO review_round_submissions (dataset_id, round, reviewer, submitted_at)
      SELECT ?1, round, reviewer, submitted_at
      FROM review_round_submissions WHERE dataset_id = ?2
    `).bind(targetId, baseId),
    env.DB.prepare(`
      INSERT INTO review_boundary_resolutions (dataset_id, round, seam_message_id, decision, note, decided_by, decided_at)
      SELECT ?1, round, seam_message_id, decision, note, decided_by, decided_at
      FROM review_boundary_resolutions WHERE dataset_id = ?2
    `).bind(targetId, baseId),
  ]);

  const after = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM review_rounds WHERE dataset_id = ?1) AS rounds,
      (SELECT COUNT(*) FROM review_boundary_marks WHERE dataset_id = ?1) AS marks,
      (SELECT COUNT(*) FROM review_round_submissions WHERE dataset_id = ?1) AS submissions,
      (SELECT COUNT(*) FROM review_boundary_resolutions WHERE dataset_id = ?1) AS resolutions
  `).bind(targetId).first<{ rounds: number; marks: number; submissions: number; resolutions: number }>();

  return json({
    ok: true,
    targetDatasetId: targetId,
    inserted: {
      rounds: Number(after?.rounds || 0),
      marks: Number(after?.marks || 0),
      submissions: Number(after?.submissions || 0),
      resolutions: Number(after?.resolutions || 0),
    },
  });
}

// -------------------------------------------- Marks-Nachtrag (beide Reviewer)

/**
 * Bei einem gemeinsam geklärten Streitfall (BEIDE haben dieselbe Nicht-open-
 * Entscheidung protokolliert, siehe agreeResolutions) trägt diese Funktion die
 * geklärte Entscheidung auch in die rohen Einzelmarkierungen (review_boundary_marks)
 * BEIDER Personen nach — auf ausdrücklichen Wunsch von Philipp, mit dem
 * Wissen, dass die rohe „Übereinstimmung"-Kennzahl dadurch für diese
 * konkreten, damals strittigen Nähte rückwirkend keine ursprüngliche
 * Uneinigkeit mehr zeigt. App-F1/Optimizer brauchen das NICHT — die rechnen
 * bereits über combinedBoundary (Marks + Resolutions) korrekt.
 *
 * decision 'cut'    → beide Reviewer sollen dort mark='cut' stehen haben.
 * decision 'no_cut' → beide Reviewer sollen dort KEINE Zeile haben (entfernen).
 * 'open' (nicht beidseitig geklärt) wird nie angefasst.
 */
type MarksBackfillChange = {
  round: number;
  seamMessageId: string;
  reviewer: Role;
  action: 'set_cut' | 'remove';
  from: 'cut' | 'doubt' | null;
};

async function computeMarksBackfillPlan(env: Env, datasetId: string): Promise<{
  datasetId: string;
  resolvedSeams: number;
  changes: MarksBackfillChange[];
  alreadyCorrect: number;
}> {
  const [resolutionRows, markRows] = await Promise.all([
    env.DB.prepare(`
      SELECT round, seam_message_id, decided_by, decision FROM review_boundary_resolutions WHERE dataset_id = ?1
    `).bind(datasetId).all<{ round: number; seam_message_id: string; decided_by: string; decision: string }>(),
    env.DB.prepare(`
      SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1
    `).bind(datasetId).all<{ round: number; reviewer: Role; seam_message_id: string; mark: 'cut' | 'doubt' }>(),
  ]);

  const resByRound = new Map<number, Array<{ seam_message_id: string; decided_by: string; decision: string }>>();
  for (const row of resolutionRows.results || []) {
    if (!resByRound.has(row.round)) resByRound.set(row.round, []);
    resByRound.get(row.round)!.push(row);
  }

  const markByKey = new Map<string, 'cut' | 'doubt'>();
  for (const row of markRows.results || []) {
    markByKey.set(`${row.round}|${row.reviewer}|${row.seam_message_id}`, row.mark);
  }

  const changes: MarksBackfillChange[] = [];
  let resolvedSeams = 0;
  let alreadyCorrect = 0;

  for (const [round, rows] of resByRound) {
    const agreed = agreeResolutions(rows);
    for (const entry of agreed) {
      if (!entry.resolved) continue; // nur beidseitig übereinstimmend geklärte Nähte
      resolvedSeams += 1;
      for (const reviewer of ['Philipp', 'Lena'] as Role[]) {
        const key = `${round}|${reviewer}|${entry.seam_message_id}`;
        const current = markByKey.get(key) ?? null;
        if (entry.decision === 'cut') {
          if (current === 'cut') { alreadyCorrect += 1; continue; }
          changes.push({ round, seamMessageId: entry.seam_message_id, reviewer, action: 'set_cut', from: current });
        } else if (entry.decision === 'no_cut') {
          if (current === null) { alreadyCorrect += 1; continue; }
          changes.push({ round, seamMessageId: entry.seam_message_id, reviewer, action: 'remove', from: current });
        }
      }
    }
  }

  return { datasetId, resolvedSeams, changes, alreadyCorrect };
}

async function getMarksBackfillPlan(env: Env): Promise<Response> {
  const plan = await computeMarksBackfillPlan(env, env.ACTIVE_DATASET_ID);
  return json({ ok: true, ...plan });
}

async function applyMarksBackfill(request: Request, env: Env): Promise<Response> {
  if (!(await adminAuthorized(request, env))) {
    return error('Nur der Admin darf den Marks-Nachtrag auslösen.', 403);
  }
  let body: { confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return error('Ungültige Anfrage.');
  }
  const datasetId = env.ACTIVE_DATASET_ID;
  if (body.confirm !== datasetId) {
    return error(`Bestätigung fehlt: confirm muss '${datasetId}' sein.`, 400);
  }

  const plan = await computeMarksBackfillPlan(env, datasetId);
  if (plan.changes.length === 0) {
    return json({ ok: true, applied: 0, ...plan });
  }

  const now = new Date().toISOString();
  const statements = plan.changes.map((change) => {
    if (change.action === 'set_cut') {
      return env.DB.prepare(`
        INSERT INTO review_boundary_marks (dataset_id, round, reviewer, seam_message_id, mark, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 'cut', ?5, ?5)
        ON CONFLICT(dataset_id, round, reviewer, seam_message_id) DO UPDATE SET mark = 'cut', updated_at = ?5
      `).bind(datasetId, change.round, change.reviewer, change.seamMessageId, now);
    }
    return env.DB.prepare(`
      DELETE FROM review_boundary_marks WHERE dataset_id = ?1 AND round = ?2 AND reviewer = ?3 AND seam_message_id = ?4
    `).bind(datasetId, change.round, change.reviewer, change.seamMessageId);
  });
  await env.DB.batch(statements);

  return json({
    ok: true,
    applied: plan.changes.length,
    datasetId: plan.datasetId,
    resolvedSeams: plan.resolvedSeams,
    alreadyCorrect: plan.alreadyCorrect,
    changes: plan.changes,
  });
}

// ------------------------------------------------------ Schwellwert-Optimizer

async function optimizeThreshold(env: Env, dataset: DatasetRow, url: URL): Promise<Response> {
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);
  const stepMinutes = Math.max(15, Number(url.searchParams.get('step')) || 15);
  const minMinutes = Math.max(15, Number(url.searchParams.get('min')) || 15);
  const maxMinutes = Math.min(1440, Number(url.searchParams.get('max')) || 720);

  const [sequence, roundRows, submissionRows, allMarks, allResolutions] = await Promise.all([
    filteredSequence(env, dataset.id),
    env.DB.prepare(
      'SELECT round, first_message_id, message_count FROM review_rounds WHERE dataset_id = ?1 ORDER BY round',
    ).bind(dataset.id).all<RoundRow>(),
    env.DB.prepare(
      'SELECT round, reviewer FROM review_round_submissions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: string }>(),
    env.DB.prepare(
      'SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: string; seam_message_id: string; mark: string }>(),
    env.DB.prepare(
      'SELECT round, seam_message_id, decided_by, decision FROM review_boundary_resolutions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; seam_message_id: string; decided_by: string; decision: string }>(),
  ]);

  const seqIndex = new Map<string, number>();
  for (let index = 0; index < sequence.length; index += 1) seqIndex.set(rawId(sequence[index]), index);

  const readyRounds = new Set<number>();
  const subByRound = new Map<number, Set<string>>();
  for (const row of submissionRows.results || []) {
    if (!subByRound.has(row.round)) subByRound.set(row.round, new Set());
    subByRound.get(row.round)!.add(row.reviewer);
  }
  for (const [round, reviewers] of subByRound) {
    if (reviewers.has('Philipp') && reviewers.has('Lena')) readyRounds.add(round);
  }

  const marksByRound = new Map<number, { philipp: MarkRow[]; lena: MarkRow[] }>();
  for (const row of allMarks.results || []) {
    if (!marksByRound.has(row.round)) marksByRound.set(row.round, { philipp: [], lena: [] });
    const entry = marksByRound.get(row.round)!;
    const markRow: MarkRow = { seam_message_id: row.seam_message_id, mark: row.mark as 'cut' | 'doubt' };
    if (row.reviewer === 'Philipp') entry.philipp.push(markRow);
    else if (row.reviewer === 'Lena') entry.lena.push(markRow);
  }

  const resByRound = new Map<number, Array<{ seam_message_id: string; decided_by: string; decision: string }>>();
  for (const row of allResolutions.results || []) {
    if (!resByRound.has(row.round)) resByRound.set(row.round, []);
    resByRound.get(row.round)!.push(row);
  }

  type RoundData = {
    round: number;
    messages: ViewMessage[];
    positions: Map<string, number>;
    totalSeams: number;
    combinedCuts: number[];
  };

  const roundData: RoundData[] = [];
  const existingRounds = (roundRows.results || []).filter((r) => readyRounds.has(r.round));
  for (const roundRow of existingRounds) {
    const startIdx = seqIndex.get(roundRow.first_message_id);
    if (startIdx === undefined) continue;
    const messages = sequence.slice(startIdx, startIdx + roundRow.message_count).map(toView);
    const positions = seamPositions(messages);
    const totalSeams = Math.max(0, messages.length - 1);
    const marks = marksByRound.get(roundRow.round) || { philipp: [], lena: [] };
    const marksP = toPositionalMarks(marks.philipp, positions);
    const marksL = toPositionalMarks(marks.lena, positions);
    const comparison = compareReviewers(marksP, marksL, { totalSeams, tolerance, doubtMode });
    const resolutions = resByRound.get(roundRow.round) || [];
    const agreed = agreeResolutions(resolutions);
    const combined = combinedBoundary(comparison, toPositionalResolutions(agreed, positions));
    roundData.push({ round: roundRow.round, messages, positions, totalSeams, combinedCuts: combined.cuts });
  }

  const results: Array<{
    thresholdMinutes: number;
    thresholdHours: number;
    f1: number;
    pairs: number;
    onlyAuto: number;
    onlyHuman: number;
  }> = [];

  for (let minutes = minMinutes; minutes <= maxMinutes; minutes += stepMinutes) {
    const opts: SegmentationOptions = { pauseBoundaryHours: minutes / 60 };
    let totalPairs = 0;
    let totalOnlyAuto = 0;
    let totalOnlyHuman = 0;

    for (const rd of roundData) {
      const autoResult = segmentConversationWindow(
        toSegmentationInput(rd.messages),
        opts,
      );
      const autoPositions = autoResult.boundaries
        .map((b: { beforeEventId: string }) => rd.positions.get(b.beforeEventId))
        .filter((p: number | undefined): p is number => p !== undefined);
      const vs = pairSeams(autoPositions, rd.combinedCuts, tolerance);
      totalPairs += vs.pairs.length;
      totalOnlyAuto += vs.onlyA.length;
      totalOnlyHuman += vs.onlyB.length;
    }

    const denom = 2 * totalPairs + totalOnlyAuto + totalOnlyHuman;
    results.push({
      thresholdMinutes: minutes,
      thresholdHours: Math.round(minutes / 60 * 100) / 100,
      f1: denom ? (2 * totalPairs) / denom : 0,
      pairs: totalPairs,
      onlyAuto: totalOnlyAuto,
      onlyHuman: totalOnlyHuman,
    });
  }

  const best = results.reduce((a, b) => (b.f1 > a.f1 ? b : a), results[0]);

  // Rein informativer Verlauf für die Settings-Seite — ändert nichts an der
  // tatsächlich laufenden Segmentierung (die bleibt PAUSE_BOUNDARY_HOURS).
  if (best) {
    try {
      await env.DB.prepare(`
        INSERT INTO segment_optimizer_runs
          (dataset_id, ran_at, rounds_used, tolerance, doubt_mode, best_threshold_minutes, best_threshold_hours, best_f1)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `).bind(
        dataset.id, new Date().toISOString(), roundData.length, tolerance, doubtMode,
        best.thresholdMinutes, best.thresholdHours, best.f1,
      ).run();
    } catch (caught) {
      console.error('optimizer run logging failed', caught);
    }
  }

  return json({
    ok: true,
    dataset: dataset.id,
    tolerance,
    doubtMode,
    roundsUsed: roundData.length,
    currentThresholdHours: 3,
    grid: results,
    best: best ? {
      thresholdMinutes: best.thresholdMinutes,
      thresholdHours: best.thresholdHours,
      f1: best.f1,
    } : null,
  });
}

type OptimizerRunRow = {
  ran_at: string;
  rounds_used: number;
  tolerance: number;
  doubt_mode: string;
  best_threshold_minutes: number;
  best_threshold_hours: number;
  best_f1: number;
};

/** Leichtgewichtiger Status für den Seitenaufruf: letzter Lauf + aktuelle
 * Anzahl beidseitig abgegebener Runden, ohne die teure Gittersuche erneut
 * auszuführen. */
async function optimizerStatus(env: Env, dataset: DatasetRow): Promise<Response> {
  const [latestRun, recentRuns, readyRow] = await Promise.all([
    env.DB.prepare(
      'SELECT * FROM segment_optimizer_runs WHERE dataset_id = ?1 ORDER BY ran_at DESC LIMIT 1',
    ).bind(dataset.id).first<OptimizerRunRow>(),
    env.DB.prepare(
      'SELECT * FROM segment_optimizer_runs WHERE dataset_id = ?1 ORDER BY ran_at DESC LIMIT 10',
    ).bind(dataset.id).all<OptimizerRunRow>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT round FROM review_round_submissions WHERE dataset_id = ?1
        GROUP BY round HAVING COUNT(DISTINCT reviewer) = 2
      )
    `).bind(dataset.id).first<{ n: number }>(),
  ]);

  return json({
    ok: true,
    dataset: dataset.id,
    currentThresholdHours: 3,
    readyRoundsNow: readyRow?.n ?? 0,
    latestRun: latestRun ? {
      ranAt: latestRun.ran_at,
      roundsUsed: latestRun.rounds_used,
      tolerance: latestRun.tolerance,
      doubtMode: latestRun.doubt_mode,
      bestThresholdMinutes: latestRun.best_threshold_minutes,
      bestThresholdHours: latestRun.best_threshold_hours,
      bestF1: latestRun.best_f1,
    } : null,
    recentRuns: (recentRuns.results || []).map((row) => ({
      ranAt: row.ran_at,
      roundsUsed: row.rounds_used,
      tolerance: row.tolerance,
      doubtMode: row.doubt_mode,
      bestThresholdMinutes: row.best_threshold_minutes,
      bestThresholdHours: row.best_threshold_hours,
      bestF1: row.best_f1,
    })),
  });
}

// --------------------------------------------------- Validierungs-Split

/** Deterministischer PRNG (mulberry32) — macht einen Split bei Bedarf über
 * den gespeicherten split_seed exakt reproduzierbar. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Fallback, falls noch kein Optimizer-Lauf existiert — derselbe Wert wie
// die hartcodierte PAUSE_BOUNDARY_HOURS-Konstante in segmentation-v4.mjs
// (dort nicht exportiert, deshalb hier gespiegelt statt importiert, analog
// zum bereits vorhandenen "currentThresholdHours: 3" in optimizeThreshold/
// optimizerStatus oben).
const DEFAULT_THRESHOLD_MINUTES = 180;

/**
 * Prüft, ob die gefundene Segmentierungsregel echt ist oder auf den
 * bisherigen Runden overfittet: alle beidseitig abgegebenen Runden werden
 * reproduzierbar (split_seed) 70/30 in Training/Validierung geteilt, der
 * aktuelle/beste Schwellwert (letzter Optimizer-Lauf, sonst
 * DEFAULT_THRESHOLD_MINUTES) wird auf BEIDEN Teilmengen getrennt
 * ausgewertet. Ändert nichts an der laufenden Segmentierung — rein
 * informativ, wie der Optimizer.
 */
async function validateSplit(env: Env, dataset: DatasetRow, url: URL): Promise<Response> {
  const tolerance = parseTolerance(url);
  const doubtMode = parseDoubtMode(url);
  const seedParam = Number(url.searchParams.get('seed'));
  const seed = Number.isFinite(seedParam) && seedParam !== 0 ? Math.trunc(seedParam) : Math.floor(Math.random() * 2 ** 31);

  const [sequence, roundRows, submissionRows, allMarks, allResolutions, latestOptimizerRun] = await Promise.all([
    filteredSequence(env, dataset.id),
    env.DB.prepare(
      'SELECT round, first_message_id, message_count FROM review_rounds WHERE dataset_id = ?1 ORDER BY round',
    ).bind(dataset.id).all<RoundRow>(),
    env.DB.prepare(
      'SELECT round, reviewer FROM review_round_submissions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: string }>(),
    env.DB.prepare(
      'SELECT round, reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; reviewer: string; seam_message_id: string; mark: string }>(),
    env.DB.prepare(
      'SELECT round, seam_message_id, decided_by, decision FROM review_boundary_resolutions WHERE dataset_id = ?1',
    ).bind(dataset.id).all<{ round: number; seam_message_id: string; decided_by: string; decision: string }>(),
    env.DB.prepare(
      'SELECT best_threshold_minutes FROM segment_optimizer_runs WHERE dataset_id = ?1 ORDER BY ran_at DESC LIMIT 1',
    ).bind(dataset.id).first<{ best_threshold_minutes: number }>(),
  ]);

  const seqIndex = new Map<string, number>();
  for (let index = 0; index < sequence.length; index += 1) seqIndex.set(rawId(sequence[index]), index);

  const readyRounds = new Set<number>();
  const subByRound = new Map<number, Set<string>>();
  for (const row of submissionRows.results || []) {
    if (!subByRound.has(row.round)) subByRound.set(row.round, new Set());
    subByRound.get(row.round)!.add(row.reviewer);
  }
  for (const [round, reviewers] of subByRound) {
    if (reviewers.has('Philipp') && reviewers.has('Lena')) readyRounds.add(round);
  }

  const marksByRound = new Map<number, { philipp: MarkRow[]; lena: MarkRow[] }>();
  for (const row of allMarks.results || []) {
    if (!marksByRound.has(row.round)) marksByRound.set(row.round, { philipp: [], lena: [] });
    const entry = marksByRound.get(row.round)!;
    const markRow: MarkRow = { seam_message_id: row.seam_message_id, mark: row.mark as 'cut' | 'doubt' };
    if (row.reviewer === 'Philipp') entry.philipp.push(markRow);
    else if (row.reviewer === 'Lena') entry.lena.push(markRow);
  }

  const resByRound = new Map<number, Array<{ seam_message_id: string; decided_by: string; decision: string }>>();
  for (const row of allResolutions.results || []) {
    if (!resByRound.has(row.round)) resByRound.set(row.round, []);
    resByRound.get(row.round)!.push(row);
  }

  type RoundData = { round: number; messages: ViewMessage[]; positions: Map<string, number>; combinedCuts: number[] };
  const roundData: RoundData[] = [];
  const existingRounds = (roundRows.results || []).filter((r) => readyRounds.has(r.round));
  for (const roundRow of existingRounds) {
    const startIdx = seqIndex.get(roundRow.first_message_id);
    if (startIdx === undefined) continue;
    const messages = sequence.slice(startIdx, startIdx + roundRow.message_count).map(toView);
    const positions = seamPositions(messages);
    const totalSeams = Math.max(0, messages.length - 1);
    const marks = marksByRound.get(roundRow.round) || { philipp: [], lena: [] };
    const marksP = toPositionalMarks(marks.philipp, positions);
    const marksL = toPositionalMarks(marks.lena, positions);
    const comparison = compareReviewers(marksP, marksL, { totalSeams, tolerance, doubtMode });
    const resolutions = resByRound.get(roundRow.round) || [];
    const agreed = agreeResolutions(resolutions);
    const combined = combinedBoundary(comparison, toPositionalResolutions(agreed, positions));
    roundData.push({ round: roundRow.round, messages, positions, combinedCuts: combined.cuts });
  }

  if (roundData.length < 4) {
    return json({
      ok: false,
      error: `Zu wenige beidseitig abgegebene Runden für einen Trainings-/Validierungs-Split (aktuell ${roundData.length}, mindestens 4 nötig).`,
    }, 409);
  }

  const shuffled = seededShuffle(roundData, seed);
  const trainCount = Math.max(1, Math.min(shuffled.length - 1, Math.round(shuffled.length * 0.7)));
  const trainSet = shuffled.slice(0, trainCount);
  const validateSet = shuffled.slice(trainCount);

  const thresholdMinutes = latestOptimizerRun?.best_threshold_minutes ?? DEFAULT_THRESHOLD_MINUTES;
  const opts: SegmentationOptions = { pauseBoundaryHours: thresholdMinutes / 60 };

  const evalF1 = (rounds: RoundData[]): number => {
    let pairs = 0;
    let onlyAuto = 0;
    let onlyHuman = 0;
    for (const rd of rounds) {
      const autoResult = segmentConversationWindow(toSegmentationInput(rd.messages), opts);
      const autoPositions = autoResult.boundaries
        .map((b: { beforeEventId: string }) => rd.positions.get(b.beforeEventId))
        .filter((p: number | undefined): p is number => p !== undefined);
      const vs = pairSeams(autoPositions, rd.combinedCuts, tolerance);
      pairs += vs.pairs.length;
      onlyAuto += vs.onlyA.length;
      onlyHuman += vs.onlyB.length;
    }
    const denom = 2 * pairs + onlyAuto + onlyHuman;
    return denom ? (2 * pairs) / denom : 0;
  };

  const f1Train = evalF1(trainSet);
  const f1Validate = evalF1(validateSet);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO segment_validation_runs
      (dataset_id, ran_at, rounds_total, rounds_train, rounds_validate, split_seed, threshold_minutes, f1_train, f1_validate)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  `).bind(
    dataset.id, now, roundData.length, trainSet.length, validateSet.length,
    seed, thresholdMinutes, f1Train, f1Validate,
  ).run();

  return json({
    ok: true,
    dataset: dataset.id,
    tolerance,
    doubtMode,
    splitSeed: seed,
    thresholdMinutes,
    thresholdHours: Math.round((thresholdMinutes / 60) * 100) / 100,
    roundsTotal: roundData.length,
    roundsTrain: trainSet.length,
    roundsValidate: validateSet.length,
    f1Train,
    f1Validate,
    trainRounds: trainSet.map((r) => r.round).sort((a, b) => a - b),
    validateRounds: validateSet.map((r) => r.round).sort((a, b) => a - b),
  });
}

type ValidationRunRow = {
  ran_at: string;
  rounds_total: number;
  rounds_train: number;
  rounds_validate: number;
  split_seed: number;
  threshold_minutes: number;
  f1_train: number;
  f1_validate: number;
};

/** Leichtgewichtiger Status für den Seitenaufruf, analog zu optimizerStatus(). */
async function validationStatus(env: Env, dataset: DatasetRow): Promise<Response> {
  const [latestRun, recentRuns, readyRow] = await Promise.all([
    env.DB.prepare(
      'SELECT * FROM segment_validation_runs WHERE dataset_id = ?1 ORDER BY ran_at DESC LIMIT 1',
    ).bind(dataset.id).first<ValidationRunRow>(),
    env.DB.prepare(
      'SELECT * FROM segment_validation_runs WHERE dataset_id = ?1 ORDER BY ran_at DESC LIMIT 10',
    ).bind(dataset.id).all<ValidationRunRow>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT round FROM review_round_submissions WHERE dataset_id = ?1
        GROUP BY round HAVING COUNT(DISTINCT reviewer) = 2
      )
    `).bind(dataset.id).first<{ n: number }>(),
  ]);

  return json({
    ok: true,
    dataset: dataset.id,
    readyRoundsNow: readyRow?.n ?? 0,
    latestRun: latestRun ? {
      ranAt: latestRun.ran_at,
      roundsTotal: latestRun.rounds_total,
      roundsTrain: latestRun.rounds_train,
      roundsValidate: latestRun.rounds_validate,
      splitSeed: latestRun.split_seed,
      thresholdMinutes: latestRun.threshold_minutes,
      thresholdHours: Math.round((latestRun.threshold_minutes / 60) * 100) / 100,
      f1Train: latestRun.f1_train,
      f1Validate: latestRun.f1_validate,
    } : null,
    recentRuns: (recentRuns.results || []).map((row) => ({
      ranAt: row.ran_at,
      roundsTotal: row.rounds_total,
      roundsTrain: row.rounds_train,
      roundsValidate: row.rounds_validate,
      splitSeed: row.split_seed,
      thresholdMinutes: row.threshold_minutes,
      thresholdHours: Math.round((row.threshold_minutes / 60) * 100) / 100,
      f1Train: row.f1_train,
      f1Validate: row.f1_validate,
    })),
  });
}

// ----------------------------------------------------------- Verdrahtung

async function boundaryPairsApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !url.pathname.startsWith('/api/rounds/')
    && url.pathname !== '/api/agreement/summary'
    && url.pathname !== '/api/overview'
    && url.pathname !== '/api/admin/filter-check'
    && url.pathname !== '/api/admin/anchor-check'
    && url.pathname !== '/api/admin/f0-reconstruction'
    && url.pathname !== '/api/admin/marks-restore-plan'
    && url.pathname !== '/api/admin/dispute-check'
    && url.pathname !== '/api/admin/marks-restore-apply'
    && url.pathname !== '/api/admin/transfer-boundaries'
    && url.pathname !== '/api/admin/optimize-threshold'
    && url.pathname !== '/api/admin/optimizer-status'
    && url.pathname !== '/api/admin/validate-split'
    && url.pathname !== '/api/admin/validation-status'
    && url.pathname !== '/api/admin/marks-backfill-plan'
    && url.pathname !== '/api/admin/marks-backfill-apply'
    && url.pathname !== '/api/admin/backfill-ordinals'
    && url.pathname !== '/api/admin/segment-diagnose'
    && url.pathname !== '/api/admin/gap-mixture'
    && url.pathname !== '/api/public/gap-mixture'
    && url.pathname !== '/api/public/hourly'
  ) return null;

  // Admin-getokte Schreiboperationen: eigener Gate, nicht die Prüfer-Session.
  if (url.pathname === '/api/admin/transfer-boundaries' && request.method === 'POST') {
    return await transferBoundaries(request, env);
  }
  if (url.pathname === '/api/admin/marks-backfill-apply' && request.method === 'POST') {
    return await applyMarksBackfill(request, env);
  }
  if (url.pathname === '/api/admin/marks-restore-apply' && request.method === 'POST') {
    return await applyMarksRestore(request, env);
  }

  // Öffentliche Aggregat-Route (bewusste Entscheidung, 2026-08-20): ohne Login
  // abrufbar, ausschließlich Aggregate (Histogrammzählungen, GMM-Parameter) —
  // keine Nachricht, kein Zeitstempel, kein Text, keine Namen. Rechnet NIE
  // selbst: sie liefert nur das Ergebnis aus, das ein Admin-Aufruf von
  // /api/admin/gap-mixture einmalig in app_settings abgelegt hat. Die Daten
  // sind statisch (4 Jahre Historie) — einmal rechnen reicht, die Antwort hier
  // ist ein einzelner D1-Read (<1 s) statt Minuten EM-Fit.
  if (url.pathname === '/api/public/gap-mixture' && request.method === 'GET') {
    const dataset = await activeDataset(env, url.searchParams.get('dataset'));
    if (!dataset) return error('Kein aktiver Prüfdatenbestand.', 404);
    try {
      return await publicGapMixture(env, dataset, url, request);
    } catch (caught) {
      console.error('Public gap-mixture failed', caught);
      return error('Die Abstandsanalyse konnte nicht ausgeliefert werden.', 500);
    }
  }

  // Tagesrhythmus einzeln (für externe Abrufer, die nur diesen Ausschnitt
  // brauchen): derselbe abgelegte Datenstand wie /api/public/gap-mixture,
  // nur das dailyRhythm-Feld — reine Zählungen, ein D1-Read, kein Login.
  if (url.pathname === '/api/public/hourly' && request.method === 'GET') {
    const dataset = await activeDataset(env, url.searchParams.get('dataset'));
    if (!dataset) return error('Kein aktiver Prüfdatenbestand.', 404);
    try {
      return await publicHourly(env, dataset, url, request);
    } catch (caught) {
      console.error('Public hourly failed', caught);
      return error('Die Tagesrhythmus-Aggregate konnten nicht ausgeliefert werden.', 500);
    }
  }

  const user = await sessionUser(request, env);
  if (!user) return error('Nicht angemeldet.', 401);

  const dataset = await activeDataset(env, url.searchParams.get('dataset'));
  if (!dataset) return error('Kein aktiver Prüfdatenbestand.', 404);

  try {
    if (url.pathname === '/api/agreement/summary' && request.method === 'GET') {
      return await getSummary(env, dataset, user.role, url);
    }

    if (url.pathname === '/api/overview' && request.method === 'GET') {
      return await getOverview(env, dataset, user.role, url);
    }

    if (url.pathname === '/api/admin/filter-check' && request.method === 'GET') {
      return await getFilterMigrationCheck(env, dataset, url);
    }

    if (url.pathname === '/api/admin/anchor-check' && request.method === 'GET') {
      return await getAnchorCheck(env);
    }

    if (url.pathname === '/api/admin/f0-reconstruction' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf die F0-Rekonstruktion sehen.', 403);
      return await getF0Reconstruction(env, url);
    }

    if (url.pathname === '/api/admin/marks-restore-plan' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf den Marks-Rückstell-Plan sehen.', 403);
      return await getMarksRestorePlan(env);
    }

    if (url.pathname === '/api/admin/dispute-check' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf die Streitfall-Prüfung sehen.', 403);
      return await getDisputeCheck(env, dataset, url);
    }

    if (url.pathname === '/api/admin/optimize-threshold' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf den Optimizer aufrufen.', 403);
      return await optimizeThreshold(env, dataset, url);
    }

    if (url.pathname === '/api/admin/optimizer-status' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf den Optimizer-Status sehen.', 403);
      return await optimizerStatus(env, dataset);
    }

    if (url.pathname === '/api/admin/validate-split' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf den Validierungs-Split auslösen.', 403);
      return await validateSplit(env, dataset, url);
    }

    if (url.pathname === '/api/admin/validation-status' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf den Validierungs-Status sehen.', 403);
      return await validationStatus(env, dataset);
    }

    if (url.pathname === '/api/admin/marks-backfill-plan' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf den Marks-Nachtrag sehen.', 403);
      return await getMarksBackfillPlan(env);
    }

    if (url.pathname === '/api/admin/backfill-ordinals' && request.method === 'POST') {
      if (!user.canUpload) return error('Nur der Admin darf die Ordinalzahlen backfillen.', 403);
      return await backfillOrdinals(env, dataset);
    }

    if (url.pathname === '/api/admin/segment-diagnose' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf die Segment-Diagnose sehen.', 403);
      return await segmentDiagnose(env, dataset, url, request);
    }

    if (url.pathname === '/api/admin/gap-mixture' && request.method === 'GET') {
      if (!user.canUpload) return error('Nur der Admin darf die Abstandsanalyse sehen.', 403);
      return await gapMixture(env, dataset, url, request);
    }

    const match = url.pathname.match(/^\/api\/rounds\/(\d+)(\/marks|\/submit|\/agreement|\/resolve|\/state)?$/u);
    if (!match) return error('Endpunkt nicht gefunden.', 404);
    const round = Number(match[1]);
    if (!Number.isInteger(round) || round < 1) return error('Ungültige Runde.', 422);
    const suffix = match[2] || '';

    if (suffix === '/state' && request.method === 'GET') return await getRoundState(env, dataset, round);
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

// ---- Geteilt mit der Push-Schicht (worker-push.ts) ------------------------

/** Aktiver Prüfdatenbestand (id/year) — an ACTIVE_DATASET_ID gebunden. */
export async function activeDatasetRow(env: Env): Promise<DatasetRow | null> {
  return activeDataset(env);
}

/** Abgabezeitpunkte (submitted_at) einer Person — für „heute schon abgegeben?". */
export async function reviewerSubmissionTimes(env: Env, datasetId: string, reviewer: Role): Promise<string[]> {
  const rows = await env.DB.prepare(`
    SELECT submitted_at FROM review_round_submissions WHERE dataset_id = ?1 AND reviewer = ?2
  `).bind(datasetId, reviewer).all<{ submitted_at: string }>();
  return (rows.results || []).map((row) => row.submitted_at);
}

/**
 * Offene Streitfälle über alle abgabereifen Runden — exakt die Zählung aus
 * getSummary (Auftrag-2-Regel: geklärt nur bei beidseitiger Übereinstimmung).
 * Genutzt für die Push-Schwellenwert-Warnung, damit UI und Benachrichtigung
 * dieselbe Zahl sehen.
 */
export async function openDisputeTotal(
  env: Env,
  dataset: DatasetRow,
  tolerance: number,
  doubtMode: DoubtMode,
): Promise<number> {
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
    .map(([round]) => round);

  let open = 0;
  for (const round of readyRounds) {
    const { messages } = await loadRoundWindow(env, dataset, round);
    const positions = seamPositions(messages);
    const totalSeams = Math.max(0, messages.length - 1);
    const [philippMarks, lenaMarks, resolutionRows] = await Promise.all([
      loadMarks(env, dataset.id, round, 'Philipp'),
      loadMarks(env, dataset.id, round, 'Lena'),
      env.DB.prepare(`
        SELECT seam_message_id, decided_by, decision FROM review_boundary_resolutions
        WHERE dataset_id = ?1 AND round = ?2
      `).bind(dataset.id, round).all<{ seam_message_id: string; decided_by: string; decision: string }>(),
    ]);
    const comparison = compareReviewers(
      toPositionalMarks(philippMarks, positions),
      toPositionalMarks(lenaMarks, positions),
      { totalSeams, tolerance, doubtMode },
    );
    const resolvedCount = agreeResolutions(resolutionRows.results || []).filter((entry) => entry.resolved).length;
    const disputeCount = comparison.onlyA.length + comparison.onlyB.length;
    open += Math.max(0, disputeCount - resolvedCount);
  }
  return open;
}

// ---- Geteilt mit der Klassifizierungs-Schicht (worker-classification.ts) ---

/** Anzeigenachricht einer Runde — wie sie die Klassifizierung zum Rendern braucht. */
export type ClassificationViewMessage = ViewMessage;

export interface RoundCombinedResult {
  /** Nachrichten des Rundenfensters, in Reihenfolge. */
  messages: ViewMessage[];
  /** IDs in Reihenfolge (Bequemlichkeit für deriveSituations). */
  messageIds: string[];
  /** Gemeinsame Grenzpositionen (combinedBoundary.cuts) — Start jeder neuen Situation. */
  cutPositions: number[];
  /** Haben beide Prüfer diese Runde (Grenzen) abgegeben? */
  bothSubmitted: boolean;
  /** Offene Grenz-Streitfälle dieser Runde (nach 0008-Regel). 0 = vollständig geklärt. */
  openDisputes: number;
}

/**
 * Die gemeinsame Grenzfassung einer Runde plus Klärungsstand — exakt die
 * Pipeline aus buildAgreementPayload (compareReviewers → agreeResolutions →
 * combinedBoundary), aber ohne Automatik-Vergleich und Streitfall-Aufbereitung.
 * Genutzt von worker-classification.ts, um Situationen (Spannen zwischen zwei
 * Grenzen) abzuleiten und zu prüfen, ob eine Runde für die Klassifizierung
 * freigegeben ist (beide abgegeben UND keine offenen Grenz-Streitfälle).
 */
export async function combinedBoundaryForRound(
  env: Env,
  dataset: DatasetRow,
  round: number,
  tolerance = 1,
  doubtMode: DoubtMode = 'skip',
): Promise<RoundCombinedResult> {
  const { messages } = await loadRoundWindow(env, dataset, round);
  const positions = seamPositions(messages);
  const totalSeams = Math.max(0, messages.length - 1);

  const [philippMarks, lenaMarks, philippSubmitted, lenaSubmitted, resolutionRows] = await Promise.all([
    loadMarks(env, dataset.id, round, 'Philipp'),
    loadMarks(env, dataset.id, round, 'Lena'),
    submittedAt(env, dataset.id, round, 'Philipp'),
    submittedAt(env, dataset.id, round, 'Lena'),
    env.DB.prepare(`
      SELECT seam_message_id, decision, note, decided_by, decided_at
      FROM review_boundary_resolutions WHERE dataset_id = ?1 AND round = ?2
    `).bind(dataset.id, round).all<ResolutionRow>(),
  ]);

  const comparison = compareReviewers(
    toPositionalMarks(philippMarks, positions),
    toPositionalMarks(lenaMarks, positions),
    { totalSeams, tolerance, doubtMode },
  );
  const agreed = agreeResolutions(resolutionRows.results || []);
  const combined = combinedBoundary(comparison, toPositionalResolutions(agreed, positions));
  const resolvedCount = agreed.filter((entry) => entry.resolved).length;
  const disputeCount = comparison.onlyA.length + comparison.onlyB.length;

  return {
    messages,
    messageIds: messages.map((message) => message.id),
    cutPositions: combined.cuts,
    bothSubmitted: Boolean(philippSubmitted && lenaSubmitted),
    openDisputes: Math.max(0, disputeCount - resolvedCount),
  };
}

/** Aktiver bzw. per ?dataset= gewählter Datenbestand — für die Klassifizierungs-Schicht. */
export async function resolveDatasetRow(env: Env, requestedId?: string | null): Promise<DatasetRow | null> {
  return activeDataset(env, requestedId);
}

/** Alle Runden, die (Grenzen) beidseitig abgegeben wurden — Kandidaten für die Klassifizierung. */
export async function bothSubmittedRounds(env: Env, datasetId: string): Promise<number[]> {
  const rows = await env.DB.prepare(`
    SELECT round, reviewer FROM review_round_submissions WHERE dataset_id = ?1
  `).bind(datasetId).all<{ round: number; reviewer: Role }>();
  const byRound = new Map<number, Set<Role>>();
  for (const row of rows.results || []) {
    if (!byRound.has(row.round)) byRound.set(row.round, new Set());
    byRound.get(row.round)?.add(row.reviewer);
  }
  return [...byRound.entries()]
    .filter(([, reviewers]) => reviewers.has('Philipp') && reviewers.has('Lena'))
    .map(([round]) => round)
    .sort((a, b) => a - b);
}

// ------------------------------------------ Globale Grenz-/Situations-Nummern
//
// Runden-lokale Nummern ("Streitfall 3", situation_index) sind mehrdeutig und
// verschieben sich. Stattdessen bekommt jede Nachricht EINE global stabile
// Positions-Ordinalzahl: ihren 1-basierten Platz in der globalen Chronologie
// (= filteredSequence-/Chunk-Reihenfolge, das ist die Telegram-Export-Reihen-
// folge). Eine Grenze/Naht wird über die ihr folgende Nachricht
// (seam_message_id) benannt → "Grenze N" = Ordinalzahl dieser Nachricht. Eine
// Situation über ihre Start-Grenze → "Situation ab Grenze N" = Ordinalzahl von
// start_message_id. EINE Nummerierungslogik, für Grenzen wie für Situationen.
//
// Persistiert (review_message_ordinals, Migration 0016), damit die Nummern
// unveränderlich sind (Neuimporte hängen nur hinten an) UND die billigen
// Übersichts-Pfade sie per indiziertem Lookup holen, ohne den Chat zu parsen.

/**
 * Stellt sicher, dass jede Nachricht der (bereits geladenen) globalen Folge eine
 * persistente Ordinalzahl hat. Idempotent und append-only: schon vergebene
 * Nummern bleiben, neue Nachrichten bekommen fortlaufend die nächste Nummer
 * hinter der bisher höchsten. Normalfall (nichts Neues) = eine COUNT-Abfrage,
 * kein Schreiben. Aufgerufen dort, wo `sequence` ohnehin schon geladen ist
 * (loadRoundWindow, getOverview, Backfill-Endpunkt) — kein Extra-Parse.
 */
export async function ensureMessageOrdinals(
  env: Env,
  datasetId: string,
  sequence: RawMessage[],
): Promise<void> {
  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) AS c, COALESCE(MAX(ordinal), 0) AS m FROM review_message_ordinals WHERE dataset_id = ?1',
  ).bind(datasetId).first<{ c: number; m: number }>();
  const stored = Number(countRow?.c || 0);
  // Schnellpfad: mindestens so viele Nummern vergeben wie es nummerierbare
  // (id-tragende) Nachrichten gibt → nichts Neues (Append-only). Kein Diff,
  // kein Schreiben. Gegen die Zahl der id-tragenden Nachrichten geprüft (nicht
  // sequence.length), damit id-lose Einträge den Schnellpfad nicht dauerhaft
  // blockieren.
  let numberable = 0;
  for (const message of sequence) if (rawId(message)) numberable += 1;
  if (stored >= numberable) return;

  const existing = new Set<string>();
  const rows = await env.DB.prepare(
    'SELECT message_id FROM review_message_ordinals WHERE dataset_id = ?1',
  ).bind(datasetId).all<{ message_id: string }>();
  for (const row of rows.results || []) existing.add(row.message_id);

  let next = Number(countRow?.m || 0) + 1;
  // Zu vergebende (message_id, ordinal)-Paare in globaler Reihenfolge sammeln.
  const pending: Array<[string, number]> = [];
  for (const message of sequence) {
    const id = rawId(message);
    if (!id || existing.has(id)) continue;
    existing.add(id);
    pending.push([id, next]);
    next += 1;
  }
  if (!pending.length) return;

  // Multi-Row-INSERT statt einer Zeile je Statement: dataset_id als ?1
  // wiederverwendet, je Zeile message_id + ordinal → 1 + 2·Zeilen gebundene
  // Variablen. 49 Zeilen/Statement (max. 99 Binds < 100), mehrere Statements je
  // Batch. So bleibt selbst ein sehr großer Erst-Backfill (4-Jahres-Chat, ggf.
  // Zehntausende Nachrichten) auf wenige Dutzend D1-Roundtrips statt Tausende
  // Einzel-Inserts beschränkt. Append-only: jeder committete Batch bleibt, ein
  // etwaiger Abbruch setzt sich beim nächsten Aufruf fort (existing überspringt
  // die bereits vergebenen).
  const ROWS_PER_STMT = 49;
  const STMTS_PER_BATCH = 20;
  let batch: D1PreparedStatement[] = [];
  const flush = async () => { if (batch.length) { await env.DB.batch(batch); batch = []; } };
  for (let i = 0; i < pending.length; i += ROWS_PER_STMT) {
    const slice = pending.slice(i, i + ROWS_PER_STMT);
    const tuples = slice.map((_, j) => `(?1, ?${2 + j * 2}, ?${3 + j * 2})`).join(',');
    const binds: Array<string | number> = [datasetId];
    for (const [id, ord] of slice) binds.push(id, ord);
    batch.push(
      env.DB.prepare(
        `INSERT INTO review_message_ordinals (dataset_id, message_id, ordinal) VALUES ${tuples}
         ON CONFLICT(dataset_id, message_id) DO NOTHING`,
      ).bind(...binds),
    );
    if (batch.length >= STMTS_PER_BATCH) await flush();
  }
  await flush();
}

/**
 * Globale Ordinalzahlen für die angegebenen Nachrichten-IDs — billiger,
 * indizierter Lookup ohne Chat-Parsing. Fehlt für eine ID noch eine Nummer
 * (Ordinalzahlen noch nicht gebackfillt), fehlt der Eintrag in der Map (der
 * Aufrufer fällt dann auf eine Ersatzanzeige zurück). Chunked auf ≤90 gebundene
 * Variablen, damit D1s 100er-Limit nie überschritten wird.
 */
export async function messageOrdinals(
  env: Env,
  datasetId: string,
  messageIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(messageIds.filter(Boolean))];
  const CHUNK = 90;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    // dataset_id = ?1, IDs = ?2..?N+1.
    const placeholders = batch.map((_, index) => `?${index + 2}`).join(',');
    const rows = await env.DB.prepare(
      `SELECT message_id, ordinal FROM review_message_ordinals WHERE dataset_id = ?1 AND message_id IN (${placeholders})`,
    ).bind(datasetId, ...batch).all<{ message_id: string; ordinal: number }>();
    for (const row of rows.results || []) out.set(row.message_id, Number(row.ordinal));
  }
  return out;
}

/**
 * POST /api/admin/backfill-ordinals — vergibt (einmalig, danach No-Op) die
 * globalen Ordinalzahlen für alle Nachrichten des Datensatzes. Nur canUpload.
 * Nicht zwingend nötig (loadRoundWindow/getOverview backfillen ohnehin beim
 * ersten Zugriff), aber praktisch, um direkt nach Deploy/Migration zu füllen.
 */
async function backfillOrdinals(env: Env, dataset: DatasetRow): Promise<Response> {
  const sequence = await filteredSequence(env, dataset.id);
  await ensureMessageOrdinals(env, dataset.id, sequence);
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS c, COALESCE(MAX(ordinal), 0) AS m FROM review_message_ordinals WHERE dataset_id = ?1',
  ).bind(dataset.id).first<{ c: number; m: number }>();
  return json({ ok: true, dataset: dataset.id, sequenceLength: sequence.length, numbered: Number(row?.c || 0), maxOrdinal: Number(row?.m || 0) });
}


// ---- Diagnose als lesbare Seite -------------------------------------------
//
// Die Diagnose muss auf dem iPad lesbar sein, ohne JSON zu kopieren. Deshalb
// rendert derselbe Endpunkt bei Seitenaufruf (Accept: text/html) eine schlichte
// Seite; `?format=json` liefert weiterhin die Rohdaten. Serverseitig gerendert,
// damit keine zweite Seite plus Skript in die Asset-Liste muss.

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

/** Sekunden als „4 h 01 min" / „13 min" / „–". */
function humanDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–';
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} d ${String(hours).padStart(2, '0')} h`;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} s`;
}

/** Anteil als „12,3 %" (deutsche Schreibweise), null → „–". */
function humanShare(share: number | null | undefined): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return '–';
  return `${(share * 100).toFixed(1).replace('.', ',')} %`;
}

/** Zeitpunkt als „So, 03.05.2026, 14:03" in Europe/Berlin. */
function humanTime(unix: number | null | undefined): string {
  if (!unix) return '–';
  try {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit',
      year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(unix * 1000));
  } catch {
    return '–';
  }
}

function diagnosePage(title: string, body: string): Response {
  // Bewusst eigenständig und ohne Abhängigkeit auf die App-Stylesheets: die
  // Seite soll auch dann lesbar sein, wenn der Service Worker eine alte Fassung
  // der CSS-Dateien ausliefert. Dunkel wie der Rest der App, mobil zuerst.
  const html = `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 16px; background: #14171c; color: #e8eaed;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 21px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 24px 0 8px; color: #9fe3d9; }
  p.sub { color: #9aa3ad; margin: 0 0 20px; font-size: 14px; }
  .card { background: #1c2027; border: 1px solid #2b313a; border-radius: 12px;
          padding: 14px; margin: 0 0 14px; }
  .big { font-size: 30px; font-weight: 700; line-height: 1.2; }
  .big small { font-size: 14px; font-weight: 400; color: #9aa3ad; display: block; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #2b313a; }
  th { color: #9aa3ad; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .flag { color: #ffb4a8; font-weight: 600; }
  .ok { color: #9fe3d9; }
  a { color: #9fe3d9; }
  .note { font-size: 13px; color: #9aa3ad; }
</style>
</head><body>
${body}
</body></html>`;
  return new Response(html, { status: 200, headers: HTML_HEADERS });
}

/**
 * GET /api/admin/segment-diagnose — Read-only-Diagnose der Situations-Herkunft
 * (nur canUpload). Beantwortet Block 2 der Handoff-Frage: aus welchem Grenzsatz
 * stammen die `review_situations`, und wie viele haben eine große interne
 * Zeitlücke (Kennzeichen einer Annotationslücke)?
 *
 * KEINE Datenänderung — ausschließlich SELECTs. Es wird KEIN Nachrichtentext
 * ausgegeben (nur Ordinalzahl, Zeitstempel, Absender, Art).
 *
 * Grundlage: Eine Runde ist ein zusammenhängender Ausschnitt der globalen
 * `filteredSequence`; eine Situation ist ein zusammenhängender Unterausschnitt
 * davon. Damit ist die interne Zeitlücke einer Situation die größte Differenz
 * zweier aufeinanderfolgender Nachrichten zwischen ihrer Start- und
 * End-Nachricht in der globalen Folge — ohne die Runde erneut zu parsen.
 *
 * Übersicht (ohne Drill-down-Parameter): Verteilung der internen Maximallücken
 *   über alle vorbereiteten Situationen (+ Validierungs-Teilmenge) und die 25
 *   Situationen mit der größten Lücke.
 * Drill-down (?situation=<id> | ?round=<r>&index=<i> | ?ordinal=<start-ordinal>):
 *   alle Nachrichten der Situation mit Lücken sowie – je interner Naht – ob in
 *   review_boundary_marks / review_boundary_resolutions etwas steht (wessen,
 *   welcher Zustand). Leer + leer = niemand hat dort je eine Grenze gesehen
 *   (Annotationslücke).
 */
async function segmentDiagnose(env: Env, dataset: DatasetRow, url: URL, request: Request): Promise<Response> {
  // Seitenaufruf im Browser → lesbare Seite; ?format=json → Rohdaten.
  const format = url.searchParams.get('format');
  const wantsHtml = format === 'html'
    || (format !== 'json' && (request.headers.get('accept') || '').includes('text/html'));
  const sequence = await filteredSequence(env, dataset.id);
  const idIndex = new Map<string, number>();
  const secs: number[] = new Array(sequence.length);
  for (let i = 0; i < sequence.length; i += 1) {
    idIndex.set(rawId(sequence[i]), i);
    secs[i] = messageSeconds(sequence[i]);
  }

  const situationRows = (await env.DB.prepare(`
    SELECT id, round, situation_index, start_message_id, end_message_id, in_validation_sample
    FROM review_situations WHERE dataset_id = ?1 ORDER BY round, situation_index
  `).bind(dataset.id).all<{
    id: number; round: number; situation_index: number;
    start_message_id: string; end_message_id: string; in_validation_sample: number;
  }>()).results || [];

  // Ordinalzahlen für Start-/End-Nachrichten (billiger indizierter Lookup).
  const ordIds: string[] = [];
  for (const situation of situationRows) ordIds.push(situation.start_message_id, situation.end_message_id);
  const ordinals = await messageOrdinals(env, dataset.id, ordIds);

  const OVER60 = 3600;
  const OVER180 = 10800;

  type Analyzed = {
    id: number; round: number; situationIndex: number; inValidationSample: number;
    startOrdinal: number | null; endOrdinal: number | null;
    startUnix: number | null; endUnix: number | null; messageCount: number | null;
    maxGapSeconds: number | null; maxGapAfterOrdinal: number | null; resolvable: boolean;
  };

  const analyzed: Analyzed[] = situationRows.map((situation) => {
    const startIdx = idIndex.get(situation.start_message_id);
    const endIdx = idIndex.get(situation.end_message_id);
    const base: Analyzed = {
      id: situation.id, round: situation.round, situationIndex: situation.situation_index,
      inValidationSample: situation.in_validation_sample,
      startOrdinal: ordinals.get(situation.start_message_id) ?? null,
      endOrdinal: ordinals.get(situation.end_message_id) ?? null,
      startUnix: null, endUnix: null, messageCount: null,
      maxGapSeconds: null, maxGapAfterOrdinal: null, resolvable: false,
    };
    // Nicht auffindbar (z. B. additiv übertragene Runde) → nicht in die
    // Lücken-Statistik, aber gezählt.
    if (startIdx === undefined || endIdx === undefined || endIdx < startIdx) return base;
    let maxGap = 0;
    let maxAt = -1;
    for (let i = startIdx; i < endIdx; i += 1) {
      const gap = secs[i + 1] - secs[i];
      if (gap > maxGap) { maxGap = gap; maxAt = i + 1; }
    }
    return {
      ...base,
      resolvable: true,
      startUnix: secs[startIdx],
      endUnix: secs[endIdx],
      messageCount: endIdx - startIdx + 1,
      maxGapSeconds: maxGap,
      maxGapAfterOrdinal: maxAt >= 0 ? (ordinals.get(rawId(sequence[maxAt])) ?? null) : null,
    };
  });

  // ---- Drill-down: eine einzelne Situation zerlegen -----------------------
  const wantSituation = url.searchParams.get('situation');
  const wantRound = url.searchParams.get('round');
  const wantIndex = url.searchParams.get('index');
  const wantOrdinal = url.searchParams.get('ordinal');
  if (wantSituation || (wantRound && wantIndex) || wantOrdinal) {
    let target: (typeof situationRows)[number] | null = null;
    if (wantSituation) {
      target = situationRows.find((situation) => situation.id === Number(wantSituation)) || null;
    } else if (wantRound && wantIndex) {
      target = situationRows.find(
        (situation) => situation.round === Number(wantRound) && situation.situation_index === Number(wantIndex),
      ) || null;
    } else if (wantOrdinal) {
      target = situationRows.find(
        (situation) => (ordinals.get(situation.start_message_id) ?? -1) === Number(wantOrdinal),
      ) || null;
    }
    if (!target) return error('Situation nicht gefunden.', 404);

    const startIdx = idIndex.get(target.start_message_id);
    const endIdx = idIndex.get(target.end_message_id);
    if (startIdx === undefined || endIdx === undefined) {
      return json({
        ok: true, mode: 'situation', dataset: dataset.id, situation: { ...target },
        note: 'Start-/End-Nachricht in der aktuellen Folge nicht auffindbar (evtl. übertragene Runde).',
      });
    }

    // Markierungen + Auflösungen dieser Runde einmal laden, nach Naht gruppieren.
    const markRows = (await env.DB.prepare(`
      SELECT reviewer, seam_message_id, mark FROM review_boundary_marks WHERE dataset_id = ?1 AND round = ?2
    `).bind(dataset.id, target.round).all<{ reviewer: string; seam_message_id: string; mark: string }>()).results || [];
    const resRows = (await env.DB.prepare(`
      SELECT seam_message_id, decision, note, decided_by FROM review_boundary_resolutions WHERE dataset_id = ?1 AND round = ?2
    `).bind(dataset.id, target.round).all<{ seam_message_id: string; decision: string; note: string | null; decided_by: string }>()).results || [];
    const marksBySeam = new Map<string, Array<{ reviewer: string; mark: string }>>();
    for (const mark of markRows) {
      const list = marksBySeam.get(mark.seam_message_id) || [];
      list.push({ reviewer: mark.reviewer, mark: mark.mark });
      marksBySeam.set(mark.seam_message_id, list);
    }
    const resBySeam = new Map<string, Array<{ decidedBy: string; decision: string; note: string | null }>>();
    for (const res of resRows) {
      const list = resBySeam.get(res.seam_message_id) || [];
      list.push({ decidedBy: res.decided_by, decision: res.decision, note: res.note });
      resBySeam.set(res.seam_message_id, list);
    }

    const messages: unknown[] = [];
    const seams: unknown[] = [];
    for (let i = startIdx; i <= endIdx; i += 1) {
      const id = rawId(sequence[i]);
      const view = toView(sequence[i]);
      messages.push({
        ordinal: ordinals.get(id) ?? null,
        unix: secs[i],
        iso: secs[i] ? new Date(secs[i] * 1000).toISOString() : null,
        from: view.from,
        kind: view.kind,
        gapBeforeSeconds: i > startIdx ? secs[i] - secs[i - 1] : null,
      });
      if (i > startIdx) {
        const seamMarks = marksBySeam.get(id) || [];
        const seamRes = resBySeam.get(id) || [];
        seams.push({
          seamMessageId: id,
          afterOrdinal: ordinals.get(id) ?? null,
          gapSeconds: secs[i] - secs[i - 1],
          marks: seamMarks,
          resolutions: seamRes,
          // Kein Cut in der kombinierten Fassung ⇒ beide leer = Annotationslücke
          // (niemand hat hier je eine Grenze gesehen); markiert+aufgelöst-no_cut
          // = bewusst zusammengelassen.
          annotationGap: seamMarks.length === 0 && seamRes.length === 0,
        });
      }
    }
    const analyzedTarget = analyzed.find((entry) => entry.id === target!.id) || null;
    if (wantsHtml) {
      type Msg = { ordinal: number | null; unix: number; from: string; kind: string; gapBeforeSeconds: number | null };
      type Seam = { afterOrdinal: number | null; gapSeconds: number; marks: Array<{ reviewer: string; mark: string }>;
        resolutions: Array<{ decidedBy: string; decision: string; note: string | null }>; annotationGap: boolean };
      const msgList = messages as Msg[];
      const seamList = seams as Seam[];
      const seamByOrdinal = new Map<number | null, Seam>(seamList.map((seam) => [seam.afterOrdinal, seam]));
      const rows = msgList.map((message) => {
        const seam = seamByOrdinal.get(message.ordinal);
        const gap = message.gapBeforeSeconds;
        // Nur wirklich große Abstände hervorheben — das ist die Frage hier.
        const loud = gap !== null && gap > 3600;
        const grenze = !seam
          ? '—'
          : (seam.marks.length === 0 && seam.resolutions.length === 0
            ? '<span class="flag">niemand</span>'
            : escapeHtml([
              ...seam.marks.map((mark) => `${mark.reviewer}: ${mark.mark}`),
              ...seam.resolutions.map((res) => `${res.decidedBy} → ${res.decision}`),
            ].join(' · ')));
        return `<tr>
          <td class="num">${message.ordinal ?? '–'}</td>
          <td>${escapeHtml(humanTime(message.unix))}</td>
          <td class="num${loud ? ' flag' : ''}">${gap === null ? '' : escapeHtml(humanDuration(gap))}</td>
          <td>${escapeHtml(message.from)}</td>
          <td>${escapeHtml(message.kind)}</td>
          <td>${grenze}</td>
        </tr>`;
      }).join('');
      const offen = seamList.filter((seam) => seam.annotationGap && seam.gapSeconds > 3600);
      const startOrd = ordinals.get(target.start_message_id) ?? null;
      const endOrd = ordinals.get(target.end_message_id) ?? null;
      return diagnosePage(`Situation ${target.id} · Diagnose`, `
        <h1>Situation ${target.id}</h1>
        <p class="sub">Runde ${target.round} · Situation-Index ${target.situation_index}
          · Grenze ${startOrd ?? '–'} bis ${endOrd ?? '–'} · ${msgList.length} Nachrichten
          · ${target.in_validation_sample === 1 ? 'in der Stichprobe' : 'nicht in der Stichprobe'}</p>
        <div class="card">
          <div class="big">${escapeHtml(humanDuration(analyzedTarget?.maxGapSeconds ?? null))}
            <small>größte Lücke innerhalb dieser Situation</small></div>
        </div>
        <div class="card">
          <b>${offen.length === 0
            ? '<span class="ok">Keine unmarkierte Lücke über 1 Stunde.</span>'
            : `<span class="flag">${offen.length} Lücke(n) über 1 Stunde, an denen niemand eine Grenze gesetzt hat.</span>`}</b>
          <p class="note">„niemand" in der Spalte Grenze heißt: an dieser Naht steht weder eine Markierung
            (review_boundary_marks) noch eine Streitfall-Auflösung (review_boundary_resolutions) —
            also eine Annotationslücke, kein Parameterfehler.</p>
        </div>
        <h2>Nachrichten dieser Situation</h2>
        <div class="wrap"><table>
          <thead><tr><th class="num">Grenze</th><th>Zeit (Berlin)</th><th class="num">Abstand davor</th>
            <th>Von</th><th>Art</th><th>Grenze gesetzt?</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="note"><a href="/api/admin/segment-diagnose">← zur Übersicht</a>
          · <a href="?situation=${target.id}&amp;format=json">Rohdaten</a></p>
      `);
    }
    return json({
      ok: true, mode: 'situation', dataset: dataset.id,
      situation: {
        id: target.id, round: target.round, situationIndex: target.situation_index,
        inValidationSample: target.in_validation_sample,
        startOrdinal: ordinals.get(target.start_message_id) ?? null,
        endOrdinal: ordinals.get(target.end_message_id) ?? null,
        maxGapSeconds: analyzedTarget?.maxGapSeconds ?? null,
      },
      messages,
      seams,
    });
  }

  // ---- Übersicht: Verteilung der internen Maximallücken -------------------
  const distribution = (subset: Analyzed[]) => {
    const resolvable = subset.filter((entry) => entry.resolvable);
    const over60 = resolvable.filter((entry) => (entry.maxGapSeconds ?? 0) > OVER60).length;
    const over180 = resolvable.filter((entry) => (entry.maxGapSeconds ?? 0) > OVER180).length;
    const n = resolvable.length;
    return {
      prepared: subset.length,
      resolvable: n,
      unresolvable: subset.length - n,
      over60min: over60,
      over60minShare: n ? over60 / n : null,
      over180min: over180,
      over180minShare: n ? over180 / n : null,
    };
  };

  const worst = analyzed
    .filter((entry) => entry.resolvable)
    .sort((a, b) => (b.maxGapSeconds ?? 0) - (a.maxGapSeconds ?? 0))
    .slice(0, 25)
    .map((entry) => ({
      id: entry.id, round: entry.round, situationIndex: entry.situationIndex,
      inValidationSample: entry.inValidationSample,
      startOrdinal: entry.startOrdinal, endOrdinal: entry.endOrdinal,
      messageCount: entry.messageCount,
      startIso: entry.startUnix ? new Date(entry.startUnix * 1000).toISOString() : null,
      endIso: entry.endUnix ? new Date(entry.endUnix * 1000).toISOString() : null,
      maxGapSeconds: entry.maxGapSeconds,
      maxGapMinutes: entry.maxGapSeconds !== null ? Math.round(entry.maxGapSeconds / 60) : null,
      maxGapAfterOrdinal: entry.maxGapAfterOrdinal,
    }));

  // ---- 2.3: Segmentlängen + Lücken zwischen aufeinanderfolgenden Segmenten -
  const quantiles = (values: number[]) => {
    if (!values.length) return { n: 0, min: null, q1: null, median: null, q3: null, max: null };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => {
      const idx = (sorted.length - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return sorted[lo];
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    };
    return { n: sorted.length, min: sorted[0], q1: at(0.25), median: at(0.5), q3: at(0.75), max: sorted[sorted.length - 1] };
  };
  const countOver = (values: number[], threshold: number) => values.filter((value) => value > threshold).length;
  const shareOver = (values: number[], threshold: number) => (values.length ? countOver(values, threshold) / values.length : null);

  const resolvableSegs = analyzed.filter((entry) => entry.resolvable);
  const lengthMessages = resolvableSegs.map((entry) => entry.messageCount as number);
  const lengthSeconds = resolvableSegs.map((entry) => (entry.endUnix as number) - (entry.startUnix as number));

  // Lücke zwischen zwei aufeinanderfolgenden Segmenten DERSELBEN Runde = der
  // Zeitabstand an der von den Prüfern gesetzten Grenze (die Segmente einer
  // Runde partitionieren sie zusammenhängend). So misst die Verteilung genau
  // die Abstände AN den gezogenen Schnitten.
  const byRound = new Map<number, Analyzed[]>();
  for (const entry of resolvableSegs) {
    const list = byRound.get(entry.round) || [];
    list.push(entry);
    byRound.set(entry.round, list);
  }
  const interSegmentGaps: number[] = [];
  for (const list of byRound.values()) {
    list.sort((a, b) => a.situationIndex - b.situationIndex);
    for (let i = 1; i < list.length; i += 1) {
      interSegmentGaps.push((list[i].startUnix as number) - (list[i - 1].endUnix as number));
    }
  }
  const H6 = 21600;
  const H12 = 43200;
  const H24 = 86400;
  const H72 = 259200;

  if (wantsHtml) {
    const allDist = distribution(analyzed);
    const sampleDist = distribution(analyzed.filter((entry) => entry.inValidationSample === 1));
    const q = (stats: ReturnType<typeof quantiles>, asDuration: boolean) => {
      const f = (value: number | null) => (value === null
        ? '–'
        : (asDuration ? humanDuration(value) : String(Math.round(value))));
      return `<tr><td>${asDuration ? 'Dauer' : 'Nachrichten'}</td>
        <td class="num">${escapeHtml(f(stats.min))}</td>
        <td class="num">${escapeHtml(f(stats.q1))}</td>
        <td class="num"><b>${escapeHtml(f(stats.median))}</b></td>
        <td class="num">${escapeHtml(f(stats.q3))}</td>
        <td class="num">${escapeHtml(f(stats.max))}</td></tr>`;
    };
    const gapStats = quantiles(interSegmentGaps);
    const worstRows = worst.map((entry) => `<tr>
      <td class="num"><a href="?situation=${entry.id}">${entry.id}</a></td>
      <td class="num">${entry.round}</td>
      <td class="num">${entry.startOrdinal ?? '–'}</td>
      <td class="num">${entry.messageCount ?? '–'}</td>
      <td class="num flag">${escapeHtml(humanDuration(entry.maxGapSeconds))}</td>
      <td>${entry.inValidationSample === 1 ? 'ja' : '—'}</td>
    </tr>`).join('');

    return diagnosePage('Segment-Diagnose', `
      <h1>Segment-Diagnose</h1>
      <p class="sub">Datensatz ${escapeHtml(dataset.id)} · ${sequence.length} Nachrichten in der Folge
        · ${allDist.prepared} vorbereitete Situationen</p>

      <div class="card">
        <b>Herkunft der Situationen: Annotationslücke, kein Parameterfehler.</b>
        <p class="note">review_situations entstehen in deriveSituationsForRound aus
          combinedBoundaryForRound — also aus den Markierungen von Philipp und Lena plus den
          beidseitig aufgelösten Streitfällen. deriveSituations teilt danach nur noch nach
          Positionen; es gibt in diesem Pfad keine Zeit- oder Schwellwertlogik. Große Lücken
          innerhalb einer Situation heißen deshalb: dort hat niemand geschnitten.</p>
      </div>

      <h2>Interne Lücken — wie oft bleibt eine große Pause ungeschnitten?</h2>
      <div class="grid">
        <div class="card"><div class="big">${allDist.over60min}
          <small>Situationen mit Lücke &gt; 60 min<br>${escapeHtml(humanShare(allDist.over60minShare))} von ${allDist.resolvable}</small></div></div>
        <div class="card"><div class="big">${allDist.over180min}
          <small>davon &gt; 180 min<br>${escapeHtml(humanShare(allDist.over180minShare))} von ${allDist.resolvable}</small></div></div>
      </div>
      <div class="card">
        <b>Nur die Validierungsstichprobe</b>
        <p class="note">${sampleDist.resolvable} Situationen ·
          &gt; 60 min: ${sampleDist.over60min} (${escapeHtml(humanShare(sampleDist.over60minShare))}) ·
          &gt; 180 min: ${sampleDist.over180min} (${escapeHtml(humanShare(sampleDist.over180minShare))})</p>
        ${allDist.unresolvable > 0
          ? `<p class="note">${allDist.unresolvable} Situationen nicht auswertbar (Start-/End-Nachricht nicht in der aktuellen Folge, z. B. übertragene Runden).</p>`
          : ''}
      </div>

      <h2>Segmentlängen</h2>
      <div class="wrap"><table>
        <thead><tr><th></th><th class="num">Min</th><th class="num">25 %</th><th class="num">Median</th><th class="num">75 %</th><th class="num">Max</th></tr></thead>
        <tbody>${q(quantiles(lengthMessages), false)}${q(quantiles(lengthSeconds), true)}</tbody>
      </table></div>

      <h2>Lücken zwischen aufeinanderfolgenden Segmenten</h2>
      <p class="note">Gemessen an den gesetzten Schnitten innerhalb einer Runde
        (${interSegmentGaps.length} Übergänge). Über Rundengrenzen hinweg gibt es keinen
        definierten Abstand — die Runden sind Fenster, keine lückenlose Zerlegung.</p>
      <div class="wrap"><table>
        <thead><tr><th></th><th class="num">Min</th><th class="num">25 %</th><th class="num">Median</th><th class="num">75 %</th><th class="num">Max</th></tr></thead>
        <tbody><tr><td>Abstand</td>
          <td class="num">${escapeHtml(humanDuration(gapStats.min))}</td>
          <td class="num">${escapeHtml(humanDuration(gapStats.q1))}</td>
          <td class="num"><b>${escapeHtml(humanDuration(gapStats.median))}</b></td>
          <td class="num">${escapeHtml(humanDuration(gapStats.q3))}</td>
          <td class="num">${escapeHtml(humanDuration(gapStats.max))}</td></tr></tbody>
      </table></div>
      <div class="wrap"><table>
        <thead><tr><th>Schwelle</th><th class="num">Anzahl</th><th class="num">Anteil</th></tr></thead>
        <tbody>
          <tr><td>&gt; 6 h</td><td class="num">${countOver(interSegmentGaps, H6)}</td><td class="num">${escapeHtml(humanShare(shareOver(interSegmentGaps, H6)))}</td></tr>
          <tr><td>&gt; 12 h</td><td class="num">${countOver(interSegmentGaps, H12)}</td><td class="num">${escapeHtml(humanShare(shareOver(interSegmentGaps, H12)))}</td></tr>
          <tr><td>&gt; 24 h</td><td class="num">${countOver(interSegmentGaps, H24)}</td><td class="num">${escapeHtml(humanShare(shareOver(interSegmentGaps, H24)))}</td></tr>
          <tr><td>&gt; 72 h</td><td class="num">${countOver(interSegmentGaps, H72)}</td><td class="num">${escapeHtml(humanShare(shareOver(interSegmentGaps, H72)))}</td></tr>
        </tbody>
      </table></div>

      <h2>Die 25 Situationen mit der größten internen Lücke</h2>
      <p class="note">Nummer antippen öffnet die Situation mit allen Nachrichten und dem
        Grenzstatus je Naht.</p>
      <div class="wrap"><table>
        <thead><tr><th class="num">Situation</th><th class="num">Runde</th><th class="num">ab Grenze</th>
          <th class="num">Nachr.</th><th class="num">größte Lücke</th><th>Stichprobe</th></tr></thead>
        <tbody>${worstRows}</tbody>
      </table></div>

      <p class="note"><a href="?format=json">Rohdaten als JSON</a></p>
    `);
  }

  return json({
    ok: true, mode: 'overview', dataset: dataset.id,
    sequenceLength: sequence.length,
    origin:
      'review_situations stammen aus combinedBoundaryForRound → compareReviewers(review_boundary_marks) '
      + '+ agreeResolutions(review_boundary_resolutions); deriveSituations ist ein reiner Positions-Split '
      + 'ohne Zeit-/Schwellwertlogik. Große interne Lücken sind daher Annotationslücken (menschliche Grenzen), '
      + 'kein Parameterfehler eines Algorithmus.',
    internalGap: {
      all: distribution(analyzed),
      validationSample: distribution(analyzed.filter((entry) => entry.inValidationSample === 1)),
      worst,
    },
    // 2.3 — Grundlage für die Ketten-Schwellen in Block 3 (rein informativ).
    segments: {
      count: resolvableSegs.length,
      lengthMessages: quantiles(lengthMessages),
      lengthSeconds: quantiles(lengthSeconds),
      interSegmentGapSeconds: {
        ...quantiles(interSegmentGaps),
        over6h: countOver(interSegmentGaps, H6),
        over6hShare: shareOver(interSegmentGaps, H6),
        over12h: countOver(interSegmentGaps, H12),
        over12hShare: shareOver(interSegmentGaps, H12),
        over24h: countOver(interSegmentGaps, H24),
        over24hShare: shareOver(interSegmentGaps, H24),
        over72h: countOver(interSegmentGaps, H72),
        over72hShare: shareOver(interSegmentGaps, H72),
      },
    },
  });
}


// ---- Δt-Mischverteilung ----------------------------------------------------
//
// GET /api/admin/gap-mixture — Read-only. Nimmt alle Abstände zwischen
// benachbarten Nachrichten der gefilterten Folge, rechnet log₁₀(Δt in
// Sekunden) und passt Gauß-Mischungen mit k = 1…4 an. Zweck: prüfen, ob die
// Pausenverteilung überhaupt eine natürliche Struktur hat. Wählt BIC k = 1,
// gibt es keine datengestützte Zeitschwelle — dann ist jede Schwelle gesetzt,
// nicht gefunden.
//
// Ausschließlich Aggregate: Gewichte, Mittelwerte, Streuungen, Grenzen,
// Histogrammzählungen. Keine Nachricht, kein Zeitstempel, kein Text.

/** Eine Sekundenzahl in mehreren Einheiten, plus lesbare Form. */
function describeSeconds(seconds: number): {
  seconds: number; minutes: number; hours: number; human: string;
} {
  return {
    seconds: Math.round(seconds * 1000) / 1000,
    minutes: Math.round((seconds / 60) * 1000) / 1000,
    hours: Math.round((seconds / 3600) * 1000) / 1000,
    human: humanDuration(seconds),
  };
}

type MixtureBlock = ReturnType<typeof mixtureBlock>;

type GapMixturePayload = {
  ok: boolean; dataset: string; messages: number; gaps: number;
  clampedToOneSecond: number; minSeconds: number; maxSeconds: number;
  bins: number; maxK: number; maxIterations: number;
  scope: string; computedAt: string;
  overall: MixtureBlock;
  byYear: Array<{ year: string } & MixtureBlock>;
  // Tagesrhythmus (Nachrichten je Stunde pro Sender, Startstunden der Pausen).
  // Optional: vor dieser Erweiterung abgelegte Dokumente tragen das Feld nicht.
  dailyRhythm?: ReturnType<typeof hourlyAggregates>;
};

// Schlüssel, unter dem das fertig gerechnete kanonische Ergebnis (Standard-
// Parameter, alle Jahre) je Datensatz in app_settings liegt. Die öffentliche
// Route liest NUR diesen Eintrag — sie rechnet nie selbst.
function gapMixtureStoreKey(datasetId: string): string {
  return `gap_mixture_result:${datasetId}`;
}

/** Fit + Kennzahlen für eine Wertemenge (alle Jahre oder ein Kalenderjahr). */
function mixtureBlock(values: number[], bins: number, maxK: number, maxIterations: number) {
  const { fits, bestK } = fitRange(values, { maxK, maxIterations });
  const best = fits.find((fit) => fit.k === bestK) || fits[0];
  const boundaries = best ? decisionBoundaries(best) : [];
  const hist = histogram(values, bins);
  return {
    n: values.length,
    bicByK: fits.map((fit) => ({
      k: fit.k,
      logLikelihood: fit.logLikelihood,
      bic: fit.bic,
      aic: fit.aic,
      iterations: fit.iterations,
      converged: fit.converged,
    })),
    bestK,
    // Komponenten aufsteigend nach Mittelwert (Komponente 1 = die schnellste).
    components: (best ? best.means : []).map((mean, index) => {
      const sd = best.sigmas[index];
      return {
        index: index + 1,
        weight: best.weights[index],
        meanLog10: mean,
        sdLog10: sd,
        center: describeSeconds(10 ** mean),
        // ±1 Streuung, zurückgerechnet — im Logarithmus symmetrisch, in
        // Sekunden ein multiplikatives Intervall.
        low1Sd: describeSeconds(10 ** (mean - sd)),
        high1Sd: describeSeconds(10 ** (mean + sd)),
      };
    }),
    boundaries: boundaries.map((boundary) => ({
      between: boundary.between.map((index) => index + 1) as [number, number],
      log10: boundary.log10,
      ...(boundary.log10 === null ? { value: null } : { value: describeSeconds(10 ** boundary.log10) }),
    })),
    histogram: {
      bins: hist.bins,
      minLog10: hist.min,
      maxLog10: hist.max,
      widthLog10: hist.width,
      counts: hist.counts,
      edgesLog10: hist.edges,
      edgesSeconds: hist.edges.map((edge) => 10 ** edge),
    },
  };
}

// Fertige Antworten je (Datenstand, Parameter, Format) — die Rechnung ist mit
// Abstand das Teuerste an der Route; für die öffentliche Variante zugleich die
// Missbrauchsbremse. Invalidiert sich selbst über den Sequenz-Fingerprint.
const gapMixtureCache = new Map<string, { fingerprint: string; body: string; html: boolean }>();
const GAP_MIXTURE_CACHE_MAX = 12;

async function gapMixture(env: Env, dataset: DatasetRow, url: URL, request: Request, publicLimits = false): Promise<Response> {
  const format = url.searchParams.get('format');
  const wantsHtml = format === 'html'
    || (format !== 'json' && (request.headers.get('accept') || '').includes('text/html'));

  // Öffentlich gelten engere Klemmen — die Route ist ohne Login erreichbar.
  const maxBins = publicLimits ? 120 : 300;
  const maxKCap = publicLimits ? 4 : 8;
  const maxIterCap = publicLimits ? 300 : 1000;
  const requestedBins = Number(url.searchParams.get('bins'));
  const bins = Number.isFinite(requestedBins) && requestedBins >= 5 && requestedBins <= maxBins
    ? Math.floor(requestedBins) : 60;
  const requestedMaxK = Number(url.searchParams.get('maxK'));
  const maxK = Number.isFinite(requestedMaxK) && requestedMaxK >= 1 && requestedMaxK <= maxKCap
    ? Math.floor(requestedMaxK) : 4;
  const requestedIterations = Number(url.searchParams.get('maxIterations'));
  const maxIterations = Number.isFinite(requestedIterations) && requestedIterations >= 10 && requestedIterations <= maxIterCap
    ? Math.floor(requestedIterations) : 300;

  const scopeParam = url.searchParams.get('scope');
  const yearParam = url.searchParams.get('year');
  const onlyYear = yearParam && /^\d{4}$/u.test(yearParam) ? yearParam : null;
  const overallOnly = scopeParam === 'overall';

  const fingerprint = await sequenceFingerprint(env, dataset.id);
  const cacheKey = `${dataset.id}|${bins}|${maxK}|${maxIterations}|${overallOnly ? 'overall' : (onlyYear || 'all')}|${wantsHtml ? 'html' : 'json'}`;
  const cached = gapMixtureCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) {
    return new Response(cached.body, { status: 200, headers: cached.html ? HTML_HEADERS : JSON_HEADERS });
  }

  const sequence = await filteredSequence(env, dataset.id);
  const seconds = sequence.map((message) => messageSeconds(message));

  const overallGaps = logGapsFromTimestamps(seconds);

  // Jahresweise: ein Abstand zählt zu dem Kalenderjahr, in dem er BEGINNT
  // (Zeitzone Europe/Berlin, wie überall in der Auswertung).
  const yearFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric' });
  const byYearValues = new Map<string, number[]>();
  for (let index = 1; index < seconds.length; index += 1) {
    const previous = seconds[index - 1];
    const current = seconds[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    const delta = Math.max(1, current - previous);
    const year = yearFormat.format(new Date(previous * 1000));
    const list = byYearValues.get(year) || [];
    list.push(Math.log10(delta));
    byYearValues.set(year, list);
  }

  // Zuschnitt: nur ein Jahr → Gesamtblock überspringen; nur Gesamt → Jahre
  // überspringen. So bleibt auch ein Lauf mit hohem Iterationslimit im
  // CPU-Budget eines einzelnen Worker-Aufrufs.
  const overall = onlyYear
    ? mixtureBlock([], bins, 1, 1)
    : mixtureBlock(overallGaps.values, bins, maxK, maxIterations);
  const years = overallOnly ? [] : [...byYearValues.keys()].sort().filter((year) => !onlyYear || year === onlyYear);
  const byYear = years.map((year) => ({
    year,
    ...mixtureBlock(byYearValues.get(year) || [], bins, maxK, maxIterations),
  }));

  // Tagesrhythmus: ein Durchlauf über die Folge, reine Zählungen. Sender ist
  // der Absendername aus dem Export (gleiche Ableitung wie toView).
  const dailyRhythm = hourlyAggregates(sequence.map((message) => ({
    t: messageSeconds(message),
    from: String(message.from || message.actor || message.sender || '?'),
  })));

  const payload: GapMixturePayload = {
    ok: true,
    dataset: dataset.id,
    messages: sequence.length,
    gaps: overallGaps.values.length,
    clampedToOneSecond: overallGaps.clamped,
    minSeconds: overallGaps.minSeconds,
    maxSeconds: overallGaps.maxSeconds,
    bins,
    maxK,
    maxIterations,
    scope: overallOnly ? 'overall' : (onlyYear || 'all'),
    computedAt: new Date().toISOString(),
    overall,
    byYear,
    dailyRhythm,
  };

  // Kanonisches Ergebnis (Standardparameter, alle Jahre) einmal gerechnet →
  // fertig in D1 ablegen. Die Daten sind statisch (4 Jahre Historie); die
  // öffentliche Route liefert danach nur noch dieses gespeicherte Dokument.
  // Nicht-fatal: schlägt das Schreiben fehl, funktioniert die Antwort trotzdem.
  if (payload.scope === 'all' && bins === 60 && maxK === 4 && maxIterations === 300) {
    try {
      await env.DB.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(gapMixtureStoreKey(dataset.id), JSON.stringify(payload), payload.computedAt).run();
    } catch (caught) {
      console.error('gap-mixture: Ablage in app_settings fehlgeschlagen — nicht fatal', caught);
    }
  }

  const remember = (body: string, html: boolean): void => {
    if (!gapMixtureCache.has(cacheKey) && gapMixtureCache.size >= GAP_MIXTURE_CACHE_MAX) {
      const oldest = gapMixtureCache.keys().next().value;
      if (oldest !== undefined) gapMixtureCache.delete(oldest);
    }
    gapMixtureCache.set(cacheKey, { fingerprint, body, html });
  };

  if (!wantsHtml) {
    const body = JSON.stringify(payload);
    remember(body, false);
    return new Response(body, { status: 200, headers: JSON_HEADERS });
  }

  const page = renderGapMixturePage(payload);
  const body = await page.text();
  remember(body, true);
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}


/** Tagesrhythmus als Tabelle — genutzt von der Gesamtseite UND /api/public/hourly. */
function dailyRhythmSectionHtml(rhythm: NonNullable<GapMixturePayload['dailyRhythm']>): string {
  const senders = Object.keys(rhythm.msgPerHourBySender).sort();
  const classes = rhythm.gapStartHour.classes;
  const rows = Array.from({ length: 24 }, (_, hour) => `<tr>
    <td class="num">${String(hour).padStart(2, '0')}</td>
    ${senders.map((sender) => `<td class="num">${rhythm.msgPerHourBySender[sender][hour]}</td>`).join('')}
    <td class="num">${classes['1-4h'].counts[hour]}</td>
    <td class="num">${classes['4-12h'].counts[hour]}</td>
    <td class="num">${classes.over12h.counts[hour]}</td>
  </tr>`).join('');
  return `<h2>Tagesrhythmus</h2>
  <p class="note">${escapeHtml(rhythm.timezoneNote)} Pausen zählen ab &gt; 1 h,
    eingetragen bei der Stunde, in der die Pause beginnt (letzte Nachricht davor).</p>
  <div class="wrap"><table>
    <thead><tr><th class="num">Stunde</th>
      ${senders.map((sender) => `<th class="num">${escapeHtml(sender)}</th>`).join('')}
      <th class="num">Pausen 1–4 h</th><th class="num">4–12 h</th><th class="num">&gt; 12 h</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/**
 * GET /api/public/hourly — nur der Tagesrhythmus-Ausschnitt des abgelegten
 * Dokuments (msgPerHourBySender + gapStartHour). Reiner D1-Read, kein Login,
 * reine Zählungen. Rechnet nie selbst; fehlt die Ablage (oder stammt sie von
 * vor der Tagesrhythmus-Erweiterung), sagt die Antwort, wie sie erneuert wird.
 */
async function publicHourly(env: Env, dataset: DatasetRow, url: URL, request: Request): Promise<Response> {
  const format = url.searchParams.get('format');
  const wantsHtml = format === 'html'
    || (format !== 'json' && (request.headers.get('accept') || '').includes('text/html'));

  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?1')
    .bind(gapMixtureStoreKey(dataset.id)).first<{ value: string }>();
  const stored = row?.value ? JSON.parse(row.value) as GapMixturePayload : null;
  if (!stored?.dailyRhythm) {
    const hint = stored
      ? 'Die Ablage stammt von vor der Tagesrhythmus-Erweiterung — /api/admin/gap-mixture einmal als Admin neu aufrufen.'
      : 'Noch kein Ergebnis abgelegt — /api/admin/gap-mixture einmal als Admin aufrufen.';
    if (wantsHtml) {
      return diagnosePage('Tagesrhythmus', `
        <h1>Tagesrhythmus</h1>
        <p class="sub">Datensatz ${escapeHtml(dataset.id)}</p>
        <div class="card"><b class="flag">Noch keine Tagesrhythmus-Daten abgelegt.</b>
          <p class="note">${escapeHtml(hint)}</p></div>
      `);
    }
    return error(hint, 503);
  }

  if (!wantsHtml) {
    return json({
      ok: true,
      dataset: stored.dataset,
      computedAt: stored.computedAt,
      messages: stored.messages,
      ...stored.dailyRhythm,
    });
  }
  return diagnosePage('Tagesrhythmus', `
    <h1>Tagesrhythmus</h1>
    <p class="sub">Datensatz ${escapeHtml(stored.dataset)} · ${stored.messages} Nachrichten ·
      berechnet ${escapeHtml(humanTime(Math.floor(Date.parse(stored.computedAt) / 1000)))}</p>
    ${dailyRhythmSectionHtml(stored.dailyRhythm)}
    <p class="note"><a href="?format=json">Rohdaten als JSON</a>
      · <a href="/api/public/gap-mixture">Gesamtanalyse</a></p>
  `);
}

/**
 * Öffentliche Auslieferung des gespeicherten Ergebnisses — reiner D1-Read.
 * Kein Fit, kein Chunk-Parsing; Query-Parameter außer ?dataset= und ?format=
 * werden ignoriert (das Dokument ist fix). Liegt noch nichts vor, sagt die
 * Antwort, wie es erzeugt wird, statt selbst zu rechnen.
 */
async function publicGapMixture(env: Env, dataset: DatasetRow, url: URL, request: Request): Promise<Response> {
  const format = url.searchParams.get('format');
  const wantsHtml = format === 'html'
    || (format !== 'json' && (request.headers.get('accept') || '').includes('text/html'));

  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?1')
    .bind(gapMixtureStoreKey(dataset.id)).first<{ value: string }>();
  if (!row?.value) {
    if (wantsHtml) {
      return diagnosePage('Δt-Mischverteilung', `
        <h1>Δt-Mischverteilung</h1>
        <p class="sub">Datensatz ${escapeHtml(dataset.id)}</p>
        <div class="card"><b class="flag">Noch kein Ergebnis abgelegt.</b>
          <p class="note">Das Ergebnis wird einmalig erzeugt, indem Philipp (angemeldet)
            /api/admin/gap-mixture aufruft — dabei wird es gespeichert und liegt danach
            hier dauerhaft bereit.</p></div>
      `);
    }
    return error('Noch kein Ergebnis abgelegt — /api/admin/gap-mixture einmal als Admin aufrufen.', 503);
  }

  if (!wantsHtml) {
    return new Response(row.value, { status: 200, headers: JSON_HEADERS });
  }
  const payload = JSON.parse(row.value) as GapMixturePayload;
  return renderGapMixturePage(payload);
}

/**
 * Lesbare Seite aus einem (frisch gerechneten ODER gespeicherten) Ergebnis.
 * Bewusst von der Berechnung getrennt: die öffentliche Route rendert damit
 * das in app_settings abgelegte Dokument, ohne je selbst zu fitten.
 */
function renderGapMixturePage(payload: GapMixturePayload): Response {
  const isYearScope = payload.scope !== 'all' && payload.scope !== 'overall';
  const bicTable = (block: MixtureBlock) => `<div class="wrap"><table>
    <thead><tr><th class="num">k</th><th class="num">log L</th><th class="num">BIC</th>
      <th class="num">ΔBIC</th><th class="num">Iter.</th></tr></thead>
    <tbody>${block.bicByK.map((entry) => {
      const bestBic = Math.min(...block.bicByK.map((other) => other.bic));
      const isBest = entry.k === block.bestK;
      return `<tr>
        <td class="num">${isBest ? `<b class="ok">${entry.k}</b>` : entry.k}</td>
        <td class="num">${escapeHtml(entry.logLikelihood.toFixed(1))}</td>
        <td class="num">${isBest ? `<b class="ok">${escapeHtml(entry.bic.toFixed(1))}</b>` : escapeHtml(entry.bic.toFixed(1))}</td>
        <td class="num">${escapeHtml((entry.bic - bestBic).toFixed(1))}</td>
        <td class="num">${entry.iterations}${entry.converged ? '' : ' <span class="flag">!</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;

  const componentTable = (block: MixtureBlock) => `<div class="wrap"><table>
    <thead><tr><th class="num">#</th><th class="num">Gewicht</th><th>Zentrum</th>
      <th>±1 s (von–bis)</th><th class="num">µ log₁₀</th><th class="num">σ log₁₀</th></tr></thead>
    <tbody>${block.components.map((component) => `<tr>
      <td class="num">${component.index}</td>
      <td class="num">${escapeHtml(humanShare(component.weight))}</td>
      <td><b>${escapeHtml(component.center.human)}</b></td>
      <td>${escapeHtml(component.low1Sd.human)} – ${escapeHtml(component.high1Sd.human)}</td>
      <td class="num">${escapeHtml(component.meanLog10.toFixed(3))}</td>
      <td class="num">${escapeHtml(component.sdLog10.toFixed(3))}</td>
    </tr>`).join('')}</tbody></table></div>`;

  const boundaryList = (block: MixtureBlock) => (block.boundaries.length === 0
    ? '<p class="note">Keine Grenze — das Modell hat nur eine Komponente.</p>'
    : `<div class="wrap"><table>
        <thead><tr><th>zwischen</th><th>Grenze</th><th class="num">log₁₀</th></tr></thead>
        <tbody>${block.boundaries.map((boundary) => `<tr>
          <td>Komponente ${boundary.between[0]} / ${boundary.between[1]}</td>
          <td><b>${boundary.value ? escapeHtml(boundary.value.human) : '—'}</b></td>
          <td class="num">${boundary.log10 === null ? '—' : escapeHtml(boundary.log10.toFixed(3))}</td>
        </tr>`).join('')}</tbody></table></div>`);

  const histogramBars = (block: MixtureBlock) => {
    const max = Math.max(1, ...block.histogram.counts);
    return `<div class="hist">${block.histogram.counts.map((count, index) => {
      const from = block.histogram.edgesSeconds[index];
      return `<div class="hrow">
        <span class="hlabel">${escapeHtml(humanDuration(from))}</span>
        <span class="hbar"><i style="width:${(count / max) * 100}%"></i></span>
        <span class="hcount">${count}</span>
      </div>`;
    }).join('')}</div>`;
  };

  const section = (title: string, block: MixtureBlock) => `
    <h2>${escapeHtml(title)}</h2>
    <div class="card"><div class="big">k = ${block.bestK}
      <small>bestes Modell nach BIC · ${block.n} Abstände</small></div></div>
    ${bicTable(block)}
    <h3>Komponenten</h3>
    ${componentTable(block)}
    <h3>Entscheidungsgrenzen</h3>
    ${boundaryList(block)}`;

  const page = diagnosePage('Δt-Mischverteilung', `
    <style>
      h3 { font-size: 15px; margin: 18px 0 6px; color: #cfd6de; }
      .hist { margin: 8px 0 0; }
      .hrow { display: grid; grid-template-columns: 78px 1fr 52px; gap: 8px; align-items: center; font-size: 12px; }
      .hlabel { color: #9aa3ad; text-align: right; font-variant-numeric: tabular-nums; }
      .hbar { background: #232833; border-radius: 3px; height: 12px; overflow: hidden; }
      .hbar i { display: block; height: 100%; background: #4fb3a4; }
      .hcount { text-align: right; color: #9aa3ad; font-variant-numeric: tabular-nums; }
    </style>
    <h1>Δt-Mischverteilung</h1>
    <p class="sub">Datensatz ${escapeHtml(payload.dataset)} · ${payload.messages} Nachrichten ·
      ${payload.gaps} Abstände · kleinster ${escapeHtml(humanDuration(payload.minSeconds))} ·
      größter ${escapeHtml(humanDuration(payload.maxSeconds))} ·
      ${payload.clampedToOneSecond} Abstände unter 1 s auf 1 s angehoben · berechnet ${escapeHtml(humanTime(Math.floor(Date.parse(payload.computedAt) / 1000)))}</p>

    <div class="card">
      <b>Was hier gerechnet wird.</b>
      <p class="note">Alle Abstände zwischen benachbarten Nachrichten, logarithmiert
        (log₁₀ der Sekunden), angepasst mit Gauß-Mischungen für k = 1…${payload.maxK}. Gewählt wird
        das k mit dem kleinsten BIC. Wählt BIC k = 1, hat die Pausenverteilung keine
        natürliche Struktur — dann gibt es keine datengestützte Zeitschwelle, und jede
        Schwelle wäre gesetzt statt gefunden. Bei k &gt; 1 sind die Entscheidungsgrenzen
        die einzigen Schwellen, die aus den Daten selbst kommen.</p>
    </div>

    ${isYearScope ? '' : `${section('Alle Jahre', payload.overall)}

    <h3>Histogramm (${payload.bins} Bins über log₁₀, Beschriftung = Beginn des Bins)</h3>
    ${histogramBars(payload.overall)}`}

    ${payload.byYear.map((entry) => section(`Kalenderjahr ${entry.year}`, entry)).join('')}

    ${!payload.dailyRhythm ? '' : dailyRhythmSectionHtml(payload.dailyRhythm)}

    <p class="note"><a href="?format=json">Rohdaten als JSON</a>
      · <a href="/api/admin/segment-diagnose">Segment-Diagnose</a></p>
  `);
  return page;
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
