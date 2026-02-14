// ─────────────────────────────────────────────────────────
// Self Capsule — Agent Registry (admin-only)
// GET /api/v1/self/agents
// Why: lets the operator list all bootstrapped agents, check
// their trial progress, and troubleshoot issues — without
// needing to know agent IDs upfront. Protected by ADMIN_SECRET.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import {
  getAgentRegistry,
  getAgentMeta,
  getStoredCapsule,
  getWritesUsed24h,
  dayResetAtIsoUTC,
} from "../../../_shared/self/store";

const WRITE_LIMIT_24H = 50;

// ── Admin auth (same pattern as admin/sources.ts) ──

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

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const authError = checkAdmin(request, env);
  if (authError) return authError;

  const registry = await getAgentRegistry(env);

  if (registry.agents.length === 0) {
    return jsonResponse({
      total: 0,
      agents: [],
    });
  }

  // Enrich each agent with meta + trial progress (parallel fetches)
  const enriched = await Promise.all(
    registry.agents.map(async (entry) => {
      const [meta, stored, usedToday] = await Promise.all([
        getAgentMeta(env, entry.agent_id),
        getStoredCapsule(env, entry.agent_id),
        getWritesUsed24h(env, entry.agent_id),
      ]);

      // Extract trial objective statuses
      let objectives: { id: unknown; status: unknown }[] | null = null;
      let receipts: { id: unknown }[] | null = null;
      let hasCollaboration = false;

      if (stored?.capsule && typeof stored.capsule === "object") {
        const cap = stored.capsule as Record<string, unknown>;

        // Objectives
        if (Array.isArray(cap.objectives)) {
          objectives = cap.objectives.map((o: unknown) => {
            if (o && typeof o === "object") {
              const obj = o as Record<string, unknown>;
              return { id: obj.id, status: obj.status };
            }
            return { id: null, status: null };
          });
        }

        // Receipts
        const pointers = cap.pointers;
        if (pointers && typeof pointers === "object") {
          const receiptsList = (pointers as Record<string, unknown>).receipts;
          if (Array.isArray(receiptsList)) {
            receipts = receiptsList.map((r: unknown) => {
              if (r && typeof r === "object") {
                return { id: (r as Record<string, unknown>).id };
              }
              return { id: null };
            });
          }
        }

        // Collaboration
        const ac = cap.access_control;
        if (ac && typeof ac === "object") {
          const readers = (ac as Record<string, unknown>).authorized_readers;
          if (Array.isArray(readers) && readers.length > 0) {
            hasCollaboration = true;
          }
        }
      }

      // Determine trial completion status
      const allDone = objectives
        ? objectives.every((o) => o.status === "done")
        : false;
      const hasTokenSavings = receipts
        ? receipts.some((r) => r.id === "token-savings")
        : false;
      const hasFeedback = receipts
        ? receipts.some((r) => r.id === "trial-feedback")
        : false;

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
        trial: {
          objectives,
          receipts,
          has_collaboration: hasCollaboration,
          all_objectives_done: allDone,
          has_token_savings: hasTokenSavings,
          has_feedback: hasFeedback,
          trial_complete: allDone && hasTokenSavings && hasFeedback && hasCollaboration,
        },
      };
    })
  );

  return jsonResponse({
    total: enriched.length,
    reset_at: dayResetAtIsoUTC(),
    agents: enriched,
  });
};
