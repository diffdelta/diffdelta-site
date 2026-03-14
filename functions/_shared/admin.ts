// Shared admin authentication with brute-force rate limiting.
// Why: admin endpoints only check a bearer token — without a
// per-IP attempt limit, an attacker at 60 req/min could brute-force
// ADMIN_SECRET. This helper enforces 5 failed attempts per 15min
// per IP before locking out.

import { errorResponse } from "./response";
import type { Env } from "./types";

const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_SEC = 900; // 15 minutes

export async function checkAdmin(
  request: Request,
  env: Env
): Promise<Response | null> {
  const adminSecret = (env as Record<string, unknown>).ADMIN_SECRET as
    | string
    | undefined;

  if (!adminSecret) {
    return errorResponse("Admin endpoint not configured", 503);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const window = Math.floor(Date.now() / 1000 / WINDOW_SEC);
  const rlKey = `admin-rl:${ip}:${window}`;

  // Check if already locked out before comparing secrets
  if (env.RATE_LIMITS) {
    const failCount = parseInt((await env.RATE_LIMITS.get(rlKey)) || "0", 10);
    if (failCount >= MAX_FAILED_ATTEMPTS) {
      return errorResponse("Too many failed attempts. Try again later.", 429);
    }
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${adminSecret}`) {
    // Increment failed attempt counter
    if (env.RATE_LIMITS) {
      const current = parseInt((await env.RATE_LIMITS.get(rlKey)) || "0", 10);
      await env.RATE_LIMITS.put(rlKey, String(current + 1), {
        expirationTtl: WINDOW_SEC * 2,
      });
    }
    return errorResponse("Unauthorized", 401);
  }

  return null;
}
