// ─────────────────────────────────────────────────────────
// DiffDelta — Composite Feed Head Pointer
// Why: Lightweight cursor check so agents can detect changes
// without downloading the full composite feed.
// GET /feeds/cf/{id}/head.json
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, CompositeFeed } from "../../../_shared/types";

async function hashString(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env, request } = context;
  const id = String(params.id || "").trim();

  if (!id.startsWith("cf_")) {
    return errorResponse("Feed not found", 404);
  }

  const feedRaw = await env.KEYS.get(`cfeed:${id}`);
  if (!feedRaw) {
    return errorResponse("Feed not found", 404);
  }
  const feed: CompositeFeed = JSON.parse(feedRaw);

  // Access control
  if (feed.visibility === "private") {
    const apiKey = request.headers.get("X-DiffDelta-Key");
    if (!apiKey) {
      return errorResponse("Feed not found", 404);
    }
    const keyBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
    const keyHash = Array.from(new Uint8Array(keyBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (keyHash !== feed.owner_key_hash) {
      return errorResponse("Feed not found", 404);
    }
  }

  // Collect cursors from constituent sources to compute combined cursor
  const siteOrigin = new URL(request.url).origin;
  const sourceCursors: string[] = [];

  for (const sourceId of feed.source_ids) {
    let headPath: string;
    if (sourceId.startsWith("cs_")) {
      headPath = `/diff/${sourceId}/head.json`;
    } else {
      headPath = `/diff/source/${sourceId}/head.json`;
    }

    try {
      const resp = await fetch(`${siteOrigin}${headPath}`);
      if (!resp.ok && !sourceId.startsWith("cs_")) {
        const altResp = await fetch(`${siteOrigin}/diff/${sourceId}/head.json`);
        if (altResp.ok) {
          const altData = await altResp.json() as Record<string, unknown>;
          sourceCursors.push(String(altData.cursor || ""));
        }
        continue;
      }
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        sourceCursors.push(String(data.cursor || ""));
      }
    } catch {
      // Source unavailable
    }
  }

  const cursorInput = sourceCursors.sort().join("|");
  const cursor = `sha256:${await hashString(cursorInput)}`;

  // Check against previously seen cursor for this composite feed
  const prevCursorKey = `cfeed-prev-cursor:${id}`;
  const prevCursor = await env.KEYS.get(prevCursorKey) || `sha256:${"0".repeat(64)}`;
  const changed = cursor !== prevCursor;

  // Store current cursor as previous for next check
  if (changed) {
    await env.KEYS.put(prevCursorKey, cursor, { expirationTtl: 86400 * 7 });
  }

  return jsonResponse({
    cursor,
    prev_cursor: prevCursor,
    changed,
    generated_at: new Date().toISOString(),
    ttl_sec: feed.ttl_sec,
    latest_url: `/feeds/cf/${id}/latest.json`,
    composite: true,
    sources_count: feed.source_ids.length,
    _protocol: {
      standard: "ddv1",
    },
  });
};
