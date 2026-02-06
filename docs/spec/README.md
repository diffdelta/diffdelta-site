# DiffDelta Specification & Reference Clients

A secure changefeed protocol for AI agents.

---

## Specification

- **[DiffDelta Feed Spec v1](./diffdelta-feed-spec.md)** — Normative protocol definition. Covers resources, cursor semantics, canonicalization, caching, error handling, degraded/fallback semantics, and the operator health dashboard.
- **[Client Quickstart](./client-quickstart.md)** — How a bot should poll DiffDelta, with code examples.

## Reference Clients

| Language | Path | Dependencies | 304 Support |
|---|---|---|---|
| **Python** | [`clients/python/diffdelta_client.py`](../../clients/python/diffdelta_client.py) | None (stdlib only) | ✅ ETag + disk cache |
| **TypeScript** | [`clients/typescript/diffdeltaClient.ts`](../../clients/typescript/diffdeltaClient.ts) | None (fetch API) | ✅ ETag + in-memory cache |

Both clients implement the same polling loop:

1. `fetchHead(sourceId)` — lightweight check with `If-None-Match`
2. `fetchLatest(url)` — full feed fetch (only when head says changed)
3. `walkBack(sourceId, limit)` — traverse archive history via `prev_cursor`

## JSON Schema

- [`diff.schema.json`](https://diffdelta.io/schema/v1/diff.schema.json) — Feed validation schema (JSON Schema 2020-12)
- [`known_issues.schema.json`](https://diffdelta.io/schema/v1/known_issues.schema.json) — Operational memory schema
- [`wellknown.schema.json`](https://diffdelta.io/schema/v1/wellknown.schema.json) — Discovery manifest schema

## Discovery

```bash
curl -s https://diffdelta.io/.well-known/diffdelta.json | jq .
```

## Links

- **Site:** [https://diffdelta.io](https://diffdelta.io)
- **Schema:** [/schema/v1/diff.schema.json](https://diffdelta.io/schema/v1/diff.schema.json)
