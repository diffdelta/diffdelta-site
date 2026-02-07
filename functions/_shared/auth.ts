// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Authentication
// Why: Validates X-DiffDelta-Key header OR dd_session cookie
// against KV store. No key/session = free tier (still served).
// Invalid key = 401.  Session cookie = passwordless dashboard.
// ─────────────────────────────────────────────────────────

import type { Env, KeyData, AuthSession } from "./types";
import { hashKey } from "./crypto";

export interface AuthResult {
  authenticated: boolean;
  tier: "free" | "pro" | "enterprise";
  key_hash?: string;
  key_data?: KeyData;
  error?: string;
  auth_mode?: "key" | "session";  // How the user authenticated
  session_id?: string;            // If auth_mode="session", the session ID (for logout/rotation)
}

/**
 * Authenticate a request by checking:
 * 1. X-DiffDelta-Key header (API key — takes priority)
 * 2. dd_session cookie (magic link session — fallback for humans)
 * Returns tier info. Gracefully degrades if KV is not bound.
 */
export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<AuthResult> {
  // ── 1. Try X-DiffDelta-Key header (existing, priority) ──
  const apiKey = request.headers.get("X-DiffDelta-Key");

  if (apiKey) {
    return authenticateFromKey(apiKey, env);
  }

  // ── 2. Try dd_session cookie (magic link flow) ──
  const sessionId = getSessionCookie(request);
  if (sessionId && env.SESSIONS) {
    return authenticateFromSession(sessionId, env);
  }

  // ── 3. No auth → free tier (perfectly valid) ──
  return { authenticated: false, tier: "free" };
}

/**
 * Authenticate via API key header (existing logic, extracted).
 */
async function authenticateFromKey(
  apiKey: string,
  env: Env
): Promise<AuthResult> {
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
    auth_mode: "key",
  };
}

/**
 * Authenticate via dd_session cookie (magic link flow).
 * Resolves session → key_hash → KeyData.
 * If key_hash is stale (post-rotation), falls back to email → key_hash lookup.
 */
async function authenticateFromSession(
  sessionId: string,
  env: Env
): Promise<AuthResult> {
  // Read session from SESSIONS KV
  const sessionRaw = await env.SESSIONS.get(`auth:${sessionId}`);
  if (!sessionRaw) {
    return { authenticated: false, tier: "free", error: "Session expired" };
  }

  const session: AuthSession = JSON.parse(sessionRaw);

  // Try resolving key_hash directly (fast path — 1 KV read)
  let keyData: KeyData | null = null;
  let keyHash = session.key_hash;

  const raw = await env.KEYS.get(`key:${keyHash}`);
  if (raw) {
    keyData = JSON.parse(raw);
  }

  // If key_hash is stale (post-rotation), fall back to email → key_hash
  if (!keyData || !keyData.active) {
    if (session.email && env.KEYS) {
      const updatedHash = await env.KEYS.get(`email:${session.email}`);
      if (updatedHash) {
        const updatedRaw = await env.KEYS.get(`key:${updatedHash}`);
        if (updatedRaw) {
          keyData = JSON.parse(updatedRaw);
          keyHash = updatedHash;

          // Lazy-update the session so next request is fast
          const updatedSession: AuthSession = {
            ...session,
            key_hash: updatedHash,
          };
          await env.SESSIONS.put(
            `auth:${sessionId}`,
            JSON.stringify(updatedSession),
            { expirationTtl: 604800 } // 7 days
          );
        }
      }
    }
  }

  if (!keyData || !keyData.active) {
    return {
      authenticated: false,
      tier: "free",
      error: "Account not found or deactivated. Try signing in again.",
    };
  }

  return {
    authenticated: true,
    tier: keyData.tier,
    key_hash: keyHash,
    key_data: keyData,
    auth_mode: "session",
    session_id: sessionId,
  };
}

/**
 * Parse dd_session cookie from request.
 * Returns the session ID or null.
 */
function getSessionCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "dd_session") {
      const value = rest.join("=").trim();
      // Basic validation: must be a non-empty hex/alphanumeric string
      if (value && /^[a-zA-Z0-9_-]{32,}$/.test(value)) {
        return value;
      }
    }
  }

  return null;
}
