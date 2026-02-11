// KV storage and quota logic for Self Capsule.
// Why: single place to enforce invariants: last-good stays on reject; seq monotonic; quotas.

import type { Env } from "../types";
import { canonicalJson } from "./canonical";
import { sha256Hex } from "./crypto";
import type { CapsuleLimits } from "./schema";

export interface StoredCapsuleRecord {
  capsule: unknown;
  cursor: string; // sha256:<hex>
  prev_cursor: string | null; // sha256:<hex> or null
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface TierPolicy {
  tier: "free" | "pro";
  limits: CapsuleLimits;
  write_limit_24h: number;
}

export const FREE_POLICY: TierPolicy = {
  tier: "free",
  // Filled by caller from schema constants to avoid circular deps.
  // (store.ts shouldn't import schema.ts to keep modules tiny)
  limits: null as unknown as CapsuleLimits,
  write_limit_24h: 5,
};

export const PRO_POLICY: TierPolicy = {
  tier: "pro",
  limits: null as unknown as CapsuleLimits,
  write_limit_24h: 50,
};

export function capsuleKey(agentIdHex: string) {
  return `self:capsule:${agentIdHex}`;
}

export function writeLimitKey(agentIdHex: string, yyyyMmDd: string) {
  return `self:wrl:${agentIdHex}:${yyyyMmDd}`;
}

export function newAgentIpLimitKey(ipHashHex: string, yyyyMmDd: string) {
  return `self:newrl:${ipHashHex}:${yyyyMmDd}`;
}

export async function getStoredCapsule(env: Env, agentIdHex: string): Promise<StoredCapsuleRecord | null> {
  const raw = await env.SELF.get(capsuleKey(agentIdHex));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredCapsuleRecord;
  } catch {
    return null;
  }
}

export async function putStoredCapsule(env: Env, agentIdHex: string, record: StoredCapsuleRecord): Promise<void> {
  await env.SELF.put(capsuleKey(agentIdHex), JSON.stringify(record));
}

export function isoNow() {
  return new Date().toISOString();
}

export function yyyyMmDdNowUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function dayResetAtIsoUTC(): string {
  // Next UTC midnight
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
  return next.toISOString();
}

export async function getWritesUsed24h(env: Env, agentIdHex: string): Promise<number> {
  const key = writeLimitKey(agentIdHex, yyyyMmDdNowUTC());
  const raw = await env.SELF.get(key);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

export async function checkAndIncrementWriteQuota(
  env: Env,
  agentIdHex: string,
  limit24h: number
): Promise<{ allowed: boolean; used: number; remaining: number; reset_at: string }> {
  const dateKey = yyyyMmDdNowUTC();
  const key = writeLimitKey(agentIdHex, dateKey);
  const used = await getWritesUsed24h(env, agentIdHex);
  if (used >= limit24h) {
    return { allowed: false, used, remaining: 0, reset_at: dayResetAtIsoUTC() };
  }
  await env.SELF.put(key, String(used + 1), { expirationTtl: 86400 });
  return { allowed: true, used: used + 1, remaining: limit24h - (used + 1), reset_at: dayResetAtIsoUTC() };
}

export async function checkAndIncrementNewAgentQuotaForIp(
  env: Env,
  ip: string,
  limit24h: number
): Promise<{ allowed: boolean; used: number; remaining: number; reset_at: string }> {
  const dateKey = yyyyMmDdNowUTC();
  const ipHashHex = await sha256Hex(new TextEncoder().encode(ip || "unknown"));
  const key = newAgentIpLimitKey(ipHashHex, dateKey);
  const raw = await env.SELF.get(key);
  const used = raw ? parseInt(raw, 10) || 0 : 0;
  if (used >= limit24h) {
    return { allowed: false, used, remaining: 0, reset_at: dayResetAtIsoUTC() };
  }
  await env.SELF.put(key, String(used + 1), { expirationTtl: 86400 });
  return { allowed: true, used: used + 1, remaining: limit24h - (used + 1), reset_at: dayResetAtIsoUTC() };
}

export async function computeCursorForCapsule(capsule: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(capsule));
  const hex = await sha256Hex(bytes);
  return `sha256:${hex}`;
}

