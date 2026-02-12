// ─────────────────────────────────────────────────────────
// Self Capsule — history.json
// GET /self/{agent_id_hex}/history.json
// GET /self/{agent_id_hex}/history.json?since=<cursor>
//
// Returns the append-only capsule version history, newest first.
// Use ?since=<cursor> to get only versions newer than that cursor
// (the "delta fetch" — walkback without re-reading everything).
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";
import { parseAgentIdHex } from "../../_shared/self/crypto";
import { getHistory, getHistorySince, getStoredCapsule, checkCapsuleAccess } from "../../_shared/self/store";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env, request } = context;
  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(String(params.agent_id_hex || ""));
  } catch {
    return errorResponse("Invalid agent_id (expected 64 hex chars)", 400);
  }

  // Access control: check the current capsule's access_control settings.
  // History inherits access control from the live capsule — if the capsule is
  // private, history is private too (prevents leaking state via history endpoint).
  const stored = await getStoredCapsule(env, agentIdHex);
  if (stored) {
    const requesterAgentId = request.headers.get("X-Self-Agent-Id");
    const access = checkCapsuleAccess(stored.capsule, agentIdHex, requesterAgentId, "history.json");
    if (!access.allowed) {
      return jsonResponse(
        { error: "access_denied", detail: access.reason, agent_id: agentIdHex },
        403
      );
    }
  }

  const record = await getHistory(env, agentIdHex);
  if (!record || record.versions.length === 0) {
    return errorResponse("No history found for this agent", 404);
  }

  // Check for ?since=<cursor> walkback
  const url = new URL(request.url);
  const sinceCursor = url.searchParams.get("since");

  if (sinceCursor) {
    // Normalize: accept with or without "sha256:" prefix
    const normalizedCursor = sinceCursor.startsWith("sha256:") ? sinceCursor : `sha256:${sinceCursor}`;
    const delta = getHistorySince(record, normalizedCursor);

    if (delta === null) {
      // Cursor not found in history — tell the client to re-fetch full history
      return jsonResponse(
        {
          agent_id: agentIdHex,
          error: "cursor_not_found",
          detail: "The provided cursor is not in the retained history. Fetch the full history instead.",
          history_url: `/self/${agentIdHex}/history.json`,
        },
        410 // Gone — the cursor was pruned or is invalid
      );
    }

    if (delta.length === 0) {
      // Client is already up to date — return 304-equivalent in JSON
      // (We use 200 with empty versions since ?since is a query param, not If-None-Match)
      return jsonResponse({
        agent_id: agentIdHex,
        versions: [],
        since_cursor: normalizedCursor,
        total_writes: record.total_writes,
        up_to_date: true,
      });
    }

    return jsonResponse({
      agent_id: agentIdHex,
      versions: delta,
      since_cursor: normalizedCursor,
      total_writes: record.total_writes,
      up_to_date: false,
    });
  }

  // Full history request
  const oldest = record.versions[record.versions.length - 1];
  const pruned = record.total_writes > record.versions.length;

  return jsonResponse({
    agent_id: agentIdHex,
    versions: record.versions,
    total_writes: record.total_writes,
    oldest_available_seq: oldest?.seq ?? null,
    pruned,
  });
};
