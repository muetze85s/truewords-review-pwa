-- Globale, stabile Positions-Ordinalzahl je Nachricht (dataset-scoped).
--
-- Hintergrund: bisher waren Grenzen/Streitfälle runden-lokal nummeriert
-- ("Streitfall 3") und Situationen über situation_index ("R5·3"). Beides ist
-- mehrdeutig (in jeder Runde gibt es einen Streitfall 3) und verschiebt sich,
-- wenn ein Streitfall geklärt oder die Stichprobe neu abgeleitet wird.
--
-- Stattdessen bekommt jede Nachricht EINE global stabile Ordinalzahl: ihren
-- 1-basierten Platz in der globalen Chronologie (= filteredSequence-Reihenfolge,
-- die Telegram-Export-/Chunk-Reihenfolge). Eine Grenze/Naht wird über die ihr
-- folgende Nachricht (seam_message_id) benannt → "Grenze N". Eine Situation über
-- ihre Start-Grenze → "Situation ab Grenze N" (Ordinalzahl von start_message_id).
--
-- Persistiert (statt pro Request neu berechnet), damit
--   (a) die Nummern unveränderlich bleiben — Neuimporte hängen nur hinten an,
--       bestehende Ordinalzahlen verschieben sich nie; und
--   (b) die billigen Übersichts-Pfade (Klassifizierung/Grenzen) die Nummer per
--       indiziertem Lookup holen, OHNE den ganzen Chat neu zu parsen.
--
-- Vergabe append-only: schon vergebene Nummern bleiben; neue Nachrichten
-- bekommen fortlaufend die nächste freie Nummer hinter der bisher höchsten
-- (siehe ensureMessageOrdinals in worker-boundary-pairs.ts). Ein — bei einem
-- Append-only-Chat praktisch nie auftretender — mid-history eingefügter Eintrag
-- bekommt ebenfalls die nächste End-Nummer und ist dann nicht mehr streng
-- positionsmonoton, aber weiterhin stabil und global eindeutig.

CREATE TABLE IF NOT EXISTS review_message_ordinals (
  dataset_id TEXT    NOT NULL,
  message_id TEXT    NOT NULL,
  ordinal    INTEGER NOT NULL,
  PRIMARY KEY (dataset_id, message_id)
);

-- Für den (selten nötigen) Blick "welche Ordinalzahl ist die höchste / gibt es
-- eine Nummer N" sowie stabile Sortierung.
CREATE INDEX IF NOT EXISTS idx_message_ordinals_by_ordinal
  ON review_message_ordinals (dataset_id, ordinal);
