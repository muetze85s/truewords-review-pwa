-- 0014_llm_third_rater.sql
--
-- PR 2: LLM als dritter, unabhängiger Kodierer (Anthropic/Claude, anderer
-- Anbieter als P5/OpenAI — Zirkularitätsvermeidung). Additiv.
--
-- (a) review_classification_marks um reviewer 'LLM' (großgeschrieben, wie
--     'Philipp'/'Lena') und eine Spalte rater_model erweitern — damit Kappa
--     über die Zeit vergleichbar bleibt, wenn das Modell wechselt (analog
--     detector_version). SQLite kann CHECK nicht in place ändern → Tabellen-
--     Neubau wie in 0008. Keine FK verweist auf diese Tabelle, der Neubau
--     reißt nichts mit. Es existieren noch keine 'LLM'-Zeilen.
-- (b) Kosten-Ledger für den Anthropic-Gateway (Zwei-Phasen-Commit, ganzzahlige
--     Mikro-Dollar, KEINE Nachrichteninhalte/Prompts).
-- (c) review_classification_auto: je pattern_key Freigabe-Flag für den
--     automatischen Dauerbetrieb + die zugrunde liegenden Kappa-Werte.

PRAGMA foreign_keys = ON;

-- (a) ---------------------------------------------------------- Marks-Neubau
CREATE TABLE review_classification_marks_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation_id INTEGER NOT NULL REFERENCES review_situations(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena', 'LLM')),
  pattern_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  is_correction_of_llm INTEGER NOT NULL DEFAULT 0 CHECK (is_correction_of_llm IN (0, 1)),
  codebook_version INTEGER NOT NULL DEFAULT 1,
  rater_model TEXT,                       -- z. B. 'claude-haiku-4-5'; NULL bei Menschen
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (situation_id, reviewer, pattern_key)
);

INSERT INTO review_classification_marks_v2
  (id, situation_id, reviewer, pattern_key, present, is_correction_of_llm, codebook_version, rater_model, submitted_at)
SELECT id, situation_id, reviewer, pattern_key, present, is_correction_of_llm, codebook_version, NULL, submitted_at
FROM review_classification_marks;

DROP TABLE review_classification_marks;
ALTER TABLE review_classification_marks_v2 RENAME TO review_classification_marks;

CREATE INDEX IF NOT EXISTS idx_classification_marks_situation
  ON review_classification_marks(situation_id, reviewer);
CREATE INDEX IF NOT EXISTS idx_classification_marks_pattern
  ON review_classification_marks(pattern_key);

-- (b) ---------------------------------------------------------- Kosten-Ledger
-- Ein einziges laufendes Konto (Labor, ein Betreiber). Limit wird beim Reservieren
-- aus der Env gesetzt. reserved/spent in ganzzahligen Mikro-Dollar.
CREATE TABLE IF NOT EXISTS ai_llm_budget (
  id TEXT PRIMARY KEY,
  limit_micro INTEGER NOT NULL,
  spent_micro INTEGER NOT NULL DEFAULT 0,
  reserved_micro INTEGER NOT NULL DEFAULT 0,
  is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_llm_reservations (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  est_input_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  reserved_micro INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'completed', 'failed', 'released')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_llm_reservations_fp
  ON ai_llm_reservations(budget_id, request_fingerprint);
CREATE INDEX IF NOT EXISTS idx_ai_llm_reservations_status
  ON ai_llm_reservations(status, expires_at);

-- Nur Tokens/Kosten/Modell/Fehlercode — nie Nachrichteninhalt oder Prompt.
CREATE TABLE IF NOT EXISTS ai_llm_usage_events (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  actual_micro INTEGER NOT NULL DEFAULT 0,
  provider_request_id TEXT,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_llm_usage_events_res
  ON ai_llm_usage_events(reservation_id);

-- (c) ------------------------------------------------- Freigabe je Musterklasse
-- Freigabe für den automatischen Dauerbetrieb: erst wenn Kappa Mensch-Mensch
-- ≥ 0,60–0,67 UND Kappa Mensch-LLM ≥ 0,60 vorliegt. Rein informativ gespeichert,
-- die eigentliche Entscheidung trifft der Betreiber über den Endpunkt.
CREATE TABLE IF NOT EXISTS review_classification_auto (
  pattern_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  kappa_hh REAL,
  kappa_hl REAL,
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
