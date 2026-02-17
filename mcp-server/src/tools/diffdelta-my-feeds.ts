/**
 * diffdelta_my_feeds — List feeds owned by this agent
 *
 * Calls GET /api/v1/feeds/mine with the agent's X-Self-Agent-Id.
 * Returns metadata for each owned feed: name, cursor, item count, URLs.
 *
 * Cost: ~100-200 tokens depending on feed count.
 */

import { loadIdentity } from "../lib/identity.js";
import { ddGet } from "../lib/http.js";

interface MyFeedsResponse {
  agent_id?: string;
  feed_count?: number;
  feeds?: Array<{
    source_id: string;
    name: string;
    description: string;
    tags: string[];
    item_count: number;
    cursor: string | null;
    visibility: string;
    ttl_sec: number;
    created_at: string;
    updated_at: string;
    head_url: string;
    latest_url: string;
  }>;
  error?: string;
}

function textResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

export async function handleDiffdeltaMyFeeds(
  _args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const stored = loadIdentity();
  if (!stored) {
    return textResult({
      error: "no_identity",
      detail: "No identity found. Run self_bootstrap first.",
    });
  }

  let res;
  try {
    res = await ddGet<MyFeedsResponse>("/api/v1/feeds/mine", {
      agentId: stored.identity.agent_id,
    });
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
      detail: res.data.error || "Failed to list feeds.",
    });
  }

  return textResult({
    agent_id: stored.identity.agent_id,
    feed_count: res.data.feed_count || 0,
    feeds: res.data.feeds || [],
  });
}
