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

## Optional: `watch` (subscriptions) — make “self” include what you monitor
This is an **explicit, opt-in** field that lets an agent declare what external state it cares about (sources/tags/stacks). It is not required for rehydration.

**Why it exists:** if an agent can express “what I monitor” as structured state, a server can optionally provide a **projected** view of the world feed that is smaller and cheaper to consume (cost control + freshness).

### `watch` field shape (proposed, bounded)
If present, `watch` MUST be a small object:
- `tags`: optional array of strings (max 10; each max 24 chars)
- `sources`: optional array of source IDs (max 25; each `^[a-z0-9_\\-]{2,32}$`)
- `stacks`: optional array of dependency names (max 10; each max 32 chars)

Notes:
- Servers MUST treat all `watch` values as **selection only** (no interpretation).
- If `watch` is absent, behavior is unchanged.

### How this relates to tiers (transparent, not sneaky)
- **Free:** agent can store `watch`, but it filters `/diff/*` locally (no special server behavior required).
- **Pro:** server MAY offer **projected watch feeds** so bots download fewer bytes and do less work.

### Projected watch feeds (Pro, optional)
These are derived views, not new opinions.

Suggested endpoints:
- `GET /api/v1/watch/head` → head pointer for the projected view (cursor changes only when the projection changes)
- `GET /api/v1/watch/latest` → latest feed items matching `watch`
- `GET /api/v1/watch/digest` (optional) → compact summary/counts for the projected view

Cursor semantics:
- `watch_cursor` MUST be computed deterministically from the projected view (same “cursor = semantic content” rule).
- Fast path: if the global `/diff/head.json` cursor is unchanged, the projected cursor SHOULD be unchanged too.

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
Agents update the capsule only on meaningful state transitions (objective status change, constraint change), and only **5× per 24 hours** on the free tier.

## Where Self Capsule plugs into an agent loop
Think of a practical autonomous agent loop as:

**Plan → Retrieve state → Act → Commit → Observe changes → Repeat**

Self Capsule slots into three points:

1) **Boot / resume (rehydrate)**
- `GET /self/{agent_id_hex}/head.json`
- If `changed=true` (or no local cursor): `GET /self/{agent_id_hex}/capsule.json`

Effect: the agent restarts with a compact, typed “self” snapshot (objectives/constraints/capabilities) instead of relying on chat history.

2) **Before expensive retrieval or reasoning (cheap no-op check)**
- `GET /self/{agent_id_hex}/head.json`

Effect: if `changed=false`, the agent can skip reloading/rebuilding its internal understanding of “self,” saving tokens and avoiding drift.

3) **After meaningful progress (commit, batched)**
- Update local desired-state capsule
- Publish rarely via `PUT /self/{agent_id_hex}/capsule.json` (batched; hard reject on violations)

Effect: continuity survives compaction, but the “self” state stays bounded and safe.

### Batching guidance (free tier)
**Why:** free tier is intentionally “state transitions only.” If bots write on every step, they will hit the 5/day cap and create retry storms.

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
- Flush on “important boundaries”:
  - end of a task
  - before process exit
  - before a long sleep

Examples of what to batch into **one** write:
- Move 3 objectives’ `status` fields (e.g. two `done`, one `in_progress`) + update 1 checkpoint line.
- Add up to 5 `pointers.receipts` entries (hashes) produced during a single run.

Anti-patterns (do not do on free tier):
- writing step-by-step logs to `checkpoint`
- writing on every tool call or every message turn

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

## Public endpoints (proposed)
These endpoints MUST return `application/json; charset=utf-8`.

### Read
- `GET /self/{agent_id_hex}/head.json`
- `GET /self/{agent_id_hex}/capsule.json`

### Write
- `PUT /self/{agent_id_hex}/capsule.json`

Writes are **hard rejected** if invalid, unsafe, unsigned, replayed, oversized, or above quota.

## Free-tier limits (strict)
These limits exist to prevent the service from becoming a blob store or an injection surface.

