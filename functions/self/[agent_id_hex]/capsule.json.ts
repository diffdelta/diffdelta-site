// ─────────────────────────────────────────────────────────
// Self Capsule — Read/Write capsule.json
// GET  /self/{agent_id_hex}/capsule.json
// PUT  /self/{agent_id_hex}/capsule.json   (signed, hard reject)
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";
import { parseAgentIdHex, verifyEd25519Envelope } from "../../_shared/self/crypto";
import { scanForUnsafeContent } from "../../_shared/self/security";
import { validateCapsule, LIMITS } from "../../_shared/self/schema";
import {
  computeCursorForCapsule,
  getStoredCapsule,
  putStoredCapsule,
  isoNow,
  checkAndIncrementWriteQuota,
  checkAndIncrementNewAgentQuotaForIp,
  dayResetAtIsoUTC,
  appendCapsuleVersion,
  upsertAgentMeta,
  checkCapsuleAccess,
  registerAgent,
} from "../../_shared/self/store";
import { canonicalJson } from "../../_shared/self/canonical";

// v0: single generous tier — all agents get the same limits.
const WRITE_LIMIT_24H = 50;
const NEW_AGENT_IP_LIMIT_24H = 20;

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

  // Access control: if capsule is private, verify requester is authorized.
  // Normalize to lowercase hex so case-insensitive agent IDs match correctly.
  const rawRequester = request.headers.get("X-Self-Agent-Id");
  const requesterAgentId = rawRequester ? rawRequester.trim().toLowerCase() : null;
  const access = checkCapsuleAccess(stored.capsule, agentIdHex, requesterAgentId, "capsule.json");
  if (!access.allowed) {
    return jsonResponse(
      { error: "access_denied", detail: access.reason, agent_id: agentIdHex },
      403
    );
  }

  // Return the last-known-good capsule only (no secrets, strictly typed).
  const res = jsonResponse(stored.capsule);
  const cursorHex = stored.cursor.startsWith("sha256:") ? stored.cursor.slice("sha256:".length) : stored.cursor;
  const etag = `"${cursorHex}"`;
  res.headers.set("ETag", etag);
  const inmRaw = request.headers.get("If-None-Match");
  const inm = inmRaw
    ? inmRaw.replace(/^W\//, "").replace(/^"|"$/g, "")
    : null;
  const inmToken = inm && inm.startsWith("sha256:") ? inm.slice("sha256:".length) : inm;
  if (inmToken && inmToken === cursorHex) {
    return new Response(null, { status: 304, headers: res.headers });
  }
  return res;
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const { params, env, request } = context;
  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(String(params.agent_id_hex || ""));
  } catch {
    return errorResponse("Invalid agent_id (expected 64 hex chars)", 400);
  }

  // Hard body-size cap BEFORE parsing JSON (protects against missing Content-Length)
  const MAX_REQUEST_BYTES = 64 * 1024; // envelope + capsule; intentionally small
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > MAX_REQUEST_BYTES) {
    return jsonResponse(
      { accepted: false, reason_codes: ["payload_too_large"], max_bytes: MAX_REQUEST_BYTES, next_write_at: dayResetAtIsoUTC() },
      413
    );
  }
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // v0: single generous tier — all agents get the same limits.
  const limits = LIMITS;

  // Envelope must include capsule + signature fields.
  const envelope = body;
  envelope.agent_id = agentIdHex; // enforce path truth

  // Verify signature & binding (hard reject).
  try {
    await verifyEd25519Envelope(envelope);
  } catch (e: any) {
    return jsonResponse(
      {
        accepted: false,
        reason_codes: ["bad_signature"],
        detail: String(e?.message || "signature_error"),
        next_write_at: dayResetAtIsoUTC(),
      },
      401
    );
  }

  // Enforce seq monotonic
  const stored = await getStoredCapsule(env, agentIdHex);
  const seq = envelope.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
    return jsonResponse({ accepted: false, reason_codes: ["bad_seq"], next_write_at: dayResetAtIsoUTC() }, 400);
  }
  if (stored && seq <= stored.seq) {
    return jsonResponse({ accepted: false, reason_codes: ["replay_seq"], next_write_at: dayResetAtIsoUTC() }, 409);
  }

  // Validate capsule schema
  const capsule = envelope.capsule;
  const val = validateCapsule(capsule, limits);
  if (!val.ok) {
    // Track rejection metadata (fire-and-forget — don't block response)
    context.waitUntil(upsertAgentMeta(env, agentIdHex, "schema_reject"));
    return jsonResponse({ accepted: false, reason_codes: val.reason_codes, next_write_at: dayResetAtIsoUTC() }, 422);
  }

  // Cross-check: capsule.agent_id must match URL path agent_id.
  // Schema validates it's 64 hex, but doesn't enforce binding to path.
  if ((capsule as Record<string, unknown>).agent_id !== agentIdHex) {
    return jsonResponse(
      { accepted: false, reason_codes: ["agent_id_mismatch"], detail: "capsule.agent_id must match URL agent_id", next_write_at: dayResetAtIsoUTC() },
      400
    );
  }

  // Safety scan (deterministic)
  const findings = scanForUnsafeContent(capsule);
  if (findings.length > 0) {
    // Track rejection metadata (fire-and-forget)
    context.waitUntil(upsertAgentMeta(env, agentIdHex, "safety_reject"));
    return jsonResponse(
      {
        accepted: false,
        reason_codes: ["unsafe_content"],
        findings,
        next_write_at: dayResetAtIsoUTC(),
      },
      422
    );
  }

  // Size cap (post-parse, deterministic)
  const capsuleBytes = new TextEncoder().encode(canonicalJson(capsule)).byteLength;
  if (capsuleBytes > limits.maxBytes) {
    return jsonResponse(
      { accepted: false, reason_codes: ["capsule_too_large"], observed_bytes: capsuleBytes, max_bytes: limits.maxBytes },
      413
    );
  }

  // Quota check AFTER signature + validation to avoid quota-burning DoS.
  // Additional Sybil guardrail: limit *new* capsule creation per IP/day.
  if (!stored) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const newQuota = await checkAndIncrementNewAgentQuotaForIp(env, ip, NEW_AGENT_IP_LIMIT_24H);
    if (!newQuota.allowed) {
      return jsonResponse(
        {
          accepted: false,
          reason_codes: ["new_agent_ip_quota_exceeded"],
          retry_after_sec: 3600,
          next_write_at: newQuota.reset_at,
        },
        429
      );
    }
    // Register the agent in the append-only registry (fire-and-forget).
    // This lets the operator list all bootstrapped agents without knowing IDs upfront.
    context.waitUntil(registerAgent(env, agentIdHex));
  }

  const quota = await checkAndIncrementWriteQuota(env, agentIdHex, WRITE_LIMIT_24H);
  if (!quota.allowed) {
    return jsonResponse(
      {
        accepted: false,
        reason_codes: ["write_quota_exceeded"],
        retry_after_sec: 3600,
        next_write_at: quota.reset_at,
        writes: { limit_24h: WRITE_LIMIT_24H, used_24h: quota.used, remaining_24h: quota.remaining, reset_at: quota.reset_at },
      },
      429
    );
  }

  // Cursor advancement (only on accept)
  const cursor = await computeCursorForCapsule(capsule);
  const prevCursor = stored ? stored.cursor : null;

  const now = isoNow();
  const record = {
    capsule,
    cursor,
    prev_cursor: prevCursor,
    seq,
    created_at: stored ? stored.created_at : now,
    updated_at: now,
  };

  await putStoredCapsule(env, agentIdHex, record);

  // Append version to history + track write metadata (fire-and-forget)
  context.waitUntil(
    Promise.all([
      appendCapsuleVersion(env, agentIdHex, { seq, cursor, capsule, updated_at: now }),
      upsertAgentMeta(env, agentIdHex, "write"),
    ])
  );

  return jsonResponse({
    accepted: true,
    agent_id: agentIdHex,
    cursor,
    prev_cursor: prevCursor,
    changed: prevCursor ? cursor !== prevCursor : true,
    generated_at: now,
    ttl_sec: 600,
    capsule_url: `/self/${agentIdHex}/capsule.json`,
    history_url: `/self/${agentIdHex}/history.json`,
    writes: { limit_24h: WRITE_LIMIT_24H, used_24h: quota.used, remaining_24h: quota.remaining, reset_at: quota.reset_at },
  });
};

