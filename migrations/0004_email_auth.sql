PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS review_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('Philipp', 'Lena')),
  can_upload INTEGER NOT NULL DEFAULT 0 CHECK (can_upload IN (0, 1)),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_users_role
  ON review_users(role);

CREATE TABLE IF NOT EXISTS review_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES review_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_sessions_user
  ON review_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_review_sessions_expires
  ON review_sessions(expires_at);
