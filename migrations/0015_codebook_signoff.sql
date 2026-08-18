-- 0015_codebook_signoff.sql
--
-- Freigabe der Kodierhandbuch-Definitionen: Philipp und Lena haken auf der
-- Nachschlage-Seite je Definition ab („gegengelesen, passt"). Eine Definition
-- gilt als beidseitig freigegeben, wenn beide für dieselbe codebook_version
-- abgehakt haben. Rein additiv; kein FK (pattern_key ist keine Tabellenspalte).

CREATE TABLE IF NOT EXISTS review_codebook_signoff (
  pattern_key TEXT NOT NULL,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena')),
  codebook_version INTEGER NOT NULL,
  agreed INTEGER NOT NULL DEFAULT 1 CHECK (agreed IN (0, 1)),
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pattern_key, reviewer, codebook_version)
);
