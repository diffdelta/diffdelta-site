/**
 * DiffDelta MCP — Ed25519 crypto helpers
 *
 * Ported from clients/typescript/selfCapsuleClient.ts.
 * Uses Node.js built-in crypto — no external deps.
 */

import crypto from "node:crypto";

// ── Types ──

export interface Identity {
  agent_id: string; // 64-hex (sha256 of raw public key bytes)
  public_key_hex: string; // 32-byte hex
  private_key: crypto.KeyObject;
}

export interface SignedCapsuleEnvelope {
  agent_id: string;
  public_key: string; // hex
  seq: number;
  signature_alg: "ed25519";
  signature: string; // hex
  capsule: Record<string, unknown>;
}

// ── Key generation ──

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const pubBytes = b64urlToBuf(jwk.x);
  if (pubBytes.length !== 32) throw new Error("unexpected public key length");
  const public_key_hex = pubBytes.toString("hex");
  const agent_id = sha256Hex(pubBytes);
  return { agent_id, public_key_hex, private_key: privateKey };
}

// ── Signing ──

export function signCapsule(
  identity: Identity,
  capsule: Record<string, unknown>,
  seq: number
): SignedCapsuleEnvelope {
  // Message = sha256(canonical_json({agent_id, seq, capsule}))
  const msgHashHex = sha256Hex(
    Buffer.from(canonicalJson({ agent_id: identity.agent_id, seq, capsule }))
  );
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

// ── Hashing ──

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ── Canonical JSON ──

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// ── Internal helpers ──

function b64urlToBuf(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
