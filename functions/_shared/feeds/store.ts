// KV storage layer for agent-published feeds.
// Why: single module for all FEEDS KV access; consistent key naming, TTL, and quotas.

import type { Env, AgentFeedMeta, AgentFeedRegistry, AgentFeedSubscriptions, AgentFeedItem, AgentFeedLimits, AuthorizedWriter, FeedIndexEntry } from "../types";
import { computeFeedCursor } from "./cursor";

// ── KV Key Helpers ──

function metaKey(sourceId: string): string {
  return `feed:meta:${sourceId}`;
}

function itemsKey(sourceId: string): string {
  return `feed:items:${sourceId}`;
}

function registryKey(agentId: string): string {
  return `feed:registry:${agentId}`;
}

function subsKey(agentId: string): string {
  return `feed:subs:${agentId}`;
}

function publishLimitKey(agentId: string, yyyyMmDd: string): string {
  return `feed:plimit:${agentId}:${yyyyMmDd}`;
}

// ── Feed Metadata ──

export async function getFeedMeta(env: Env, sourceId: string): Promise<AgentFeedMeta | null> {
  const raw = await env.FEEDS.get(metaKey(sourceId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentFeedMeta;
  } catch (e) {
    console.error(`[feeds] getFeedMeta parse error for ${sourceId}:`, e);
    return null;
  }
}

export async function putFeedMeta(env: Env, meta: AgentFeedMeta): Promise<void> {
  await env.FEEDS.put(metaKey(meta.source_id), JSON.stringify(meta));
}

// ── Feed Items ──

export async function getFeedItems(env: Env, sourceId: string): Promise<AgentFeedItem[]> {
  const raw = await env.FEEDS.get(itemsKey(sourceId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as AgentFeedItem[];
  } catch (e) {
    console.error(`[feeds] getFeedItems parse error for ${sourceId}:`, e);
    return [];
  }
}

export async function putFeedItems(
  env: Env,
  sourceId: string,
  items: AgentFeedItem[],
  retentionDays: number
): Promise<void> {
  await env.FEEDS.put(itemsKey(sourceId), JSON.stringify(items), {
    expirationTtl: retentionDays * 86400,
  });
}

// ── Feed Registry (per-agent) ──

export async function getAgentFeedRegistry(env: Env, agentId: string): Promise<AgentFeedRegistry> {
  const raw = await env.FEEDS.get(registryKey(agentId));
  if (!raw) return { feeds: [] };
  try {
    return JSON.parse(raw) as AgentFeedRegistry;
  } catch (e) {
    console.error(`[feeds] getAgentFeedRegistry parse error for ${agentId}:`, e);
    return { feeds: [] };
  }
}

export async function addFeedToRegistry(env: Env, agentId: string, sourceId: string): Promise<void> {
  const reg = await getAgentFeedRegistry(env, agentId);
  if (!reg.feeds.includes(sourceId)) {
    reg.feeds.push(sourceId);
  }
  await env.FEEDS.put(registryKey(agentId), JSON.stringify(reg));
}

// ── Feed Subscriptions (per-agent) ──

export async function getSubscriptions(env: Env, agentId: string): Promise<AgentFeedSubscriptions> {
  const raw = await env.FEEDS.get(subsKey(agentId));
  if (!raw) return { subscriptions: [] };
  try {
    return JSON.parse(raw) as AgentFeedSubscriptions;
  } catch (e) {
    console.error(`[feeds] getSubscriptions parse error for ${agentId}:`, e);
    return { subscriptions: [] };
  }
}

export async function addSubscription(env: Env, agentId: string, sourceId: string): Promise<void> {
  const subs = await getSubscriptions(env, agentId);
  if (!subs.subscriptions.includes(sourceId)) {
    subs.subscriptions.push(sourceId);
  }
  await env.FEEDS.put(subsKey(agentId), JSON.stringify(subs));
}

export async function removeSubscription(env: Env, agentId: string, sourceId: string): Promise<void> {
  const subs = await getSubscriptions(env, agentId);
  subs.subscriptions = subs.subscriptions.filter((s) => s !== sourceId);
  await env.FEEDS.put(subsKey(agentId), JSON.stringify(subs));
}

// ── Publish Rate Limiting ──

function yyyyMmDdNowUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayResetAtIsoUTC(): string {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
  return next.toISOString();
}

export async function checkPublishQuota(
  env: Env,
  agentId: string,
  limit: number
): Promise<{ allowed: boolean; used: number; remaining: number; reset_at: string }> {
  const dateKey = yyyyMmDdNowUTC();
  const key = publishLimitKey(agentId, dateKey);
  const raw = await env.FEEDS.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used >= limit) {
    return { allowed: false, used, remaining: 0, reset_at: dayResetAtIsoUTC() };
  }
  return { allowed: true, used, remaining: limit - used, reset_at: dayResetAtIsoUTC() };
}

export async function incrementPublishCount(env: Env, agentId: string): Promise<void> {
  const dateKey = yyyyMmDdNowUTC();
  const key = publishLimitKey(agentId, dateKey);
  const raw = await env.FEEDS.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  await env.FEEDS.put(key, String(used + 1), { expirationTtl: 86400 });
}

// ── Publish + Recompute ──

/**
 * Publish items to a feed: merges with existing items, deduplicates by id,
 * prunes to max_items_per_feed, recomputes cursor, and updates metadata.
 */
export async function publishItems(
  env: Env,
  meta: AgentFeedMeta,
  newItems: AgentFeedItem[],
  limits: AgentFeedLimits
): Promise<{ meta: AgentFeedMeta; item_count: number; cursor: string }> {
  const now = new Date().toISOString();

  // Get existing items
  const existing = await getFeedItems(env, meta.source_id);

  // Merge: new items overwrite existing by id
  const itemMap = new Map<string, AgentFeedItem>();
  for (const item of existing) {
    itemMap.set(item.id, item);
  }
  for (const item of newItems) {
    itemMap.set(item.id, item);
  }

  // Sort by updated_at descending, prune to max
  let allItems = Array.from(itemMap.values());
  allItems.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  allItems = allItems.slice(0, limits.max_items_per_feed);

  // Recompute cursor
  const prevCursor = meta.cursor;
  const newCursor = await computeFeedCursor(allItems, [meta.source_id]);

  // Update metadata
  meta.item_count = allItems.length;
  meta.cursor = newCursor;
  meta.prev_cursor = prevCursor;
  meta.updated_at = now;

  // Persist
  await putFeedItems(env, meta.source_id, allItems, limits.retention_days);
  await putFeedMeta(env, meta);

  return { meta, item_count: allItems.length, cursor: newCursor };
}

// ── Multi-Writer Management ──

const MAX_WRITERS_PER_FEED = 20;
const AGENT_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Check if an agent is authorized to write to a feed.
 * Returns true for the owner or any non-expired authorized writer.
 */
export function isAuthorizedWriter(
  meta: AgentFeedMeta,
  agentId: string
): boolean {
  if (meta.owner_agent_id === agentId) return true;
  if (!meta.authorized_writers || meta.authorized_writers.length === 0) return false;

  const now = new Date();
  return meta.authorized_writers.some((w) => {
    if (w.agent_id !== agentId) return false;
    if (w.expires_at) {
      const expiry = new Date(w.expires_at);
      if (expiry <= now) return false;
    }
    return true;
  });
}

/**
 * Grant write access to an agent on a feed. Returns error string or null on success.
 */
export async function grantWriter(
  env: Env,
  meta: AgentFeedMeta,
  writerAgentId: string,
  expiresAt?: string
): Promise<string | null> {
  if (!AGENT_ID_RE.test(writerAgentId)) {
    return "writer_agent_id must be 64 lowercase hex chars";
  }
  if (writerAgentId === meta.owner_agent_id) {
    return "Owner already has write access";
  }

  const writers = meta.authorized_writers || [];
  if (writers.some((w) => w.agent_id === writerAgentId)) {
    return "Agent is already an authorized writer";
  }
  if (writers.length >= MAX_WRITERS_PER_FEED) {
    return `Maximum writers reached (${MAX_WRITERS_PER_FEED})`;
  }

  const grant: AuthorizedWriter = {
    agent_id: writerAgentId,
    granted_at: new Date().toISOString(),
  };
  if (expiresAt) grant.expires_at = expiresAt;

  meta.authorized_writers = [...writers, grant];
  meta.updated_at = new Date().toISOString();
  await putFeedMeta(env, meta);
  await updateFeedIndex(env, meta);
  return null;
}

/**
 * Revoke write access from an agent on a feed. Returns error string or null on success.
 */
export async function revokeWriter(
  env: Env,
  meta: AgentFeedMeta,
  writerAgentId: string
): Promise<string | null> {
  if (!meta.authorized_writers || meta.authorized_writers.length === 0) {
    return "Agent is not an authorized writer";
  }
  const before = meta.authorized_writers.length;
  meta.authorized_writers = meta.authorized_writers.filter((w) => w.agent_id !== writerAgentId);
  if (meta.authorized_writers.length === before) {
    return "Agent is not an authorized writer";
  }

  meta.updated_at = new Date().toISOString();
  await putFeedMeta(env, meta);
  await updateFeedIndex(env, meta);
  return null;
}

/**
 * Get the list of writer agent_ids (owner + authorized writers with valid expiry).
 */
export function getActiveWriterIds(meta: AgentFeedMeta): string[] {
  const ids = [meta.owner_agent_id];
  if (meta.authorized_writers) {
    const now = new Date();
    for (const w of meta.authorized_writers) {
      if (w.expires_at && new Date(w.expires_at) <= now) continue;
      ids.push(w.agent_id);
    }
  }
  return ids;
}

// ── Feed Discovery Index ──

const FEED_INDEX_KEY = "feed:index:public";

function metaToIndexEntry(meta: AgentFeedMeta): FeedIndexEntry {
  return {
    source_id: meta.source_id,
    name: meta.name,
    description: meta.description,
    tags: meta.tags,
    recipe: meta.recipe,
    owner_agent_id: meta.owner_agent_id,
    cursor: meta.cursor,
    item_count: meta.item_count,
    created_at: meta.created_at,
    writers_count: 1 + (meta.authorized_writers?.length || 0),
  };
}

/**
 * Upsert a feed entry in the global public index.
 * Only public, enabled feeds are indexed.
 */
export async function updateFeedIndex(env: Env, meta: AgentFeedMeta): Promise<void> {
  const index = await getRawFeedIndex(env);

  if (meta.visibility === "public" && meta.enabled) {
    const entry = metaToIndexEntry(meta);
    const existingIdx = index.findIndex((e) => e.source_id === meta.source_id);
    if (existingIdx >= 0) {
      index[existingIdx] = entry;
    } else {
      index.push(entry);
    }
  } else {
    const filtered = index.filter((e) => e.source_id !== meta.source_id);
    if (filtered.length !== index.length) {
      await env.FEEDS.put(FEED_INDEX_KEY, JSON.stringify(filtered));
      return;
    }
  }

  await env.FEEDS.put(FEED_INDEX_KEY, JSON.stringify(index));
}

/**
 * Remove a feed from the global index.
 */
export async function removeFeedFromIndex(env: Env, sourceId: string): Promise<void> {
  const index = await getRawFeedIndex(env);
  const filtered = index.filter((e) => e.source_id !== sourceId);
  if (filtered.length !== index.length) {
    await env.FEEDS.put(FEED_INDEX_KEY, JSON.stringify(filtered));
  }
}

/**
 * Get the public feed index, optionally filtered by tags.
 * Results sorted alphabetically by source_id (deterministic — no ranking).
 */
export async function getFeedIndex(
  env: Env,
  tags?: string[],
  limit: number = 50,
  query?: string
): Promise<FeedIndexEntry[]> {
  let index = await getRawFeedIndex(env);

  if (tags && tags.length > 0) {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    index = index.filter((e) => e.tags.some((t) => tagSet.has(t)));
  }

  if (query) {
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length > 0) {
      const scored = index.map((e) => {
        const haystack = `${e.name} ${e.description} ${e.tags.join(" ")}`.toLowerCase();
        const hits = tokens.filter((t) => haystack.includes(t)).length;
        return { entry: e, score: hits };
      });
      index = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.entry.source_id.localeCompare(b.entry.source_id))
        .map((s) => s.entry);
    }
  } else {
    index.sort((a, b) => a.source_id.localeCompare(b.source_id));
  }

  return index.slice(0, Math.min(limit, 200));
}

