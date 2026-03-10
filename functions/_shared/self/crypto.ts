// Self Capsule cryptography helpers (v0: Ed25519-only).
// Why: signed writes are the integrity boundary; reads are public.
// Uses Web Crypto API only — no node:crypto, so it runs on Cloudflare
// Workers/Pages Functions without nodejs_compat.

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
  if (env.signature_alg && env.signature_alg !== "ed25519") {
    throw new Error("Unsupported signature_alg (v0: ed25519 only)");
  }

  if (typeof env.public_key !== "string") throw new Error("Missing public_key");
  if (typeof env.signature !== "string") throw new Error("Missing signature");
  if (env.capsule === undefined || env.capsule === null) throw new Error("Missing capsule");

  const agentIdHex = parseAgentIdHex(env.agent_id);

  const pubHex = env.public_key.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubHex)) throw new Error("Invalid public_key (expected 32-byte hex)");
  const pubKeyBytes = fromHex(pubHex);

  const derived = await sha256Hex(pubKeyBytes);
  if (derived !== agentIdHex) throw new Error("agent_id does not match public_key");

  const sigHex = env.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sigHex)) throw new Error("Invalid signature (expected 64-byte hex)");
  const sigBytes = fromHex(sigHex);

  const msgHashHex = await sha256HexOfJson({
    agent_id: agentIdHex,
    seq: env.seq,
    capsule: env.capsule,
  });
  const msgBytes = fromHex(msgHashHex);

  // Import the raw 32-byte Ed25519 public key via Web Crypto API.
  // Wrap in SPKI DER: 12-byte fixed prefix + 32-byte raw key.
  const ED25519_SPKI_PREFIX = new Uint8Array([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
    0x70, 0x03, 0x21, 0x00,
  ]);
  const spkiDer = new Uint8Array(44);
  spkiDer.set(ED25519_SPKI_PREFIX, 0);
  spkiDer.set(pubKeyBytes, 12);

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      spkiDer,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    ok = await crypto.subtle.verify("Ed25519", key, sigBytes, msgBytes);
  } catch {
    throw new Error("Ed25519 verification failed");
  }

  if (!ok) throw new Error("Invalid signature");
}
