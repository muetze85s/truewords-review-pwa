/**
 * Reine, node-testbare Bausteine für den LLM-Dritt-Rater (PR 2):
 * Anonymisierung, Prompt-Bau, robustes JSON-Parsen. KEIN Netzwerkzugriff —
 * die Transport-/Kostenschicht liegt in anthropic-gateway.ts.
 *
 * Anonymisierung geschieht hier, in der Datenaufbereitung, NICHT als Anweisung
 * im Prompt ("ignoriere Namen"): Klarnamen werden durch generische Labels
 * ersetzt, Zeitstempel fallen ganz weg (Handoff 7b/2.6).
 */

/** Erstes/zweites/... Wort eines Namens — für den Whole-Word-Ersatz im Text. */
function firstName(value) {
  return String(value ?? '').trim().split(/\s+/u)[0] || '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Ersetzt Klarnamen/Spitznamen serverseitig durch stabile, reihenfolgebasierte
 * Labels: erster Absender der Situation → "Person A", zweiter → "Person B", usw.
 * Nicht fest an Philipp/Lena gebunden, damit aus der Reihenfolge keine Identität
 * ableitbar ist. Zeitstempel werden nicht mit ausgegeben.
 *
 * Zusätzlich werden die (Voll- und Vor-)Namen der Absender auch INNERHALB des
 * Nachrichtentexts wortweise durch ihr Label ersetzt — best effort, damit ein
 * im Text genannter Name nicht doch die Identität verrät.
 *
 * @param {Array<{from?:string,text?:string,kind?:string}>} messages
 * @returns {{ text: string, labelCount: number }}
 */
export function anonymizeSituation(messages) {
  const labelByName = new Map();
  function labelFor(name) {
    const key = String(name ?? '');
    if (!labelByName.has(key)) {
      const letter = String.fromCharCode(65 + labelByName.size); // A, B, C, ...
      labelByName.set(key, `Person ${letter}`);
    }
    return labelByName.get(key);
  }
  // Labels zuerst vergeben (Reihenfolge des ersten Auftretens).
  for (const message of messages) labelFor(message.from);

  // Ersetzungsliste für In-Text-Namen: voller Name + Vorname → Label.
  const replacements = [];
  for (const [name, label] of labelByName) {
    const full = String(name).trim();
    const first = firstName(name);
    for (const variant of new Set([full, first].filter((v) => v.length >= 2))) {
      replacements.push({ pattern: new RegExp(`\\b${escapeRegExp(variant)}\\b`, 'giu'), label });
    }
  }
  // Längere Varianten zuerst ersetzen (voller Name vor Vorname).
  replacements.sort((a, b) => b.pattern.source.length - a.pattern.source.length);

  function scrub(text) {
    let out = String(text ?? '');
    for (const { pattern, label } of replacements) out = out.replace(pattern, label);
    return out;
  }

  const lines = messages.map((message) => {
    const who = labelFor(message.from);
    let body;
    if (message.kind === 'anruf') body = '[Anruf]';
    else if (message.kind === 'medien') body = '[Medien]';
    else if (message.kind === 'leer' || !message.text) body = '[ohne Text]';
    else body = scrub(message.text);
    return `${who}: ${body}`;
  });

  return { text: lines.join('\n'), labelCount: labelByName.size };
}

/**
 * Baut System- und User-Prompt. Die Klassendefinitionen stammen aus dem
 * übergebenen Kodierhandbuch-Abschnitt (docs/CODEBOOK.md v1) — eine Quelle,
 * keine Duplizierung im Code. Es wird strukturiertes JSON verlangt.
 *
 * @param {{ situationText: string, codebookSection: string, keys: string[] }} input
 */
export function buildClassificationPrompt({ situationText, codebookSection, keys }) {
  const system = [
    'Du bist ein neutraler, unabhängiger Kodierer für eine Studie zur Paarkommunikation.',
    'Bewerte ausschließlich die dir gezeigte Situation anhand des reinen Textes — kein vermuteter Tonfall, keine Annahmen über die Personen.',
    'Für jede der unten definierten Musterklassen entscheide binär: Enthält diese Situation das Muster? true oder false. Mehrere Klassen können gleichzeitig zutreffen; triggere nicht künstlich, aber halte auch nicht zurück.',
    '',
    'Definitionen (Kodierhandbuch):',
    String(codebookSection || '').trim(),
    '',
    'Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt. Für jeden der folgenden Schlüssel genau ein Boolean (true/false), nichts anderes — keine Erklärungen, kein Markdown, keine Codeblöcke.',
    `Schlüssel (pattern_key): ${keys.join(', ')}`,
  ].join('\n');

  const user = `Situation:\n${String(situationText || '').trim()}`;
  return { system, user };
}

/**
 * Robustes Parsen der Modellantwort. Strippt Markdown-Fences, schneidet auf das
 * äußerste JSON-Objekt zu und parst. Bei jeder Formatabweichung → null (der
 * Aufruf gilt als FEHLGESCHLAGEN), NICHT als „alle Klassen false". Bei
 * erfolgreichem Parsen zählt ein fehlender Schlüssel als 0 (nicht vorhanden).
 *
 * @returns {{ classes: Record<string, 0|1> } | null}
 */
export function parseClassificationJson(text, keys) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let cleaned = text.trim();
  // ```json ... ``` oder ``` ... ``` entfernen.
  cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/u, '').replace(/\s*```$/u, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const classes = {};
  let recognized = 0;
  for (const key of keys) {
    const raw = parsed[key];
    if (raw === true || raw === 1 || raw === 'true') { classes[key] = 1; recognized += 1; }
    else if (raw === false || raw === 0 || raw === 'false') { classes[key] = 0; recognized += 1; }
    else classes[key] = 0; // fehlend/unbekannt → nicht vorhanden
  }
  // Wenn KEIN einziger erwarteter Schlüssel erkannt wurde, ist die Antwort
  // strukturell unbrauchbar → als Fehlschlag behandeln (nicht „alles false").
  if (recognized === 0) return null;
  return { classes };
}
