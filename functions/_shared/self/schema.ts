// Self Capsule schema validation (v0) — strict, bounded, additionalProperties=false.
// Why: keep capsules non-sensitive, compact, and deterministic.

export type Tier = "free" | "pro";

export interface ValidationResult {
  ok: boolean;
  reason_codes?: string[];
}

export interface CapsuleLimits {
  maxBytes: number;
  maxObjectives: number;
  maxConstraints: number;
  maxReceipts: number;
  maxTools: number;
  maxFlags: number;
}

export const FREE_LIMITS: CapsuleLimits = {
  maxBytes: 4096,
  maxObjectives: 8,
  maxConstraints: 20,
  maxReceipts: 5,
  maxTools: 20,
  maxFlags: 20,
};

export const PRO_LIMITS: CapsuleLimits = {
  maxBytes: 24 * 1024,
  maxObjectives: 8,
  maxConstraints: 20,
  maxReceipts: 5,
  maxTools: 20,
  maxFlags: 20,
};

const AGENT_ID_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z0-9_-]{1,24}$/;
const TOOL_ID_RE = /^[a-z0-9_.:-]{1,48}$/;
const SOURCE_ID_RE = /^[a-z0-9_\-]{2,32}$/;

export function validateCapsule(capsule: unknown, limits: CapsuleLimits): ValidationResult {
  const reasons: string[] = [];

  if (!isObj(capsule)) return { ok: false, reason_codes: ["invalid_capsule"] };

  // Top-level allowed fields only
  const allowedTop = new Set([
    "schema_version",
    "agent_id",
    "policy",
    "constraints",
    "objectives",
    "capabilities",
    "pointers",
    "self_motto",
    "watch",
  ]);
  for (const k of Object.keys(capsule)) {
    if (!allowedTop.has(k)) reasons.push("unknown_field");
  }

  const schemaVersion = capsule.schema_version;
  if (schemaVersion !== "self_capsule_v0") reasons.push("schema_version");

  const agentId = capsule.agent_id;
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) reasons.push("agent_id");

  // policy
  if (!isObj(capsule.policy)) {
    reasons.push("policy");
  } else {
    const p = capsule.policy;
    const allowedPolicy = new Set([
      "policy_version",
      "rehydrate_mode",
      "deny_external_instructions",
      "deny_tool_instructions_in_text",
      "memory_budget",
    ]);
    for (const k of Object.keys(p)) if (!allowedPolicy.has(k)) reasons.push("unknown_field");

    if (typeof p.policy_version !== "string" || p.policy_version.length > 16) reasons.push("policy_version");
    if (p.rehydrate_mode !== "strict") reasons.push("rehydrate_mode");
    if (p.deny_external_instructions !== true) reasons.push("deny_external_instructions");
    if (p.deny_tool_instructions_in_text !== true) reasons.push("deny_tool_instructions_in_text");

    if (!isObj(p.memory_budget)) {
      reasons.push("memory_budget");
    } else {
      const mb = p.memory_budget;
      const allowedMb = new Set(["max_rehydrate_tokens", "max_objectives"]);
      for (const k of Object.keys(mb)) if (!allowedMb.has(k)) reasons.push("unknown_field");
      if (!isInt(mb.max_rehydrate_tokens) || mb.max_rehydrate_tokens < 256 || mb.max_rehydrate_tokens > 1500) {
        reasons.push("max_rehydrate_tokens");
      }
      if (!isInt(mb.max_objectives) || mb.max_objectives < 0 || mb.max_objectives > limits.maxObjectives) {
        reasons.push("max_objectives");
      }
    }
  }

  // constraints
  if (capsule.constraints !== undefined) {
    if (!Array.isArray(capsule.constraints) || capsule.constraints.length > limits.maxConstraints) {
      reasons.push("constraints");
    } else {
      for (const c of capsule.constraints) {
        if (!isObj(c)) {
          reasons.push("constraint_item");
          continue;
        }
        const allowed = new Set(["id", "type", "value"]);
        for (const k of Object.keys(c)) if (!allowed.has(k)) reasons.push("unknown_field");
        if (typeof c.id !== "string" || !ID_RE.test(c.id)) reasons.push("constraint_id");
        if (typeof c.type !== "string") reasons.push("constraint_type");
        if (!("value" in c)) reasons.push("constraint_value");
        if (Array.isArray(c.value)) {
          if (c.value.length > 20) reasons.push("constraint_value");
          for (const s of c.value) if (typeof s !== "string" || s.length > 48) reasons.push("constraint_value");
        } else if (typeof c.value !== "boolean") {
          reasons.push("constraint_value");
        }
      }
    }
  }

  // objectives
  if (capsule.objectives !== undefined) {
    if (!Array.isArray(capsule.objectives) || capsule.objectives.length > limits.maxObjectives) {
      reasons.push("objectives");
    } else {
      for (const o of capsule.objectives) {
        if (!isObj(o)) {
          reasons.push("objective_item");
          continue;
        }
        const allowed = new Set(["id", "status", "priority", "title", "checkpoint"]);
        for (const k of Object.keys(o)) if (!allowed.has(k)) reasons.push("unknown_field");
        if (typeof o.id !== "string" || !ID_RE.test(o.id)) reasons.push("objective_id");
        if (typeof o.status !== "string") reasons.push("objective_status");
        if (o.priority !== undefined && !["low", "med", "high"].includes(o.priority)) reasons.push("objective_priority");
        if (typeof o.title !== "string" || o.title.length < 1 || o.title.length > 120) reasons.push("objective_title");
        if (o.checkpoint !== undefined && (typeof o.checkpoint !== "string" || o.checkpoint.length > 200)) {
          reasons.push("objective_checkpoint");
        }
      }
    }
  }

  // capabilities
  if (capsule.capabilities !== undefined) {
    if (!isObj(capsule.capabilities)) {
      reasons.push("capabilities");
    } else {
      const cap = capsule.capabilities;
      const allowed = new Set(["tool_allowlist", "feature_flags"]);
      for (const k of Object.keys(cap)) if (!allowed.has(k)) reasons.push("unknown_field");

      if (cap.tool_allowlist !== undefined) {
        if (!Array.isArray(cap.tool_allowlist) || cap.tool_allowlist.length > limits.maxTools) reasons.push("tool_allowlist");
        else for (const t of cap.tool_allowlist) if (typeof t !== "string" || !TOOL_ID_RE.test(t)) reasons.push("tool_allowlist");
      }
      if (cap.feature_flags !== undefined) {
        if (!Array.isArray(cap.feature_flags) || cap.feature_flags.length > limits.maxFlags) reasons.push("feature_flags");
        else for (const f of cap.feature_flags) if (typeof f !== "string" || f.length > 32) reasons.push("feature_flags");
      }
    }
  }

  // pointers.receipts
  if (capsule.pointers !== undefined) {
    if (!isObj(capsule.pointers)) {
      reasons.push("pointers");
    } else {
      const p = capsule.pointers;
      const allowed = new Set(["receipts"]);
      for (const k of Object.keys(p)) if (!allowed.has(k)) reasons.push("unknown_field");
      if (p.receipts !== undefined) {
        if (!Array.isArray(p.receipts) || p.receipts.length > limits.maxReceipts) reasons.push("receipts");
        else {
          for (const r of p.receipts) {
            if (!isObj(r)) {
              reasons.push("receipt_item");
              continue;
            }
            const allowedR = new Set(["name", "content_hash", "evidence_url"]);
            for (const k of Object.keys(r)) if (!allowedR.has(k)) reasons.push("unknown_field");
            if (typeof r.name !== "string" || r.name.length < 1 || r.name.length > 32) reasons.push("receipt_name");
            if (typeof r.content_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(r.content_hash)) reasons.push("receipt_hash");
            if (r.evidence_url !== undefined && (typeof r.evidence_url !== "string" || r.evidence_url.length > 200)) reasons.push("receipt_url");
          }
        }
      }
    }
  }

  // self_motto
  if (capsule.self_motto !== undefined) {
    if (typeof capsule.self_motto !== "string" || capsule.self_motto.length > 160) reasons.push("self_motto");
  }

  // watch (optional)
  if (capsule.watch !== undefined) {
    if (!isObj(capsule.watch)) {
      reasons.push("watch");
    } else {
      const w = capsule.watch;
      const allowed = new Set(["tags", "sources", "stacks"]);
      for (const k of Object.keys(w)) if (!allowed.has(k)) reasons.push("unknown_field");
      if (w.tags !== undefined) {
        if (!Array.isArray(w.tags) || w.tags.length > 10) reasons.push("watch.tags");
        else for (const t of w.tags) if (typeof t !== "string" || t.length > 24) reasons.push("watch.tags");
      }
      if (w.sources !== undefined) {
        if (!Array.isArray(w.sources) || w.sources.length > 25) reasons.push("watch.sources");
        else for (const s of w.sources) if (typeof s !== "string" || !SOURCE_ID_RE.test(s)) reasons.push("watch.sources");
      }
      if (w.stacks !== undefined) {
        if (!Array.isArray(w.stacks) || w.stacks.length > 10) reasons.push("watch.stacks");
        else for (const s of w.stacks) if (typeof s !== "string" || s.length > 32) reasons.push("watch.stacks");
      }
    }
  }

  if (reasons.length) return { ok: false, reason_codes: uniq(reasons) };
  return { ok: true };
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr));
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

