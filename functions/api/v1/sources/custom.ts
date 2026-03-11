// ─────────────────────────────────────────────────────────
// DiffDelta — Custom Source Management
// Why: Lets authenticated users create, list, and manage
// custom sources that the engine processes every 15 minutes.
// GET  /api/v1/sources/custom — List owned custom sources
// POST /api/v1/sources/custom — Create a new custom source
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, KeyData, CustomSource, CustomSourceConfig } from "../../../_shared/types";
import type { AuthResult } from "../../../_shared/auth";

const MAX_ITEMS_FREE = 50;
const MAX_ITEMS_PRO = 200;
const MIN_TTL_SEC = 900;
const MAX_PROMOTE_FIELDS = 10;
const MAX_TAGS = 5;
const SOURCE_ID_PATTERN = /^[a-z0-9_\-]{2,32}$/;
const TAG_PATTERN = /^[a-z0-9_\-]{2,32}$/;

function sourceLimitForTier(tier: string, keyData?: KeyData): number {
  if (keyData?.custom_sources_limit !== undefined && keyData.custom_sources_limit !== -1) {
    return keyData.custom_sources_limit;
  }
  if (tier === "enterprise") return 999;
  if (tier === "pro") return 10;
  return 2;
}

// ── GET: List user's custom sources ──

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.authenticated || !auth.key_hash) {
    return errorResponse("Authentication required", 401);
  }

  const raw = await env.KEYS.get(`key:${auth.key_hash}`);
  if (!raw) return errorResponse("Key not found", 404);

  const keyData: KeyData = JSON.parse(raw);
  const sourceIds = keyData.custom_source_ids || [];
  const limit = sourceLimitForTier(auth.tier, keyData);

  const sources: CustomSource[] = [];
  for (const id of sourceIds) {
    const srcRaw = await env.KEYS.get(`custom:${id}`);
    if (srcRaw) {
      sources.push(JSON.parse(srcRaw));
    }
  }

  return jsonResponse({
    limit,
    used: sources.length,
    sources,
  });
};

// ── POST: Create a new custom source ──

interface CreateBody {
  name?: string;
  url?: string;
  adapter?: string;
  description?: string;
  tags?: string[];
  visibility?: string;
  config?: Partial<CustomSourceConfig>;
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

  // ── Validate required fields ──
  const name = (body.name || "").trim();
  const url = (body.url || "").trim();
  const adapter = (body.adapter || "").trim();
  const visibility = (body.visibility || "private").trim();
  const description = (body.description || "").trim();
  const tags = body.tags || [];

  if (!name || name.length < 2 || name.length > 100) {
    return errorResponse("name is required (2-100 characters)", 400);
  }
  if (!url) {
    return errorResponse("url is required", 400);
  }
  if (adapter !== "rss" && adapter !== "json") {
    return errorResponse("adapter must be 'rss' or 'json'", 400);
  }
  if (visibility !== "private" && visibility !== "public") {
    return errorResponse("visibility must be 'private' or 'public'", 400);
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return errorResponse("Invalid URL format", 400);
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return errorResponse("URL must use HTTP or HTTPS", 400);
  }

  // Validate tags
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    return errorResponse(`tags must be an array of up to ${MAX_TAGS} items`, 400);
  }
  for (const tag of tags) {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
      return errorResponse(`Invalid tag: "${tag}" — must match ${TAG_PATTERN}`, 400);
    }
  }

  // ── Validate config ──
  const rawConfig = body.config || {};
  const maxItemsCap = auth.tier === "pro" || auth.tier === "enterprise" ? MAX_ITEMS_PRO : MAX_ITEMS_FREE;

  const config: CustomSourceConfig = {
    max_items: Math.min(Math.max(rawConfig.max_items || 50, 1), maxItemsCap),
    ttl_sec: Math.max(rawConfig.ttl_sec || 900, MIN_TTL_SEC),
  };

  if (adapter === "rss") {
    config.feed_url = parsedUrl.href;
  } else {
    config.api_url = parsedUrl.href;
    if (rawConfig.json_items_key && typeof rawConfig.json_items_key === "string") {
      config.json_items_key = rawConfig.json_items_key.slice(0, 64);
    }
    if (rawConfig.json_title_field && typeof rawConfig.json_title_field === "string") {
      config.json_title_field = rawConfig.json_title_field.slice(0, 64);
    }
    if (rawConfig.json_content_field && typeof rawConfig.json_content_field === "string") {
      config.json_content_field = rawConfig.json_content_field.slice(0, 64);
    }
    if (rawConfig.url_prefix && typeof rawConfig.url_prefix === "string") {
      config.url_prefix = rawConfig.url_prefix.slice(0, 200);
    }
  }

  if (Array.isArray(rawConfig.promote_fields)) {
    const validFields = rawConfig.promote_fields
      .filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= 64)
      .slice(0, MAX_PROMOTE_FIELDS);
    if (validFields.length > 0) {
      config.promote_fields = validFields;
    }
  }

  // ── Check source limits ──
  const keyData = auth.key_data as KeyData;
  const limit = sourceLimitForTier(auth.tier, keyData);
  const currentIds = keyData.custom_source_ids || [];
  if (currentIds.length >= limit) {
    return errorResponse(
      `Custom source limit reached (${limit}). Upgrade your plan for more.`,
      403
    );
  }

  // ── Rate limit: 5 creations/day ──
  const dateKey = new Date().toISOString().slice(0, 10);
  const rlKey = `csrc-rl:${auth.key_hash}:${dateKey}`;
  const rlCount = parseInt((await env.KEYS.get(rlKey)) || "0", 10);
  if (rlCount >= 5) {
    return errorResponse("Too many source creations today (5/day). Try again tomorrow.", 429);
  }

  // ── Create source record ──
  const id = `cs_${crypto.randomUUID().slice(0, 12).replace(/-/g, "")}`;
  const now = new Date().toISOString();

  const source: CustomSource = {
    id,
    owner_key_hash: auth.key_hash,
    name,
    url: parsedUrl.href,
    status: "active",
    visibility: visibility as "private" | "public",
    submitted_at: now,
    adapter: adapter as "rss" | "json",
    config,
    description: description || undefined,
    tags: tags.length > 0 ? tags : undefined,
  };

  // Store source record
  await env.KEYS.put(`custom:${id}`, JSON.stringify(source));

  // Update KeyData with new source ID
  const updatedKeyData: KeyData = {
    ...keyData,
    custom_source_ids: [...currentIds, id],
  };
  await env.KEYS.put(`key:${auth.key_hash}`, JSON.stringify(updatedKeyData));

  // Increment daily rate limit
  await env.KEYS.put(rlKey, String(rlCount + 1), { expirationTtl: 86400 });

  return jsonResponse(
    {
      status: "active",
      source: {
        id: source.id,
        name: source.name,
        url: source.url,
        adapter: source.adapter,
        visibility: source.visibility,
        config: source.config,
        submitted_at: source.submitted_at,
      },
      feed_path: `/diff/${id}/head.json`,
      message: "Source created. It will be processed on the next engine cycle (~15 minutes).",
    },
    201
  );
};
