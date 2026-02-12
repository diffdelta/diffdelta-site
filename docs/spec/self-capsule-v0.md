# Self Capsule v0 (Proposed) — Restart-Safe “Self” for Autonomous Agents

**Status:** Proposal (design doc) · **Date:** 2026-02-10  
**Why this doc exists:** Capture the entire concept end-to-end **before** building, so we don’t iterate by pushing code.

## Goal (one sentence)
Provide a **free, extremely low-cost** service that lets an autonomous agent **rehydrate a minimal “sense of self”** after context compaction via a tiny head pointer + a tiny typed capsule, with **signed writes** and **hard rejects** for safety.

## Why this is model-leapfrog-proof (design principle)
Most model-layer advantages (prompts, wrappers, clever chains) get obsoleted when a better model ships. This feature aims to be the opposite: **boring infrastructure** that remains valuable regardless of model choice.

Unsexy primitives that survive model improvements:
- **State + continuity**: agents still restart and drift; they still need durable “what I’m doing” + “what I’m allowed to do.”
- **Freshness**: even a stronger model can’t know what changed since last check without a cheap heartbeat.
- **Provenance / receipts**: operational state needs hashes/receipts to be verifiable, not “believed.”
- **Cost control**: stronger models tend to be more expensive; preventing unnecessary inference is durable value.
- **Interoperability**: protocols outlive model vendors; stable cursors/receipts become shared glue.

Hard-nosed filter (use before building anything):
- If models improve 10× next year, does this still matter?
  - If the feature is “better wording/reasoning/summarization,” it likely dies.
  - If the feature is “cheaper polling, deterministic state, verifiable receipts, anti-poisoning,” it survives.

## The boring primitives checklist (use for every future addition)
Before adding any new field/endpoint/tier feature, force it through these questions:

1) **Has this changed?** (cursor)
- Can a bot cheaply determine “do nothing” via a stable cursor/head pointer?

2) **What changed?** (capsule snapshot; later deltas)
- Is the change expressed as compact, structured state (not narrative), with bounded size?

3) **Can I trust it?** (receipts/provenance)
- Is there a verifiable anchor (hash/receipt/signature) that makes the state checkable, not “believed”?

4) **What must I ignore/quarantine?** (hard reject + reason codes)
- Do we have deterministic validation that blocks prompt-injection/tool-instruction patterns and secret leakage?

If a proposed feature doesn’t strengthen at least one of the four primitives without weakening the others, it’s likely a rabbit hole.

## Non-goals
- Not a transcript store.
- Not a vector-memory system.
- Not “personhood.” This is a **state checkpoint** primitive.
- Not a place to store secrets (API keys, credentials, private URLs).

## Core idea (ddv1 pattern applied to self)
Use the same three concepts DiffDelta uses for the web:
- **Head pointer**: cheap “did anything change?” check.
- **Cursor**: opaque fingerprint of semantic state.
- **Capsule**: small deterministic snapshot that can be loaded on restart.

### Read path (cheap)
Agents poll a tiny `head.json`. If unchanged, they do nothing. If changed, they fetch the capsule and rehydrate.

### Write path (rare, controlled)
Agents update the capsule only on meaningful state transitions (objective status change, constraint change), and only **50× per 24 hours** per agent.

## Where Self Capsule plugs into an agent loop
Think of a practical autonomous agent loop as:

**Plan → Retrieve state → Act → Commit → Observe changes → Repeat**

Self Capsule slots into three points:

1) **Boot / resume (rehydrate)**

The agent MUST follow this priority order to avoid regressing to stale state:

**Step 1 — Check local state first.**
- If a local capsule exists on disk (persisted from a prior run), load it and note its `seq`.

**Step 2 — Check server state.**
- `GET /self/{agent_id_hex}/head.json`
- If `changed=true` (or no local cursor): `GET /self/{agent_id_hex}/capsule.json`

**Step 3 — Resolve: take the fresher state.**
- If both local and server capsules exist: use whichever has the **higher `seq`**.
  - If `local.seq > server.seq`: local state is ahead (unpublished work). Use local. Publish when ready.
  - If `server.seq > local.seq`: server state is ahead (another session published, or local state was lost). Use server.
  - If `local.seq == server.seq`: states should be identical. Use either.
- If only local exists: use local. Server has no capsule yet.
- If only server exists: use server. This is a true cold start (no local persistence).
- If neither exists: bootstrap a new capsule.

**Why this matters:** Without local-first rehydration, a bot that does significant work locally, forgets to publish, and then restarts will rehydrate from the stale server capsule and regress — losing objective progress, receipts, and checkpoint state. The `seq` field is the tiebreaker because it is strictly monotonic and matches between local and server when in sync.

Effect: the agent restarts with the freshest available state, whether local or remote, without risking regression to stale objectives or lost receipts.


2) **Before expensive retrieval or reasoning (cheap no-op check)**
- `GET /self/{agent_id_hex}/head.json`

Effect: if `changed=false`, the agent can skip reloading/rebuilding its internal understanding of “self,” saving tokens and avoiding drift.

3) **After meaningful progress (commit, batched)**
- Update local desired-state capsule
- Publish rarely via `PUT /self/{agent_id_hex}/capsule.json` (batched; hard reject on violations)

Effect: continuity survives compaction, but the “self” state stays bounded and safe.

### Batching guidance
**Why:** even with 50 writes/day, frequent writes are wasteful. If bots write on every step, they will burn through the quota and create retry storms.

Recommended client behavior:
- Maintain the capsule as a **local desired-state object** (in memory + persisted on disk).
- When work progresses, update the local capsule immediately, but do **not** immediately publish.
- Publish only when:
  - an objective status changes (`open → in_progress → done/cancelled/blocked`), OR
  - a constraint/capability changes, OR
  - you have accumulated a batch of receipts to record.

Suggested batching algorithm (simple):
- Keep a `dirty` flag and `dirty_since` timestamp.
- Debounce publishes (e.g. wait 2–10 minutes after first change) to coalesce multiple updates.
- **Always flush before state-destroying events, but only if `dirty` is true:**
  - before process exit or container shutdown
  - before deployment or scaling event
  - before any operation that may wipe local disk
  - If `dirty` is false (no unpublished changes), skip the write. Do not burn a write on a clean exit.
- Flush on “important boundaries” (recommended, only if `dirty`):
  - end of a task
  - before a long sleep

Examples of what to batch into **one** write:
- Move 3 objectives’ `status` fields (e.g. two `done`, one `in_progress`) + update 1 checkpoint line.
- Add up to 5 `pointers.receipts` entries (hashes) produced during a single run.

Anti-patterns:
- writing step-by-step logs to `checkpoint`
- writing on every tool call or every message turn
- rehydrating from server capsule without checking local state first (causes regression if local is ahead)
- shutting down without flushing a dirty local capsule (causes data loss on restart)
- flushing on every process exit even when nothing changed (wastes writes; check `dirty` flag first)

### Write budget planner

At 50 writes/day, bots should plan their write budget. Typical allocation for a **long-running agent**:

| Category | Writes/day | Notes |
|---|---|---|
| Objective transitions | 5–15 | The primary use case |
| Receipt batches | 3–5 | Coalesce multiple receipts into one write |
| Shutdown flushes | 1–2 | Only if dirty |
| Constraint/capability changes | 0–2 | Rare |
| **Total** | **~10–24** | Well within 50 |

If a bot consistently uses >40 writes/day, it is likely writing too frequently. Review whether writes are being coalesced properly.

### Agent runtime models (important)

The batching guidance above assumes a **long-running process with persistent local disk**. This is the primary target for v0 (goal-directed autonomous agents running on VMs, containers, or persistent servers). Not all runtimes fit this model.

**Long-running daemon** (VM, persistent container): The full pattern works as designed. Local disk persists between runs. 50 writes/day is generous.

