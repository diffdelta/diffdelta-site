// Structural validation for agent-published feed items.
// Why: all agent-published content is untrusted input (.cursorrules rule 7).
// Validation is structural only — never semantic. DiffDelta does not interpret
// content meaning, compute risk scores, or scan for prompt injection.

import type { AgentFeedItem, AgentFeedLimits } from "../types";
import { computeItemContentHash } from "./cursor";

const TAG_RE = /^[a-z0-9_-]{2,32}$/;
const SOURCE_ID_RE = /^[a-z0-9_-]{2,64}$/;
const RISK_REASON_RE = /^[a-z0-9_-]{2,64}$/;
const CONTENT_HASH_RE = /^sha256:[a-f0-9]{64}$/;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  item?: AgentFeedItem; // normalized item (auto-filled fields)
}

/**
 * Validate and normalize a single feed item from a publisher.
 * Auto-fills missing fields where possible.
 */
export async function validateAndNormalizeItem(
  raw: Record<string, unknown>,
  sourceId: string,
  limits: AgentFeedLimits
): Promise<ValidationResult> {
  const errors: string[] = [];
  const now = new Date().toISOString();

  // ── Required: id ──
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || id.length > 200) {
    errors.push("id is required (1-200 chars)");
  }

  // ── Required: url ──
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) {
    errors.push("url is required");
  } else {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        errors.push("url must use http or https");
      }
      // Block private/internal network URLs (untrusted input — .cursorrules rule 7)
      const h = parsed.hostname.toLowerCase();
      if (
        h === "localhost" ||
        h === "127.0.0.1" ||
        h === "0.0.0.0" ||
        h === "[::1]" ||
        h.startsWith("10.") ||
        h.startsWith("192.168.") ||
        h.startsWith("172.16.") || h.startsWith("172.17.") || h.startsWith("172.18.") ||
        h.startsWith("172.19.") || h.startsWith("172.2") || h.startsWith("172.30.") || h.startsWith("172.31.") ||
        h.startsWith("169.254.") ||
        h.endsWith(".local") ||
        h.endsWith(".internal")
      ) {
        errors.push("url must not point to private or internal networks");
      }
    } catch {
      errors.push("url is not a valid URL");
    }
  }

  // ── Required: headline ──
  const headline = typeof raw.headline === "string" ? raw.headline.trim() : "";
  if (!headline || headline.length > 2000) {
    errors.push("headline is required (1-2000 chars)");
  }

  // ── Optional: content ──
  const rawContent = raw.content && typeof raw.content === "object"
    ? raw.content as Record<string, unknown>
    : {};
  const lang = typeof rawContent.lang === "string" ? rawContent.lang.trim() : "und";
  let excerptText = typeof rawContent.excerpt_text === "string"
    ? rawContent.excerpt_text.trim()
    : "";
  if (excerptText.length > 500) {
    excerptText = excerptText.slice(0, 500);
  }

  // ── Optional: risk (publisher-provided, never computed by DiffDelta) ──
  let riskScore = 0;
  let riskReasons: string[] = [];
  if (raw.risk && typeof raw.risk === "object") {
    const rawRisk = raw.risk as Record<string, unknown>;
    if (typeof rawRisk.score === "number") {
      riskScore = Math.max(0, Math.min(1, rawRisk.score));
    }
    if (Array.isArray(rawRisk.reasons)) {
      riskReasons = rawRisk.reasons
        .filter((r): r is string => typeof r === "string" && RISK_REASON_RE.test(r))
        .slice(0, 10);
    }
  }

  // ── Auto-fill timestamps ──
  const publishedAt = typeof raw.published_at === "string" ? raw.published_at : now;
  const updatedAt = typeof raw.updated_at === "string" ? raw.updated_at : now;

  // ── Auto-fill provenance ──
  let provenance: AgentFeedItem["provenance"];
  if (raw.provenance && typeof raw.provenance === "object") {
    const rawProv = raw.provenance as Record<string, unknown>;
    const fetchedAt = typeof rawProv.fetched_at === "string" ? rawProv.fetched_at : now;
    const evidenceUrls = Array.isArray(rawProv.evidence_urls)
      ? rawProv.evidence_urls.filter((u): u is string => typeof u === "string").slice(0, 20)
      : [url];
    const contentHash = typeof rawProv.content_hash === "string" && CONTENT_HASH_RE.test(rawProv.content_hash)
      ? rawProv.content_hash
      : await computeItemContentHash({ id, url, headline, content: { excerpt_text: excerptText } });

    provenance = { fetched_at: fetchedAt, evidence_urls: evidenceUrls, content_hash: contentHash };
  } else {
    provenance = {
      fetched_at: now,
      evidence_urls: url ? [url] : [],
      content_hash: await computeItemContentHash({ id, url, headline, content: { excerpt_text: excerptText } }),
    };
  }

  if (provenance.evidence_urls.length === 0) {
    errors.push("provenance.evidence_urls must have at least 1 URL");
  }

  // ── Size check ──
  const item: AgentFeedItem = {
    id,
    url,
    headline,
    published_at: publishedAt,
    updated_at: updatedAt,
    content: { lang, excerpt_text: excerptText || undefined },
    risk: riskScore > 0 || riskReasons.length > 0
      ? { score: riskScore, reasons: riskReasons.length > 0 ? riskReasons : undefined }
      : undefined,
    provenance,
    source: sourceId,
  };

  const itemBytes = new TextEncoder().encode(JSON.stringify(item)).length;
  if (itemBytes > limits.max_item_bytes) {
    errors.push(`Item exceeds max size (${itemBytes} bytes > ${limits.max_item_bytes} limit)`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [], item };
}

/**
 * Validate a feed source_id format.
 */
export function isValidSourceId(sourceId: string): boolean {
  return SOURCE_ID_RE.test(sourceId);
}

/**
 * Validate tag format.
 */
export function isValidTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

/**
 * Slugify a name into a source_id component.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}
