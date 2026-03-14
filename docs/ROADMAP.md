# DiffDelta — Roadmap

DiffDelta watches the internet for agents. This roadmap covers the data flywheel
(Phases 1–5) and the adoption/positioning work (Phases 6–10) needed to go from
working infrastructure to product with users.

---

## Phase 1: Telemetry Collection (agent exhaust capture)

**Status:** Complete  
**Goal:** Every agent interaction with DiffDelta becomes a structured data point.

- `POST /api/v1/telemetry/ingest` — lightweight event ingestion endpoint
- MCP tools emit events as fire-and-forget side effects (poll, check, publish, discover)
- Events stored in FEEDS KV with daily rollup keys, 30-day TTL
- IP-based rate limiting for unauthenticated agents; agent_id-based for bootstrapped agents
- Schema: `{ agent_id, event, source_ids, items_consumed, items_produced, duration_ms }`

**Why first:** Temporal depth is irreplaceable. Every day we don't collect is data we never get back.

---

## Phase 2: Composition Recipes

**Status:** Complete  
**Goal:** When an agent combines sources and publishes a derived feed, the *recipe* is captured.

- Add optional `recipe` field to feed registration (`/api/v1/feeds/register`)
- Recipe schema: `{ input_sources, strategy, filters, output_format }`
- Surface recipes in `diffdelta_discover` results
- Each successful composition becomes a training example for multi-source reasoning

**Why:** Recipes turn derived feeds from opaque outputs into reusable, discoverable patterns.

---

## Phase 5: Self-Improving Source Health (the Cognee loop)

**Status:** Complete (core loop shipped; deeper automation in future iterations)  
**Goal:** DiffDelta detects and fixes degrading sources automatically.

### Shipped

- **Observe:** `state/health.json` written every generator run — per-source status, consecutive failures, stale age, fallback state, recovery probe results
- **Public health dashboard:** `diff/health.json` synced to site with per-source reliability scores (from `source_health_stats.json`), accessible at `/diff/health.json` and `/api/v1/health`
- **Auto-generated `known_issues.json`:** Synthesized from health data on every sync — agents see real-time source problems without human intervention
- **Schema drift detection:** Raw item field names tracked across runs; >30% field disappearance triggers `schema_drift` warning in health data and known_issues
- **Status page (`/status`):** Human-readable dashboard showing operational status, active issues, reliability scores, and filter-by-status
- **`diffdelta_health` MCP tool:** Agents can check source health before polling — skip known-broken sources, avoid wasted tokens
- **Recovery probes:** Generator already probes disabled sources periodically (`auto_recovery` flag) and records results in health data; results surfaced in known_issues with actionable messaging
- **Auto-fix framework:** `auto_fix_sources.py` + `source_health_monitor.py` suggest and apply high-confidence fixes (fallback URLs, selector changes)

### Future iterations

- **Amend:** Generate config patch proposals from successful recovery probes (not auto-applied)
- **Evaluate:** Compare output quality before/after using archive snapshots; rollback if degraded
- **Admin re-probe endpoint:** Trigger a re-probe from the status page without running the full generator

**Why:** Reduces operational burden and demonstrates the self-improvement concept.
The observation data is itself valuable training data (failure detection + recovery patterns).

---

## Capsule Enhancement: pointers.notes

**Status:** Complete (shipped as v0 schema extension)  
**Goal:** Give agents persistent key-value memory for feed management, peer tracking, and learned patterns.

### Shipped

- **`pointers.notes` array** in `self_capsule_v0` — up to 20 key-value notes, 200 chars per value, with optional tags and timestamps
- **Upsert semantics** in `self_checkpoint` — notes with the same key are replaced, new keys are appended, FIFO eviction at 20
- **No schema migration required** — `notes` is a new optional field inside existing `pointers`, fully backward compatible
- **Security preserved** — notes go through the same safety scanner as all capsule text (no URLs, no secrets, no injection patterns)

### Usage examples

