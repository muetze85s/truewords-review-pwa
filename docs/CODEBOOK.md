# Kodierhandbuch — Musterklassen (Klassifizierungsstufe)

**Kodierhandbuchversion: 1**
**Stand: 2026-08-18**

Verbindliche Referenz für die blinde Doppelklassifizierung von Situationen
(Philipp, Lena) und — mit **identischem** Wortlaut — für den LLM-Dritt-Rater
(Phase 2). Dieselbe Datei speist auch die UI-Tooltips auf `klassifizierung.html`
und die Nachschlage-Seite `klassifizierung-info.html`. Eine Quelle, mehrere
Verwendungen — es darf keine abweichende Definition an anderer Stelle geben.

## Versionierungs-Disziplin

Ändert sich später eine Definition, wird die **Version hochgezählt** und die
Änderung hier vermerkt. Alte Annotationen bleiben der Version zugeordnet, unter
der sie entstanden sind (analog zur `detector_version`-Idee der Hauptapp). Die
aktuelle Version steht in `classification-classes.mjs` als `CODEBOOK_VERSION`
und wird bei jeder Klassifizierung mitgeschrieben (Feld `codebook_version` in
`review_classification_marks`).

## Kodierregel (gilt für alle Klassen)

- **Binär pro Situation:** Jede Klasse ist ein klares Ja/Nein für die gesamte
  Situation. Mehrere Klassen können gleichzeitig zutreffen.
- **Nur am Text erkennbar:** Markiert wird nur, was aus dem geschriebenen Text
  hervorgeht — kein vermuteter Tonfall, keine Kenntnis über die Personen.
- **Im Zweifel die Abgrenzung lesen:** Bei Verwechslungsgefahr entscheidet der
  Abschnitt „Abgrenzung" der jeweiligen Klasse, nicht das Bauchgefühl.
- **Blind:** Jeder markiert unabhängig; die Markierung der anderen Person wird
  erst nach eigener Abgabe sichtbar.

---

## Risikomuster

### `countercriticism_before_addressing_concern` — Gegenkritik vor Bearbeitung des Anliegens
**Definition:** Auf eine Beschwerde/ein Anliegen wird zuerst mit einem eigenen Vorwurf geantwortet, bevor auf das ursprüngliche Anliegen überhaupt eingegangen wird.
**Beispiel:** A: „Du hast gestern nicht angerufen, obwohl du's versprochen hattest." B: „Du rufst aber auch nicht immer pünktlich an."
**Grenzfall (zählt nicht):** B antwortet zuerst auf A's Anliegen („Stimmt, tut mir leid") und bringt danach, in einem späteren Teil des Gesprächs, einen eigenen Punkt ein — das ist keine Gegenkritik *vor* Bearbeitung, sondern ein späterer eigener Beitrag.
**Abgrenzung zu `criticism_justification_loop`:** Hier geht es um die Reihenfolge (Gegenkritik kommt zuerst, verdrängt die Antwort). Die Schleife ist ein wiederholtes Muster über mehrere Runden, nicht ein einzelner Reihenfolgefehler.

### `previous_issue_used_to_displace_current_issue` — Aufrechnen
**Definition:** Ein altes, eigentlich abgeschlossenes oder unabhängiges Thema wird herangezogen, um vom aktuellen Anliegen abzulenken oder es zu relativieren.
**Beispiel:** A: „Mich stört, dass du das Geschirr stehen lässt." B: „Und was ist mit letztem Monat, als du den Urlaub vergeigt hast?"
**Grenzfall (zählt nicht):** Das „alte Thema" ist inhaltlich direkt mit dem aktuellen verknüpft (gleiche Sache, nicht nur zeitlich früher) — das wäre dann eher `topic_shift` oder gar keine eigene Kategorie, sondern legitime Fortsetzung desselben Themas.
**Abgrenzung zu `whataboutism_candidate`:** Aufrechnen bezieht sich auf ein *anderes, vergangenes* Ereignis. Whataboutism muss nicht vergangenheitsbezogen sein — kann auch ein allgemeiner Gegenvorwurf ohne konkretes Ereignis sein.

### `whataboutism_candidate` — Whataboutism
**Definition:** Statt sich mit dem Vorwurf auseinanderzusetzen, wird ein Gegenvorwurf an die andere Person gerichtet, der das ursprüngliche Thema nicht behandelt, sondern es „zurückspielt".
**Beispiel:** A: „Du hörst mir beim Reden oft nicht richtig zu." B: „Du guckst aber auch ständig aufs Handy, wenn ich rede."
**Grenzfall (zählt nicht):** B stimmt zunächst zu und bringt den Gegenpunkt als eigenständige, spätere Beobachtung, nicht als Abwehrreaktion — Position im Gespräch entscheidet, nicht nur der Inhalt der Aussage.
**Hinweis:** Am ehesten verwechselbar mit `previous_issue_used_to_displace_current_issue` — falls unsicher, tendenziell hier ansetzen, wenn kein konkretes vergangenes Ereignis benannt wird, sondern ein allgemeiner Gegenvorwurf.