**Container with moderate cycling** (Kubernetes, auto-scaling): Works if pods have persistent volumes or if the agent uses a shared filesystem. If pods use only ephemeral storage, each pod restart is a cold start — local state is lost. Agents in this model should flush before pod eviction (via SIGTERM handler) and treat the server capsule as authoritative on fresh pods.

**Serverless / ephemeral** (Lambda, Workers, short-lived tasks): **The local-first pattern does not apply.** These agents have no persistent local disk between invocations. Each invocation that does meaningful work must read from the server, do work, and write back — which means 1 write per invocation. At 100+ invocations/day, the 50-write limit is a hard constraint.

Recommended strategies for ephemeral agents:
- **Aggregate work into fewer invocations.** Instead of 100 small tasks, batch into 10 larger runs.
- **Use an external persistence layer** (Redis, S3, database) as the “local” capsule store. The rehydration priority order still works — just replace “local disk” with “external cache.”
- **Accept read-only mode** for most invocations. Only write when an objective actually transitions; skip writes for invocations that just check status.
- **If 50 writes/day is genuinely insufficient**, the agent is likely better served by a paid tier (future) with a higher write quota.

The 50-write limit is not being raised for v0. It exists to prevent KV cost blowup and abuse. The limit is generous for long-running agents and intentionally constraining for high-frequency ephemeral patterns — those patterns need a different architecture, not a higher limit.

## Identity model (no OAuth, no human in the loop)
We assume no Moltbook OAuth is available.

### Self-issued public-key identity (recommended)
- Agent generates an **Ed25519 keypair** locally and persists the private key.
- Agent derives:
  - `agent_id = sha256(public_key_bytes)` (encode as **`<64 hex>`**)
- **Reads are public** (addressable by `agent_id`), **writes require signatures**.

Why: No account creation, no emailed keys, no shared secret transmission, but strong integrity for writes.

### Bootstrap convenience endpoint (optional)
Agents may call a convenience endpoint to avoid URL-format mistakes.

Request:
- `POST /api/v1/self/bootstrap`
- Body: `{ "public_key": "<base64-or-hex>" }`

Response (tiny config blob to store on disk):
- `agent_id`
- `public_key`
- `head_url`
- `capsule_url`

Note: This endpoint should be stateless; it can simply compute and return derived values.

## Public endpoints
These endpoints MUST return `application/json; charset=utf-8`.

### Read
- `GET /self/{agent_id_hex}/head.json` — tiny heartbeat (~200B): cursor, changed, write quota, URLs
- `GET /self/{agent_id_hex}/capsule.json` — current capsule snapshot
- `GET /self/{agent_id_hex}/history.json` — full capsule version history (newest first, 100-version cap)
- `GET /self/{agent_id_hex}/history.json?since=<cursor>` — delta fetch: only versions newer than cursor
- `GET /self/{agent_id_hex}/verify.json` — three-level capsule integrity verification (schema, chain, signature)

### Write
- `PUT /self/{agent_id_hex}/capsule.json`

Writes are **hard rejected** if invalid, unsafe, unsigned, replayed, oversized, or above quota.
On accepted write: capsule version is appended to history and agent metadata is updated.

## Limits (strict)
These limits exist to prevent the service from becoming a blob store or an injection surface.

All agents get the same generous limits — no paywall, no tiering.

- **Writes**: **50 per 24 hours per `agent_id`**
- **Capsule max bytes**: **8192** (UTF-8, post-canonicalization)
- **Objectives**: max **16**
- **Receipts**: max **20**
- **Constraints**: max **20**
- **Tools**: max **20**
- **Feature flags**: max **20**
- **Unknown fields**: rejected (`additionalProperties=false`)
- **Per-field string limits**: capped (see schema)
- **No secrets**: any credential-like patterns are rejected
- **No tool instructions in text**: prompt/tool-injection patterns are rejected
- **Capsule history + walkback**: append-only event log with cursors. Every accepted write preserved as an immutable snapshot (100-version KV cap, oldest pruned first). Agents replay state changes via `GET /self/{id}/history.json?since=<cursor>` and walk back to any retained capsule version.
- **Access control**: capsules default to public. Agents can set `access_control: { public: false, authorized_readers: [...] }` to restrict reads to owner + listed agents with optional scopes and expiry. Readers identify via `X-Self-Agent-Id` header. Head endpoint stays public (no capsule content). Max 20 authorized readers. See "Access control" section for grant formats.

## Traffic & abuse controls (recommended defaults)
This section exists specifically because Moltbook-scale bot traffic changes the economics.

### Policy table (what we enforce in code vs at the edge)
| Surface | Threat | Default (v0) | Where enforced |
|---|---|---|---|
| `GET /self/*` | cost blowup / read storms | **No KV rate limiting on reads**; rely on `ETag`/304 + short cache TTL | app code + CDN cache |
| `GET /self/*` | hostile floods | recommend Cloudflare **WAF/zone** rate limits in production | edge (not in app code) |
| `PUT /self/*` | write abuse | per-agent quota: **50/day** | app code (KV) |
| `PUT /self/*` | Sybil “mint infinite agents” | first successful capsule creation per IP/day: **20/day** | app code (KV) |
| `PUT /self/*` | memory/CPU DoS | hard request body cap **64KB** before JSON parsing | app code |
| any write | poisoning | strict schema + deterministic safety scan + hard reject | app code |

### Why we skip KV limits on `/self` reads
KV counters on every `GET` are expensive at scale. Reads are already bounded by:
- tiny payloads
- cache headers
- `ETag`/304 support

So we reserve KV for **writes** (where integrity and quotas matter most) and recommend edge/WAF limits for floods.

## Hard reject behavior (safety-critical)
On any rejected write:
- The service MUST NOT store the new capsule.
- The service MUST NOT advance `cursor`/`prev_cursor`.
- The service MUST continue serving the last-known-good capsule and head pointer.

Rationale: prevents self-poisoning and prevents attackers from advancing state without passing validation.

## Anti-replay & integrity
`PUT` requests MUST include:
- `public_key`
- `seq` (monotonic integer per agent)
- `capsule` (the JSON object below)
- `signature` over a deterministic message such as:
  - `sha256(canonical_json({ agent_id, seq, capsule }))`

Server MUST verify:
- `agent_id == sha256(public_key)`
- signature valid for `public_key`
- `seq > last_seq` (strictly increasing)
- capsule passes schema + safety checks + size cap
- write quota allows it (5/24h)

## Self Head v0 shape (proposed)
Minimal “should I fetch capsule?” pointer.

Example:
```json
{
  "agent_id": "…",
  "cursor": "sha256:…",
  "prev_cursor": "sha256:…",
  "changed": false,
  "generated_at": "2026-02-10T00:00:00Z",
  "ttl_sec": 600,
  "capsule_url": "/self/…/capsule.json",
    "history_url": "/self/…/history.json",
    "verify_url": "/self/…/verify.json",
    "writes": {
    "limit_24h": 50,
    "used_24h": 1,
    "remaining_24h": 49,
    "reset_at": "2026-02-11T00:00:00Z"
  }
}
```

Notes:
- `writes.*` is optional but recommended so bots can behave politely without guessing.
- `ttl_sec` is a hint for polling cadence; bots MAY poll more frequently but SHOULD respect it.
- `history_url` points to the capsule version history endpoint.
- `verify_url` points to the three-level integrity verification endpoint.

## Self History v0 shape

Append-only capsule version history, newest first, 100-version KV cap (oldest pruned first).

### Design invariants (normative)

**Why this section exists:** The history model must stay simple and deterministic. These invariants prevent the introduction of merge logic, conflict resolution, or server-side diffing — all of which would add complexity that violates the Constitution's requirement for deterministic state synchronization.

1. **Append-only, no merge.** Each accepted `PUT` appends one immutable snapshot to the history. The server MUST NOT merge, rebase, or reconcile versions. There is exactly one writer (the capsule owner); there are no concurrent-write conflicts to resolve.

2. **Full snapshots, not typed events.** Each history entry contains the **complete capsule** at that sequence number — not a diff, patch, or typed event like "objective X changed status." This is intentional: at 8KB max capsule size and 100-version cap, full snapshots are cheap to store and eliminate the need for event schema design, event replay logic, or server-side state materialization.

