# DiffDelta — Data Flywheel Roadmap

DiffDelta watches the internet for agents. This roadmap extends it so agents
create value for each other — and the exhaust from all of it becomes training
data for the next generation of models.

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

## Phase 3: Composition Graph (analytics + market intelligence)

**Status:** Planned (needs Phase 1 volume — target: 50+ active agents)  
**Goal:** Understand which sources get composed together and where gaps are.

- Background job reads telemetry, computes source affinity scores
- Gap detection: "N agents tried to combine X with a source that doesn't exist"
- Quality signals: feeds with more subscribers = higher implicit quality
- `GET /api/v1/analytics/graph` — composition patterns endpoint
- Dashboard visualization

**Why:** Tells us what sources to add next and what curated bundles to pre-build.

---

## Phase 4: Exhaust Marketplace (data licensing)

**Status:** Planned (needs Phase 3 insights)  
**Goal:** Package telemetry + recipes + graph into sellable training datasets.

- Consent layer: companies opt into data licensing, get revenue share
- Anonymization and aggregation pipeline
- Corpus properties: tool-use traces, multi-source reasoning demos, quality-labeled compositions
- Annual licensing model, targeting AI lab data teams (Anthropic, OpenAI, Google, Meta)

**Why:** The dataset nobody else has — real agent behavioral data with provenance.

---

## Phase 5: Self-Improving Source Health (the Cognee loop)

**Status:** Planned  
**Goal:** DiffDelta detects and fixes degrading sources automatically.

- **Observe:** Health check in generator runs — item count drops, field changes, upstream errors
- **Inspect:** Re-run probe against source URL, compare detected schema to stored config
- **Amend:** Generate config patch proposals (not auto-applied)
- **Evaluate:** Compare output quality before/after using archive snapshots; rollback if degraded
- Store health + amendment history as `health.json` per source

**Why:** Reduces operational burden and demonstrates the self-improvement concept.
The observation data is itself valuable training data (failure detection + recovery patterns).

---

## Build Order

1. **Phase 1** — days, not weeks. Extends existing middleware patterns.
2. **Phase 2** — hours. Optional field on existing data structure.
3. **Phase 5** — ~1 week. Most user-facing impact.
4. **Phase 3** — after telemetry volume. Analytical layer.
5. **Phase 4** — after graph shows patterns. Business layer.

Each phase produces data that makes the next phase more valuable.
