/**
 * Web-Push-Versand: VAPID-Authentifizierung (RFC 8292) + Nutzlast-Verschlüsselung
 * aes128gcm (RFC 8291 / RFC 8188). Nutzt ausschließlich Web Crypto (global
 * `crypto`), läuft damit im Cloudflare-Worker UND in Node — deshalb im
 * Round-Trip testbar (tests/push-send.test.mjs), bevor je ein echtes Gerät
 * angesprochen wird.
 */

const textEncoder = new TextEncoder();
const te = (value) => textEncoder.encode(value);

export function bytesToBase64url(bytes) {
  let binary = '';
  const array = new Uint8Array(bytes);
  for (let index = 0; index < array.length; index += 1) binary += String.fromCharCode(array[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function base64urlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concat(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

async function hmacSha256(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, messageBytes));
}

// HKDF (RFC 5869) über HMAC-SHA256; Ausgabelänge <= 32, daher ein Expand-Block.
const hkdfExtract = (salt, ikm) => hmacSha256(salt, ikm);
async function hkdfExpand(prk, info, length) {
  const block = await hmacSha256(prk, concat(info, Uint8Array.of(1)));
  return block.slice(0, length);
}

/**
 * Verschlüsselt die Nutzlast für ein Abo nach RFC 8291 (aes128gcm). Liefert den
 * fertigen Body: salt(16) || rs(4) || idlen(1)=65 || AS-Public(65) || Ciphertext.
 */
export async function encryptPayload(plaintext, uaPublic, authSecret) {
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // Schlüssel-Kombination (RFC 8291 §3.4): auth_secret als salt, ecdh als ikm.
  const keyInfo = concat(te('WebPush: info'), Uint8Array.of(0), uaPublic, asPublic);
  const ikm = await hkdfExpand(await hkdfExtract(authSecret, ecdhSecret), keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, concat(te('Content-Encoding: aes128gcm'), Uint8Array.of(0)), 16);
  const nonce = await hkdfExpand(prk, concat(te('Content-Encoding: nonce'), Uint8Array.of(0)), 12);

  // Einziger Record: Klartext || 0x02 (Abschluss-Delimiter, RFC 8188).
  const record = concat(plaintext, Uint8Array.of(2));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false); // rs
  header[20] = 65; // idlen der AS-Public-Key
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** VAPID-Authorization-Header (RFC 8292, „vapid t=<jwt>, k=<public>"). */
export async function vapidAuthorization(endpoint, vapidPublic, vapidPrivate, subject) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const header = bytesToBase64url(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToBase64url(te(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${payload}`;

  const pub = base64urlToBytes(vapidPublic);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: vapidPrivate,
    x: bytesToBase64url(pub.slice(1, 33)),
    y: bytesToBase64url(pub.slice(33, 65)),
    ext: true,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te(signingInput)));
  const jwt = `${signingInput}.${bytesToBase64url(signature)}`;
  return `vapid t=${jwt}, k=${vapidPublic}`;
}

/**
 * Sendet eine verschlüsselte Push-Nachricht an ein Abo. Liefert den HTTP-Status
 * des Push-Dienstes: 201 = zugestellt; 404/410 = Abo abgelaufen (löschen).
 */
export async function sendPush(subscription, payloadString, vapid) {
  const body = await encryptPayload(
    te(payloadString),
    base64urlToBytes(subscription.p256dh),
    base64urlToBytes(subscription.auth),
  );
  const authorization = await vapidAuthorization(subscription.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
    },
    body,
  });
  return response.status;
}