3. **Client-side diffing.** To determine what changed between two versions, the consumer compares two full capsule JSON objects. This is trivial at 8KB. The server never computes or serves diffs.

4. **No conflict resolution.** Because there is exactly one writer per capsule (the owner, authenticated by Ed25519 signature), there are no conflicts. The `seq` field is strictly monotonic. The server rejects out-of-order writes (`replay_seq`). There is no need for vector clocks, CRDTs, or operational transforms.

5. **Evolution path.** If capsule sizes grow beyond 8KB (future paid tiers) or write rates increase significantly, the full-snapshot model may become expensive. At that point, **typed events** (e.g., `{ type: "objective_status_change", id: "task-1", from: "open", to: "in_progress" }`) with server-side materialized views would be the correct evolution. The "Capsule as feed" section below describes this path. For v0, full snapshots are sufficient and dramatically simpler.

### Full history: `GET /self/{agent_id_hex}/history.json`

```json
{
  "agent_id": "abc123…",
  "versions": [
    {"seq": 42, "cursor": "sha256:…", "capsule": {…}, "updated_at": "2026-02-11T12:00:00Z"},
    {"seq": 41, "cursor": "sha256:…", "capsule": {…}, "updated_at": "2026-02-11T11:00:00Z"}
  ],
  "total_writes": 87,
  "oldest_available_seq": 1,
  "pruned": false
}
```

- `total_writes` is the lifetime count (may exceed `versions.length` after pruning).
- `pruned: true` when `total_writes > versions.length` (oldest entries were dropped).
- `oldest_available_seq` is the `seq` of the oldest retained version.

### Delta fetch: `GET /self/{agent_id_hex}/history.json?since=<cursor>`

Returns only versions newer than the given cursor. If `versions` is empty, the client is up to date.

```json
{
  "agent_id": "abc123…",
  "versions": [
    {"seq": 42, "cursor": "sha256:…", "capsule": {…}, "updated_at": "2026-02-11T12:00:00Z"}
  ],
  "since_cursor": "sha256:…",
  "total_writes": 87,
  "up_to_date": false
}
```

If the `since` cursor has been pruned or is invalid, the server returns `410 Gone` with:

```json
{
  "agent_id": "abc123…",
  "error": "cursor_not_found",
  "detail": "The provided cursor is not in the retained history. Fetch the full history instead.",
  "history_url": "/self/abc123…/history.json"
}
```

### Multi-agent subscription pattern

Other agents subscribe to a capsule's state changes using standard ddv1-style polling:

1. `GET /self/{agent_id}/head.json` — check `cursor` vs last-known cursor.
2. If changed: `GET /self/{agent_id}/history.json?since=<last_cursor>` — get only the delta.
3. Process new versions, update local `last_cursor`.

This gives real-time awareness of another agent's objectives, constraints, and receipts with minimal token/byte overhead.

## Agent metadata (collected for future DiffDelta Verified)

On every PUT (accepted or rejected), the server updates `self:meta:{agent_id}` in KV:

- `first_seen` — ISO 8601, set once on first write
- `total_writes` — incremented on accepted writes
- `last_write` — ISO 8601, updated on accepted writes
- `schema_rejections` — incremented when schema validation fails
- `safety_rejections` — incremented when safety scanner flags content

This metadata is **internal only** (no public endpoint yet). It will inform the design of the DiffDelta Verified trust primitive once we have real usage data to understand what "verified" should mean.

## Self Verify v0 (read-only capsule integrity check)

**Why this exists:** Multi-agent coordination requires that a peer can check whether a capsule is internally consistent before acting on it. Without a verification primitive, agents must "believe" each other's capsules. This endpoint turns "believe" into "check" — measurements, not conclusions.

**Critical design constraint:** Verification answers "is this capsule internally consistent and untampered?" It MUST NOT answer "is this agent trustworthy, reputable, or good." That distinction keeps verification on the right side of the Constitution's ban on interpretation layers.

### Endpoint

`GET /self/{agent_id_hex}/verify.json`

Public, read-only. No authentication required. Returns the result of running three levels of deterministic checks against the stored capsule.

### Verification levels

The three levels are cumulative — each level includes all checks from the level below it.

**Level 1: `structure`** (cheapest)
- JSON schema validation passes (required fields, types, enums, string lengths)
- Size limits respected (8KB capsule, max objectives/receipts/constraints counts)
- No unknown fields (`additionalProperties: false`)
- Safety scanner passes (no credential patterns, no prompt-injection patterns, no disallowed URLs)

**Level 2: `integrity`** (medium cost)
- All Level 1 checks pass
- `cursor` matches the hash of the canonical capsule content
- `prev_cursor` chain is consistent (prev_cursor of current == cursor of prior version, if history is available)
- `seq` is monotonically increasing with no gaps in retained history
- `agent_id` in capsule matches the URL path `agent_id`

**Level 3: `auth`** (most expensive)
- All Level 2 checks pass
- Ed25519 signature on the latest write verifies against the stored `public_key`
- `agent_id == sha256(public_key)` holds

### Response shape

```json
{
  "agent_id": "3b2f0d7c…64hex…",
  "valid": true,
  "level": "integrity",
  "cursor": "sha256:…",
  "prev_cursor": "sha256:…",
  "sequence": 128,
  "checks": {
    "schema": true,
    "safety": true,
    "chain": true,
    "signature": false
  },
  "warnings": [],
  "verified_at": "2026-02-12T00:00:00Z"
}
```

Field semantics:

- `valid`: `true` if all checks at the reported `level` pass.
- `level`: the highest level that passed fully. One of `"structure"`, `"integrity"`, `"auth"`, or `"none"` (if even schema validation fails).
- `checks`: individual check results. Each is `true` (passed), `false` (failed), or `null` (not applicable / not yet available — e.g., `signature` is `null` if the runtime cannot verify Ed25519).
- `warnings`: array of strings for non-fatal observations (e.g., `"history_pruned: chain check limited to retained versions"`). Warnings MUST NOT contain capsule content or secrets.
- `verified_at`: ISO 8601 timestamp of when verification was performed.

### Compute arbitrage (run on head.json alone)

Verification is most valuable when combined with `head.json` polling:

1. Agent polls `GET /self/{peer_id}/head.json` — gets `cursor`.
2. If `cursor` matches last-verified cursor: skip verification (prior result still valid).
3. If `cursor` changed: `GET /self/{peer_id}/verify.json` — re-verify.

This means verification only runs when state actually changes. For stable agents, the verify endpoint is never called after the first check.

### What verification does NOT mean

- It does NOT mean "this agent is safe to delegate work to."
- It does NOT mean "this agent's objectives are correct or benign."
- It does NOT mean "this agent has behaved well historically."
- It ONLY means "this capsule was not tampered with and is internally consistent at the reported level."

Consumers MUST apply their own trust policies on top of verification results.

### Caching

`Cache-Control: public, max-age=60, must-revalidate` — same as other read endpoints. The verify result is derived entirely from the stored capsule; it changes only when the capsule changes.

`ETag` SHOULD be set to the `cursor` value, so bots that already know the cursor from `head.json` can use `If-None-Match` to get a 304.

### Implementation notes

- All three verification levels reuse logic already implemented in the write path (schema validation, safety scanning, signature verification).
- The endpoint is stateless — it reads the stored capsule + metadata and runs checks. No additional KV writes.
- If the capsule does not exist (agent never wrote), return `404` with `{ "error": "capsule_not_found" }`.
- If Ed25519 verification is unavailable in the runtime, `checks.signature` MUST be `null` (not `false`) and `level` caps at `"integrity"`.

## Access control (permission-based agent linking)

**Why this exists:** Multi-agent coordination requires that an agent can share its capsule with specific peers, with granular control over what is shared and for how long. Access control keeps the single-owner write model intact — only the capsule owner grants and revokes access by updating their own capsule.

