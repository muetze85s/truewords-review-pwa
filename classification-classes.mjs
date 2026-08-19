/**
 * Zentrale Konstante der 20 Musterklassen (Phase 1) der Klassifizierungsstufe.
 *
 * Eine Quelle für alle: UI-Checkboxen und -Tooltips (klassifizierung.html),
 * die Nachschlage-Seite (klassifizierung-info.html), die Kappa-Berechnung
 * (classification-logic.mjs) und später den LLM-Prompt (Phase 2). Die
 * ausführlichen Definitionen/Beispiele/Grenzfälle leben in `docs/CODEBOOK.md`
 * (Version = CODEBOOK_VERSION) — die `hint` hier ist die verkürzte
 * Tooltip-Fassung, nie eine abweichende Definition.
 *
 * Reines Daten-/Logikmodul ohne D1-/DOM-/Fetch-Zugriff: in Node testbar, vom
 * Worker (TS) wie von der Seite (Browser-JS) importierbar.
 */

/** Aktuelle Kodierhandbuchversion. Bei jeder Definitionsänderung hochzählen
 *  (und docs/CODEBOOK.md vermerken). Wird pro Markierung mitgeschrieben. */
export const CODEBOOK_VERSION = 1;

export const GROUP_LABELS = {
  risk: 'Risikomuster',
  positive: 'Positive Marker',
  apology: 'Entschuldigung',
};

/**
 * Reihenfolge = Anzeigereihenfolge in der UI. `code` (N1–N10 / P1–P9 / E1) ist
 * der feste, KURZE Anzeigecode je Klasse — an den `key` (pattern_key) gebunden,
 * NICHT an die Anzeigereihenfolge: ändert sich die Reihenfolge, wandert der Code
 * mit dem key mit. Angezeigt wird überall „N7 · Wirkung relativiert" (Code +
 * Klartext); der englische `key` bleibt rein intern (D1/LLM). `selfImplicating`
 * markiert Klassen, bei denen das eigene Verhalten betroffen sein kann — für die
 * Bias-Auswertung und die Priorisierung der Abweichungsliste (PR 2).
 * `autoClassificationEnabled` bleibt bis zur bestandenen Validierung false;
 * erst dann übernimmt das LLM diese Klasse im Dauerbetrieb (PR 2).
 */
