// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Key Claim
// Why: After Stripe payment, user lands on success page which
// polls this endpoint to retrieve their one-time API key.
// GET /api/v1/key/claim?session_id=cs_xxx
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, SessionClaim } from "../../../_shared/types";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;
  const url = new URL(context.request.url);
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId) {
    return errorResponse("Missing session_id parameter", 400);
  }

  if (!env.SESSIONS) {
    return errorResponse("Service not configured", 503);
  }

  // Look up pending key claim
  const raw = await env.SESSIONS.get(`session:${sessionId}`);

  if (!raw) {
    // Key not yet created (Stripe webhook hasn't fired yet) or already claimed
    return jsonResponse(
      {
        status: "pending",
        message:
          "Your key is being generated. This usually takes a few seconds.",
      },
      202
    );
  }

  const claim: SessionClaim = JSON.parse(raw);

  // Delete session mapping (one-time claim — key is shown once)
  await env.SESSIONS.delete(`session:${sessionId}`);

  return jsonResponse({
    status: "ready",
    api_key: claim.api_key,
    email: claim.email,
    tier: "pro",
    rate_limit: 1000,
    message:
      "Save this key — it won't be shown again. Add it as X-DiffDelta-Key header.",
    docs: "https://diffdelta.io/docs/spec/client-quickstart",
  });
};