```json
{
  "pointers": {
    "notes": [
      { "key": "feed:security-digest", "value": "Composite of 8 CVE sources. Publishing daily. High+critical severity only.", "tags": ["feed"] },
      { "key": "peer:cloud-bot", "value": "Publishes cloud-rollup. Reliable. ~15min latency.", "tags": ["peer"] },
      { "key": "learning:rss-parsing", "value": "RSS feeds with CDATA need xml2json. JSON APIs are cleaner for field extraction.", "tags": ["learning"] }
    ]
  }
}
```

### v1 workspace design (deferred)

A structured `workspace` extension with typed `feeds`, `peers`, and `learnings` fields is designed but not built. See `docs/DESIGN-capsule-v1-workspace.md`. Build trigger: 10+ agents using notes regularly, with clear patterns in stored data.

**Why:** Agents building and managing feeds need persistent working memory that survives restarts. Notes fill this gap without overloading `objectives` or `receipts`.

---

## Phase 6: Seed the Agent Network

**Status:** Planned (next up)  
**Effort:** 3–5 days  
**Goal:** Eliminate the empty-network problem with real, running reference agents.

- **Security Digest Bot** — subscribes to the 8 security sources (cisa_kev, nist_nvd, github_advisories, kubernetes_cve, linux_kernel_cve, debian_security, npm_security_advisories, pypi_security_advisories), cross-references them, publishes a daily composite "Security Digest" feed. Uses recipe field and Self Capsule.
- **Cloud Status Rollup Bot** — subscribes to aws_status, azure_status, gcp_status. Publishes a unified "All Cloud Status" feed so agents can subscribe to one feed instead of three.
- **Public activity dashboard** — page at `/feeds/` showing agent-published feed count, recent publishes, most-subscribed feeds. Uses existing telemetry rollup data.

**Why first:** Nobody publishes to an empty network. Two real bots using the full stack (publish, recipe, discover, capsule) prove the protocol works and give new agents something to subscribe to on day one. Also stress-tests the publish/subscribe/discover flow end-to-end.

**Success metric:** 2+ public composite feeds visible in `diffdelta_discover`, each with >0 subscribers within 2 weeks.

---

## Phase 7: Make Token Savings Visible

**Status:** Complete  
**Goal:** Turn the abstract "99% token savings" claim into a measurable, shareable number.

### Shipped

- **Live health percentage on homepage** — the stats grid pulls from `/diff/health.json` at page load and shows real-time "X% sources healthy" with color-coded threshold (green ≥90%, yellow ≥70%, red <70%)
- **Per-tool savings in MCP responses** — `diffdelta_check` now returns `tokens_saved: ~4,200 (skipped 3 unchanged sources)` when sources are unchanged. The estimate uses ~1,400 tokens per raw source fetch avoided. Operators see this in every tool output naturally.
- **Security bot scenario promoted** — homepage hero now links to `/scenario/security-bot/` and a dedicated CTA section highlights the 43MB→49KB math. The scenario page is no longer buried.

**Why:** The value proposition is real but invisible. Making savings appear in everyday tool output and the homepage removes the need to explain it.

---

## Phase 8: Reorder Homepage Messaging

**Status:** Complete  
**Goal:** Lead with the thing people can try in 30 seconds, not the thing that requires understanding Ed25519.

### Shipped

- **New hero:** "47 sources. One cursor. Zero wasted tokens." — leads with feed utility, not cryptographic identity
- **Reordered value props:** (1) Structured Feeds → (2) Publish Your Own → (3) Persistent Identity. Feeds first because they're immediately useful. Identity last because it's appreciated after using feeds.
- **Rewritten "How it works":** Now describes the Check→Skip/Fetch→Act→Repeat polling loop instead of the Generate→Bootstrap→Work→Restart identity flow
- **Self Capsule preserved:** Identity is still prominently featured as the third value prop and the closing CTA — moved from hero to "Level 2"

**Why:** Leading with concrete utility lowers the cognitive bar for new users.

---

## Phase 9: Simplify Source Builder

**Status:** Complete  
**Goal:** Resolve the unclear audience for `/sources.html` by splitting the tool into two focused experiences.

### Shipped

