// Supabase Edge Function: send-password-reset
// Generates a password reset token, stores it in app_state, and emails it via Brevo.
// BREVO_API_KEY is read from the app_secrets table (set via SQL editor).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function generateToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  try {
    const { email, appUrl } = await req.json();

    if (!email || !appUrl) {
      return new Response(
        JSON.stringify({ error: "email and appUrl are required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Read Brevo API key from database (stored via SQL editor)
    const { data: secretRow, error: secretError } = await supabase
      .from("app_secrets")
      .select("value")
      .eq("key", "BREVO_API_KEY")
      .single();

    if (secretError || !secretRow?.value) {
      console.error("Secret fetch error:", secretError);
      return new Response(
        JSON.stringify({ error: "Email service not configured" }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const brevoApiKey = secretRow.value;

    // Load app state to verify user and store token
    const { data: stateRow, error: fetchError } = await supabase
      .from("app_state")
      .select("data")
      .eq("id", 1)
      .single();

    if (fetchError || !stateRow) {
      console.error("DB fetch error:", fetchError);
      return new Response(
        JSON.stringify({ error: "Database error" }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const appData = stateRow.data;
    const users: any[] = appData?.settings?.users || [];
    const user = users.find(
      (u: any) => u.email?.toLowerCase() === normalizedEmail
    );

    // Return success regardless to avoid email enumeration
    if (!user) {
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // Generate token valid for 1 hour
    const token = generateToken();
    const expiry = Date.now() + 60 * 60 * 1000;

    if (!appData.settings.passwordResetTokens) {
      appData.settings.passwordResetTokens = [];
    }

    // Remove any prior token for this email
    appData.settings.passwordResetTokens = (
      appData.settings.passwordResetTokens as any[]
    ).filter((t: any) => t.email !== normalizedEmail);

    appData.settings.passwordResetTokens.push({ email: normalizedEmail, token, expiry });

    const { error: updateError } = await supabase
      .from("app_state")
      .update({ data: appData })
      .eq("id", 1);

    if (updateError) {
      console.error("DB update error:", updateError);
      return new Response(
        JSON.stringify({ error: "Failed to save reset token" }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const resetUrl = `${appUrl}?reset=${token}`;
    const userName = user.name || normalizedEmail.split("@")[0];

    const emailRes = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": brevoApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "CAB Commuter Life", email: "noreply@cabgcu.com" },
        to: [{ email: normalizedEmail, name: userName }],
        subject: "Reset Your Password – CAB Commuter Life",
        htmlContent: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#111;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);">
        <tr>
          <td style="padding:36px 32px;text-align:center;background:linear-gradient(135deg,#6c63ff,#e056fd);">
            <h1 style="margin:0;font-size:1.6rem;font-weight:800;color:#fff;letter-spacing:-0.5px;">Reset Your Password</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="font-size:1rem;color:#ccc;margin:0 0 8px;">Hi ${userName},</p>
            <p style="font-size:1rem;color:#ccc;margin:0 0 24px;">
              We received a request to reset the password for
              <strong style="color:#fff;">${normalizedEmail}</strong>.
              Click the button below — this link expires in <strong style="color:#fff;">1 hour</strong>.
            </p>
            <div style="text-align:center;margin-bottom:24px;">
              <a href="${resetUrl}"
                 style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6c63ff,#e056fd);
                        color:#fff;text-decoration:none;border-radius:12px;font-weight:700;font-size:1rem;">
                Reset Password
              </a>
            </div>
            <p style="font-size:0.8rem;color:#555;text-align:center;margin:0;">
              If you didn't request this, you can safely ignore this email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.text();
      console.error("Brevo error:", errBody);
      return new Response(
        JSON.stringify({ error: "Failed to send email" }),
        { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
});