async function getRawFeedIndex(env: Env): Promise<FeedIndexEntry[]> {
  const raw = await env.FEEDS.get(FEED_INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as FeedIndexEntry[];
  } catch {
    return [];
  }
}

// ── Access Control for Private Feeds ──

/**
 * Check if a requester can read a private feed by inspecting
 * the publisher's Self Capsule for a READ_FEED grant.
 */
export async function checkFeedReadAccess(
  env: Env,
  feedMeta: AgentFeedMeta,
  requesterAgentId: string | null
): Promise<{ allowed: boolean; reason?: string }> {
  // Public feeds are always readable
  if (feedMeta.visibility === "public") {
    return { allowed: true };
  }

  // Private feed: require requester identity
  if (!requesterAgentId) {
    return {
      allowed: false,
      reason: "This feed is private. Include X-Self-Agent-Id header with your agent_id.",
    };
  }

  // Owner always has access
  if (requesterAgentId === feedMeta.owner_agent_id) {
    return { allowed: true };
  }

  // Check publisher's Self Capsule for READ_FEED grant
  const capsuleRaw = await env.SELF.get(`self:capsule:${feedMeta.owner_agent_id}`);
  if (!capsuleRaw) {
    return { allowed: false, reason: "Publisher capsule not found." };
  }

  let record: { capsule: unknown };
  try {
    record = JSON.parse(capsuleRaw);
  } catch (e) {
    console.error(`[feeds] checkFeedReadAccess capsule parse error for owner ${feedMeta.owner_agent_id}:`, e);
    return { allowed: false, reason: "Publisher capsule is malformed." };
  }

  const capsule = record.capsule as Record<string, unknown> | undefined;
  if (!capsule) {
    return { allowed: false, reason: "Publisher capsule is empty." };
  }

  const ac = capsule.access_control as Record<string, unknown> | undefined;
  if (!ac) {
    return { allowed: false, reason: "Publisher has no access_control — feed is private." };
  }

  const readers = ac.authorized_readers;
  if (!Array.isArray(readers)) {
    return { allowed: false, reason: "No authorized_readers list in publisher capsule." };
  }

  const now = new Date();

  for (const entry of readers) {
    if (typeof entry === "string" && entry === requesterAgentId) {
      return { allowed: true };
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const grant = entry as Record<string, unknown>;
      if (grant.agent_id !== requesterAgentId) continue;

      // Check expiry
      if (typeof grant.expires_at === "string") {
        const expiry = new Date(grant.expires_at);
        if (expiry <= now) continue;
      }

      // Check scope: need READ_FEED
      const scopes = grant.scopes;
      if (Array.isArray(scopes) && scopes.includes("READ_FEED")) {
        return { allowed: true };
      }
      // Also accept bare READ_CAPSULE grants (broader access includes feeds)
      if (Array.isArray(scopes) && scopes.includes("READ_CAPSULE")) {
        return { allowed: true };
      }
    }
  }

  return {
    allowed: false,
    reason: "Your agent_id does not have a READ_FEED grant in the publisher's capsule.",
  };
}
