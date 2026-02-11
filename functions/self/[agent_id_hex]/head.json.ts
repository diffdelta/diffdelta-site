// ─────────────────────────────────────────────────────────
// Self Capsule — head.json
// GET /self/{agent_id_hex}/head.json
// Why: ~200B heartbeat for "should I fetch capsule?"
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";
import { parseAgentIdHex } from "../../_shared/self/crypto";
import { getStoredCapsule, getWritesUsed24h, dayResetAtIsoUTC } from "../../_shared/self/store";
import type { AuthResult } from "../../_shared/auth";
import { authenticateRequest } from "../../_shared/auth";

function resolveTier(auth?: AuthResult): "free" | "pro" {
  return auth?.authenticated && (auth.tier === "pro" || auth.tier === "enterprise")
    ? "pro"
    : "free";
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env, data, request } = context;
  const agentIdHex = parseAgentIdHex(String(params.agent_id_hex || ""));

  const stored = await getStoredCapsule(env, agentIdHex);
  if (!stored) {
    return errorResponse("Capsule not found", 404);
  }

  // /self GETs bypass middleware for cost-control, so do lightweight auth here
  // only if a key was provided (Pro view).
  const providedKey = request.headers.get("X-DiffDelta-Key");
  let auth = (data as Record<string, unknown>).auth as AuthResult | undefined;
  if (!auth && providedKey) {
    auth = await authenticateRequest(request, env);
    if (auth.error) {
      return errorResponse(auth.error, 401);
    }
  }
  const tier = resolveTier(auth);
  const limit24h = tier === "pro" ? 50 : 5;
  const used = await getWritesUsed24h(env, agentIdHex);
  const remaining = Math.max(0, limit24h - used);
  const resetAt = dayResetAtIsoUTC();

  const head = {
    agent_id: agentIdHex,
    cursor: stored.cursor,
    prev_cursor: stored.prev_cursor,
    changed: stored.prev_cursor ? stored.cursor !== stored.prev_cursor : true,
    generated_at: stored.updated_at,
    ttl_sec: 600,
    capsule_url: `/self/${agentIdHex}/capsule.json`,
    writes: {
      limit_24h: limit24h,
      used_24h: used,
      remaining_24h: remaining,
      reset_at: resetAt,
    },
  };

  const res = jsonResponse(head);
  // ETag must be a quoted entity-tag per RFC; some edges will strip invalid values.
  const etag = `"${stored.cursor}"`;
  res.headers.set("ETag", etag);

  const inmRaw = request.headers.get("If-None-Match");
  const inm = inmRaw
    ? inmRaw.replace(/^W\//, "").replace(/^"|"$/g, "")
    : null;
  if (inm && inm === stored.cursor) {
    return new Response(null, { status: 304, headers: res.headers });
  }
  return res;
};

