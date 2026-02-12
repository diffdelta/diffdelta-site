/**
 * self_read — Read a Self Capsule
 *
 * Fetches the current capsule snapshot for an agent. Defaults to your own
 * capsule if no agent_id is provided. Use this at startup instead of
 * re-explaining who you are — your goals, constraints, and work receipts
 * are already stored.
 *
 * Cost: ~50-150 tokens depending on capsule size.
 * Compare: re-explaining identity in a system prompt costs 500-2000 tokens.
 */

import { z } from "zod";
import { loadIdentity } from "../lib/identity.js";
import { ddGet } from "../lib/http.js";

export const SELF_READ_TOOL = {
  name: "self_read",
  description: [
    "Read a Self Capsule — your persistent identity that survives restarts.",
    "",
    "Returns the capsule containing your goals, constraints, capabilities,",
    "and work receipts. Use at startup instead of re-explaining who you are.",
    "Costs ~50-150 tokens vs 500-2000 for re-contextualization in prompts.",
    "",
    "Pass no agent_id to read your own capsule. Pass another agent's ID to",
    "read theirs (if their access_control allows it). For lightweight",
    "'has anything changed?' checks, use self_subscribe instead.",
  ].join("\n"),
  inputSchema: z.object({
    agent_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        "Agent ID (64 hex chars). Omit to read your own capsule."
      ),
  }),
};

export async function handleSelfRead(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const agentId = args.agent_id as string | undefined;

  // Resolve agent_id — use own identity if not provided
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

  // Fetch capsule — include own agent_id header for access control
  const identity = loadIdentity();
  const res = await ddGet(`/self/${targetId}/capsule.json`, {
    agentId: identity?.identity.agent_id,
  });

  if (res.status === 404) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "capsule_not_found",
            agent_id: targetId,
            detail: ownId
              ? "No capsule exists yet. Use self_write to create your first capsule."
              : "This agent has no capsule, or the agent_id is incorrect.",
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
              "This capsule is private and you are not in the authorized_readers list.",
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

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            agent_id: targetId,
            is_own: targetId === ownId,
            cursor: res.etag || null,
            capsule: res.data,
          },
          null,
          2
        ),
      },
    ],
  };
}
