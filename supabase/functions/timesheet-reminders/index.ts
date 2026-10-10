// Supabase Edge Function: timesheet-reminders
// Scheduled cron (Mondays 8:00 AM Arizona) — emails every member whose logged hours
// for the week that just ended fell short of their position's weekly minimum.
// Same rules as the CAB Timesheet app's Code.gs, sent through Brevo like
// send-password-reset (BREVO_API_KEY is read from the app_secrets table).
//
// Rules:
//   - Only members with a position whose minimum is > 0 are checked.
//   - Break-week pause: if fewer than `breakThreshold` members logged any hours
//     that week, it's assumed to be a break and nothing is sent.
//   - Each member is emailed at most once per week. Sends are recorded in
//     appData.timesheetEmailLog[weekStart][email], so re-running (or the admin's
//     "Send now" button) never double-sends.
//
// Settings live in appData.settings.tsEmailSettings:
//   { enabled: boolean, breakThreshold: number, cc: "a@x.com, b@y.com" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DEFAULT_BREAK_THRESHOLD = 7;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Monday (YYYY-MM-DD) of the week before the current one, in Arizona time.
function lastWeekStartAZ(): string {
  const todayAZ = new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });
  const [y, m, d] = todayAZ.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1) - 7);
  return isoDate(date);
}

function formatWeekRange(weekStart: string): string {
  const start = new Date(weekStart + "T00:00:00Z");
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  return `${start.toLocaleDateString("en-US", opts)} - ${end.toLocaleDateString("en-US", opts)}, ${end.getUTCFullYear()}`;
}

