// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Key Info
// Why: Lets Pro users check their key details and tier status.
// Requires authentication (middleware enforces this).
// GET /api/v1/key/info
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, KeyData } from "../../../_shared/types";
import type { AuthResult } from "../../../_shared/auth";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.key_hash) {
    return errorResponse("Not authenticated", 401);
  }

  const raw = await env.KEYS.get(`key:${auth.key_hash}`);
  if (!raw) {
    return errorResponse("Key not found", 404);
  }

  const keyData: KeyData = JSON.parse(raw);

  return jsonResponse({
    tier: keyData.tier,
    email: keyData.email,
    rate_limit: keyData.rate_limit,
    created_at: keyData.created_at,
    last_rotated_at: keyData.last_rotated_at,
    active: keyData.active,
    // Usage analytics (Phase 2 — placeholder)
    usage: {
      note: "Detailed usage analytics coming soon.",
    },
  });
};
