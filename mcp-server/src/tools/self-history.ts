/**
 * self_history — Fetch capsule version history
 *
 * Returns the append-only history of capsule states, newest first.
 * Supports delta fetching via `since_cursor` to only get versions
 * newer than a known cursor — critical for token-efficient state auditing.
 *
 * Cost: ~100-500 tokens depending on history depth.
 */

import { loadIdentity } from "../lib/identity.js";
import { ddGet } from "../lib/http.js";

interface HistoryVersion {
  seq: number;
  cursor: string;
  capsule: Record<string, unknown>;
  updated_at: string;
}

interface FullHistoryResponse {
  agent_id: string;
  versions: HistoryVersion[];
  total_writes: number;
  oldest_available_seq: number | null;
  pruned: boolean;
}

interface DeltaHistoryResponse {
  agent_id: string;
  versions: HistoryVersion[];
  since_cursor: string;
  total_writes: number;
  up_to_date: boolean;
}

export async function handleSelfHistory(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const agentId = args.agent_id as string | undefined;
  const sinceCursor = args.since_cursor as string | undefined;
  const limit = args.limit as number | undefined;

  let targetId = agentId;
  let ownId: string | undefined;

  if (!targetId) {
    const stored = loadIdentity();
    if (!stored) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "no_identity",
              detail:
                "No identity found. Run self_bootstrap first to create your identity.",
            }),
          },
        ],
      };
    }
    targetId = stored.identity.agent_id;
    ownId = targetId;
  }

  const identity = loadIdentity();
  let path = `/self/${targetId}/history.json`;
  if (sinceCursor) {
    path += `?since=${encodeURIComponent(sinceCursor)}`;
  }

  const res = await ddGet<FullHistoryResponse | DeltaHistoryResponse>(path, {
    agentId: identity?.identity.agent_id,
  });

  if (res.status === 404) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "no_history",
            agent_id: targetId,
            detail: ownId
              ? "No history yet. Use self_write to create your first capsule."
              : "No history found for this agent.",
          }),
        },
      ],
    };
  }

  if (res.status === 403) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "access_denied",
            agent_id: targetId,
            detail:
              "This capsule's history is private and you are not in the authorized_readers list.",
          }),
        },
      ],
    };
  }

  if (res.status === 410) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "cursor_not_found",
            agent_id: targetId,
            detail:
              "The since_cursor was pruned or invalid. Fetch full history by omitting since_cursor.",
          }),
        },
      ],
    };
  }

  if (!res.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "request_failed",
            http_status: res.status,
            data: res.data,
          }),
        },
      ],
    };
  }

  const data = res.data as FullHistoryResponse & DeltaHistoryResponse;

  let versions = data.versions || [];
  if (limit && limit > 0 && versions.length > limit) {
    versions = versions.slice(0, limit);
  }

  const result: Record<string, unknown> = {
    agent_id: targetId,
    is_own: targetId === (ownId || identity?.identity.agent_id),
    version_count: versions.length,
    total_writes: data.total_writes,
  };

  if (sinceCursor) {
    result.since_cursor = data.since_cursor;
    result.up_to_date = data.up_to_date;
  } else {
    result.oldest_available_seq = data.oldest_available_seq;
    result.pruned = data.pruned;
  }

  result.versions = versions;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
