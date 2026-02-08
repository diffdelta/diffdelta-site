// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Type definitions
// Why: Single source of truth for all shared types across
// Pages Functions (middleware, endpoints, Stripe handlers).
// ─────────────────────────────────────────────────────────

/**
 * Cloudflare Pages Function environment bindings.
 * KV namespaces and secrets are configured in Cloudflare dashboard.
 */
export interface Env {
  // ── KV Namespaces ──
  KEYS: KVNamespace;          // API keys (hashed) → KeyData
  RATE_LIMITS: KVNamespace;   // Rate limit counters (ephemeral, TTL-based)
  SESSIONS: KVNamespace;      // Stripe sessions, magic link tokens, auth sessions

  // ── Secrets (set in Cloudflare Pages > Settings > Environment variables) ──
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;
  RESEND_API_KEY: string;     // Email delivery (magic links). Optional — feature disabled if missing
  ADMIN_SECRET: string;       // Bearer token for admin endpoints
  MOLTBOOK_APP_KEY?: string;  // moltdev_ key for verifying bot identity tokens. Optional — feature disabled if missing
}

/** Stored in KV under `key:{sha256(raw_key)}` */
export interface KeyData {
  tier: "pro" | "enterprise";
  customer_id: string;           // Stripe customer ID
  stripe_subscription_id: string;
  email: string;
  rate_limit: number;            // requests per minute
  created_at: string;            // ISO 8601
  last_rotated_at: string;       // ISO 8601
  active: boolean;
  custom_sources_limit: number;  // 2 (pro), -1 (enterprise = unlimited)
  custom_source_ids: string[];   // IDs of owned custom sources
}

/** Stored in KV under `session:{stripe_session_id}` with 1hr TTL */
export interface SessionClaim {
  api_key: string;               // Raw key (shown once to user)
  email: string;
  created_at: string;
}

/** Result of rate limit check */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset_at: number;              // Unix timestamp (seconds)
  limit: number;
}

/** Stored in KV under `custom:{id}` */
export interface CustomSource {
  id: string;                     // e.g. "cs_a1b2c3d4e5f6"
  owner_key_hash: string;        // SHA-256 of the owning API key
  name: string;                   // User-provided display name
  url: string;                    // Submitted URL to monitor
  status: "pending" | "reviewing" | "active" | "rejected";
  review_notes?: string;          // Admin notes on review decision
  submitted_at: string;           // ISO 8601
  reviewed_at?: string;           // ISO 8601
  feed_source_id?: string;        // Generator source_id once active
}

/** Stored in SESSIONS KV under `magic:{token}` with 15min TTL */
export interface MagicLinkToken {
  email: string;
  key_hash: string;            // The key_hash to authenticate as
  created_at: string;          // ISO 8601
}

/** Stored in SESSIONS KV under `auth:{session_id}` with 7-day TTL */
export interface AuthSession {
  email: string;
  key_hash: string;            // Resolved key_hash for this user
  created_at: string;          // ISO 8601
}

/** Cached Moltbook agent verification — stored in SESSIONS KV under `moltbook:{agent_id}` with 5min TTL */
export interface MoltbookAgentCache {
  agent_id: string;
  name: string;
  karma: number;
  is_claimed: boolean;
  verified_at: string;           // ISO 8601 — when we last verified with Moltbook
  linked_key_hash?: string;      // If this Moltbook agent is linked to a DiffDelta Pro account
}

/** Webhook registration (Phase 2 — type reserved now) */
export interface WebhookRegistration {
  id: string;
  url: string;
  secret: string;                // HMAC signing secret
  tags: string[];                // Filter by tags (empty = all)
  sources: string[];             // Filter by source IDs (empty = all)
  active: boolean;
  created_at: string;
  last_delivered_at: string | null;
  consecutive_failures: number;
}
