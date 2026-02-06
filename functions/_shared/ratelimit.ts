// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Rate Limiting
// Why: Sliding-window rate limits via KV counters.
// Free: 60 req/min per IP. Pro: 1,000. Enterprise: 5,000.
// Falls back to "unlimited" if RATE_LIMITS KV not bound.
// ─────────────────────────────────────────────────────────

import type { Env, RateLimitResult } from "./types";

const LIMITS: Record<string, number> = {
  free: 60,
  pro: 1000,
  enterprise: 5000,
};

const WINDOW_SEC = 60;

/**
 * Check and increment rate limit counter.
 * @param env      - Cloudflare env bindings
 * @param id       - Identifier: IP address (free) or key hash (pro/enterprise)
 * @param tier     - Tier determines the limit
 */
export async function checkRateLimit(
  env: Env,
  id: string,
  tier: "free" | "pro" | "enterprise"
): Promise<RateLimitResult> {
  const limit = LIMITS[tier] ?? LIMITS.free;
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_SEC);
  const resetAt = (window + 1) * WINDOW_SEC;

  // KV not bound → allow all (graceful degradation during setup)
  if (!env.RATE_LIMITS) {
    return { allowed: true, remaining: limit, reset_at: resetAt, limit };
  }

  const kvKey = `rl:${id}:${window}`;

  // Read current count
  const raw = await env.RATE_LIMITS.get(kvKey);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= limit) {
    return { allowed: false, remaining: 0, reset_at: resetAt, limit };
  }

  // Increment (TTL = 2 windows for auto-cleanup)
  await env.RATE_LIMITS.put(kvKey, String(count + 1), {
    expirationTtl: WINDOW_SEC * 2,
  });

  return {
    allowed: true,
    remaining: limit - count - 1,
    reset_at: resetAt,
    limit,
  };
}
