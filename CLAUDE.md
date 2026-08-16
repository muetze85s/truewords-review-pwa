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
- **Abhängigkeiten:** `embla-carousel` 8.6 (Karussell). Dev: `@cloudflare/workers-types`, `@playwright/test`, `typescript`, `wrangler`.
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

### PWA (Browser)

Statische Seiten, ausgeliefert vom Worker; Service Worker `sw.js` (Cache-Name
`truewords-review-pwa-server-v39`) precacht Assets und trägt `push`- und
`notificationclick`-Handler. **Fetch-Strategie ist Stale-while-revalidate**
(Cache antwortet sofort, holt aber immer parallel eine frische Kopie nach) —
bei künftigen Deploys muss die Cache-Version **nicht mehr** manuell erhöht
werden, damit Änderungen ankommen. Hauptseiten:

- `login.html` / `account-setup.html` / `reset-password.html` — Zugang
- `review.html` — Prüfstand (Einzelsegmentierung)
- `doppelpruefung.html` + `boundary-pairs.js`/`.css` — Doppelprüfung, Vergleich, Live-F1, Übersicht als responsives Div-Grid (kein `<table>`, kein horizontales Scrollen auf Mobile)
- `situation-info.html`, `situation-quiz.html` — Situationskunde (nicht mehr im aktiven Login-Flow, Login springt direkt auf die Übersicht)
- `upload.html`, `admin.html`, `analysis-import.html` — Betrieb (nur `canUpload`/Philipp)
- `push-settings.html` — Settings, 4 Abschnitte: Gerät-Einstellungen, Push-Benachrichtigungen (zwei symmetrische Module Philipp/Lena), Optimierung (Schwellwert-Optimizer-Verlauf + „Neu trainieren"), Datenbank (`?dataset=`-Schalter)
- `nav.js`/`nav.css` — persistente Navigation über alle Seiten (TrueWords | Übersicht | Prüfstand | Doppelprüfung | Upload | Settings), rollenbewusst; **kein** Dataset-Schalter mehr im Kopfbalken — der lebt ausschließlich auf der Settings-Seite

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

_Stand: 2026-08-16 · 03:35_

**Stand heute:** Zwei Etappen, beide deployed und grün. Letzter Commit
`11db6f5`, Branch `claude/segmentation-v5-migration-h0syxc`, kein PR offen,
Arbeitsverzeichnis sauber.

1. **F0/F1/GT-Nomenklatur + Übersicht-Redesign + Prüfstand-Link entfernt**
   (`9e9b596`): Backend und Frontend einheitlich auf F0 (rohe Übereinstimmung
   Philipp/Lena), GT (kombinierte Grenzenmenge aus F0 + geklärten
   Streitfällen) und F1 (Algorithmus vs. GT) umgestellt. Übersichtsseite neu:
   Spalten `Runde|Philipp|Lena|F0|Streitfälle|GT|F1` mit gepoolten Ø/Σ-
   Aggregaten in den Köpfen, „öffnen"-Spalte weg — ganze Zeile/Karte ist
   jetzt Desktop **und** Mobile klickbar. Dabei einen echten Bug gefunden:
   das Live-F1-Panel in der Doppelprüfung war in einer früheren Session
   komplett aus dem HTML gelöscht (nicht nur der Platzhaltertext) — der JS-
   Code lief seither ins Leere. Wiederhergestellt mit den neuen Feldnamen.
   „Prüfstand" aus `nav.js` entfernt (einzige Fundstelle im Repo);
   `review.html` selbst bleibt voll funktionsfähig und ist weiterhin die
   Redirect-Zielseite für Nutzer ohne Upload-Recht in `upload.js` — bewusst
   nicht angetastet.
2. **Eigenes Home-Screen-Icon für review.html** (`11db6f5`): echtes
   TrueWords-Logo (Türkis/Rosa-Sprechblasen) aus `truewords-paaruebersetzer`
   übernommen als `icon-pruefstand-192.png`/`-512.png`, `apple-touch-icon` +
   neuer `apple-mobile-web-app-title`-Tag „TW - Prüfstand" in `review.html`.
   Restliche Seiten/Manifest bewusst unverändert (bleiben „TW Prüfung").

**Noch unverifiziert (von Philipp/Lena):**
- Übersicht-Redesign (F0/Streitfälle/GT/F1-Spalten, ganze Zeile klickbar) —
  auf echten Geräten (Desktop + iPhone + iPad) noch nicht bestätigt.
- Neues Prüfstand-Icon — noch nicht frisch zum Home-Bildschirm hinzugefügt
  und gegen das bestehende „TW Prüfung"-Icon auf Konflikte geprüft.

**Morgen zuerst:**
1. Rückmeldung von Philipp zu den beiden obigen Punkten einholen bzw.
   nachfragen, falls noch nichts getestet wurde.
2. **Optimizer neu trainieren** — auf der Settings-Seite „Neu trainieren"
   klicken. Alle bisherigen `segment_optimizer_runs`-Einträge liefen mit der
   falschen Toleranz (0 statt 1, `parseTolerance`-Bug vom 15.08.) und sind
   damit nicht mehr aussagekräftig. Steht seit gestern aus.
3. Push-Opt-in beider Geräte + Zustell-Test steht weiterhin aus (siehe unten).

**Offene Punkte:**
- Optimizer-Neutraining ausstehend (s. o.).
- Push-Opt-in beider Geräte + Zustell-Test — noch nicht erfolgt (Philipp:
  Home-Screen-Icon neu anlegen → Benachrichtigungen erlauben; Lena:
  dasselbe auf ihrem iPad; dann wechselseitig eine Runde abgeben und
  prüfen, ob die Benachrichtigung ankommt — beide Richtungen einzeln
  an-/abschaltbar auf der Settings-Seite).
- Playwright-Visual-Snapshots (`tests/visual/boundary-pairs.visual.spec.mjs`)
  brauchen nach den UI-Umbauten ein `--update-snapshots` — nicht Teil des
  Deploy-Gates (`npm run check`), daher unkritisch.
- Live-F1 nur auf abgeschlossenen Runden belastbar; bei < 40 gemeinsamen
  Grenzen volatil.
