// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Key Rotation
// Why: Allows Pro users to rotate their API key without
// losing their subscription. Old key is immediately invalidated.
// POST /api/v1/key/rotate
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import { generateApiKey, hashKey } from "../../../_shared/crypto";
import type { Env, KeyData } from "../../../_shared/types";
import type { AuthResult } from "../../../_shared/auth";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.key_hash) {
    return errorResponse("Not authenticated", 401);
  }

  // Read current key data
  const raw = await env.KEYS.get(`key:${auth.key_hash}`);
  if (!raw) {
    return errorResponse("Key not found", 404);
  }

  const keyData: KeyData = JSON.parse(raw);
  const now = new Date().toISOString();

  // Generate new key
  const newApiKey = await generateApiKey();
  const newKeyHash = await hashKey(newApiKey);

  // Update timestamps
  keyData.last_rotated_at = now;

  // Store new key
  await env.KEYS.put(`key:${newKeyHash}`, JSON.stringify(keyData));

  // Update subscription → new key hash mapping
  if (keyData.stripe_subscription_id) {
    await env.KEYS.put(
      `sub:${keyData.stripe_subscription_id}`,
      newKeyHash
    );
  }

  // Delete old key (immediate invalidation)
  await env.KEYS.delete(`key:${auth.key_hash}`);

  return jsonResponse({
    api_key: newApiKey,
    tier: keyData.tier,
    rotated_at: now,
    message:
      "Key rotated successfully. The old key is now invalid. Save this new key.",
  });
};
