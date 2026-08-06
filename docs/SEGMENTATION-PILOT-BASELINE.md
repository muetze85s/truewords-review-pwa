# Segmentierungs-Pilot – nachvollziehbare Baseline

## Zweck

Diese Baseline dokumentiert die lokale Vorselektion, die für den ersten Kalibrierungstest erzeugt wurde. Sie ist kein fertiger Algorithmus und keine Beziehungsanalyse. Sie erzeugt ausschließlich Vorschläge für Grenzen zwischen Gesprächssituationen.

## Pilotumfang

- Datenbasis: Telegram-Chat, Kalenderjahr 2026
- Sichtbare Nachrichten nach Bereinigung: 1.953
- Verwendetes Kalibrierungsfenster: erste 250 sichtbare Nachrichten
- Erzeugte Vorschläge: 29 Situationen
- Externe Modellaufrufe: keine
- Methode: Zeitabstände, Antwortbezüge und lokale TF-IDF-Themenwechsel
- Grenzschwelle: Score >= 2,8

## Bereinigung vor der Segmentierung

Ausgeschlossen wurden:

- Service-Ereignisse
- weitergeleitete Nachrichten
- Sticker
- Medien ohne Text
- leere Nachrichten
- Nachrichten, die ausschließlich aus einem Link bestehen

Nachrichten mit Text und zusätzlichem Medium blieben erhalten.

## Grenzscore

Zwischen jeweils zwei aufeinanderfolgenden sichtbaren Nachrichten wurde ein Score gebildet.

### Zeitabstand – genau eine Stufe

| Abstand | Punkte |
|---|---:|
| mehr als 2 Stunden | +2,0 |
| mehr als 4 Stunden | +3,0 |
| mehr als 12 Stunden | +4,0 |
| mehr als 24 Stunden | +5,0 |

Die höchste passende Stufe wurde verwendet; die Werte wurden nicht addiert.

### Themenwechsel aus lokaler TF-IDF-Ähnlichkeit

| Einstufung | Punkte |
|---|---:|
| leichter Themenwechsel | +0,4 |
| deutlicher Themenwechsel | +0,8 |
| starker Themenwechsel | +1,2 |

Die konkreten Cosinus-Schwellen der drei Stufen wurden im Pilotexport nicht gespeichert. Sie dürfen daher nicht nachträglich als vermeintlich exakte Werte ausgegeben werden und müssen im nächsten reproduzierbaren Lauf ausdrücklich versioniert werden.

### Weitere Signale

| Signal | Punkte |
|---|---:|
| erkennbarer neuer Gesprächseinstieg | +0,5 |
| Antwortbezug spricht gegen eine Trennung | -1,0 |
| sehr kurze Nachricht | -0,5 |

Die erste Nachricht des Kalibrierungsfensters begann immer Situation 1.

## Entscheidung und Konfidenz

- Grenze vorgeschlagen ab Score 2,8
- niedrige Konfidenz: 2,8 bis 3,4
- mittlere Konfidenz: 3,5 bis 4,9
- hohe Konfidenz: ab 5,0

Diese Bereiche lassen sich vollständig aus den gespeicherten Pilotbegründungen und Scores rekonstruieren.

## Bewertung der Baseline

Stärken:

- transparent und sehr günstig
- gut nachvollziehbare Zeitkomponente
- Reply-Bezüge verhindern einige offensichtliche Fehltrennungen
- manuell korrigierbare Vorschläge statt automatischer Festlegung

Bekannte Schwächen:

- lange Zeitlücken dominieren den Score stark
- kurze Pausen mit echtem Themenwechsel können übersehen werden
- lange Gespräche mit mehreren Themen können fälschlich zusammenbleiben
- TF-IDF erkennt Wortwechsel besser als semantisch gleiche Themen mit anderem Wortlaut
- sehr kurze Antworten können sowohl Abschluss als auch Fortsetzung sein
- kein mehrstufiger Kontext vor und nach einer möglichen Grenze
- keine explizite Modellierung von Gesprächsphasen, Reparaturen oder Rückbezügen

## Verbindliche Weiterentwicklung

Der nächste Algorithmus soll diese Baseline nicht ersetzen, sondern als Version `heuristic-v1` reproduzierbar implementieren. Jede Erweiterung erhält eine eigene Version und wird gegen manuell bestätigte Grenzen verglichen.

Vorgesehene zusätzliche Merkmale:

- Reply-Graph über mehrere Nachrichten
- Sprecherwechsel und Turn-Sequenzen
- lokale Fenster vor und nach der Grenze
- Tageswechsel getrennt vom reinen Zeitabstand
- Gruß-, Abschluss- und Wiedereinstiegssignale
- semantische Ähnlichkeit als eigene, versionierte Stufe
- Split-, Merge- und Grenzverschiebungen aus der manuellen Prüfung
- getrennte Kennzahlen für Präzision, Recall und Grenzabweichung

Rohchat, Algorithmusversionen, Vorschläge und manuelle Korrekturen bleiben getrennt gespeichert.