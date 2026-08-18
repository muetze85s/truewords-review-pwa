import baseWorker, {
  combinedBoundaryForRound,
  resolveDatasetRow,
  bothSubmittedRounds,
} from './worker-boundary-pairs';
import { hashSeed, mulberry32 } from '../boundary-pairs-logic.mjs';
import {
  deriveSituations,
  agreementByKey,
  agreeClassificationResolutions,
  disputesForSituation,
} from '../classification-logic.mjs';
import {
  CLASSIFICATION_CLASSES,
  CLASSIFICATION_KEYS,
  isValidPatternKey,
  CODEBOOK_VERSION,
} from '../classification-classes.mjs';
import {
  QUALITY_FLAGS,
  QUALITY_FLAG_KEYS,
  isValidQualityFlag,
  SEGMENTATION_BROKEN_FLAG_KEYS,
} from '../quality-flags.mjs';

/**
 * Klassifizierungs-Schicht: inhaltliche Ja/Nein-Klassifizierung von Situationen
 * durch zwei Menschen (Phase 1), Kappa-Auswertung und Zuschnitt-Qualitätsflags.
 * Sitzt in der Dekorator-Kette direkt über worker-boundary-pairs (gleiche Ebene
 * wie die Grenzen-Doppelprüfung) und delegiert alles Fremde an baseWorker.
 *
 * Blindheit ist — wie bei den Grenzen — eine Servereigenschaft: die
 * Markierungen der anderen Person werden erst geliefert, wenn beide die
 * Situation abgegeben haben. Streitfälle gelten erst als geklärt, wenn beide
 * denselben Wert bestätigt haben (Muster aus Migration 0008).
 *
 * Lenas Zugang ist über den Settings-Schalter `lena_classification_enabled`
 * (app_settings) serverseitig gesperrt, solange er aus ist — nicht nur in der UI.
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

type SessionUser = { role: Role; canUpload: boolean };

const SESSION_COOKIE = 'tw_review_session_v2';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

// Zielgröße der Validierungsstichprobe (Abschnitt 1b: 150–200 Situationen).
const DEFAULT_SAMPLE_SIZE = 180;
const MAX_SAMPLE_SIZE = 400;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function error(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
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

// Eigene, schlanke Session-Auflösung — wie in worker-push.ts (jede Schicht hält
// diese winzigen Helfer selbst, das ist die bestehende Konvention der Kette).
async function sessionUser(request: Request, env: Env): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/iu.test(token)) return null;
  const row = await env.DB.prepare(`
    SELECT u.role, u.can_upload
    FROM review_sessions s
    JOIN review_users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.is_active = 1
    LIMIT 1
  `).bind(await sha256Hex(token), new Date().toISOString()).first<{ role: Role; can_upload: number }>();
  if (!row) return null;
  return { role: row.role, canUpload: Number(row.can_upload) === 1 };
}

async function asset(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  return env.ASSETS.fetch(new Request(url.toString(), request));
}

// ------------------------------------------------------- Zugangssteuerung (4a)

async function lenaEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'lena_classification_enabled'`)
    .first<{ value: string }>();
  return row?.value === '1';
}

/** Darf dieser Nutzer die Klassifizierung benutzen? Philipp immer, Lena nur bei Freischaltung. */
async function classificationAllowed(env: Env, user: SessionUser): Promise<boolean> {
  if (user.canUpload) return true; // Philipp
  if (user.role === 'Lena') return lenaEnabled(env);
  return false;
}

// ------------------------------------------------------- Situationsableitung

type SituationRow = {
  id: number;
  dataset_id: string;
  round: number;
  situation_index: number;
  start_message_id: string;
  end_message_id: string;
  in_validation_sample: number;
};

/**
 * Leitet die Situationen einer Runde idempotent aus der gemeinsamen Grenzfassung
 * ab und legt fehlende Zeilen an. Nur für Runden mit VOLLSTÄNDIG geklärten
 * Grenzen (beide abgegeben, keine offenen Grenz-Streitfälle) — sonst wird auf
 * wackligem Zuschnitt klassifiziert. Liefert die Zahl der abgeleiteten
 * Situationen (0, wenn die Runde noch nicht freigegeben ist).
 */
