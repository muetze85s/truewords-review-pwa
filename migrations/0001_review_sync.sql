PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS review_datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  dataset_hash TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL UNIQUE,
  annotations_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS review_owners (
  dataset_id TEXT NOT NULL,
  situation_id INTEGER NOT NULL,
  assigned_to TEXT NOT NULL CHECK (assigned_to IN ('Philipp', 'Lena')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_id, situation_id),
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  situation_id INTEGER,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena', 'Admin')),
  action TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_events_dataset_created
  ON review_events(dataset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_owners_reviewer
  ON review_owners(dataset_id, assigned_to, situation_id);
