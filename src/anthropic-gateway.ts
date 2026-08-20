/**
 * Anthropic-Gateway für den LLM-Dritt-Rater (PR 2). Ein einziger Providerausgang
 * pro Anbieter — kein direkter fetch aus der Klassifizierungslogik. Spiegelt die
 * Disziplin von openai-gateway.ts der Hauptapp:
 *   - Preisvalidierung gegen eine Registry
 *   - konservative Token-Obergrenze
 *   - Budgetauflösung + Reservierung VOR dem Call (Zwei-Phasen-Commit)
 *   - Verbuchung nach dem Call, Freigabe der Restreservierung
 *   - Beträge in ganzzahligen Mikro-Dollar
 *   - KEINE Nachrichteninhalte und KEINE Prompts in den Kostenprotokollen
 *
 * Bewusst getrennt von allen bestehenden Keys: eigener Env-Key ANTHROPIC_API_KEY,
 * eigenes Ledger (ai_llm_*). Transport per raw fetch (wie openai-gateway.ts),
 * kein SDK im Worker-Bundle.
 */

interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_MAX_TOTAL_USD?: string;
  ANTHROPIC_MAX_COST_PER_REQUEST_USD?: string;
}

export const ANTHROPIC_GATEWAY_ERRORS = {
  notConfigured: 'ANTHROPIC_NOT_CONFIGURED',
  model: 'ANTHROPIC_MODEL_PRICE_UNKNOWN',
  perRequestLimit: 'ANTHROPIC_PER_REQUEST_LIMIT_EXCEEDED',
  budgetExceeded: 'ANTHROPIC_BUDGET_EXCEEDED',
} as const;

type ModelPrice = {
  model: string;
  inputPrice: number; // USD je 1 Mio. Input-Tokens
  outputPrice: number; // USD je 1 Mio. Output-Tokens
  enabled: boolean;
  safetyMargin: number;
};

// USD je Mio. Tokens. Einzige Preis-Registry hier. Modellstring ist per Env
// wählbar (ANTHROPIC_MODEL) — Standard: kostengünstiges Modell genügt für eine
// binäre 20-Klassen-Klassifizierung.
export const ANTHROPIC_MODEL_PRICES: readonly ModelPrice[] = [
  { model: 'claude-haiku-4-5', inputPrice: 1, outputPrice: 5, enabled: true, safetyMargin: 1.25 },
  { model: 'claude-sonnet-4-6', inputPrice: 3, outputPrice: 15, enabled: true, safetyMargin: 1.25 },
  { model: 'claude-opus-4-8', inputPrice: 5, outputPrice: 25, enabled: true, safetyMargin: 1.25 },
];

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
const MAX_OUTPUT_TOKENS = 1024; // JSON mit 20 Booleans passt weit darunter
const DEFAULT_TOTAL_USD = 10; // Gesamtdeckel, per Env erhöhbar
const DEFAULT_PER_REQUEST_USD = 0.05; // Cent-Bereich pro Klassifizierung
const ACCOUNT_ID = 'anthropic-llm';

export function validateModelPrice(model: string, prices: readonly ModelPrice[] = ANTHROPIC_MODEL_PRICES): ModelPrice {
  const price = prices.find((entry) => entry.model === model && entry.enabled);
  if (!price) throw new Error(ANTHROPIC_GATEWAY_ERRORS.model);
  return price;
}

/** Konservative Token-Schätzung: UTF-8-Bytes / 3 (gemischtes Deutsch/JSON). */
export function estimateInputTokens(system: string, user: string): number {
  const bytes = new TextEncoder().encode(`${system}\n${user}`).byteLength;
  return Math.max(1, Math.ceil(bytes / 3));
}

/** Maximale Kosten (Mikro-USD, ganzzahlig) inkl. Sicherheitsmarge. */
export function estimateMaxCostMicro(price: ModelPrice, inputTokens: number, maxOutputTokens: number): number {
  return Math.ceil((inputTokens * price.inputPrice + maxOutputTokens * price.outputPrice) * price.safetyMargin);
}

/** Tatsächliche Kosten (Mikro-USD, ganzzahlig) aus der gemeldeten Nutzung. */
export function calculateActualCostMicro(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * price.inputPrice + outputTokens * price.outputPrice);
}

