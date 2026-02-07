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

  // ── Rotation lock: prevent concurrent rotations ──
  const lockKey = `lock:rotate:${keyData.stripe_subscription_id || auth.key_hash}`;
  const existingLock = await env.KEYS.get(lockKey);
  if (existingLock) {
    return errorResponse(
      "Key rotation already in progress. Please wait a few seconds and try again.",
      409
    );
  }
  // Set lock with 30-second TTL (auto-expires if something crashes)
  await env.KEYS.put(lockKey, "1", { expirationTtl: 30 });

  try {
    const now = new Date().toISOString();

    // Generate new key
    const newApiKey = await generateApiKey();
    const newKeyHash = await hashKey(newApiKey);

    // Update timestamps
    keyData.last_rotated_at = now;

    // Store new key FIRST (so there's always a valid key)
    await env.KEYS.put(`key:${newKeyHash}`, JSON.stringify(keyData));

    // Update subscription → new key hash mapping
    if (keyData.stripe_subscription_id) {
      await env.KEYS.put(
        `sub:${keyData.stripe_subscription_id}`,
        newKeyHash
      );
    }

    // Update email → new key hash mapping (for magic link auth)
    if (keyData.email) {
      await env.KEYS.put(`email:${keyData.email}`, newKeyHash);
    }

    // Delete old key LAST (after new key is safely stored)
    await env.KEYS.delete(`key:${auth.key_hash}`);

    return jsonResponse({
      api_key: newApiKey,
      tier: keyData.tier,
      rotated_at: now,
      message:
        "Key rotated successfully. The old key is now invalid. Save this new key.",
    });
  } finally {
    // Release lock
    await env.KEYS.delete(lockKey);
  }
};
