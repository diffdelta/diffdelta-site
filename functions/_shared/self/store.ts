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

// v0: single generous tier for all agents. No paywall.
// TierPolicy kept for interface compatibility; both aliases point to the same policy.
export interface TierPolicy {
  limits: CapsuleLimits;
  write_limit_24h: number;
}

export const POLICY: TierPolicy = {
  // Filled by caller from schema constants to avoid circular deps.
  // (store.ts shouldn't import schema.ts to keep modules tiny)
  limits: null as unknown as CapsuleLimits,
  write_limit_24h: 50,
};

// Keep aliases so existing imports don't break.
export const FREE_POLICY: TierPolicy = POLICY;
export const PRO_POLICY: TierPolicy = POLICY;

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

// ─────────────────────────────────────────────────────────
// Access control — permission-based agent linking
// ─────────────────────────────────────────────────────────

export interface AccessControlResult {
  allowed: boolean;
  reason?: string; // human-readable reason for denial
}

// Resource-to-scope mapping for structured grants.
const RESOURCE_SCOPE_MAP: Record<string, string> = {
  "head.json": "READ_HEAD",
  "capsule.json": "READ_CAPSULE",
  "history.json": "READ_HISTORY",
  "verify.json": "READ_VERIFY",
};

/**
 * Check whether a requesting agent is allowed to read a capsule resource.
 *
 * Rules:
 * - If `access_control` is absent or `access_control.public` is true: anyone can read.
 * - If `access_control.public` is false: only the owner or listed `authorized_readers` can read.
 * - The requester identifies via `X-Self-Agent-Id` header.
 * - The owner's agent_id is always allowed (matches the capsule's own agent_id).
 * - Structured grants enforce scopes (which resources) and expiry (time-limited).
 * - Bare string grants (backward compat) allow all read scopes with no expiry.
 *
 * @param resource - The resource being accessed (e.g., "capsule.json"). If omitted, any read scope suffices.
 */
export function checkCapsuleAccess(
  capsule: unknown,
  ownerAgentId: string,
  requesterAgentId: string | null,
  resource?: string
): AccessControlResult {
  if (!capsule || typeof capsule !== "object") {
    return { allowed: true }; // malformed capsule — let the caller handle
  }

  const ac = (capsule as Record<string, unknown>).access_control;
  if (!ac || typeof ac !== "object") {
    return { allowed: true }; // no access_control → public (backward compatible)
  }

  const acObj = ac as Record<string, unknown>;
  if (acObj.public !== false) {
    return { allowed: true }; // explicitly public or missing public field
  }

  // Capsule is private — check requester identity
  if (!requesterAgentId) {
    return {
      allowed: false,
      reason: "This capsule is private. Include X-Self-Agent-Id header with your agent_id to authenticate.",
    };
  }

  // Owner always has access
  if (requesterAgentId === ownerAgentId) {
    return { allowed: true };
  }

  // Check authorized_readers list (supports both bare strings and structured grants)
  const readers = acObj.authorized_readers;
  if (!Array.isArray(readers)) {
    return {
      allowed: false,
      reason: "Your agent_id is not in this capsule's authorized_readers list.",
    };
  }

  const requiredScope = resource ? RESOURCE_SCOPE_MAP[resource] : undefined;
  const now = new Date();

  for (const entry of readers) {
    if (typeof entry === "string") {
      // Bare string: backward compatible — all scopes, no expiry
      if (entry === requesterAgentId) {
        return { allowed: true };
      }
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const grant = entry as Record<string, unknown>;
      if (grant.agent_id !== requesterAgentId) continue;

      // Check expiry
      if (typeof grant.expires_at === "string") {
        const expiry = new Date(grant.expires_at);
        if (expiry <= now) continue; // expired grant — skip
      }

      // Check scope
      if (requiredScope) {
        const scopes = grant.scopes;
        if (Array.isArray(scopes) && scopes.includes(requiredScope)) {
          return { allowed: true };
        }
        // Grant exists but doesn't cover this resource — keep searching
      } else {
        // No specific resource requested — any valid grant suffices
        return { allowed: true };
      }
    }
  }

  return {
    allowed: false,
    reason: "Your agent_id is not in this capsule's authorized_readers list, or your grant has expired or does not cover this resource.",
  };
}

