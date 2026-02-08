// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Response helpers
// Why: Consistent JSON responses with CORS + rate limit headers.
// ─────────────────────────────────────────────────────────

import type { RateLimitResult } from "./types";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "X-DiffDelta-Key, X-Moltbook-Identity, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

/**
 * Return a JSON response with standard headers.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  rateLimit?: RateLimitResult
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  };

  if (rateLimit) {
    headers["X-RateLimit-Limit"] = String(rateLimit.limit);
    headers["X-RateLimit-Remaining"] = String(rateLimit.remaining);
    headers["X-RateLimit-Reset"] = String(rateLimit.reset_at);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Return a JSON error response.
 */
export function errorResponse(
  message: string,
  status: number,
  rateLimit?: RateLimitResult
): Response {
  return jsonResponse({ error: message, status }, status, rateLimit);
}

/**
 * CORS preflight response.
 */
export function corsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Max-Age": "86400",
    },
  });
}
