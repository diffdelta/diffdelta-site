// ─────────────────────────────────────────────────────────
// DiffDelta — Composite Feed Detail (PATCH / DELETE)
// Why: Lets users update source composition, visibility,
// or remove a composite feed entirely.
// PATCH  /api/v1/feeds/composite/:id
// DELETE /api/v1/feeds/composite/:id
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../../_shared/response";
import type { Env, KeyData, CompositeFeed } from "../../../../_shared/types";
import type { AuthResult } from "../../../../_shared/auth";

const MAX_SOURCES_PER_FEED = 20;

async function getOwnedFeed(
  env: Env,
  id: string,
  ownerKeyHash: string
): Promise<CompositeFeed | null> {
  const raw = await env.KEYS.get(`cfeed:${id}`);
  if (!raw) return null;
  const feed: CompositeFeed = JSON.parse(raw);
  if (feed.owner_key_hash !== ownerKeyHash) return null;
  return feed;
}

// ── PATCH: Update composite feed ──

interface PatchBody {
  name?: string;
  description?: string;
  tags?: string[];
  source_ids?: string[];
  visibility?: string;
  ttl_sec?: number;
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const { request, params, env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.authenticated || !auth.key_hash) {
    return errorResponse("Authentication required", 401);
  }

  const id = String(params.id || "").trim();
  if (!id.startsWith("cf_")) {
    return errorResponse("Invalid feed ID", 400);
  }

  const feed = await getOwnedFeed(env, id, auth.key_hash);
  if (!feed) {
    return errorResponse("Feed not found", 404);
  }

  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > 8192) {
    return errorResponse("Request body too large", 413);
  }
  let body: PatchBody;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (body.name && typeof body.name === "string" && body.name.trim().length >= 2) {
    feed.name = body.name.trim().slice(0, 100);
  }
  if (typeof body.description === "string") {
    feed.description = body.description.trim().slice(0, 500) || undefined;
  }
  if (body.visibility === "private" || body.visibility === "public") {
    feed.visibility = body.visibility;
  }
  if (typeof body.ttl_sec === "number") {
    feed.ttl_sec = Math.max(body.ttl_sec, 900);
  }
  if (Array.isArray(body.tags)) {
    feed.tags = body.tags
      .filter((t): t is string => typeof t === "string" && /^[a-z0-9_\-]{2,32}$/.test(t))
      .slice(0, 5);
  }
  if (Array.isArray(body.source_ids)) {
    if (body.source_ids.length === 0) {
      return errorResponse("source_ids cannot be empty", 400);
    }
    if (body.source_ids.length > MAX_SOURCES_PER_FEED) {
      return errorResponse(`Maximum ${MAX_SOURCES_PER_FEED} sources per feed`, 400);
    }
    feed.source_ids = body.source_ids.filter(
      (sid): sid is string => typeof sid === "string" && sid.length >= 2
    );
  }

  feed.updated_at = new Date().toISOString();
  await env.KEYS.put(`cfeed:${id}`, JSON.stringify(feed));

  // Invalidate cached composite feed result
  await env.KEYS.delete(`cfeed-cache:${id}`);

  return jsonResponse({
    status: "updated",
    feed: {
      id: feed.id,
      name: feed.name,
      source_ids: feed.source_ids,
      visibility: feed.visibility,
      ttl_sec: feed.ttl_sec,
      updated_at: feed.updated_at,
    },
  });
};

// ── DELETE: Remove composite feed ──

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const { params, env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.authenticated || !auth.key_hash) {
    return errorResponse("Authentication required", 401);
  }

  const id = String(params.id || "").trim();
  if (!id.startsWith("cf_")) {
    return errorResponse("Invalid feed ID", 400);
  }

  const feed = await getOwnedFeed(env, id, auth.key_hash);
  if (!feed) {
    return errorResponse("Feed not found", 404);
  }

  await env.KEYS.delete(`cfeed:${id}`);
  await env.KEYS.delete(`cfeed-cache:${id}`);

  // Remove from owner's KeyData
  const keyRaw = await env.KEYS.get(`key:${auth.key_hash}`);
  if (keyRaw) {
    const keyData: KeyData = JSON.parse(keyRaw);
    keyData.composite_feed_ids = (keyData.composite_feed_ids || []).filter((fid) => fid !== id);
    await env.KEYS.put(`key:${auth.key_hash}`, JSON.stringify(keyData));
  }

  return jsonResponse({ status: "deleted", id });
};
