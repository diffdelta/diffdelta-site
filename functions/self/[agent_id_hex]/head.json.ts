// ─────────────────────────────────────────────────────────
// Self Capsule — head.json
// GET /self/{agent_id_hex}/head.json
// Why: ~200B heartbeat for "should I fetch capsule?"
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";
import { parseAgentIdHex } from "../../_shared/self/crypto";
import { getStoredCapsule, getWritesUsed24h, dayResetAtIsoUTC } from "../../_shared/self/store";

// v0: single generous tier — all agents get 50 writes/day.
const WRITE_LIMIT_24H = 50;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env, request } = context;
  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(String(params.agent_id_hex || ""));
  } catch {
    return errorResponse("Invalid agent_id (expected 64 hex chars)", 400);
  }

  const stored = await getStoredCapsule(env, agentIdHex);
  if (!stored) {
    return errorResponse("Capsule not found", 404);
  }

  const used = await getWritesUsed24h(env, agentIdHex);
  const remaining = Math.max(0, WRITE_LIMIT_24H - used);
  const resetAt = dayResetAtIsoUTC();

  const head = {
    agent_id: agentIdHex,
    cursor: stored.cursor,
    prev_cursor: stored.prev_cursor,
    changed: stored.prev_cursor ? stored.cursor !== stored.prev_cursor : true,
    generated_at: stored.updated_at,
    ttl_sec: 600,
    capsule_url: `/self/${agentIdHex}/capsule.json`,
    history_url: `/self/${agentIdHex}/history.json`,
    writes: {
      limit_24h: WRITE_LIMIT_24H,
      used_24h: used,
      remaining_24h: remaining,
      reset_at: resetAt,
    },
  };

  const res = jsonResponse(head);
  // Cloudflare sometimes strips/overrides non-standard ETag values.
  // Use cursor *hex only* as the ETag token to maximize preservation.
  const cursorHex = stored.cursor.startsWith("sha256:") ? stored.cursor.slice("sha256:".length) : stored.cursor;
  const etag = `"${cursorHex}"`;
  res.headers.set("ETag", etag);

  const inmRaw = request.headers.get("If-None-Match");
  const inm = inmRaw
    ? inmRaw.replace(/^W\//, "").replace(/^"|"$/g, "")
    : null;
  const inmToken = inm && inm.startsWith("sha256:") ? inm.slice("sha256:".length) : inm;
  if (inmToken && inmToken === cursorHex) {
    return new Response(null, { status: 304, headers: res.headers });
  }
  return res;
};

