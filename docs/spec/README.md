# DiffDelta Specification & Reference Clients

Agent-ready intelligence feeds — normalized, risk-scored JSON changefeeds for autonomous agents.

---

## Specification

- **[DiffDelta Feed Spec v1](./diffdelta-feed-spec.md)** — Normative protocol definition. Covers resources, cursor semantics, canonicalization, caching, error handling, degraded/fallback semantics, and the operator health dashboard.
- **[Client Quickstart](./client-quickstart.md)** — How a bot should poll DiffDelta, with code examples.

## Client Libraries

### Python (Recommended)

```bash
pip install diffdelta
```

```python
from diffdelta import DiffDelta

dd = DiffDelta()
for item in dd.poll(tags=["security"]):
    print(f"{item.source}: {item.headline} (risk: {item.risk_score})")
```

Published on PyPI: [`diffdelta`](https://pypi.org/project/diffdelta/) (v0.1.1)
Source: [github.com/diffdelta/diffdelta-python](https://github.com/diffdelta/diffdelta-python)

Features: automatic cursor persistence, tag/source filtering, continuous monitoring (`dd.watch()`), `risk_score` as first-class field.

### Reference Clients (Spec-level)

| Language | Path | Dependencies | 304 Support |
|---|---|---|---|
| **Python** | [`clients/python/diffdelta_client.py`](../../clients/python/diffdelta_client.py) | None (stdlib only) | ✅ ETag + disk cache |
| **TypeScript** | [`clients/typescript/diffdeltaClient.ts`](../../clients/typescript/diffdeltaClient.ts) | None (fetch API) | ✅ ETag + in-memory cache |

Both reference clients implement the same polling loop:

1. `fetchHead(sourceId)` — lightweight check with `If-None-Match`
2. `fetchLatest(url)` — full feed fetch (only when head says changed)
3. `walkBack(sourceId, limit)` — traverse archive history via `prev_cursor`

## Pre-Built Recipes

The Python repo includes copy-paste-ready integrations:

| Recipe | Destination |
|--------|------------|
| `slack_alerts.py` | Slack webhook |
| `discord_alerts.py` | Discord webhook |
| `github_issues.py` | GitHub Issues (with dedup) |
| `pagerduty_trigger.py` | PagerDuty Events API |

Plus deployment templates for Docker, systemd, Kubernetes, and GitHub Actions.

## JSON Schema

- [`diff.schema.json`](https://diffdelta.io/schema/v1/diff.schema.json) — Feed validation schema (JSON Schema 2020-12)
- [`known_issues.schema.json`](https://diffdelta.io/schema/v1/known_issues.schema.json) — Operational memory schema
- [`wellknown.schema.json`](https://diffdelta.io/schema/v1/wellknown.schema.json) — Discovery manifest schema

## Discovery

```bash
curl -s https://diffdelta.io/.well-known/diffdelta.json | jq .
```

## Links

- **Site:** [diffdelta.io](https://diffdelta.io)
- **Python Client:** [pypi.org/project/diffdelta](https://pypi.org/project/diffdelta/)
- **GitHub:** [github.com/diffdelta](https://github.com/diffdelta)
- **Schema:** [/schema/v1/diff.schema.json](https://diffdelta.io/schema/v1/diff.schema.json)
- **Scenario:** [The Security Bot Scenario](https://diffdelta.io/scenario/security-bot)