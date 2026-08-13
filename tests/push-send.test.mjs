import assert from 'node:assert/strict';
import {
  encryptPayload,
  vapidAuthorization,
  bytesToBase64url,
  base64urlToBytes,
} from '../push-send.mjs';

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

console.log('push-send tests: PASS');
