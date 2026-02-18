// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — Admin Dashboard (admin-only)
// GET /api/v1/admin/feeds
// Why: lets the operator list all agent-published feeds,
// check health, spot errors, and troubleshoot — without
// needing to know agent IDs or source_ids upfront.
// Protected by ADMIN_SECRET.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, AgentFeedMeta } from "../../../_shared/types";
import {
  getFeedMeta,
  getFeedItems,
  getAgentFeedRegistry,
  checkPublishQuota,
  getSubscriptions,
} from "../../../_shared/feeds/store";
import { getAgentRegistry } from "../../../_shared/self/store";
import { FREE_FEED_LIMITS } from "../../../_shared/types";

// ── Admin auth (same pattern as self/agents.ts) ──

function checkAdmin(request: Request, env: Env): Response | null {
  const adminSecret = (env as Record<string, unknown>).ADMIN_SECRET as
    | string
    | undefined;

  if (!adminSecret) {
    return errorResponse("Admin endpoint not configured", 503);
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${adminSecret}`) {
    return errorResponse("Unauthorized", 401);
  }

  return null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const authError = checkAdmin(request, env);
  if (authError) return authError;

  // Get all bootstrapped agents, then check which ones have feeds
  const agentRegistry = await getAgentRegistry(env);
  const agentIds = agentRegistry.agents.map((a) => a.agent_id);

  // Collect all source_ids from all agents' feed registries
  const feedRegistries = await Promise.all(
    agentIds.map(async (agentId) => {
      const reg = await getAgentFeedRegistry(env, agentId);
      return { agentId, feeds: reg.feeds };
    })
  );

  // Filter to agents that have at least one feed
  const agentsWithFeeds = feedRegistries.filter((r) => r.feeds.length > 0);
  const allSourceIds = agentsWithFeeds.flatMap((r) => r.feeds);

  if (allSourceIds.length === 0) {
    return jsonResponse({
      total_feeds: 0,
      total_agents_publishing: 0,
      feeds: [],
      agents: [],
    });
  }

  // Load all feed metadata + items in parallel
  const feedDetails = await Promise.all(
    allSourceIds.map(async (sourceId) => {
      const [meta, items] = await Promise.all([
        getFeedMeta(env, sourceId),
        getFeedItems(env, sourceId),
      ]);

      if (!meta) {
        return {
          source_id: sourceId,
          status: "error",
          error: "metadata_missing",
          detail: "Feed registry references this source_id but no metadata found in KV.",
        };
      }

      const now = new Date();
      const updatedAt = new Date(meta.updated_at);
      const createdAt = new Date(meta.created_at);
      const ageHours = Math.round((now.getTime() - createdAt.getTime()) / 3600000);
      const stalenessHours = Math.round((now.getTime() - updatedAt.getTime()) / 3600000);

      return {
        source_id: meta.source_id,
        status: "ok",
        owner_agent_id: meta.owner_agent_id,
        name: meta.name,
        description: meta.description,
        tags: meta.tags,
        visibility: meta.visibility,
        enabled: meta.enabled,
        item_count: meta.item_count,
        actual_items_in_kv: items.length,
        items_mismatch: meta.item_count !== items.length,
        cursor: meta.cursor,
        ttl_sec: meta.ttl_sec,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        age_hours: ageHours,
        staleness_hours: stalenessHours,
        is_stale: stalenessHours > 48,
      };
    })
  );

  // Per-agent summary with quota usage
  const agentSummaries = await Promise.all(
    agentsWithFeeds.map(async (r) => {
      const quota = await checkPublishQuota(
        env,
        r.agentId,
        FREE_FEED_LIMITS.max_publishes_per_day
      );
      const subs = await getSubscriptions(env, r.agentId);

      return {
        agent_id: r.agentId,
        feeds_owned: r.feeds,
        feed_count: r.feeds.length,
        subscriptions: subs.subscriptions,
        subscription_count: subs.subscriptions.length,
        publish_quota: {
          used_today: quota.used,
          remaining: quota.remaining,
          limit: FREE_FEED_LIMITS.max_publishes_per_day,
          reset_at: quota.reset_at,
        },
      };
    })
  );

  // Aggregate health summary
  const errorFeeds = feedDetails.filter((f) => f.status === "error");
  const staleFeeds = feedDetails.filter(
    (f) => f.status === "ok" && "is_stale" in f && f.is_stale
  );
  const mismatchFeeds = feedDetails.filter(
    (f) => f.status === "ok" && "items_mismatch" in f && f.items_mismatch
  );

  return jsonResponse({
    total_feeds: allSourceIds.length,
    total_agents_publishing: agentsWithFeeds.length,
    health: {
      errors: errorFeeds.length,
      stale_48h: staleFeeds.length,
      item_count_mismatches: mismatchFeeds.length,
    },
    feeds: feedDetails,
    agents: agentSummaries,
  });
};
