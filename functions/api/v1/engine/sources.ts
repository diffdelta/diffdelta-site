// ─────────────────────────────────────────────────────────
// DiffDelta — Engine Sources API
// Why: Returns all active custom sources in engine-compatible
// format so the generator can process them alongside curated
// sources. Called by the Pulse workflow every 15 minutes.
// GET /api/v1/engine/sources
// Auth: Authorization: Bearer {ENGINE_SECRET}
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, CustomSource } from "../../../_shared/types";

const CACHE_KEY = "engine-sources-cache";
const CACHE_TTL_SEC = 300; // 5 minutes

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // ── Auth: ENGINE_SECRET bearer token ──
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const engineSecret = (env as Record<string, unknown>).ENGINE_SECRET as string | undefined;

  if (!engineSecret || !token || token !== engineSecret) {
    return errorResponse("Unauthorized", 401);
  }

  // ── Check cache ──
  const cached = await env.KEYS.get(CACHE_KEY);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── List all custom sources from KV ──
  // KV list with prefix "custom:" returns all custom source keys
  const sources: Record<string, unknown> = {};
  let cursor: string | undefined;

  do {
    const list = await env.KEYS.list({ prefix: "custom:", cursor, limit: 100 });
    for (const key of list.keys) {
      const raw = await env.KEYS.get(key.name);
      if (!raw) continue;

      let src: CustomSource;
      try {
        src = JSON.parse(raw);
      } catch {
        continue;
      }

      if (src.status !== "active") continue;

      // Transform to engine-compatible format (matches sources.config.json schema)
      sources[src.id] = {
        enabled: true,
        name: src.name,
        tags: src.tags || [],
        description: src.description || `Custom source: ${src.name}`,
        homepage: src.url,
        adapter: src.adapter,
        config: {
          ...(src.adapter === "rss"
            ? { feed_url: src.config.feed_url || src.url }
            : { api_url: src.config.api_url || src.url }),
          ...(src.config.json_items_key && { json_items_key: src.config.json_items_key }),
          ...(src.config.json_title_field && { json_title_field: src.config.json_title_field }),
          ...(src.config.json_content_field && { json_content_field: src.config.json_content_field }),
          ...(src.config.url_prefix && { url_prefix: src.config.url_prefix }),
          ...(src.config.promote_fields && { promote_fields: src.config.promote_fields }),
          max_items: src.config.max_items,
          ttl_sec: src.config.ttl_sec,
        },
        paths: {
          state: `diff/source/${src.id}/_state.json`,
          latest: `diff/source/${src.id}/latest.json`,
        },
        _custom: {
          owner_key_hash: src.owner_key_hash,
          visibility: src.visibility,
        },
      };
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  const response = JSON.stringify({
    generated_at: new Date().toISOString(),
    count: Object.keys(sources).length,
    sources,
  });

  // ── Cache ──
  await env.KEYS.put(CACHE_KEY, response, { expirationTtl: CACHE_TTL_SEC });

  return new Response(response, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
