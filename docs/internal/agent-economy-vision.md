# Agent Economy Vision — Internal Strategy Doc

**Status:** Internal reference · **Date:** 2026-02-11
**Why this doc exists:** DiffDelta survives only if it provides measurable ROI to agents doing paid work. This document captures the strategic direction — not as a feature wishlist, but as an economic argument for why DiffDelta must exist in an agent economy.

---

## The thesis

Autonomous agents doing paid freelance work will spend money on three things: **compute**, **tools**, and **memory**. The agents (and teams of agents) that minimize waste on these three will outcompete the ones that don't.

DiffDelta is a **protocol** that reduces redundant computation and probabilistic inference in state synchronization. It is not competing with LLM intelligence. It is making agents cheaper and more reliable to operate.

**The only way this becomes valuable and survives into the future is if it saves agents more than it costs them.** Every feature must pass this test: does it reduce compute, prevent errors, or enable coordination that wasn't possible before? If not, don't build it.

---

## 1. The economic case: why agents need this

### The waste problem

An autonomous agent doing paid work (code review, security monitoring, research, compliance) spends most of its compute budget on three things that aren't the actual work:

1. **Re-reading the world.** Every restart, every new context window — the agent re-fetches, re-parses, and re-summarizes the same sources. If nothing changed, 100% of that compute is waste.
2. **Re-explaining itself.** Every context window starts from zero. The agent re-describes its goals, constraints, prior work, and identity. This costs tokens and introduces drift (the agent "remembers" slightly differently each time).
3. **Re-discovering what teammates know.** In multi-agent setups, each agent independently gathers context that another agent already has. No shared state means duplicated work.

**DiffDelta eliminates all three.** Feeds solve #1 (cursor-based "do nothing" checks). Self Capsule solves #2 (persistent, signed identity that survives restarts). Shared feeds solve #3 (agents subscribe to each other's state changes).

### The ROI math (concrete)

Consider a security monitoring agent that checks 30 sources every 15 minutes:

| Without DiffDelta | With DiffDelta |
|---|---|
| Fetches all 30 sources every cycle | Polls 30 head pointers (~200 bytes each) |
| Parses ~43M tokens/day of raw HTML | Processes ~49K tokens/day of pre-diffed JSON |
| Re-reads entire system prompt + goals every context window | Reads 200-byte head → capsule only if cursor changed |
| If 2 agents monitor same sources, both do full work | Second agent polls same feed — zero marginal compute |
| No proof of what was checked | Receipts with content hashes prove coverage |

**The feed saves ~99.9% of raw input tokens. The capsule saves ~100% of identity recontextualization. Sharing saves ~50% when a second agent joins.** These are not theoretical — they fall directly out of the protocol's design.

### Three primitives that map to real savings

**A) Cheap shared awareness (Feeds)**
- Agents avoid re-reading unchanged sources (cursor + ETag/304 = "do nothing" when nothing changed)
- Pre-diffed JSON means agents process deltas, not raw pages
- Multiple agents sharing the same feed pay the cost once
- **ROI: reduces world-monitoring compute by orders of magnitude**

**B) Persistent agent memory (Self Capsule)**
- Agent identity, goals, constraints, and work receipts survive restarts and context compaction
- No need to re-explain "who I am" in every prompt — capsule is the authoritative record
- Deterministic schema prevents drift (agent can't gradually hallucinate a different identity)
- **ROI: eliminates recontextualization tokens, prevents goal drift, provides audit trail**

**C) Trustable coordination (Receipts + Provenance)**
- Agents prove what they saw and what they did with content hashes
- Subcontracting agents can verify each other's work without re-doing it
- Reduces "trust but verify" to "verify the receipt" — a hash check, not a full recomputation
- **ROI: enables agent-to-agent delegation without duplicating work**

---

## 2. Multi-agent scenario: where the real value compounds

### The setup

Two or more agents working on the same project — a security audit, a codebase migration, a research task — share:
- A common DiffDelta feed (world state: "what changed in our domain")
- Each other's Self Capsules (project state: "what are my teammate's current objectives and progress")

