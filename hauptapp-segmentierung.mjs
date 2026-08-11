/**
 * Zweiter Segmentierer-Modus des Prüfstands: die **echte** Segmentierung der
 * Hauptanwendung, nicht die Nachbildung in segmentation-v4.mjs.
 *
 * Benutzt ausschließlich segmentCommunicationSituations() aus der unveränderten
 * Kopie unter vendor/truewords-app/ (Herkunft und Prüfsumme siehe HERKUNFT.md
 * dort). Diese Datei enthält nur die Anpassung unserer Rundennachrichten auf die
 * Form, die jene Funktion erwartet — damit die Kopie unberührt bleibt.
 *
 * Der Prüfstand denkt in Zwischenräumen (Position 1..n-1, „Grenze vor Nachricht
 * an Position p"), die Hauptanwendung in Situationen. Die Übersetzung: jede
 * Situation ab der zweiten beginnt mit einer Nachricht, und deren Position ist
 * genau eine Grenze.
 */
import { segmentCommunicationSituations } from './vendor/truewords-app/sequential-communication-analysis.ts';

/**
 * Die beiden Beteiligten eines Fensters. Die Hauptanwendung verlangt zu jeder
 * Nachricht Sender UND Empfänger; unsere Rundennachrichten kennen nur den
 * Absender, der Empfänger ist in einer Zweierbeziehung der jeweils andere.
 */
export function participantsOf(messages) {
  const names = [];
  for (const message of messages) {
    const from = String(message.from ?? '');
    if (from && !names.includes(from)) names.push(from);
  }
  return names;
}

/**
 * Übersetzt unsere Anzeigenachrichten (ViewMessage) in NormalizedMessageEvent.
 *
 * - `sentAt` ist ein Date; unser `t` sind Sekunden.
 * - `text` bleibt leer für Anrufe und Medien. Das ist bewusst: die Hauptanwendung
 *   zählt Textlängen (maxCharacters) und prüft das Abschlussmuster auf dem Text.
 *   Ein erfundener Ersatztext würde beides verfälschen.
 * - `source: 'chat_import'` ist die Betriebsart, unter der die Hauptanwendung einen
 *   eingelesenen Chat verarbeitet. Sie steuert, dass die letzte Situation als
 *   geschlossen gilt ('end_of_import') statt offen zu bleiben.
 */
export function toNormalizedEvents(messages, options = {}) {
  const source = options.source || 'chat_import';
  const participants = participantsOf(messages);
  return messages.map((message) => {
    const senderUserId = String(message.from ?? '');
    const other = participants.find((name) => name !== senderUserId);
    return {
      id: String(message.id ?? ''),
      source,
      senderUserId,
      // In einer Zweierbeziehung ist der Empfänger der jeweils andere. Gibt es
      // nur einen Namen im Fenster, bleibt das Feld leer statt geraten zu werden.
      recipientUserId: other === undefined ? '' : other,
      text: String(message.text ?? ''),
      sentAt: new Date(Number(message.t || 0) * 1000),
      replyToId: message.replyToId === undefined ? null : String(message.replyToId),
    };
  });
}

/**
 * Führt die Segmentierung der Hauptanwendung auf einem Rundenfenster aus und
 * liefert die Grenzen als Zwischenraum-Positionen — dieselbe Währung, in der
 * auch unsere eigene Automatik gemessen wird.
 *
 * Rückgabe: { positions, situations, closeReasons }
 *   positions     aufsteigende Zwischenraum-Positionen (1..n-1)
 *   situations    Anzahl der Situationen, die die Hauptanwendung gebildet hat
 *   closeReasons  Zählung je Schließungsgrund, für die Fehleranalyse
 */
export function hauptappBoundaries(messages, config = {}) {
  if (!Array.isArray(messages) || messages.length < 2) {
    return { positions: [], situations: messages?.length ? 1 : 0, closeReasons: {} };
  }

  const events = toNormalizedEvents(messages, config);
  const situations = segmentCommunicationSituations(events, config.limits || {});

  // Position jeder Nachricht im Fenster: 1..n-1 sind Zwischenräume, Index 0 ist
  // der Fensteranfang und damit keine Grenze.
  const positionById = new Map();
  for (let index = 1; index < messages.length; index += 1) {
    positionById.set(String(messages[index].id ?? ''), index);
  }

  const positions = [];
  const closeReasons = {};
  situations.forEach((situation, index) => {
    closeReasons[situation.closeReason] = (closeReasons[situation.closeReason] || 0) + 1;
    if (index === 0) return; // die erste Situation beginnt am Fensteranfang
    const firstId = String(situation.messages[0]?.id ?? '');
    const position = positionById.get(firstId);
    if (position !== undefined) positions.push(position);
  });

  positions.sort((a, b) => a - b);
  return { positions, situations: situations.length, closeReasons };
}
