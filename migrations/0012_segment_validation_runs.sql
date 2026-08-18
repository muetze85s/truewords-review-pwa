-- 0012_segment_validation_runs.sql
--
-- Verlauf des Trainings-/Validierungs-Splits (Validierungs-Split als Feature,
-- analog zu Migration 0011 / segment_optimizer_runs). Prüft, ob die
-- gefundene Segmentierungsregel echt ist oder auf den bisherigen Runden
-- overfittet: Runden werden reproduzierbar (split_seed) 70/30 in
-- Training/Validierung geteilt, der aktuelle/beste Schwellwert wird auf
-- BEIDEN Teilmengen getrennt ausgewertet. Rein informativ — ändert nichts
-- an der tatsächlich laufenden Segmentierung.

CREATE TABLE IF NOT EXISTS segment_validation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rounds_total INTEGER NOT NULL,
  rounds_train INTEGER NOT NULL,
  rounds_validate INTEGER NOT NULL,
  split_seed INTEGER NOT NULL,
  threshold_minutes INTEGER NOT NULL,
  f1_train REAL NOT NULL,
  f1_validate REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segment_validation_runs_dataset
  ON segment_validation_runs(dataset_id, ran_at DESC);
