// ─────────────────────────────────────────────────────────
// DiffDelta — Source Probe
// Why: Lets users paste a URL and preview its schema before
// creating a custom source. Detects adapter type (RSS/JSON),
// extracts sample fields, and suggests title/content mappings.
// POST /api/v1/sources/probe  { url: string }
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import type { AuthResult } from "../../../_shared/auth";

// Fields commonly used as "title" or "content" in upstream APIs
const TITLE_CANDIDATES = ["title", "name", "headline", "subject", "label", "summary", "model_name"];
const CONTENT_CANDIDATES = ["body", "content", "description", "text", "message", "detail", "abstract", "deprecation_context"];

// Private/reserved IP ranges (SSRF protection)
function isPrivateIP(ip: string): boolean {
  // IPv4 private ranges
  if (/^10\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^0\./.test(ip)) return true;
  // IPv6 loopback and link-local
  if (ip === "::1" || ip === "::") return true;
  if (/^fe80:/i.test(ip)) return true;
  if (/^fc00:/i.test(ip)) return true;
  if (/^fd/i.test(ip)) return true;
  return false;
}

interface ProbeRequest {
  url?: string;
}

interface FieldInfo {
  name: string;
  type: string;
  sample: unknown;
}

function truncateSample(val: unknown): unknown {
  if (typeof val === "string") return val.slice(0, 200);
  if (typeof val === "number" || typeof val === "boolean" || val === null) return val;
  if (Array.isArray(val)) return `[array, ${val.length} items]`;
  if (typeof val === "object") return "[object]";
  return String(val).slice(0, 100);
}

function extractFields(item: Record<string, unknown>): FieldInfo[] {
  return Object.entries(item).map(([key, val]) => ({
    name: key,
    type: val === null ? "null" : Array.isArray(val) ? "array" : typeof val,
    sample: truncateSample(val),
  }));
}

function suggestField(fields: FieldInfo[], candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fields.some((f) => f.name === candidate && f.type === "string")) {
      return candidate;
    }
  }
  return null;
}

// Detect JSON items key by finding the first top-level array of objects
function detectItemsKey(data: Record<string, unknown>): { key: string; items: unknown[] } | null {
  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
      return { key, items: val };
    }
  }
  return null;
}

function detectRSSFields(text: string): FieldInfo[] {
  // Extract field names from a sample RSS item
  const fields: FieldInfo[] = [];
  const itemMatch = text.match(/<item[^>]*>([\s\S]*?)<\/item>/i) ||
                    text.match(/<entry[^>]*>([\s\S]*?)<\/entry>/i);
  if (!itemMatch) return fields;

  const itemXml = itemMatch[1];
  const tagRegex = /<([a-zA-Z0-9:]+)[^>]*>([^<]*)<\/\1>/g;
  let match;
  const seen = new Set<string>();
  while ((match = tagRegex.exec(itemXml)) !== null) {
    const tagName = match[1].replace(/^[a-z]+:/i, ""); // strip namespace prefix
    if (!seen.has(tagName)) {
      seen.add(tagName);
      fields.push({
        name: tagName,
        type: "string",
        sample: match[2].slice(0, 200),
      });
    }
  }
  return fields;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const auth = (context.data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.authenticated) {
    return errorResponse("Authentication required", 401);
  }

  // ── Rate limit: 10 probes/day ──
  const dateKey = new Date().toISOString().slice(0, 10);
  const rlKey = `probe-rl:${auth.key_hash || "anon"}:${dateKey}`;
  const rlCount = parseInt((await env.KEYS.get(rlKey)) || "0", 10);
  if (rlCount >= 10) {
    return errorResponse("Probe rate limit reached (10/day). Try again tomorrow.", 429);
  }

  // ── Parse request ──
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > 4096) {
    return errorResponse("Request body too large", 413);
  }
  let body: ProbeRequest;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const urlStr = (body.url || "").trim();
  if (!urlStr) {
    return errorResponse("url is required", 400);
  }

  // ── Validate URL ──
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    return errorResponse("Invalid URL format", 400);
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return errorResponse("URL must use HTTP or HTTPS", 400);
  }

  // ── SSRF protection: block private IPs ──
  // Cloudflare Workers resolve DNS internally, but we can check the hostname
  // for obviously private patterns. The actual fetch goes through CF's network
  // which blocks private IPs at the infrastructure level.
  const hostname = parsedUrl.hostname;
  if (hostname === "localhost" || isPrivateIP(hostname)) {
    return errorResponse("Cannot probe private or local addresses", 400);
  }

  // ── Fetch the URL ──
  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    response = await fetch(parsedUrl.href, {
      signal: controller.signal,
      headers: {
        "User-Agent": "DiffDelta-Probe/1.0 (+https://diffdelta.com)",
        Accept: "application/json, application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    clearTimeout(timeout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return errorResponse(`Failed to fetch URL: ${msg}`, 502);
  }

  if (!response.ok) {
    return errorResponse(`URL returned HTTP ${response.status}`, 502);
  }

  // ── Read body with size cap (1MB) ──
  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  if (contentLength > 1_048_576) {
    return errorResponse("Response too large (>1MB)", 502);
  }
  let text: string;
  try {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > 1_048_576) {
      return errorResponse("Response too large (>1MB)", 502);
    }
    text = new TextDecoder().decode(buf);
  } catch {
    return errorResponse("Failed to read response body", 502);
  }

  // ── Increment rate limit AFTER successful fetch ──
  await env.KEYS.put(rlKey, String(rlCount + 1), { expirationTtl: 86400 });

  // ── Detect adapter type ──
  const contentType = response.headers.get("content-type") || "";
  const trimmed = text.trimStart();
  const isXml =
    contentType.includes("xml") ||
    contentType.includes("rss") ||
    contentType.includes("atom") ||
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<rss") ||
    trimmed.startsWith("<feed");

  if (isXml) {
    // RSS/Atom feed
    const fields = detectRSSFields(text);
    const itemCount = (text.match(/<item[\s>]/gi) || text.match(/<entry[\s>]/gi) || []).length;

    return jsonResponse({
      adapter: "rss",
      item_count: itemCount,
      fields,
      suggested_title_field: null,
      suggested_content_field: null,
      json_items_key: null,
    });
  }

  // Try JSON
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return errorResponse(
      "URL returned content that is neither valid JSON nor RSS/XML. DiffDelta supports JSON APIs and RSS/Atom feeds.",
      422
    );
  }

  // JSON: top-level array or object with nested array
  let items: unknown[] = [];
  let jsonItemsKey: string | null = null;

  if (Array.isArray(data)) {
    items = data;
  } else if (typeof data === "object" && data !== null) {
    const detected = detectItemsKey(data as Record<string, unknown>);
    if (detected) {
      jsonItemsKey = detected.key;
      items = detected.items;
    } else {
      return errorResponse(
        "JSON response has no array of items. Expected a top-level array or an object with an array field.",
        422
      );
    }
  }

  if (items.length === 0) {
    return errorResponse("URL returned an empty items array", 422);
  }

  const sampleItem = items[0] as Record<string, unknown>;
  if (typeof sampleItem !== "object" || sampleItem === null) {
    return errorResponse("Items are not objects — expected JSON objects with named fields", 422);
  }

  const fields = extractFields(sampleItem);

  return jsonResponse({
    adapter: "json",
    item_count: items.length,
    fields,
    suggested_title_field: suggestField(fields, TITLE_CANDIDATES),
    suggested_content_field: suggestField(fields, CONTENT_CANDIDATES),
    json_items_key: jsonItemsKey,
  });
};
