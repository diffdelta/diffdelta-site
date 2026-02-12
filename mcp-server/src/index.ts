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
import { handleDiffdeltaCheck } from "./tools/diffdelta-check.js";
import { handleDiffdeltaPoll } from "./tools/diffdelta-poll.js";
import { handleDiffdeltaListSources } from "./tools/diffdelta-list-sources.js";

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
    "Discover all available DiffDelta feed sources.",
    "",
    "Returns a list of feeds with metadata: source ID, name, tags,",
    "and feed URL. Use this to discover what you can monitor before",
    "calling diffdelta_check or diffdelta_poll.",
    "",
    "Optionally filter by tag (e.g. 'security', 'infrastructure').",
    "Costs ~200 tokens. Call once and cache — sources change rarely.",
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
// Start — stdio transport
// ─────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
