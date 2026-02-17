// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — Register a new feed
// POST /api/v1/feeds/register
// Why: agents create named feeds they'll publish items to.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, AgentFeedMeta } from "../../../_shared/types";
import { FREE_FEED_LIMITS } from "../../../_shared/types";
import { authenticateFeedWrite } from "../../../_shared/feeds/auth";
import { getFeedMeta, putFeedMeta, getAgentFeedRegistry, addFeedToRegistry } from "../../../_shared/feeds/store";
import { isValidSourceId, isValidTag, slugify } from "../../../_shared/feeds/validate";

const MAX_REQUEST_BYTES = 64 * 1024; // 64KB — same cap as Self Capsule writes

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Hard body-size cap BEFORE parsing JSON (protects against DoS via large payloads)
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > MAX_REQUEST_BYTES) {
    return errorResponse(`Request body too large (${rawBytes.byteLength} bytes, max ${MAX_REQUEST_BYTES})`, 413);
  }

  // Parse body from raw bytes (avoids consuming the stream twice)
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes)) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // Authenticate via signed envelope (build a new Request with the parsed body)
  const authRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
  const authResult = await authenticateFeedWrite(authRequest, env);
  if (authResult instanceof Response) return authResult;
  const { agent_id } = authResult;
  const action = (body.action || body.data || {}) as Record<string, unknown>;

  // Validate required fields
  const name = typeof action.name === "string" ? action.name.trim() : "";
  if (!name || name.length > 100) {
    return errorResponse("name is required (1-100 chars)", 400);
  }

  const description = typeof action.description === "string" ? action.description.trim() : "";
  if (description.length > 500) {
    return errorResponse("description must be 500 chars or less", 400);
  }

  // Tags: validate format
  let tags: string[] = [];
  if (Array.isArray(action.tags)) {
    tags = action.tags.filter((t): t is string => typeof t === "string" && isValidTag(t)).slice(0, 5);
  }

  // Visibility: default public
  const visibility = action.visibility === "private" ? "private" : "public";

  // TTL: clamp to 60-3600
  let ttlSec = typeof action.ttl_sec === "number" ? action.ttl_sec : 300;
  ttlSec = Math.max(60, Math.min(3600, ttlSec));

  // Check feed count limit
  const registry = await getAgentFeedRegistry(env, agent_id);
  if (registry.feeds.length >= FREE_FEED_LIMITS.max_feeds_per_agent) {
    return errorResponse(
      `Maximum feeds reached (${FREE_FEED_LIMITS.max_feeds_per_agent}). Delete a feed or upgrade.`,
      429
    );
  }

  // Generate source_id: agent_{first8}_slug
  const slugged = slugify(name);
  const sourceId = `agent_${agent_id.slice(0, 8)}_${slugged}`;

  if (!isValidSourceId(sourceId)) {
    return errorResponse("Generated source_id is invalid. Use a simpler feed name.", 400);
  }

  // Check if source_id already exists
  const existing = await getFeedMeta(env, sourceId);
  if (existing) {
    return errorResponse(`Feed "${sourceId}" already exists`, 409);
  }

  // Create feed metadata
  const now = new Date().toISOString();
  const meta: AgentFeedMeta = {
    source_id: sourceId,
    owner_agent_id: agent_id,
    name,
    description,
    tags,
    created_at: now,
    updated_at: now,
    item_count: 0,
    cursor: null,
    prev_cursor: null,
    ttl_sec: ttlSec,
    visibility,
    enabled: true,
  };

  // Persist
  await putFeedMeta(env, meta);
  await addFeedToRegistry(env, agent_id, sourceId);

  return jsonResponse({
    registered: true,
    source_id: sourceId,
    name,
    visibility,
    ttl_sec: ttlSec,
    head_url: `/feeds/${sourceId}/head.json`,
    latest_url: `/feeds/${sourceId}/latest.json`,
    publish_url: `/api/v1/feeds/publish`,
    limits: {
      max_items_per_feed: FREE_FEED_LIMITS.max_items_per_feed,
      max_item_bytes: FREE_FEED_LIMITS.max_item_bytes,
      max_publishes_per_day: FREE_FEED_LIMITS.max_publishes_per_day,
      retention_days: FREE_FEED_LIMITS.retention_days,
    },
  }, 201);
};
