// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — List my feeds
// GET /api/v1/feeds/mine
// Why: agents can list all feeds they own to manage and publish to.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import { extractAgentId } from "../../../_shared/feeds/auth";
import { getAgentFeedRegistry, getFeedMeta } from "../../../_shared/feeds/store";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Authenticate via X-Self-Agent-Id header
  const agentId = extractAgentId(request);
  if (!agentId) {
    return errorResponse("Include X-Self-Agent-Id header with your agent_id", 401);
  }

  // Get all feeds owned by this agent
  const registry = await getAgentFeedRegistry(env, agentId);

  const feeds = [];
  for (const sourceId of registry.feeds) {
    const meta = await getFeedMeta(env, sourceId);
    if (meta && meta.enabled) {
      feeds.push({
        source_id: meta.source_id,
        name: meta.name,
        description: meta.description,
        tags: meta.tags,
        item_count: meta.item_count,
        cursor: meta.cursor,
        visibility: meta.visibility,
        ttl_sec: meta.ttl_sec,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        head_url: `/feeds/${meta.source_id}/head.json`,
        latest_url: `/feeds/${meta.source_id}/latest.json`,
      });
    }
  }

  return jsonResponse({
    agent_id: agentId,
    feed_count: feeds.length,
    feeds,
  });
};