async function deriveSituationsForRound(env: Env, dataset: { id: string; year: number }, round: number): Promise<number> {
  const combined = await combinedBoundaryForRound(env, dataset, round);
  if (!combined.bothSubmitted || combined.openDisputes > 0) return 0;
  const situations = deriveSituations(combined.messageIds, combined.cutPositions);
  if (!situations.length) return 0;
  const statements = situations.map((situation) => env.DB.prepare(`
    INSERT INTO review_situations
      (dataset_id, round, situation_index, start_message_id, end_message_id)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(dataset_id, round, situation_index) DO NOTHING
  `).bind(dataset.id, round, situation.situationIndex, situation.startMessageId, situation.endMessageId));
  await env.DB.batch(statements);
  return situations.length;
}

/**
 * Bereitet die Validierungsstichprobe vor (nur Philipp): leitet Situationen aus
 * allen abgabereifen, vollständig geklärten Runden ab und markiert deterministisch
 * bis zur Zielgröße `in_validation_sample = 1`. Additiv — bereits markierte
 * Situationen bleiben markiert, es wird nur aufgefüllt.
 */
async function prepareSample(request: Request, env: Env, dataset: { id: string; year: number }): Promise<Response> {
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('size'));
  const target = Number.isFinite(requested) && requested > 0
    ? Math.min(MAX_SAMPLE_SIZE, Math.floor(requested))
    : DEFAULT_SAMPLE_SIZE;

  const rounds = await bothSubmittedRounds(env, dataset.id);
  let derivedRounds = 0;
  let derivedSituations = 0;
  const skipped: number[] = [];
  for (const round of rounds) {
    try {
      const count = await deriveSituationsForRound(env, dataset, round);
      if (count > 0) { derivedRounds += 1; derivedSituations += count; }
    } catch (caught) {
      // Runden, deren Startpunkt in der aktuellen Folge nicht auffindbar ist
      // (z. B. additiv aus einem anderen Datensatz übertragen), überspringen
      // statt die ganze Vorbereitung abzubrechen.
      console.error(`Klassifizierung: Runde ${round} übersprungen —`, caught instanceof Error ? caught.message : caught);
      skipped.push(round);
    }
  }

  // Alle Situationen in stabiler Reihenfolge, dann deterministisch mischen.
  const allRows = await env.DB.prepare(`
    SELECT id, in_validation_sample FROM review_situations
    WHERE dataset_id = ?1 ORDER BY round, situation_index
  `).bind(dataset.id).all<{ id: number; in_validation_sample: number }>();
  const all = allRows.results || [];
  const alreadyFlagged = all.filter((row) => row.in_validation_sample === 1).map((row) => row.id);
  const unflagged = all.filter((row) => row.in_validation_sample === 0).map((row) => row.id);

  // Fisher–Yates mit mulberry32 — reproduzierbar je Datensatz.
  const rng = mulberry32(hashSeed(`${dataset.id}|classification-sample`));
  for (let index = unflagged.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [unflagged[index], unflagged[swap]] = [unflagged[swap], unflagged[index]];
  }

  const need = Math.max(0, target - alreadyFlagged.length);
  const toFlag = unflagged.slice(0, need);
  if (toFlag.length) {
    const now = new Date().toISOString();
    const statements = toFlag.map((id) => env.DB.prepare(
      `UPDATE review_situations SET in_validation_sample = 1 WHERE id = ?1`,
    ).bind(id));
    // Batch in Blöcken, D1 verträgt große Batches, aber wir bleiben moderat.
    await env.DB.batch(statements);
    void now;
  }

  return json({
    ok: true,
    target,
    derivedRounds,
    derivedSituations,
    skippedRounds: skipped,
    totalSituations: all.length,
    flagged: alreadyFlagged.length + toFlag.length,
    newlyFlagged: toFlag.length,
  });
}

// ------------------------------------------------------- Laden / Hilfen

async function loadSituation(env: Env, dataset: { id: string }, id: number): Promise<SituationRow | null> {
  return env.DB.prepare(`
    SELECT id, dataset_id, round, situation_index, start_message_id, end_message_id, in_validation_sample
    FROM review_situations WHERE id = ?1 AND dataset_id = ?2 LIMIT 1
  `).bind(id, dataset.id).first<SituationRow>();
}

type ViewMessage = { id: string; from: string; t: number; text: string; kind: string };

