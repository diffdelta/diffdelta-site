// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Magic Link Verification
// Why: Completes the magic link flow — validates the token,
// creates a session, sets an HttpOnly cookie, and redirects
// the user to the Pro dashboard.
// GET /api/v1/auth/verify?token=...
// ─────────────────────────────────────────────────────────

import type { Env, MagicLinkToken, AuthSession } from "../../../_shared/types";

const SESSION_TTL = 604800; // 7 days in seconds

/**
 * Generate a cryptographically secure session ID.
 */
function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build an HTML response page (for success or error states).
 */
function htmlResponse(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — DiffDelta</title>
  <meta name="robots" content="noindex">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#fafafa;
      display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:480px;width:100%;background:#18181b;border:1px solid #27272a;
      border-radius:16px;padding:40px 24px;text-align:center}
    h1{font-size:1.4rem;font-weight:700;margin-bottom:12px;letter-spacing:-.5px}
    p{color:#a1a1aa;font-size:.95rem;margin-bottom:16px;line-height:1.6}
    a{color:#3b82f6;text-decoration:none}
    a:hover{text-decoration:underline}
    .btn{display:inline-block;background:#3b82f6;color:#fff;font-weight:600;padding:10px 24px;
      border-radius:8px;text-decoration:none;font-size:.9rem;margin-top:8px}
    .btn:hover{background:#2563eb;text-decoration:none}
    .spinner{width:32px;height:32px;border:3px solid #27272a;border-top-color:#3b82f6;
      border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.SESSIONS || !env.KEYS) {
    return htmlResponse(
      "Error",
      `<h1>Service Unavailable</h1>
       <p>Sign-in is temporarily unavailable. Please try again later or use your API key.</p>
       <a href="/pro" class="btn">Go to Dashboard</a>`,
      503
    );
  }

  // ── Read token from query string ──
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return htmlResponse(
      "Invalid Link",
      `<h1>Invalid Sign-In Link</h1>
       <p>This link is missing the authentication token. Please request a new sign-in link.</p>
       <a href="/pro" class="btn">Go to Dashboard</a>`,
      400
    );
  }

  // ── Look up the magic token ──
  const tokenRaw = await env.SESSIONS.get(`magic:${token}`);

  if (!tokenRaw) {
    return htmlResponse(
      "Link Expired",
      `<h1>Link Expired or Already Used</h1>
       <p>This sign-in link has expired or has already been used. Magic links are valid for 15 minutes and can only be used once.</p>
       <a href="/pro" class="btn">Request a New Link</a>`,
      410
    );
  }

  const tokenData: MagicLinkToken = JSON.parse(tokenRaw);

  // ── Delete the magic token immediately (one-time use) ──
  await env.SESSIONS.delete(`magic:${token}`);

  // ── Verify the key still exists and is active ──
  let keyHash = tokenData.key_hash;
  const keyRaw = await env.KEYS.get(`key:${keyHash}`);

  if (!keyRaw) {
    // Key may have been rotated — try email lookup
    const updatedHash = await env.KEYS.get(`email:${tokenData.email}`);
    if (updatedHash) {
      keyHash = updatedHash;
    } else {
      return htmlResponse(
        "Account Not Found",
        `<h1>Account Not Found</h1>
         <p>We couldn\u2019t find an active account for this email. Your subscription may have been cancelled.</p>
         <p>Contact <a href="mailto:human@diffdelta.io">human@diffdelta.io</a> for help.</p>
         <a href="/" class="btn">Go to DiffDelta</a>`,
        404
      );
    }
  }

  // ── Create auth session ──
  const sessionId = generateSessionId();
  const now = new Date().toISOString();

  const session: AuthSession = {
    email: tokenData.email,
    key_hash: keyHash,
    created_at: now,
  };

  await env.SESSIONS.put(`auth:${sessionId}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL,
  });

  // ── Set HttpOnly session cookie and redirect to dashboard ──
  const origin = url.origin;
  const isSecure = url.protocol === "https:";

  const cookieParts = [
    `dd_session=${sessionId}`,
    `Path=/`,
    `Max-Age=${SESSION_TTL}`,
    `SameSite=Lax`,
    `HttpOnly`,
  ];

  if (isSecure) {
    cookieParts.push("Secure");
  }

  // Redirect to /pro with a brief interstitial (in case redirect is blocked)
  const redirectHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="1;url=${origin}/pro">
  <title>Signing In — DiffDelta</title>
  <meta name="robots" content="noindex">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:#09090b;color:#fafafa;
      display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:480px;width:100%;background:#18181b;border:1px solid #27272a;
      border-radius:16px;padding:40px 24px;text-align:center}
    h1{font-size:1.4rem;font-weight:700;margin-bottom:12px;letter-spacing:-.5px}
    p{color:#a1a1aa;font-size:.95rem;line-height:1.6}
    a{color:#3b82f6}
    .spinner{width:32px;height:32px;border:3px solid #27272a;border-top-color:#3b82f6;
      border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>You\u2019re signed in!</h1>
    <p>Redirecting to your dashboard\u2026</p>
    <p style="margin-top:12px;font-size:.85rem">Not redirecting? <a href="${origin}/pro">Click here</a></p>
  </div>
</body>
</html>`;

  return new Response(redirectHtml, {
    status: 302,
    headers: {
      Location: `${origin}/pro`,
      "Set-Cookie": cookieParts.join("; "),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
