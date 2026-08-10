-- 0007_boundary_double_review.sql
--
-- Doppelprüfung der Situationsgrenzen: Philipp und Lena teilen dieselben
-- Runden unabhängig voneinander ein. Daraus ergibt sich die Übereinstimmung
-- zwischen zwei Menschen — die Obergrenze, gegen die die Automatik antritt.
--
-- Eigener, paralleler Datenpfad ohne Eigentümerbegriff: jeder Prüfer
-- schreibt ausschließlich eigene Zeilen, Konflikte sind konstruktionsbedingt
-- ausgeschlossen. src/worker-d1.ts und die Merge-/Eigentümerlogik bleiben
-- unberührt.

PRAGMA foreign_keys = ON;

-- Welcher Ausschnitt gehört zu welcher Runde. Einmal festgelegt, nie geändert.
CREATE TABLE IF NOT EXISTS review_rounds (
  dataset_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  first_message_id TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_id, round),
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

-- Eine Zeile je markiertem Zwischenraum je Prüfer.
-- seam_message_id ist die ID der Nachricht NACH der Grenze.
CREATE TABLE IF NOT EXISTS review_boundary_marks (
  dataset_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena')),
  seam_message_id TEXT NOT NULL,
  mark TEXT NOT NULL CHECK (mark IN ('cut', 'doubt')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_id, round, reviewer, seam_message_id),
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_boundary_marks_round
  ON review_boundary_marks(dataset_id, round, reviewer);

-- Erst wenn beide abgegeben haben, darf einer die Markierung des anderen sehen.
CREATE TABLE IF NOT EXISTS review_round_submissions (
  dataset_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena')),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_id, round, reviewer),
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

-- Ergebnis der gemeinsamen Klärung eines Streitfalls.
CREATE TABLE IF NOT EXISTS review_boundary_resolutions (
  dataset_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  seam_message_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('cut', 'no_cut', 'open')),
  note TEXT,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('Philipp', 'Lena')),
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_id, round, seam_message_id),
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);