/** Nachrichten einer Situation (inklusive Grenzen), aus der gemeinsamen Grenzfassung geschnitten. */
async function situationMessages(env: Env, dataset: { id: string; year: number }, situation: SituationRow): Promise<ViewMessage[]> {
  const combined = await combinedBoundaryForRound(env, dataset, situation.round);
  const spans = deriveSituations(combined.messageIds, combined.cutPositions);
  const span = spans.find((entry) => entry.situationIndex === situation.situation_index);
  if (!span) return [];
  return combined.messages.slice(span.startPos, span.endPos + 1) as ViewMessage[];
}

async function classificationSubmittedAt(env: Env, situationId: number, reviewer: Role): Promise<string | null> {
  const row = await env.DB.prepare(`
    SELECT submitted_at FROM review_classification_submissions WHERE situation_id = ?1 AND reviewer = ?2
  `).bind(situationId, reviewer).first<{ submitted_at: string }>();
  return row?.submitted_at ?? null;
}

type MarkRow = { situation_id: number; pattern_key?: string; flag_key?: string; present: number };

async function loadClassMarks(env: Env, situationId: number, reviewer: Role): Promise<MarkRow[]> {
  const rows = await env.DB.prepare(`
    SELECT situation_id, pattern_key, present FROM review_classification_marks
    WHERE situation_id = ?1 AND reviewer = ?2
  `).bind(situationId, reviewer).all<MarkRow>();
  return rows.results || [];
}

async function loadFlagMarks(env: Env, situationId: number, reviewer: Role): Promise<MarkRow[]> {
  const rows = await env.DB.prepare(`
    SELECT situation_id, flag_key, present FROM review_situation_quality_flags
    WHERE situation_id = ?1 AND reviewer = ?2
  `).bind(situationId, reviewer).all<MarkRow>();
  return rows.results || [];
}

function marksToMap(rows: MarkRow[], keyField: 'pattern_key' | 'flag_key'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = row[keyField];
    if (key) out[key] = row.present ? 1 : 0;
  }
  return out;
}

// ------------------------------------------------------- Endpunkte

