// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — Publish items to a feed
// POST /api/v1/feeds/publish
// Why: agents push structured items; DiffDelta validates, merges,
// recomputes cursors, and hosts the spec-compliant feed files.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import { FREE_FEED_LIMITS } from "../../../_shared/types";
import { authenticateFeedWrite } from "../../../_shared/feeds/auth";
import { getFeedMeta, checkPublishQuota, incrementPublishCount, publishItems } from "../../../_shared/feeds/store";
import { validateAndNormalizeItem, isValidSourceId } from "../../../_shared/feeds/validate";

const MAX_REQUEST_BYTES = 256 * 1024; // 256KB — larger than register since items can be bulky

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

  // Parse body from raw bytes
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes)) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // Authenticate via signed envelope
  const authRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
  const authResult = await authenticateFeedWrite(authRequest, env);
  if (authResult instanceof Response) return authResult;
  const { agent_id } = authResult;

  const action = (body.action || body.data || {}) as Record<string, unknown>;

  // Validate source_id format before KV access
  const sourceId = typeof action.source_id === "string" ? action.source_id.trim() : "";
  if (!sourceId) {
    return errorResponse("source_id is required", 400);
  }
  if (!isValidSourceId(sourceId)) {
    return errorResponse("Invalid source_id format", 400);
  }

  // Verify feed exists and agent owns it
  const meta = await getFeedMeta(env, sourceId);
  if (!meta) {
    return errorResponse(`Feed "${sourceId}" not found`, 404);
  }
  if (meta.owner_agent_id !== agent_id) {
    return errorResponse("You do not own this feed", 403);
  }
  if (!meta.enabled) {
    return errorResponse("This feed is disabled", 403);
  }

  // Check publish quota
  const limits = FREE_FEED_LIMITS;
  const quota = await checkPublishQuota(env, agent_id, limits.max_publishes_per_day);
  if (!quota.allowed) {
    return jsonResponse({
      published: false,
      reason: "publish_quota_exceeded",
      publishes: { limit_24h: limits.max_publishes_per_day, used_24h: quota.used, remaining_24h: 0, reset_at: quota.reset_at },
    }, 429);
  }

  // Validate items
  const rawItems = Array.isArray(action.items) ? action.items : [];
  if (rawItems.length === 0) {
    return errorResponse("items array is required and must not be empty", 400);
  }
  if (rawItems.length > 50) {
    return errorResponse("Maximum 50 items per publish call", 400);
  }

  const validatedItems = [];
  const itemErrors = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    if (!raw || typeof raw !== "object") {
      itemErrors.push({ index: i, errors: ["Item must be an object"] });
      continue;
    }
    const result = await validateAndNormalizeItem(raw as Record<string, unknown>, sourceId, limits);
    if (!result.valid) {
      itemErrors.push({ index: i, errors: result.errors });
    } else if (result.item) {
      // Reject duplicate ids within the same publish call
      if (seenIds.has(result.item.id)) {
        itemErrors.push({ index: i, errors: [`Duplicate item id "${result.item.id}" in this batch`] });
      } else {
        seenIds.add(result.item.id);
        validatedItems.push(result.item);
      }
    }
  }

  if (itemErrors.length > 0) {
    return jsonResponse({
      published: false,
      reason: "validation_errors",
      item_errors: itemErrors,
    }, 422);
  }

  // Increment publish counter synchronously BEFORE publishing
  // (prevents quota bypass on concurrent requests and avoids burning quota on failed publishes)
  await incrementPublishCount(env, agent_id);

  // Publish: merge, deduplicate, recompute cursor
  const result = await publishItems(env, meta, validatedItems, limits);

  return jsonResponse({
    published: true,
    source_id: sourceId,
    items_accepted: validatedItems.length,
    item_count: result.item_count,
    cursor: result.cursor,
    prev_cursor: result.meta.prev_cursor,
    changed: result.cursor !== result.meta.prev_cursor,
    head_url: `/feeds/${sourceId}/head.json`,
    latest_url: `/feeds/${sourceId}/latest.json`,
    publishes: {
      limit_24h: limits.max_publishes_per_day,
      used_24h: quota.used + 1,
      remaining_24h: quota.remaining - 1,
      reset_at: quota.reset_at,
    },
  });
};
