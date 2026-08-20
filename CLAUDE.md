# CLAUDE.md — TrueWords Review PWA

Prüf- und Annotations-PWA für die manuelle Segmentierung eines privaten
Telegram-Chat-Exports. Läuft als Cloudflare Worker mit statischen Assets und
D1-Datenbank. Zwei Prüfer (Philipp, Lena) markieren Situationsgrenzen; eine
Doppelprüfung vergleicht ihre Grenzen und misst die Übereinstimmung.

## Tech-Stack

- **Laufzeit:** Cloudflare Workers (`fetch` + `scheduled`/Cron). `compatibility_date` 2026-08-05.
- **Datenbank:** Cloudflare D1 (SQLite), Binding `DB`, DB-Name `truewords-review-sync-db`.
- **Assets:** statische Dateien aus `./dist`, Binding `ASSETS`, SPA-Fallback, `run_worker_first: true`.
- **Sprachen:** TypeScript 5.9 (Worker) + reines JavaScript (Browser) + `.mjs`-Logikmodule mit `.d.mts`-Typdeklarationen (in Node testbar, vom Worker importiert).
- **Build/Deploy:** Wrangler ^4.92 (`wrangler.jsonc`).
- **Abhängigkeiten:** `embla-carousel` 8.6 (Karussell). Dev: `@cloudflare/workers-types`, `typescript`, `wrangler`.
- **Web-Push:** VAPID (ES256-JWT), RFC 8291/8188 `aes128gcm`-Payload-Verschlüsselung, ECDH P-256, HKDF — alles über Web Crypto (`crypto.subtle`), ohne externe Bibliothek (`push-send.mjs`).
- **Zeitzonen:** über `Intl.DateTimeFormat` (Europe/Berlin mit Auto-Sommerzeit, Asia/Bangkok fix +7). Zeiten werden als „HH:MM in Zeitzone" gespeichert, nie als feste UTC-Zahl.

## Build- und Deploy-Befehle

```bash
npm run build        # kopiert die Asset-Liste aus scripts/build-worker.mjs nach ./dist
npm run check        # node --check je Datei + Tests + tsc --noEmit (Vollprüfung, s.u.)
npm run dev          # build + wrangler dev (lokal)
npm run deploy       # build + wrangler deploy
npm run import:data  # scripts/import-review-data.mjs (Datenimport, nur lokal/Betreiber)

# D1-Migrationen
npm run db:migrate:local   # wrangler d1 migrations apply truewords-review-sync-db --local
npm run db:migrate:remote  # wrangler d1 migrations apply truewords-review-sync-db --remote
```

`npm run check` ist das verbindliche Tor vor jedem Deploy: `node --check` auf allen
Browser-/Logikdateien, dann die Tests (`tests/segmentation-v4`, `tests/boundary-pairs-logic`,
`tests/push-schedule-logic`, `tests/push-send`, `tests/hauptapp-segmentierung` via
`--experimental-strip-types`) und abschließend `tsc --noEmit`.

**Deploy läuft über GitHub Actions** (`.github/workflows/cloudflare-review.yml`):
`npm run check` + `npm run build`, dann `wrangler deploy` und
`wrangler d1 migrations apply --remote`. Secrets: `CLOUDFLARE_API_TOKEN`
(braucht Workers- **und** D1-Edit-Rechte), optional `VAPID_PUBLIC`/`VAPID_PRIVATE`/`VAPID_SUBJECT`.

## Architektur-Überblick

### Worker-Kette (Dekorator-Muster)

Jede Schicht importiert die nächste als `baseWorker`/`appWorker` und delegiert
alles, was sie nicht selbst behandelt, per `baseWorker.fetch(request, env)`.
**Wichtig:** die Basis-`fetch` nimmt nur `(request, env)`, **nicht** `ctx`.
`main` ist `src/worker-push.ts` (oberste Schicht). Reihenfolge von oben nach unten:

