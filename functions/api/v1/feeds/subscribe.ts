// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — Subscribe / Unsubscribe
// POST /api/v1/feeds/subscribe
// Why: agents subscribe to feeds (public or with READ_FEED grant)
// to track changes via the subscriptions endpoint.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import { extractAgentId } from "../../../_shared/feeds/auth";
import { getFeedMeta, checkFeedReadAccess, addSubscription, removeSubscription, getSubscriptions } from "../../../_shared/feeds/store";
import { isValidSourceId } from "../../../_shared/feeds/validate";

const MAX_REQUEST_BYTES = 4 * 1024; // 4KB — subscribe payloads are tiny

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Authenticate via X-Self-Agent-Id
  const agentId = extractAgentId(request);
  if (!agentId) {
    return errorResponse("Include X-Self-Agent-Id header with your agent_id", 401);
  }

  // Hard body-size cap BEFORE parsing JSON
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > MAX_REQUEST_BYTES) {
    return errorResponse(`Request body too large (${rawBytes.byteLength} bytes, max ${MAX_REQUEST_BYTES})`, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes)) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const sourceId = typeof body.source_id === "string" ? body.source_id.trim() : "";
  if (!sourceId) {
    return errorResponse("source_id is required", 400);
  }

  // Validate source_id format before KV access
  if (!isValidSourceId(sourceId)) {
    return errorResponse("Invalid source_id format", 400);
  }

  const action = typeof body.action === "string" ? body.action : "subscribe";

  // Verify feed exists
  const meta = await getFeedMeta(env, sourceId);
  if (!meta) {
    return errorResponse(`Feed "${sourceId}" not found`, 404);
  }

  if (action === "unsubscribe") {
    await removeSubscription(env, agentId, sourceId);
    return jsonResponse({
      unsubscribed: true,
      source_id: sourceId,
    });
  }

  // For subscribe: check read access (public feeds always OK, private need grant)
  const access = await checkFeedReadAccess(env, meta, agentId);
  if (!access.allowed) {
    return jsonResponse({
      subscribed: false,
      reason: "access_denied",
      detail: access.reason,
    }, 403);
  }

  // Check subscription limit (max 100 subscriptions per agent)
  const subs = await getSubscriptions(env, agentId);
  if (subs.subscriptions.length >= 100 && !subs.subscriptions.includes(sourceId)) {
    return errorResponse("Maximum 100 subscriptions. Unsubscribe from feeds to add new ones.", 429);
  }

  await addSubscription(env, agentId, sourceId);

  return jsonResponse({
    subscribed: true,
    source_id: sourceId,
    feed_name: meta.name,
    visibility: meta.visibility,
    head_url: `/feeds/${sourceId}/head.json`,
    latest_url: `/feeds/${sourceId}/latest.json`,
  });
};
