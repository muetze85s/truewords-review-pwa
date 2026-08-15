-- 0010_push_settings_symmetry.sql
--
-- Push-Einstellungen symmetrisch machen (Master-Handoff Punkt 7): beide
-- Personen bekommen identische Schalter statt eines geteilten Toggles.
-- notify_philipp_on_lena_submit (0009) bleibt für die Richtung Lena→Philipp;
-- die Gegenrichtung Philipp→Lena bekommt hier ihre eigene Spalte. Die
-- Streitfall-Erinnerung wird ebenfalls je Person abschaltbar, die Schwelle
-- bleibt gemeinsam (ein Wert für beide Module).

ALTER TABLE push_settings
  ADD COLUMN notify_lena_on_philipp_submit INTEGER NOT NULL DEFAULT 1;

ALTER TABLE push_settings
  ADD COLUMN dispute_alert_philipp_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE push_settings
  ADD COLUMN dispute_alert_lena_enabled INTEGER NOT NULL DEFAULT 1;

UPDATE push_settings SET
  dispute_alert_philipp_enabled = dispute_alert_enabled,
  dispute_alert_lena_enabled = dispute_alert_enabled
WHERE id = 1;
