/**
 * Schwellwert-Optimizer (Phase 1): Grid Search über PAUSE_BOUNDARY_HOURS.
 *
 * Ruft den Worker-Endpunkt GET /api/admin/optimize-threshold auf und gibt
 * die Ergebnisse als Tabelle aus. Benötigt eine laufende Instanz (lokal
 * oder deployed) und Prüfer-Auth (Session-Cookie).
 *
 * Aufruf:
 *   REVIEW_API_URL=https://… REVIEW_SESSION=<cookie> node scripts/optimize-threshold.mjs
 *
 * Optionale Parameter:
 *   --min 15      Minimum in Minuten (Standard: 15)
 *   --max 720     Maximum in Minuten (Standard: 720)
 *   --step 15     Schrittweite in Minuten (Standard: 15)
 *   --tol 0       Toleranz (0, 1, 2; Standard: 1)
 *   --doubt skip  doubt-Modus (skip, cut, none; Standard: skip)
 */

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    result[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const apiBase = String(process.env.REVIEW_API_URL || 'http://localhost:8787').replace(/\/$/, '');
const sessionCookie = String(process.env.REVIEW_SESSION || '');

if (!sessionCookie) {
  throw new Error(
    'REVIEW_SESSION fehlt. Setze den Session-Cookie-Wert (tw_review_session_v2) als Umgebungsvariable.\n'
    + 'Beispiel: REVIEW_SESSION=abc123… node scripts/optimize-threshold.mjs',
  );
}

const params = new URLSearchParams();
if (args.min) params.set('min', args.min);
if (args.max) params.set('max', args.max);
if (args.step) params.set('step', args.step);
if (args.tol) params.set('tol', args.tol);
if (args.doubt) params.set('doubt', args.doubt);

const url = `${apiBase}/api/admin/optimize-threshold?${params}`;
const response = await fetch(url, {
  headers: { cookie: `tw_review_session_v2=${sessionCookie}` },
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`HTTP ${response.status}: ${body}`);
}

const data = await response.json();
if (!data.ok) throw new Error(data.error || 'Unbekannter Fehler.');

console.log(`\nDataset: ${data.dataset}`);
console.log(`Runden: ${data.roundsUsed}  |  Toleranz: ${data.tolerance}  |  Doubt: ${data.doubtMode}`);
console.log(`Aktueller Schwellwert: ${data.currentThresholdHours} h\n`);

console.log('  Schwelle     F1      Paare  nurAuto  nurMensch');
console.log('  ' + '-'.repeat(50));

for (const row of data.grid) {
  const marker = row.thresholdMinutes === data.currentThresholdHours * 60 ? ' ◀' : '';
  const best = data.best && row.thresholdMinutes === data.best.thresholdMinutes ? ' ★' : '';
  console.log(
    `  ${String(row.thresholdMinutes).padStart(4)} min`
    + `  ${row.f1.toFixed(4).padStart(7)}`
    + `  ${String(row.pairs).padStart(7)}`
    + `  ${String(row.onlyAuto).padStart(7)}`
    + `  ${String(row.onlyHuman).padStart(9)}`
    + marker + best,
  );
}

if (data.best) {
  console.log(`\nBester Schwellwert: ${data.best.thresholdMinutes} min (${data.best.thresholdHours} h)  →  F1 ${data.best.f1.toFixed(4)}`);
}