// ------------------------------------------------------------- D1-Ledger

async function resolveAccount(env: Env, limitMicro: number, now: number): Promise<{ id: string; available: number }> {
  await env.DB.prepare(`
    INSERT INTO ai_llm_budget (id, limit_micro, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(id) DO UPDATE SET limit_micro = excluded.limit_micro, updated_at = excluded.updated_at
  `).bind(ACCOUNT_ID, limitMicro, new Date(now).toISOString()).run();
  const row = await env.DB.prepare(
    `SELECT limit_micro, spent_micro, reserved_micro, is_blocked FROM ai_llm_budget WHERE id = ?1`,
  ).bind(ACCOUNT_ID).first<{ limit_micro: number; spent_micro: number; reserved_micro: number; is_blocked: number }>();
  if (!row || Number(row.is_blocked) === 1) throw new Error(ANTHROPIC_GATEWAY_ERRORS.budgetExceeded);
  return { id: ACCOUNT_ID, available: Number(row.limit_micro) - Number(row.spent_micro) - Number(row.reserved_micro) };
}

async function reserve(env: Env, input: { fingerprint: string; operation: string; model: string; estInput: number; maxOutput: number; amountMicro: number; now: number }): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO ai_llm_reservations
      (id, budget_id, operation, request_fingerprint, model, est_input_tokens, max_output_tokens, reserved_micro, status, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'reserved', ?9, ?10)
  `).bind(id, ACCOUNT_ID, input.operation, input.fingerprint, input.model, input.estInput, input.maxOutput, input.amountMicro, input.now, input.now + 300_000).run();

  const updated = await env.DB.prepare(`
    UPDATE ai_llm_budget SET reserved_micro = reserved_micro + ?1, updated_at = ?2
    WHERE id = ?3 AND is_blocked = 0 AND limit_micro - spent_micro - reserved_micro >= ?1
  `).bind(input.amountMicro, new Date(input.now).toISOString(), ACCOUNT_ID).run();
  if (!updated.meta.changes) {
    await env.DB.prepare(`UPDATE ai_llm_reservations SET status = 'released', completed_at = ?1 WHERE id = ?2 AND status = 'reserved'`).bind(input.now, id).run();
    throw new Error(ANTHROPIC_GATEWAY_ERRORS.budgetExceeded);
  }
  return id;
}

async function completeReservation(env: Env, resId: string, reservedMicro: number, actualMicro: number, operation: string, model: string, inTok: number, outTok: number, providerId: string | null, now: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE ai_llm_budget SET reserved_micro = max(0, reserved_micro - ?1), spent_micro = spent_micro + ?2, updated_at = ?3
    WHERE id = ?4 AND EXISTS (SELECT 1 FROM ai_llm_reservations WHERE id = ?5 AND status = 'reserved')
  `).bind(reservedMicro, actualMicro, new Date(now).toISOString(), ACCOUNT_ID, resId).run();
  await env.DB.prepare(`UPDATE ai_llm_reservations SET status = 'completed', completed_at = ?1 WHERE id = ?2 AND status = 'reserved'`).bind(now, resId).run();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO ai_llm_usage_events (id, reservation_id, operation, model, input_tokens, output_tokens, actual_micro, provider_request_id, success, error_code, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, NULL, ?9)
  `).bind(crypto.randomUUID(), resId, operation, model, inTok, outTok, actualMicro, providerId, now).run();
}

async function failReservation(env: Env, resId: string, reservedMicro: number, operation: string, model: string, errorCode: string, now: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE ai_llm_budget SET reserved_micro = max(0, reserved_micro - ?1), updated_at = ?2
    WHERE id = ?3 AND EXISTS (SELECT 1 FROM ai_llm_reservations WHERE id = ?4 AND status = 'reserved')
  `).bind(reservedMicro, new Date(now).toISOString(), ACCOUNT_ID, resId).run();
  await env.DB.prepare(`UPDATE ai_llm_reservations SET status = 'failed', completed_at = ?1 WHERE id = ?2 AND status = 'reserved'`).bind(now, resId).run();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO ai_llm_usage_events (id, reservation_id, operation, model, input_tokens, output_tokens, actual_micro, provider_request_id, success, error_code, created_at)
    VALUES (?1, ?2, ?3, ?4, 0, 0, 0, NULL, 0, ?5, ?6)
  `).bind(crypto.randomUUID(), resId, operation, model, errorCode.slice(0, 80), now).run();
}

// ------------------------------------------------------------- Transport

export function readModel(env: Env): string {
  return String(env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL);
}

export function isConfigured(env: Env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

type LlmResult = { text: string; inputTokens: number; outputTokens: number; model: string; providerId: string | null };

/**
 * Ein Call pro Situation. reserve → Anthropic → commit/release. Wirft bei jedem
 * Fehler (nach Freigabe der Reservierung). Kein Nachrichteninhalt landet im Ledger.
 * `now` wird injiziert, damit die reine Logik testbar bleibt (Worker gibt Date.now()).
 */
export async function rateWithAnthropic(env: Env, input: { system: string; user: string; operation: string; situationId: number; now: number; fetchImpl?: typeof fetch }): Promise<LlmResult> {
  const apiKey = String(env.ANTHROPIC_API_KEY || '');
  if (!apiKey) throw new Error(ANTHROPIC_GATEWAY_ERRORS.notConfigured);
  const model = readModel(env);
  const price = validateModelPrice(model);

  const estInput = estimateInputTokens(input.system, input.user);
  const maxCostMicro = estimateMaxCostMicro(price, estInput, MAX_OUTPUT_TOKENS);
  const perRequestLimitMicro = Math.round((Number(env.ANTHROPIC_MAX_COST_PER_REQUEST_USD) || DEFAULT_PER_REQUEST_USD) * 1_000_000);
  if (maxCostMicro > perRequestLimitMicro) throw new Error(ANTHROPIC_GATEWAY_ERRORS.perRequestLimit);

  const limitMicro = Math.round((Number(env.ANTHROPIC_MAX_TOTAL_USD) || DEFAULT_TOTAL_USD) * 1_000_000);
  await resolveAccount(env, limitMicro, input.now);

  const fingerprint = `${input.operation}:${input.situationId}:${crypto.randomUUID()}`;
  const resId = await reserve(env, { fingerprint, operation: input.operation, model, estInput, maxOutput: MAX_OUTPUT_TOKENS, amountMicro: maxCostMicro, now: input.now });

  const doFetch = input.fetchImpl || fetch;
  try {
    const response = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: input.system,
        messages: [{ role: 'user', content: input.user }],
      }),
    });
    if (!response.ok) throw new Error(`ANTHROPIC_HTTP_${response.status}`);
    const payload = await response.json() as Record<string, unknown>;
    const text = Array.isArray(payload.content)
      ? (payload.content as Array<Record<string, unknown>>).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('')
      : '';
    const usage = (payload.usage ?? {}) as Record<string, unknown>;
    const inputTokens = Math.max(0, Math.round(Number(usage.input_tokens) || 0));
    const outputTokens = Math.max(0, Math.round(Number(usage.output_tokens) || 0));
    const actualMicro = calculateActualCostMicro(price, inputTokens, outputTokens);
    const providerId = payload.id ? String(payload.id) : null;
    await completeReservation(env, resId, maxCostMicro, actualMicro, input.operation, model, inputTokens, outputTokens, providerId, input.now);
    return { text, inputTokens, outputTokens, model, providerId };
  } catch (caught) {
    await failReservation(env, resId, maxCostMicro, input.operation, model, caught instanceof Error ? caught.message : 'ANTHROPIC_UNKNOWN', input.now);
    throw caught;
  }
}

/** Kurzer Budgetstatus für die UI (nur Zahlen, keine Inhalte). */
export async function llmBudgetStatus(env: Env): Promise<{ limitMicro: number; spentMicro: number; reservedMicro: number } | null> {
  const row = await env.DB.prepare(`SELECT limit_micro, spent_micro, reserved_micro FROM ai_llm_budget WHERE id = ?1`)
    .bind(ACCOUNT_ID).first<{ limit_micro: number; spent_micro: number; reserved_micro: number }>();
  if (!row) return null;
  return { limitMicro: Number(row.limit_micro), spentMicro: Number(row.spent_micro), reservedMicro: Number(row.reserved_micro) };
}
