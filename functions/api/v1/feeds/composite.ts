// ─────────────────────────────────────────────────────────
// DiffDelta — Composite Feed Management
// Why: Lets users bundle multiple sources (custom + curated)
// into a single pollable feed. Assembled at the edge, no
// engine changes needed for composition.
// GET  /api/v1/feeds/composite — List user's composite feeds
// POST /api/v1/feeds/composite — Create a composite feed
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, KeyData, CompositeFeed } from "../../../_shared/types";
import type { AuthResult } from "../../../_shared/auth";

const MAX_SOURCES_PER_FEED = 20;
const MAX_TAGS = 5;
const TAG_PATTERN = /^[a-z0-9_\-]{2,32}$/;
const MIN_TTL_SEC = 900;

function feedLimitForTier(tier: string): number {
  if (tier === "enterprise") return 999;
  if (tier === "pro") return 10;
  return 2;
}

// ── GET: List user's composite feeds ──

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.authenticated || !auth.key_hash) {
    return errorResponse("Authentication required", 401);
  }

  const raw = await env.KEYS.get(`key:${auth.key_hash}`);
  if (!raw) return errorResponse("Key not found", 404);

  const keyData: KeyData = JSON.parse(raw);
  const feedIds = keyData.composite_feed_ids || [];
  const limit = feedLimitForTier(auth.tier);

  const feeds: CompositeFeed[] = [];
  for (const id of feedIds) {
    const feedRaw = await env.KEYS.get(`cfeed:${id}`);
    if (feedRaw) {
      feeds.push(JSON.parse(feedRaw));
    }
  }

  return jsonResponse({
    limit,
    used: feeds.length,
    feeds,
  });
};

// ── POST: Create a composite feed ──

interface CreateBody {
  name?: string;
  description?: string;
  tags?: string[];
  source_ids?: string[];
  visibility?: string;
  ttl_sec?: number;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.authenticated || !auth.key_hash || !auth.key_data) {
    return errorResponse("Authentication required", 401);
  }

  // ── Parse body ──
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > 8192) {
    return errorResponse("Request body too large", 413);
  }
  let body: CreateBody;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // ── Validate ──
  const name = (body.name || "").trim();
  if (!name || name.length < 2 || name.length > 100) {
    return errorResponse("name is required (2-100 characters)", 400);
  }

  const visibility = (body.visibility || "private").trim();
  if (visibility !== "private" && visibility !== "public") {
    return errorResponse("visibility must be 'private' or 'public'", 400);
  }

  const sourceIds = body.source_ids || [];
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    return errorResponse("source_ids is required (at least 1 source)", 400);
  }
  if (sourceIds.length > MAX_SOURCES_PER_FEED) {
    return errorResponse(`Maximum ${MAX_SOURCES_PER_FEED} sources per composite feed`, 400);
  }

  // Validate each source_id exists (curated or owned custom or public custom)
  for (const sid of sourceIds) {
    if (typeof sid !== "string" || sid.length < 2) {
      return errorResponse(`Invalid source_id: "${sid}"`, 400);
    }
    if (sid.startsWith("cs_")) {
      // Custom source — must be owned by this user or public
      const srcRaw = await env.KEYS.get(`custom:${sid}`);
      if (!srcRaw) {
        return errorResponse(`Custom source not found: "${sid}"`, 400);
      }
      const src = JSON.parse(srcRaw);
      if (src.owner_key_hash !== auth.key_hash && src.visibility !== "public") {
        return errorResponse(`Source "${sid}" is not accessible`, 403);
      }
    }
    // Curated sources: we trust the user's input — if the source doesn't exist
    // in the catalog, the composite feed will simply have no items from it.
    // No need to validate against the full catalog at creation time.
  }

  const tags = body.tags || [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    return errorResponse(`tags must be an array of up to ${MAX_TAGS} items`, 400);
  }
  for (const tag of tags) {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
      return errorResponse(`Invalid tag: "${tag}"`, 400);
    }
  }

  const ttlSec = Math.max(body.ttl_sec || 900, MIN_TTL_SEC);

  // ── Check feed limits ──
  const keyData = auth.key_data as KeyData;
  const limit = feedLimitForTier(auth.tier);
  const currentIds = keyData.composite_feed_ids || [];
  if (currentIds.length >= limit) {
    return errorResponse(
      `Composite feed limit reached (${limit}). Upgrade your plan for more.`,
      403
    );
  }

  // ── Rate limit: 5 creations/day ──
  const dateKey = new Date().toISOString().slice(0, 10);
  const rlKey = `cfeed-rl:${auth.key_hash}:${dateKey}`;
  const rlCount = parseInt((await env.KEYS.get(rlKey)) || "0", 10);
  if (rlCount >= 5) {
    return errorResponse("Too many feed creations today (5/day). Try again tomorrow.", 429);
  }

  // ── Create composite feed ──
  const id = `cf_${crypto.randomUUID().slice(0, 12).replace(/-/g, "")}`;
  const now = new Date().toISOString();

  const feed: CompositeFeed = {
    id,
    owner_key_hash: auth.key_hash,
    name,
    description: (body.description || "").trim().slice(0, 500) || undefined,
    tags: tags.length > 0 ? tags : undefined,
    source_ids: sourceIds,
    visibility: visibility as "private" | "public",
    created_at: now,
    updated_at: now,
    ttl_sec: ttlSec,
  };

  await env.KEYS.put(`cfeed:${id}`, JSON.stringify(feed));

  // Update KeyData
  const updatedKeyData: KeyData = {
    ...keyData,
    composite_feed_ids: [...currentIds, id],
  };
  await env.KEYS.put(`key:${auth.key_hash}`, JSON.stringify(updatedKeyData));

  // Increment rate limit
  await env.KEYS.put(rlKey, String(rlCount + 1), { expirationTtl: 86400 });

  return jsonResponse(
    {
      status: "created",
      feed: {
        id: feed.id,
        name: feed.name,
        source_ids: feed.source_ids,
        visibility: feed.visibility,
        ttl_sec: feed.ttl_sec,
        created_at: feed.created_at,
      },
      feed_path: `/feeds/cf/${id}/head.json`,
      message: "Composite feed created. It is available immediately.",
    },
    201
  );
};