export const CLASSIFICATION_CLASSES = [
  // --- Risikomuster (10) ---
  {
    code: 'N1',
    key: 'countercriticism_before_addressing_concern',
    label: 'Gegenkritik vor Bearbeitung des Anliegens',
    group: 'risk',
    selfImplicating: true,
    autoClassificationEnabled: false,
    hint: 'Auf ein Anliegen wird zuerst mit einem eigenen Vorwurf geantwortet, bevor auf das Anliegen eingegangen wird.',
  },
  {
    code: 'N2',
    key: 'previous_issue_used_to_displace_current_issue',
    label: 'Aufrechnen (altes Thema verdrängt aktuelles)',
    group: 'risk',
    selfImplicating: true,
    autoClassificationEnabled: false,
    hint: 'Ein altes, unabhängiges Thema wird herangezogen, um vom aktuellen Anliegen abzulenken.',
  },
  {
    code: 'N3',
    key: 'whataboutism_candidate',
    label: 'Whataboutism',
    group: 'risk',
    selfImplicating: true,
    autoClassificationEnabled: false,
    hint: 'Statt Auseinandersetzung mit dem Vorwurf ein Gegenvorwurf, der das Thema „zurückspielt".',
  },
  {
    code: 'N4',
    key: 'topic_shift',
    label: 'Themenwechsel',
    group: 'risk',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Das Gespräch wandert vom Anliegen weg zu einem anderen Thema, ohne das Anliegen zu klären.',
  },
  {
    code: 'N5',
    key: 'problem_mixing',
    label: 'Problemvermischung',
    group: 'risk',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Mehrere Konfliktpunkte gleichzeitig verhandelt, keiner davon einzeln zu Ende besprochen.',
  },
  {
    code: 'N6',
    key: 'responsibility_shift',
    label: 'Verantwortungsverschiebung',
    group: 'risk',
    selfImplicating: true,
    autoClassificationEnabled: false,
    hint: 'Verantwortung fürs eigene Verhalten wird der anderen Person oder den Umständen zugeschrieben.',
  },
  {
    code: 'N7',
    key: 'impact_relativized',
    label: 'Wirkung relativiert',
    group: 'risk',
    selfImplicating: true,
    autoClassificationEnabled: false,
    hint: 'Die Wirkung des eigenen Verhaltens auf den anderen wird kleingeredet statt anerkannt.',
  },
  {
    code: 'N8',
    key: 'intent_attribution',
    label: 'Absichtsunterstellung',
    group: 'risk',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Der anderen Person wird eine (meist negative) Absicht unterstellt, die sie nicht geäußert hat.',
  },
  {
    code: 'N9',
    key: 'generalization_candidate',
    label: 'Verallgemeinerung',
    group: 'risk',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Ein Einzelfall wird zum generellen Urteil erklärt („immer", „nie").',
  },
  {
    code: 'N10',
    key: 'criticism_justification_loop',
    label: 'Kritik-Rechtfertigungs-Schleife',
    group: 'risk',
    selfImplicating: true,
    autoClassificationEnabled: false,
    hint: 'Kritik → Rechtfertigung → Kritik → … über mehrere Runden ohne Bewegung der Positionen.',
  },

  // --- Positive Marker (9) ---
  {
    code: 'P1',
    key: 'repair_offer',
    label: 'Reparaturangebot',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Aktives Angebot, die Situation zu verbessern (Entschuldigung, Vorschlag, Geste).',
  },
  {
    code: 'P2',
    key: 'responsibility_taken',
    label: 'Verantwortungsübernahme',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Eigenes Fehlverhalten wird explizit anerkannt, ohne es zu relativieren oder zu bedingen.',
  },
  {
    code: 'P3',
    key: 'topic_return',
    label: 'Themenrückkehr',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Nach einem Abschweifen kehrt das Gespräch zum ursprünglichen Anliegen zurück.',
  },
  {
    code: 'P4',
    key: 'agreement_reached',
    label: 'Vereinbarung',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Beide Seiten einigen sich erkennbar auf eine konkrete nächste Handlung oder ein Verständnis.',
  },
  {
    code: 'P5',
    key: 'concern_stated_without_blame',
    label: 'Anliegen ohne Vorwurf formuliert',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Kritisches Anliegen angesprochen ohne Schuld-/Absichtszuschreibung — eigene Wahrnehmung/Bedürfnis statt Fehlverhalten des anderen.',
  },
  {
    code: 'P6',
    key: 'clarifying_question',
    label: 'Nachfrage statt Annahme',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Statt eine Deutung als gegeben zu behandeln, wird nachgefragt, wie etwas gemeint war.',
  },
  {
    code: 'P7',
    key: 'perception_validated',
    label: 'Wahrnehmung des anderen bestätigt',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Empfindung/Sichtweise des anderen wird als berechtigt anerkannt — unabhängig von inhaltlicher Zustimmung.',
  },
  {
    code: 'P8',
    key: 'deescalation',
    label: 'Bewusste Deeskalation',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Jemand nimmt erkennbar Tempo/Schärfe heraus — Pause vorschlagen, Dynamik benennen, bewusst abbremsen.',
  },
  {
    code: 'P9',
    key: 'affection_in_conflict',
    label: 'Zuneigung/Wärme im Konfliktkontext',
    group: 'positive',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Zuneigung/Wertschätzung/Verbundenheit mitten im Konflikt — Signal, dass die Beziehung intakt ist.',
  },

  // --- Entschuldigung: reine Erkennung (1) ---
  {
    code: 'E1',
    key: 'apology_present',
    label: 'Situation enthält eine Entschuldigung',
    group: 'apology',
    selfImplicating: false,
    autoClassificationEnabled: false,
    hint: 'Irgendeine Form von Entschuldigung („tut mir leid", „sorry") kommt vor — Art/Aufrichtigkeit hier noch nicht bewertet.',
  },
];

/** Code (N7) → key, und key → Code — für Anzeige und Nachschlag. */
const CODE_BY_KEY = new Map(CLASSIFICATION_CLASSES.map((entry) => [entry.key, entry.code]));

/** Kurzer Anzeigecode (N7/P3/E1/…) zu einem key, oder '' wenn unbekannt. */
export function codeByKey(key) {
  return CODE_BY_KEY.get(key) || '';
}

/** Keys in Anzeigereihenfolge. */
export const CLASSIFICATION_KEYS = CLASSIFICATION_CLASSES.map((entry) => entry.key);

/** Selbstimplizierende Klassen — für Bias-Auswertung/Priorisierung (PR 2). */
export const SELF_IMPLICATING_KEYS = CLASSIFICATION_CLASSES
  .filter((entry) => entry.selfImplicating)
  .map((entry) => entry.key);

const KEY_SET = new Set(CLASSIFICATION_KEYS);
const BY_KEY = new Map(CLASSIFICATION_CLASSES.map((entry) => [entry.key, entry]));

/** Ist `key` eine bekannte Musterklasse? Für serverseitige Eingabevalidierung. */
export function isValidPatternKey(key) {
  return KEY_SET.has(key);
}

/** Klassendefinition zu einem Key (oder undefined). */
export function classByKey(key) {
  return BY_KEY.get(key);
}

/** Klassen einer Gruppe, in Anzeigereihenfolge. */
export function classesByGroup(group) {
  return CLASSIFICATION_CLASSES.filter((entry) => entry.group === group);
}
