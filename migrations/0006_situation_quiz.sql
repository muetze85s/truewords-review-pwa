CREATE TABLE IF NOT EXISTS review_situation_quiz_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena')),
  quiz_version INTEGER NOT NULL,
  answers_json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reviewer, quiz_version)
);

CREATE INDEX IF NOT EXISTS idx_situation_quiz_reviewer_version
  ON review_situation_quiz_results(reviewer, quiz_version);
