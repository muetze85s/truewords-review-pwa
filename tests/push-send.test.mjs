import assert from 'node:assert/strict';
import {
  encryptPayload,
  vapidAuthorization,
  bytesToBase64url,
  base64urlToBytes,
} from '../push-send.mjs';
import { pushAllowedFor, dueReminderSlots, disputeAlertDue } from '../push-schedule-logic.mjs';

const te = (value) => new TextEncoder().encode(value);
const td = (bytes) => new TextDecoder().decode(bytes);

function concat(...chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
}
const extract = (salt, ikm) => hmac(salt, ikm);
async function expand(prk, info, length) {
  return (await hmac(prk, concat(info, Uint8Array.of(1)))).slice(0, length);
}

// --- Round-Trip: verschlüsseln → unabhängig entschlüsseln -------------------

{
  // Empfänger (Gerät) erzeugt sein ECDH-Paar + auth-Secret, wie beim echten Abo.
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  const message = 'TrueWords: Lena hat Runde 7 abgegeben.';
  const body = await encryptPayload(te(message), uaPublic, authSecret);

  // Body zerlegen (RFC 8188 Header): salt(16) | rs(4) | idlen(1) | AS-Public | Ciphertext
  const salt = body.slice(0, 16);
  const idlen = body[20];
  assert.equal(idlen, 65, 'AS-Public-Key ist 65 Bytes');
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  // Empfängerseitig entschlüsseln.
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const keyInfo = concat(te('WebPush: info'), Uint8Array.of(0), uaPublic, asPublic);
  const ikm = await expand(await extract(authSecret, ecdh), keyInfo, 32);
  const prk = await extract(salt, ikm);
  const cek = await expand(prk, concat(te('Content-Encoding: aes128gcm'), Uint8Array.of(0)), 16);
  const nonce = await expand(prk, concat(te('Content-Encoding: nonce'), Uint8Array.of(0)), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext));

  assert.equal(plain[plain.length - 1], 2, 'Record endet auf 0x02-Delimiter');
  assert.equal(td(plain.slice(0, -1)), message, 'entschlüsselter Text entspricht dem Original');
}

// --- VAPID-JWT: Signatur prüfbar, Felder korrekt ---------------------------

{
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const VAPID_PUBLIC = bytesToBase64url(rawPub);
  const VAPID_PRIVATE = jwk.d;
  const subject = 'mailto:philipp.sellin@googlemail.com';
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';

  const authorization = await vapidAuthorization(endpoint, VAPID_PUBLIC, VAPID_PRIVATE, subject);
  const match = /^vapid t=([^,]+), k=(.+)$/u.exec(authorization);
  assert.ok(match, 'Authorization hat die Form vapid t=…, k=…');
  const [, jwt, k] = match;
  assert.equal(k, VAPID_PUBLIC, 'k ist der VAPID-Public-Key');

  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(td(base64urlToBytes(h)));
  const payload = JSON.parse(td(base64urlToBytes(p)));
  assert.equal(header.alg, 'ES256');
  assert.equal(payload.aud, 'https://fcm.googleapis.com', 'aud ist der Origin des Endpunkts');
  assert.equal(payload.sub, subject);
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'exp liegt in der Zukunft');

  const verifyKey = await crypto.subtle.importKey('raw', base64urlToBytes(VAPID_PUBLIC), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    base64urlToBytes(s),
    te(`${h}.${p}`),
  );
  assert.ok(ok, 'JWT-Signatur ist mit dem VAPID-Public-Key gültig');
}

// --- Hauptschalter: aus = keinerlei Zustellung, ausnahmslos ---------------
//
// Der Hauptschalter (push_enabled_<person>, Migration 0017) wird an genau
// einer Stelle durchgesetzt: notifyReviewer in worker-push.ts fragt
// pushAllowedFor() und bricht bei „aus" ab, bevor irgendein Abo geladen wird.
// Alle vier Anlässe — Abgabe des Partners, Streitfall-Alarm, Cron-Erinnerung
// und der Test-Push — laufen durch dieselbe Funktion. Getestet wird deshalb
// hier die Entscheidung, die alle vier gemeinsam gatet, plus die Zusicherung,
// dass sie unabhängig vom jeweiligen Anlass-Schalter greift.

// Die vier Anlässe, wie sie in worker-push.ts vor notifyReviewer geprüft werden.
const ANLAESSE = ['abgabe', 'streitfall', 'cron', 'test'];

