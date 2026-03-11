// ─────────────────────────────────────────────────────────
// DiffDelta — Composite Feed Serving (latest.json)
// Why: Dynamically assembles a composite feed by merging
// individual source latest.json files at the edge.
// Agents poll this identically to any other DiffDelta feed.
// GET /feeds/cf/{id}/latest.json
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

  // ── Load feed definition ──
  const feedRaw = await env.KEYS.get(`cfeed:${id}`);
  if (!feedRaw) {
    return errorResponse("Feed not found", 404);
  }
  const feed: CompositeFeed = JSON.parse(feedRaw);

  // ── Access control ──
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

  // ── Check cache ──
  const cacheKey = `cfeed-cache:${id}`;
  const cached = await env.KEYS.get(cacheKey);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": `public, max-age=${feed.ttl_sec}`,
      },
    });
  }

  // ── Fetch and merge source feeds ──
  const now = new Date().toISOString();
  const allItems: unknown[] = [];
  const sourceCursors: string[] = [];
  const sourcesIncluded: string[] = [];
  const siteOrigin = new URL(request.url).origin;

  for (const sourceId of feed.source_ids) {
    // Determine the source feed path
    let feedPath: string;
    if (sourceId.startsWith("cs_")) {
      feedPath = `/diff/${sourceId}/latest.json`;
    } else {
      // Curated source — check both /diff/source/{id}/ and /diff/{id}/
      feedPath = `/diff/source/${sourceId}/latest.json`;
    }

    try {
      const resp = await fetch(`${siteOrigin}${feedPath}`);
      if (!resp.ok) {
        // Try alternate path for curated sources
        if (!sourceId.startsWith("cs_")) {
          const altResp = await fetch(`${siteOrigin}/diff/${sourceId}/latest.json`);
          if (altResp.ok) {
            const altData = await altResp.json() as Record<string, unknown>;
            const items = extractItems(altData);
            allItems.push(...items);
            sourceCursors.push(String(altData.cursor || ""));
            sourcesIncluded.push(sourceId);
          }
        }
        continue;
      }
      const data = await resp.json() as Record<string, unknown>;
      const items = extractItems(data);
      allItems.push(...items);
      sourceCursors.push(String(data.cursor || ""));
      sourcesIncluded.push(sourceId);
    } catch {
      // Source unavailable — skip silently
    }
  }

  // ── Sort items by published_at descending ──
  allItems.sort((a, b) => {
    const aDate = (a as Record<string, unknown>).published_at as string || "";
    const bDate = (b as Record<string, unknown>).published_at as string || "";
    return bDate.localeCompare(aDate);
  });

  // ── Compute combined cursor ──
  const cursorInput = sourceCursors.sort().join("|");
  const cursor = `sha256:${await hashString(cursorInput)}`;

  // ── Build response ──
  const response = {
    schema_version: "1.2.0",
    generated_at: now,
    source_id: id,
    cursor,
    changed: true,
    ttl_sec: feed.ttl_sec,
    composite: true,
    sources_included: sourcesIncluded,
    counts: {
      items: allItems.length,
      sources: sourcesIncluded.length,
    },
    buckets: {
      items: allItems,
      updated: [],
      removed: [],
    },
  };

  const responseJson = JSON.stringify(response);

  // ── Cache result ──
  const cacheTtl = Math.max(Math.floor(feed.ttl_sec / 2), 60);
  await env.KEYS.put(cacheKey, responseJson, { expirationTtl: cacheTtl });

  return new Response(responseJson, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${feed.ttl_sec}`,
    },
  });
};

function extractItems(data: Record<string, unknown>): unknown[] {
  const buckets = data.buckets as Record<string, unknown[]> | undefined;
  if (buckets && Array.isArray(buckets.items)) {
    return buckets.items;
  }
  if (Array.isArray(data.items)) {
    return data.items;
  }
  return [];
}