/** Übersicht: Validierungssituationen mit Status + Fortschritt. */
async function getSituationsOverview(env: Env, dataset: { id: string; year: number }, user: SessionUser): Promise<Response> {
  const situationsRows = await env.DB.prepare(`
    SELECT id, round, situation_index, start_message_id, end_message_id
    FROM review_situations WHERE dataset_id = ?1 AND in_validation_sample = 1
    ORDER BY round, situation_index
  `).bind(dataset.id).all<{ id: number; round: number; situation_index: number; start_message_id: string; end_message_id: string }>();
  const situations = situationsRows.results || [];
  if (!situations.length) {
    return json({ ok: true, needsPreparation: true, sampleSize: 0, situations: [], progress: { classifiedByBoth: 0, sampleSize: 0 }, partnerActive: await lenaEnabled(env) });
  }
  const ids = situations.map((entry) => entry.id);
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(',');

  const [subsRows, classMarksRows, classResRows, flagMarksRows, flagResRows] = await Promise.all([
    env.DB.prepare(`SELECT situation_id, reviewer FROM review_classification_submissions WHERE situation_id IN (${placeholders})`).bind(...ids).all<{ situation_id: number; reviewer: Role }>(),
    env.DB.prepare(`SELECT situation_id, reviewer, pattern_key, present FROM review_classification_marks WHERE situation_id IN (${placeholders}) AND reviewer IN ('Philipp','Lena')`).bind(...ids).all<{ situation_id: number; reviewer: Role; pattern_key: string; present: number }>(),
    env.DB.prepare(`SELECT situation_id, pattern_key, decided_by, resolved_present FROM review_classification_resolutions WHERE situation_id IN (${placeholders})`).bind(...ids).all<{ situation_id: number; pattern_key: string; decided_by: string; resolved_present: number }>(),
    env.DB.prepare(`SELECT situation_id, reviewer, flag_key, present FROM review_situation_quality_flags WHERE situation_id IN (${placeholders}) AND reviewer IN ('Philipp','Lena')`).bind(...ids).all<{ situation_id: number; reviewer: Role; flag_key: string; present: number }>(),
    env.DB.prepare(`SELECT situation_id, flag_key, decided_by, resolved_present FROM review_situation_quality_resolutions WHERE situation_id IN (${placeholders})`).bind(...ids).all<{ situation_id: number; flag_key: string; decided_by: string; resolved_present: number }>(),
  ]);

  const submittedBy = new Map<number, Set<Role>>();
  for (const row of subsRows.results || []) {
    if (!submittedBy.has(row.situation_id)) submittedBy.set(row.situation_id, new Set());
    submittedBy.get(row.situation_id)?.add(row.reviewer);
  }
  const classByReviewer = { Philipp: [] as MarkRow[], Lena: [] as MarkRow[] };
  for (const row of classMarksRows.results || []) classByReviewer[row.reviewer].push({ situation_id: row.situation_id, pattern_key: row.pattern_key, present: row.present });
  const flagByReviewer = { Philipp: [] as MarkRow[], Lena: [] as MarkRow[] };
  for (const row of flagMarksRows.results || []) flagByReviewer[row.reviewer].push({ situation_id: row.situation_id, flag_key: row.flag_key, present: row.present });

  const classResBySituation = new Map<number, typeof classResRows.results>();
  for (const row of classResRows.results || []) {
    if (!classResBySituation.has(row.situation_id)) classResBySituation.set(row.situation_id, []);
    classResBySituation.get(row.situation_id)?.push(row);
  }
  const flagResBySituation = new Map<number, typeof flagResRows.results>();
  for (const row of flagResRows.results || []) {
    if (!flagResBySituation.has(row.situation_id)) flagResBySituation.set(row.situation_id, []);
    flagResBySituation.get(row.situation_id)?.push(row);
  }

  let classifiedByBoth = 0;
  const list = situations.map((situation) => {
    const submitted = submittedBy.get(situation.id) || new Set<Role>();
    const philippSubmitted = submitted.has('Philipp');
    const lenaSubmitted = submitted.has('Lena');
    const both = philippSubmitted && lenaSubmitted;
    if (both) classifiedByBoth += 1;

    let openDisputes = 0;
    let segmentationBroken = false;
    if (both) {
      const classDisputes = disputesForSituation({
        situationId: situation.id,
        marksA: classByReviewer.Philipp,
        marksB: classByReviewer.Lena,
        resolutions: classResBySituation.get(situation.id) || [],
        keys: CLASSIFICATION_KEYS,
      });
      const flagDisputes = disputesForSituation({
        situationId: situation.id,
        marksA: flagByReviewer.Philipp,
        marksB: flagByReviewer.Lena,
        resolutions: flagResBySituation.get(situation.id) || [],
        keys: QUALITY_FLAG_KEYS,
        keyField: 'flag_key',
      });
      openDisputes = classDisputes.filter((d) => !d.resolved).length + flagDisputes.filter((d) => !d.resolved).length;

      // „Zuschnitt strittig/fehlerhaft": bestätigt (beide ja, oder Streit zu ja geklärt)
      // für einen der Zuschnitt-Fehler-Flags.
      const philippFlags = marksToMap(flagByReviewer.Philipp.filter((m) => m.situation_id === situation.id), 'flag_key');
      const lenaFlags = marksToMap(flagByReviewer.Lena.filter((m) => m.situation_id === situation.id), 'flag_key');
      const agreedFlags = new Map(
        agreeClassificationResolutions(flagResBySituation.get(situation.id) || [], 'flag_key')
          .map((entry) => [entry.key, entry]),
      );
      for (const key of SEGMENTATION_BROKEN_FLAG_KEYS) {
        const p = philippFlags[key] ?? 0;
        const l = lenaFlags[key] ?? 0;
        const resolution = agreedFlags.get(key);
        const confirmed = (p === 1 && l === 1) || (resolution && resolution.resolved && resolution.resolvedPresent === 1);
        if (confirmed) { segmentationBroken = true; break; }
      }
    }

    return {
      id: situation.id,
      round: situation.round,
      situationIndex: situation.situation_index,
      philippSubmitted,
      lenaSubmitted,
      openDisputes,
      segmentationBroken,
    };
  });

  return json({
    ok: true,
    needsPreparation: false,
    sampleSize: situations.length,
    partnerActive: await lenaEnabled(env),
    role: user.role,
    progress: { classifiedByBoth, sampleSize: situations.length },
    situations: list,
  });
}