```
worker-push               Web-Push: /api/push/*, Einstellungsseite-Gate, Sofort-Hinweis, scheduled()-Cron
  └ worker-classification Klassifizierung: Situationen, 20 Musterklassen + 3 Zuschnitt-Flags, blinde Doppelklassifizierung, Kappa, Lena-Freischaltung, LLM-Dritt-Rater (Anthropic) + Alpha + Abweichungsliste (/api/classification/*, /klassifizierung*.html)
    └ worker-boundary-pairs Doppelprüfung: Runden, Markierungen, Vergleich/F1, Streitfälle, ?dataset=, Transfer
      └ worker-source-integrity-v4  Integritätsprüfung des 4-Jahres-Rohchats
        └ worker-situation-quiz     Situations-Quiz
          └ worker-review-precision Präzisions-/Merge-Ansicht
            └ worker-source-integrity  Integritätsprüfung des Rohchats (Test 3)
              └ worker-review          Prüfstand-Auslieferung
                └ worker-chat-stream   Chat-Stream/Verarbeitung
                  └ worker-auth-fast   Login/Setup/Passwort-Reset (schneller Pfad)
                    └ worker-portal    Sessions, /api/auth/* (me, login, logout, setup)
                      └ worker-analysis  Analyse-Import/-Versionen
                        └ worker-chunked D1-Chunk-Upload großer Chats
                          └ worker-d1    unterste Schicht: D1-Zugriff, Datensätze
```

### D1-Schema (Migrationen `migrations/000X_*.sql`)

- `0001` Review-Sync-Grundtabellen (`review_datasets`, `review_messages`, …)
- `0002` Chunk-Import
- `0003` Analyse-Versionen
- `0004` E-Mail-Auth (`review_users`, `review_sessions`)
- `0005` Balance der Pilot-Review-Owner
- `0006` Situations-Quiz
- `0007` Doppelprüfung (`review_rounds`, `review_marks`, `review_round_submissions`, `review_resolutions`)
- `0008` Streitfall-Auflösung „beide müssen zustimmen" (`ON CONFLICT(dataset_id, round, seam_message_id, decided_by)`)
- `0009` Web-Push (`push_subscriptions`, `push_settings` (Singleton id=1), `push_state` für Dedup)
- `0010` Push-Einstellungen symmetrisch: `notify_lena_on_philipp_submit`, `dispute_alert_philipp_enabled`, `dispute_alert_lena_enabled` (je Person einzeln abschaltbar statt ein geteilter Schalter)
- `0011` `segment_optimizer_runs` — Verlauf der Schwellwert-Optimierung (rein informativ, ändert nicht die laufende Segmentierung)
- `0012` `segment_validation_runs` — Verlauf des Validierungs-Splits (70/30 Overfitting-Test, rein informativ)
- `0013` Klassifizierung: `review_situations` (+`in_validation_sample`), `review_classification_marks` (+`is_correction_of_llm`, `codebook_version`, reviewer inkl. `'llm'` — in 0014 auf `'LLM'` gehoben), `review_classification_submissions` (Blind-Gate je Situation), `review_classification_resolutions` (beide-müssen-zustimmen wie 0008), `review_situation_quality_flags`/`_resolutions` (3 Zuschnitt-Flags), `app_settings` (Key-Value, u. a. `lena_classification_enabled`)
- `0014` LLM-Dritt-Rater: `review_classification_marks` neu (reviewer `'LLM'` großgeschrieben + Spalte `rater_model`), Kosten-Ledger `ai_llm_budget`/`ai_llm_reservations`/`ai_llm_usage_events` (Zwei-Phasen-Commit, Mikro-Dollar, keine Inhalte), `review_classification_auto` (Freigabe je `pattern_key`). LLM = Anthropic/Claude über `anthropic-gateway.ts`; Secret `ANTHROPIC_API_KEY` (getrennt), Modell per `ANTHROPIC_MODEL` (Default `claude-haiku-4-5`), Deckel `ANTHROPIC_MAX_TOTAL_USD`/`ANTHROPIC_MAX_COST_PER_REQUEST_USD`.
- `0015` `review_codebook_signoff` — Freigabe-Häkchen je Definition (Philipp/Lena) auf der Nachschlage-Seite
- `0016` `review_message_ordinals` — global stabile Positions-Ordinalzahl je Nachricht (dataset-scoped, append-only). Basis der Grenz-Nummern in BEIDEN Werkzeugen; Vergabe/Lookup in `worker-boundary-pairs.ts` (`ensureMessageOrdinals`/`messageOrdinals`), Backfill zusätzlich über `POST /api/admin/backfill-ordinals`
- `0017` Push-Hauptschalter je Person (`push_enabled_philipp`/`push_enabled_lena`): steht er auf 0, geht an diese Person **keinerlei** Web-Push — Test, Zeit 1, Zeit 2, Streitfall, Abgabe des Partners. Durchgesetzt an genau einer Stelle (`notifyReviewer` in `worker-push.ts`, Gate `pushAllowedFor` aus `push-schedule-logic.mjs`). Der frühere Erinnerungs-Schalter `reminders_*_enabled` ist entfallen (die beiden Zeit-Häkchen sind die Schalter); die Spalte bleibt additiv stehen, wird aber nicht mehr gelesen.

