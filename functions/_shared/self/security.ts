// Deterministic safety checks for Self Capsule writes.
// Why: project-ending risk is prompt-injection / secret leakage becoming persistent state.

const MAX_DEPTH = 8;
const MAX_KEYS_TOTAL = 200;

// Extremely conservative patterns (v0). These are not "opinions" — they are guardrails.
const BAD_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s+prompt/i,
  /developer\s+message/i,
  /function_call/i,
  /tool\s*:\s*/i,
  /\bcurl\b/i,
  /\brm\s+-rf\b/i,
  /\bbash\b.*-lc/i,
  /\bpowershell\b/i,
  /Authorization\s*:/i,
];

// Secret-like patterns (examples; keep conservative).
// Exported so feed item validation can reuse the same list without duplicating.
export const SECRET_PATTERNS: RegExp[] = [
  /\bsk[-_][A-Za-z0-9_]{20,}\b/,             // common API key prefix (sk-xxx or sk_live_xxx)
  /\bdd_live_[A-Za-z0-9]{20,}\b/,            // DiffDelta key format
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,      // PEM private keys
  /\bAKIA[0-9A-Z]{16}\b/,                    // AWS access key id
  /\bmoltbook_sk_[A-Za-z0-9_]{20,}\b/,       // Moltbook API key
  /\bghp_[A-Za-z0-9]{36,}\b/,               // GitHub personal access token
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,           // GitLab personal access token
  /\bxoxb-[0-9]{10,}-[A-Za-z0-9]+/,         // Slack bot token
];

export interface SafetyFinding {
  code:
    | "too_deep"
    | "too_many_keys"
    | "bad_pattern"
    | "secret_pattern"
    | "url_in_text";
  path: string;
}

// Narrow subset of BAD_PATTERNS for feed item content.
// Feed items are tech news/advisories — patterns like curl, bash, powershell,
// Authorization, and "system prompt" are legitimate in that context.
// Only flag unambiguous prompt injection attempts.
export const FEED_SAFETY_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /developer\s+message/i,
  /function_call/i,
  /tool\s*:\s*/i,
];

export function scanForUnsafeContent(value: unknown): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  let keysSeen = 0;

  function walk(v: unknown, path: string, depth: number) {
    if (depth > MAX_DEPTH) {
      findings.push({ code: "too_deep", path });
      return;
    }
    if (v === null || v === undefined) return;

    if (typeof v === "string") {
      const s = v;
      for (const re of BAD_PATTERNS) {
        if (re.test(s)) {
          findings.push({ code: "bad_pattern", path });
          break;
        }
      }
      for (const re of SECRET_PATTERNS) {
        if (re.test(s)) {
          findings.push({ code: "secret_pattern", path });
          break;
        }
      }

      // URLs are only allowed in pointers.receipts.evidence_url. We enforce this here.
      const isEvidenceUrl =
        path.includes("pointers.receipts[") && path.endsWith(".evidence_url");
      if (/(https?:\/\/)/i.test(s) && !isEvidenceUrl) {
        findings.push({ code: "url_in_text", path });
      }
      return;
    }

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        walk(v[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }

    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        keysSeen++;
        if (keysSeen > MAX_KEYS_TOTAL) {
          findings.push({ code: "too_many_keys", path });
          return;
        }
        walk(obj[k], path ? `${path}.${k}` : k, depth + 1);
      }
    }
  }

  walk(value, "", 0);
  return findings;
}

