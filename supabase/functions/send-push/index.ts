// Supabase Edge Function: send-push
// Sends encrypted Web Push notifications with payload (required for iOS)
// Implements RFC 8291 (Web Push Encryption) using Web Crypto API

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@commuterlife.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function base64urlToUint8Array(b64url: string): Uint8Array {
  const padding = "=".repeat((4 - (b64url.length % 4)) % 4);
  const base64 = (b64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function uint8ArrayToBase64url(arr: Uint8Array): string {
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importVapidPrivateKey(): Promise<CryptoKey> {
  const raw = base64urlToUint8Array(VAPID_PRIVATE_KEY);
  const pubBytes = base64urlToUint8Array(VAPID_PUBLIC_KEY);

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: uint8ArrayToBase64url(raw),
    x: uint8ArrayToBase64url(pubBytes.slice(1, 33)),
    y: uint8ArrayToBase64url(pubBytes.slice(33, 65)),
  };

  return crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
}

async function createVapidJwt(audience: string, privateKey: CryptoKey): Promise<string> {
  const encode = (obj: unknown) =>
    uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(obj)));

  const header = encode({ typ: "JWT", alg: "ES256" });
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ aud: audience, exp: now + 12 * 3600, sub: VAPID_SUBJECT });
  const unsigned = header + "." + payload;

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(unsigned)
  );

  return unsigned + "." + uint8ArrayToBase64url(new Uint8Array(sig));
}

// --- RFC 8291 Web Push Encryption (aes128gcm) ---

async function encryptPayload(
  payload: Uint8Array,
  subscriptionKeys: { p256dh: string; auth: string }
): Promise<{ encrypted: Uint8Array; localPublicKey: Uint8Array }> {
  // Import subscriber's public key (p256dh)
  const subscriberPubBytes = base64urlToUint8Array(subscriptionKeys.p256dh);
  const subscriberPubKey = await crypto.subtle.importKey(
    "raw", subscriberPubBytes,
    { name: "ECDH", namedCurve: "P-256" }, false, []
  );

  // Auth secret from subscription
  const authSecret = base64urlToUint8Array(subscriptionKeys.auth);

  // Generate ephemeral ECDH key pair for this message
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const localPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey)
  );

  // ECDH shared secret
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: subscriberPubKey },
      localKeyPair.privateKey, 256
    )
  );

  // HKDF to derive IKM: HKDF-SHA-256(auth, sharedSecret, "WebPush: info\0" || subscriberPub || localPub, 32)
  const infoPrefix = new TextEncoder().encode("WebPush: info\0");
  const keyInfo = new Uint8Array(infoPrefix.length + subscriberPubBytes.length + localPublicKey.length);
  keyInfo.set(infoPrefix, 0);
  keyInfo.set(subscriberPubBytes, infoPrefix.length);
  keyInfo.set(localPublicKey, infoPrefix.length + subscriberPubBytes.length);

  const ikm = await hkdfDerive(authSecret, sharedSecret, keyInfo, 32);

  // Generate 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive Content Encryption Key (CEK): HKDF-SHA-256(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const cek = await hkdfDerive(salt, ikm, cekInfo, 16);

  // Derive nonce: HKDF-SHA-256(salt, ikm, "Content-Encoding: nonce\0", 12)
  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");
  const nonce = await hkdfDerive(salt, ikm, nonceInfo, 12);

  // Pad payload: payload || 0x02 (final record delimiter)
  const padded = new Uint8Array(payload.length + 1);
  padded.set(payload);
  padded[payload.length] = 2; // Final record padding delimiter

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey(
    "raw", cek, { name: "AES-GCM" }, false, ["encrypt"]
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce }, aesKey, padded
    )
  );

  // Build aes128gcm header: salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext
  const rs = payload.length + 1 + 16 + 1; // record size: padded content + tag overhead + padding byte
  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, 4096); // Use standard record size

  const header = new Uint8Array(16 + 4 + 1 + localPublicKey.length + ciphertext.length);
  header.set(salt, 0);
  header.set(rsBytes, 16);
  header[20] = localPublicKey.length; // idlen
  header.set(localPublicKey, 21);
  header.set(ciphertext, 21 + localPublicKey.length);

  return { encrypted: header, localPublicKey };
}

async function hkdfDerive(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", ikm, { name: "HKDF" }, false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key, length * 8
  );
  return new Uint8Array(derived);
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  try {
    const { targets, notification } = await req.json();
    if (!targets || !Array.isArray(targets) || targets.length === 0) {
      return new Response(JSON.stringify({ error: "Missing targets array" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Read push subscriptions from app_state
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase.from("app_state").select("data").eq("id", 1).single();
    if (error || !data?.data) {
      return new Response(JSON.stringify({ error: "Could not read app_state", details: error }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const subscriptions = data.data.pushSubscriptions || {};
    const privateKey = await importVapidPrivateKey();
    const results: Record<string, string> = {};

    // Build notification payload
    const notifPayload = notification
      ? JSON.stringify({
          title: notification.title || "New Notification",
          body: notification.body || "You have a new notification",
          icon: notification.icon || "",
          tag: notification.tag || "cab-notif",
          data: notification.data || {},
        })
      : JSON.stringify({ title: "New Notification", body: "You have a new notification" });

    const payloadBytes = new TextEncoder().encode(notifPayload);

    for (const userName of targets) {
      const sub = subscriptions[userName];
      if (!sub?.endpoint || !sub?.keys) {
        results[userName] = "no_subscription";
        continue;
      }

      try {
        const audience = new URL(sub.endpoint).origin;
        const jwt = await createVapidJwt(audience, privateKey);

        // Encrypt payload using Web Push encryption (RFC 8291)
        const { encrypted } = await encryptPayload(payloadBytes, sub.keys);

        const resp = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
            TTL: "86400",
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "Content-Length": String(encrypted.length),
            Urgency: "high",
          },
          body: encrypted,
        });

        const respText = await resp.text();
        results[userName] = resp.ok ? "sent" : `error_${resp.status}: ${respText}`;

        // Clean up expired subscriptions
        if (resp.status === 404 || resp.status === 410) {
          delete subscriptions[userName];
          await supabase
            .from("app_state")
            .update({ data: { ...data.data, pushSubscriptions: subscriptions } })
            .eq("id", 1);
          results[userName] = "subscription_expired";
        }
      } catch (err) {
        results[userName] = "error: " + (err as Error).message;
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
