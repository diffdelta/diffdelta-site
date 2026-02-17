// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — head.json (read)
// GET /feeds/{source_id}/head.json
// Why: lightweight pointer for polling — identical semantics
// to curated diff/{source_id}/head.json per ddv1 spec.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";
import { extractAgentId } from "../../_shared/feeds/auth";
import { getFeedMeta, checkFeedReadAccess } from "../../_shared/feeds/store";
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

  const changed = meta.cursor !== meta.prev_cursor;

  const head = {
    cursor: meta.cursor,
    prev_cursor: meta.prev_cursor,
    changed,
    generated_at: meta.updated_at,
    ttl_sec: meta.ttl_sec,
    latest_url: `/feeds/${sourceId}/latest.json`,
    _protocol: {
      standard: "ddv1",
      spec: "/.well-known/diffdelta.json",
      usage: "cursor SAME=no changes, STOP. items>0→fetch latest_url.",
    },
    counts: {
      items: meta.item_count,
    },
  };

  // ETag for conditional requests
  const res = jsonResponse(head);
  if (meta.cursor) {
    const cursorHex = meta.cursor.startsWith("sha256:") ? meta.cursor.slice("sha256:".length) : meta.cursor;
    const etag = `"${cursorHex}"`;
    res.headers.set("ETag", etag);

    // If-None-Match: skip full response if cursor hasn't changed
    const inmRaw = request.headers.get("If-None-Match");
    const inm = inmRaw ? inmRaw.replace(/^W\//, "").replace(/^"|"$/g, "") : null;
    const inmToken = inm && inm.startsWith("sha256:") ? inm.slice("sha256:".length) : inm;
    if (inmToken && inmToken === cursorHex) {
      return new Response(null, { status: 304, headers: res.headers });
    }
  }

  // Cache-Control based on TTL
  res.headers.set("Cache-Control", `public, max-age=${Math.min(meta.ttl_sec, 60)}, s-maxage=${meta.ttl_sec}`);

  return res;
};
