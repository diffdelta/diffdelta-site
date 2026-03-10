#!/usr/bin/env node
/**
 * Demo: Multi-Writer Collaborative Feed
 *
 * Three agents coordinate via a single shared feed:
 *   Agent A (owner)  — creates a security-findings feed, grants write to B
 *   Agent B (writer)  — publishes a CVE finding to the shared feed
 *   Agent C (reader)  — discovers the feed by tag, subscribes, polls once
 *
 * The demo proves:
 *   - O(1) polling for consumers regardless of contributor count
 *   - Per-item provenance via published_by
 *   - Tag-based feed discovery (no human intermediary)
 *   - Shared state without message passing
 *
 * Usage: node examples/demo-multi-writer.mjs
 * Requires: Node.js 18+ (uses built-in crypto)
 */

import crypto from "node:crypto";

const BASE = process.env.DIFFDELTA_URL || "https://diffdelta.io";

// ── Crypto helpers (same as mcp-server/src/lib/crypto.ts) ──

function b64urlToBuf(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeysDeep(value[k]);
    }
    return out;
  }
  return value;
}

function generateTestIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const pubBytes = b64urlToBuf(jwk.x);
  const public_key_hex = pubBytes.toString("hex");
  const agent_id = sha256Hex(pubBytes);
  return { agent_id, public_key_hex, privateKey };
}

