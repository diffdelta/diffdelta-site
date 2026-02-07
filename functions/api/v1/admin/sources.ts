// ─────────────────────────────────────────────────────────
// DiffDelta Admin — Custom Source Review Queue
// Why: Lets you review, approve, or reject custom source
// requests from Pro users. Protected by ADMIN_SECRET.
// GET  /api/v1/admin/sources?status=pending  — List sources
// POST /api/v1/admin/sources                 — Review a source
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, CustomSource } from "../../../_shared/types";

// ── Admin auth helper ──

function checkAdmin(request: Request, env: Env): Response | null {
  const adminSecret = (env as Record<string, unknown>).ADMIN_SECRET as
    | string
    | undefined;

  if (!adminSecret) {
    return errorResponse("Admin endpoint not configured", 503);
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${adminSecret}`) {
    return errorResponse("Unauthorized", 401);
  }

  return null; // Auth passed
}

// ── GET: List custom sources (filterable by status) ──

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const authError = checkAdmin(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const filterStatus = url.searchParams.get("status"); // "pending", "active", etc.

  // List all custom source keys
  const { keys } = await env.KEYS.list({ prefix: "custom:cs_" });

  const sources: CustomSource[] = [];
  for (const key of keys) {
    const raw = await env.KEYS.get(key.name);
    if (!raw) continue;

    const source: CustomSource = JSON.parse(raw);

    // Apply status filter if provided
    if (filterStatus && source.status !== filterStatus) continue;

    sources.push(source);
  }

  // Sort by submitted_at descending (newest first)
  sources.sort((a, b) =>
    b.submitted_at.localeCompare(a.submitted_at)
  );

  return jsonResponse({
    count: sources.length,
    filter: filterStatus || "all",
    sources,
  });
};

// ── POST: Review a custom source (approve/reject) ──

interface ReviewBody {
  source_id?: string;
  action?: "approve" | "reject";
  review_notes?: string;
  feed_source_id?: string; // Required when approving — the generator's source_id
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const authError = checkAdmin(request, env);
  if (authError) return authError;

  let body: ReviewBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { source_id, action, review_notes, feed_source_id } = body;

  if (!source_id) {
    return errorResponse("source_id is required", 400);
  }
  if (!action || !["approve", "reject"].includes(action)) {
    return errorResponse('action must be "approve" or "reject"', 400);
  }

  // ── Read the source record ──
  const raw = await env.KEYS.get(`custom:${source_id}`);
  if (!raw) {
    return errorResponse("Custom source not found", 404);
  }

  const source: CustomSource = JSON.parse(raw);
  const now = new Date().toISOString();

  if (action === "approve") {
    if (!feed_source_id) {
      return errorResponse(
        "feed_source_id is required when approving (the generator source ID)",
        400
      );
    }
    source.status = "active";
    source.feed_source_id = feed_source_id;
  } else {
    source.status = "rejected";
  }

  source.reviewed_at = now;
  if (review_notes) {
    source.review_notes = review_notes;
  }

  // ── Persist updated source ──
  await env.KEYS.put(`custom:${source_id}`, JSON.stringify(source));

  return jsonResponse({
    updated: true,
    source,
    message: `Source ${action === "approve" ? "approved" : "rejected"}: ${source.name}`,
  });
};