// ─────────────────────────────────────────────────────────
// Capsule history — append-only, 100-version KV cap
// ─────────────────────────────────────────────────────────

export interface HistoryVersion {
  seq: number;
  cursor: string; // sha256:<hex>
  capsule: unknown;
  updated_at: string; // ISO 8601
}

export interface HistoryRecord {
  versions: HistoryVersion[]; // newest first
  total_writes: number; // total ever written (may exceed versions.length after pruning)
}

const MAX_HISTORY_VERSIONS = 100;

function historyKey(agentIdHex: string) {
  return `self:history:${agentIdHex}`;
}

/**
 * Append a capsule version to the agent's history.
 * Prunes oldest entries if over MAX_HISTORY_VERSIONS.
 */
export async function appendCapsuleVersion(
  env: Env,
  agentIdHex: string,
  version: HistoryVersion
): Promise<void> {
  const key = historyKey(agentIdHex);
  const raw = await env.SELF.get(key);
  let record: HistoryRecord;

  if (raw) {
    try {
      record = JSON.parse(raw) as HistoryRecord;
    } catch {
      record = { versions: [], total_writes: 0 };
    }
  } else {
    record = { versions: [], total_writes: 0 };
  }

  // Prepend (newest first)
  record.versions.unshift(version);
  record.total_writes += 1;

  // Prune oldest if over cap
  if (record.versions.length > MAX_HISTORY_VERSIONS) {
    record.versions = record.versions.slice(0, MAX_HISTORY_VERSIONS);
  }

  await env.SELF.put(key, JSON.stringify(record));
}

/**
 * Get the full history record for an agent.
 */
export async function getHistory(env: Env, agentIdHex: string): Promise<HistoryRecord | null> {
  const raw = await env.SELF.get(historyKey(agentIdHex));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HistoryRecord;
  } catch {
    return null;
  }
}

/**
 * Get history versions since a given cursor (exclusive — returns versions newer than the cursor).
 * Returns null if the cursor is not found in history (agent should re-fetch full history).
 */
export function getHistorySince(record: HistoryRecord, sinceCursor: string): HistoryVersion[] | null {
  // versions are newest-first; find the index of the cursor
  const idx = record.versions.findIndex((v) => v.cursor === sinceCursor);
  if (idx === -1) return null; // cursor not in history (pruned or invalid)
  // Everything before idx is newer than sinceCursor
  return record.versions.slice(0, idx);
}

// ─────────────────────────────────────────────────────────
// Agent metadata — for future DiffDelta Verified
// ─────────────────────────────────────────────────────────

export interface AgentMeta {
  first_seen: string; // ISO 8601
  total_writes: number;
  last_write: string; // ISO 8601
  schema_rejections: number;
  safety_rejections: number;
}

function agentMetaKey(agentIdHex: string) {
  return `self:meta:${agentIdHex}`;
}

/**
 * Update agent metadata on writes and rejections.
 * Increments counters and updates timestamps.
 */
export async function upsertAgentMeta(
  env: Env,
  agentIdHex: string,
  event: "write" | "schema_reject" | "safety_reject"
): Promise<void> {
  const key = agentMetaKey(agentIdHex);
  const raw = await env.SELF.get(key);
  const now = isoNow();

  let meta: AgentMeta;
  if (raw) {
    try {
      meta = JSON.parse(raw) as AgentMeta;
    } catch {
      meta = { first_seen: now, total_writes: 0, last_write: now, schema_rejections: 0, safety_rejections: 0 };
    }
  } else {
    meta = { first_seen: now, total_writes: 0, last_write: now, schema_rejections: 0, safety_rejections: 0 };
  }

  switch (event) {
    case "write":
      meta.total_writes += 1;
      meta.last_write = now;
      break;
    case "schema_reject":
      meta.schema_rejections += 1;
      break;
    case "safety_reject":
      meta.safety_rejections += 1;
      break;
  }

  await env.SELF.put(key, JSON.stringify(meta));
}

/**
 * Read agent metadata (for future Verified endpoint).
 */
export async function getAgentMeta(env: Env, agentIdHex: string): Promise<AgentMeta | null> {
  const raw = await env.SELF.get(agentMetaKey(agentIdHex));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentMeta;
  } catch {
    return null;
  }
}