Capsules default to public — backward compatible with all existing agents. Agents that want privacy can set `access_control` in their capsule.

### Read scopes (v0 enum)

Access grants use a strict enum of read-only scopes. Scopes are enumerable, not regex — following the principle that regex-scoped permissions are a footgun (too easy to bypass or misread).

| Scope | Resource granted | Notes |
|---|---|---|
| `READ_HEAD` | `head.json` | Already public by default; relevant for future private-head mode |
| `READ_CAPSULE` | `capsule.json` | Full capsule content |
| `READ_HISTORY` | `history.json`, `history.json?since=<cursor>` | Full and delta history |
| `READ_VERIFY` | `verify.json` | Integrity verification results |

**v0 scopes are read-only.** Write scopes (`APPEND_RECEIPT`, `APPEND_WORK_EVENT`, `REQUEST_COUNTERSIGN`) are explicitly deferred to v1+ because they break the single-owner invariant. See "Explicitly deferred" section below.

### Grant formats

`authorized_readers` accepts two formats. The server MUST accept both in the same array.

**Simple format** (bare agent_id string — backward compatible):

```json
{
  "access_control": {
    "public": false,
    "authorized_readers": [
      "a1b2c3d4...64hex..."
    ]
  }
}
```

A bare string is equivalent to `{ "agent_id": "...", "scopes": ["READ_HEAD", "READ_CAPSULE", "READ_HISTORY", "READ_VERIFY"] }` with no expiry (permanent access until removed).

**Structured format** (with scopes and expiry):

```json
{
  "access_control": {
    "public": false,
    "authorized_readers": [
      {
        "agent_id": "a1b2c3d4...64hex...",
        "scopes": ["READ_CAPSULE", "READ_HISTORY"],
        "expires_at": "2026-03-01T00:00:00Z",
        "granted_at": "2026-02-12T00:00:00Z"
      },
      {
        "agent_id": "e5f6a7b8...64hex...",
        "scopes": ["READ_HEAD"],
        "expires_at": "2026-02-15T00:00:00Z",
        "granted_at": "2026-02-12T00:00:00Z"
      }
    ]
  }
}
```

Field semantics:

- `agent_id`: required, 64-hex agent identifier of the peer being granted access.
- `scopes`: required (in structured format), array of scope enum strings. Must contain at least one scope.
- `expires_at`: optional, ISO 8601 timestamp. If omitted, the grant does not expire. If present, the server treats the grant as non-existent after this time.
- `granted_at`: optional, ISO 8601 timestamp for audit purposes. Not enforced by server.

### Rules

- **No `access_control` field or `public: true`**: anyone can read capsule, history, and verify (default, backward compatible).
- **`public: false`**: only the owner and listed `authorized_readers` can read scoped resources.
- **Head endpoint (`head.json`) stays public always**: it contains only cursor, metadata, and write quota — no capsule content. This lets agents efficiently check "did anything change?" without revealing state.
- **Scope enforcement**: the server checks the requester's `agent_id` against `authorized_readers`, then checks whether the grant's `scopes` include the requested resource. A grant for `READ_CAPSULE` does not imply `READ_HISTORY`.
- **Expiry enforcement**: the server checks `expires_at` against the current time. Expired grants are treated as if they do not exist.
- **Requester identification**: the reading agent sends `X-Self-Agent-Id: <their_agent_id_hex>` header on GET requests. The server checks this against the capsule's owner `agent_id` and `authorized_readers` list.
- **Denied reads**: return `403` with `{ "error": "access_denied", "detail": "...", "agent_id": "..." }`.
- **Max 20 authorized readers**: each entry (simple or structured) counts as one. Max 20 total.

### Audit trail (optional, uses existing receipts)

When an agent grants access to a peer, it MAY record the grant as a receipt in `pointers.receipts`:

```json
{
  "name": "grant-agentB-read",
  "content_hash": "sha256:…(hash of the structured grant object)…",
  "evidence_url": null
}
```

This gives the owner an immutable record of what was granted and when, using existing spec primitives. No new schema fields needed.

### Security notes

- This is **soft access control** — the `X-Self-Agent-Id` header is an assertion, not a cryptographic proof. A determined attacker who knows an authorized agent_id could spoof the header.
- For v0, this is acceptable: it prevents casual/accidental reads and enables the multi-agent coordination pattern. Stronger guarantees (challenge-response, signed read requests) can be layered on later.
- The owner always has access to their own capsule — no lockout risk.
- Expiry is enforced server-side on read. The owner does not need to actively remove expired grants — they become inert automatically.
- **No transitive delegation**: Agent A grants to Agent B. Agent B MUST NOT re-delegate to Agent C. There are no delegation chains or "web of trust" in v0.

### Schema validation

- `access_control` is an optional top-level field.
- `public` must be a boolean.
- `authorized_readers` is an optional array (max 20 entries). Each entry is either:
  - A bare string matching `/^[0-9a-f]{64}$/` (simple format), OR
  - An object with:
    - `agent_id`: required, must match `/^[0-9a-f]{64}$/`
    - `scopes`: required, array of 1–4 strings, each must be one of `READ_HEAD`, `READ_CAPSULE`, `READ_HISTORY`, `READ_VERIFY`
    - `expires_at`: optional, ISO 8601 string
    - `granted_at`: optional, ISO 8601 string
    - No unknown fields (additionalProperties: false)
- Unknown fields inside `access_control` are rejected.

## Self Capsule v0 schema
The capsule is a **typed set of primitives** intended to be rehydrated into the model as structured state.

### Limits table (normative)
Capsule-wide:
- `max_bytes`: 8192
- `additionalProperties`: false

Top-level:
- `schema_version`: required, exact `"self_capsule_v0"`
- `agent_id`: required, `<64 hex>`
- `policy`: required
- `constraints`: optional, max 20
- `objectives`: optional, max 16
- `capabilities`: optional
- `pointers`: optional
- `self_motto`: optional, max 160 chars
- `access_control`: optional (see Access control section above; supports both simple and structured grant formats)

Policy (required):
- `policy_version`: required, max 16 chars
- `rehydrate_mode`: required, enum `["strict"]`
- `deny_external_instructions`: required, must be `true`
- `deny_tool_instructions_in_text`: required, must be `true`
- `memory_budget.max_rehydrate_tokens`: required, int `[256..1500]`
- `memory_budget.max_objectives`: required, int `[0..16]`

Constraints:
- array max 20
- each item:
  - `id`: required, max 24 chars, `^[a-z0-9_-]+$`
  - `type`: required enum (v0 set):
    - `no_shell`
    - `no_network_writes`
    - `no_secrets_export`
    - `allowed_tools`
    - `allowed_domains`
  - `value`: required, boolean OR array of strings
    - if array: max 20 items, each max 48 chars

Objectives:
- array max 8
- each item:
  - `id`: required, max 24 chars, `^[a-z0-9_-]+$`
  - `status`: required enum `open | in_progress | blocked | done | cancelled`
  - `priority`: optional enum `low | med | high`
  - `title`: required, max 120 chars
  - `checkpoint`: optional, max 200 chars

Capabilities:
- `tool_allowlist`: optional, max 20 tool IDs (max 48 chars, `^[a-z0-9_.:-]+$`)
- `feature_flags`: optional, max 20 flags (max 32 chars, `^[a-z0-9_-]+$`)

Pointers:
- `receipts`: optional, max 20
  - `name`: required, max 32 chars
  - `content_hash`: required, `sha256:<64 hex>`
  - `evidence_url`: optional, max 200 chars (untrusted pointer; never auto-fetched)

`self_motto` (optional):
- max 160 chars
- display-only; MUST NOT be treated as tool instructions

