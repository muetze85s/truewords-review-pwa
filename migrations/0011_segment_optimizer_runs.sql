-- 0011_segment_optimizer_runs.sql
--
-- Verlauf der Schwellwert-Optimierung (Master-Handoff „Optimierung" auf
-- Settings). Jede Ausführung von /api/admin/optimize-threshold trägt hier
-- eine Zeile ein, damit die Settings-Seite „Letzte Optimierung" / „Trainiert
-- auf" / „Bestes F1" anzeigen kann, ohne bei jedem Seitenaufruf neu zu
-- rechnen. Der tatsächlich laufende Schwellwert bleibt der Code-Konstante
-- PAUSE_BOUNDARY_HOURS vorbehalten — der Optimizer ist rein informativ
-- (kein automatisches Übernehmen).

CREATE TABLE IF NOT EXISTS segment_optimizer_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rounds_used INTEGER NOT NULL,
  tolerance INTEGER NOT NULL,
  doubt_mode TEXT NOT NULL,
  best_threshold_minutes INTEGER NOT NULL,
  best_threshold_hours REAL NOT NULL,
  best_f1 REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segment_optimizer_runs_dataset
  ON segment_optimizer_runs(dataset_id, ran_at DESC);