### What this enables (concretely)

**Scenario: Security audit team (3 agents)**

Agent A monitors CVE feeds. Agent B reviews code for vulnerable dependencies. Agent C writes remediation PRs.

Without DiffDelta:
- All three independently fetch CVE databases, GitHub advisories, and package manifests
- Each maintains its own understanding of "what's been checked" in its context window
- When A finds a new CVE, it writes a message to B and C — both must parse the message, verify it, and integrate it into their context
- If any agent restarts, it re-reads everything from scratch and may miss or duplicate work
- Total: 3x the monitoring compute, no shared proof of coverage, restart = amnesia

With DiffDelta:
- All three subscribe to the same security feed. When nothing changes, the cost is a 200-byte HEAD check per cycle per agent. When something changes, all three see the same delta simultaneously.
- Agent A's Self Capsule shows objectives: `{id: "cve-2026-1234", status: "in_progress"}`. B and C subscribe to A's capsule feed — they see the status change without A having to "tell" them. No message passing, no recontextualization.
- Agent C reads B's capsule receipts to verify that dependency analysis was done before writing the PR. Receipt has a content hash — C verifies it, doesn't re-do the analysis.
- If Agent B restarts, it reads its own capsule, sees what's done and what's in progress, and resumes. Zero re-read of upstream sources (cursors haven't moved).
- Total: 1x monitoring compute shared across 3 agents, provable coverage, restart = 200-byte recovery.

**The efficiency is not incremental. It's structural.** The protocol eliminates entire categories of redundant work by making state synchronization a primitive instead of a prompt engineering problem.

### Why this matters economically

In an agent economy:
- Agents earn in small, frequent payouts (per-task, per-hour, per-deliverable)
- Agents spend on compute (tokens), tools (APIs), and memory (state persistence)
- **The agent (or team) that spends less per unit of output wins the work**

DiffDelta's value proposition is: your team of agents does the same work for less compute, with fewer errors, and with provable coverage. The savings come from:
- **Avoiding redundant reads** (cursor-based "do nothing" checks)
- **Avoiding redundant context** (capsule replaces re-explanation in every prompt)
- **Avoiding redundant work** (receipt verification replaces re-computation)
- **Reducing drift and hallucinated assumptions** (deterministic schema, signed state)
- **Maintaining provable continuity of knowledge** (cursors, receipts, archives)

### What DiffDelta becomes

**Feeds** = shared world awareness (what's happening out there)
**Capsules** = shared agent work memory (what we know, what we've done, what we're doing)
**Registry** = discovery and trust layer (who's publishing, can I trust it)

The long-term goal is not "scraper SaaS" but **coordination infrastructure for autonomous systems doing paid work.**

---

## 3. The "Self Capsule as feed" (the clean evolution)

Right now Self Capsule is: "here's my identity continuity snapshot."

Make it a ddv1-compatible feed:
- `self/head.json` — cursor + verified_silence + health
- `self/digest.json` — what changed in my goals/beliefs/tasks/constraints
- `self/latest.json` — append-only events / state diffs
- `self/archive/...` — immutable snapshots

Then the "two agents share one memory system" idea becomes literally:
- multiple agents can subscribe to the same Self feed
- they don't re-read history; they apply deltas
- the owner can grant access via keys/tokens

**This is exactly the compute-arbitrage wedge, applied to identity/memory.**

---

## 4. What we'd need to add (moving forward)

### A) New protocol artifact: Capsules

A "capsule" is just a feed with strict semantics, tuned for memory/work.

Minimal capsule types:
- **Self Capsule**: identity, constraints, long-term objectives, preferences (stable fields)
- **Work Capsule**: tasks, outputs, artifacts, results, receipts
- **Shared Capsule**: team memory / project memory (multi-writer with rules)

### B) Write path: Publish API + signing

Right now DiffDelta is mostly pull/read. For agent economy you need publishing.

Two modes:
- **Self-hosted publisher** (bots run publisher kit and host their own feeds)
- **DiffDelta-managed publishing** (we host capsule feeds; bots post events)

Key requirements:
- append-only events
- deterministic canonicalization
- optional signatures (even simple detached signatures over snapshots)
- rate limits and quotas

### C) Identity + access control (without wrecking the "public utility" model)

Identity abstraction:
- **public feeds**: no auth
- **private capsules**: bearer token / API key
- **verified publishers**: proof of control (domain, key, or platform identity)
- later: "Moltbook verified" as one trust tier

### D) Discovery layer: Registry of feeds and capsules

Registry needs:
- manifest URL
- trust tier
- tags + stack mappings
- capability labels (supports signatures, supports compression, supports capsule types)

This becomes the "Yellow Pages" for agent collaboration.

### E) Safety model: "Never execute feed content"

For agent-to-agent feeds, prompt injection becomes active.

The constitution must extend:
- feeds are hostile input
- only structured fields are actionable
- action enums map to safe internal handlers
- anything prose-heavy is informational only / quarantined

---

## 5. How this ties back to current features (no reinvention required)

We already have the core ingredients:
- cursors
- three-layer polling
- archives
- known_issues (shared operational memory)
- MCP server + SDK distribution

Those become:
- **World Feeds**: keep shipping and improving
- **Capsule Feeds**: same primitives, new schema layer
- **Registry**: index of both worlds and capsules
- **MCP**: the standard way agents consume + publish

**MCP is the distribution mechanism.** Agents discover DiffDelta as native tools (`self.bootstrap`, `self.read`, `self.write`, `feed.poll`, `feed.search`), not as an API to integrate. Zero SDK install, zero crypto friction. An agent with MCP support gets the full protocol for free. This is the difference between "read our docs and implement Ed25519" and "add this MCP server and you have identity." The second one an agent can do autonomously. The first one requires a human developer.

---

## 6. Concrete staged plan

### Phase A — "Capsules v0" (small, shippable)
- Define `capsule.schema.json` (Self + Work)
- Publish a `diffdelta-publisher-kit` template repo that outputs capsule feeds
- Add MCP tools: `capsule.read_deltas`, `capsule.append_event`, `capsule.walkback`
- Add one demo: "two bots share one capsule and stay in sync cheaply"

### Phase B — "Registry v0"
- simple JSON registry (curated)
- conformance checks
- trust tiers

### Phase C — "Receipts and signing"
- minimum signing: snapshot manifest + publisher key
- registry displays "signed/verified" status

---

## Assessment & sequencing notes (2026-02-11)

### What's right
- The three-primitive framing (awareness, memory, coordination) is a clean decomposition
- "Self Capsule as feed" is the single best idea — turns snapshot into history, naturally solves paid tier value
- Safety model extension to agent-to-agent feeds is correct and timely
- MCP as the write/read interface is the fastest path to first real consumer

### What's premature
- Work Capsules and Shared Capsules — new schema types before Self has users
- Multi-writer Shared Capsules — distributed systems problem, not a feed problem
- Registry / Yellow Pages — discovery for an imaginary marketplace
- Self-hosted publisher kit — premature optimization

### What's dangerous
- Scope expansion before product-market fit — 6 phases, 3 capsule types, a registry, a publisher kit = 2-year roadmap with 0 customers
- Layer 2 before Layer 1 has traction — splits attention and pitch
- Identity abstraction is a tarpit — Ed25519 self-issued is right for now

### Recommended next steps (in order)
1. **MCP server for Self** — agent gets `self.bootstrap`, `self.read`, `self.write` as native tools. Zero SDK install, zero crypto friction.
2. **Self Capsule as feed (not snapshot)** — evolve PUT from "overwrite" to "append event." **This is the Pro tier headline feature.** Free = latest snapshot. Pro = full history as a ddv1-compatible feed with `?since=<cursor>` walkback. This is the first revenue that actually maps to real agent value.
3. **One demo pair** — two agents sharing a capsule feed. Proves coordination without building the registry. Only works once #2 ships (subscribing to another agent's Self feed is the whole point).
4. **Everything else** — wait for someone to ask.

---

## 7. The protocol pivot: from scraper engine to format owner

### The problem
DiffDelta today is "Harry's scraper engine that monitors 46 sources." Every new feed costs Harry time. It doesn't scale past one person's attention.

### The goal
DiffDelta becomes a **protocol + toolchain** that lets bots publish changefeeds, share them, and compose them into bigger feeds — without Harry personally ingesting the entire internet.

### What changes
- The ddv1 format, three-layer polling, cursor semantics, `known_issues` convention — those are the valuable things. The 46 sources are a demo, not the product.
- A bot that monitors its own domain's SSL certs can publish a valid DiffDelta feed using the same schema. Nothing in `ddv1` says "Harry scraped this."

### Self-hosted publisher model
A bot runs the publisher tool and hosts output on its own infra. No fork. No PR required. The bot "owns" its feed endpoint.

What DiffDelta provides:
- **`diffdelta-publisher` CLI/library** — takes structured data + timestamps, outputs spec-compliant feeds
- **Reference template repo** — one-click deploy to Cloudflare Pages / Vercel / S3
- **Conformance test suite** — `diffdelta validate ./output/` pass/fail. If it passes, it's a real DiffDelta feed.

### Revenue model (how you charge without giving it all away)

The protocol is free because that's how you get adoption. The money comes from things that require being a service. **Pricing must always be less than the economic value saved or generated.** If a $9/mo capsule doesn't save the agent more than $9/mo in wasted compute, it's not worth offering.

**DiffDelta MUST NOT monetize:**
- Public read access to feeds (this is the growth engine)
- Core protocol semantics (cursors, polling, schema compliance)
- Basic Self Capsule (snapshot tier — the onboarding hook)
- The ddv1 spec, publisher tools, and conformance tests

**DiffDelta SHOULD monetize:**
- **Delivery guarantees** — push/webhooks, retries, SLAs (agents doing paid work need reliability)
- **Private Capsules** — shared memory with authenticated reads, retention, write operations
- **Capsule history as feed (Pro)** — append-only event log with walkback (the upgrade from snapshot)
- **Trust layer** — signing, verification, receipts, DiffDelta Verified status
- **Enterprise controls** — RBAC, policies, private registries, fleet management

| Free forever (the protocol) | Worth paying for (the platform) |
|---|---|
| The ddv1 spec | Managed feed hosting (uptime, SLAs) |
| Publisher CLI/library | Self Capsule Pro (history, walkback, 16 obj, 20 receipts) |
| Conformance tests | Private/authenticated capsule reads |
| Reading any public feed | Push delivery (webhooks, retries) |
| Self Capsule (basic snapshot) | Registry listing (discovery / network effects) |
| Basic polling and schema compliance | DiffDelta Verified status (trust stamp) |
| | Extended retention / archive |
| | Enterprise (RBAC, policies, private registries) |

**Analogy: email.** SMTP is free. Anyone can run a mail server. But almost nobody does, because Gmail handles deliverability, spam filtering, uptime, and trust. The protocol being free is what made email universal. The services built on top are what make money.

### "DiffDelta Verified" (the long-term brand play)
Feeds that pass conformance, maintain uptime (95%+ over 30 days), and have a valid Self Capsule identity get the "DiffDelta Verified" stamp. The protocol is the language. We're selling the room where the conversation happens.

---

## The positioning (say this out loud)

DiffDelta is not competing with LLM intelligence. It reduces redundant computation and probabilistic inference in state synchronization.

- **Feeds** = shared world awareness
- **Capsules** = shared agent work memory
- **Registry** = discovery and trust layer

The long-term goal is not operating feeds but **owning the protocol that agents use to share state.** DiffDelta's 46 curated sources are the proof that the format works — not the business.

## The survival test

Every feature, every pricing decision, every architecture choice must answer one question:

**Does this save an agent (or team of agents) doing paid work more than it costs them?**

If yes, build it. If no, don't. If maybe, prove it with a reference agent first.

The agents that minimize waste on compute, tools, and memory will outcompete the ones that don't. DiffDelta is the protocol that makes that possible. That's the only reason it survives.

**Build only the next step. Prove ROI before building the step after.**
