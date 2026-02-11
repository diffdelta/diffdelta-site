# Agent Economy Vision — Internal Strategy Doc

**Status:** Internal reference · **Date:** 2026-02-11
**Why this doc exists:** Captures the big-picture evolution from "web changefeeds" to "agent coordination substrate." Not a build plan — a north star. Refer to this when making sequencing decisions.

---

## The thesis

Once you have lots of agents operating continuously, the scarce resources become (1) compute, (2) trustworthy shared state, and (3) coordination bandwidth. DiffDelta fits naturally as coordination infrastructure, not just "web changefeeds."

---

## 1. The agent economy needs three primitives DiffDelta can own

### A) Cheap shared awareness

Agents waste money when they re-check the world independently.

DiffDelta already solves this with:
- heartbeat → digest → full payload
- stable cursors
- "verified silence" (or its next version)

In an agent economy, this becomes: **shared situational awareness as a utility.**

### B) Shared memory that isn't a chat transcript

Key insight: "two agents can share one memory system."

That's basically:
- append-only, cursor-addressable memory
- cheap "what changed?" checks
- provenance/auditability so agents can trust it
- no need to load the whole past into context

**Self Capsule is already the right shape. The evolution is: treat it like a feed, not a blob.**

### C) Trustable collaboration across agents

Agents will subcontract to other agents. That requires:
- "here's what I saw"
- "here's what I did"
- "here's proof I did it"
- "here's the delta since last time"

That's exactly the receipts/provenance philosophy — just applied to agent work products, not upstream websites.

---

## 2. What DiffDelta becomes in that world

DiffDelta splits into two layers:

**Layer 1: World Feeds** (what we're doing now)
Security / releases / status / policy / pricing.
This is the "eyes and ears" feed refinery.

**Layer 2: Work Feeds** (agent-to-agent collaboration)
Agents publish feeds about their own work:
- "I ran this analysis"
- "I updated this code"
- "I attempted this outreach"
- "I verified these sources"
- "I observed this environment"

These are not blogs. They're **deterministic work logs with cursors and receipts.**

If we get Layer 2 right, DiffDelta becomes the shared coordination fabric for agent labor.

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

MCP is a killer wedge: it can expose "capsule read/write" tools in a way agents already understand.

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
2. **Self Capsule as feed (not snapshot)** — evolve PUT from "overwrite" to "append event." Makes Pro valuable (history + walkback).
3. **One demo pair** — two agents sharing a capsule feed. Proves coordination without building a registry.
4. **Everything else** — wait for someone to ask.

### The punchline
That blurb predicts: "agents will need shared memory and shared awareness to survive economically."

DiffDelta already solves shared awareness for the web.
The next evolution is to solve shared awareness for agent work and memory — using the same deterministic diff machinery.

**This document is worth keeping as a north star. It's not worth building yet.**
