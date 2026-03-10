/**
 * diffdelta_grant_write — Grant or revoke write access on a feed
 *
 * Enables multi-writer collaborative feeds: the feed owner can authorize
 * other agents to publish items to the same feed. Each writer signs their
 * own publishes with their Ed25519 key; items carry per-item provenance
 * (published_by) so readers know which agent contributed each item.
 *
 * Cost: ~100 tokens.
 */

import { loadIdentity, incrementSeq } from "../lib/identity.js";
import { signCapsule } from "../lib/crypto.js";
import { ddPost } from "../lib/http.js";

interface WritersResponse {
  granted?: boolean;
  revoked?: boolean;
  source_id?: string;
  writer_agent_id?: string;
  writers?: string[];
  error?: string;
}

function textResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

export async function handleDiffdeltaGrantWrite(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const stored = loadIdentity();
  if (!stored) {
    return textResult({
      error: "no_identity",
      detail: "No identity found. Run self_bootstrap first.",
    });
  }

  const { identity } = stored;

  const sourceId = typeof args.source_id === "string" ? args.source_id.trim() : "";
  const writerAgentId = typeof args.writer_agent_id === "string" ? args.writer_agent_id.trim().toLowerCase() : "";
  const action = typeof args.action === "string" ? args.action : "grant";
  const expiresAt = typeof args.expires_at === "string" ? args.expires_at : undefined;

  if (!sourceId) {
    return textResult({ error: "invalid_input", detail: "source_id is required." });
  }
  if (!writerAgentId) {
    return textResult({ error: "invalid_input", detail: "writer_agent_id is required." });
  }
  if (action !== "grant" && action !== "revoke") {
    return textResult({ error: "invalid_input", detail: 'action must be "grant" or "revoke".' });
  }

  const seq = incrementSeq();
  const actionPayload: Record<string, unknown> = {
    source_id: sourceId,
    writer_agent_id: writerAgentId,
    action,
  };
  if (expiresAt) actionPayload.expires_at = expiresAt;

  const envelope = signCapsule(identity, actionPayload, seq);
  const body = {
    agent_id: identity.agent_id,
    public_key: identity.public_key_hex,
    seq,
    signature_alg: "ed25519",
    signature: envelope.signature,
    action: actionPayload,
  };

  let res;
  try {
    res = await ddPost<WritersResponse>("/api/v1/feeds/writers", body);
  } catch (err) {
    return textResult({
      error: "network_error",
      detail: `Request failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }

  if (!res.ok) {
    return textResult({
      error: "request_failed",
      http_status: res.status,
      detail: res.data.error || "Failed to manage writer.",
    });
  }

  return textResult(res.data);
}
