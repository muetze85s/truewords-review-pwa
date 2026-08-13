export declare function bytesToBase64url(bytes: Uint8Array | ArrayBuffer): string;
export declare function base64urlToBytes(value: string): Uint8Array;
export declare function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
): Promise<Uint8Array>;
export declare function vapidAuthorization(
  endpoint: string,
  vapidPublic: string,
  vapidPrivate: string,
  subject: string,
): Promise<string>;
export type PushSubscription = { endpoint: string; p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string };
export declare function sendPush(
  subscription: PushSubscription,
  payloadString: string,
  vapid: Vapid,
): Promise<number>;
