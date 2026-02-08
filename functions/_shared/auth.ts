// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Authentication
// Why: Validates X-DiffDelta-Key header OR dd_session cookie
// against KV store. No key/session = free tier (still served).
// Invalid key = 401.  Session cookie = passwordless dashboard.
// ─────────────────────────────────────────────────────────

import type { Env, KeyData, AuthSession, MoltbookAgentCache } from "./types";
import { hashKey } from "./crypto";

export interface AuthResult {
  authenticated: boolean;
  tier: "free" | "pro" | "enterprise";
  key_hash?: string;
  key_data?: KeyData;
  error?: string;
  auth_mode?: "key" | "session" | "moltbook";  // How the user authenticated
  session_id?: string;            // If auth_mode="session", the session ID (for logout/rotation)
  moltbook_agent_id?: string;    // If auth_mode="moltbook", the verified agent ID
  moltbook_agent_name?: string;  // If auth_mode="moltbook", the agent's display name
}

/**
 * Authenticate a request by checking (in priority order):
 * 1. X-DiffDelta-Key header (API key — takes priority, most explicit)
 * 2. X-Moltbook-Identity header (bot identity token — verified via Moltbook API)
 * 3. dd_session cookie (magic link session — fallback for humans on dashboard)
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

  // ── 2. Try X-Moltbook-Identity header (bot identity) ──
  const moltbookToken = request.headers.get("X-Moltbook-Identity");
  if (moltbookToken && env.MOLTBOOK_APP_KEY) {
    return authenticateFromMoltbook(moltbookToken, env);
  }

  // ── 3. Try dd_session cookie (magic link flow) ──
  const sessionId = getSessionCookie(request);
  if (sessionId && env.SESSIONS) {
    return authenticateFromSession(sessionId, env);
  }

  // ── 4. No auth → free tier (perfectly valid) ──
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
 * Authenticate via Moltbook identity token (bot identity).
 * Flow:
 *   1. Check SESSIONS KV cache for `moltbook:{hash(token)}` (5-min TTL, avoids re-verifying)
 *   2. If cache miss → call Moltbook API to verify the token
 *   3. If valid → cache the result + check for linked DiffDelta Pro account
 *   4. If agent has a linked Pro key → return Pro tier; otherwise → authenticated free
 *
 * Why this order: We verify with Moltbook first, then optionally upgrade to Pro
 * if the bot owner has linked their DiffDelta account. This means any Moltbook bot
 * gets verified identity (and we know who's calling), and Pro bots get full features.
 */
async function authenticateFromMoltbook(
  token: string,
  env: Env
): Promise<AuthResult> {
  // ── Quick cache check (avoid calling Moltbook every request) ──
  // Hash the token so we don't store raw JWTs in KV keys
  const tokenHash = await hashKey(token);
  const cacheKey = `moltbook:${tokenHash}`;

  let agent: MoltbookAgentCache | null = null;

  if (env.SESSIONS) {
    const cached = await env.SESSIONS.get(cacheKey);
    if (cached) {
      agent = JSON.parse(cached);
    }
  }

  // ── Cache miss → verify with Moltbook API ──
  if (!agent) {
    try {
      const verifyRes = await fetch("https://moltbook.com/api/v1/agents/verify-identity", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Moltbook-App-Key": env.MOLTBOOK_APP_KEY!,
        },
        body: JSON.stringify({ token }),
      });

      if (!verifyRes.ok) {
        return {
          authenticated: false,
          tier: "free",
          error: "Moltbook identity verification failed",
        };
      }

      const result = await verifyRes.json() as {
        success: boolean;
        valid: boolean;
        agent?: {
          id: string;
          name: string;
          karma: number;
          is_claimed: boolean;
        };
      };

      if (!result.success || !result.valid || !result.agent) {
        return {
          authenticated: false,
          tier: "free",
          error: "Invalid or expired Moltbook identity token",
        };
      }

      // Build cache entry
      agent = {
        agent_id: result.agent.id,
        name: result.agent.name,
        karma: result.agent.karma,
        is_claimed: result.agent.is_claimed,
        verified_at: new Date().toISOString(),
      };

      // Check if this Moltbook agent is linked to a DiffDelta Pro account
      if (env.KEYS) {
        const linkedHash = await env.KEYS.get(`moltbook:${result.agent.id}`);
        if (linkedHash) {
          agent.linked_key_hash = linkedHash;
        }
      }

      // Cache for 5 minutes (tokens expire in 1hr, so 5min is safe)
      if (env.SESSIONS) {
        await env.SESSIONS.put(cacheKey, JSON.stringify(agent), {
          expirationTtl: 300,
        });
      }
    } catch (err) {
      // Moltbook API is down → don't block the request, degrade to free
      console.error("Moltbook verification error:", err);
      return { authenticated: false, tier: "free" };
    }
  }

  // ── If agent is linked to a DiffDelta Pro account, load that tier ──
  if (agent.linked_key_hash && env.KEYS) {
    const raw = await env.KEYS.get(`key:${agent.linked_key_hash}`);
    if (raw) {
      const keyData: KeyData = JSON.parse(raw);
      if (keyData.active) {
        return {
          authenticated: true,
          tier: keyData.tier,
          key_hash: agent.linked_key_hash,
          key_data: keyData,
          auth_mode: "moltbook",
          moltbook_agent_id: agent.agent_id,
          moltbook_agent_name: agent.name,
        };
      }
    }
  }

  // ── No linked Pro account → authenticated free (but we know who they are) ──
  return {
    authenticated: true,
    tier: "free",
    auth_mode: "moltbook",
    moltbook_agent_id: agent.agent_id,
    moltbook_agent_name: agent.name,
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
