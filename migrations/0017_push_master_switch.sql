-- 0017_push_master_switch.sql
--
-- Echter Hauptschalter je Person. Bisher gab es keinen: „Benachrichtigungen
-- [Person] aktiv" hieß nur so, schaltete aber ausschließlich die täglichen
-- Erinnerungen (reminders_*_enabled). Abgabe-Hinweis, Streitfall-Alarm und
-- der Test-Push liefen daran vorbei — ein Schalter mit Ausnahmen.
--
-- Ab hier gilt: push_enabled_<person> = 0 → an diese Person geht KEINERLEI
-- Web-Push (Test, Zeit 1, Zeit 2, Streitfall, Abgabe des Partners).
-- Durchgesetzt wird das an genau einer Stelle im Sendepfad (notifyReviewer in
-- worker-push.ts), nicht an den einzelnen Aufrufstellen.
--
-- Die drei Anlass-Schalter (notify_*_on_*_submit, dispute_alert_*_enabled)
-- bleiben als Feinsteuerung UNTER dem Hauptschalter bestehen.
--
-- Additiv: keine bestehende Tabelle wird geändert, nichts gelöscht.

ALTER TABLE push_settings
  ADD COLUMN push_enabled_philipp INTEGER NOT NULL DEFAULT 1;

ALTER TABLE push_settings
  ADD COLUMN push_enabled_lena INTEGER NOT NULL DEFAULT 1;

-- Der eigene Erinnerungs-Schalter entfällt: die beiden Zeiten haben je ein
-- eigenes Häkchen (leere Zeit = abgeschaltet), ein dritter Schalter darüber
-- war doppelt gemoppelt. Damit „keine Erinnerungen" für wen auch immer das
-- heute eingestellt hat, exakt so bleibt, werden dessen Zeiten geleert.
-- reminders_*_enabled bleibt als Spalte stehen (additiv, kein DROP), wird vom
-- Code aber nicht mehr gelesen.
UPDATE push_settings
  SET philipp_time_1 = '', philipp_time_2 = ''
  WHERE id = 1 AND reminders_philipp_enabled = 0;

UPDATE push_settings
  SET lena_time_1 = '', lena_time_2 = ''
  WHERE id = 1 AND reminders_lena_enabled = 0;
