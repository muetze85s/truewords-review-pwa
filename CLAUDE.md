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

**Links immer im Code-Fenster ausgeben.** Jede URL, die Philipp oder Lena
anklicken oder kopieren sollen, steht in einem eigenen Markdown-Codeblock —
nie als Fließtext-Link, nie als eingebettete Verlinkung. Auf dem iPad lässt
sich Fließtext nicht zuverlässig markieren, ein Codeblock dagegen mit einem
Tipp kopieren. Immer die **vollständige** Adresse inklusive
`https://truewords-review-sync.das-sind-meine.workers.dev`, nie nur der Pfad —
ein relativer Pfad ist auf dem Gerät nicht aufrufbar.

    ```
    https://truewords-review-sync.das-sind-meine.workers.dev/api/admin/segment-diagnose
    ```

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

_Stand: 2026-08-20_

**Stand heute:** Alles live — letzter Deploy `bf99ae8` (GitHub Actions Runs
#98–#106 sämtlich grün, inkl. D1-Migration 0017). Branch
`claude/klassifizierung-musterklassen-plplo4`, Arbeitsverzeichnis sauber,
lokal = origin, kein PR. Der Tag: Handoff-Blöcke 1+2 komplett, dazu die
Analyse-Infrastruktur (Diagnose-/Mischverteilungs-/Tagesrhythmus-Seiten und
die vorberechneten öffentlichen Aggregat-Routen).

1. **B1.2:** Playwright-Visual-Snapshots ersatzlos entfernt (`292b178`) —
   `tests/visual/`, Config, Workflow, devDependency; kein nicht-visueller
   Playwright-Test blieb übrig.
2. **B1.1 Hauptschalter** (`217228c`, `3dbcaf2`): Befund war „es gibt keinen" —
   „Benachrichtigungen X aktiv" schaltete nur die Cron-Erinnerung, der Test
   umging alles. Nach Philipps Entscheid: Migration `0017`
   (`push_enabled_philipp`/`_lena`), genau EINE Durchsetzung in
   `notifyReviewer` (Gate `pushAllowedFor`), Test läuft durch dieselbe
   Funktion (`sent:false` + Grund bei „aus"), Dedup erst nach erfolgreicher
   Zustellung, dritter Erinnerungs-Schalter entfällt (leere Zeit = aus, die
   Migration leerte die Zeiten der Abgeschalteten), Testknopf mit Begründung
   gesperrt. Tests in `tests/push-send` für alle vier Anlässe an/aus.
3. **B2 vollständig beantwortet** (Endpunkt `63663b9`, lesbare Seite
   `9ce097e`): **Antwort A — Annotationslücke.** `prepare-sample` →
   `combinedBoundaryForRound` (nur menschliche Marks + Auflösungen),
   `deriveSituations` reiner Positions-Split; `segmentConversationWindow` nur
   in Anzeige-/Optimizer-Pfaden. **Zahlen (Live-D1):** 273 Situationen, 144
   (52,7 %) mit interner Lücke > 60 min, 37 (13,6 %) > 180 min; Stichprobe
   praktisch identisch (52,8 %/15,6 %). Segmentlängen Median 8 Nachrichten /
   2 h 02; Abstände zwischen Segmenten Median 5 h 24, > 6 h 44,6 %, > 12 h
   15,0 %, > 24 h 4,3 %, > 72 h 2,1 % (233 Übergänge). **Kernschluss:** die
   Verteilungen „innerhalb" und „zwischen" überlappen massiv — keine
   Zeitschwelle kann trennen; Beleg für die Vorgangsebene. Situation 69 =
   Runde 11/Index 1, Grenzen 66639–66642: 3× Philipp 22:12, Lena-Anruf 23:44
   (1 h 31), alle Nähte ohne Markierung/Auflösung. Anrufe: mitgezählt, kein
   Auto-Grenzsignal, nicht verworfen (`isService`/`isCallAction`). Achtung:
   Klassifizierungs-UI nummeriert anders als die DB-IDs — Einheiten über
   Runde+Index oder Diagnose-ID benennen.
4. **Analyse-Seiten + öffentliche Aggregat-Routen** (`31781c2` … `bf99ae8`):
   `GET /api/admin/segment-diagnose` (Lückenverteilung, 2.3, Drill-down je
   Situation mit Naht-Status), `GET /api/admin/gap-mixture` (GMM k=1–4 über
   log₁₀(Δt), BIC, Grenzen, 60-Bin-Histogramm, je Kalenderjahr; Modul
   `gap-mixture.mjs` + Tests; CPU-Fix: relative Konvergenz, `?scope=`/`?year=`)
   und Tagesrhythmus (`daily-rhythm.mjs` + Tests: Nachrichten/Stunde je
   Sender, Pausen-Startstunden 1–4/4–12/>12 h, Europe/Berlin inkl.
   Sommerzeit). Der Admin-Aufruf legt das kanonische Ergebnis in
   `app_settings` (`gap_mixture_result:<dataset>`) ab;
   `GET /api/public/gap-mixture` und `GET /api/public/hourly` liefern OHNE
   Login nur dieses gespeicherte Dokument (reine Aggregate, <1 s, nie live
   rechnen; 503 mit Anleitung solange leer). Öffentlich = bewusste
   Entscheidung Philipps; ?key= wäre bei öffentlichem Repo Scheinsicherheit.
5. **Neue verbindliche Konventionen** (oben verankert): Auswertungen als
   lesbare Seiten statt JSON (`diagnosePage()`-Muster); Links immer
   vollständig im Markdown-Codeblock.

**Morgen zuerst:**
1. **Ablage füllen + Zahlen ansehen:** Als Philipp einmal
   `/api/admin/gap-mixture` aufrufen (rechnet neu und persistiert, danach
   liefern `/api/public/gap-mixture` und `/api/public/hourly` sofort).
   Interessant: bestes k nach BIC, Lage der Entscheidungsgrenzen, ob sie über
   die Jahre wandern, Tagesrhythmus-Tabelle (Nachtstunden sollten bei
   >12-h-Pausen dominieren).
2. **Block-2-Freigabe entscheiden.** Danach — und erst danach — Block 3
   (Vorgangsebene, Handoff 2026-08-20): additive Migration `review_cases`/
   `review_case_members` (Muster 0008/0013), Verkettungs-Ansicht in
   lückenloser Ordinal-Reihenfolge, Blind-Teilmenge ~40 Segmente, Ziehung auf
   Blockebene. Für die 3.2-Entscheidungen liegen die Zahlen vor: Schwelle
   < 12 h zerschnitte die Über-Nacht-Brücken (15 %), Woche wirkungslos
   (2,1 %); ~3 Segmente/Tag → Kalenderwoche ≈ 20 Segmente, 40er-Teilmenge ≈
   2 Wochenblöcke. Beide Fragen bleiben Philipps Entscheid, notfalls als
   Konfigurationswert anlegen und melden.

**Offene Punkte:**
- Block 3 GESPERRT bis Philipps Freigabe der Block-2-Diagnose.
- Hauptschalter-Zustelltest auf echten Geräten (aus → Testknopf gesperrt,
  direkter POST liefert `sent:false`; an + Gerät → Test kommt an).
- Situation 42 (Runde 6) = 100 Nachrichten ohne einzigen Schnitt (Lücke
  9 h 05) — größter Annotationslücken-Fall, bei Gelegenheit ansehen.
- 14 offene Streitfälle in Runden 13–17 warten auf Lenas Votes.
- Validierungs-Split + Optimizer-Neutraining nicht ausgeführt (Settings).
- Push-Opt-in beider Geräte + Zustell-Test weiterhin offen.
- LLM-Dritt-Rater nie auf echten Daten gelaufen (`ANTHROPIC_API_KEY` nötig).
- Kein PR offen; alles auf `claude/klassifizierung-musterklassen-plplo4`.
- Backlog (kein Auftrag): adaptives Segmentierungstool
  (`KONZEPT_Adaptive_Segmentierung.md`).
