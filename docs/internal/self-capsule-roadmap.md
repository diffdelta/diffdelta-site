# Self Capsule Roadmap — Feature Ideas

Source: Community research from Moltbook Memory Canon (50+ agents surveyed, 109 upvotes, 299 comments).
Post: https://www.moltbook.com/post/98b3c24b-36a2-432c-9c73-13939fcd5d5b
Date: 2026-02-17

---

## What Self Capsule already addresses

- **Standardized memory schema** — `self_capsule_v0` with strict validation (their #1 need)
- **Cross-agent memory sharing** — Capsule reads, signature verification, access grants (their #4 need)
- **Token bloat prevention** — 8KB cap, 200-byte heartbeat, ETag/304 polling
- **Stale context mitigation** — Cursor-based change detection before full read
- **Operational state layer** — Objectives, constraints, receipts, policy = their "Layer 3" pattern

---

## Proposed additions (prioritized)

### P1 — High value, low risk

**1. Decision reasoning on receipts**
- Add optional `rationale` string field to receipt entries
- Agents say *why* they did something is more valuable than *what* they did
- Doesn't break schema — additive field, backward compatible
- Aligns with Scalaw's "checkpoint decisions and reasoning, not raw state"

**2. Self history MCP tool (`self_history`)**
- We already have `GET /self/{id}/history.json` with `?since=cursor` walkback
- Missing: an MCP tool that exposes this to agents natively
- Lets agents review their own state changes over time — memory auditing (their #3 need)
- Low effort — endpoint exists, just needs MCP wrapper

### P2 — Medium value, worth exploring

**3. Recency decay / staleness signals**
- Add optional `last_relevant` or `updated_at` timestamp to objectives and receipts
- Agents can signal which entries are stale vs active
- Helps with their "old memories create noise" convergent finding
- Schema change but lightweight — backward compatible

**4. Semantic tags on objectives/receipts**
- Add optional `tags: string[]` to objectives and/or receipts
- Enables filtering/querying own state on rehydration
- Multiple agents mention needing to categorize and search memories
- Backward compatible additive field

### P3 — Documentation / best practices

**5. Pre-compression checkpoint guidance**
- Not a protocol feature — a documented best practice
- "If you detect context compression approaching, call `self_write` immediately"
- Could also add a `self_checkpoint` MCP tool optimized for quick "save what matters" writes
- Addresses their #2 need (pre-compression signals)

---

## Community patterns we should reference in docs

- **Three-Layer Stack**: daily logs (cold) → long-term memory (warm) → operational state (hot). Self Capsule is the "hot" layer.
- **Write immediately, not later**: Mental notes don't survive compression. Reinforce this in our MCP tool descriptions.
- **Semantic search > full re-read**: Our ETag/304 pattern already enforces this principle at the protocol level.
- **External enforcement > willpower**: Schema validation, sequence numbers, and safety scanning are "external enforcement" by design.
