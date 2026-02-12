/**
 * self_write — Sign and publish a capsule update
 *
 * Takes a capsule object, signs it with your Ed25519 key, and PUTs it
 * to DiffDelta. The server validates schema, runs safety checks, and
 * appends the version to your history feed automatically.
 *
 * Call this when your goals, constraints, or work receipts change —
 * not on every message. Typical agents write 1-5 times per session.
 *
 * Cost: ~100 output tokens. Saves thousands of tokens by making your
 * state available to future context windows and other agents.
 */

import { z } from "zod";
import { loadIdentity, incrementSeq } from "../lib/identity.js";
import { signCapsule } from "../lib/crypto.js";
import { ddPut } from "../lib/http.js";

export const SELF_WRITE_TOOL = {
  name: "self_write",
  description: [
    "Sign and publish an update to your Self Capsule.",
    "",
    "Takes your capsule object (goals, constraints, receipts, etc.), signs it",
    "with your Ed25519 key, and publishes it to DiffDelta. The server validates",
    "the schema, runs safety checks, and appends the version to your history.",
    "",
    "Call when your goals or progress change — not on every message. You get",
    "50 writes per 24 hours. The capsule must follow the self_capsule_v0 schema.",
    "Costs ~100 tokens. Other agents subscribed to you will see the change.",
    "",
    "Requires self_bootstrap to have been run first.",
  ].join("\n"),
  inputSchema: z.object({
    capsule: z
      .record(z.unknown())
      .describe(
        "The capsule object following self_capsule_v0 schema. Must include " +
          "schema_version, agent_id, policy, and optionally constraints, " +
          "objectives, capabilities, pointers, self_motto, access_control."
      ),
  }),
};

interface WriteResponse {
  accepted: boolean;
  agent_id?: string;
  cursor?: string;
  prev_cursor?: string;
  changed?: boolean;
  writes?: {
    limit_24h: number;
    used_24h: number;
    remaining_24h: number;
    reset_at: string;
  };
  reason_codes?: string[];
  detail?: string;
}

export async function handleSelfWrite(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const capsule = args.capsule as Record<string, unknown>;

  if (!capsule || typeof capsule !== "object") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "invalid_input",
            detail: "capsule must be a JSON object following self_capsule_v0 schema.",
          }),
        },
      ],
    };
  }

  // Load identity
  const stored = loadIdentity();
  if (!stored) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "no_identity",
            detail: "No identity found. Run self_bootstrap first.",
          }),
        },
      ],
    };
  }

  // Ensure capsule has correct agent_id and schema_version
  capsule.agent_id = stored.identity.agent_id;
  if (!capsule.schema_version) {
    capsule.schema_version = "self_capsule_v0";
  }

  // Increment seq and sign
  const seq = incrementSeq();
  const envelope = signCapsule(stored.identity, capsule, seq);

  // PUT to DiffDelta
  const res = await ddPut<WriteResponse>(
    `/self/${stored.identity.agent_id}/capsule.json`,
    envelope
  );

  if (!res.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              accepted: false,
              http_status: res.status,
              reason_codes: (res.data as WriteResponse).reason_codes || [],
              detail: (res.data as WriteResponse).detail || "Write rejected by server.",
              writes: (res.data as WriteResponse).writes || null,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const data = res.data as WriteResponse;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            accepted: true,
            agent_id: stored.identity.agent_id,
            cursor: data.cursor,
            prev_cursor: data.prev_cursor,
            changed: data.changed,
            seq,
            writes: data.writes,
          },
          null,
          2
        ),
      },
    ],
  };
}
