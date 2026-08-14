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

### PWA (Browser)

Statische Seiten, ausgeliefert vom Worker; Service Worker `sw.js` (Cache-Name
`truewords-review-pwa-server-v35`) precacht Assets und trägt `push`- und
`notificationclick`-Handler. Hauptseiten:

- `login.html` / `account-setup.html` / `reset-password.html` — Zugang
- `review.html` — Prüfstand (Einzelsegmentierung)
- `doppelpruefung.html` + `boundary-pairs.js`/`.css` — Doppelprüfung, Vergleich, Live-F1
- `situation-info.html`, `situation-quiz.html` — Situationskunde
- `upload.html`, `admin.html`, `analysis-import.html` — Betrieb (nur `canUpload`/Philipp)
- `push-settings.html` — Benachrichtigungssteuerung (serverseitig nur Philipp)
- `nav.js`/`nav.css` — persistente Navigation über alle Seiten, rollenbewusst, inkl. `?dataset=`-Schalter

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
- Live-F1 in der Doppelprüfung: nach jeder Annotation Neuberechnung und Anzeige, **ohne** automatische Parameteränderung.
- Persistente Navigation über alle Seiten (mobil/iPad-tauglich).

## Aktueller Fokus

_Stand: 2026-08-14_

**Stand heute:** Deploy #59 ist grün und **live** unter
`https://truewords-review-sync.das-sind-meine.workers.dev` (Health `{"ok":true,…,"storage":"d1"}`).
Umstieg auf `philena-4y` inkl. `?dataset=`-Schalter und Einfrieren von
`philena-2026-pilot-v4-unseen` ist ausgerollt; persistente Navigation und
Live-F1 in der Doppelprüfung ebenso. Web-Push ist serverseitig scharf: alle drei
`VAPID_*`-Secrets sind gesetzt und Migration `0009` ist remote angewandt.
Branch: `claude/segmentation-v5-migration-h0syxc`.

**Morgen zuerst — Push wirklich zustellen (einziges offenes Gate):** Push kommt
erst an, wenn **jedes Gerät einmal opt-in** gemacht hat. Philipp **und** Lena
öffnen `/doppelpruefung.html` und tippen in der Leiste (`push-enable.js`)
„Benachrichtigungen auf diesem Gerät erlauben". Danach verifizieren:
Lena gibt eine Runde ab → Philipp muss den Sofort-Hinweis bekommen
(`maybeNotifyOnSubmit` in `src/worker-push.ts`). Kontrolle je Gerät auf
`/push-settings.html` (nur Philipp, zeigt ✓/✕). Erinnerungen laufen über den
15-Min-Cron (`runScheduled`), Zeiten/Schwelle dort einstellbar.

**Offene Punkte:**
- Push-Opt-in beider Geräte + Zustell-Test (s. o.) — noch nicht erfolgt.
- Live-F1 nur auf abgeschlossenen (beidseitig abgegebenen) Runden belastbar; bei
  < 40 gemeinsamen Grenzen bleibt die Zahl volatil (`lowData`-Hinweis).
- `?dataset=`-Wechsel ist rein additiv gedacht — beim Testen der Live-Umschaltung
  darauf achten, dass `philena-2026` als eingefroren keine neuen Runden zieht.
- Kein PR offen; Arbeit liegt auf dem Feature-Branch. PR bei Bedarf noch anlegen.
