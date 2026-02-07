// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Account Profile
// Why: Single endpoint returns everything the dashboard needs.
// Compute arbitrage: one request, all data, minimal tokens.
// GET /api/v1/account
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env, KeyData, CustomSource } from "../../_shared/types";
import type { AuthResult } from "../../_shared/auth";

const WINDOW_SEC = 60;

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

  // ── Usage: read current rate limit window ──
  let used = 0;
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_SEC);
  const resetAt = (window + 1) * WINDOW_SEC;

  if (env.RATE_LIMITS) {
    const rlKey = `rl:${auth.key_hash}:${window}`;
    const rlRaw = await env.RATE_LIMITS.get(rlKey);
    used = rlRaw ? parseInt(rlRaw, 10) : 0;
  }

  // ── Custom sources: fetch owned sources ──
  // Backward compat: old keys won't have these fields
  const sourceIds = keyData.custom_source_ids || [];
  const limit = keyData.custom_sources_limit ??
    (keyData.tier === "pro" ? 2 : -1);

  const sources: CustomSource[] = [];
  for (const id of sourceIds) {
    const srcRaw = await env.KEYS.get(`custom:${id}`);
    if (srcRaw) {
      sources.push(JSON.parse(srcRaw));
    }
  }

  return jsonResponse({
    tier: keyData.tier,
    email: keyData.email,
    rate_limit: keyData.rate_limit,
    created_at: keyData.created_at,
    last_rotated_at: keyData.last_rotated_at,
    active: keyData.active,
    usage: {
      current_window: {
        used,
        limit: keyData.rate_limit,
        remaining: Math.max(0, keyData.rate_limit - used),
        reset_at: resetAt,
      },
    },
    custom_sources: {
      used: sources.length,
      limit,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        status: s.status,
        submitted_at: s.submitted_at,
        reviewed_at: s.reviewed_at,
        review_notes: s.status === "rejected" ? s.review_notes : undefined,
        feed_source_id: s.feed_source_id,
      })),
    },
    billing: {
      customer_id: keyData.customer_id ? true : false, // Don't expose raw ID
      portal_available: !!env.STRIPE_SECRET_KEY && !!keyData.customer_id,
    },
  });
};
