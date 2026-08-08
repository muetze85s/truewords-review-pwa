# TrueWords Review V2 – verbindliche Interaktionsregeln

Stand: 2026-08-08

## 1. Situation

Die endgültige fachliche Definition wird nach Lenas Situations-Quiz festgeschrieben. Für die UI gilt bereits: Eine Situation ist ein zusammenhängender Abschnitt; gestückelte/nicht zusammenhängende Situationen werden nicht unterstützt.

## 2. Timeline-Grundmodell

- Links: Situationsliste.
- Rechts: kompletter für den jeweiligen Test freigegebener Chatverlauf, durchgehend scrollbar.
- Es wird nicht mehr nur eine einzelne Situation plus Kontext gerendert.
- Inaktive Situationen zeigen nur Kerninformationen.
- Aktive Situationen erweitern sich und zeigen präzisere Metadaten und Analysefelder.

## 3. Umschalten beim Scrollen

- Scrollrichtung nach unten: Sobald die erste Nachricht der nächsten Situation die aktive Scrollposition erreicht, wird diese Situation aktiv.
- Scrollrichtung nach oben: Sobald die letzte Nachricht der vorherigen Situation die aktive Scrollposition erreicht, wird diese Situation aktiv.
- Klick auf eine Situation in der Liste: Chat springt zur ersten Nachricht dieser Situation.
- Die aktive Situation wird in Liste, Kopfzeile/Slidebar und Chat synchron gehalten.

## 4. Bezeichnung und Zeit

Inaktiv:

```text
2   ✓                    16 Nachr.
Philipp                   01.05.
```

Aktiv:

```text
2   ✓ bestätigt          16 Nachr.
Philipp                   01.05.
12:41 – 14:22

Klassifizierung …
Richtung …
Muster …
…
```

- Kein wiederholtes „Test 3“ in Situationen oder Sprechblasen.
- Aktive Situation zeigt Start- und Enduhrzeit.

## 5. Erweiterbare Analysefelder

Aktive Situationen sind für beliebig erweiterbare, später korrigierbare Analysefelder vorbereitet, insbesondere:

- Klassifizierung
- Richtung
- Muster
- Themen
- Ausgangsanliegen
- Verlauf
- Ergebnis
- Reparatur
- Sicherheit
- zukünftige weitere Felder ohne Umbau der Karte

## 6. Farben

Farbschema wird später separat festgelegt. Die Interaktionsstruktur darf davon nicht abhängen.

## 7. Neue Situation

- Klick auf eine Nachricht macht die Aktion „Neue Situation ab hier“ sichtbar.
- Beim Auslösen wird die aktuelle zusammenhängende Situation an dieser Nachricht geteilt.
- Temporäre Nummerierung: bestehende Situationsnummer + Buchstabe, z. B. `2A`.
- Wenn weitere temporäre Teilungen derselben Stammnummer nötig werden, werden freie Buchstaben fortlaufend genutzt (`2B`, `2C`, …).
- Endgültige fortlaufende Nummerierung erst nach Abschluss der Prüfung.

## 8. Keine freie Nachrichtenzuordnung

Eine generische Funktion „Nachricht einer beliebigen Situation zuordnen“ wird nicht gebaut. Da Situationen zusammenhängend sein müssen, werden Korrekturen über Grenzen, Teilen und gegebenenfalls Zusammenführen vorgenommen.

## 9. Boundary-Fokus

- Anfang verschieben: neue erste Nachricht bleibt oben im Fokus.
- Ende verschieben: neue letzte Nachricht bleibt unten im Fokus.
- Kein automatisches Zurückspringen zum Situationsanfang.

## 10. Bestätigen / wieder öffnen

- `offen → bestätigt`
- erneute Bestätigungskontrolle: `bestätigt → offen`
- nach inhaltlicher Korrektur kann `korrigiert` verwendet werden.
- Erledigte Situationen bleiben an ihrer chronologischen Position.

## 11. Chatdarstellung

- Vollständiger freigegebener Chat bleibt sichtbar und scrollbar.
- Aktive Situation wird deutlich hervorgehoben.
- Inaktive Situationen bleiben sichtbar, aber visuell zurückgenommen.
- Personenfarben bleiben unabhängig vom Prüfer stabil; genaue Farben werden später festgelegt.

## 12. Mobil

- Keine nebeneinander gequetschte Liste und Chatspalte.
- Chat nutzt die normale volle Breite.
- Kopfzeile zeigt im eingeblendeten Zustand die wichtigsten Informationen zur aktuellen Situation.
- Beim Herunterscrollen kann die Kopfzeile automatisch ausblenden.
- Im ausgeblendeten Zustand bleibt ganz oben eine kompakte horizontal scrollbare Situations-Slidebar sichtbar.
- Wischen/Scrollen oder Auswahl in der Slidebar navigiert zwischen Situationen; der Chat scrollt synchron zur ausgewählten Situation.
- Bestätigung einer Situation steht am Ende ihrer letzten Nachricht.

## 13. Technische Basis

Bestehende Authentifizierung, D1, Rohchat, Testfilter, Revisionen, Audit, Prüferzuordnung und Server-Synchronisation bleiben erhalten. Review V2 ersetzt später nur die bisherige Prüf- und Zuordnungsoberfläche.
