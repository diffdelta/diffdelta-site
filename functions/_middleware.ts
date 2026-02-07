// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Global middleware
// Why: Intercepts ALL requests to handle auth, rate limiting,
// and CORS. Free tier is zero-overhead (no KV lookups if no key).
// ─────────────────────────────────────────────────────────

import { authenticateRequest } from "./_shared/auth";
import { checkRateLimit } from "./_shared/ratelimit";
import { errorResponse, corsPreflightResponse } from "./_shared/response";
import type { Env } from "./_shared/types";

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, next, data } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // ── CORS preflight ──
  if (request.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  // ── Skip middleware for static content ──
  // /diff/ and /archive/ are static JSON on CDN — let Cloudflare cache them
  // directly (cf-cache-status: HIT) without burning Function invocations.
  // Only /api/ and /stripe/ need auth, rate limiting, or signature checks.
  const needsMiddleware =
    path.startsWith("/api/") ||
    path.startsWith("/stripe/");

  if (!needsMiddleware) {
    return next();
  }

  // ── Stripe webhook has its own signature verification — skip auth ──
  if (path.startsWith("/stripe/")) {
    return next();
  }

  // ── Authenticate ──
  const auth = await authenticateRequest(request, env);

  // If a key was provided but is invalid, return 401 (don't silently downgrade)
  const providedKey = request.headers.get("X-DiffDelta-Key");
  if (providedKey && auth.error) {
    return errorResponse(auth.error, 401);
  }

  // ── Rate limit ──
  const identifier =
    auth.authenticated && auth.key_hash
      ? auth.key_hash
      : request.headers.get("CF-Connecting-IP") || "unknown";

  const rl = await checkRateLimit(env, identifier, auth.tier);

  if (!rl.allowed) {
    return errorResponse(
      auth.tier === "free"
        ? "Rate limit exceeded. Upgrade to Pro for 1,000 req/min: https://diffdelta.io/#pricing"
        : "Rate limit exceeded. Contact support if you need higher limits.",
      429,
      rl
    );
  }

  // ── API routes require Pro key (except public endpoints) ──
  if (path.startsWith("/api/")) {
    const isPublicEndpoint =
      path === "/api/v1/checkout" ||
      path === "/api/v1/source-request" ||
      path.startsWith("/api/v1/key/claim") ||
      path.startsWith("/api/v1/admin/"); // Admin endpoints use their own auth

    if (!isPublicEndpoint && !auth.authenticated) {
      return errorResponse(
        "API key required. Get one at https://diffdelta.io/#pricing",
        401,
        rl
      );
    }
  }

  // ── Pass auth context to downstream handlers via context.data ──
  (data as Record<string, unknown>).auth = auth;

  // ── Execute downstream handler (static file or Function) ──
  const response = await next();

  // ── Add rate limit + tier headers to response ──
  const headers = new Headers(response.headers);
  headers.set("X-RateLimit-Limit", String(rl.limit));
  headers.set("X-RateLimit-Remaining", String(rl.remaining));
  headers.set("X-RateLimit-Reset", String(rl.reset_at));

  if (auth.tier !== "free") {
    headers.set("X-DiffDelta-Tier", auth.tier);
  }

  // Ensure CORS headers are present
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Headers",
    "X-DiffDelta-Key, Content-Type"
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
