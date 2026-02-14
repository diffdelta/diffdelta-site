// Self Capsule cryptography helpers (v0: Ed25519-only).
// Why: signed writes are the integrity boundary; reads are public.

import { canonicalJson } from "./canonical";

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

export async function sha256HexOfJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return sha256Hex(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex length");
  if (!/^[0-9a-f]*$/i.test(hex)) throw new Error("Invalid hex characters");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function parseAgentIdHex(agentId: string): string {
  const hex = agentId.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("Invalid agent_id (expected 64 hex chars)");
  }
  return hex;
}

export interface SignedCapsuleEnvelope {
  agent_id: string; // <64 hex>
  public_key: string; // hex or base64 (v0: accept hex only for simplicity)
  seq: number;
  signature_alg?: "ed25519" | "hmac-sha256";
  signature: string; // hex (v0: Ed25519 signature bytes)
  capsule: unknown;
}

export async function verifyEd25519Envelope(env: SignedCapsuleEnvelope): Promise<void> {
  // v0: Ed25519-only
  if (env.signature_alg && env.signature_alg !== "ed25519") {
    throw new Error("Unsupported signature_alg (v0: ed25519 only)");
  }

  // Guard: required envelope fields must be present and be strings.
  if (typeof env.public_key !== "string") throw new Error("Missing public_key");
  if (typeof env.signature !== "string") throw new Error("Missing signature");
  if (env.capsule === undefined || env.capsule === null) throw new Error("Missing capsule");

  const agentIdHex = parseAgentIdHex(env.agent_id);

  // public_key: require 32-byte hex for v0
  const pubHex = env.public_key.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubHex)) throw new Error("Invalid public_key (expected 32-byte hex)");
  const pubKeyBytes = fromHex(pubHex);

  // Verify binding: agent_id == sha256(public_key_bytes)
  const derived = await sha256Hex(pubKeyBytes);
  if (derived !== agentIdHex) throw new Error("agent_id does not match public_key");

  // Signature: 64-byte hex
  const sigHex = env.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sigHex)) throw new Error("Invalid signature (expected 64-byte hex)");
  const sigBytes = fromHex(sigHex);

  // Message to sign: sha256(canonical_json({agent_id, seq, capsule}))
  const msgHashHex = await sha256HexOfJson({
    agent_id: agentIdHex,
    seq: env.seq,
    capsule: env.capsule,
  });
  const msgBytes = fromHex(msgHashHex);

  // Attempt WebCrypto Ed25519 verification.
  // If runtime lacks Ed25519 support, we hard-fail (safe default).
  // We can later swap this to a small audited library without changing the envelope.
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      pubKeyBytes,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { name: "Ed25519" } as any,
      false,
      ["verify"]
    );
  } catch {
    throw new Error("Ed25519 not supported in this runtime (importKey failed)");
  }

  let ok = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ok = await crypto.subtle.verify({ name: "Ed25519" } as any, key, sigBytes, msgBytes);
  } catch {
    throw new Error("Ed25519 not supported in this runtime (verify failed)");
  }

  if (!ok) throw new Error("Invalid signature");
}