// Nachbildung der Aufrufkette: erst der Anlass-Schalter (sofern es einen gibt),
// dann — immer — der Hauptschalter in notifyReviewer.
function zustellung(settings, reviewer, anlass) {
  const anlassSchalter = {
    abgabe: reviewer === 'Philipp'
      ? Number(settings.notify_philipp_on_lena_submit) === 1
      : Number(settings.notify_lena_on_philipp_submit) === 1,
    streitfall: reviewer === 'Philipp'
      ? Number(settings.dispute_alert_philipp_enabled) === 1
      : Number(settings.dispute_alert_lena_enabled) === 1,
    // Cron-Erinnerung: die Zeit selbst ist der Anlass-Schalter (leer = aus).
    cron: Boolean(reviewer === 'Philipp' ? settings.philipp_time_1 : settings.lena_time_1),
    // Der Test hat bewusst keinen eigenen Schalter — nur den Hauptschalter.
    test: true,
  }[anlass];
  if (!anlassSchalter) return false;
  return pushAllowedFor(settings, reviewer);
}

const alleAn = (master) => ({
  push_enabled_philipp: master,
  push_enabled_lena: master,
  notify_philipp_on_lena_submit: 1,
  notify_lena_on_philipp_submit: 1,
  dispute_alert_philipp_enabled: 1,
  dispute_alert_lena_enabled: 1,
  philipp_time_1: '09:00',
  lena_time_1: '09:00',
});

for (const reviewer of ['Philipp', 'Lena']) {
  // Hauptschalter aus → nichts geht raus, für jeden der vier Anlässe.
  const aus = alleAn(1);
  aus[reviewer === 'Philipp' ? 'push_enabled_philipp' : 'push_enabled_lena'] = 0;
  for (const anlass of ANLAESSE) {
    assert.equal(
      zustellung(aus, reviewer, anlass), false,
      `Hauptschalter aus (${reviewer}): ${anlass} darf nicht zugestellt werden`,
    );
  }

  // Hauptschalter an → alle vier stellen zu, sofern der Anlass-Schalter an ist.
  const an = alleAn(1);
  for (const anlass of ANLAESSE) {
    assert.equal(
      zustellung(an, reviewer, anlass), true,
      `Hauptschalter an (${reviewer}): ${anlass} wird zugestellt`,
    );
  }
}

// Symmetrie: die Schalter sind voneinander unabhängig — Philipp aus lässt Lena
// unberührt und umgekehrt.
{
  const nurPhilippAus = alleAn(1);
  nurPhilippAus.push_enabled_philipp = 0;
  assert.equal(pushAllowedFor(nurPhilippAus, 'Philipp'), false, 'Philipp aus');
  assert.equal(pushAllowedFor(nurPhilippAus, 'Lena'), true, 'Lena bleibt an');

  const nurLenaAus = alleAn(1);
  nurLenaAus.push_enabled_lena = 0;
  assert.equal(pushAllowedFor(nurLenaAus, 'Lena'), false, 'Lena aus');
  assert.equal(pushAllowedFor(nurLenaAus, 'Philipp'), true, 'Philipp bleibt an');
}

// Alte Zeile ohne die Spalten (vor Migration 0017): „an" — ein fehlender Wert
// darf keine stillschweigende Abschaltung sein.
assert.equal(pushAllowedFor({}, 'Philipp'), true, 'fehlende Spalte gilt als an');
assert.equal(pushAllowedFor(null, 'Lena'), true, 'fehlende Zeile gilt als an');

// Der Hauptschalter ersetzt keinen Anlass-Schalter: an, aber Anlass aus → nichts.
{
  const anlassAus = alleAn(1);
  anlassAus.dispute_alert_philipp_enabled = 0;
  assert.equal(zustellung(anlassAus, 'Philipp', 'streitfall'), false, 'Streitfall-Schalter aus wirkt weiterhin');
  assert.equal(zustellung(anlassAus, 'Philipp', 'abgabe'), true, 'andere Anlässe bleiben davon unberührt');
}

// Die Erinnerung hat keinen eigenen dritten Schalter mehr: eine leere Zeit ist
// die Abschaltung dieser Zeit (dueReminderSlots überspringt sie), der
// Hauptschalter greift zentral im Versand.
{
  const slots = dueReminderSlots({
    now: new Date('2026-08-20T07:05:00Z'),
    timeZone: 'Europe/Berlin',
    times: ['', ''],
    enabled: true,
    submittedToday: false,
    sentSlotsToday: [],
  });
  assert.deepEqual(slots, [], 'leere Zeiten lösen keine Erinnerung aus');
}

// Streitfall-Alarm bleibt an seinen Anlass-Bedingungen hängen (Schwelle),
// unabhängig vom Hauptschalter — der wirkt eine Ebene später.
assert.equal(
  disputeAlertDue({ enabled: true, openCount: 2, threshold: 5, sentToday: false, nowMinutesOfDay: 800, earliestMinutes: 780 }),
  false,
  'unter der Schwelle kein Alarm',
);

console.log('push-send tests: PASS');
