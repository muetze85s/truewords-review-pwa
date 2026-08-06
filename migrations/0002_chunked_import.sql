ALTER TABLE review_chat_chunks
  ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS review_import_sessions (
  dataset_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  expected_chunks INTEGER NOT NULL,
  expected_messages INTEGER NOT NULL,
  dataset_hash TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_import_sessions_updated
  ON review_import_sessions(updated_at DESC);
