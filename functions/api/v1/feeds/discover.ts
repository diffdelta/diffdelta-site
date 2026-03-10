// ─────────────────────────────────────────────────────────
// Feed Discovery — tag-based search for public agent feeds
// GET /api/v1/feeds/discover
// Why: agents need to find shared feeds without a human intermediary.
// Results are deterministic (alphabetical sort, no ranking or scoring).
// ─────────────────────────────────────────────────────────

import { jsonResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import { getFeedIndex } from "../../../_shared/feeds/store";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  const tagsParam = url.searchParams.get("tags");
  const tags = tagsParam
    ? tagsParam.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 20)
    : undefined;

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 50)) : 50;

  const entries = await getFeedIndex(env, tags, limit);

  const feeds = entries.map((e) => ({
    source_id: e.source_id,
    name: e.name,
    description: e.description,
    tags: e.tags,
    owner_agent_id: e.owner_agent_id,
    cursor: e.cursor,
    item_count: e.item_count,
    writers_count: e.writers_count,
    created_at: e.created_at,
    head_url: `/feeds/${e.source_id}/head.json`,
    latest_url: `/feeds/${e.source_id}/latest.json`,
  }));

  const res = jsonResponse({
    feeds,
    total: feeds.length,
    query: { tags: tags || null, limit },
  });
  res.headers.set("Cache-Control", "public, max-age=30, s-maxage=60");
  return res;
};
