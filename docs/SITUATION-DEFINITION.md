# TrueWords: verbindliche Definition einer Situation

Status: verbindliche Arbeitsdefinition für Segmentierung, Prüfstand und spätere TrueWords-Analyse ab Test 4.

## Kurzdefinition

> **Situation = Konversation.**

Eine Situation ist eine **zusammenhängende Konversation zwischen den Partnern**. Sie bildet einen chronologisch zusammenhängenden Kommunikationsabschnitt. Ein übergeordnetes Gespräch kann sich über mehrere Konversationen beziehungsweise Situationen erstrecken.

## Begriffe

- **Gespräch** = übergeordneter Kommunikationsverlauf. Er kann mehrere Konversationen umfassen und später wieder aufgegriffen werden.
- **Situation / Konversation** = ein zusammenhängender konkreter Kommunikationsabschnitt.
- **Thema** = worüber innerhalb einer oder mehrerer Konversationen gesprochen wird.
- **Muster/Ereignis** = kommunikative Dynamik innerhalb einer Situation, zum Beispiel Rechtfertigung, Rückzug, Gegenkritik, Reparatur oder Annäherung.

## Was daraus folgt

- Eine Situation kann mehrere Themen enthalten.
- Ein Themenwechsel allein erzeugt keine neue Situation.
- Dasselbe Thema kann in mehreren Situationen vorkommen.
- Eine Zeitpause allein erzeugt **niemals** eine neue Situation.
- Eine Situation kann über Stunden oder über Nacht laufen, wenn dieselbe Konversation wegen Arbeit, Schlaf, Zeitverschiebung oder anderer Verfügbarkeit nur verzögert fortgesetzt wird.
- Eine direkte Antwort auf eine noch offene Frage kann deshalb auch nach mehreren Stunden zur selben Situation gehören.
- Eine neue Situation beginnt, wenn eine **neue eigenständige Konversation** eröffnet wird: zum Beispiel nach erkennbarem Abschluss, durch einen neuen Kontaktversuch oder durch einen klaren neuen Gesprächseinstieg.
- Ein späterer Reply oder Rückbezug kann Situationen miteinander verbinden. Er darf eine bereits beendete Situation aber nicht über eine dazwischenliegende andere Situation hinweg wieder öffnen.
- Jede Situation bleibt ein zusammenhängender chronologischer Bereich. Konstruktionen wie `4,4,4,6,4,4` sind unzulässig.

## Asynchrone Kommunikation

Zeitabstände sind nur Indizien. Beispiel:

08:00 Lena: „Kannst du heute beim Vermieter anrufen?“  
12:00 Philipp: „Ja, mache ich in der Mittagspause.“  
16:00 Lena: „Hat es geklappt?“  
20:00 Philipp: „Ja, Termin ist Donnerstag.“

**Ergebnis: eine Situation.** Die Antworten kommen jeweils vier Stunden später, aber die Konversation bleibt dieselbe.

## Neue Konversation trotz gleichem Gespräch

Eine frühere Konversation kann später aufgegriffen werden:

Situation 1: abendlicher Kontaktversuch und offene Frage.  
Situation 2: später beginnt eine neue eigenständige Konversation und nimmt einen Punkt von Situation 1 wieder auf.

**Ergebnis: zwei Situationen mit Rückbezug.** Der Bezug verbindet die Situationen, verschmilzt sie aber nicht.

## Operative Grenzregel

Die Prüffrage lautet:

> **„Ist das noch dieselbe Konversation – oder beginnt hier eine neue?“**

Gemeinsam betrachtet werden:

1. direkte Antworten und Reply-Bezüge,
2. noch offene Fragen oder kommunikative Aufgaben,
3. erkennbare Abschlüsse oder Abbrüche,
4. neue Kontaktversuche und klare neue Gesprächseinstiege,
5. zeitliche Abstände ausschließlich als unterstützendes Indiz.

**Nicht als alleinige Grenzregel verwenden:** Zeitpause, Tageswechsel, Themenwechsel oder eine feste Anzahl Minuten/Stunden.

## TrueWords-Segmentierungsalgorithmus V4

Test 4 setzt diese Definition erstmals direkt als Algorithmusregel um:

- `timeGapAloneCreatesBoundary = false`
- direkte Replies halten die aktuelle Konversation offen,
- offene Fragen dürfen lange Antwortpausen überstehen,
- neue Kontaktversuche und explizite Abschlüsse können Grenzen auslösen,
- Rückbezüge dürfen bereits beendete Situationen nicht nicht-kontiguierlich wieder öffnen,
- externe Sprach-KI erzeugt keine Situationsgrenzen.

Test 4 verwendet einen neuen, zuvor ungeprüften Ereignisbereich nach Test 3. Seine manuelle Prüfung erzeugt den nächsten Goldstandard. Test 3 bleibt unverändert als eigener Validierungsstand erhalten.