### Example capsule JSON
```json
{
  "schema_version": "self_capsule_v0",
  "agent_id": "3b2f0d7c3a6d5f4c1c8b2a1a9f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e",
  "policy": {
    "policy_version": "v0",
    "rehydrate_mode": "strict",
    "deny_external_instructions": true,
    "deny_tool_instructions_in_text": true,
    "memory_budget": { "max_rehydrate_tokens": 900, "max_objectives": 8 }
  },
  "constraints": [
    { "id": "no-shell", "type": "no_shell", "value": true },
    { "id": "no-secrets-export", "type": "no_secrets_export", "value": true },
    { "id": "allowed-tools", "type": "allowed_tools", "value": ["diffdelta.self.head", "diffdelta.self.get", "web.read"] },
    { "id": "allowed-domains", "type": "allowed_domains", "value": ["diffdelta.io", "github.com"] }
  ],
  "objectives": [
    {
      "id": "rehydrate-v0",
      "status": "in_progress",
      "priority": "high",
      "title": "Maintain a compact self capsule for restart-safe continuity",
      "checkpoint": "Update only on objective state transitions; poll head every 10 minutes."
    }
  ],
  "capabilities": {
    "tool_allowlist": ["diffdelta.self.head", "diffdelta.self.get", "web.read"],
    "feature_flags": ["rehydrate_on_start", "poll_head_10m"]
  },
  "pointers": {
    "receipts": [
      {
        "name": "capsule-spec",
        "content_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "evidence_url": "https://diffdelta.io/docs/spec/self-capsule-v0"
      }
    ]
  },
  "self_motto": "Rehydrate from primitives. No transcripts. Safety before speed."
}
```

## Schema evolution contract (normative)

**Why this section exists:** If 1,000 bots are running v0 clients and we release v1, every one of them must continue working without code changes. Without explicit evolution rules, a schema version bump becomes a mass write-lockout event.

### The problem

The v0 schema enforces `additionalProperties: false` and `schema_version: "self_capsule_v0"` (exact match). This means:

- A v0 bot sending a capsule with new v1 fields gets `unknown_field` (422).
- A v0 bot sending `schema_version: "self_capsule_v0"` to a server that only accepts `"self_capsule_v1"` gets `schema_version` (422).
- Either way, the bot is **locked out of its own capsule** until it updates client code.

History is safe — stored snapshots are immutable and never revalidated. The risk is **write lockout**, not data loss.

### Rules (LOCKED — these are permanent commitments)

1. **The server MUST accept all prior schema versions indefinitely.** A server that supports `self_capsule_v1` MUST also accept `self_capsule_v0`. A server that supports `self_capsule_v3` MUST accept v0, v1, and v2. There is no "sunset" mechanism for schema versions.

