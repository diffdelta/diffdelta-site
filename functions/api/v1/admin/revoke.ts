// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Admin Key Revocation
// Why: Emergency key revocation without touching the
// Cloudflare dashboard. Protected by ADMIN_SECRET env var.
// POST /api/v1/admin/revoke  { "key_hash": "abc123..." }
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, KeyData } from "../../../_shared/types";

interface RevokeBody {
  key_hash?: string;
  subscription_id?: string;
  reason?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // ── Admin auth: requires ADMIN_SECRET env var ──
  const adminSecret = (env as Record<string, unknown>).ADMIN_SECRET as
    | string
    | undefined;

  if (!adminSecret) {
    return errorResponse("Admin endpoint not configured", 503);
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${adminSecret}`) {
    return errorResponse("Unauthorized", 401);
  }

  // ── Parse request ──
  let body: RevokeBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // ── Find key by hash or subscription ID ──
  let keyHash = body.key_hash;

  if (!keyHash && body.subscription_id) {
    keyHash =
      (await env.KEYS.get(`sub:${body.subscription_id}`)) || undefined;
  }

  if (!keyHash) {
    return errorResponse(
      "Provide key_hash or subscription_id to identify the key",
      400
    );
  }

  // ── Deactivate (don't delete — preserve audit trail) ──
  const raw = await env.KEYS.get(`key:${keyHash}`);
  if (!raw) {
    return errorResponse("Key not found", 404);
  }

  const keyData: KeyData = JSON.parse(raw);
  keyData.active = false;

  await env.KEYS.put(`key:${keyHash}`, JSON.stringify(keyData));

  return jsonResponse({
    revoked: true,
    key_hash: keyHash,
    email: keyData.email,
    tier: keyData.tier,
    reason: body.reason || "admin_revocation",
    message: "Key deactivated. User will receive 401 on next request.",
  });
};
