PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS review_datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  dataset_hash TEXT NOT NULL UNIQUE,
  chat_meta_json TEXT NOT NULL,
  annotations_json TEXT NOT NULL,
  owners_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS review_chat_chunks (
  dataset_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  messages_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_id, chunk_index),
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

CREATE INDEX IF NOT EXISTS idx_review_chat_chunks_dataset
  ON review_chat_chunks(dataset_id, chunk_index);
