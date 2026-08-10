/**
 * Zieht aus einem D1-Dump von review_chat_chunks nur die Zeitstempel und
 * Absender heraus — niemals Text, Medien oder IDs — und baut daraus:
 *   zeitstempel.json  [{ t, from }, ...]   Reihenfolge wie gespeichert
 *   pausen.json       [sekunden, ...]      Abstand zur vorherigen Nachricht
 *   pausen-absender.json { gleicherAbsender: [...], andererAbsender: [...] }
 *
 * Das Repository ist öffentlich, also sind auch die Action-Logs öffentlich.
 * Deshalb landen die Nutzdaten NICHT im Klartext im Log: sie werden mit
 * einem übergebenen öffentlichen Schlüssel verschlüsselt (AES-256-GCM,
 * Schlüssel per RSA-OAEP gekapselt) und nur als Base64-Block ausgegeben.
 * Im Klartext erscheinen ausschließlich Aggregatzahlen.
 *
 * Aufruf:
 *   node scripts/zeitstempel-from-d1.mjs <chunks-dump.json> <public-key.pem>
 */
import { readFileSync } from 'node:fs';
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';

const [dumpPath, publicKeyPath] = process.argv.slice(2);
if (!dumpPath || !publicKeyPath) {
  throw new Error('Aufruf: node scripts/zeitstempel-from-d1.mjs <chunks-dump.json> <public-key.pem>');
}

function seconds(message) {
  const raw = message?.date_unixtime ?? message?.timestamp ?? message?.date;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.floor(raw > 1e12 ? raw / 1000 : raw);
  }
  if (typeof raw === 'string' && /^\d+$/u.test(raw)) {
    const value = Number(raw);
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function fromName(message) {
  const value = message?.from;
  return typeof value === 'string' && value ? value : null;
}

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const rows = dump[0]?.results || [];

// Reihenfolge wie gespeichert: nach chunk_index, darin die Array-Reihenfolge.
const ordered = [...rows].sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index));
const zeitstempel = [];
for (const row of ordered) {
  const parsed = JSON.parse(row.messages_json);
  if (!Array.isArray(parsed)) continue;
  for (const message of parsed) {
    if (!message || typeof message !== 'object') continue;
    zeitstempel.push({ t: seconds(message), from: fromName(message) });
  }
}

// Pausen: Differenz zum jeweils vorherigen Zeitstempel. Übergänge, bei denen
// einer der beiden Werte null ist, werden übersprungen.
const pausen = [];
const gleicherAbsender = [];
const andererAbsender = [];
for (let index = 1; index < zeitstempel.length; index += 1) {
  const previous = zeitstempel[index - 1];
  const current = zeitstempel[index];
  if (previous.t === null || current.t === null) continue;
  const delta = current.t - previous.t;
  pausen.push(delta);
  if (previous.from !== null && current.from !== null && previous.from === current.from) {
    gleicherAbsender.push(delta);
  } else if (previous.from !== null && current.from !== null) {
    andererAbsender.push(delta);
  }
}

// ---------------------------------------------------- Aggregate (Klartext)
const withTimestamp = zeitstempel.filter((entry) => entry.t !== null);
const invalid = zeitstempel.length - withTimestamp.length;
const speakers = new Map();
for (const entry of zeitstempel) {
  const key = entry.from ?? '(ohne Absender)';
  speakers.set(key, (speakers.get(key) || 0) + 1);
}
const sortedTimes = withTimestamp.map((entry) => entry.t).sort((a, b) => a - b);

console.log('=== AGGREGATE ===');
console.log(`Nachrichten gesamt: ${zeitstempel.length}`);
console.log(`mit gültigem Zeitstempel: ${withTimestamp.length}`);
console.log(`ungültige Zeitstempel (t=null): ${invalid}`);
for (const [name, count] of [...speakers].sort((a, b) => b[1] - a[1])) {
  console.log(`  Absender ${name}: ${count}`);
}
if (sortedTimes.length) {
  console.log(`Zeitraum von: ${new Date(sortedTimes[0] * 1000).toISOString()}`);
  console.log(`Zeitraum bis: ${new Date(sortedTimes[sortedTimes.length - 1] * 1000).toISOString()}`);
}
console.log(`Übergänge gesamt: ${pausen.length}`);
console.log(`  davon gleicher Absender: ${gleicherAbsender.length}`);
console.log(`  davon anderer Absender: ${andererAbsender.length}`);
console.log(`negative Abstände (Reihenfolge nicht monoton): ${pausen.filter((d) => d < 0).length}`);

// ------------------------------------------- Nutzdaten (nur verschlüsselt)
const payload = JSON.stringify({
  zeitstempel,
  pausen,
  pausenAbsender: { gleicherAbsender, andererAbsender },
});

const key = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
const wrappedKey = publicEncrypt(
  { key: readFileSync(publicKeyPath, 'utf8'), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  key,
);

console.log('=== VERSCHLUESSELT BEGIN ===');
console.log(JSON.stringify({
  k: wrappedKey.toString('base64'),
  iv: iv.toString('base64'),
  tag: cipher.getAuthTag().toString('base64'),
  data: ciphertext.toString('base64'),
}));
console.log('=== VERSCHLUESSELT ENDE ===');
