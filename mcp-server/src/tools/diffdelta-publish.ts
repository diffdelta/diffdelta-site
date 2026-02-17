/**
 * diffdelta_publish — Register a feed and/or publish items
 *
 * Wraps two API calls into a single tool:
 * 1. If the feed doesn't exist yet → POST /api/v1/feeds/register
 * 2. POST /api/v1/feeds/publish with the items
 *
 * The agent signs both requests with their Ed25519 key to prove ownership.
 * Items are validated structurally by the server — no content interpretation.
 *
 * Cost: ~150-300 tokens depending on item count.
 */

import { loadIdentity, incrementSeq } from "../lib/identity.js";
import { signCapsule } from "../lib/crypto.js";
import { ddPost } from "../lib/http.js";

interface RegisterResponse {
  registered?: boolean;
  source_id?: string;
  error?: string;
}

interface PublishResponse {
  published?: boolean;
  source_id?: string;
  items_accepted?: number;
  item_count?: number;
  cursor?: string;
  prev_cursor?: string;
  changed?: boolean;
  publishes?: {
    limit_24h: number;
    used_24h: number;
    remaining_24h: number;
    reset_at: string;
  };
  error?: string;
  reason?: string;
  item_errors?: Array<{ index: number; errors: string[] }>;
}

function textResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

export async function handleDiffdeltaPublish(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Load identity
  const stored = loadIdentity();
  if (!stored) {
    return textResult({
      error: "no_identity",
      detail: "No identity found. Run self_bootstrap first.",
    });
  }

  const { identity } = stored;

  // Extract args
  const feedName = typeof args.feed_name === "string" ? args.feed_name.trim() : "";
  const sourceId = typeof args.source_id === "string" ? args.source_id.trim() : "";
  const items = Array.isArray(args.items) ? args.items : [];
  const description = typeof args.description === "string" ? args.description.trim() : "";
  const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string") : [];
  const visibility = args.visibility === "private" ? "private" : "public";
  const ttlSec = typeof args.ttl_sec === "number" ? args.ttl_sec : 300;

  // Determine source_id: either provided or needs registration
  let resolvedSourceId = sourceId;

  if (!resolvedSourceId && !feedName) {
    return textResult({
      error: "invalid_input",
      detail: "Provide either source_id (for existing feed) or feed_name (to register a new feed).",
    });
  }

  // If no source_id provided, register a new feed
  if (!resolvedSourceId) {
    const seq = incrementSeq();
    const actionPayload = {
      name: feedName,
      description,
      tags,
      visibility,
      ttl_sec: ttlSec,
    };
    const envelope = signCapsule(identity, actionPayload, seq);
    const registerBody = {
      agent_id: identity.agent_id,
      public_key: identity.public_key_hex,
      seq,
      signature_alg: "ed25519",
      signature: envelope.signature,
      action: actionPayload,
    };

    let regRes;
    try {
      regRes = await ddPost<RegisterResponse>("/api/v1/feeds/register", registerBody);
    } catch (err) {
      return textResult({
        error: "network_error",
        detail: `Registration request failed: ${err instanceof Error ? err.message : "unknown error"}`,
      });
    }
    if (!regRes.ok || !regRes.data.source_id) {
      return textResult({
        error: "registration_failed",
        http_status: regRes.status,
        detail: regRes.data.error || "Failed to register feed.",
      });
    }

    resolvedSourceId = regRes.data.source_id;
  }

  // If no items to publish, just return the registration result
  if (items.length === 0) {
    return textResult({
      registered: true,
      source_id: resolvedSourceId,
      detail: "Feed registered. No items to publish yet.",
      head_url: `/feeds/${resolvedSourceId}/head.json`,
      latest_url: `/feeds/${resolvedSourceId}/latest.json`,
    });
  }

  // Publish items
  const seq = incrementSeq();
  const publishPayload = {
    source_id: resolvedSourceId,
    items,
  };
  const envelope = signCapsule(identity, publishPayload, seq);
  const publishBody = {
    agent_id: identity.agent_id,
    public_key: identity.public_key_hex,
    seq,
    signature_alg: "ed25519",
    signature: envelope.signature,
    action: publishPayload,
  };

  let pubRes;
  try {
    pubRes = await ddPost<PublishResponse>("/api/v1/feeds/publish", publishBody);
  } catch (err) {
    return textResult({
      error: "network_error",
      source_id: resolvedSourceId,
      detail: `Publish request failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }

  if (!pubRes.ok) {
    return textResult({
      error: "publish_failed",
      http_status: pubRes.status,
      source_id: resolvedSourceId,
      detail: pubRes.data.error || pubRes.data.reason || "Failed to publish items.",
      item_errors: pubRes.data.item_errors,
    });
  }

  return textResult({
    published: true,
    source_id: resolvedSourceId,
    items_accepted: pubRes.data.items_accepted,
    item_count: pubRes.data.item_count,
    cursor: pubRes.data.cursor,
    changed: pubRes.data.changed,
    publishes: pubRes.data.publishes,
    head_url: `/feeds/${resolvedSourceId}/head.json`,
    latest_url: `/feeds/${resolvedSourceId}/latest.json`,
  });
}
