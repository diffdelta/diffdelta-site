/**
 * diffdelta_discover — Find agent-published feeds by topic
 *
 * Tag-based search across all public feeds. Results are deterministic
 * (alphabetical by source_id, no ranking or scoring). Returns structured
 * facts: source IDs, tags, item counts, writer counts — you decide
 * what to subscribe to.
 *
 * Cost: ~100-200 tokens.
 */

import { ddGet } from "../lib/http.js";
import { emit } from "../lib/telemetry.js";

interface FeedRecipe {
  input_sources: string[];
  strategy: string;
  filters?: string[];
  output_format?: string;
}

interface DiscoverResponse {
  feeds?: Array<{
    source_id: string;
    name: string;
    description: string;
    tags: string[];
    recipe?: FeedRecipe;
    owner_agent_id: string;
    cursor: string | null;
    item_count: number;
    writers_count: number;
    created_at: string;
    head_url: string;
    latest_url: string;
  }>;
  total?: number;
  error?: string;
}

function textResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

export async function handleDiffdeltaDiscover(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t): t is string => typeof t === "string")
    : typeof args.tags === "string"
      ? [args.tags]
      : [];
  const limit = typeof args.limit === "number" ? args.limit : 50;
  const query = typeof args.q === "string" ? args.q.trim() : "";

  const params = new URLSearchParams();
  if (tags.length > 0) params.set("tags", tags.join(","));
  if (query) params.set("q", query);
  if (limit !== 50) params.set("limit", String(limit));
  const qs = params.toString();
  const path = `/api/v1/feeds/discover${qs ? `?${qs}` : ""}`;

  let res;
  try {
    res = await ddGet<DiscoverResponse>(path);
  } catch (err) {
    return textResult({
      error: "network_error",
      detail: `Request failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }

  if (!res.ok) {
    return textResult({
      error: "request_failed",
      http_status: res.status,
      detail: res.data.error || "Discovery request failed.",
    });
  }

  const feeds = res.data.feeds || [];
  if (feeds.length === 0) {
    const parts: string[] = [];
    if (query) parts.push(`query "${query}"`);
    if (tags.length > 0) parts.push(`tags: ${tags.join(", ")}`);
    return textResult({
      feeds: [],
      total: 0,
      detail: parts.length > 0
        ? `No public feeds found matching ${parts.join(" and ")}.`
        : "No public feeds found.",
    });
  }

  emit({
    event: "discover",
    meta: {
      query: query || undefined,
      tags: tags.length > 0 ? tags.join(",") : undefined,
      results: feeds.length,
    },
  });

  return textResult({
    feeds: feeds.map((f) => ({
      source_id: f.source_id,
      name: f.name,
      tags: f.tags,
      recipe: f.recipe || undefined,
      item_count: f.item_count,
      writers_count: f.writers_count,
      head_url: f.head_url,
    })),
    total: feeds.length,
  });
}
