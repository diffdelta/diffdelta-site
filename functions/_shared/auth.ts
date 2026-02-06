// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Authentication
// Why: Validates X-DiffDelta-Key header against KV store.
// No key = free tier (still served). Invalid key = 401.
// ─────────────────────────────────────────────────────────

import type { Env, KeyData } from "./types";
import { hashKey } from "./crypto";

export interface AuthResult {
  authenticated: boolean;
  tier: "free" | "pro" | "enterprise";
  key_hash?: string;
  key_data?: KeyData;
  error?: string;
}

/**
 * Authenticate a request by checking the X-DiffDelta-Key header.
 * Returns tier info. Gracefully degrades if KV is not bound.
 */
export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<AuthResult> {
  const apiKey = request.headers.get("X-DiffDelta-Key");

  // No key → free tier (perfectly valid)
  if (!apiKey) {
    return { authenticated: false, tier: "free" };
  }

  // KV not bound yet → treat as free (graceful degradation during setup)
  if (!env.KEYS) {
    return { authenticated: false, tier: "free" };
  }

  // Validate key format: dd_live_ prefix + at least 32 chars
  if (!apiKey.startsWith("dd_live_") || apiKey.length < 40) {
    return {
      authenticated: false,
      tier: "free",
      error: "Invalid key format. Keys start with dd_live_",
    };
  }

  // Look up hashed key in KV
  const keyHash = await hashKey(apiKey);
  const raw = await env.KEYS.get(`key:${keyHash}`);

  if (!raw) {
    return {
      authenticated: false,
      tier: "free",
      error: "API key not found",
    };
  }

  const keyData: KeyData = JSON.parse(raw);

  if (!keyData.active) {
    return {
      authenticated: false,
      tier: "free",
      error: "API key deactivated. Check your subscription status.",
    };
  }

  return {
    authenticated: true,
    tier: keyData.tier,
    key_hash: keyHash,
    key_data: keyData,
  };
}
