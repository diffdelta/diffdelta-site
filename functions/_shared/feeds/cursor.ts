// Canonical cursor computation for agent-published feeds.
// Why: reuses canonical_v1 algorithm from the feed spec so agent feeds
// produce identical cursor semantics to curated feeds.

import { sha256Hex } from "../self/crypto";
import { canonicalJson } from "../self/canonical";
import type { AgentFeedItem } from "../types";

/**
 * Compute a deterministic cursor from a set of feed items.
 *
 * Algorithm (canonical_v1):
 * 1. Build (source, id, content_hash) tuples from all items.
 * 2. Sort lexicographically.
 * 3. Prepend sources_included (sorted, deduplicated).
 * 4. cursor = "sha256:" + hex(SHA-256(canonical_json(payload)))
 *
 * This matches the feed spec §3.1 — cursor changes if and only if
 * semantic content changes.
 */
export async function computeFeedCursor(
  items: AgentFeedItem[],
  sourcesIncluded: string[]
): Promise<string> {
  // Build canonical tuples
  const tuples = items.map((item) => ({
    source: item.source,
    id: item.id,
    content_hash: item.provenance.content_hash,
  }));

  // Sort lexicographically by (source, id, content_hash)
  tuples.sort((a, b) => {
    const s = a.source.localeCompare(b.source);
    if (s !== 0) return s;
    const i = a.id.localeCompare(b.id);
    if (i !== 0) return i;
    return a.content_hash.localeCompare(b.content_hash);
  });

  // Build canonical payload
  const payload = {
    sources_included: [...sourcesIncluded].sort(),
    items: tuples,
  };

  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const hex = await sha256Hex(bytes);
  return `sha256:${hex}`;
}

/**
 * Compute the content_hash for a single item (SHA-256 of its content fields).
 * Used when the publisher does not provide a content_hash.
 */
export async function computeItemContentHash(item: {
  id: string;
  url: string;
  headline: string;
  content?: { excerpt_text?: string };
}): Promise<string> {
  const payload = {
    id: item.id,
    url: item.url,
    headline: item.headline,
    excerpt_text: item.content?.excerpt_text || "",
  };
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const hex = await sha256Hex(bytes);
  return `sha256:${hex}`;
}