/** Detailansicht einer Situation (blind bis beide abgegeben haben). */
async function getSituationDetail(env: Env, dataset: { id: string; year: number }, user: SessionUser, id: number): Promise<Response> {
  const situation = await loadSituation(env, dataset, id);
  if (!situation) return error('Situation nicht gefunden.', 404);
  if (situation.in_validation_sample !== 1) return error('Diese Situation gehört nicht zur Validierungsstichprobe.', 403);

  const messages = await situationMessages(env, dataset, situation);
  const partnerActive = await lenaEnabled(env);
  const other: Role = user.role === 'Philipp' ? 'Lena' : 'Philipp';

  const [ownSub, otherSub, ownClass, ownFlags] = await Promise.all([
    classificationSubmittedAt(env, id, user.role),
    classificationSubmittedAt(env, id, other),
    loadClassMarks(env, id, user.role),
    loadFlagMarks(env, id, user.role),
  ]);

  const base = {
    ok: true as const,
    id,
    round: situation.round,
    situationIndex: situation.situation_index,
    messages,
    reviewer: user.role,
    partnerActive,
    submitted: Boolean(ownSub),
    otherSubmitted: Boolean(otherSub),
    ownClasses: marksToMap(ownClass, 'pattern_key'),
    ownFlags: marksToMap(ownFlags, 'flag_key'),
  };

  // Vergleich nur, wenn BEIDE abgegeben haben — sonst bleibt die Sicht blind.
  if (!(ownSub && otherSub)) {
    return json(base);
  }

  const [otherClass, otherFlags, classRes, flagRes] = await Promise.all([
    loadClassMarks(env, id, other),
    loadFlagMarks(env, id, other),
    env.DB.prepare(`SELECT situation_id, pattern_key, decided_by, resolved_present FROM review_classification_resolutions WHERE situation_id = ?1`).bind(id).all<{ situation_id: number; pattern_key: string; decided_by: string; resolved_present: number }>(),
    env.DB.prepare(`SELECT situation_id, flag_key, decided_by, resolved_present FROM review_situation_quality_resolutions WHERE situation_id = ?1`).bind(id).all<{ situation_id: number; flag_key: string; decided_by: string; resolved_present: number }>(),
  ]);

  const philippClass = user.role === 'Philipp' ? ownClass : otherClass;
  const lenaClass = user.role === 'Philipp' ? otherClass : ownClass;
  const philippFlagMarks = user.role === 'Philipp' ? ownFlags : otherFlags;
  const lenaFlagMarks = user.role === 'Philipp' ? otherFlags : ownFlags;

  const classDisputes = disputesForSituation({
    situationId: id, marksA: philippClass, marksB: lenaClass, resolutions: classRes.results || [], keys: CLASSIFICATION_KEYS,
  });
  const flagDisputes = disputesForSituation({
    situationId: id, marksA: philippFlagMarks, marksB: lenaFlagMarks, resolutions: flagRes.results || [], keys: QUALITY_FLAG_KEYS, keyField: 'flag_key',
  });

  return json({
    ...base,
    compare: true,
    otherClasses: marksToMap(otherClass, 'pattern_key'),
    otherFlags: marksToMap(otherFlags, 'flag_key'),
    classDisputes,
    flagDisputes,
  });
}

/** Speichert die (Entwurfs-)Markierungen. Nach Abgabe gesperrt. */
async function putMarks(request: Request, env: Env, dataset: { id: string }, user: SessionUser, id: number): Promise<Response> {
  const situation = await loadSituation(env, dataset, id);
  if (!situation) return error('Situation nicht gefunden.', 404);
  if (situation.in_validation_sample !== 1) return error('Diese Situation gehört nicht zur Validierungsstichprobe.', 403);
  if (await classificationSubmittedAt(env, id, user.role)) {
    return error('Diese Situation ist bereits abgegeben und kann nicht mehr geändert werden.', 409);
  }
  let body: { classes?: Record<string, unknown>; flags?: Record<string, unknown> };
  try { body = await request.json(); } catch { return error('Ungültige Anfrage.'); }
  await writeMarks(env, id, user.role, body.classes || {}, body.flags || {}, 0);
  return json({ ok: true });
}

