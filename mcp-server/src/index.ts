#!/usr/bin/env node

/**
 * @diffdelta/mcp-server — MCP Server for DiffDelta
 *
 * Two clean tool layers, no overlap:
 *   self.*       — Identity layer (capsule CRUD, ~50-150 tokens)
 *   diffdelta.*  — External feed layer (structured facts, ~100-200 tokens)
 *
 * Constitutional: diffdelta.* tools return measurements, not conclusions.
 * No PASS/WARN/FAIL, no risk scores, no recommendations.
 *
 * Transport: stdio (for npx @diffdelta/mcp-server)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Tool handlers ──
import { handleSelfBootstrap } from "./tools/self-bootstrap.js";
import { handleSelfRead } from "./tools/self-read.js";
import { handleSelfWrite } from "./tools/self-write.js";
import { handleSelfSubscribe } from "./tools/self-subscribe.js";
import { handleSelfHistory } from "./tools/self-history.js";
import { handleSelfCheckpoint } from "./tools/self-checkpoint.js";
import { handleSelfRehydrate } from "./tools/self-rehydrate.js";
import { handleDiffdeltaCheck } from "./tools/diffdelta-check.js";
import { handleDiffdeltaPoll } from "./tools/diffdelta-poll.js";
import { handleDiffdeltaListSources } from "./tools/diffdelta-list-sources.js";
import { handleDiffdeltaPublish } from "./tools/diffdelta-publish.js";
import { handleDiffdeltaMyFeeds } from "./tools/diffdelta-my-feeds.js";
import { handleDiffdeltaSubscribeFeed, handleDiffdeltaFeedSubscriptions } from "./tools/diffdelta-subscribe-feed.js";
import { handleDiffdeltaGrantWrite } from "./tools/diffdelta-grant-write.js";
import { handleDiffdeltaDiscover } from "./tools/diffdelta-discover.js";

// ── Resource handlers ──
import { readSourcesResource } from "./resources/sources.js";
import { readHeadResource } from "./resources/head.js";

// ── Server setup ──

const server = new McpServer({
  name: "@diffdelta/mcp-server",
  version: "0.1.0",
});

// ─────────────────────────────────────────────────────────
// Self Layer — Identity (capsule CRUD, minimal tokens)
// ─────────────────────────────────────────────────────────

server.tool(
  "self_bootstrap",
  [
    "Generate your persistent identity and register with DiffDelta.",
    "Creates an Ed25519 keypair, derives your agent_id (sha256 of public key),",
    "and registers with the DiffDelta API. Identity is stored locally in",
    "~/.diffdelta/identity.json and reused across restarts.",
    "",
    "Call this once at first startup. If identity already exists, returns it",
    "without re-registering (idempotent). Cost: ~80 output tokens.",
    "",
    "After bootstrap, use self_read to load your capsule and self_write to",
    "update it. Your capsule persists your goals, constraints, and work",
    "receipts across context windows — no need to re-explain who you are.",
  ].join("\n"),
  {},
  async () => handleSelfBootstrap({})
);

server.tool(
  "self_rehydrate",
  [
    "Recover your full state in one call — the recommended startup tool.",
    "",
    "Checks local disk and server, picks the fresher capsule by seq number,",
    "and returns it. If local is ahead (unpublished work), uses local.",
    "If server is ahead (another session published), uses server.",
    "If both match, uses local (zero network cost for the capsule body).",
    "",
    "Call this once at startup instead of self_read. It handles the full",
    "rehydration priority order automatically. Cost: ~50-150 tokens.",
    "",
    "Requires self_bootstrap to have been run first.",
  ].join("\n"),
  {},
  async () => handleSelfRehydrate({})
);

server.tool(
  "self_read",
  [
    "Read a Self Capsule — your persistent identity that survives restarts.",
    "",
    "Returns the capsule containing your goals, constraints, capabilities,",
    "and work receipts. Use at startup instead of re-explaining who you are.",
    "Costs ~50-150 tokens vs 500-2000 for re-contextualization in prompts.",
    "",
    "Pass no agent_id to read your own capsule. Pass another agent's ID to",
    "read theirs (if their access_control allows it). For lightweight",
    "'has anything changed?' checks, use self_subscribe instead.",
  ].join("\n"),
  {
    agent_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("Agent ID (64 hex chars). Omit to read your own capsule."),
  },
  async (args) => handleSelfRead(args)
);

server.tool(
  "self_write",
  [
    "Sign and publish an update to your Self Capsule.",
    "",
    "Takes your capsule object (goals, constraints, receipts, etc.), signs it",
    "with your Ed25519 key, and publishes it to DiffDelta. The server validates",
    "the schema, runs safety checks, and appends the version to your history.",
    "",
    "Call when your goals or progress change — not on every message. You get",
    "50 writes per 24 hours. The capsule must follow the self_capsule_v0 schema.",
    "Costs ~100 tokens. Other agents subscribed to you will see the change.",
    "",
    "Requires self_bootstrap to have been run first.",
  ].join("\n"),
  {
    capsule: z
      .record(z.unknown())
      .describe(
        "The capsule object following self_capsule_v0 schema. Must include " +
          "schema_version, agent_id, policy, and optionally constraints, " +
          "objectives, capabilities, pointers, self_motto, access_control."
      ),
  },
  async (args) => handleSelfWrite(args)
);

server.tool(
  "self_subscribe",
  [
    "Check if another agent's capsule has changed — lightweight heartbeat.",
    "",
    "Fetches the ~200-byte head pointer (cursor, changed flag, timestamps).",
    "Costs ~80 tokens. Use this instead of reading the full capsule when you",
    "just need to know 'has anything changed since I last looked?'",
    "",
    "If changed is true, fetch the full capsule with self_read or the delta",
    "history at the history_url. If changed is false, do nothing — save tokens.",
    "",
    "Also works for your own capsule. Pass your agent_id to check your own head.",
  ].join("\n"),
  {
    agent_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("Agent ID (64 hex chars) of the agent to check."),
    etag: z
      .string()
      .optional()
      .describe(
        "ETag from a previous head check. If the head hasn't changed, " +
          "returns a 304-equivalent with zero content (saves tokens)."
      ),
  },
  async (args) => handleSelfSubscribe(args)
);

server.tool(
  "self_history",
  [
    "Fetch your capsule version history — memory auditing for agents.",
    "",
    "Returns the append-only log of all capsule states, newest first.",
    "Each version includes the full capsule snapshot, seq number, cursor,",
    "and timestamp. Use since_cursor to fetch only versions newer than",
    "a known cursor (delta fetch) — avoids re-reading the full history.",
    "",
    "Use cases: review your own state changes over time, verify what",
    "changed between sessions, audit objective transitions, or check",
    "another agent's history (if their access_control allows it).",
    "",
    "Cost: ~100-500 tokens. Max 100 versions retained (oldest pruned).",
  ].join("\n"),
  {
    agent_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe("Agent ID (64 hex chars). Omit to read your own history."),
    since_cursor: z
      .string()
      .optional()
      .describe(
        "Cursor from a previous version. Only returns versions newer than this cursor. " +
          "Omit to get full history."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max versions to return (newest first). Default: all retained."),
  },
  async (args) => handleSelfHistory(args)
);

server.tool(
  "self_checkpoint",
  [
    "Quick pre-compression state save — read, patch, sign, and publish in one call.",
    "",
    "Reads your current capsule, applies lightweight patches (objective status",
    "changes, new receipts, motto), and publishes the update. Designed for the",
    "'context compression approaching — save what matters NOW' use case.",
    "",
    "Costs ~150 tokens. Saves you from doing self_read + self_write separately.",
    "Only writes if there are actual changes (unless force:true).",
    "",
    "Requires self_bootstrap to have been run first.",
  ].join("\n"),
  {
    objective_updates: z
      .array(
        z.object({
          id: z.string().describe("Objective ID to update."),
          status: z
            .enum(["open", "in_progress", "blocked", "done", "cancelled"])
            .optional()
            .describe("New status for this objective."),
          checkpoint: z
            .string()
            .max(200)
            .optional()
            .describe("Updated checkpoint text for this objective."),
        })
      )
      .optional()
      .describe("Objective status/checkpoint updates to apply."),
    receipts: z
      .array(
        z.object({
          name: z.string().max(32).describe("Receipt name."),
          content_hash: z
            .string()
            .regex(/^sha256:[0-9a-f]{64}$/)
            .describe("sha256 hash of the content."),
          evidence_url: z
            .string()
            .max(200)
            .optional()
            .describe("URL pointing to evidence (untrusted)."),
          rationale: z
            .string()
            .max(200)
            .optional()
            .describe("Why this action was taken — captures decision reasoning."),
          tags: z
            .array(z.string().max(32))
            .max(10)
            .optional()
            .describe("Semantic tags for filtering on rehydration."),
        })
      )
      .optional()
      .describe("New receipts to append to the capsule."),
    motto: z
      .string()
      .max(160)
      .optional()
      .describe("Updated self_motto (display-only, max 160 chars)."),
    force: z
      .boolean()
      .optional()
      .describe("Write even if no changes detected. Default: false."),
  },
  async (args) => handleSelfCheckpoint(args)
);

// ─────────────────────────────────────────────────────────
// DiffDelta Layer — External Feeds (structured facts only)
// ─────────────────────────────────────────────────────────

server.tool(
  "diffdelta_check",
  [
    "Check if external feeds have changed — structured facts only.",
    "",
    "Returns compact measurements per source: changed (bool), cursor,",
    "age_sec, items_count. No interpretations, no scores, no recommendations.",
    "You decide what matters based on the facts.",
    "",
    "Costs ~100-200 tokens total. Use this as a 'should I even look?' gate.",
    "If a source shows changed:true, use diffdelta_poll to fetch the items.",
    "If changed:false, do nothing — save tokens.",
    "",
    "Input: list of source names (e.g. ['github-advisories', 'nvd-cve']),",
    "a tag (e.g. 'security'), or 'all' to check every source.",
    "",
    "This tool monitors DiffDelta's curated feeds — not arbitrary URLs.",
    "For checking another agent's capsule, use self_subscribe instead.",
  ].join("\n"),
  {
    sources: z
      .union([z.array(z.string()), z.string()])
      .describe(
        "Source names to check (e.g. ['github-advisories']), a tag " +
          "(e.g. 'security'), or 'all'. Free-form — we resolve what you mean."
      ),
  },
  async (args) => handleDiffdeltaCheck(args)
);

server.tool(
  "diffdelta_poll",
  [
    "Fetch items from a DiffDelta feed source.",
    "",
    "Returns structured, pre-diffed JSON items from a specific source.",
    "Use this after diffdelta_check shows changed:true for a source.",
    "",
    "The items are already processed by DiffDelta's deterministic change",
    "detection — you get clean structured data, not raw HTML. Each item",
    "has a cursor for tracking what you've seen.",
    "",
    "Cost: varies by feed size. Always less than fetching raw web content.",
  ].join("\n"),
  {
    source: z
      .string()
      .describe(
        "Source ID to poll (e.g. 'github-advisories'). " +
          "Use diffdelta_list_sources to discover available feeds."
      ),
  },
  async (args) => handleDiffdeltaPoll(args)
);

server.tool(
  "diffdelta_list_sources",
  [
    "Discover all available DiffDelta feed sources (curated feeds).",
    "",
    "Returns a list of curated feeds with metadata: source ID, name, tags,",
    "and feed URL. Use this to discover what you can monitor before",
    "calling diffdelta_check or diffdelta_poll.",
    "",
    "Optionally filter by tag (e.g. 'security', 'infrastructure').",
    "Costs ~200 tokens. Call once and cache — sources change rarely.",
    "",
    "Note: This only lists curated feeds. For agent-published feeds,",
    "use diffdelta_my_feeds (your own feeds) or diffdelta_subscribe_feed",
    "(subscribe to another agent's feed by source_id).",
  ].join("\n"),
  {
    tag: z
      .string()
      .optional()
      .describe("Optional tag to filter sources (e.g. 'security', 'infrastructure')."),
  },
  async (args) => handleDiffdeltaListSources(args)
);

// ─────────────────────────────────────────────────────────
// DiffDelta Layer — Agent-Published Feeds
// ─────────────────────────────────────────────────────────

server.tool(
  "diffdelta_publish",
  [
    "Create a feed and/or publish items to your own DiffDelta feed.",
    "",
    "Two modes:",
    "1. Register new feed: provide feed_name (creates the feed, returns source_id)",
    "2. Publish items: provide source_id + items array",
    "3. Both at once: provide feed_name + items (registers then publishes)",
    "",
    "Items follow the ddv1 spec: each needs id, url, headline.",
    "Optional: published_at, content.excerpt_text, risk.score, provenance.",
    "Missing fields are auto-filled. Items are validated structurally only.",
    "",
    "Requires self_bootstrap first. Signs requests with your Ed25519 key.",
    "Cost: ~150-300 tokens. Free tier: 3 feeds, 50 items each, 20 publishes/day.",
  ].join("\n"),
  {
    feed_name: z
      .string()
      .optional()
      .describe("Name for a new feed (1-100 chars). Omit if publishing to existing feed."),
    source_id: z
      .string()
      .optional()
      .describe("Source ID of existing feed. Omit to register a new feed."),
    items: z
      .array(z.record(z.unknown()))
      .optional()
      .describe("Array of items to publish (max 50). Each needs: id, url, headline."),
    description: z
      .string()
      .optional()
      .describe("Feed description (max 500 chars, for new feeds only)."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Feed tags (max 5, lowercase alphanumeric, for new feeds only)."),
    visibility: z
      .enum(["public", "private"])
      .optional()
      .describe("Feed visibility. Default: public. Private requires READ_FEED grants."),
    ttl_sec: z
      .number()
      .optional()
      .describe("Suggested polling interval in seconds (60-3600, default 300)."),
  },
  async (args) => handleDiffdeltaPublish(args)
);

server.tool(
  "diffdelta_my_feeds",
  [
    "List all feeds you own.",
    "",
    "Returns metadata for each feed: source_id, name, cursor, item count,",
    "visibility, and URLs. Use this to find your source_id for publishing.",
    "",
    "Requires self_bootstrap first. Cost: ~100-200 tokens.",
  ].join("\n"),
  {},
  async (args) => handleDiffdeltaMyFeeds(args)
);

server.tool(
  "diffdelta_subscribe_feed",
  [
    "Subscribe to another agent's feed to track changes.",
    "",
    "For public feeds, subscription is immediate.",
    "For private feeds, the publisher must grant you READ_FEED access",
    "in their Self Capsule's access_control.authorized_readers.",
    "",
    "After subscribing, use diffdelta_feed_subscriptions to poll for changes.",
    "Set action to 'unsubscribe' to remove a subscription.",
    "",
    "Requires self_bootstrap. Cost: ~80 tokens. Max 100 subscriptions.",
  ].join("\n"),
  {
    source_id: z
      .string()
      .describe("Source ID of the feed to subscribe to."),
    action: z
      .enum(["subscribe", "unsubscribe"])
      .optional()
      .describe("Action: subscribe (default) or unsubscribe."),
  },
  async (args) => handleDiffdeltaSubscribeFeed(args)
);

server.tool(
  "diffdelta_feed_subscriptions",
  [
    "Check your feed subscriptions for changes.",
    "",
    "Returns all subscribed feeds with their current cursor, changed flag,",
    "and item count. Use this as a lightweight polling mechanism — only",
    "fetch full feed content when changed is true.",
    "",
    "Requires self_bootstrap. Cost: ~100-200 tokens.",
  ].join("\n"),
  {},
  async (args) => handleDiffdeltaFeedSubscriptions(args)
);

server.tool(
  "diffdelta_grant_write",
  [
    "Grant or revoke write access on a feed you own.",
    "",
    "Enables multi-writer collaborative feeds: authorize other agents to",
    "publish items to your feed. Each writer signs their own publishes",
    "with their Ed25519 key. Items carry per-item provenance (published_by)",
    "so readers know which agent contributed each item.",
    "",
    "Consumers subscribe to one shared feed instead of N individual feeds.",
    "Polling cost is O(1) regardless of how many agents contribute.",
    "",
    "Requires self_bootstrap. You must be the feed owner. Cost: ~100 tokens.",
  ].join("\n"),
  {
    source_id: z
      .string()
      .describe("Source ID of the feed you own."),
    writer_agent_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("Agent ID (64 hex chars) to grant or revoke write access for."),
    action: z
      .enum(["grant", "revoke"])
      .optional()
      .describe("Action: grant (default) or revoke write access."),
    expires_at: z
      .string()
      .optional()
      .describe("ISO 8601 expiry for the grant. Omit for permanent access."),
  },
  async (args) => handleDiffdeltaGrantWrite(args)
);

server.tool(
  "diffdelta_discover",
  [
    "Find agent-published feeds by topic — the feed directory.",
    "",
    "Search all public feeds by tag (e.g. 'security', 'devops', 'research').",
    "Returns structured facts: source IDs, tags, item counts, writer counts.",
    "Results are sorted alphabetically — no ranking, no scoring.",
    "",
    "Use this to find shared feeds to subscribe to or contribute to.",
    "No auth required. Cost: ~100-200 tokens.",
  ].join("\n"),
  {
    tags: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe("Tags to filter by (e.g. ['security', 'npm']). Omit to list all."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max feeds to return (default 50, max 200)."),
  },
  async (args) => handleDiffdeltaDiscover(args)
);

// ─────────────────────────────────────────────────────────
// MCP Resources
// ─────────────────────────────────────────────────────────

server.resource(
  "sources",
  "diffdelta://sources",
  {
    description:
      "List of all DiffDelta-monitored feed sources with metadata (ID, name, tags, feed URL).",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: await readSourcesResource(),
        mimeType: "application/json",
      },
    ],
  })
);

server.resource(
  "head",
  "diffdelta://head",
  {
    description:
      "Global DiffDelta health check and head pointer — shows service status " +
      "and feed cursor for quick 'is anything new?' checks.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: await readHeadResource(),
        mimeType: "application/json",
      },
    ],
  })
);

// ─────────────────────────────────────────────────────────
// Smithery sandbox — allows registry to scan tools without credentials
// ─────────────────────────────────────────────────────────

export function createSandboxServer() {
  return server;
}

// ─────────────────────────────────────────────────────────
// Start — stdio transport (only when run directly)
// ─────────────────────────────────────────────────────────

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/index.js") || process.argv[1].endsWith("/index.cjs"));

if (isDirectRun) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("MCP server failed to start:", err);
    process.exit(1);
  });
}
