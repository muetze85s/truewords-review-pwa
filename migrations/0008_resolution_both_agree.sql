-- 0008_resolution_both_agree.sql
--
-- Auftrag 2: Ein Streitfall gilt erst als GEKLÄRT, wenn BEIDE Prüfer dieselbe
-- Entscheidung getroffen haben (beide 'cut' oder beide 'no_cut'). Dafür muss die
-- Tabelle zwei Entscheidungen je Naht halten können — `decided_by` wandert in den
-- Primärschlüssel: (dataset_id, round, seam_message_id, decided_by).
--
-- Die bestehenden Fälle wurden von Philipp und Lena GEMEINSAM besprochen. Sie
-- werden als BEIDSEITIG BESTÄTIGT übernommen: jede bestehende Zeile wird zu ZWEI
-- übereinstimmenden Stimmen (einmal Philipp, einmal Lena, gleiche decision/note)
-- — sie zählen nach der neuen Regel weiterhin als geklärt, fallen NICHT auf
-- offen zurück.
--
-- Reiner Tabellen-Neubau (SQLite kann den PK nicht in place ändern). Keine
-- andere Tabelle verweist per FOREIGN KEY auf review_boundary_resolutions, der
-- Neubau reißt also nichts mit. Läuft über alle dataset_id der Tabelle.

CREATE TABLE review_boundary_resolutions_v2 (
  dataset_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  seam_message_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('cut', 'no_cut', 'open')),
  note TEXT,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('Philipp', 'Lena')),
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_id, round, seam_message_id, decided_by),
  FOREIGN KEY (dataset_id) REFERENCES review_datasets(id) ON DELETE CASCADE
);

-- Stimme 1: Philipp — dieselbe Entscheidung wie im gemeinsam geklärten Altfall.
INSERT INTO review_boundary_resolutions_v2
  (dataset_id, round, seam_message_id, decision, note, decided_by, decided_at)
SELECT dataset_id, round, seam_message_id, decision, note, 'Philipp', decided_at
FROM review_boundary_resolutions;

-- Stimme 2: Lena — identische Entscheidung, damit der Fall beidseitig bestätigt ist.
INSERT INTO review_boundary_resolutions_v2
  (dataset_id, round, seam_message_id, decision, note, decided_by, decided_at)
SELECT dataset_id, round, seam_message_id, decision, note, 'Lena', decided_at
FROM review_boundary_resolutions;

DROP TABLE review_boundary_resolutions;

ALTER TABLE review_boundary_resolutions_v2 RENAME TO review_boundary_resolutions;

CREATE INDEX IF NOT EXISTS idx_boundary_resolutions_round
  ON review_boundary_resolutions(dataset_id, round);