/** Schreibt Klassen- und Flag-Markierungen (upsert). Nur gültige Keys. */
async function writeMarks(
  env: Env,
  situationId: number,
  reviewer: Role,
  classes: Record<string, unknown>,
  flags: Record<string, unknown>,
  isCorrectionOfLlm: number,
): Promise<void> {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const key of CLASSIFICATION_KEYS) {
    if (!(key in classes)) continue;
    if (!isValidPatternKey(key)) continue;
    const present = classes[key] ? 1 : 0;
    statements.push(env.DB.prepare(`
      INSERT INTO review_classification_marks
        (situation_id, reviewer, pattern_key, present, is_correction_of_llm, codebook_version, submitted_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(situation_id, reviewer, pattern_key) DO UPDATE SET
        present = excluded.present,
        is_correction_of_llm = excluded.is_correction_of_llm,
        codebook_version = excluded.codebook_version,
        submitted_at = excluded.submitted_at
    `).bind(situationId, reviewer, key, present, isCorrectionOfLlm, CODEBOOK_VERSION, now));
  }
  for (const key of QUALITY_FLAG_KEYS) {
    if (!(key in flags)) continue;
    if (!isValidQualityFlag(key)) continue;
    const present = flags[key] ? 1 : 0;
    statements.push(env.DB.prepare(`
      INSERT INTO review_situation_quality_flags
        (situation_id, reviewer, flag_key, present, submitted_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(situation_id, reviewer, flag_key) DO UPDATE SET
        present = excluded.present,
        submitted_at = excluded.submitted_at
    `).bind(situationId, reviewer, key, present, now));
  }
  if (statements.length) await env.DB.batch(statements);
}

