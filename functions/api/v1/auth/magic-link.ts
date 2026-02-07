// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Magic Link Request
// Why: Sends a one-time login link via email so human users
// can access the dashboard without pasting their API key.
// POST /api/v1/auth/magic-link
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, MagicLinkToken } from "../../../_shared/types";

const TOKEN_TTL = 900;          // 15 minutes
const RATE_LIMIT_PER_HOUR = 5;  // Max magic link requests per email per hour

/**
 * Generate a cryptographically secure URL-safe token.
 */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // URL-safe base64 (no +, /, or = padding)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // ── Check config ──
  if (!env.RESEND_API_KEY) {
    return errorResponse(
      "Email sign-in is not configured yet. Please use your API key to sign in.",
      503
    );
  }

  if (!env.KEYS || !env.SESSIONS) {
    return errorResponse("Service not configured", 503);
  }

  // ── Parse body ──
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const email = (body.email || "").trim().toLowerCase();

  // ── Validate email format ──
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errorResponse("Please enter a valid email address.", 400);
  }

  // ── Rate limit: max 5 requests per email per hour ──
  const hourKey = new Date().toISOString().slice(0, 13); // "2026-02-07T14"
  const rlKey = `magic-rl:${email}:${hourKey}`;
  const rlCount = parseInt((await env.SESSIONS.get(rlKey)) || "0", 10);

  if (rlCount >= RATE_LIMIT_PER_HOUR) {
    return errorResponse(
      "Too many sign-in requests. Please check your inbox or try again later.",
      429
    );
  }

  // ── Look up email → key_hash ──
  const keyHash = await env.KEYS.get(`email:${email}`);

  if (!keyHash) {
    // Don't reveal whether the email exists — return same success message.
    // This prevents enumeration attacks against customer emails.
    // We still increment the rate limit to prevent probing.
    await env.SESSIONS.put(rlKey, String(rlCount + 1), {
      expirationTtl: 3600,
    });
    return jsonResponse({
      status: "sent",
      message:
        "If an account exists for that email, we\u2019ve sent a sign-in link. Check your inbox.",
    });
  }

  // ── Verify the key is still active ──
  const keyRaw = await env.KEYS.get(`key:${keyHash}`);
  if (!keyRaw) {
    // Key was deleted — same response to prevent enumeration
    await env.SESSIONS.put(rlKey, String(rlCount + 1), {
      expirationTtl: 3600,
    });
    return jsonResponse({
      status: "sent",
      message:
        "If an account exists for that email, we\u2019ve sent a sign-in link. Check your inbox.",
    });
  }

  const keyData = JSON.parse(keyRaw);
  if (!keyData.active) {
    await env.SESSIONS.put(rlKey, String(rlCount + 1), {
      expirationTtl: 3600,
    });
    return jsonResponse({
      status: "sent",
      message:
        "If an account exists for that email, we\u2019ve sent a sign-in link. Check your inbox.",
    });
  }

  // ── Generate magic link token ──
  const token = generateToken();
  const now = new Date().toISOString();

  const tokenData: MagicLinkToken = {
    email,
    key_hash: keyHash,
    created_at: now,
  };

  await env.SESSIONS.put(`magic:${token}`, JSON.stringify(tokenData), {
    expirationTtl: TOKEN_TTL,
  });

  // ── Send email via Resend ──
  const origin = new URL(request.url).origin;
  const verifyUrl = `${origin}/api/v1/auth/verify?token=${encodeURIComponent(token)}`;

  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "DiffDelta <noreply@diffdelta.io>",
        to: [email],
        subject: "Sign in to DiffDelta Pro",
        html: buildEmailHtml(verifyUrl),
        text: buildEmailText(verifyUrl),
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.text();
      console.error("Resend API error:", emailRes.status, errBody);
      return errorResponse(
        "Failed to send sign-in email. Please try again or use your API key.",
        500
      );
    }
  } catch (err) {
    console.error("Email send failed:", err);
    return errorResponse(
      "Failed to send sign-in email. Please try again or use your API key.",
      500
    );
  }

  // ── Increment rate limit ──
  await env.SESSIONS.put(rlKey, String(rlCount + 1), {
    expirationTtl: 3600,
  });

  return jsonResponse({
    status: "sent",
    message:
      "If an account exists for that email, we\u2019ve sent a sign-in link. Check your inbox.",
  });
};

// ── Email templates ──

function buildEmailHtml(verifyUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#fafafa;padding:40px 20px">
  <div style="max-width:480px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:40px 32px;text-align:center">
    <h1 style="font-size:1.4rem;font-weight:700;margin:0 0 8px;letter-spacing:-0.5px">
      Diff<span style="color:#3b82f6">Delta</span>
    </h1>
    <p style="color:#a1a1aa;font-size:.95rem;margin:0 0 28px">Sign in to your Pro dashboard</p>
    <a href="${verifyUrl}"
       style="display:inline-block;background:#3b82f6;color:#fff;font-weight:600;font-size:.95rem;
              padding:12px 32px;border-radius:8px;text-decoration:none">
      Sign In \u2192
    </a>
    <p style="color:#71717a;font-size:.8rem;margin:28px 0 0">
      This link expires in 15 minutes.<br>
      If you didn\u2019t request this, you can safely ignore this email.
    </p>
  </div>
  <p style="text-align:center;color:#71717a;font-size:.75rem;margin-top:20px">
    DiffDelta \u00b7 <a href="https://diffdelta.io" style="color:#71717a">diffdelta.io</a>
  </p>
</body>
</html>`.trim();
}

function buildEmailText(verifyUrl: string): string {
  return [
    "Sign in to DiffDelta Pro",
    "",
    "Click this link to sign in to your dashboard:",
    verifyUrl,
    "",
    "This link expires in 15 minutes.",
    "If you didn\u2019t request this, you can safely ignore this email.",
    "",
    "\u2014 DiffDelta",
    "human@diffdelta.io",
  ].join("\n");
}
