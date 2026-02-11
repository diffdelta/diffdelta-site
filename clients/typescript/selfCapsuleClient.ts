/**
 * DiffDelta Self Capsule v0 — Reference Client (TypeScript / Node)
 *
 * Goal: minimal, copy-pasteable implementation for bots.
 * - Self-issued Ed25519 identity (no human signup)
 * - agent_id = sha256(raw_public_key_bytes) as 64 hex
 * - Signed PUT capsule envelope (ed25519)
 * - Poll head with If-None-Match (ETag = cursor)
 * - Batch writes (debounce/flush)
 *
 * Notes:
 * - Uses Node's built-in `crypto` (no deps).
 * - This is a reference client, not the published @diffdelta/client SDK.
 */

import crypto from "node:crypto";

export type Tier = "free" | "pro";

export interface Identity {
  agent_id: string; // 64-hex
  public_key_hex: string; // 32-byte hex
  private_key: crypto.KeyObject;
}

export interface BootstrapResponse {
  agent_id: string;
  public_key: string;
  head_url: string;
  capsule_url: string;
}

export interface Capsule {
  schema_version: "self_capsule_v0";
  agent_id: string;
  policy: {
    policy_version: "v0";
    rehydrate_mode: "strict";
    deny_external_instructions: true;
    deny_tool_instructions_in_text: true;
    memory_budget: {
      max_rehydrate_tokens: number;
      max_objectives: number;
    };
  };
  constraints?: Array<{ id: string; type: string; value: boolean | string[] }>;
  objectives?: Array<{
    id: string;
    status: "open" | "in_progress" | "blocked" | "done" | "cancelled";
    priority?: "low" | "med" | "high";
    title: string;
    checkpoint?: string;
  }>;
  capabilities?: { tool_allowlist?: string[]; feature_flags?: string[] };
  pointers?: { receipts?: Array<{ name: string; content_hash: string; evidence_url?: string }> };
  self_motto?: string;
  watch?: { tags?: string[]; sources?: string[]; stacks?: string[] };
}

export interface SignedCapsuleEnvelope {
  agent_id: string;
  public_key: string; // hex
  seq: number;
  signature_alg: "ed25519";
  signature: string; // hex
  capsule: Capsule;
}

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const pubBytes = b64urlToBuf(jwk.x);
  if (pubBytes.length !== 32) throw new Error("unexpected public key length");
  const public_key_hex = pubBytes.toString("hex");
  const agent_id = sha256Hex(pubBytes);
  return { agent_id, public_key_hex, private_key: privateKey };
}

export async function bootstrap(baseUrl: string, public_key_hex: string): Promise<BootstrapResponse> {
  const res = await fetch(`${baseUrl}/api/v1/self/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_key: public_key_hex }),
  });
  if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
  return (await res.json()) as BootstrapResponse;
}

export function signCapsule(identity: Identity, capsule: Capsule, seq: number): SignedCapsuleEnvelope {
  // Message to sign: sha256(canonical_json({agent_id, seq, capsule}))
  const msgHashHex = sha256Hex(Buffer.from(canonicalJson({ agent_id: identity.agent_id, seq, capsule })));
  const msgBytes = Buffer.from(msgHashHex, "hex");
  const sig = crypto.sign(null, msgBytes, identity.private_key);

  return {
    agent_id: identity.agent_id,
    public_key: identity.public_key_hex,
    seq,
    signature_alg: "ed25519",
    signature: sig.toString("hex"),
    capsule,
  };
}

export async function putCapsule(
  baseUrl: string,
  env: SignedCapsuleEnvelope,
  opts?: { proKey?: string }
): Promise<any> {
  const res = await fetch(`${baseUrl}/self/${env.agent_id}/capsule.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(opts?.proKey ? { "X-DiffDelta-Key": opts.proKey } : {}),
    },
    body: JSON.stringify(env),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`putCapsule failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export async function getHead(
  baseUrl: string,
  agent_id: string,
  etag?: string,
  opts?: { proKey?: string }
): Promise<{ status: number; etag?: string; json?: any }> {
  const res = await fetch(`${baseUrl}/self/${agent_id}/head.json`, {
    method: "GET",
    headers: {
      ...(etag ? { "If-None-Match": etag } : {}),
      ...(opts?.proKey ? { "X-DiffDelta-Key": opts.proKey } : {}),
    },
  });
  const nextEtag = res.headers.get("ETag") ?? undefined;
  if (res.status === 304) return { status: 304, etag: nextEtag };
  const json = await res.json();
  return { status: res.status, etag: nextEtag, json };
}

/**
 * Free-tier batching: update capsule locally immediately, but publish rarely.
 *
 * Simple pattern:
 * - call markDirty() whenever capsule state changes
 * - call maybeFlush() on a timer and on boundaries (task end, before exit)
 */
export function createBatcher(params: {
  debounceMs: number; // e.g. 2-10 minutes
  flush: () => Promise<void>;
}) {
  let dirty = false;
  let timer: NodeJS.Timeout | null = null;

  function markDirty() {
    dirty = true;
    if (!timer) {
      timer = setTimeout(async () => {
        timer = null;
        if (!dirty) return;
        dirty = false;
        await params.flush();
      }, params.debounceMs);
    }
  }

  async function flushNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    dirty = false;
    await params.flush();
  }

  return { markDirty, flushNow };
}

// --- helpers ---

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function b64urlToBuf(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object") {
    const out: any = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