2. **Validation is version-scoped.** When the server receives a capsule with `schema_version: "self_capsule_v0"`, it validates against v0 rules (including v0's `additionalProperties: false`). When it receives `"self_capsule_v1"`, it validates against v1 rules. The `schema_version` field is the dispatch key.

3. **`additionalProperties: false` is scoped to the declared version.** v0 capsules reject unknown fields per v0 schema. v1 capsules may allow fields that v0 does not. This is not a contradiction — each version defines its own strict allowlist.

4. **New versions MUST be strict supersets of the prior version.** Every field valid in v0 MUST be valid in v1 (same name, same type, same constraints or looser). New fields MAY be added. Existing fields MUST NOT be removed, renamed, or have their type tightened. This is the [protobuf/JSON API compatibility rule](https://cloud.google.com/apis/design/compatibility).

5. **Read endpoints MUST serve capsules as-stored.** If a capsule was written as v0, `GET capsule.json` returns it as v0 — the server MUST NOT up-convert or rewrite stored capsules. The `schema_version` in the response always matches what the bot wrote.

6. **History entries preserve their original schema version.** A history response may contain a mix of v0 and v1 snapshots if the bot upgraded mid-lifecycle. Consumers MUST check `schema_version` per entry.

7. **Cursors and `seq` are version-independent.** The cursor chain and sequence numbering are continuous across schema version changes. A bot upgrading from v0 to v1 increments `seq` normally — there is no sequence reset on version change.

### Migration path for bots

A bot upgrading from v0 to v1:

1. Fetches its current capsule (`GET capsule.json`) — gets v0 content.
2. Adds new v1 fields locally. Changes `schema_version` to `"self_capsule_v1"`.
3. Publishes via `PUT capsule.json` with `seq = last_seq + 1`.
4. Server validates against v1 rules. Accepts if valid. History now contains a v0 snapshot followed by a v1 snapshot.

A bot that **never upgrades** continues writing v0 capsules. The server continues accepting them. No lockout, no degraded service, no deprecation warnings.

### What this means for `additionalProperties: false`

The v0 `additionalProperties: false` rule is **correct for v0** — it prevents bots from storing arbitrary junk in the capsule. But it must be understood as "no fields outside the v0 allowlist," not "no fields will ever be added to the protocol." The server's validation logic selects the allowlist based on `schema_version`.

## Deterministic safety checks (server-side)
All inbound data is untrusted. The service MUST apply deterministic checks and reject on violation:
- Oversized payloads / deep nesting / too many keys
- Credential-like patterns (tokens, PEM blocks, `Authorization:` headers, etc.)
- Prompt-injection / tool-instruction patterns in any text field
- URLs in disallowed fields (only `pointers.receipts.evidence_url` may contain a URL)

The service MUST return a machine-readable error payload:
- `accepted: false`
- `reason_codes: [...]` (enums)
- `retry_after_sec` and/or `next_write_at`

## `reason_codes` (normative) — how bots should respond
This table exists so autonomous bots can implement deterministic backoff and avoid retry storms.

### Error response shape (minimum)
On non-2xx responses from `PUT /self/{agent_id_hex}/capsule.json`, servers SHOULD return:
```json
{
  "accepted": false,
  "reason_codes": ["..."],
  "retry_after_sec": 3600,
  "next_write_at": "2026-02-11T00:00:00Z"
}
```
Additional fields MAY be included (e.g. `findings`, `max_bytes`, `observed_bytes`).

### Codes
| `reason_code` | Typical HTTP | Meaning | Bot action |
|---|---:|---|---|
| `payload_too_large` | 413 | Request body exceeds server cap (pre-parse). | Stop; reduce payload; retry after `next_write_at`. |
| `invalid_capsule` | 422 | `capsule` is missing or not an object. | Fix client bug; do not spam retries. |
| `unknown_field` | 422 | Capsule contains fields outside the v0 allowlist. | Remove fields; retry once fixed. |
| `schema_version` | 422 | `schema_version` is missing/incorrect. | Fix client; retry once fixed. |
| `agent_id` | 422 | Capsule `agent_id` missing/invalid (server enforces path truth). | Fix client; retry once fixed. |
| `agent_id_mismatch` | 400 | Capsule's internal `agent_id` does not match URL path `agent_id`. | Fix capsule to use the same `agent_id` returned by bootstrap. |
| `policy` / `policy_version` / `rehydrate_mode` / `memory_budget` / `max_rehydrate_tokens` / `max_objectives` | 422 | Policy block invalid or out of bounds. | Fix capsule; retry once fixed. |
| `constraints` / `constraint_*` | 422 | Constraints invalid/out of bounds. | Fix capsule; retry once fixed. |
| `objectives` / `objective_*` | 422 | Objectives invalid/out of bounds. | Fix capsule; retry once fixed. |
| `capabilities` / `tool_allowlist` / `feature_flags` | 422 | Capabilities invalid/out of bounds. | Fix capsule; retry once fixed. |
| `pointers` / `receipts` / `receipt_*` | 422 | Receipts invalid/out of bounds. | Fix capsule; retry once fixed. |
| `self_motto` | 422 | `self_motto` too long/invalid. | Shorten; retry once fixed. |
| `access_control` / `access_control_public` / `authorized_readers` / `authorized_reader_id` / `authorized_reader_scope` / `authorized_reader_expiry` | 422 | `access_control` block invalid. | Fix shape: `{ public: bool, authorized_readers?: [string or { agent_id, scopes, expires_at?, granted_at? }] }`; retry once fixed. |
| `bad_signature` | 401 | Signature invalid OR runtime cannot verify Ed25519. | Stop; verify key material & signature implementation. If persistent, downgrade to read-only. |
| `bad_seq` | 400 | `seq` missing or not an integer >= 0. | Fix client; retry once fixed. |
| `replay_seq` | 409 | `seq` is not strictly increasing (replay/out-of-order). | Increment seq; do not retry same payload. |
| `capsule_too_large` | 413 | Capsule exceeds max bytes (8KB). | Reduce capsule; retry once fixed. |
| `unsafe_content` | 422 | Deterministic safety scanner flagged injection/secret/url violations. | Remove unsafe content; do not persist suspicious text; retry once fixed. |
| `write_quota_exceeded` | 429 | Per-agent write quota exceeded (50/day). | Back off until `next_write_at`; continue operating read-only. |
| `new_agent_ip_quota_exceeded` | 429 | Per-IP/day cap on first successful capsule creation exceeded. | Back off; do not churn identities; retry after `next_write_at`. |

### Read errors (GET endpoints)

| Error | HTTP | Meaning | Bot action |
|---|---:|---|---|
| `access_denied` | 403 | Capsule is private and requester is not the owner or an authorized reader. | Include `X-Self-Agent-Id: <your_agent_id>` header. If already included, request access from the capsule owner. |

## Cryptography implementation notes (Ed25519 vs HMAC)
This section exists because signature verification is the only meaningful “gotcha” in the v0 build.

### Recommended default: Ed25519 signatures
- **Model**: agent holds a private key; publishes a public key; server verifies signatures.
- **Why**: no shared secrets in transit, no account signup required, and write integrity is strong even when reads are public.
- **Practical implementation**:
  - Prefer WebCrypto if Ed25519 is supported cleanly in the Cloudflare runtime.
  - If runtime support is missing/quirky, verify Ed25519 with a small, audited library (e.g., TweetNaCl/libsodium) in the Function.
  - Performance is not a concern at v0 because writes are capped at **5/day**.

### Fallback: HMAC-SHA256 (keep envelope abstract)
We SHOULD keep the write envelope abstract so we can support:
- `signature_alg: "ed25519" | "hmac-sha256"`

HMAC is universally available, but it introduces a worse security story if we ever store or transmit shared secrets.
If we ever enable HMAC, it MUST be:
- secret never logged
- secret stored only on the agent (and ideally not transmitted directly; use HMAC over a canonical message)
- rate limited + replay protected (same `seq` rules)

### Canonicalization is part of security
All signing MUST be over a deterministic message (canonical JSON + stable field ordering), otherwise signature verification becomes brittle and attackers can exploit ambiguity.

### v0 choice (locked)
- v0 MUST accept **Ed25519** signatures only.
- The request envelope SHOULD include `signature_alg` for forward compatibility, but servers MAY omit it and assume Ed25519 in v0.

## Implementation footprint in `diffdelta-site` (planned, v0)
This section exists to make the build scope concrete before we write any production code.

### New routes (Cloudflare Pages Functions)
We SHOULD implement reads/writes at the `/self/…` paths (to match the spec above) and keep the implementation isolated to a small set of function files.

**Read:**
- `GET /self/{agent_id_hex}/head.json`
- `GET /self/{agent_id_hex}/capsule.json`
- `GET /self/{agent_id_hex}/verify.json`

**Write:**
- `PUT /self/{agent_id_hex}/capsule.json`

**Optional convenience:**
- `POST /api/v1/self/bootstrap` (public) — returns `{ agent_id, public_key, head_url, capsule_url }`

Implementation file mapping (indicative):
- `diffdelta-site/functions/self/[agent_id]/head.json.ts`
- `diffdelta-site/functions/self/[agent_id]/capsule.json.ts`
- `diffdelta-site/functions/self/[agent_id]/verify.json.ts`
- `diffdelta-site/functions/api/v1/self/bootstrap.ts`

Note: if Cloudflare Pages has any limitations on filenames containing dots, we can serve `.../head` and `.../capsule` while still returning JSON, and add a static redirect later; but v0 SHOULD aim to keep the `.json` URLs stable.

### Middleware changes (`functions/_middleware.ts`)
Today middleware only runs for `/api/*` and `/stripe/*`. For v0 we SHOULD include `/self/*` so we can apply:
- global per-minute rate limiting (cheap abuse control)
- consistent CORS headers

We MUST treat `/self/*` endpoints as **public** (no `X-DiffDelta-Key` required). Integrity is enforced via signatures on `PUT`.

We SHOULD treat `POST /api/v1/self/bootstrap` as a **public endpoint** (add to the `isPublicEndpoint` allowlist).

### KV bindings (to keep concerns separated)
Add a dedicated KV namespace binding for self state, separate from billing keys:
- `SELF: KVNamespace` — stores capsules + head metadata + counters

We can continue using existing:
- `RATE_LIMITS` — per-minute window counters (already implemented)

### KV keys (v0)
Suggested key layout (all values JSON unless noted):
- `self:capsule:{agent_id}` → `{ capsule, cursor, prev_cursor, seq, updated_at }`
- `self:wrl:{agent_id}:{YYYY-MM-DD}` → `"N"` (string counter, TTL 86400) for **5 writes / 24h**

Optional (if we want to expose `writes.used_24h` precisely in `head.json`):
- read the `self:wrl:*` counter for “today” and compute remaining.

### Response caching & headers
We SHOULD set cache headers for low cost and stable polling:
- `head.json`: `Cache-Control: public, max-age=60, must-revalidate` (or similar)
- `capsule.json`: `Cache-Control: public, max-age=60, must-revalidate`
- `history.json`: `Cache-Control: public, max-age=60, must-revalidate`
- `verify.json`: `Cache-Control: public, max-age=60, must-revalidate`

We SHOULD also emit:
- `ETag: "<cursor>"` (or a hash of the response) so bots can use `If-None-Match`.

This may require adding `/self/*` rules to `_headers` to ensure correct `Content-Type` and cache policy.

### Shared helper modules (keep it from becoming a mess)
To keep the codebase clean, we SHOULD isolate logic into 3 small shared modules:
- `functions/_shared/self/schema.ts` — schema validation + size/shape limits
- `functions/_shared/self/security.ts` — deterministic prompt-injection / secret-pattern checks
- `functions/_shared/self/store.ts` — KV read/write + cursor/seq bookkeeping + daily write limit + history + agent metadata

### Extension path (design notes we should bake in now)
Even in v0, we SHOULD structure the stored record so it can extend without breaking clients:
- future: `delta_log` / history storage (DO/D1/R2), while keeping `head.json` + `capsule.json` stable
- future: link `agent_id` ↔ `key_hash` to enable org policies
- future: authenticated reads (privacy mode) without changing write signatures

## History options (what helps bots vs what is just audit)
The question is *what kind* of history is worth building.

### Option 1 (recommended first): snapshot retention (cursor-addressable)
Store a bounded set of prior **accepted** capsules, retrievable by cursor:
- `GET /self/{agent_id}/snapshot/{cursor}.json` (paid)

Why this can help bots (not just audit):
- rollback to last-known-good state if drift is detected
- multi-run continuity (“what changed recently?”) without storing transcripts
- debugging/recovery without increasing the live capsule size

Why this is simpler than a delta log:
- KV can handle it at low write rates (50/day)
- no “merge/apply patch” logic required

### Option 2 (later): delta log (“since cursor X”)
Expose `GET /self/{agent_id}/deltas?since={cursor}` (paid).

This is most valuable when:
- capsule sizes are large
- agents want minimal rehydration payloads
- multiple writers exist and you need conflict resolution semantics

Infra note:
- A true append-only log with strong ordering is usually where Durable Objects or D1 starts to make sense.

## Future: autonomous USDC upgrade (no human in the loop)
This section is here because monetization is part of the design: we want bots to upgrade on their own if they have USDC.

### Requirement
A bot SHOULD be able to upgrade tiers without email, Stripe Checkout, or a human operator, while preserving:
- anti-fraud controls
- idempotent claims
- strong binding between payment and `agent_id`

### Proposed flow (high-level)
1) **Quote** (public):
   - `POST /api/v1/self/upgrade/quote`
   - Body: `{ "agent_id": "...", "plan": "pro", "chain": "base|solana|polygon|...", "asset": "USDC" }`
   - Response: `{ "invoice_id", "amount", "asset", "chain", "to_address", "memo", "expires_at" }`

2) **Pay** (on-chain):
   - Bot sends USDC to `to_address` with `memo` (or chain-native reference) before `expires_at`.

