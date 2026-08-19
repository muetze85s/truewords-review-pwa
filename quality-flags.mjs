/**
 * Die 3 Zuschnitt-Qualitätsflags — getrennt von den 20 Inhaltsklassen
 * (classification-classes.mjs). Sie bewerten den *Zuschnitt* der Situation
 * (Rückmeldung an die Segmentierung), nicht den Inhalt. Deshalb eigene Tabelle,
 * eigene Kappa-Spalte, aber gleiche UI-Seite (optisch abgesetzte Gruppe).
 *
 * Ausführliche Definitionen: docs/CODEBOOK.md, Abschnitt „Zuschnitt-Flags".
 */

// `code` (Z1–Z3) ist der feste, kurze Anzeigecode je Zuschnitt-Flag, an den
// `key` gebunden (nicht an die Reihenfolge). Angezeigt wird „Z1 · Keine echte
// Situation"; der englische key bleibt intern.
export const QUALITY_FLAGS = [
  {
    code: 'Z1',
    key: 'not_a_real_situation',
    label: 'Keine echte Situation',
    hint: 'Kein zusammenhängender Austausch — Rauschen, Systemnachricht, Fehlsegmentierung ohne Inhalt.',
  },
  {
    code: 'Z2',
    key: 'incomplete',
    label: 'Situation unvollständig',
    hint: 'Die Grenze schneidet mitten in einem zusammenhängenden Austausch ab — Anfang oder Ende fehlt.',
  },
  {
    code: 'Z3',
    key: 'merged_situations',
    label: 'Situationen vermischt',
    hint: 'Zwei oder mehr eigentlich getrennte Situationen fälschlich zu einer zusammengefasst.',
  },
];

export const QUALITY_FLAG_KEYS = QUALITY_FLAGS.map((entry) => entry.key);

/** Code (Z1) → key-Zuordnung für Anzeige und Nachschlag. */
const QUALITY_CODE_BY_KEY = new Map(QUALITY_FLAGS.map((entry) => [entry.key, entry.code]));

/** Kurzer Anzeigecode (Z1/Z2/Z3) zu einem Flag-Key, oder '' wenn unbekannt. */
export function qualityCodeByKey(key) {
  return QUALITY_CODE_BY_KEY.get(key) || '';
}

/**
 * Bestätigte Flags, die den Zuschnitt als fehlerhaft markieren (Übersicht:
 * „Zuschnitt strittig/fehlerhaft"). `not_a_real_situation` gehört fachlich
 * dazu — eine Nicht-Situation ist ebenfalls ein Zuschnittfehler.
 */
export const SEGMENTATION_BROKEN_FLAG_KEYS = ['incomplete', 'merged_situations', 'not_a_real_situation'];

const QUALITY_KEY_SET = new Set(QUALITY_FLAG_KEYS);

export function isValidQualityFlag(key) {
  return QUALITY_KEY_SET.has(key);
}

export function qualityFlagByKey(key) {
  return QUALITY_FLAGS.find((entry) => entry.key === key);
}
