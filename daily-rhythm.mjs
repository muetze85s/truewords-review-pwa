/**
 * Tagesrhythmus-Aggregate: Nachrichten je Tagesstunde (pro Sender) und die
 * Startstunden längerer Pausen. Reine Zählungen, kein Nachrichtentext.
 *
 * Zeitzonen-Festlegung: Die Zeitstempel im Telegram-Export sind Unix-Epoch,
 * also UTC. Eingeteilt wird hier — wie in der gesamten Auswertung — nach
 * Europe/Berlin (mit automatischer Sommerzeit), über Intl.DateTimeFormat.
 * Welche Zone galt, steht ausdrücklich im Ergebnis (`timezone`).
 *
 * Keine D1-/DOM-/Fetch-Aufrufe — direkt mit `node` testbar
 * (tests/daily-rhythm.test.mjs) und vom Worker importierbar.
 */

// Pausenklassen: > 1 h ist die Eintrittsschwelle, darüber drei Bänder.
const HOUR = 3600;
const GAP_MIN = 1 * HOUR;      // > 1 h zählt überhaupt
const GAP_MID = 4 * HOUR;      // 1–4 h | 4–12 h
const GAP_LONG = 12 * HOUR;    // 4–12 h | > 12 h

/**
 * Tagesstunde (0–23) eines Unix-Zeitpunkts in der Zielzone — mit Cache je
 * UTC-Stunde. Exakt trotz Sommerzeit: Europas Umstellungen liegen auf vollen
 * UTC-Stunden, innerhalb einer UTC-Stunde ist der Versatz also konstant, und
 * ganze Stunden Versatz bilden eine UTC-Stunde auf genau eine Ortsstunde ab.
 * So braucht der 4-Jahres-Chat ~35 000 Intl-Aufrufe statt ~200 000.
 */
function makeHourOfDay(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
  const cache = new Map();
  return (unixSeconds) => {
    const bucket = Math.floor(unixSeconds / HOUR);
    let hour = cache.get(bucket);
    if (hour === undefined) {
      hour = Number(formatter.format(new Date(bucket * HOUR * 1000)));
      cache.set(bucket, hour);
    }
    return hour;
  };
}

/**
 * @param {Array<{ t: number, from: string }>} entries  Nachrichten in
 *   Reihenfolge: Unix-Sekunden + Absendername. Einträge ohne gültige Zeit
 *   (t ≤ 0) werden übersprungen und gezählt gemeldet.
 * @param {{ timeZone?: string }} [options]
 * @returns {{
 *   timezone: string,
 *   timezoneNote: string,
 *   skippedNoTimestamp: number,
 *   msgPerHourBySender: Record<string, number[]>,
 *   gapStartHour: {
 *     minGapSeconds: number,
 *     classes: {
 *       '1-4h': { fromSeconds: number, toSeconds: number, counts: number[] },
 *       '4-12h': { fromSeconds: number, toSeconds: number, counts: number[] },
 *       'over12h': { fromSeconds: number, toSeconds: number | null, counts: number[] },
 *     },
 *   },
 * }}
 */
export function hourlyAggregates(entries, options = {}) {
  const timeZone = options.timeZone || 'Europe/Berlin';
  const hourOfDay = makeHourOfDay(timeZone);

  const msgPerHourBySender = {};
  const zeros = () => new Array(24).fill(0);
  const gapShort = zeros();
  const gapMid = zeros();
  const gapLong = zeros();

  let skipped = 0;
  let previousT = null;
  for (const entry of entries) {
    const t = Number(entry?.t);
    if (!Number.isFinite(t) || t <= 0) { skipped += 1; continue; }

    const sender = String(entry.from || '?');
    if (!msgPerHourBySender[sender]) msgPerHourBySender[sender] = zeros();
    msgPerHourBySender[sender][hourOfDay(t)] += 1;

    // Pause = Abstand zur vorherigen (zeittragenden) Nachricht. Gezählt wird
    // die Stunde, in der die Pause BEGINNT — also die der Nachricht davor.
    if (previousT !== null) {
      const gap = t - previousT;
      if (gap > GAP_MIN) {
        const startHour = hourOfDay(previousT);
        if (gap <= GAP_MID) gapShort[startHour] += 1;
        else if (gap <= GAP_LONG) gapMid[startHour] += 1;
        else gapLong[startHour] += 1;
      }
    }
    previousT = t;
  }

  return {
    timezone: timeZone,
    timezoneNote:
      'Zeitstempel im Export sind Unix-Epoch (UTC); die Stunden hier sind nach '
      + `${timeZone} eingeteilt, mit automatischer Sommerzeit.`,
    skippedNoTimestamp: skipped,
    msgPerHourBySender,
    gapStartHour: {
      minGapSeconds: GAP_MIN,
      classes: {
        '1-4h': { fromSeconds: GAP_MIN, toSeconds: GAP_MID, counts: gapShort },
        '4-12h': { fromSeconds: GAP_MID, toSeconds: GAP_LONG, counts: gapMid },
        'over12h': { fromSeconds: GAP_LONG, toSeconds: null, counts: gapLong },
      },
    },
  };
}
