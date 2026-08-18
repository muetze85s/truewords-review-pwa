/**
 * Reine Auslöselogik für die Push-Erinnerungen. Keine D1-/Netz-/Krypto-Aufrufe,
 * damit sie ohne Server im Trockenlauf testbar ist (tests/push-schedule-logic.test.mjs).
 *
 * Zeitzonen sind hier der Kern: Zeiten werden als „HH:MM in Zeitzone" geführt und
 * über Intl in die jeweilige Ortszeit übersetzt. Europe/Berlin bekommt so
 * automatisch Sommer-/Winterzeit; Asia/Bangkok ist fix UTC+7. Nirgends eine feste
 * UTC-Zahl.
 */

/** Ortszeit-Bestandteile eines Zeitpunkts in einer Zeitzone (DST-korrekt via Intl). */
export function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  const hour = Number(parts.hour === '24' ? '00' : parts.hour);
  const minute = Number(parts.minute);
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
  };
}

/** Ortsdatum (YYYY-MM-DD) — der Tagesschlüssel für den Doppelversand-Schutz. */
export function localYmd(date, timeZone) {
  return localParts(date, timeZone).ymd;
}

/** "HH:MM" → Minuten seit Mitternacht, oder null bei Unfug. */
export function parseHhmm(value) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Welche der eingestellten Erinnerungszeiten sind JETZT fällig?
 * Fällig = Schalter an, an dem Ortstag noch keine Runde abgegeben, Ortszeit hat
 * die konfigurierte Zeit erreicht (>=), und dieser Slot wurde heute noch nicht
 * gesendet. "erreicht" statt "exakt getroffen", damit ein verpasster Cron-Tick
 * die Erinnerung nicht verschluckt — der Doppelversand-Schutz (sentSlotsToday)
 * sorgt dafür, dass sie trotzdem nur einmal rausgeht.
 */
export function dueReminderSlots({ now, timeZone, times, enabled, submittedToday, sentSlotsToday = [] }) {
  if (!enabled || submittedToday) return [];
  const nowMinutes = localParts(now, timeZone).minutesOfDay;
  const alreadySent = new Set(sentSlotsToday);
  const due = [];
  (times || []).forEach((hhmm, index) => {
    const target = parseHhmm(hhmm);
    if (target === null) return;
    if (nowMinutes >= target && !alreadySent.has(index)) due.push(index);
  });
  return due;
}

/**
 * Tägliche Streitfall-Warnung fällig? Schalter an, offene Fälle >= Schwelle, und
 * heute (Ortstag der Person) noch nicht gesendet. Zusätzlich an eine früheste
 * Ortszeit gebunden (`earliestMinutes`, Minuten seit Mitternacht) — damit die
 * Warnung nicht direkt nach dem Tageswechsel um Mitternacht rausgeht, sondern
 * erst ab dieser Uhrzeit (in der Praxis die erste Erinnerungszeit der Person).
 * `nowMinutesOfDay` ist die aktuelle Ortszeit der Person. Fehlt einer der beiden
 * Zeitwerte, greift sie wie früher am ersten Tick, an dem die Bedingung stimmt.
 */
export function disputeAlertDue({ enabled, openCount, threshold, sentToday, nowMinutesOfDay, earliestMinutes }) {
  if (!enabled || sentToday) return false;
  const count = Number(openCount);
  const limit = Number(threshold);
  if (!Number.isFinite(count) || !Number.isFinite(limit)) return false;
  if (count < limit) return false;
  const nowMin = Number(nowMinutesOfDay);
  const earliest = Number(earliestMinutes);
  if (Number.isFinite(nowMin) && Number.isFinite(earliest) && nowMin < earliest) return false;
  return true;
}
