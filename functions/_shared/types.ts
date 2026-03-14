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
  SELF: KVNamespace;          // Self Capsule state (capsules, cursors, seq, quotas)
  FEEDS: KVNamespace;         // Agent-published feeds (metadata, items, heads, subscriptions)

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
  custom_sources_limit: number;  // 2 (free), 10 (pro), -1 (enterprise = unlimited)
  custom_source_ids: string[];   // IDs of owned custom sources
  composite_feed_ids?: string[]; // IDs of owned composite feeds
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
  url: string;                    // Canonical upstream URL
  status: "active" | "paused";
  visibility: "private" | "public";
  submitted_at: string;           // ISO 8601
  adapter: "rss" | "json";
  config: CustomSourceConfig;
  description?: string;
  tags?: string[];                // e.g. ["security", "ai"]
}

/** Engine-compatible config embedded in CustomSource */
export interface CustomSourceConfig {
  feed_url?: string;              // RSS adapter
  api_url?: string;               // JSON adapter
  json_items_key?: string;
  json_title_field?: string;
  json_content_field?: string;
  url_prefix?: string;
  promote_fields?: string[];
  max_items: number;              // Capped: free=50, pro=200
  ttl_sec: number;                // Floor: 900 (15 min)
}

/** Stored in KV under `cfeed:{id}` */
export interface CompositeFeed {
  id: string;                     // e.g. "cf_x1y2z3"
  owner_key_hash: string;        // SHA-256 of the owning API key
  name: string;
  description?: string;
  tags?: string[];
  source_ids: string[];           // Mix of curated IDs and "cs_*" custom IDs
  visibility: "private" | "public";
  created_at: string;             // ISO 8601
  updated_at: string;             // ISO 8601
  ttl_sec: number;                // Polling interval hint (default: min of source TTLs)
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

// ─────────────────────────────────────────────────────────
// Agent-published feeds — managed publishing infrastructure
// Why: agents publish their own changefeeds using the ddv1 protocol.
// DiffDelta validates, hosts, and serves them identically to curated feeds.
// ─────────────────────────────────────────────────────────

/** Write-access grant for multi-writer feeds */
export interface AuthorizedWriter {
  agent_id: string;               // 64-hex agent ID
  granted_at: string;             // ISO 8601
  expires_at?: string;            // ISO 8601 (optional, enforced server-side)
}

/** How an agent composed a derived feed from multiple sources */
export interface FeedRecipe {
  input_sources: string[];        // Source IDs this feed draws from (max 20)
  strategy: string;               // Free-text description of the composition logic (max 500 chars)
  filters?: string[];             // Filtering criteria applied (max 10, each max 200 chars)
  output_format?: string;         // How results are structured/ranked (max 200 chars)
}

/** Stored in FEEDS KV under `feed:meta:{source_id}` */
export interface AgentFeedMeta {
  source_id: string;              // e.g. "agent_ab12cd_my_security_feed"
  owner_agent_id: string;         // SHA-256 agent_id from Self Capsule
  name: string;                   // Display name (max 100 chars)
  description: string;            // Max 500 chars
  tags: string[];                 // Max 5 tags, pattern: ^[a-z0-9_\-]{2,32}$
  recipe?: FeedRecipe;            // How this feed was composed from other sources
  created_at: string;             // ISO 8601
  updated_at: string;             // ISO 8601
  item_count: number;             // Current items in feed
  cursor: string | null;          // Current cursor (sha256:<hex>)
  prev_cursor: string | null;     // Previous cursor
  ttl_sec: number;                // Suggested polling interval (60-3600)
  visibility: "public" | "private"; // Access control level
  enabled: boolean;
  authorized_writers?: AuthorizedWriter[]; // Max 20 — agents granted write access
}

/** Stored in FEEDS KV under `feed:registry:{agent_id}` */
export interface AgentFeedRegistry {
  feeds: string[];                // Array of source_ids owned by this agent
}

/** Stored in FEEDS KV under `feed:subs:{agent_id}` */
export interface AgentFeedSubscriptions {
  subscriptions: string[];        // Array of source_ids this agent subscribes to
}

/** A single item in an agent-published feed (subset of deltaItem) */
export interface AgentFeedItem {
  id: string;                     // Unique within this feed (1-200 chars)
  url: string;                    // URI
  headline: string;               // 1-2000 chars
  published_at: string;           // ISO 8601
  updated_at: string;             // ISO 8601
  content: {
    lang?: string;                // ISO 639-1 (default: "und")
    excerpt_text?: string;        // Max 500 chars
  };
  risk?: {
    score: number;                // 0-1 (publisher-provided, DiffDelta does not compute)
    reasons?: string[];           // Max 10, pattern: ^[a-z0-9_\-]{2,64}$
  };
  provenance: {
    fetched_at: string;           // ISO 8601
    evidence_urls: string[];      // 1-20 URIs
    content_hash: string;         // sha256:<64-char-hex>
  };
  source: string;                 // Source ID (auto-filled to feed source_id)
  published_by?: string;          // agent_id of the writer (server-set, never trusted from input)
  _safety_flags?: string[];       // Server-stamped injection pattern flags (never trusted from input)
}

/** Entry in the public feed discovery index */
export interface FeedIndexEntry {
  source_id: string;
  name: string;
  description: string;
  tags: string[];
  recipe?: FeedRecipe;
  owner_agent_id: string;
  cursor: string | null;
  item_count: number;
  created_at: string;
  writers_count: number;
}

/** Feed publish limits */
export interface AgentFeedLimits {
  max_feeds_per_agent: number;
  max_items_per_feed: number;
  max_item_bytes: number;
  max_publishes_per_day: number;
  retention_days: number;
}

export const FREE_FEED_LIMITS: AgentFeedLimits = {
  max_feeds_per_agent: 3,
  max_items_per_feed: 50,
  max_item_bytes: 4096,
  max_publishes_per_day: 20,
  retention_days: 7,
};

export const PRO_FEED_LIMITS: AgentFeedLimits = {
  max_feeds_per_agent: 20,
  max_items_per_feed: 500,
  max_item_bytes: 16384,
  max_publishes_per_day: 200,
  retention_days: 90,
};

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
