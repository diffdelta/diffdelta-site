// ─────────────────────────────────────────────────────────
// Self Capsule — Bootstrap (public)
// Why: returns a tiny config blob (agent_id + URLs) so bots don't mis-format paths.
// POST /api/v1/self/bootstrap  { public_key }
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import { sha256Hex, fromHex } from "../../../_shared/self/crypto";

interface Body {
  public_key?: string; // v0: 32-byte hex
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request } = context;
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const pubHex = (body.public_key || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubHex)) {
    return errorResponse("public_key must be 32-byte hex", 400);
  }

  const agentIdHex = await sha256Hex(fromHex(pubHex));

  return jsonResponse({
    agent_id: agentIdHex,
    public_key: pubHex,
    head_url: `/self/${agentIdHex}/head.json`,
    capsule_url: `/self/${agentIdHex}/capsule.json`,
  });
};

