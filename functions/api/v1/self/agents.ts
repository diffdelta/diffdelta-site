// ─────────────────────────────────────────────────────────
// Self Capsule — Agent Registry (admin-only)
// GET /api/v1/self/agents
// Why: lets the operator list all bootstrapped agents and
// troubleshoot issues — without knowing agent IDs upfront.
// Protected by ADMIN_SECRET.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import { checkAdmin } from "../../../_shared/admin";
import type { Env } from "../../../_shared/types";
import {
  getAgentRegistry,
  getAgentMeta,
  getStoredCapsule,
  getWritesUsed24h,
  dayResetAtIsoUTC,
} from "../../../_shared/self/store";

const WRITE_LIMIT_24H = 50;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const authError = await checkAdmin(request, env);
  if (authError) return authError;

  const registry = await getAgentRegistry(env);

  if (registry.agents.length === 0) {
    return jsonResponse({
      total: 0,
      agents: [],
    });
  }

  const enriched = await Promise.all(
    registry.agents.map(async (entry) => {
      const [meta, stored, usedToday] = await Promise.all([
        getAgentMeta(env, entry.agent_id),
        getStoredCapsule(env, entry.agent_id),
        getWritesUsed24h(env, entry.agent_id),
      ]);

      let objectiveCount = 0;
      let hasCollaboration = false;

      if (stored?.capsule && typeof stored.capsule === "object") {
        const cap = stored.capsule as Record<string, unknown>;
        if (Array.isArray(cap.objectives)) {
          objectiveCount = cap.objectives.length;
        }
        const ac = cap.access_control;
        if (ac && typeof ac === "object") {
          const readers = (ac as Record<string, unknown>).authorized_readers;
          if (Array.isArray(readers) && readers.length > 0) {
            hasCollaboration = true;
          }
        }
      }

      return {
        agent_id: entry.agent_id,
        registered_at: entry.registered_at,
        current_seq: stored?.seq ?? null,
        last_write: meta?.last_write ?? null,
        lifetime: meta
          ? {
              total_writes: meta.total_writes,
              schema_rejections: meta.schema_rejections,
              safety_rejections: meta.safety_rejections,
            }
          : null,
        writes_today: {
          used: usedToday,
          remaining: Math.max(0, WRITE_LIMIT_24H - usedToday),
        },
        objective_count: objectiveCount,
        has_collaboration: hasCollaboration,
      };
    })
  );

  return jsonResponse({
    total: enriched.length,
    reset_at: dayResetAtIsoUTC(),
    agents: enriched,
  });
};
