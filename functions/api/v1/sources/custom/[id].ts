// ─────────────────────────────────────────────────────────
// DiffDelta — Custom Source Detail (PATCH / DELETE)
// Why: Lets users update visibility, promote_fields, or
// pause/delete their custom sources after creation.
// PATCH  /api/v1/sources/custom/:id
// DELETE /api/v1/sources/custom/:id
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../../_shared/response";
import type { Env, KeyData, CustomSource } from "../../../../_shared/types";
import type { AuthResult } from "../../../../_shared/auth";

async function getOwnedSource(
  env: Env,
  id: string,
  ownerKeyHash: string
): Promise<CustomSource | null> {
  const raw = await env.KEYS.get(`custom:${id}`);
  if (!raw) return null;
  const source: CustomSource = JSON.parse(raw);
  if (source.owner_key_hash !== ownerKeyHash) return null;
  return source;
}

// ── PATCH: Update source properties ──

interface PatchBody {
  visibility?: string;
  status?: string;
  promote_fields?: string[];
  name?: string;
  description?: string;
  tags?: string[];
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const { request, params, env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.authenticated || !auth.key_hash) {
    return errorResponse("Authentication required", 401);
  }

  const id = String(params.id || "").trim();
  if (!id.startsWith("cs_")) {
    return errorResponse("Invalid source ID", 400);
  }

  const source = await getOwnedSource(env, id, auth.key_hash);
  if (!source) {
    return errorResponse("Source not found", 404);
  }

  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > 4096) {
    return errorResponse("Request body too large", 413);
  }
  let body: PatchBody;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // Apply allowed updates
  if (body.visibility === "private" || body.visibility === "public") {
    source.visibility = body.visibility;
  }
  if (body.status === "active" || body.status === "paused") {
    source.status = body.status;
  }
  if (body.name && typeof body.name === "string" && body.name.trim().length >= 2) {
    source.name = body.name.trim().slice(0, 100);
  }
  if (typeof body.description === "string") {
    source.description = body.description.trim().slice(0, 500) || undefined;
  }
  if (Array.isArray(body.tags)) {
    source.tags = body.tags
      .filter((t): t is string => typeof t === "string" && /^[a-z0-9_\-]{2,32}$/.test(t))
      .slice(0, 5);
  }
  if (Array.isArray(body.promote_fields)) {
    source.config.promote_fields = body.promote_fields
      .filter((f): f is string => typeof f === "string" && f.length > 0 && f.length <= 64)
      .slice(0, 10);
  }

  await env.KEYS.put(`custom:${id}`, JSON.stringify(source));

  return jsonResponse({
    status: "updated",
    source: {
      id: source.id,
      name: source.name,
      visibility: source.visibility,
      status: source.status,
      config: source.config,
    },
  });
};

// ── DELETE: Remove a custom source ──

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const { params, env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.authenticated || !auth.key_hash) {
    return errorResponse("Authentication required", 401);
  }

  const id = String(params.id || "").trim();
  if (!id.startsWith("cs_")) {
    return errorResponse("Invalid source ID", 400);
  }

  const source = await getOwnedSource(env, id, auth.key_hash);
  if (!source) {
    return errorResponse("Source not found", 404);
  }

  // Remove from KV
  await env.KEYS.delete(`custom:${id}`);

  // Remove from owner's KeyData
  const keyRaw = await env.KEYS.get(`key:${auth.key_hash}`);
  if (keyRaw) {
    const keyData: KeyData = JSON.parse(keyRaw);
    keyData.custom_source_ids = (keyData.custom_source_ids || []).filter((sid) => sid !== id);
    await env.KEYS.put(`key:${auth.key_hash}`, JSON.stringify(keyData));
  }

  return jsonResponse({ status: "deleted", id });
};