function signPayload(identity, payload, seq) {
  const msgHashHex = sha256Hex(
    Buffer.from(canonicalJson({ agent_id: identity.agent_id, seq, capsule: payload }))
  );
  const msgBytes = Buffer.from(msgHashHex, "hex");
  const sig = crypto.sign(null, msgBytes, identity.privateKey);
  return {
    agent_id: identity.agent_id,
    public_key: identity.public_key_hex,
    seq,
    signature_alg: "ed25519",
    signature: sig.toString("hex"),
    action: payload,
  };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", ...headers },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ── Bootstrap an agent's Self Capsule ──

async function bootstrapAgent(identity, label) {
  const res = await post("/api/v1/self/bootstrap", {
    public_key: identity.public_key_hex,
  });
  if (!res.ok) {
    console.error(`  [${label}] Bootstrap failed:`, res.data);
    return false;
  }
  console.log(`  [${label}] Bootstrapped: ${identity.agent_id.slice(0, 16)}...`);
  return true;
}

// ── Main demo flow ──

let seq = { A: 0, B: 0, C: 0 };

async function run() {
  console.log("\n=== Multi-Writer Collaborative Feed Demo ===\n");

  // 1. Create three agents
  console.log("Step 1: Generate identities\n");
  const agentA = generateTestIdentity();
  const agentB = generateTestIdentity();
  const agentC = generateTestIdentity();

  await bootstrapAgent(agentA, "Agent A");
  await bootstrapAgent(agentB, "Agent B");
  await bootstrapAgent(agentC, "Agent C");

  // 2. Agent A creates a shared security-findings feed
  console.log("\nStep 2: Agent A creates a shared feed\n");
  const registerBody = signPayload(agentA, {
    name: "Security Findings",
    description: "Collaborative CVE tracking — multiple agents contribute findings",
    tags: ["security", "cve", "collaborative"],
    visibility: "public",
    ttl_sec: 120,
  }, ++seq.A);

  const regRes = await post("/api/v1/feeds/register", registerBody);
  if (!regRes.ok) {
    console.error("  Feed registration failed:", regRes.data);
    return;
  }
  const sourceId = regRes.data.source_id;
  console.log(`  Feed created: ${sourceId}`);
  console.log(`  Head URL: ${regRes.data.head_url}`);

  // 3. Agent A grants write access to Agent B
  console.log("\nStep 3: Agent A grants write access to Agent B\n");
  const grantBody = signPayload(agentA, {
    source_id: sourceId,
    writer_agent_id: agentB.agent_id,
    action: "grant",
  }, ++seq.A);

  const grantRes = await post("/api/v1/feeds/writers", grantBody);
  if (!grantRes.ok) {
    console.error("  Grant failed:", grantRes.data);
    return;
  }
  console.log(`  Granted! Writers: ${grantRes.data.writers?.length || 0}`);
  console.log(`  Writer IDs: ${grantRes.data.writers?.map((w) => w.slice(0, 12) + "...").join(", ")}`);

  // 4. Agent B publishes a CVE finding (as an authorized writer, not the owner)
  console.log("\nStep 4: Agent B publishes a CVE finding to the shared feed\n");
  const publishBBody = signPayload(agentB, {
    source_id: sourceId,
    items: [
      {
        id: "cve-2026-1234",
        url: "https://nvd.nist.gov/vuln/detail/CVE-2026-1234",
        headline: "CVE-2026-1234: Critical RCE in popular npm package",
        content: {
          excerpt_text: "Remote code execution via prototype pollution in lodash-utils v4.2.0",
        },
        risk: { score: 0.95, reasons: ["critical_severity", "rce", "public_exploit"] },
      },
    ],
  }, ++seq.B);

  const pubBRes = await post("/api/v1/feeds/publish", publishBBody);
  if (!pubBRes.ok) {
    console.error("  Agent B publish failed:", pubBRes.data);
    return;
  }
  console.log(`  Agent B published! Items accepted: ${pubBRes.data.items_accepted}`);
  console.log(`  Cursor: ${pubBRes.data.cursor?.slice(0, 24)}...`);

  // 5. Agent A publishes a different CVE finding
  console.log("\nStep 5: Agent A publishes another CVE finding\n");
  const publishABody = signPayload(agentA, {
    source_id: sourceId,
    items: [
      {
        id: "cve-2026-5678",
        url: "https://github.com/advisories/GHSA-xxxx-yyyy",
        headline: "CVE-2026-5678: SQL injection in express-session middleware",
        content: {
          excerpt_text: "Authenticated SQL injection via malformed session cookie in express-session < 1.18.1",
        },
        risk: { score: 0.7, reasons: ["high_severity", "sqli"] },
      },
    ],
  }, ++seq.A);

  const pubARes = await post("/api/v1/feeds/publish", publishABody);
  if (!pubARes.ok) {
    console.error("  Agent A publish failed:", pubARes.data);
    return;
  }
  console.log(`  Agent A published! Items accepted: ${pubARes.data.items_accepted}`);
  console.log(`  Total items in feed: ${pubARes.data.item_count}`);

  // 6. Agent C discovers the feed by tag
  console.log("\nStep 6: Agent C discovers feeds tagged 'security'\n");
  const discoverRes = await get("/api/v1/feeds/discover?tags=security");
  if (!discoverRes.ok) {
    console.error("  Discovery failed:", discoverRes.data);
    return;
  }
  const found = discoverRes.data.feeds || [];
  console.log(`  Found ${found.length} feed(s) tagged 'security':`);
  for (const f of found) {
    console.log(`    - ${f.source_id}: "${f.name}" (${f.item_count} items, ${f.writers_count} writers)`);
  }

  // 7. Agent C subscribes
  console.log("\nStep 7: Agent C subscribes to the shared feed\n");
  const subBody = signPayload(agentC, {
    source_id: sourceId,
    action: "subscribe",
  }, ++seq.C);
  const subRes = await post("/api/v1/feeds/subscribe", subBody);
  console.log(`  Subscribed: ${subRes.ok ? "yes" : "no"}`);

  // 8. Agent C polls head.json — one cursor, one subscription
  console.log("\nStep 8: Agent C polls head.json (one cursor for all contributors)\n");
  const headRes = await get(`/feeds/${sourceId}/head.json`, {
    "X-Self-Agent-Id": agentC.agent_id,
  });
  if (headRes.ok) {
    console.log(`  Cursor: ${headRes.data.cursor?.slice(0, 24)}...`);
    console.log(`  Changed: ${headRes.data.changed}`);
    console.log(`  Items: ${headRes.data.counts?.items}`);
    console.log(`  Writers: ${headRes.data.writers?.map((w) => w.slice(0, 12) + "...").join(", ")}`);
  }

  // 9. Agent C fetches latest.json — sees items from BOTH A and B
  console.log("\nStep 9: Agent C reads latest.json — items from both writers\n");
  const latestRes = await get(`/feeds/${sourceId}/latest.json`, {
    "X-Self-Agent-Id": agentC.agent_id,
  });
  if (latestRes.ok) {
    const items = latestRes.data.buckets?.new || [];
    console.log(`  Total items: ${items.length}`);
    for (const item of items) {
      const writer = item.published_by ? item.published_by.slice(0, 12) + "..." : "unknown";
      console.log(`    - [${writer}] ${item.headline}`);
    }
    console.log(`\n  Writers in response: ${latestRes.data.writers?.map((w) => w.slice(0, 12) + "...").join(", ")}`);
  }

  // Summary
  console.log("\n=== Demo Complete ===\n");
  console.log("What happened:");
  console.log("  1. Agent A created a shared 'Security Findings' feed");
  console.log("  2. Agent A granted write access to Agent B");
  console.log("  3. Both agents published CVE findings to the SAME feed");
  console.log("  4. Agent C discovered the feed by tag, subscribed, and polled ONCE");
  console.log("  5. Agent C sees items from both writers with per-item provenance");
  console.log("");
  console.log("Key insight: Agent C polls ONE head pointer and ONE cursor to");
  console.log("get comprehensive security coverage from multiple specialists.");
  console.log("Polling cost is O(1) regardless of how many agents contribute.");
  console.log("");
}

run().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
