// Supabase Edge Function: shift-reminders
// Scheduled cron (every 10 min) — fires push notifications for upcoming shifts
// even when no users have the app open.
//
// Reminder windows:
//   24h  — shift is 2h–25h away  (fires once per shift)
//   1h   — shift is 15min–2h away (fires once per shift)
//
// Also fires in-app notifications so they appear the next time the user opens the app.
// Deduplication is tracked in appData.sentShiftReminders (keyed by shift ID + window).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@commuterlife.com";

// ── Crypto helpers (copied from send-push so this function is self-contained) ─

function b64uToBytes(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64u(arr: Uint8Array): string {
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importVapidPrivateKey(): Promise<CryptoKey> {
  const raw = b64uToBytes(VAPID_PRIVATE_KEY);
  const pub = b64uToBytes(VAPID_PUBLIC_KEY);
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: bytesToB64u(raw), x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)) },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

async function vapidJwt(audience: string, privateKey: CryptoKey): Promise<string> {
  const enc = (o: unknown) => bytesToB64u(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(unsigned));
  return unsigned + "." + bytesToB64u(new Uint8Array(sig));
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

async function encryptPayload(payload: Uint8Array, keys: { p256dh: string; auth: string }): Promise<Uint8Array> {
  const subPubBytes = b64uToBytes(keys.p256dh);
  const subPub = await crypto.subtle.importKey("raw", subPubBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const auth = b64uToBytes(keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: subPub }, local.privateKey, 256));
  const infoPrefix = new TextEncoder().encode("WebPush: info\0");
  const keyInfo = new Uint8Array(infoPrefix.length + subPubBytes.length + localPub.length);
  keyInfo.set(infoPrefix); keyInfo.set(subPubBytes, infoPrefix.length); keyInfo.set(localPub, infoPrefix.length + subPubBytes.length);
  const ikm = await hkdf(auth, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const padded = new Uint8Array(payload.length + 1);
  padded.set(payload); padded[payload.length] = 2;
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  const out = new Uint8Array(16 + 4 + 1 + localPub.length + ct.length);
  out.set(salt); out.set(rs, 16); out[20] = localPub.length; out.set(localPub, 21); out.set(ct, 21 + localPub.length);
  return out;
}

async function sendWebPush(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  title: string,
  body: string,
  tag: string,
  icon: string,
  privateKey: CryptoKey
): Promise<{ ok: boolean; status: number }> {
  const payload = new TextEncoder().encode(JSON.stringify({ title, body, icon, tag, data: { type: tag } }));
  const encrypted = await encryptPayload(payload, sub.keys);
  const audience = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt(audience, privateKey);
  const resp = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
      TTL: "86400",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Urgency: "high",
    },
    body: encrypted,
  });
  return { ok: resp.ok, status: resp.status };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function workerUserName(workerId: string, workers: any[], users: any[]): string | null {
  const w = workers.find((w: any) => w.id === workerId);
  if (!w?.email) return null;
  const u = users.find((u: any) => u.email?.toLowerCase() === w.email.toLowerCase());
  return u?.name || w.email.split("@")[0] || null;
}

