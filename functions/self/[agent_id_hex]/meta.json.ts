// ─────────────────────────────────────────────────────────
// Self Capsule — meta.json
// GET /self/{agent_id_hex}/meta.json
// Why: operator-facing endpoint for troubleshooting agents.
// Returns write counts, rejection counts, and activity timestamps.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";
import { parseAgentIdHex } from "../../_shared/self/crypto";
import {
  getAgentMeta,
  getStoredCapsule,
  getWritesUsed24h,
  getHistory,
  dayResetAtIsoUTC,
} from "../../_shared/self/store";

const WRITE_LIMIT_24H = 50;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env } = context;
  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(String(params.agent_id_hex || ""));
  } catch {
    return errorResponse("Invalid agent_id (expected 64 hex chars)", 400);
  }

  const stored = await getStoredCapsule(env, agentIdHex);
  if (!stored) {
    return errorResponse("Agent not found (no capsule has been written)", 404);
  }

  const [meta, usedToday, history] = await Promise.all([
    getAgentMeta(env, agentIdHex),
    getWritesUsed24h(env, agentIdHex),
    getHistory(env, agentIdHex),
  ]);

  const remaining = Math.max(0, WRITE_LIMIT_24H - usedToday);

  return jsonResponse({
    agent_id: agentIdHex,
    exists: true,
    current_seq: stored.seq,
    cursor: stored.cursor,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
    lifetime: meta
      ? {
          total_writes: meta.total_writes,
          first_seen: meta.first_seen,
          last_write: meta.last_write,
          schema_rejections: meta.schema_rejections,
          safety_rejections: meta.safety_rejections,
        }
      : null,
    writes_today: {
      limit_24h: WRITE_LIMIT_24H,
      used_24h: usedToday,
      remaining_24h: remaining,
      reset_at: dayResetAtIsoUTC(),
    },
    history: history
      ? {
          versions_retained: history.versions.length,
          total_writes: history.total_writes,
          pruned: history.total_writes > history.versions.length,
        }
      : null,
  });
};