### `topic_shift` — Themenwechsel
**Definition:** Das Gespräch bewegt sich vom ursprünglichen Anliegen weg zu einem anderen Thema, ohne dass das ursprüngliche Anliegen als geklärt markiert wurde.
**Beispiel:** Gespräch beginnt bei „du kommst oft zu spät", wandert nach ein paar Nachrichten zu einem anderen Thema (z. B. Wochenendplanung), ohne dass die Verspätungsfrage aufgelöst wurde.
**Grenzfall (zählt nicht):** Ein Thema wird bewusst und einvernehmlich vertagt („lass uns das später besprechen, gerade ist wichtiger…") — das ist Selbstregulation, kein unkontrollierter Themenwechsel.
**Abgrenzung zu `problem_mixing`:** Hier verschwindet Thema A und wird durch Thema B ersetzt. Bei Problemvermischung bleiben beide Themen gleichzeitig im selben Gesprächsabschnitt vermengt.

### `problem_mixing` — Problemvermischung
**Definition:** Mehrere unterschiedliche Konfliktpunkte werden im selben Gesprächsabschnitt gleichzeitig verhandelt, sodass keiner davon einzeln zu Ende besprochen wird.
**Beispiel:** Eine Nachricht enthält gleichzeitig Vorwürfe zu Pünktlichkeit, Haushalt und einer Wortwahl von letzter Woche.
**Grenzfall (zählt nicht):** Zwei Themen werden nacheinander, aber jeweils einzeln abgeschlossen, besprochen — das ist Reihung, keine Vermischung.
**Abgrenzung zu `topic_shift`:** Mixing ist gleichzeitig, Shift ist nacheinander mit Verdrängung.

### `responsibility_shift` — Verantwortungsverschiebung
**Definition:** Die Verantwortung für das eigene Verhalten wird der anderen Person, äußeren Umständen oder einer dritten Partei zugeschrieben, statt sie zu übernehmen.
**Beispiel:** „Ich war nur genervt, weil du mich vorher schon so angegangen bist." (eigenes Fehlverhalten wird als Reaktion auf B dargestellt)
**Grenzfall (zählt nicht):** Eine sachliche Erklärung der Umstände, ohne die eigene Verantwortung dabei zu leugnen („Ich war spät dran, weil die Bahn ausgefallen ist" bei einem reinen Verspätungsvorwurf ohne vorherige eigene Schuldzuweisung) — Kontext liefern ist nicht automatisch Verschiebung.
**Abgrenzung zu `impact_relativized`:** Hier geht es um die *Ursache* des eigenen Verhaltens. Bei Relativierung geht es um die *Wirkung* auf die andere Person.

### `impact_relativized` — Wirkung relativiert
**Definition:** Die Wirkung des eigenen Verhaltens auf die andere Person wird kleingeredet oder infrage gestellt, statt anerkannt.
**Beispiel:** A: „Das hat mich wirklich verletzt." B: „Ach komm, das war doch nicht so schlimm gemeint."
**Grenzfall (zählt nicht):** B fragt nach, ohne die Wirkung zu bestreiten („Das wusste ich nicht, kannst du mir sagen, was genau daran wehgetan hat?") — Nachfrage ist keine Relativierung.

### `intent_attribution` — Absichtsunterstellung
**Definition:** Der anderen Person wird eine bestimmte (meist negative) Absicht hinter ihrem Verhalten unterstellt, ohne dass diese das selbst geäußert hat.
**Beispiel:** „Du machst das doch nur, um mich zu ärgern."
**Grenzfall (zählt nicht):** Eine Vermutung wird als Frage formuliert und offen gelassen („Wolltest du mich damit ärgern?") — das eröffnet Klärung, statt sie als Fakt zu setzen. Tendenziell eher nicht markieren, wenn erkennbar als echte Frage gemeint.
**Abgrenzung zu `responsibility_shift`:** Hier wird der *anderen Person* eine Absicht unterstellt. Bei Verantwortungsverschiebung geht es um die *eigene* Verantwortung.

### `generalization_candidate` — Verallgemeinerung
**Definition:** Ein Einzelfall wird zu einem generellen Muster erklärt („immer", „nie", „jedes Mal").
**Beispiel:** „Du hörst mir NIE zu."
**Grenzfall (zählt nicht):** Die Formulierung enthält „immer/nie", meint aber erkennbar nur den aktuellen, wiederholten Einzelfall und wird nicht als absolute Aussage über die ganze Beziehung verstanden — sprachliche Übertreibung im Affekt ist nicht automatisch die Kategorie, entscheidend ist, ob es als generelles Urteil ankommt.

### `criticism_justification_loop` — Kritik-Rechtfertigungs-Schleife
**Definition:** Ein wiederkehrendes Muster über mehrere Nachrichten: Kritik → Rechtfertigung → erneute Kritik → erneute Rechtfertigung, ohne dass sich die Positionen bewegen.
**Beispiel:** Drei oder mehr Runden aus „du hast X gemacht" / „ich musste doch, weil Y" / „aber X war trotzdem falsch" / „Y war aber wichtig" ohne Fortschritt.
**Grenzfall (zählt nicht):** Zwei Runden Kritik/Rechtfertigung, danach Wendung zu Verständnis oder Reparatur — das ist eine normale Klärung, keine Schleife. Braucht mindestens einen erkennbaren zweiten vollen Durchlauf ohne Bewegung, um zu zählen.

---

## Positive Marker

*Bewusst gleichgewichtig zu den Risikomustern ausgebaut (9 gegen 10): Der Übersetzer lernt aus Gelingen, nicht nur aus Fehlern — insbesondere aus dem Fall „kritische Sache wurde gesagt und kam trotzdem gut an".*

### `repair_offer` — Reparaturangebot
**Definition:** Eine Person bietet aktiv etwas an, um die Situation zu verbessern (Entschuldigung, Vorschlag, Geste), unabhängig davon, ob es angenommen wird.
**Beispiel:** „Tut mir leid, das war unfair von mir. Sollen wir nochmal von vorne reden?"

### `responsibility_taken` — Verantwortungsübernahme
**Definition:** Eine Person erkennt eigenes Fehlverhalten explizit an, ohne es zu relativieren oder zu bedingen.
**Beispiel:** „Du hast recht, das war nicht in Ordnung von mir."
**Grenzfall (zählt nicht):** „Es tut mir leid, dass DU das so empfindest" — das erkennt die Wirkung an, nicht die eigene Verantwortung (klassische bedingte Entschuldigung). Zählt eher als Grenzfall zu `apology_present`, nicht automatisch hier.

### `topic_return` — Themenrückkehr
**Definition:** Nach einem Abschweifen (Themenwechsel, Streitpunkt, Nebensache) kehrt das Gespräch zum ursprünglichen Anliegen zurück und behandelt es weiter.
**Beispiel:** Nach ein paar Nachrichten zu einem Nebenthema: „Okay, aber zurück zu vorhin — wegen der Verspätung…"

### `agreement_reached` — Vereinbarung
**Definition:** Beide Seiten einigen sich erkennbar auf eine konkrete nächste Handlung oder ein gemeinsames Verständnis.
**Beispiel:** „Okay, dann ruf ich beim nächsten Mal kurz an, wenn's später wird." — „Gut, passt."
**Grenzfall (zählt nicht):** Nur eine Seite formuliert einen Vorsatz, ohne erkennbare Zustimmung/Reaktion der anderen — einseitiges Versprechen ist keine Vereinbarung.

### `concern_stated_without_blame` — Anliegen ohne Vorwurf formuliert
**Definition:** Ein kritisches Anliegen wird angesprochen, ohne der anderen Person Schuld, Absicht oder Charakterfehler zuzuschreiben — beschreibt die eigene Wahrnehmung oder das eigene Bedürfnis statt das Fehlverhalten des anderen.
**Beispiel:** „Wenn ich abends nichts von dir höre, mache ich mir Gedanken. Können wir da was finden?" (statt: „Du meldest dich nie.")
**Grenzfall (zählt nicht):** Vorwurf mit höflicher Verpackung — „Ich finde es echt schade, dass du immer…" bleibt inhaltlich ein Vorwurf, nur weicher formuliert.
**Warum diese Klasse wichtig ist:** Für den Übersetzer die zentrale Positivkategorie — genau das Zielverhalten, das `reframedText` erzeugen soll. Ohne erfasste Beispiele hat das Modell nur Gegenbeispiele, kein Vorbild.

### `clarifying_question` — Nachfrage statt Annahme
**Definition:** Statt eine Deutung als gegeben zu behandeln, wird nachgefragt, wie etwas gemeint war oder was der andere braucht.
**Beispiel:** „Wie hast du das gemeint?" / „Was hättest du dir stattdessen gewünscht?"
**Grenzfall (zählt nicht):** Rhetorische Frage, die keine Antwort erwartet („Ist das dein Ernst?") — das ist eine Aussage in Frageform, keine Klärung.

### `perception_validated` — Wahrnehmung des anderen bestätigt
**Definition:** Die Empfindung oder Sichtweise der anderen Person wird als berechtigt anerkannt, unabhängig davon, ob man ihr inhaltlich zustimmt.
**Beispiel:** „Ich kann verstehen, dass sich das für dich blöd angefühlt hat."
**Grenzfall (zählt nicht):** Scheinbestätigung mit anschließender Entkräftung — „Ich versteh dich ja, aber du übertreibst" fällt eher unter `impact_relativized`.
**Abgrenzung zu `responsibility_taken`:** Hier wird das *Erleben* des anderen anerkannt, nicht die eigene Schuld. Beides kann gleichzeitig zutreffen.

### `deescalation` — Bewusste Deeskalation
**Definition:** Jemand nimmt erkennbar Tempo oder Schärfe heraus — schlägt eine Pause vor, benennt die Dynamik, bremst bewusst ab.
**Beispiel:** „Ich merke, wir drehen uns im Kreis. Lass uns kurz aufhören und später weiterreden."
**Grenzfall (zählt nicht):** Gesprächsabbruch ohne Rückkehrangebot („Ich hab keine Lust mehr auf das Thema") — das beendet, statt zu deeskalieren.
**Abgrenzung zu `topic_shift`:** Deeskalation benennt die Situation und pausiert bewusst; Themenwechsel weicht aus, ohne das zu markieren.

### `affection_in_conflict` — Zuneigung/Wärme im Konfliktkontext
**Definition:** Innerhalb einer Konfliktsituation wird Zuneigung, Wertschätzung oder Verbundenheit ausgedrückt — ein Signal, dass die Beziehung trotz Streit intakt ist.
**Beispiel:** „Ich bin gerade sauer, aber ich hab dich trotzdem lieb." / „Wir kriegen das hin."
**Grenzfall (zählt nicht):** Zuneigungsausdruck außerhalb jeden Konfliktkontexts (normale Alltagsnachricht ohne Streitbezug) — hier geht es speziell um Wärme *während* eines Konflikts, weil das die aussagekräftige Beobachtung ist.

---

## Entschuldigung — reine Erkennung

### `apology_present` — Situation enthält eine Entschuldigung
**Definition:** Irgendeine Form von „Entschuldigung / tut mir leid / sorry" o. ä. kommt vor, unabhängig davon, wie aufrichtig oder bedingt sie ist. Die Art der Entschuldigung wird hier bewusst noch nicht bewertet (kommt in Phase 2).
**Beispiel:** Jede Nachricht mit erkennbarer Entschuldigungsformel, auch kurze wie „sorry" oder „my bad".
**Grenzfall (zählt nicht):** Reine Höflichkeitsfloskel ohne Bezug zu einem Konflikt in der Situation („sorry, hab dich nicht gehört, kannst du's nochmal sagen?" bei technischem Missverständnis ohne emotionalen Kontext) — hier tendenziell großzügig sein und trotzdem markieren, es sei denn eindeutig sachlich-technisch.

---

## Zuschnitt-Flags (Segmentierungsqualität, nicht Inhalt)

Diese drei Flags bewerten **nicht** den Inhalt der Situation, sondern den
*Zuschnitt* — eine Rückmeldung an die Segmentierung. Sie werden getrennt von den
20 Inhaltsklassen erfasst und getrennt ausgewertet (eigene Kappa-Spalte). Eine
Situation mit bestätigtem `merged_situations` oder `incomplete` wird in der
Übersicht als „Zuschnitt strittig/fehlerhaft" markiert und fließt in eine
spätere, gesonderte Nacharbeitsliste — es wird jetzt **keine** Grenze
rückgebaut.

### `not_a_real_situation` — Keine echte Situation
**Definition:** Der markierte Ausschnitt ist kein zusammenhängender kommunikativer Austausch — Rauschen, reine Systemnachrichten, Fehlsegmentierung ohne erkennbaren Inhalt.

### `incomplete` — Situation unvollständig
**Definition:** Die Grenze schneidet mitten in einem erkennbar zusammenhängenden Austausch ab — es fehlt sichtbar ein Anfang oder ein Ende, das eigentlich dazugehört.

### `merged_situations` — Situationen vermischt
**Definition:** Der Ausschnitt enthält erkennbar zwei oder mehr eigentlich getrennte Situationen (unterschiedliche Anliegen, keine inhaltliche Verbindung), die durch die aktuelle Grenzsetzung fälschlich zusammengefasst wurden.

---

## Bewusst nicht aufgenommen

- **Humor/Lachen:** zu stark tonfallabhängig, würde Kappa drücken.
- **Dankbarkeit:** meist außerhalb von Konfliktsituationen, für die Übersetzerfunktion wenig relevant.
- **Mehrdimensionale Entschuldigungsanalyse** (Verhalten/Wirkung/Verantwortung/Bedingtheit/…): strukturell pro Entschuldigungs*instanz*, eigener Auftrag (Phase 2). Hier nur die binäre Erkennung `apology_present`.