function fmt12h(t: string): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function makeId(): string {
  return "notif_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

const ICON_MAP: Record<string, string> = {
  shift_reminder: "⏰", shift_added: "📅", shift_cancelled: "❌",
  swap_request: "🔄", swap_approved: "✅", swap_denied: "❌", volunteer_open: "🙋",
};
const BG_MAP: Record<string, string> = {
  shift_reminder: "rgba(255,149,0,0.15)", shift_added: "rgba(10,132,255,0.15)",
  shift_cancelled: "rgba(255,59,48,0.15)", swap_request: "rgba(191,90,242,0.15)",
  swap_approved: "rgba(52,199,89,0.15)", swap_denied: "rgba(255,59,48,0.15)",
  volunteer_open: "rgba(255,204,0,0.15)",
};

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase.from("app_state").select("data").eq("id", 1).single();
  if (error || !data?.data) {
    console.error("shift-reminders: could not read app_state", error);
    return new Response(JSON.stringify({ error: "app_state unavailable" }), { status: 500 });
  }

  const appData = data.data as any;
  const workers: any[] = appData.workers || [];
  const shifts: any[] = appData.shifts || [];
  const users: any[] = appData.settings?.users || [];
  const subscriptions: Record<string, any> = appData.pushSubscriptions || {};
  const notifications: Record<string, any[]> = appData.notifications || {};

  // Deduplication store — keyed "24h_<shiftId>" / "1h_<shiftId>"
  if (!appData.sentShiftReminders) appData.sentShiftReminders = {};
  const sent: Record<string, string> = appData.sentShiftReminders;

  const now = new Date();
  let privateKey: CryptoKey | null = null;
  if (VAPID_PRIVATE_KEY && VAPID_PUBLIC_KEY) {
    try { privateKey = await importVapidPrivateKey(); } catch (e) { console.warn("VAPID key import failed", e); }
  }

  type PushJob = { userName: string; title: string; body: string; tag: string };
  const pushJobs: PushJob[] = [];
  let modified = false;

  function queueNotif(userName: string, type: string, title: string, body: string) {
    if (!notifications[userName]) notifications[userName] = [];
    notifications[userName].unshift({
      id: makeId(), type, title, body,
      icon: ICON_MAP[type] || "🔔",
      iconBg: BG_MAP[type] || "rgba(10,132,255,0.15)",
      read: false,
      timestamp: now.toISOString(),
    });
    notifications[userName] = notifications[userName].slice(0, 100);
    pushJobs.push({ userName, title, body, tag: `cl-${type}-${Date.now()}` });
    modified = true;
  }

  // ── Shift reminders ──────────────────────────────────────────────────────────
  for (const shift of shifts) {
    if (shift.volunteerSlot || !shift.workerId || shift.workerId === "open") continue;

    const userName = workerUserName(shift.workerId, workers, users);
    if (!userName) continue;

    const shiftDT = new Date(shift.date + "T" + (shift.startTime || "09:00"));
    const msUntil = shiftDT.getTime() - now.getTime();
    if (msUntil <= 0) continue;

    const hoursUntil = msUntil / 3_600_000;
    const timeStr = shift.startTime ? fmt12h(shift.startTime) : "";
    const roleStr = shift.role ? " — " + shift.role : "";

    // 24-hour window: 2h–25h before shift
    const key24 = `24h_${shift.id}`;
    if (hoursUntil <= 25 && hoursUntil > 2 && !sent[key24]) {
      queueNotif(userName, "shift_reminder", "⏰ Shift Tomorrow",
        `You have a shift tomorrow${timeStr ? " at " + timeStr : ""}${roleStr}.`);
      sent[key24] = now.toISOString();
    }

    // 1-hour window: 15min–2h before shift
    const key1h = `1h_${shift.id}`;
    if (hoursUntil <= 2 && hoursUntil > 0.25 && !sent[key1h]) {
      queueNotif(userName, "shift_reminder", "⏰ Shift Starting Soon",
        `Your shift starts${timeStr ? " at " + timeStr : " soon"}${roleStr}.`);
      sent[key1h] = now.toISOString();
    }
  }

  // ── Clean up reminder keys older than 7 days ─────────────────────────────────
  const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  for (const key of Object.keys(sent)) {
    if (sent[key] < cutoff) delete sent[key];
  }

  // ── Persist changes to app_state ─────────────────────────────────────────────
  const pushResults: Record<string, string> = {};

  if (modified) {
    appData.notifications = notifications;
    appData.sentShiftReminders = sent;

    const { error: saveErr } = await supabase
      .from("app_state")
      .update({ data: appData })
      .eq("id", 1);

    if (saveErr) console.error("shift-reminders: save failed", saveErr);

    // ── Send real push notifications ─────────────────────────────────────────
    if (privateKey) {
      for (const job of pushJobs) {
        const sub = subscriptions[job.userName];
        if (!sub?.endpoint || !sub?.keys) {
          pushResults[job.userName] = "no_subscription";
          continue;
        }
        try {
          const { ok, status } = await sendWebPush(
            sub, job.title, job.body, job.tag,
            appData.settings?.appIconUrl || "",
            privateKey
          );
          pushResults[job.userName] = ok ? "sent" : `error_${status}`;

          // Remove expired subscriptions
          if (status === 404 || status === 410) {
            delete subscriptions[job.userName];
            await supabase.from("app_state")
              .update({ data: { ...appData, pushSubscriptions: subscriptions } })
              .eq("id", 1);
            pushResults[job.userName] = "subscription_expired";
          }
        } catch (e) {
          pushResults[job.userName] = "error: " + (e as Error).message;
        }
      }
    } else {
      console.warn("shift-reminders: VAPID keys not set — skipping Web Push delivery");
    }
  }

  const summary = {
    checkedShifts: shifts.length,
    remindersQueued: pushJobs.length,
    pushResults,
    modified,
    ranAt: now.toISOString(),
  };
  console.log("shift-reminders:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary), {
    headers: { "Content-Type": "application/json" },
  });
});
