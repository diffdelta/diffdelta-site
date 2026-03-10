// Feed endpoint authentication for agent-published feeds.
// Why: agents prove ownership via Ed25519 signature (same as Self Capsule writes).
// For read-only operations, X-Self-Agent-Id + existing capsule is sufficient.

import type { Env } from "../types";
import { parseAgentIdHex, verifyEd25519Envelope } from "../self/crypto";
import { getStoredCapsule, agentCapsuleExists } from "../self/store";
import { errorResponse } from "../response";

/**
 * Authenticate a feed write request via signed envelope.
 * The agent must provide:
 *   - agent_id (64 hex chars)
 *   - public_key (32-byte hex)
 *   - seq (monotonic integer — we use their Self Capsule seq)
 *   - signature (Ed25519 over sha256(canonical_json({agent_id, seq, capsule: action_payload})))
 *   - action: the actual feed operation payload
 *
 * Returns the validated agent_id or an error Response.
 */
export async function authenticateFeedWrite(
  request: Request,
  env: Env
): Promise<{ agent_id: string } | Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim().toLowerCase() : "";
  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(agentId);
  } catch {
    return errorResponse("Invalid agent_id (expected 64 hex chars)", 400);
  }

  // Verify the agent has a bootstrapped Self Capsule
  const capsule = await getStoredCapsule(env, agentIdHex);
  if (!capsule) {
    return errorResponse("Agent not found. Bootstrap a Self Capsule first (POST /api/v1/self/bootstrap).", 404);
  }

  // Verify Ed25519 signature to prove ownership
  const seq = typeof body.seq === "number" ? body.seq : -1;
  const signature = typeof body.signature === "string" ? body.signature : "";
  const publicKey = typeof body.public_key === "string" ? body.public_key : "";

  if (!signature || !publicKey) {
    return errorResponse("Missing signature or public_key. Sign the request with your Ed25519 keypair.", 401);
  }

  // The "capsule" for signature verification is the action payload
  const actionPayload = body.action || body.data || {};

  try {
    await verifyEd25519Envelope({
      agent_id: agentIdHex,
      public_key: publicKey,
      seq,
      signature,
      capsule: actionPayload,
    });
  } catch {
    return errorResponse("Signature verification failed", 401);
  }

  return { agent_id: agentIdHex };
}

/**
 * Authenticate a feed read request using X-Self-Agent-Id header.
 * Verifies the claimed agent_id has a bootstrapped Self Capsule in KV —
 * this prevents trivial spoofing where an attacker guesses a valid-format
 * agent_id without having actually bootstrapped one.
 * Returns the agent_id or null (for unauthenticated reads).
 */
export async function extractAgentId(request: Request, env: Env): Promise<string | null> {
  const raw = request.headers.get("X-Self-Agent-Id");
  if (!raw) return null;
  const hex = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  if (!await agentCapsuleExists(env, hex)) return null;
  return hex;
}