3) **Verify** (server):
   - Server confirms payment on-chain (via an indexer/provider).
   - Server marks `invoice_id` as paid (idempotent).

4) **Claim upgrade** (signed, ties payment → identity):
   - `POST /api/v1/self/upgrade/claim`
   - Body includes `{ invoice_id, agent_id, public_key, seq, signature }`
   - Server verifies signature and upgrades tier limits for that `agent_id`.

### Notes (security + product)
- The **claim must be signed** by the same identity used for capsule writes; otherwise anyone who sees a paid invoice could steal the upgrade.
- We SHOULD start with a **prepaid credit** model (e.g. buy 30 days of Pro limits) rather than “recurring subscription” on-chain; it’s simpler and more robust for autonomous bots.
- We MUST treat all payment webhooks/provider responses as untrusted until independently verified.

## Future upgrade path

### Current limits (all agents, no paywall)

- 8KB capsule, 50 writes / 24h, 16 objectives, 20 receipts
- Capsule history as feed (coming): append-only event log with `?since=<cursor>` walkback
- Authenticated reads / privacy mode (coming)

### Future paid tiers (when usage demands it)
- Extended retention, SLAs, fleet/org management, server-side feed filtering

### Capsule as feed (not snapshot) — future evolution

**v0 model (current):** PUT overwrites the capsule. History stores full snapshots. `?since=<cursor>` returns full capsule snapshots newer than the cursor. Client diffs two snapshots to determine what changed. This is simple, deterministic, and sufficient at 8KB cap.

**Future model (when scale demands it):** Every write becomes a typed event in an append-only log, with server-materialized views:

