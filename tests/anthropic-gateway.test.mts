import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  rateWithAnthropic,
  calculateActualCostMicro,
  estimateMaxCostMicro,
  estimateInputTokens,
  validateModelPrice,
} from '../src/anthropic-gateway.ts';

// Minimaler D1-Ersatz über node:sqlite (prepare().bind().run()/first()/all()).
function d1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async run() { const r = stmt.run(...(args as never[])); return { meta: { changes: r.changes } }; },
            async first() { return stmt.get(...(args as never[])) ?? null; },
            async all() { return { results: stmt.all(...(args as never[])) }; },
          };
        },
      };
    },
  };
}

// --- Reine Kostenarithmetik ---------------------------------------------

{
  const price = validateModelPrice('claude-haiku-4-5');
  // Mikro-USD = Tokens · Preis(USD/1M). 1200·1 + 20·5 = 1300.
  assert.equal(calculateActualCostMicro(price, 1200, 20), 1300);
  assert.ok(estimateMaxCostMicro(price, 1200, 1024) >= 1300, 'Maximalkosten inkl. Marge ≥ Ist');
  assert.ok(estimateInputTokens('abc', 'def') >= 1);
  assert.throws(() => validateModelPrice('gpt-irgendwas'), /ANTHROPIC_MODEL_PRICE_UNKNOWN/);
}

// --- Ledger: reserve → commit → release ---------------------------------

const db = new DatabaseSync(':memory:');
const migration = readFileSync('migrations/0014_llm_third_rater.sql', 'utf8');
db.exec(migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS ai_llm_budget')));

const env = {
  DB: d1(db),
  ANTHROPIC_API_KEY: 'k',
  ANTHROPIC_MODEL: 'claude-haiku-4-5',
  ANTHROPIC_MAX_TOTAL_USD: '1',
  ANTHROPIC_MAX_COST_PER_REQUEST_USD: '0.05',
} as never;

const okFetch = async () => ({
  ok: true,
  json: async () => ({ id: 'msg_x', content: [{ type: 'text', text: '{"topic_shift": true}' }], usage: { input_tokens: 1200, output_tokens: 20 } }),
}) as never;

{
  const res = await rateWithAnthropic(env, { system: 's', user: 'u', operation: 'test', situationId: 1, now: 1700000000000, fetchImpl: okFetch });
  assert.ok(res.text.includes('topic_shift'));
  assert.equal(res.inputTokens, 1200);
  assert.equal(res.outputTokens, 20);
  const budget = db.prepare('SELECT * FROM ai_llm_budget').get() as Record<string, number>;
  assert.equal(budget.reserved_micro, 0, 'Reservierung nach commit freigegeben');
  assert.equal(budget.spent_micro, 1300, 'Ist-Kosten verbucht');
  const usage = db.prepare('SELECT * FROM ai_llm_usage_events').all() as Array<Record<string, number>>;
  assert.equal(usage.length, 1);
  assert.equal(usage[0].success, 1);
  assert.equal(usage[0].actual_micro, 1300);
  // Kein Nachrichteninhalt / Prompt im Kostenprotokoll.
  const cols = (db.prepare('PRAGMA table_info(ai_llm_usage_events)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!cols.some((c) => /prompt|content|text|system|message/u.test(c)), 'kein Inhalt im Ledger');
}

// --- Ledger: Fehlschlag gibt frei, verbucht keine Kosten ----------------

{
  const failFetch = async () => ({ ok: false, status: 500 }) as never;
  await assert.rejects(
    () => rateWithAnthropic(env, { system: 's', user: 'u', operation: 'test', situationId: 2, now: 1700000001000, fetchImpl: failFetch }),
    /ANTHROPIC_HTTP_500/,
  );
  const budget = db.prepare('SELECT * FROM ai_llm_budget').get() as Record<string, number>;
  assert.equal(budget.reserved_micro, 0, 'nach Fehler freigegeben');
  assert.equal(budget.spent_micro, 1300, 'Fehlschlag ohne Kosten');
  const failEv = db.prepare("SELECT * FROM ai_llm_usage_events WHERE success = 0").get() as Record<string, string>;
  assert.equal(failEv.error_code, 'ANTHROPIC_HTTP_500');
}

// --- Budgetgrenze greift -------------------------------------------------

{
  const tiny = { ...(env as object), ANTHROPIC_MAX_TOTAL_USD: '0.000001' } as never;
  await assert.rejects(
    () => rateWithAnthropic(tiny, { system: 's', user: 'u', operation: 'test', situationId: 3, now: 1700000002000, fetchImpl: okFetch }),
    /ANTHROPIC_(BUDGET_EXCEEDED|PER_REQUEST)/,
  );
}

console.log('anthropic-gateway tests: PASS');
