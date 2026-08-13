import assert from 'node:assert/strict';
import {
  localParts,
  localYmd,
  parseHhmm,
  dueReminderSlots,
  disputeAlertDue,
} from '../push-schedule-logic.mjs';

const BERLIN = 'Europe/Berlin';
const BANGKOK = 'Asia/Bangkok';

// --- Ortszeit inkl. Sommer-/Winterzeit -------------------------------------

{
  // Sommer: Berlin = UTC+2. 07:00 UTC → 09:00 Ortszeit.
  const summer = localParts(new Date('2026-07-01T07:00:00Z'), BERLIN);
  assert.equal(summer.hour, 9, 'Berlin im Sommer ist UTC+2');
  assert.equal(summer.minute, 0);
  assert.equal(summer.ymd, '2026-07-01');

  // Winter: Berlin = UTC+1. 08:00 UTC → 09:00 Ortszeit.
  const winter = localParts(new Date('2026-01-01T08:00:00Z'), BERLIN);
  assert.equal(winter.hour, 9, 'Berlin im Winter ist UTC+1');

  // Bangkok fix UTC+7, keine Sommerzeit. 02:00 UTC → 09:00 Ortszeit.
  const bkkSummer = localParts(new Date('2026-07-01T02:00:00Z'), BANGKOK);
  const bkkWinter = localParts(new Date('2026-01-01T02:00:00Z'), BANGKOK);
  assert.equal(bkkSummer.hour, 9, 'Bangkok ganzjährig UTC+7');
  assert.equal(bkkWinter.hour, 9, 'Bangkok ganzjährig UTC+7, keine Sommerzeit');

  // Tageswechsel über die Zeitzone: 23:30 UTC ist in Bangkok schon der nächste Tag.
  assert.equal(localYmd(new Date('2026-03-10T23:30:00Z'), BANGKOK), '2026-03-11');
  assert.equal(localYmd(new Date('2026-03-10T23:30:00Z'), BERLIN), '2026-03-11');
}

// --- parseHhmm --------------------------------------------------------------

{
  assert.equal(parseHhmm('09:00'), 540);
  assert.equal(parseHhmm('9:05'), 545);
  assert.equal(parseHhmm('23:59'), 1439);
  assert.equal(parseHhmm('24:00'), null);
  assert.equal(parseHhmm('12:60'), null);
  assert.equal(parseHhmm('abc'), null);
  assert.equal(parseHhmm(''), null);
}

// --- Erinnerungen: Sommerzeit korrekt, nichts doppelt ----------------------

{
  const times = ['09:00', '18:00'];

  // Lena, Berlin, Sommer: um 08:59 Ortszeit (06:59 UTC) ist 09:00 noch NICHT fällig.
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-07-01T06:59:00Z'),
      timeZone: BERLIN, times, enabled: true, submittedToday: false, sentSlotsToday: [],
    }),
    [],
    'vor 09:00 Ortszeit nichts fällig',
  );

  // Um 09:00 Ortszeit (07:00 UTC im Sommer) ist Slot 0 fällig.
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-07-01T07:00:00Z'),
      timeZone: BERLIN, times, enabled: true, submittedToday: false, sentSlotsToday: [],
    }),
    [0],
    'ab 09:00 Ortszeit ist die erste Erinnerung fällig (Sommerzeit)',
  );

  // Im WINTER ist 09:00 Ortszeit erst um 08:00 UTC — bei 07:00 UTC (=08:00 Ortszeit)
  // darf noch nichts fällig sein. Genau das darf die Sommerzeit nicht verwaschen.
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-01-01T07:00:00Z'),
      timeZone: BERLIN, times, enabled: true, submittedToday: false, sentSlotsToday: [],
    }),
    [],
    'im Winter ist 07:00 UTC erst 08:00 Ortszeit — noch nichts fällig',
  );
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-01-01T08:00:00Z'),
      timeZone: BERLIN, times, enabled: true, submittedToday: false, sentSlotsToday: [],
    }),
    [0],
    'im Winter wird 09:00 Ortszeit erst um 08:00 UTC fällig',
  );

  // Nichts doppelt: Slot 0 heute schon gesendet → nicht erneut, aber Slot 1 (18:00)
  // wird abends fällig.
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-07-01T16:00:00Z'), // 18:00 Berlin Sommer
      timeZone: BERLIN, times, enabled: true, submittedToday: false, sentSlotsToday: [0],
    }),
    [1],
    'bereits gesendeter Slot 0 wird nicht wiederholt, Slot 1 kommt dazu',
  );
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-07-01T16:00:00Z'),
      timeZone: BERLIN, times, enabled: true, submittedToday: false, sentSlotsToday: [0, 1],
    }),
    [],
    'beide Slots heute gesendet → nichts mehr fällig',
  );

  // Hat heute schon eine Runde abgegeben → keine Erinnerung.
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-07-01T16:00:00Z'),
      timeZone: BERLIN, times, enabled: true, submittedToday: true, sentSlotsToday: [],
    }),
    [],
    'nach Abgabe an dem Tag keine Erinnerung',
  );

  // Schalter aus → nichts.
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-07-01T16:00:00Z'),
      timeZone: BERLIN, times, enabled: false, submittedToday: false, sentSlotsToday: [],
    }),
    [],
    'Schalter aus → nichts',
  );

  // Beide Zeiten überschritten, noch nichts gesendet → beide fällig (nachgeholt).
  assert.deepEqual(
    dueReminderSlots({
      now: new Date('2026-07-01T20:00:00Z'), // 22:00 Berlin
      timeZone: BERLIN, times, enabled: true, submittedToday: false, sentSlotsToday: [],
    }),
    [0, 1],
    'verpasste Ticks werden nachgeholt, aber je Slot nur einmal (Dedup an anderer Stelle)',
  );
}

// --- Streitfall-Warnung -----------------------------------------------------

{
  assert.equal(disputeAlertDue({ enabled: true, openCount: 5, threshold: 5, sentToday: false }), true, 'genau an der Schwelle');
  assert.equal(disputeAlertDue({ enabled: true, openCount: 6, threshold: 5, sentToday: false }), true, 'über der Schwelle');
  assert.equal(disputeAlertDue({ enabled: true, openCount: 4, threshold: 5, sentToday: false }), false, 'unter der Schwelle');
  assert.equal(disputeAlertDue({ enabled: true, openCount: 9, threshold: 5, sentToday: true }), false, 'heute schon gesendet');
  assert.equal(disputeAlertDue({ enabled: false, openCount: 9, threshold: 5, sentToday: false }), false, 'Schalter aus');
}

console.log('push-schedule-logic tests: PASS');