### PWA (Browser)

Statische Seiten, ausgeliefert vom Worker; Service Worker `sw.js` (Cache-Name
`truewords-review-pwa-server-v39`) precacht Assets und trägt `push`- und
`notificationclick`-Handler. **Fetch-Strategie ist Stale-while-revalidate**
(Cache antwortet sofort, holt aber immer parallel eine frische Kopie nach) —
bei künftigen Deploys muss die Cache-Version **nicht mehr** manuell erhöht
werden, damit Änderungen ankommen. Hauptseiten:

- `login.html` / `account-setup.html` / `reset-password.html` — Zugang
- `review.html` — Prüfstand (Einzelsegmentierung)
- `doppelpruefung.html` + `boundary-pairs.js`/`.css` — **Segmentierung** (früher „Doppelprüfung"): Übersicht als Startansicht, Runde, Vergleich, Streitfälle
- `klassifizierung.html` + `classification.js`/`.css`, `klassifizierung-info.html` + `codebook-render.js` — Klassifizierung und Kodierhandbuch-Nachschlage-Seite
- `overview.css` — **gemeinsame** Übersichts-/Tabellen-Komponente beider Werkzeuge (klebende Kopfzeile, Σ/Ø-Aggregate, Spaltengruppen, mobil kompakte Überschriften). Keine zweite Fassung anlegen.
- `seam.css` — **gemeinsame** Grenzlinien-Komponente (`.tw-seam`), genutzt von Runden-Ansicht, Streitfall-Kontext UND dem Situationstrenner der Klassifizierung. Zustand über `data-mark` (cut/doubt/leer) und `data-owner` (Philipp/Lena/both).
- `situation-info.html`, `situation-quiz.html` — Situationskunde (nicht mehr im aktiven Login-Flow, Login springt direkt auf die Übersicht)
- `upload.html`, `admin.html`, `analysis-import.html` — Betrieb (nur `canUpload`/Philipp)
- `push-settings.html` — Settings, 4 Abschnitte: Gerät-Einstellungen, Push-Benachrichtigungen (zwei symmetrische Module Philipp/Lena), Optimierung (Schwellwert-Optimizer-Verlauf + „Neu trainieren"), Datenbank (`?dataset=`-Schalter)
- `nav.js`/`nav.css` — persistente Navigation: **Segmentierung · Klassifizierung · Upload · Settings** (zwei gleichwertige Werkzeuge, je mit eigener interner Übersicht), rollenbewusst; **kein** Dataset-Schalter im Kopfbalken — der lebt ausschließlich auf der Settings-Seite. `nav.js` veröffentlicht seine Höhe als `--tw-nav-height` für die klebenden Tabellenkopfzeilen.

### Ausgaben für Menschen, nicht für die Konsole (verbindlich)

**Jede Auswertung, Diagnose oder Kennzahl, die Philipp oder Lena ansehen sollen,
wird als lesbare Seite ausgeliefert — niemals als JSON zum Kopieren.** Gearbeitet
wird auf iPad und iPhone; dort ist die Browser-Konsole nicht bedienbar und JSON
lässt sich nicht sinnvoll markieren. Ein Endpunkt, dessen Antwort ein Mensch
lesen soll, rendert deshalb bei Seitenaufruf (`Accept: text/html`) HTML und
liefert Rohdaten nur auf ausdrückliches `?format=json`.

Vorbild und Muster: `GET /api/admin/segment-diagnose` in
`worker-boundary-pairs.ts` — serverseitig gerendert über `diagnosePage()` mit
den Helfern `escapeHtml`/`humanDuration`/`humanShare`/`humanTime`. Serverseitig
gerendert, damit keine zweite Seite plus Skript in die Asset-Liste muss und der
Service Worker keine veraltete Fassung ausliefern kann. Zahlen deutsch
formatiert (Komma, „4 h 01 min"), Tabellen in `.wrap` mit `overflow-x`, damit
mobil nichts quer scrollt.

Gilt auch für Betriebs-Endpunkte, die bisher JSON zurückgeben: sobald ihre
Ausgabe jemand lesen soll, bekommen sie einen HTML-Zweig. Ausgenommen sind nur
Endpunkte, die ausschließlich von Skripten aufgerufen werden.

Reine Logik liegt in `.mjs`-Modulen (`boundary-pairs-logic.mjs`,
`push-schedule-logic.mjs`, `push-send.mjs`, `segmentation-v4.mjs`) mit
zugehörigen `.d.mts` — in Node testbar, vom Worker wie von der Seite importierbar.

### Telegram-Komponente

Es gibt **keinen** laufenden Telegram-Bot. „Telegram" bezieht sich auf das
**Eingabeformat**: der private Chat wird als Telegram-JSON-Export hochgeladen.
`worker-source-integrity*.ts` verifiziert, dass der hochgeladene Rohchat der
vollständige, verlustfreie Telegram-Originalexport ist, bevor daraus der
Ereignisstrom gespeichert wird.

## Datensätze & aktueller Stand

- Aktiver Datensatz: `ACTIVE_DATASET_ID` in `wrangler.jsonc` → **`philena-4y`** (Umstieg auf 4 Jahre).
- `philena-2026-pilot-v4-unseen` ist **eingefroren** (`FROZEN_DATASETS` in `worker-boundary-pairs.ts`): bestehende Runden bleiben lesbar, es werden keine neuen Runden mehr angelegt.
- `?dataset=`-Schalter: pro Gerät wählbar (localStorage `tw_dataset`, Query-Param), wechselt zwischen Datensätzen **ohne Redeploy**. Server validiert die ID und fällt sonst auf den Standard zurück.
- Grenzdaten der Basis wurden **additiv** nach `philena-4y` übertragen (Transfer-Endpunkt `/api/admin/transfer-boundaries`): 17 Runden, 161 Markierungen, 31 Abgaben, 90 Streitfall-Zeilen. Basisdaten bleiben unangetastet.

### In Arbeit / zuletzt umgesetzt

- Web-Push vollständig implementiert (VAPID/`aes128gcm`, Erinnerungen je Zeitzone, Sofort-Hinweis bei Lenas Abgabe, Streitfall-Alarm ab Schwelle, 15-Min-Cron). Live-Zustellung erfordert gesetzte `VAPID_*`-Secrets **und** Geräte-Opt-in je Browser.
- **Web-Push bidirektional, je Person einzeln abschaltbar**: Wenn Lena eingibt → Philipp benachrichtigt (`notify_philipp_on_lena_submit`); wenn Philipp eingibt → Lena benachrichtigt (`notify_lena_on_philipp_submit`, Migration 0010). Ebenso die Streitfall-Erinnerung: `dispute_alert_philipp_enabled`/`dispute_alert_lena_enabled` statt einem geteilten Schalter.
- Live-F1 in der Doppelprüfung: nach jeder Annotation Neuberechnung und Anzeige, **ohne** automatische Parameteränderung.
- Persistente Navigation über alle Seiten (mobil/iPad-tauglich).
- **Übersicht als Startseite** (Runden-Tabelle, Aufgabe 10): nach Login landet man auf der Übersicht (Doppelprüfung-Tab). Tabelle aller Runden: Philipp ✓/offen, Lena ✓/offen, offene Streitfälle, Direktlink. Farbcode: Türkis=Philipp offen, Rosa=Lena offen, Gelb=beide offen, neutral=komplett.
- **Übersicht-Performance** (Aufgabe 11): N+1 eliminiert. `getOverview` ruft `filteredSequence` einmal + 4 Bulk-SQL-Queries statt pro Runde.
- **Sortierung & Navigation** (Aufgabe 12): neueste Runde oben, nach Abgabe Sprung zur nächsten offenen Runde.
- **PWA Standalone** (Aufgabe 14): Manifest mit PNG-Icons 192×192/512×512, `apple-mobile-web-app-capable` + `apple-touch-icon` in allen HTML-Köpfen.
- **Safari/iPad Push** (Aufgabe 13): iOS-Erkennung in `push-enable.js`/`push-settings.js` — Installationsanleitung statt Fehlermeldung im Browser-Modus.
- **Konsistenz-Aufräum Handoff 1–4, 7**: Dataset-Schalter nur auf Settings, Nav-Buttons weg, Tabellenspalten-Reihenfolge, F1-Text entfernt.
- **Konsistenz-Aufräum Handoff 5–6**: Grenzlinien-Styling (Türkis Philipp, Rosa Lena, dashed alternierend bei Übereinstimmung), Namen durchgehend gefärbt.
- **Master-Handoff (Konsistenz + Mobile + Settings-Neubau + Optimizer)**: siehe unten.

## Aktueller Fokus

_Stand: 2026-08-19_

**Stand heute:** Alles von heute ist **live** — letzter Deploy `1f27c58` (GitHub
Actions Run #97, alle 12 Schritte grün, inkl. D1-Migration 0016 und
Health-Check). Branch `claude/klassifizierung-musterklassen-plplo4`,
Arbeitsverzeichnis sauber, lokal = origin. Der Tag hatte drei Blöcke: den
Sammel-Handoff Bugfixes (9 Punkte, u. a. der D1-Blocker, der die
Klassifizierungs-Übersicht komplett lahmgelegt hatte), die Vereinheitlichung
von Navigation und Übersichten, und den UI-Nachtrag inkl. Grenznummer am Ort.

1. **Sammel-Handoff Bugfixes** (`26d544a` … `7b0152c`, 9 Punkte):
   - **P4 (Blocker):** `situation_id IN (?1…?N)` sprengte ab >100
     Validierungssituationen D1s 100-Bind-Limit → Übersicht lud gar nicht.
     Fix: Helper `selectBySituationIds` chunkt auf 90 Binds (4 Funktionen in
     `worker-classification.ts`). Kein Zwilling im Grenzen-Tool.
   - **P1:** global stabile Grenz-Nummern (Option B) — Migration `0016`,
     `review_message_ordinals`, append-only; Anzeige „Grenze N", Situationen
     über ihre Start-Grenze. Später gehärtet (Multi-Row-INSERT, nicht-fatal),
     damit der Erst-Backfill den 4-Jahres-Chat in einem Durchgang schafft.
   - **P2:** `filteredSequence`-Cache (Fingerprint aus Chunk-Anzahl + Bytelänge)
     + inkrementelles `putMarks` (Diff statt DELETE-all). Indizes geprüft: keine
     fehlenden.
   - **P3/P3b:** F1 bei GT=0 und κ/α bei degenerierter Klasse sind jetzt
     **n/a (null)**, nicht 0 bzw. 1; solche Fälle fließen nicht in die Aggregate.
   - **P9:** feste Klassencodes N1–N10 / P1–P9 / E1 / Z1–Z3, an `pattern_key`
     gebunden. **P7:** Polling eines billigen Zustands-Stempels (`/state`),
     Blindheit gewahrt. **P8/P5/P6:** mobile Kopfzeile, dicke Grenzlinien,
     iPad-Tastatur (`inputmode="numeric"`).
2. **Vereinheitlichung Navigation & Übersichten** (`946c280`): Nav auf
   `Segmentierung · Klassifizierung · Upload · Settings`; beide Werkzeuge mit
   identischem Muster (Nav → Übersicht → Einheit → „Zur Übersicht"); neue
   gemeinsame `overview.css`; Klassifizierungs-Übersicht mit
   offene-zuerst-Filter, 25/Seite, Σ/Ø-Aggregatkopf; klebende Kopfzeilen;
   Spaltengruppen; mobil ohne Querscrollen (bei 360/375/393px nachgemessen).
   Dabei gefunden: `body.cl .ov-row` in `classification.css` überschrieb wegen
   höherer Spezifität die gemeinsame Komponente — entfernt.
3. **UI-Nachtrag + Grenznummer am Ort** (`af2e3c0`, `1f27c58`): Gruppen heißen
   Negativ-/Positiv-Marker (passend zu N/P), Gruppentitel groß und kräftig
   (drei Regeln zu einer zusammengeführt), selbstimplizierend überall als
   gelbes ⚠. Grenznummer steht jetzt dort, wo die Grenze liegt: Trenner
   „Grenze N" über der ersten Nachricht einer Situation, Nummer an jeder
   gesetzten Grenzlinie der Runden-Ansicht, Nummer an der strittigen Linie im
   Streitfall. Dafür neue **gemeinsame** `seam.css`; `.dp-seam` und
   `.dp-dispute-seam` sind ersatzlos entfallen. Beim Zusammenführen behoben:
   die Prüferfarb-Regel war spezifischer als die Streitfall-Regel — eine
   strittige Naht wäre türkis statt rot geblieben. `dashboard.html/.css/.js`
   entfernt (verwaist); die Weiterleitung `/dashboard.html` bleibt für alte
   Lesezeichen.

**Morgen zuerst:**
1. **Live-Durchgang auf den echten Geräten** (nur Philipp/Lena können das, ich
   habe keine Session): App öffnen (ggf. zweimal — der Service Worker liefert
   stale-while-revalidate) und prüfen: (a) Klassifizierungs-Übersicht **lädt**
   überhaupt wieder (das war der Blocker), (b) Trenner „Grenze N" über der
   ersten Nachricht einer Situation, (c) Nummern an den Grenzlinien in Runden-
   und Streitfall-Ansicht, (d) Übersichten auf dem iPhone ohne Querscrollen mit
   klebender Kopfzeile, (e) eine Runde öffnen, Grenze setzen/zurücknehmen,
   Streitfall ansehen — nichts kaputt.
2. **Ordinal-Backfill gegenprüfen:** läuft automatisch beim ersten Laden der
   Übersicht. Falls Nummern fehlen, in der Browser-Konsole als Philipp:
   `fetch('/api/admin/backfill-ordinals',{method:'POST',credentials:'same-origin'}).then(r=>r.json()).then(console.log)`
   → `numbered` sollte ≈ `sequenceLength` sein.
3. **Danach erst der eigentliche Klassifizierungs-Start:** `prepare-sample` auf
   echten Daten (Klassifizierung → „Stichprobe vorbereiten", nur Philipp).

**Offene Punkte:**
- Zwei Design-Entscheidungen warten auf Philipps Urteil (beides Einzeiler):
  Situationstrenner nutzt `data-owner="both"` (Türkis/Rosa-Wechselmuster statt
  einzelner Prüferfarbe); der „Öffnen"-Knopf der Segmentierung ist entfallen,
  das Sprungfeld öffnet per Enter/Verlassen.
- 14 offene Streitfälle in Runden 13–17 warten weiterhin auf Lenas Votes
  (`GET /api/admin/dispute-check?rounds=13-17` zum Nachzählen).
- Validierungs-Split und Optimizer-Neutraining weiterhin nicht ausgeführt
  (Settings-Seite).
- Push-Opt-in beider Geräte + Zustell-Test weiterhin offen.
- LLM-Dritt-Rater ist gebaut, aber noch nie auf echten Daten gelaufen
  (`ANTHROPIC_API_KEY` als Secret nötig).
- Kein PR offen; alles liegt auf `claude/klassifizierung-musterklassen-plplo4`.
- Backlog (kein Auftrag): adaptives Segmentierungstool, Konzept in
  `KONZEPT_Adaptive_Segmentierung.md`.
