// ─────────────────────────────────────────────────────────
// DiffDelta — Source Request Handler
// Why: Stores user-submitted source suggestions in KV so we
// can prioritize what to build next based on real demand.
// POST /api/v1/source-request  { email, source }
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";

interface SourceRequest {
  email?: string;
  source?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.KEYS) {
    return errorResponse("Service not configured", 503);
  }

  // ── Parse + validate ──
  let body: SourceRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const source = (body.source || "").trim();

  if (!email || !email.includes("@") || !email.includes(".")) {
    return errorResponse("Valid email is required", 400);
  }

  if (!source || source.length < 2) {
    return errorResponse("Source name or URL is required", 400);
  }

  // ── Length limits (prevent abuse) ──
  if (email.length > 254 || source.length > 500) {
    return errorResponse("Input too long", 400);
  }

  // ── Rate limit: max 5 requests per email per day ──
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const rateLimitKey = `sourcereq-rl:${email}:${dateKey}`;
  const currentCount = parseInt((await env.KEYS.get(rateLimitKey)) || "0", 10);

  if (currentCount >= 5) {
    return errorResponse("Too many requests today. Try again tomorrow.", 429);
  }

  await env.KEYS.put(rateLimitKey, String(currentCount + 1), {
    expirationTtl: 86400, // 24 hours
  });

  // ── Store the request ──
  const timestamp = new Date().toISOString();
  const id = `sourcereq:${timestamp}:${crypto.randomUUID().slice(0, 8)}`;

  const record = {
    email,
    source,
    submitted_at: timestamp,
    ip: request.headers.get("CF-Connecting-IP") || "unknown",
  };

  // TTL of 90 days — we'll review and clean up
  await env.KEYS.put(id, JSON.stringify(record), {
    expirationTtl: 7776000, // 90 days
  });

  return jsonResponse({
    status: "received",
    message: "Thanks! We'll review your suggestion.",
  });
};
