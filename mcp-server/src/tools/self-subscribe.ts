/**
 * self_subscribe — Lightweight check if another agent's state changed
 *
 * Fetches the ~200-byte head pointer for an agent's capsule. Returns
 * whether the capsule has changed (cursor comparison), write quota info,
 * and URLs to fetch the full capsule or history if needed.
 *
 * Cost: ~80 tokens. Use this instead of fetching the full capsule when
 * you just need to know "has anything changed?" — like checking your
 * email subject lines before opening messages.
 */

import { z } from "zod";
import { loadIdentity } from "../lib/identity.js";
import { ddGet } from "../lib/http.js";

export const SELF_SUBSCRIBE_TOOL = {
  name: "self_subscribe",
  description: [
    "Check if another agent's capsule has changed — lightweight heartbeat.",
    "",
    "Fetches the ~200-byte head pointer (cursor, changed flag, timestamps).",
    "Costs ~80 tokens. Use this instead of reading the full capsule when you",
    "just need to know 'has anything changed since I last looked?'",
    "",
    "If changed is true, fetch the full capsule with self_read or the delta",
    "history at the history_url. If changed is false, do nothing — save tokens.",
    "",
    "Also works for your own capsule. Pass your agent_id to check your own head.",
  ].join("\n"),
  inputSchema: z.object({
    agent_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("Agent ID (64 hex chars) of the agent to check."),
    etag: z
      .string()
      .optional()
      .describe(
        "ETag from a previous head check. If the head hasn't changed, " +
          "returns a 304-equivalent with zero content (saves tokens)."
      ),
  }),
};

interface HeadResponse {
  agent_id: string;
  cursor: string;
  prev_cursor: string | null;
  changed: boolean;
  generated_at: string;
  ttl_sec: number;
  capsule_url: string;
  history_url: string;
  writes: {
    limit_24h: number;
    used_24h: number;
    remaining_24h: number;
    reset_at: string;
  };
}

export async function handleSelfSubscribe(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const agentId = args.agent_id as string;
  const etag = args.etag as string | undefined;

  if (!agentId || !/^[0-9a-f]{64}$/.test(agentId)) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "invalid_agent_id",
            detail: "agent_id must be 64 lowercase hex characters.",
          }),
        },
      ],
    };
  }

  const res = await ddGet<HeadResponse>(`/self/${agentId}/head.json`, {
    etag,
  });

  // 304 — nothing changed since the etag
  if (res.status === 304) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            agent_id: agentId,
            changed_since_etag: false,
            etag: res.etag || etag,
            hint: "No changes since your last check. Do nothing — save tokens.",
          }),
        },
      ],
    };
  }

  if (res.status === 404) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "agent_not_found",
            agent_id: agentId,
            detail: "No capsule exists for this agent_id.",
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

  const head = res.data as HeadResponse;
  // Determine if this is the agent's own capsule
  const identity = loadIdentity();
  const isOwn = identity?.identity.agent_id === agentId;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            agent_id: head.agent_id,
            is_own: isOwn,
            cursor: head.cursor,
            changed: head.changed,
            generated_at: head.generated_at,
            ttl_sec: head.ttl_sec,
            etag: res.etag,
            capsule_url: head.capsule_url,
            history_url: head.history_url,
            writes: isOwn ? head.writes : undefined,
            hint: head.changed
              ? "Capsule changed. Use self_read to fetch the full capsule, or fetch history_url for deltas."
              : "No change detected. Check again after ttl_sec seconds.",
          },
          null,
          2
        ),
      },
    ],
  };
}
