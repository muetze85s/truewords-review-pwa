# Herkunft: `sequential-communication-analysis.ts`

Diese Datei ist eine **unveränderte Kopie** aus der Hauptanwendung. Sie wird hier nur
gelesen, damit der Prüfstand exakt dieselbe Segmentierung messen kann, die in der
Hauptanwendung läuft — statt einer Nachbildung.

| | |
|---|---|
| Quell-Repository | `muetze85s/truewords-paaruebersetzer` (privat) |
| Quellpfad | `app/lib/sequential-communication-analysis.ts` |
| Branch | `main` |
| Stand des Branches | `503bf6e30a9453e51f208f798d80e1ed86e24b80` („Remove one-time v58 recovery workflow", 2026-08-09) — entspricht **Sites v58** |
| Letzte Änderung dieser Datei | `7c68376ab4d3518d63faf96d218656aad5d87364` (2026-08-03, „Import Sites version 58") |
| Umfang | 227 Zeilen, 16.353 Bytes |
| SHA-256 | `2ba3692ec9499f793d7f8a721fbe1fa7a1b9a550b73ce818b12d80e2a4180ecd` |

## Regeln für den Umgang

1. **Nicht bearbeiten.** Die Datei ist byte-identisch mit der Quelle und muss es
   bleiben. Wer sie ändert, misst nicht mehr die Hauptanwendung. Die Prüfsumme oben
   ist der Nachweis; `tests/hauptapp-segmentierung.test.mjs` prüft sie bei jedem
   Testlauf.
2. **Keine Rückwirkung.** Aus dem Prüfstand wird nichts in die Hauptanwendung
   zurückgeschrieben. Der Datenfluss ist einseitig.
3. **Aktualisieren** heißt: neu kopieren, Prüfsumme und Commit hier nachtragen,
   Messung wiederholen. Nicht von Hand nachziehen.

## Warum sie eigenständig verwendbar ist

Die Datei enthält **keinen einzigen `import`** — geprüft, keine Next.js-, React- oder
sonstigen Abhängigkeiten. Sie besteht aus Typdefinitionen und reinen Funktionen und
lässt sich damit direkt einbinden: von `wrangler`/esbuild ohnehin, in Node über
`--experimental-strip-types` (die Datei nutzt nur Typannotationen und `as const`,
keine Enums oder Namespaces).

## Was der Prüfstand daraus benutzt

Ausschließlich `segmentCommunicationSituations()`. Die Anpassung unserer
Rundennachrichten auf die erwartete Form `NormalizedMessageEvent` steht in
`hauptapp-segmentierung.mjs` — getrennt von dieser Datei, damit die Kopie unberührt
bleibt.

Die Segmentierung der Hauptanwendung arbeitet mit diesen Vorgaben
(`SITUATION_DEFAULTS`, Zeile 1–6):

| Vorgabe | Wert | Bedeutung |
|---|---|---|
| `inactivityMs` | 15 Minuten | Pause, ab der eine neue Situation beginnt |
| `maxMessages` | 40 | Höchstzahl Nachrichten je Situation |
| `maxOpenMs` | 6 Stunden | Höchstdauer einer Situation |
| `maxCharacters` | 24.000 | Höchstzahl Zeichen je Situation |

Dazu kommt ein ausdrückliches Abschlussmuster (`isExplicitClosureCandidate`, Zeile 58–60),
das eine Situation nach mindestens zwei Nachrichten schließt.
