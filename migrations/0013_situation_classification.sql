-- 0013_situation_classification.sql
--
-- Klassifizierungsstufe (Musterklassen): inhaltliche Ja/Nein-Klassifizierung
-- von Situationen durch zwei Menschen (Philipp, Lena) — dieselbe Blind-Doppel-
-- Prüfungsmaschinerie wie bei den Grenzen (0007/0008), nur pro Situation und
-- pro Musterklasse statt pro Naht. Zusätzlich Zuschnitt-Qualitätsflags
-- (Rückmeldung an die Segmentierung) und eine generische app_settings-Tabelle.
--
-- Rein additiv: keine bestehende Tabelle wird geändert. reviewer/decided_by
-- folgen der bestehenden Konvention aus 0007 ('Philipp' | 'Lena', großgeschrieben).
-- 'llm' ist im reviewer-CHECK der Mark-/Flag-Tabellen bereits erlaubt (PR 2,
-- LLM-Dritt-Rater) — spart dort einen Tabellen-Neubau. LLM stimmt aber nie ab
-- und flaggt nicht selbst-auflösend: decided_by bleibt auf Philipp/Lena.

PRAGMA foreign_keys = ON;

-- Eine Zeile je abgeleiteter Situation (Spanne zwischen zwei aufeinander-
-- folgenden Grenzen aus combinedBoundary). Lazy angelegt beim ersten Öffnen
-- der Runde; Idempotenz über UNIQUE(dataset_id, round, situation_index).
-- in_validation_sample = 1: nur diese werden Philipp/Lena blind vorgelegt
-- (begrenzte Validierungsstichprobe, ~150–200 Situationen).
CREATE TABLE IF NOT EXISTS review_situations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  situation_index INTEGER NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  in_validation_sample INTEGER NOT NULL DEFAULT 0 CHECK (in_validation_sample IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (dataset_id, round, situation_index),
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_situations_round
  ON review_situations(dataset_id, round);
CREATE INDEX IF NOT EXISTS idx_review_situations_sample
  ON review_situations(dataset_id, in_validation_sample);

-- Eine Zeile je (Situation, Prüfer, Klasse): angekreuzt (present=1) oder
-- explizit verneint (present=0). is_correction_of_llm markiert menschliche
-- Korrekturen einer LLM-Ausgabe (spätere Few-Shot-Quelle, PR 2). codebook_version
-- hält die Kodierhandbuchversion fest, unter der markiert wurde.
CREATE TABLE IF NOT EXISTS review_classification_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation_id INTEGER NOT NULL REFERENCES review_situations(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena', 'llm')),
  pattern_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  is_correction_of_llm INTEGER NOT NULL DEFAULT 0 CHECK (is_correction_of_llm IN (0, 1)),
  codebook_version INTEGER NOT NULL DEFAULT 1,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (situation_id, reviewer, pattern_key)
);

CREATE INDEX IF NOT EXISTS idx_classification_marks_situation
  ON review_classification_marks(situation_id, reviewer);
CREATE INDEX IF NOT EXISTS idx_classification_marks_pattern
  ON review_classification_marks(pattern_key);

-- Blindheit als Servereigenschaft: erst wenn ein Prüfer die Situation
-- abgegeben hat, darf er die Markierungen des anderen sehen (analog
-- review_round_submissions, hier je Situation statt je Runde). Nur Menschen.
CREATE TABLE IF NOT EXISTS review_classification_submissions (
  situation_id INTEGER NOT NULL REFERENCES review_situations(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena')),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (situation_id, reviewer)
);

-- Streitfall-Auflösung nach dem „beide müssen zustimmen"-Muster aus 0008:
-- decided_by ist Teil des Schlüssels, geklärt gilt erst, wenn beide denselben
-- resolved_present gesetzt haben.
CREATE TABLE IF NOT EXISTS review_classification_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation_id INTEGER NOT NULL REFERENCES review_situations(id) ON DELETE CASCADE,
  pattern_key TEXT NOT NULL,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('Philipp', 'Lena')),
  resolved_present INTEGER NOT NULL CHECK (resolved_present IN (0, 1)),
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (situation_id, pattern_key, decided_by)
);

CREATE INDEX IF NOT EXISTS idx_classification_resolutions_situation
  ON review_classification_resolutions(situation_id);

-- Zuschnitt-Qualitätsflags: bewerten die Grenze, nicht den Inhalt. Getrennte
-- Tabelle, damit ihre Kappa-Auswertung die der 20 Inhaltsklassen nicht
-- verfälscht (Abschnitt 7a).
CREATE TABLE IF NOT EXISTS review_situation_quality_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation_id INTEGER NOT NULL REFERENCES review_situations(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena', 'llm')),
  flag_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (situation_id, reviewer, flag_key)
);

CREATE INDEX IF NOT EXISTS idx_quality_flags_situation
  ON review_situation_quality_flags(situation_id, reviewer);

-- Streitfall-Auflösung der Zuschnitt-Flags, gleiches Muster wie oben.
CREATE TABLE IF NOT EXISTS review_situation_quality_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation_id INTEGER NOT NULL REFERENCES review_situations(id) ON DELETE CASCADE,
  flag_key TEXT NOT NULL,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('Philipp', 'Lena')),
  resolved_present INTEGER NOT NULL CHECK (resolved_present IN (0, 1)),
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (situation_id, flag_key, decided_by)
);

CREATE INDEX IF NOT EXISTS idx_quality_resolutions_situation
  ON review_situation_quality_resolutions(situation_id);

-- Generische Schlüssel-Wert-Einstellungen (kleinste Lösung, Abschnitt 4a).
-- Erster Eintrag: Lenas Zugang zur Klassifizierung, Default aus ('0').
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('lena_classification_enabled', '0');