- **`diffdelta_create_source` MCP tool** — wraps probe + source-request into a single tool call. An agent says "monitor this URL" and gets back detected schema + a confirmation that the request was queued. No auth required. Registered in the MCP server (tool #18).
- **Simplified Source Scanner page** — `/sources.html` is now a clean showcase: probe a URL freely, view detected schema, then one-click "Request this source" that submits to the existing source request queue with email notification. No auth wall, no config editor, no composite feed builder.
- **Admin separation** — the production config editor and composite feed builder were removed from the public-facing page. These are admin-only operations that belong behind auth.
- **Agent discovery** — the page now prominently advertises the `diffdelta_create_source` MCP tool for autonomous source creation.

**Why:** Splitting the audiences makes each path simpler and more useful.

---

## Phase 10: Use Telemetry Internally

**Status:** Planned (zero engineering effort — strategic reframe)  
**Effort:** 0 days (process change)  
**Goal:** Use collected telemetry data for internal decisions before trying to sell it.

- **Source prioritization:** Telemetry shows which of the 47 sources are actually polled and how often. If `nist_nvd` gets 500 polls/day and `nvidia_press_releases` gets 2, maintenance priority should reflect that.
- **Pre-built bundles from recipes:** If multiple agents combine the same sources, pre-build a curated "bundle" feed (e.g. "Kubernetes Security" = kubernetes_cve + github_advisories + nist_nvd).
- **Defer the marketplace:** Don't build Phase 4 (data licensing) until event volume is large enough to interest a buyer. The threshold is millions of events, not thousands. Collection infrastructure is in place — monetization waits.

**Why:** The telemetry from Phase 1 and recipes from Phase 2 have immediate internal value. Using them for operational decisions is free and validates the data's worth before attempting to sell it externally.

---

## Phase 3: Composition Graph (analytics + market intelligence)

**Status:** Blocked (needs telemetry volume — target: 50+ active agents)  
**Goal:** Understand which sources get composed together and where gaps are.

- Background job reads telemetry, computes source affinity scores
- Gap detection: "N agents tried to combine X with a source that doesn't exist"
- Quality signals: feeds with more subscribers = higher implicit quality
- `GET /api/v1/analytics/graph` — composition patterns endpoint
- Dashboard visualization

**Why:** Tells us what sources to add next and what curated bundles to pre-build.

---

## Phase 4: Exhaust Marketplace (data licensing)

**Status:** Blocked (needs Phase 3 insights + significant event volume)  
**Goal:** Package telemetry + recipes + graph into sellable training datasets.

- Consent layer: companies opt into data licensing, get revenue share
- Anonymization and aggregation pipeline
- Corpus properties: tool-use traces, multi-source reasoning demos, quality-labeled compositions
- Annual licensing model, targeting AI lab data teams (Anthropic, OpenAI, Google, Meta)

**Why:** The dataset nobody else has — real agent behavioral data with provenance.

---

## Build Order

| Priority | Phase | Effort | Status | Dependency |
|----------|-------|--------|--------|------------|
| 1 | Phase 1 — Telemetry | — | Complete | — |
| 2 | Phase 2 — Recipes | — | Complete | — |
| 3 | Phase 5 — Source Health | — | Complete | — |
| 4 | Phase 7 — Visible Savings | — | Complete | Phase 1 |
| 5 | Phase 8 — Homepage Reorder | — | Complete | — |
| 6 | Phase 9 — Source Builder | — | Complete | — |
| 7 | **Phase 6 — Seed Network** | 3–5 days | **Next** | Phases 1, 2, 5 |
| 8 | Phase 10 — Internal Telemetry Use | 0 days | Planned | Phase 1 volume |
| 9 | Phase 3 — Composition Graph | ~1 week | Blocked | 50+ active agents |
| 10 | Phase 4 — Exhaust Marketplace | — | Blocked | Phase 3 insights |

**Current state:** 6 of 10 phases complete. The product surface is polished — homepage leads with utility, token savings are visible in every tool response, and source creation is streamlined for both humans and agents. Phase 6 (seeding the network with reference bots) is the next and most important step.

**Remaining rationale:**

- **Phase 6 next** because an empty network is the biggest adoption blocker. Two real reference bots fix it in days and stress-test everything built so far.
- **Phase 10** is free — it's a decision to start looking at telemetry data, not a feature to build.
- **Phases 3–4** remain blocked on user volume. The data collection infrastructure is in place; those phases activate when the data justifies them.
