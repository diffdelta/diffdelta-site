// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Crypto utilities
// Why: Centralized key generation & hashing. Keys are never
// stored raw — only SHA-256 hashes live in KV.
// ─────────────────────────────────────────────────────────

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate a cryptographically secure API key.
 * Format: dd_live_ + 32 base62 chars ≈ 190 bits of entropy.
 */
export async function generateApiKey(): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => BASE62[b % 62]).join("");
  return `dd_live_${chars}`;
}

/**
 * SHA-256 hash a key for storage. Never store raw keys.
 * Returns lowercase hex string.
 */
export async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Generate an HMAC-SHA256 signature for webhook payloads.
 */
export async function hmacSign(
  payload: string,
  secret: string
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
