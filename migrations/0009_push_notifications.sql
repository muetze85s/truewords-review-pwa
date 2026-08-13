-- 0009_push_notifications.sql
--
-- Web-Push für die Doppelprüfung. Reine Zusatz-Tabellen, keine bestehende
-- berührt. Zeiten werden als "HH:MM in Zeitzone" geführt (siehe push_settings),
-- nie als feste UTC-Zahl — die Übersetzung passiert im Worker über Intl.

-- Ein Abo je Endpunkt (Gerät/Browser). reviewer sagt, wem das Gerät gehört.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  reviewer TEXT NOT NULL CHECK (reviewer IN ('Philipp', 'Lena')),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_reviewer
  ON push_subscriptions(reviewer);

-- Genau eine Einstellungszeile (id = 1). Philipp steuert alles hierüber.
CREATE TABLE IF NOT EXISTS push_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reminders_lena_enabled INTEGER NOT NULL DEFAULT 1 CHECK (reminders_lena_enabled IN (0, 1)),
  reminders_philipp_enabled INTEGER NOT NULL DEFAULT 1 CHECK (reminders_philipp_enabled IN (0, 1)),
  lena_time_1 TEXT NOT NULL DEFAULT '09:00',
  lena_time_2 TEXT NOT NULL DEFAULT '18:00',
  philipp_time_1 TEXT NOT NULL DEFAULT '09:00',
  philipp_time_2 TEXT NOT NULL DEFAULT '18:00',
  lena_tz TEXT NOT NULL DEFAULT 'Europe/Berlin',
  philipp_tz TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  notify_philipp_on_lena_submit INTEGER NOT NULL DEFAULT 1 CHECK (notify_philipp_on_lena_submit IN (0, 1)),
  dispute_alert_enabled INTEGER NOT NULL DEFAULT 1 CHECK (dispute_alert_enabled IN (0, 1)),
  dispute_threshold INTEGER NOT NULL DEFAULT 5,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO push_settings (id) VALUES (1);

-- Doppelversand-Schutz: je (Person, Art, Ortstag) höchstens einmal.
-- kind: 'reminder:0' / 'reminder:1' (Slot der zwei Zeiten), 'dispute',
-- oder 'lena_submit:<round>' (Sofort-Hinweis, ymd fix '-').
CREATE TABLE IF NOT EXISTS push_state (
  reviewer TEXT NOT NULL,
  kind TEXT NOT NULL,
  ymd TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (reviewer, kind, ymd)
);