function emailHtml(name: string, position: string, weekString: string, reqHours: number, loggedHours: number): string {
  return `
<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
  <div style="background-color: #000000; padding: 24px; text-align: center;">
    <h2 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 600;">Action Required: Timesheet Update</h2>
  </div>
  <div style="padding: 32px 24px;">
    <p style="font-size: 16px; color: #374151; margin-top: 0;">Hello <strong>${esc(name)}</strong>,</p>
    <p style="font-size: 16px; color: #4b5563; line-height: 1.6;">
      You are receiving this automated notification because your logged hours for the week of <strong>${esc(weekString)}</strong> did not meet your position's minimum requirement.
    </p>
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
      <h3 style="margin-top: 0; color: #1e293b; font-size: 15px; margin-bottom: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em;">Weekly Summary</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 15px;">Position</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #334155;">${esc(position)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 15px;">Required Hours</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #059669;">${reqHours.toFixed(1)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #64748b; font-size: 15px;">Logged Hours</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #e11d48;">${loggedHours.toFixed(1)}</td>
        </tr>
      </table>
    </div>
    <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 16px; margin-bottom: 24px; border-radius: 0 8px 8px 0;">
      <p style="margin: 0; color: #1e3a8a; font-size: 15px; line-height: 1.5;">
        <strong>Important:</strong> Please reach out to your staff member for next steps. As a reminder, all hours must be submitted by <strong>11:59 PM on Sunday nights</strong>.
      </p>
    </div>
    <p style="font-size: 15px; color: #4b5563; margin-bottom: 0;">Thank you,</p>
    <p style="font-size: 15px; color: #4b5563; font-weight: 600; margin-top: 4px;">— Commuter Life</p>
  </div>
  <div style="background-color: #f9fafb; padding: 16px; border-top: 1px solid #e5e7eb; text-align: center;">
    <p style="font-size: 12px; color: #9ca3af; margin: 0;">This is an automated message from Commuter Life.</p>
  </div>
</div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS_HEADERS });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: stateRow, error: stateErr } = await supabase.from("app_state").select("data").eq("id", 1).single();
  if (stateErr || !stateRow?.data) {
    console.error("timesheet-reminders: could not read app_state", stateErr);
    return json({ error: "app_state unavailable" }, 500);
  }
  const appData = stateRow.data as any;
  const settings = appData.settings || {};
  const emailSettings = settings.tsEmailSettings || {};

  if (emailSettings.enabled === false) return json({ skipped: "Minimum-hours emails are turned off." });

  const weekStart = lastWeekStartAZ();
  const weekString = formatWeekRange(weekStart);

  const positions: any[] = Array.isArray(settings.tsPositions) ? settings.tsPositions : [];
  const minFor = (name: string) => {
    const p = positions.find((p) => p.name === name);
    return p ? Math.max(0, parseFloat(p.minHours) || 0) : 0;
  };

  const users: any[] = (settings.users || []).filter((u: any) => u.email && u.email !== "admin");
  const timesheets: any[] = appData.timesheets || [];
  const hoursFor = (email: string) =>
    timesheets
      .filter((t) => t.userEmail === email && t.weekStart === weekStart)
      .reduce((s, t) => s + (t.entries || []).reduce((a: number, e: any) => a + (parseFloat(e.hours) || 0), 0), 0);

  // Break-week check (same as the timesheet app): too few people logged anything.
  const threshold = Math.max(0, parseInt(emailSettings.breakThreshold ?? DEFAULT_BREAK_THRESHOLD) || 0);
  const activeCount = users.filter((u) => hoursFor(u.email) > 0).length;
  if (activeCount < threshold) {
    return json({ week: weekStart, skipped: `Break week — only ${activeCount} member(s) logged hours (threshold ${threshold}).` });
  }

  const log: Record<string, Record<string, string>> = appData.timesheetEmailLog || {};
  const alreadySent = log[weekStart] || {};

  const behind = users
    .map((u) => ({ u, req: minFor(u.tsPosition || ""), logged: hoursFor(u.email) }))
    .filter(({ u, req, logged }) => req > 0 && logged + 1e-9 < req && !alreadySent[u.email.toLowerCase()]);

  if (!behind.length) return json({ week: weekStart, sent: 0 });

  const { data: secretRow, error: secretErr } = await supabase.from("app_secrets").select("value").eq("key", "BREVO_API_KEY").single();
  if (secretErr || !secretRow?.value) {
    console.error("timesheet-reminders: BREVO_API_KEY missing", secretErr);
    return json({ error: "Email service not configured" }, 500);
  }
  const brevoApiKey = secretRow.value;

  const cc = String(emailSettings.cc || "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

  const sentNow: Record<string, string> = {};
  const failed: string[] = [];
  for (const { u, req, logged } of behind) {
    const email = u.email.toLowerCase();
    const name = u.name || email.split("@")[0];
    const ccFor = cc.filter((c) => c !== email).map((c) => ({ email: c }));
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": brevoApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: { name: "Commuter Life", email: "noreply@cabgcu.com" },
          to: [{ email, name }],
          ...(ccFor.length ? { cc: ccFor } : {}),
          subject: `Action Needed: Timesheet Update - ${weekString}`,
          htmlContent: emailHtml(name, u.tsPosition, weekString, req, logged),
        }),
      });
      if (res.ok) sentNow[email] = new Date().toISOString();
      else {
        failed.push(email);
        console.error(`timesheet-reminders: Brevo rejected ${email}:`, res.status, await res.text());
      }
    } catch (err) {
      failed.push(email);
      console.error(`timesheet-reminders: send to ${email} failed`, err);
    }
  }

  // Record who was emailed. Re-read app_state right before writing and merge in only
  // the email log, so edits made by live clients since our read aren't overwritten.
  // Keep the last 12 weeks of history.
  if (Object.keys(sentNow).length) {
    const { data: fresh } = await supabase.from("app_state").select("data").eq("id", 1).single();
    const base = fresh?.data || appData;
    const freshLog: Record<string, Record<string, string>> = base.timesheetEmailLog || {};
    freshLog[weekStart] = { ...(freshLog[weekStart] || {}), ...sentNow };
    const keep = Object.keys(freshLog).sort().slice(-12);
    base.timesheetEmailLog = Object.fromEntries(keep.map((k) => [k, freshLog[k]]));
    const { error: saveErr } = await supabase.from("app_state").update({ data: base }).eq("id", 1);
    if (saveErr) console.error("timesheet-reminders: could not save email log", saveErr);
  }

  return json({ week: weekStart, sent: Object.keys(sentNow).length, failed: failed.length });
});