/** Gibt die Situation ab: schreibt fehlende Klassen/Flags als 0 nach, setzt Submission. */
async function submitSituation(request: Request, env: Env, dataset: { id: string }, user: SessionUser, id: number): Promise<Response> {
  const situation = await loadSituation(env, dataset, id);
  if (!situation) return error('Situation nicht gefunden.', 404);
  if (situation.in_validation_sample !== 1) return error('Diese Situation gehört nicht zur Validierungsstichprobe.', 403);
  if (await classificationSubmittedAt(env, id, user.role)) {
    return json({ ok: true, alreadySubmitted: true });
  }
  // Endstand optional mitgeschickt — dann atomar mit der Abgabe speichern.
  let body: { classes?: Record<string, unknown>; flags?: Record<string, unknown> } = {};
  try { body = await request.json(); } catch { body = {}; }

  // Vollständige Vorgabe: jede Klasse/jeder Flag als 0, dann mit Body/Entwurf überschreiben.
  const existingClass = marksToMap(await loadClassMarks(env, id, user.role), 'pattern_key');
  const existingFlags = marksToMap(await loadFlagMarks(env, id, user.role), 'flag_key');
  const classes: Record<string, number> = {};
  for (const key of CLASSIFICATION_KEYS) classes[key] = (body.classes && key in body.classes) ? (body.classes[key] ? 1 : 0) : (existingClass[key] ?? 0);
  const flags: Record<string, number> = {};
  for (const key of QUALITY_FLAG_KEYS) flags[key] = (body.flags && key in body.flags) ? (body.flags[key] ? 1 : 0) : (existingFlags[key] ?? 0);

  await writeMarks(env, id, user.role, classes, flags, 0);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO review_classification_submissions (situation_id, reviewer, submitted_at)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(situation_id, reviewer) DO NOTHING
  `).bind(id, user.role, now).run();

  // Frischen Detailzustand zurückgeben (spart dem Browser einen zweiten Umlauf).
  return getSituationDetail(env, dataset as { id: string; year: number }, user, id);
}

/** Klärt einen Streitfall (eigene Stimme, beide-müssen-zustimmen). */
async function resolveClassificationDispute(request: Request, env: Env, dataset: { id: string; year: number }, user: SessionUser, id: number): Promise<Response> {
  const situation = await loadSituation(env, dataset, id);
  if (!situation) return error('Situation nicht gefunden.', 404);
  const other: Role = user.role === 'Philipp' ? 'Lena' : 'Philipp';
  const [ownSub, otherSub] = await Promise.all([
    classificationSubmittedAt(env, id, user.role),
    classificationSubmittedAt(env, id, other),
  ]);
  if (!(ownSub && otherSub)) {
    return error('Streitfälle können erst geklärt werden, wenn beide abgegeben haben.', 403);
  }
  let body: { kind?: unknown; key?: unknown; present?: unknown };
  try { body = await request.json(); } catch { return error('Ungültige Anfrage.'); }
  const kind = String(body.kind || '');
  const key = String(body.key || '');
  const present = body.present ? 1 : 0;
  const now = new Date().toISOString();

  if (kind === 'class') {
    if (!isValidPatternKey(key)) return error('Unbekannte Klasse.', 422);
    await env.DB.prepare(`
      INSERT INTO review_classification_resolutions (situation_id, pattern_key, decided_by, resolved_present, decided_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(situation_id, pattern_key, decided_by) DO UPDATE SET
        resolved_present = excluded.resolved_present, decided_at = excluded.decided_at
    `).bind(id, key, user.role, present, now).run();
  } else if (kind === 'flag') {
    if (!isValidQualityFlag(key)) return error('Unbekanntes Zuschnitt-Flag.', 422);
    await env.DB.prepare(`
      INSERT INTO review_situation_quality_resolutions (situation_id, flag_key, decided_by, resolved_present, decided_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(situation_id, flag_key, decided_by) DO UPDATE SET
        resolved_present = excluded.resolved_present, decided_at = excluded.decided_at
    `).bind(id, key, user.role, present, now).run();
  } else {
    return error('Unbekannte Streitfall-Art.', 422);
  }

  return getSituationDetail(env, dataset, user, id);
}

/** Kappa je Klasse (Inhalt) und je Flag (Zuschnitt) über beidseitig abgegebene Validierungssituationen. */
async function getSummary(env: Env, dataset: { id: string }): Promise<Response> {
  const partnerActive = await lenaEnabled(env);

  // Situationen, die BEIDE Menschen abgegeben haben (nur Validierungsstichprobe).
  const bothRows = await env.DB.prepare(`
    SELECT s.situation_id AS id, COUNT(DISTINCT s.reviewer) AS c
    FROM review_classification_submissions s
    JOIN review_situations r ON r.id = s.situation_id
    WHERE r.dataset_id = ?1 AND r.in_validation_sample = 1 AND s.reviewer IN ('Philipp','Lena')
    GROUP BY s.situation_id
    HAVING c = 2
  `).bind(dataset.id).all<{ id: number; c: number }>();
  const situationIds = (bothRows.results || []).map((row) => row.id);

  if (!situationIds.length) {
    return json({
      ok: true,
      partnerActive,
      bothSubmittedCount: 0,
      humanHuman: false,
      content: CLASSIFICATION_CLASSES.map((entry) => ({ key: entry.key, label: entry.label, group: entry.group, n: 0, kappa: null, ampel: 'insufficient', agreementPercent: null })),
      quality: QUALITY_FLAGS.map((entry) => ({ key: entry.key, label: entry.label, n: 0, kappa: null, ampel: 'insufficient', agreementPercent: null })),
    });
  }

  const placeholders = situationIds.map((_, index) => `?${index + 1}`).join(',');
  const [classRows, flagRows] = await Promise.all([
    env.DB.prepare(`SELECT situation_id, reviewer, pattern_key, present FROM review_classification_marks WHERE situation_id IN (${placeholders}) AND reviewer IN ('Philipp','Lena')`).bind(...situationIds).all<{ situation_id: number; reviewer: Role; pattern_key: string; present: number }>(),
    env.DB.prepare(`SELECT situation_id, reviewer, flag_key, present FROM review_situation_quality_flags WHERE situation_id IN (${placeholders}) AND reviewer IN ('Philipp','Lena')`).bind(...situationIds).all<{ situation_id: number; reviewer: Role; flag_key: string; present: number }>(),
  ]);

  const classA: MarkRow[] = []; const classB: MarkRow[] = [];
  for (const row of classRows.results || []) (row.reviewer === 'Philipp' ? classA : classB).push({ situation_id: row.situation_id, pattern_key: row.pattern_key, present: row.present });
  const flagA: MarkRow[] = []; const flagB: MarkRow[] = [];
  for (const row of flagRows.results || []) (row.reviewer === 'Philipp' ? flagA : flagB).push({ situation_id: row.situation_id, flag_key: row.flag_key, present: row.present });

  const contentStats = agreementByKey({ situationIds, marksA: classA, marksB: classB, keys: CLASSIFICATION_KEYS });
  const qualityStats = agreementByKey({ situationIds, marksA: flagA, marksB: flagB, keys: QUALITY_FLAG_KEYS, keyField: 'flag_key' });

  const labelOf = (key: string) => CLASSIFICATION_CLASSES.find((entry) => entry.key === key);
  const flagLabelOf = (key: string) => QUALITY_FLAGS.find((entry) => entry.key === key);

  return json({
    ok: true,
    partnerActive,
    humanHuman: true,
    bothSubmittedCount: situationIds.length,
    content: contentStats.map((stat) => ({ ...stat, label: labelOf(stat.key)?.label || stat.key, group: labelOf(stat.key)?.group || 'risk' })),
    quality: qualityStats.map((stat) => ({ ...stat, label: flagLabelOf(stat.key)?.label || stat.key })),
  });
}

// ------------------------------------------------------------- Verdrahtung

async function classificationApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/classification/')) return null;

  const user = await sessionUser(request, env);
  if (!user) return error('Nicht angemeldet.', 401);

  // Freischalt-Status lesen — auch für Lena erlaubt (die Nav braucht ihn).
  if (url.pathname === '/api/classification/access' && request.method === 'GET') {
    return json({ ok: true, enabled: await lenaEnabled(env), role: user.role, canUpload: user.canUpload });
  }
  if (url.pathname === '/api/classification/access' && request.method === 'POST') {
    if (!user.canUpload) return error('Nur der Admin darf die Freischaltung ändern.', 403);
    let body: { enabled?: unknown };
    try { body = await request.json(); } catch { return error('Ungültige Anfrage.'); }
    const value = body.enabled ? '1' : '0';
    await env.DB.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES ('lena_classification_enabled', ?1, ?2)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(value, new Date().toISOString()).run();
    return json({ ok: true, enabled: value === '1' });
  }

  // Ab hier: Zugang zur Klassifizierung nötig (Philipp immer, Lena nur freigeschaltet).
  if (!(await classificationAllowed(env, user))) {
    return error('Die Klassifizierung ist für dich noch nicht freigeschaltet.', 403);
  }

  const dataset = await resolveDatasetRow(env, url.searchParams.get('dataset'));
  if (!dataset) return error('Kein aktiver Prüfdatenbestand.', 404);

  try {
    if (url.pathname === '/api/classification/prepare-sample' && request.method === 'POST') {
      if (!user.canUpload) return error('Nur der Admin darf die Stichprobe vorbereiten.', 403);
      return await prepareSample(request, env, dataset);
    }
    if (url.pathname === '/api/classification/situations' && request.method === 'GET') {
      return await getSituationsOverview(env, dataset, user);
    }
    if (url.pathname === '/api/classification/summary' && request.method === 'GET') {
      return await getSummary(env, dataset);
    }

    const match = url.pathname.match(/^\/api\/classification\/situations\/(\d+)(\/marks|\/submit|\/resolve)?$/u);
    if (match) {
      const id = Number(match[1]);
      if (!Number.isInteger(id) || id < 1) return error('Ungültige Situation.', 422);
      const suffix = match[2] || '';
      if (suffix === '' && request.method === 'GET') return await getSituationDetail(env, dataset, user, id);
      if (suffix === '/marks' && request.method === 'PUT') return await putMarks(request, env, dataset, user, id);
      if (suffix === '/submit' && request.method === 'POST') return await submitSituation(request, env, dataset, user, id);
      if (suffix === '/resolve' && request.method === 'POST') return await resolveClassificationDispute(request, env, dataset, user, id);
    }

    return error('Endpunkt nicht gefunden.', 404);
  } catch (caught) {
    console.error('Classification API error', caught);
    return error(caught instanceof Error ? caught.message : 'Klassifizierung konnte nicht verarbeitet werden.', 500);
  }
}

/** Seiten-Gate: Klassifizierungsseiten nur für Berechtigte (Lena nur freigeschaltet). */
async function classificationPageGate(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/klassifizierung.html' && pathname !== '/klassifizierung-info.html') return null;
  const user = await sessionUser(request, env);
  if (!user) return redirect('/login.html');
  if (!(await classificationAllowed(env, user))) return redirect('/doppelpruefung.html?tab=overview');
  return asset(request, env, pathname);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const apiResponse = await classificationApi(request, env);
      if (apiResponse) return apiResponse;
      const pageResponse = await classificationPageGate(request, env);
      if (pageResponse) return pageResponse;
      return baseWorker.fetch(request, env);
    } catch (caught) {
      console.error('Classification worker failed', caught);
      return error('Die Klassifizierung konnte serverseitig nicht verarbeitet werden.', 500);
    }
  },
};
