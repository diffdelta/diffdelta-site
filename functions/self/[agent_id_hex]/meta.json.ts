// ─────────────────────────────────────────────────────────
// Self Capsule — meta.json
// GET /self/{agent_id_hex}/meta.json
// Why: operator-facing endpoint for troubleshooting trial bots.
// Returns write counts, rejection counts, and activity timestamps
// so the operator can monitor bot progress without reading capsules.
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

// v0: single generous tier — all agents get 50 writes/day.
const WRITE_LIMIT_24H = 50;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env } = context;
  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(String(params.agent_id_hex || ""));
  } catch {
    return errorResponse("Invalid agent_id (expected 64 hex chars)", 400);
  }

  // Check if agent exists (has ever written a capsule)
  const stored = await getStoredCapsule(env, agentIdHex);
  if (!stored) {
    return errorResponse("Agent not found (no capsule has been written)", 404);
  }

  // Gather all metadata
  const [meta, usedToday, history] = await Promise.all([
    getAgentMeta(env, agentIdHex),
    getWritesUsed24h(env, agentIdHex),
    getHistory(env, agentIdHex),
  ]);

  const remaining = Math.max(0, WRITE_LIMIT_24H - usedToday);
  const resetAt = dayResetAtIsoUTC();

  // Extract trial progress from capsule objectives (if present)
  let objectives: unknown[] | null = null;
  if (
    stored.capsule &&
    typeof stored.capsule === "object" &&
    Array.isArray((stored.capsule as Record<string, unknown>).objectives)
  ) {
    objectives = ((stored.capsule as Record<string, unknown>).objectives as unknown[]).map(
      (obj: unknown) => {
        if (obj && typeof obj === "object") {
          const o = obj as Record<string, unknown>;
          return { id: o.id, status: o.status, title: o.title };
        }
        return obj;
      }
    );
  }

  // Extract receipts summary (for trial verification)
  let receipts: unknown[] | null = null;
  if (
    stored.capsule &&
    typeof stored.capsule === "object"
  ) {
    const pointers = (stored.capsule as Record<string, unknown>).pointers;
    if (pointers && typeof pointers === "object") {
      const receiptsList = (pointers as Record<string, unknown>).receipts;
      if (Array.isArray(receiptsList)) {
        receipts = receiptsList.map((r: unknown) => {
          if (r && typeof r === "object") {
            const rec = r as Record<string, unknown>;
            return { id: rec.id, content_hash: rec.content_hash };
          }
          return r;
        });
      }
    }
  }

  // Check for collaboration (authorized_readers)
  let hasCollaboration = false;
  if (
    stored.capsule &&
    typeof stored.capsule === "object"
  ) {
    const ac = (stored.capsule as Record<string, unknown>).access_control;
    if (ac && typeof ac === "object") {
      const readers = (ac as Record<string, unknown>).authorized_readers;
      if (Array.isArray(readers) && readers.length > 0) {
        hasCollaboration = true;
      }
    }
  }

  return jsonResponse({
    agent_id: agentIdHex,
    exists: true,
    current_seq: stored.seq,
    cursor: stored.cursor,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
    // Lifetime stats
    lifetime: meta
      ? {
          total_writes: meta.total_writes,
          first_seen: meta.first_seen,
          last_write: meta.last_write,
          schema_rejections: meta.schema_rejections,
          safety_rejections: meta.safety_rejections,
        }
      : null,
    // Today's quota
    writes_today: {
      limit_24h: WRITE_LIMIT_24H,
      used_24h: usedToday,
      remaining_24h: remaining,
      reset_at: resetAt,
    },
    // History summary
    history: history
      ? {
          versions_retained: history.versions.length,
          total_writes: history.total_writes,
          pruned: history.total_writes > history.versions.length,
        }
      : null,
    // Trial progress (if objectives are present)
    trial_progress: objectives
      ? {
          objectives,
          receipts,
          has_collaboration: hasCollaboration,
        }
      : null,
  });
};
