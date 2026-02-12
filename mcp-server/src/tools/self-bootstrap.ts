/**
 * self_bootstrap — Generate identity and register with DiffDelta
 *
 * One-time setup. Creates an Ed25519 keypair, derives your agent_id,
 * registers with the DiffDelta API, and persists the identity locally.
 * Subsequent calls return the existing identity (idempotent).
 *
 * Cost: ~80 tokens. Run once, reuse forever.
 */

import { z } from "zod";
import { loadIdentity, createAndSaveIdentity, getIdentityPath } from "../lib/identity.js";
import { ddPost } from "../lib/http.js";

export const SELF_BOOTSTRAP_TOOL = {
  name: "self_bootstrap",
  description: [
    "Generate your persistent identity and register with DiffDelta.",
    "Creates an Ed25519 keypair, derives your agent_id (sha256 of public key),",
    "and registers with the DiffDelta API. Identity is stored locally in",
    "~/.diffdelta/identity.json and reused across restarts.",
    "",
    "Call this once at first startup. If identity already exists, returns it",
    "without re-registering (idempotent). Cost: ~80 output tokens.",
    "",
    "After bootstrap, use self_read to load your capsule and self_write to",
    "update it. Your capsule persists your goals, constraints, and work",
    "receipts across context windows — no need to re-explain who you are.",
  ].join("\n"),
  inputSchema: z.object({}).describe("No input required — identity is generated automatically"),
};

interface BootstrapResponse {
  agent_id: string;
  public_key: string;
  head_url: string;
  capsule_url: string;
}

export async function handleSelfBootstrap(
  _args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Check for existing identity first (idempotent)
  const existing = loadIdentity();
  if (existing) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "existing_identity",
              agent_id: existing.identity.agent_id,
              public_key: existing.identity.public_key_hex,
              seq: existing.seq,
              identity_path: getIdentityPath(),
              head_url: `/self/${existing.identity.agent_id}/head.json`,
              capsule_url: `/self/${existing.identity.agent_id}/capsule.json`,
              history_url: `/self/${existing.identity.agent_id}/history.json`,
              hint: "Identity already exists. Use self_read to load your capsule.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Generate new identity
  const { identity, seq } = createAndSaveIdentity();

  // Register with DiffDelta API
  const res = await ddPost<BootstrapResponse>("/api/v1/self/bootstrap", {
    public_key: identity.public_key_hex,
  });

  if (!res.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "error",
              detail: "Bootstrap API call failed",
              http_status: res.status,
              response: res.data,
            },
            null,
            2
          ),
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
            status: "created",
            agent_id: identity.agent_id,
            public_key: identity.public_key_hex,
            seq,
            identity_path: getIdentityPath(),
            head_url: res.data.head_url,
            capsule_url: res.data.capsule_url,
            history_url: `/self/${identity.agent_id}/history.json`,
            hint: "Identity created and registered. Use self_write to store your first capsule.",
          },
          null,
          2
        ),
      },
    ],
  };
}
