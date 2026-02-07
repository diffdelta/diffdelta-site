// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Custom Source Management
// Why: Lets Pro users submit and track custom source requests.
// Sources are reviewed by admin before activation. All submitted
// URLs are treated as untrusted input.
// GET  /api/v1/sources/custom — List owned custom sources
// POST /api/v1/sources/custom — Submit a new source request
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, KeyData, CustomSource } from "../../../_shared/types";
import type { AuthResult } from "../../../_shared/auth";

// ── GET: List user's custom sources ──

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.key_hash) {
    return errorResponse("Not authenticated", 401);
  }

  const raw = await env.KEYS.get(`key:${auth.key_hash}`);
  if (!raw) {
    return errorResponse("Key not found", 404);
  }

  const keyData: KeyData = JSON.parse(raw);
  const sourceIds = keyData.custom_source_ids || [];

  const sources: CustomSource[] = [];
  for (const id of sourceIds) {
    const srcRaw = await env.KEYS.get(`custom:${id}`);
    if (srcRaw) {
      sources.push(JSON.parse(srcRaw));
    }
  }

  return jsonResponse({
    limit: keyData.custom_sources_limit ?? (keyData.tier === "pro" ? 2 : -1),
    used: sources.length,
    sources,
  });
};

// ── POST: Submit a new custom source request ──

interface SubmitBody {
  name?: string;
  url?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.key_hash || !auth?.key_data) {
    return errorResponse("Not authenticated", 401);
  }

  // ── Parse and validate input ──
  let body: SubmitBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const name = (body.name || "").trim();
  const url = (body.url || "").trim();

  if (!name || name.length < 2) {
    return errorResponse("Source name is required (min 2 characters)", 400);
  }
  if (!url) {
    return errorResponse("Source URL is required", 400);
  }
  if (name.length > 100) {
    return errorResponse("Source name too long (max 100 characters)", 400);
  }
  if (url.length > 500) {
    return errorResponse("URL too long (max 500 characters)", 400);
  }

  // ── Validate URL format (must be HTTP/HTTPS — untrusted input) ──
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return errorResponse("Invalid URL format", 400);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return errorResponse("URL must use HTTP or HTTPS", 400);
  }

  // ── Check custom source limits ──
  const keyData = auth.key_data as KeyData;
  const limit = keyData.custom_sources_limit ??
    (keyData.tier === "pro" ? 2 : -1);
  const currentIds = keyData.custom_source_ids || [];

  if (limit !== -1 && currentIds.length >= limit) {
    return errorResponse(
      `Custom source limit reached (${limit}). Upgrade your plan for more.`,
      403
    );
  }

  // ── Rate limit: max 5 custom source submissions per day ──
  const dateKey = new Date().toISOString().slice(0, 10);
  const rlKey = `csrc-rl:${auth.key_hash}:${dateKey}`;
  const rlCount = parseInt((await env.KEYS.get(rlKey)) || "0", 10);

  if (rlCount >= 5) {
    return errorResponse("Too many submissions today. Try again tomorrow.", 429);
  }

  // ── Create custom source record ──
  const id = `cs_${crypto.randomUUID().slice(0, 12).replace(/-/g, "")}`;
  const now = new Date().toISOString();

  const source: CustomSource = {
    id,
    owner_key_hash: auth.key_hash,
    name,
    url: parsedUrl.href, // Normalized URL
    status: "pending",
    submitted_at: now,
  };

  // Store source record
  await env.KEYS.put(`custom:${id}`, JSON.stringify(source));

  // Update KeyData with new source ID
  const updatedIds = [...currentIds, id];
  const updatedKeyData = {
    ...keyData,
    custom_source_ids: updatedIds,
  };
  await env.KEYS.put(`key:${auth.key_hash}`, JSON.stringify(updatedKeyData));

  // Increment daily rate limit counter
  await env.KEYS.put(rlKey, String(rlCount + 1), { expirationTtl: 86400 });

  return jsonResponse(
    {
      status: "submitted",
      source: {
        id: source.id,
        name: source.name,
        url: source.url,
        status: source.status,
        submitted_at: source.submitted_at,
      },
      message:
        "Source submitted for review. We\u2019ll check it\u2019s a structured technical feed and get back to you.",
    },
    201
  );
};
