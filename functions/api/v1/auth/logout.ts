// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Logout (clear session)
// Why: Clears the dd_session cookie and deletes the auth
// session from KV, logging the user out of the dashboard.
// POST /api/v1/auth/logout
// ─────────────────────────────────────────────────────────

import { jsonResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // ── Parse session cookie ──
  const cookieHeader = request.headers.get("Cookie") || "";
  let sessionId = "";

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "dd_session") {
      sessionId = rest.join("=").trim();
      break;
    }
  }

  // ── Delete session from KV (if exists) ──
  if (sessionId && env.SESSIONS) {
    await env.SESSIONS.delete(`auth:${sessionId}`);
  }

  // ── Clear the cookie ──
  const url = new URL(request.url);
  const isSecure = url.protocol === "https:";

  const clearCookieParts = [
    "dd_session=",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
    "HttpOnly",
  ];

  if (isSecure) {
    clearCookieParts.push("Secure");
  }

  const body = JSON.stringify({
    status: "logged_out",
    message: "Session cleared successfully.",
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": clearCookieParts.join("; "),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "X-DiffDelta-Key, Content-Type",
      "Cache-Control": "no-store",
    },
  });
};
