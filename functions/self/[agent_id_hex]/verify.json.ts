// ─────────────────────────────────────────────────────────
// Self Capsule — verify.json
// GET /self/{agent_id_hex}/verify.json
// Why: three-level integrity verification so agents can check
// each other's capsules without "believing" them. Stateless
// read-only — no KV writes, reuses existing validation logic.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";
import { parseAgentIdHex } from "../../_shared/self/crypto";
import { scanForUnsafeContent } from "../../_shared/self/security";
import { validateCapsule, LIMITS } from "../../_shared/self/schema";
import {
  getStoredCapsule,
  computeCursorForCapsule,
  getHistory,
  checkCapsuleAccess,
  isoNow,
} from "../../_shared/self/store";

interface VerifyChecks {
  schema: boolean | null;
  safety: boolean | null;
  chain: boolean | null;
  signature: boolean | null;
}

type VerifyLevel = "none" | "structure" | "integrity" | "auth";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env, request } = context;
  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(String(params.agent_id_hex || ""));
  } catch {
    return errorResponse("Invalid agent_id (expected 64 hex chars)", 400);
  }

  const stored = await getStoredCapsule(env, agentIdHex);
  if (!stored) {
    return errorResponse("Capsule not found", 404);
  }

  // Access control: if capsule is private, verify requester has READ_VERIFY scope.
  // Normalize to lowercase hex so case-insensitive agent IDs match correctly.
  const rawRequester = request.headers.get("X-Self-Agent-Id");
  const requesterAgentId = rawRequester ? rawRequester.trim().toLowerCase() : null;
  const access = checkCapsuleAccess(stored.capsule, agentIdHex, requesterAgentId, "verify.json");
  if (!access.allowed) {
    return jsonResponse(
      { error: "access_denied", detail: access.reason, agent_id: agentIdHex },
      403
    );
  }

  const capsule = stored.capsule;
  const checks: VerifyChecks = {
    schema: null,
    safety: null,
    chain: null,
    signature: null,
  };
  const warnings: string[] = [];

  // ── Level 1: Structure ──
  // Schema validation (same logic as write path)
  const schemaResult = validateCapsule(capsule, LIMITS);
  checks.schema = schemaResult.ok;

  // Safety scan (same logic as write path)
  const findings = scanForUnsafeContent(capsule);
  checks.safety = findings.length === 0;

  if (!checks.schema || !checks.safety) {
    // Failed structure checks — report and stop
    const res = buildResponse(agentIdHex, stored, checks, warnings, "none");
    return etagResponse(res, stored.cursor, request);
  }

  // ── Level 2: Integrity ──
  let chainOk = true;

  // Verify cursor matches capsule content
  const expectedCursor = await computeCursorForCapsule(capsule);
  if (expectedCursor !== stored.cursor) {
    chainOk = false;
    warnings.push("cursor_mismatch: stored cursor does not match recomputed hash of capsule content");
  }

  // Verify agent_id in capsule matches URL path
  if (
    capsule &&
    typeof capsule === "object" &&
    (capsule as Record<string, unknown>).agent_id !== agentIdHex
  ) {
    chainOk = false;
    warnings.push("agent_id_mismatch: capsule agent_id does not match URL path");
  }

  // Verify chain consistency against history (if available)
  const history = await getHistory(env, agentIdHex);
  if (history && history.versions.length > 0) {
    // Check seq monotonicity (newest first — seqs should be strictly decreasing)
    let seqOk = true;
    for (let i = 0; i < history.versions.length - 1; i++) {
      if (history.versions[i].seq <= history.versions[i + 1].seq) {
        seqOk = false;
        break;
      }
    }
    if (!seqOk) {
      chainOk = false;
      warnings.push("seq_not_monotonic: history contains non-strictly-decreasing sequence numbers");
    }

    // Check prev_cursor chain: stored.prev_cursor should match the cursor of the second-newest version
    if (history.versions.length >= 2) {
      const secondNewest = history.versions[1];
      if (stored.prev_cursor && stored.prev_cursor !== secondNewest.cursor) {
        chainOk = false;
        warnings.push("prev_cursor_chain_break: prev_cursor does not match prior version cursor");
      }
    }

    if (history.total_writes > history.versions.length) {
      warnings.push("history_pruned: chain check limited to retained versions");
    }
  } else {
    warnings.push("no_history: chain check skipped (no history available)");
  }

  checks.chain = chainOk;

  if (!chainOk) {
    const res = buildResponse(agentIdHex, stored, checks, warnings, "structure");
    return etagResponse(res, stored.cursor, request);
  }

  // ── Level 3: Auth ──
  // Verify Ed25519 signature requires the public_key and signature from the
  // original write envelope. We don't store those in KV (only the capsule +
  // cursor + seq). So we verify the binding: agent_id == sha256(public_key)
  // is already enforced on write. For read-time verification, we check what
  // we can: the agent_id derivation is consistent.
  //
  // Full signature re-verification would require storing the envelope, which
  // is not in v0 scope. Report signature as null (not applicable) if we can't
  // verify, rather than false (which would imply failure).
  //
  // If we had the public_key stored, we'd do full verification here.
  // For now, signature check is null = "not available at read time."
  checks.signature = null;
  warnings.push("signature_not_stored: full signature re-verification requires the original write envelope, which is not retained in v0. Signatures are verified on every write.");

  const res = buildResponse(agentIdHex, stored, checks, warnings, "integrity");
  return etagResponse(res, stored.cursor, request);
};

function buildResponse(
  agentIdHex: string,
  stored: { cursor: string; prev_cursor: string | null; seq: number },
  checks: VerifyChecks,
  warnings: string[],
  level: VerifyLevel
): Record<string, unknown> {
  const valid = level !== "none";
  return {
    agent_id: agentIdHex,
    valid,
    level,
    cursor: stored.cursor,
    prev_cursor: stored.prev_cursor,
    sequence: stored.seq,
    checks,
    warnings,
    verified_at: isoNow(),
  };
}

function etagResponse(
  body: Record<string, unknown>,
  cursor: string,
  request: Request
): Response {
  const res = jsonResponse(body);
  const cursorHex = cursor.startsWith("sha256:")
    ? cursor.slice("sha256:".length)
    : cursor;
  const etag = `"${cursorHex}"`;
  res.headers.set("ETag", etag);
  res.headers.set(
    "Cache-Control",
    "public, max-age=60, must-revalidate"
  );

  const inmRaw = request.headers.get("If-None-Match");
  const inm = inmRaw
    ? inmRaw.replace(/^W\//, "").replace(/^"|"$/g, "")
    : null;
  const inmToken =
    inm && inm.startsWith("sha256:") ? inm.slice("sha256:".length) : inm;
  if (inmToken && inmToken === cursorHex) {
    return new Response(null, { status: 304, headers: res.headers });
  }
  return res;
}
