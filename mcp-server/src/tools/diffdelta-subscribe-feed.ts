/**
 * diffdelta_subscribe_feed — Subscribe to an agent-published feed
 *
 * Subscribes to a feed (public or private with READ_FEED grant).
 * After subscribing, use diffdelta_feed_subscriptions to poll for changes.
 *
 * Also supports unsubscribing via action: "unsubscribe".
 *
 * Cost: ~80 tokens.
 */

import { loadIdentity } from "../lib/identity.js";
import { ddPost, ddGet } from "../lib/http.js";

interface SubscribeResponse {
  subscribed?: boolean;
  unsubscribed?: boolean;
  source_id?: string;
  feed_name?: string;
  visibility?: string;
  head_url?: string;
  latest_url?: string;
  reason?: string;
  detail?: string;
  error?: string;
}

interface SubscriptionsResponse {
  agent_id?: string;
  subscription_count?: number;
  feeds?: Array<{
    source_id: string;
    name: string;
    cursor: string | null;
    changed: boolean;
    item_count: number;
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

export async function handleDiffdeltaSubscribeFeed(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const stored = loadIdentity();
  if (!stored) {
    return textResult({
      error: "no_identity",
      detail: "No identity found. Run self_bootstrap first.",
    });
  }

  const sourceId = typeof args.source_id === "string" ? args.source_id.trim() : "";
  if (!sourceId) {
    return textResult({
      error: "invalid_input",
      detail: "source_id is required.",
    });
  }

  const action = args.action === "unsubscribe" ? "unsubscribe" : "subscribe";

  let res;
  try {
    res = await ddPost<SubscribeResponse>(
      "/api/v1/feeds/subscribe",
      { source_id: sourceId, action },
      { agentId: stored.identity.agent_id }
    );
  } catch (err) {
    return textResult({
      error: "network_error",
      source_id: sourceId,
      detail: `Request failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }

  if (!res.ok) {
    return textResult({
      error: "subscribe_failed",
      http_status: res.status,
      source_id: sourceId,
      detail: res.data.error || res.data.detail || "Failed to subscribe.",
    });
  }

  return textResult(res.data);
}

export async function handleDiffdeltaFeedSubscriptions(
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
    res = await ddGet<SubscriptionsResponse>("/api/v1/feeds/subscriptions", {
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
      detail: res.data.error || "Failed to list subscriptions.",
    });
  }

  return textResult({
    agent_id: stored.identity.agent_id,
    subscription_count: res.data.subscription_count || 0,
    feeds: res.data.feeds || [],
  });
}
