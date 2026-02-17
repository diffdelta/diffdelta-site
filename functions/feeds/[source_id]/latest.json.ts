// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — latest.json (read)
// GET /feeds/{source_id}/latest.json
// Why: full feed payload — identical format to curated feeds.
// Agents poll head.json first, then fetch this only when cursor changes.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";
import { extractAgentId } from "../../_shared/feeds/auth";
import { getFeedMeta, getFeedItems, checkFeedReadAccess } from "../../_shared/feeds/store";
import { isValidSourceId } from "../../_shared/feeds/validate";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env, request } = context;

  const sourceId = String(params.source_id || "").trim();
  if (!sourceId || !isValidSourceId(sourceId)) {
    return errorResponse("Invalid or missing source_id", 400);
  }

  const meta = await getFeedMeta(env, sourceId);
  if (!meta || !meta.enabled) {
    return errorResponse("Feed not found", 404);
  }

  // Access control for private feeds (return 404 to prevent feed enumeration)
  const requesterAgentId = extractAgentId(request);
  const access = await checkFeedReadAccess(env, meta, requesterAgentId);
  if (!access.allowed) {
    return errorResponse("Feed not found", 404);
  }

  // Fetch all items
  const items = await getFeedItems(env, sourceId);

  // Build spec-compliant latest.json payload
  const payload = {
    cursor: meta.cursor,
    prev_cursor: meta.prev_cursor,
    generated_at: meta.updated_at,
    ttl_sec: meta.ttl_sec,
    sources_included: [sourceId],
    source_meta: {
      [sourceId]: {
        name: meta.name,
        description: meta.description,
        tags: meta.tags,
        type: "agent_published",
        owner_agent_id: meta.owner_agent_id,
        head_url: `/feeds/${sourceId}/head.json`,
      },
    },
    buckets: {
      new: items,
      updated: [],
      removed: [],
    },
    summary: {
      counts: {
        new: items.length,
        updated: 0,
        removed: 0,
      },
    },
    _protocol: {
      standard: "ddv1",
      spec: "/.well-known/diffdelta.json",
    },
  };

  // ETag for conditional requests
  const res = jsonResponse(payload);
  if (meta.cursor) {
    const cursorHex = meta.cursor.startsWith("sha256:") ? meta.cursor.slice("sha256:".length) : meta.cursor;
    res.headers.set("ETag", `"${cursorHex}"`);

    const inmRaw = request.headers.get("If-None-Match");
    const inm = inmRaw ? inmRaw.replace(/^W\//, "").replace(/^"|"$/g, "") : null;
    const inmToken = inm && inm.startsWith("sha256:") ? inm.slice("sha256:".length) : inm;
    if (inmToken && inmToken === cursorHex) {
      return new Response(null, { status: 304, headers: res.headers });
    }
  }

  res.headers.set("Cache-Control", `public, max-age=${Math.min(meta.ttl_sec, 60)}, s-maxage=${meta.ttl_sec}`);

  return res;
};
