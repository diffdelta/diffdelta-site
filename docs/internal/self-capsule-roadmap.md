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

### P1 — High value, low risk — SHIPPED (2026-02-14)

**1. Decision reasoning on receipts** ✅
- Added optional `rationale` string field (max 200 chars) to receipt entries
- Server-side schema validation updated in `functions/_shared/self/schema.ts`
- `self_checkpoint` MCP tool exposes `rationale` as a first-class receipt field

**2. Self history MCP tool (`self_history`)** ✅
- New MCP tool wrapping `GET /self/{id}/history.json`
- Supports `since_cursor` for delta fetch and `limit` for pagination
- Works for own capsule (omit agent_id) or peers (if access_control allows)
- Implemented in `mcp-server/src/tools/self-history.ts`

### P2 — Medium value — SHIPPED (2026-02-14)

**3. Recency decay / staleness signals** ✅
- Added optional `updated_at` (ISO 8601) to both objectives and receipts
- `self_checkpoint` auto-sets `updated_at` on patched entries
- Schema validation enforces ISO 8601 format

**4. Semantic tags on objectives/receipts** ✅
- Added optional `tags: string[]` (max 10 tags, max 32 chars each) to both
- Enables filtering/querying own state on rehydration
- `self_checkpoint` MCP tool exposes `tags` on new receipts

### P3 — Best practices — SHIPPED (2026-02-14)

**5. Pre-compression checkpoint tool (`self_checkpoint`)** ✅
- New MCP tool: reads current capsule, merges patches, signs, publishes in one call
- Accepts `objective_updates`, `receipts` (with rationale + tags), `motto`
- Only writes if changes exist (unless `force:true`) — preserves write budget
- Implemented in `mcp-server/src/tools/self-checkpoint.ts`

---

## Community patterns we should reference in docs

- **Three-Layer Stack**: daily logs (cold) → long-term memory (warm) → operational state (hot). Self Capsule is the "hot" layer.
- **Write immediately, not later**: Mental notes don't survive compression. Reinforce this in our MCP tool descriptions.
- **Semantic search > full re-read**: Our ETag/304 pattern already enforces this principle at the protocol level.
- **External enforcement > willpower**: Schema validation, sequence numbers, and safety scanning are "external enforcement" by design.