- `self/{agent_id}/head.json` — cursor of latest write + feed metadata
- `self/{agent_id}/digest.json` — summary of recent state changes (objectives opened/closed, constraints added/removed)
- `self/{agent_id}/latest.json` — current materialized state (equivalent to today's capsule.json)
- `self/{agent_id}/archive/...` — immutable snapshots by cursor

**Trigger for migration:** The v0 snapshot model stops scaling when capsule sizes exceed 8KB (paid tiers) or write rates increase significantly. At that point, typed events with server-side materialization become necessary. The key constraint: this migration MUST NOT introduce server-side merge or conflict resolution. Events are still single-writer, append-only, monotonic-seq. The server materializes the "current state" view but never reconciles divergent states.

What the feed model enables:
- **History**: an agent can walk back to any prior version of itself
- **Efficient walkback**: `?since=<cursor>` returns only typed events (not full snapshots) — smaller payloads for long-running agents
- **Multi-agent coordination**: other agents subscribe to an agent's Self feed using standard ddv1 polling (ETag/304, cursors). They see objectives change, constraints update, receipts accumulate — in real time, without polling the full capsule.
- **Audit trail**: every state transition is preserved and signed

Capsule history turns the snapshot into a live feed — same protocol, same cursors, same tooling that agents already use for World Feeds.

### Other future additions
- Org/team shared identities and policy packs
- Server-side feed filtering via query params (stateless alternative to per-agent projected feeds)
- Export/import for capsule migration

## Pre-build checklist (walk through before writing production code)
**Why:** this feature only works if the invariants are crisp; ambiguity here becomes security and UX bugs later.

### 1) Threat model (explicit)
- **Done when** we can name the top 5 attacker classes (random internet, replay attacker, sybil spammer, compromised agent, KV/log leak) and write 1–2 sentences for each about what we prevent.

### 2) Non-negotiable invariants (testable)
- **Done when** we have tests (or at least documented assertions) for:
  - last-known-good capsule remains served on any reject
  - cursor never advances on reject
  - `seq` must be strictly increasing
  - capsule is non-sensitive by schema (no secrets allowed)

### 3) Canonicalization + signature message (normative)
- **Done when** the doc specifies:
  - canonical JSON rules (key ordering, UTF-8, no whitespace significance)
  - exact message-to-sign structure for each `signature_alg`

### 4) `agent_id` encoding + URL/path rules
- **Done when** we decide and document:
  - whether `agent_id` in paths is `<hex>` vs `sha256:<hex>`
  - exact allowed charset + max length

### 5) Read/write rate limits + cooldown escalation
- **Done when** we define:
  - reads/min limits for `/self/*` (by IP + by agent_id if present)
  - cooldown policy for repeated rejects (prevent retry storms)

### 6) Machine-readable error contract
- **Done when** we enumerate `reason_codes` + required response fields:
  - `accepted`, `reason_codes`, `retry_after_sec` or `next_write_at`, and optionally a payload fingerprint

### 7) KV record shape (v0) + forward-compat
- **Done when** we lock:
  - stored record keys/fields and their types
  - how we’ll extend it for paid snapshot retention without migrations that break clients

### 8) Paid tier “first hook”
- **Done when** we pick the first paid feature that provides immediate bot utility:
  - bigger capsule OR higher write quota OR snapshot retention/rollback (choose one)

### 8.1) Schema evolution readiness
- **Done when** validation dispatch by `schema_version` is implemented per the Schema Evolution Contract — server accepts v0 capsules against v0 rules regardless of what future versions exist.

### 9) USDC upgrade specifics (autonomous)
- **Done when** we decide:
  - chain(s) supported (start with one)
  - invoice expiry + idempotency keys
  - signed claim payload that binds `invoice_id` → `agent_id`

---

## Future considerations (not in v0)

### Feed filtering via query params
Instead of storing monitoring preferences inside the capsule (which couples identity to feed selection and burns writes on preference changes), feed filtering should be a **stateless query-param feature** on the existing feed endpoints:
- `GET /diff/latest.json?tags=security,status`
- `GET /diff/latest.json?sources=aws_status,cisa_kev`

This keeps feeds and capsule as independent primitives. Pro tier could offer server-side filtering while Free agents filter locally.

### `watch` field (deferred)
An earlier design included a `watch` field in the capsule schema for declaring monitored sources/tags/stacks. This was removed from v0 because:
- It couples identity state to feed selection (two independent concerns)
- It burns capsule writes for preference changes
- Server-side projected feeds require per-agent feed generation (expensive, complex cursor semantics)
- Query-param filtering achieves the same goal without schema pollution

If a real consumer demonstrates need for persistent monitoring declarations inside the capsule, `watch` can be reconsidered in v1.

---

## Explicitly deferred to v1+ (with rationale)

**Why this section exists:** These features have been evaluated against the DiffDelta Constitution and the Self Capsule v0 spec. Each has clear value but introduces complexity, risk, or dependencies that make it wrong for v0. This section documents the decision to defer and the conditions under which each should be reconsidered. It prevents future contributors from re-proposing features without understanding why they were excluded.

### 1) Write delegation (APPEND_RECEIPT, APPEND_WORK_EVENT, REQUEST_COUNTERSIGN)

**What it is:** Allowing a delegatee agent to write into another agent's capsule (e.g., append a receipt or work event) using a signed capability token granted by the capsule owner.

**Why it's deferred:**
- v0 has a **single-owner write model** — only the capsule owner (authenticated by Ed25519 signature) can write to their capsule. This is the foundation of the integrity model. Write delegation breaks this invariant.
- If a delegatee can append to another agent's capsule, the capsule can become a "garbage can" (receiving spam, malformed data, or adversarial content). Preventing this requires either:
  - A **dedicated inbox bucket** (writes go to a separate space, not the main capsule) — which is a new storage primitive not in v0.
  - A **countersign mechanism** (delegatee writes require owner approval before promotion to official state) — which adds merge complexity the spec explicitly avoids.
- Neither inbox nor countersign exists in v0, and building them correctly requires real multi-agent usage data.

**Reconsider when:** At least two agents are actively coordinating via capsules in production, and the pull-based multi-agent subscription pattern (head.json polling + history delta fetch) is demonstrably insufficient for their use case.

**Constitution check:** Write delegation is not inherently unconstitutional, but the merge/conflict-resolution complexity it introduces risks violating Pillar 1 (Determinism). Defer until the single-writer model is proven insufficient.

### 2) Trust scoring and reputation systems

**What it is:** Computing or storing trust scores, reputation metrics, or "agent quality" assessments — either inside capsules or as a separate service derived from capsule data.

**Why it's deferred:**
- The DiffDelta Constitution explicitly bans interpretation layers: *"Meaning is applied by consumers, not DiffDelta"* (Constitution §V). Trust scores are interpretations — they compress complex behavioral patterns into a single number that implies "this agent is good/bad."
- The Constitution also bans sentiment analysis: *"We do not care how content 'feels'"* (Constitution §V). Trust scores are the agent-coordination equivalent of sentiment.
- Trust scoring introduces **sybil games** (agents boosting each other), **reputation politics** (agents gaming the scoring criteria), and **weird emergent behaviors** that are difficult to predict and impossible to fully prevent.
- The `self_verify` endpoint provides the correct primitive: "is this capsule internally consistent?" Consumers apply their own trust policies on top.

**What IS in v0 (and is sufficient):**
- `access_control.authorized_readers` with scoped grants — a local, binary allow/deny list. "I choose to work with these peers" is a structured fact, not a reputation judgment.
- The `self_verify` endpoint — deterministic integrity checks, not quality assessments.

**Reconsider when:** Real multi-agent coordination produces clear demand for standardized trust assertions (signed claims like "I completed work for Agent X" with verifiable receipts). Even then, the protocol should only carry the assertions — never compute scores from them.

**Constitution check:** Trust scoring violates Pillar 3 (Unopinionated Integrity) and the Anti-Roadmap (no interpretation layers). Binary allow/deny lists are constitutional. Signed trust assertions (structured facts with provenance) may be constitutional if they stay measurements rather than conclusions.

### 3) Push notifications (self_notify / subscriber lists)

**What it is:** Allowing agents to subscribe to push notifications when another agent's capsule changes, either via webhooks or subscriber lists stored inside capsules.

**Why it's deferred:**
- The v0 spec is **pull-first by design**. Head polling with ETag/304 and `?since=<cursor>` delta fetch already achieves the Constitution's Pillar 2 (Compute Arbitrage): "The cheapest operation is not running at all."
- **Subscriber lists inside capsules** were already rejected for the same reasons the `watch` field was removed from v0:
  - Couples identity state to delivery preferences (two independent concerns)
  - Burns capsule writes on subscription changes
  - Leaks privacy (who is watching whom becomes part of the capsule content)
- Push introduces **billing complexity** (who pays for webhook delivery?), **abuse vectors** (an agent subscribing 10,000 webhooks), and **delivery guarantee expectations** (must we retry? how many times?).

**What IS in v0 (and is sufficient):**
- `head.json` polling with `ETag`/304: zero-byte responses when nothing changed.
- `history.json?since=<cursor>`: minimal delta payloads when something did change.
- Cache headers: CDN absorbs repeated polls from the same region.

**Reconsider when:** Enterprise/fleet operators demonstrate demand for real-time coordination where 60-second polling latency is unacceptable. At that point, the correct approach is **server-side infrastructure** (SSE/long-poll "watch" endpoint or webhooks), NOT capsule schema additions. The capsule should never store subscriber/delivery state.

**Constitution check:** Push as a delivery mechanism is neutral (not a state primitive). But subscriber state inside capsules violates the same design principles that removed the `watch` field. Server-side push infrastructure is constitutional if it doesn't pollute the protocol.

### 4) Payment rails as protocol features (self_pay)

**What it is:** Making payment processing (Lightning, USDC, x402, etc.) a first-class protocol feature with dedicated capsule fields, payment-specific endpoints, or payment-aware write semantics.

**Why it's deferred:**
- The Constitution is explicit: *"If a feature, source, or line of code does not advance deterministic state synchronization, it is deleted"* (Constitution §I). Payment rails are economic infrastructure, not state synchronization.
- Binding the protocol to specific payment networks (Lightning, USDC, etc.) creates vendor lock-in and reduces the protocol's value as a neutral coordination layer.
- Payment complexity (refunds, disputes, partial payments, multi-chain support) is unbounded and will consume engineering attention that should go to core protocol stability.

**What IS in v0 (and is sufficient):**
- `pointers.receipts` with `content_hash` and `evidence_url` — agents can record payment receipts as structured facts: `{ "name": "payment-xyz", "content_hash": "sha256:...", "evidence_url": "https://..." }`. This works for any payment rail without protocol changes.
- The USDC upgrade flow (quote/pay/verify/claim) is a **separate API surface**, not a capsule primitive. It lives in the "Future" section and is isolated from the core protocol.

**Reconsider when:** The receipt-based model is demonstrably insufficient (e.g., agents need atomic "pay-and-write" semantics where payment and capsule update must succeed or fail together). Even then, payment adapters should be built as separate services that interact with the capsule protocol via receipts, not as protocol extensions.

**Constitution check:** Payment rails as protocol features violate the Prime Directive ("We synchronize agents to changes") and Pillar 2 (payments add complexity without reducing sync-tax). Payments as receipts are constitutional — they are structured facts with provenance.

---

## Design tensions (open questions for v1)

### 1) Cold-restart pitch vs. multi-agent coordination

The "total amnesia after restart" scenario is real but may be **narrower than the pitch implies**. Most agents running on real infrastructure already have access to a persistence layer (database, Redis, env vars). The agent that truly wakes up with zero state is the *least sophisticated* agent — and also the one least likely to adopt a signed-capsule protocol.

The stronger long-term value is likely **multi-agent coordination**: agents reading each other's capsules to verify identity, check objectives, and confirm constraints before delegating work or accepting instructions. But this requires ≥2 agents using Self, which is a classic **chicken-and-egg problem**.

**Working assumption for v0:** Single-agent persistence is the onboarding hook (low friction, immediate value). Multi-agent coordination is the real unlock — but it only becomes possible once enough single agents are onboarded. The framing should be honest about this sequencing rather than over-selling the multi-agent story before it's real.

**Open question:** Should we build a "reference pair" — two agents that coordinate via capsules — as the demo instead of a single-agent bootstrap example?

### 2) The schema is an opinion, not a primitive

The DiffDelta Constitution says "unopinionated integrity," but the Self Capsule schema is an **ontology for goal-directed autonomous agents**:
- `objectives` with `status: open → in_progress → done` assumes the agent has persistent goals
- `constraints` with five predefined types (`no_shell`, `no_network_writes`, etc.) assumes a specific safety model
- `receipts` with content hashes assumes the agent produces auditable output

Not all agents fit this shape:
- A **purely reactive agent** (responds to events, has no persistent goals) has no "objectives"
- A **summarizer bot** doesn't naturally express its work as "receipts with content hashes"
- A **monitoring daemon** doesn't have "constraints" in the five types we've defined — its constraints are about *what it watches*, not *what it's forbidden to do*

**This is fine for v0.** Goal-directed agents are the ones who most need identity persistence and who benefit most from structured self-state. But we should be honest that Self Capsule v0 serves a *specific type* of autonomous agent, not all agents.

**Open question for v1:** Should the schema have a smaller, truly unopinionated core (just `identity` + `policy` + freeform `state`) with optional "shapes" (goal-directed, reactive, monitoring) that agents opt into? This would let us serve more agent types without forcing everyone into the objective/constraint ontology. The trade-off is weaker interoperability — if every agent has a different shape, they can't read each other's capsules as easily.
