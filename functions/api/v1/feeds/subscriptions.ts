// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — List subscriptions
// GET /api/v1/feeds/subscriptions
// Why: agents poll this to discover which subscribed feeds
// have new content (cursor changed) without reading every feed.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import { extractAgentId } from "../../../_shared/feeds/auth";
import { getSubscriptions, getFeedMeta, checkFeedReadAccess } from "../../../_shared/feeds/store";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Authenticate via X-Self-Agent-Id
  const agentId = extractAgentId(request);
  if (!agentId) {
    return errorResponse("Include X-Self-Agent-Id header with your agent_id", 401);
  }

  // Optional cursor param — if provided, only return feeds that changed since this cursor
  const url = new URL(request.url);
  const sinceCursor = url.searchParams.get("since_cursor");

  const subs = await getSubscriptions(env, agentId);
  const feeds = [];

  for (const sourceId of subs.subscriptions) {
    const meta = await getFeedMeta(env, sourceId);
    if (!meta || !meta.enabled) continue;

    // Check access (grant might have been revoked)
    const access = await checkFeedReadAccess(env, meta, agentId);
    if (!access.allowed) continue;

    const changed = sinceCursor ? meta.cursor !== sinceCursor : true;

    feeds.push({
      source_id: meta.source_id,
      name: meta.name,
      cursor: meta.cursor,
      prev_cursor: meta.prev_cursor,
      changed,
      item_count: meta.item_count,
      updated_at: meta.updated_at,
      head_url: `/feeds/${meta.source_id}/head.json`,
      latest_url: `/feeds/${meta.source_id}/latest.json`,
    });
  }

  return jsonResponse({
    agent_id: agentId,
    subscription_count: feeds.length,
    feeds,
  });
};