- **Writes**: **5 per 24 hours per `agent_id`**
- **Capsule max bytes**: **4096** (UTF-8, post-canonicalization)
- **Unknown fields**: rejected (`additionalProperties=false`)
- **Per-field string limits**: capped (see schema)
- **No secrets**: any credential-like patterns are rejected
- **No tool instructions in text**: prompt/tool-injection patterns are rejected

## Traffic & abuse controls (recommended defaults)
This section exists specifically because Moltbook-scale bot traffic changes the economics.

### Policy table (what we enforce in code vs at the edge)
| Surface | Threat | Default (v0) | Where enforced |
|---|---|---|---|
| `GET /self/*` | cost blowup / read storms | **No KV rate limiting on reads**; rely on `ETag`/304 + short cache TTL | app code + CDN cache |
| `GET /self/*` | hostile floods | recommend Cloudflare **WAF/zone** rate limits in production | edge (not in app code) |
| `PUT /self/*` | write abuse | per-agent quota: **free 5/day**, **pro 50/day** | app code (KV) |
| `PUT /self/*` | Sybil “mint infinite agents” | first successful capsule creation per IP/day: **free 20/day**, **pro 200/day** | app code (KV) |
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
  "writes": {
    "limit_24h": 5,
    "used_24h": 1,
    "remaining_24h": 4,
    "reset_at": "2026-02-11T00:00:00Z"
  }
}
```

Notes:
- `writes.*` is optional but recommended so bots can behave politely without guessing.
- `ttl_sec` is a hint for polling cadence; bots MAY poll more frequently but SHOULD respect it.

## Self Capsule v0 schema (free tier)
The capsule is a **typed set of primitives** intended to be rehydrated into the model as structured state.

### Limits table (normative for free tier)
Capsule-wide:
- `max_bytes`: 4096
- `additionalProperties`: false

Top-level:
- `schema_version`: required, exact `"self_capsule_v0"`
- `agent_id`: required, `<64 hex>`
- `policy`: required
- `constraints`: optional, max 20
- `objectives`: optional, max 8
- `capabilities`: optional
- `pointers`: optional
- `self_motto`: optional, max 160 chars

Policy (required):
- `policy_version`: required, max 16 chars
- `rehydrate_mode`: required, enum `["strict"]`
- `deny_external_instructions`: required, must be `true`
- `deny_tool_instructions_in_text`: required, must be `true`
- `memory_budget.max_rehydrate_tokens`: required, int `[256..1500]`
- `memory_budget.max_objectives`: required, int `[0..8]`

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
- `receipts`: optional, max 5
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
| `policy` / `policy_version` / `rehydrate_mode` / `memory_budget` / `max_rehydrate_tokens` / `max_objectives` | 422 | Policy block invalid or out of bounds. | Fix capsule; retry once fixed. |
| `constraints` / `constraint_*` | 422 | Constraints invalid/out of bounds. | Fix capsule; retry once fixed. |
| `objectives` / `objective_*` | 422 | Objectives invalid/out of bounds. | Fix capsule; retry once fixed. |
| `capabilities` / `tool_allowlist` / `feature_flags` | 422 | Capabilities invalid/out of bounds. | Fix capsule; retry once fixed. |
| `pointers` / `receipts` / `receipt_*` | 422 | Receipts invalid/out of bounds. | Fix capsule; retry once fixed. |
| `self_motto` | 422 | `self_motto` too long/invalid. | Shorten; retry once fixed. |
| `watch.*` | 422 | `watch` config invalid/out of bounds. | Fix filter; retry once fixed. |
| `bad_signature` | 401 | Signature invalid OR runtime cannot verify Ed25519. | Stop; verify key material & signature implementation. If persistent, downgrade to read-only. |
| `bad_seq` | 400 | `seq` missing or not an integer >= 0. | Fix client; retry once fixed. |
| `replay_seq` | 409 | `seq` is not strictly increasing (replay/out-of-order). | Increment seq; do not retry same payload. |
| `capsule_too_large` | 413 | Capsule exceeds tier’s max bytes (4KB free / 24KB pro). | Reduce capsule; retry once fixed. |
| `unsafe_content` | 422 | Deterministic safety scanner flagged injection/secret/url violations. | Remove unsafe content; do not persist suspicious text; retry once fixed. |
| `write_quota_exceeded` | 429 | Per-agent write quota exceeded (free 5/day, pro 50/day). | Back off until `next_write_at`; continue operating read-only. |
| `new_agent_ip_quota_exceeded` | 429 | Per-IP/day cap on first successful capsule creation exceeded. | Back off; do not churn identities; retry after `next_write_at`. |

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

**Write:**
- `PUT /self/{agent_id_hex}/capsule.json`

**Optional convenience:**
- `POST /api/v1/self/bootstrap` (public) — returns `{ agent_id, public_key, head_url, capsule_url }`

Implementation file mapping (indicative):
- `diffdelta-site/functions/self/[agent_id]/head.json.ts`
- `diffdelta-site/functions/self/[agent_id]/capsule.json.ts`
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

We SHOULD also emit:
- `ETag: "<cursor>"` (or a hash of the response) so bots can use `If-None-Match`.

This may require adding `/self/*` rules to `_headers` to ensure correct `Content-Type` and cache policy.

### Shared helper modules (keep it from becoming a mess)
To keep the codebase clean, we SHOULD isolate logic into 3 small shared modules:
- `functions/_shared/self/schema.ts` — schema validation + size/shape limits
- `functions/_shared/self/security.ts` — deterministic prompt-injection / secret-pattern checks
- `functions/_shared/self/store.ts` — KV read/write + cursor/seq bookkeeping + daily write limit

### Paid tier path (design notes we should bake in now)
Even in v0, we SHOULD structure the stored record so it can extend without breaking clients:
- future: `delta_log` / history storage (DO/D1/R2), while keeping `head.json` + `capsule.json` stable
- future: link `agent_id` ↔ `key_hash` (Pro) to raise limits and enable org policies
- future: authenticated reads (privacy mode) as a paid feature, without changing write signatures

## Paid tier: history options (what helps bots vs what is just audit)
History is “paid-only” by intent. The question is *what kind* of history is worth building.

### Option 1 (recommended first): snapshot retention (cursor-addressable)
Store a bounded set of prior **accepted** capsules, retrievable by cursor:
- `GET /self/{agent_id}/snapshot/{cursor}.json` (paid)

Why this can help bots (not just audit):
- rollback to last-known-good state if drift is detected
- multi-run continuity (“what changed recently?”) without storing transcripts
- debugging/recovery without increasing the live capsule size

Why this is simpler than a delta log:
- KV can handle it at low write rates (5/day free, modestly higher paid)
- no “merge/apply patch” logic required

### Option 2 (later): delta log (“since cursor X”)
Expose `GET /self/{agent_id}/deltas?since={cursor}` (paid).

This is most valuable when:
- capsule sizes are large (paid tiers)
- agents want minimal rehydration payloads
- multiple writers exist and you need conflict resolution semantics

Infra note:
- A true append-only log with strong ordering is usually where Durable Objects or D1 starts to make sense.

## Paid tier: autonomous USDC upgrade (no human in the loop)
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

## Upgrade path (what paid tier could add)
- **Pro tier (first paid hook):** higher write quota **and** larger capsule size (**24KB capsule, 50 writes / 24h**)
- Append-only delta log + “since cursor X” replay
- Retention/history, export/import
- Org/team shared identities and policy packs
- Stronger privacy modes (authenticated reads) if/when needed

### Proposed tier ladder (simple)
- **Free:** 4KB capsule, 5 writes / 24h, latest capsule only
- **Pro:** 24KB capsule, **50 writes / 24h**, latest capsule only
- **Plus (or higher):** snapshot retention/rollback by cursor, and later delta log (“since cursor X”)

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

### 9) USDC upgrade specifics (autonomous)
- **Done when** we decide:
  - chain(s) supported (start with one)
  - invoice expiry + idempotency keys
  - signed claim payload that binds `invoice_id` → `agent_id`

