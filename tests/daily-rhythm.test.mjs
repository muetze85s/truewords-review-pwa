import assert from 'node:assert/strict';
import { hourlyAggregates } from '../daily-rhythm.mjs';

const utc = (iso) => Math.floor(Date.parse(iso) / 1000);

// --- Stundenzuordnung inkl. Sommerzeit --------------------------------------
{
  const result = hourlyAggregates([
    // Winter: UTC+1 → 12:00 UTC = 13:00 Berlin.
    { t: utc('2026-01-15T12:00:00Z'), from: 'Philipp' },
    // Sommer: UTC+2 → 12:00 UTC = 14:00 Berlin.
    { t: utc('2026-07-15T12:00:00Z'), from: 'Philipp' },
    // Tageswechsel über die Zone: 23:30 UTC im Winter = 00:30 Berlin.
    { t: utc('2026-12-01T23:30:00Z'), from: 'Lena' },
  ]);
  assert.equal(result.timezone, 'Europe/Berlin');
  assert.equal(result.msgPerHourBySender.Philipp[13], 1, 'Winter: 12 UTC → 13 Berlin');
  assert.equal(result.msgPerHourBySender.Philipp[14], 1, 'Sommer: 12 UTC → 14 Berlin');
  assert.equal(result.msgPerHourBySender.Lena[0], 1, '23:30 UTC → 00:30 Berlin');
  assert.equal(result.msgPerHourBySender.Philipp.reduce((a, b) => a + b, 0), 2);
}

// --- Pausenklassen und Startstunde ------------------------------------------
{
  const base = utc('2026-01-10T09:00:00Z'); // 10:00 Berlin (Winter)
  const entries = [
    { t: base, from: 'Philipp' },
    { t: base + 2 * 3600, from: 'Lena' },      // Pause 2 h  → 1–4 h, Start 10 Berlin
    { t: base + 8 * 3600, from: 'Philipp' },   // Pause 6 h  → 4–12 h, Start 12 Berlin
    { t: base + 28 * 3600, from: 'Lena' },     // Pause 20 h → >12 h, Start 18 Berlin
    { t: base + 29 * 3600, from: 'Philipp' },  // Pause exakt 1 h → zählt NICHT (> 1 h)
    { t: base + 33 * 3600, from: 'Lena' },     // Pause exakt 4 h → 1–4 h (obere Kante einschließlich)
  ];
  const { gapStartHour } = hourlyAggregates(entries);
  const short = gapStartHour.classes['1-4h'].counts;
  const mid = gapStartHour.classes['4-12h'].counts;
  const long = gapStartHour.classes.over12h.counts;
  assert.equal(short[10], 1, '2-h-Pause beginnt 10 Uhr Berlin');
  assert.equal(mid[12], 1, '6-h-Pause beginnt 12 Uhr Berlin');
  assert.equal(long[18], 1, '20-h-Pause beginnt 18 Uhr Berlin');
  assert.equal(short.reduce((a, b) => a + b, 0), 2, 'genau zwei kurze Pausen (2 h und exakt 4 h)');
  assert.equal(mid.reduce((a, b) => a + b, 0), 1);
  assert.equal(long.reduce((a, b) => a + b, 0), 1);
  // Die exakt-1-h-Pause ist nirgends gezählt: 2+1+1 = 4 von 5 Übergängen.
  const total = [short, mid, long].flat().reduce((a, b) => a + b, 0);
  assert.equal(total, 4);
}

// --- Randfälle ---------------------------------------------------------------
{
  const result = hourlyAggregates([
    { t: 0, from: 'X' },                        // t ≤ 0 → übersprungen
    { t: utc('2026-03-01T10:00:00Z'), from: '' }, // leerer Name → '?'
  ]);
  assert.equal(result.skippedNoTimestamp, 1);
  assert.ok(result.msgPerHourBySender['?'], 'leerer Absender fällt auf ?');
  const empty = hourlyAggregates([]);
  assert.equal(Object.keys(empty.msgPerHourBySender).length, 0);
  assert.equal(empty.gapStartHour.classes['1-4h'].counts.length, 24);
}

console.log('daily-rhythm tests: PASS');
