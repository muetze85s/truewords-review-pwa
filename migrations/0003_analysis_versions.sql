PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS review_analysis_versions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  annotations_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_analysis_versions_dataset
  ON review_analysis_versions(dataset_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_analysis_versions_one_active
  ON review_analysis_versions(dataset_id)
  WHERE is_active = 1;
