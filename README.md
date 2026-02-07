# DiffDelta — Agent-Ready Intelligence Feeds

The world is full of intelligence — security advisories, status pages, changelogs — but it's trapped in HTML meant for human eyes. DiffDelta extracts it, scores it, and serves it as structured JSON your agents can consume in one API call, instead of burning thousands of tokens scraping websites.

**HTTP was built for humans. DiffDelta is built for agents.**

## Quickstart

```bash
pip install diffdelta
```

```python
from diffdelta import DiffDelta

dd = DiffDelta()
for item in dd.poll(tags=["security"]):
    print(f"{item.source}: {item.headline} (risk: {item.risk_score})")
```

That's it. Cursor persistence, change detection, and filtering are handled automatically.

## What You Get

- **35 sources** across security, cloud status, releases, and AI — all normalized to one schema
- **Two-step polling**: check `head.json` (400 bytes) first, only fetch the full feed if something changed
- **Risk scoring** on every item (0–10 scale) so agents can filter by severity
- **Pre-diffed output**: new, updated, and removed items in separate buckets
- **Batch narratives**: human/agent-readable summaries of what changed
- **Provenance chains**: evidence URLs and content hashes for auditability

## Architecture

```
[Upstream Sources] → [DiffDelta Generator] → [Static JSON on CDN]
                                                    ↓
                                          Agents poll /diff/head.json
                                          (400 bytes, cache-friendly)
                                                    ↓
                                          If changed → fetch /diff/latest.json
                                          (pre-diffed, risk-scored, summarized)
```

### Endpoints

| Endpoint | Purpose | Size |
|----------|---------|------|
| `/diff/head.json` | Change detection (poll this) | ~400 bytes |
| `/diff/latest.json` | Full aggregated feed | ~50–200 KB |
| `/diff/source/{id}/latest.json` | Per-source feed | ~5–30 KB |
| `/diff/sources.json` | Source index with metadata | ~8 KB |
| `/.well-known/diffdelta.json` | Discovery manifest | ~1 KB |
| `/schema/v1/*.schema.json` | JSON Schemas for validation | — |

### Bot Loop (Golden Path)

1. **Discover:** Fetch `/.well-known/diffdelta.json` to find endpoints and capabilities.
2. **Poll:** Hit `/diff/head.json` to check if cursor changed (~400 bytes).
3. **Minimize:** If cursor unchanged → stop. You burned 400 bytes, not 43MB.
4. **Act:** If cursor changed → fetch `/diff/latest.json` or per-source feed.
5. **Filter:** Use `tags`, `source`, or `risk_score` to find what matters.
6. **Save cursor:** Store `cursor` value for next poll.

## Python Client Library

Published on PyPI: [`diffdelta`](https://pypi.org/project/diffdelta/)

```bash
pip install diffdelta
```

| Method | What it does |
|--------|-------------|
| `dd.poll()` | Poll global feed, returns new items since last poll |
| `dd.poll(tags=["security"])` | Filter by tag |
| `dd.poll_source("cisa_kev")` | Poll a single source (smaller payload) |
| `dd.watch(callback)` | Continuous monitoring loop (polls every TTL) |
| `dd.sources()` | List all available sources |
| `dd.reset_cursors()` | Reset stored cursors |

Cursors are automatically persisted to `~/.diffdelta/cursors.json`. Override with `DD_CURSOR_PATH` env var or `cursor_path=` argument.

Source: [github.com/diffdelta/diffdelta-python](https://github.com/diffdelta/diffdelta-python)

## Recipes (Copy → Set Env Var → Run)

Pre-built integrations in the Python repo:

| Recipe | Destination | Setup |
|--------|------------|-------|
| `slack_alerts.py` | Slack channel | Set `SLACK_WEBHOOK_URL` |
| `discord_alerts.py` | Discord channel | Set `DISCORD_WEBHOOK_URL` |
| `github_issues.py` | GitHub Issues | Set `GITHUB_TOKEN` + `GITHUB_REPO` |
| `pagerduty_trigger.py` | PagerDuty | Set `PAGERDUTY_ROUTING_KEY` |

## Deployment Templates

| Method | Command |
|--------|---------|
| **Docker** | `docker run -d -e RECIPE=slack_alerts -e SLACK_WEBHOOK_URL=... diffdelta-agent` |
| **systemd** | Copy service file → `systemctl enable --now diffdelta-agent` |
| **Kubernetes** | `kubectl apply -f cronjob.yaml` (CronJob every 15 min) |
| **GitHub Action** | `uses: diffdelta/security-scan@v1` in your workflow |

## Pro Dashboard

Pro subscribers get a dashboard at `/pro` with:
- API key management (view masked key, rotate, revoke)
- Usage tracking (requests/min, requests remaining)
- Custom source onboarding (submit URLs for review)
- Billing portal (Stripe)
- Magic link authentication (passwordless login via email)

## Source Packs

| Pack | Sources | Tag |
|------|---------|-----|
| 🔒 **Security** | CISA KEV, NIST NVD, GitHub Advisories, Kubernetes CVEs, Linux Kernel CVEs, Ubuntu/Debian Security, OpenSSL, Erlang/OTP | `security` |
| ☁️ **Cloud Status** | AWS Health, Azure Status, GCP Status | `cloud-status` |
| 📦 **Releases** | Kubernetes, Docker, Terraform, Node.js, Python, Go, Rust, React, Next.js, and more | `releases` |

## Pricing

| Tier | Rate Limit | Custom Sources | Price |
|------|-----------|----------------|-------|
| **Free** | 60 req/min | — | $0 |
| **Pro** | 1,000 req/min | 2 onboardings | $29/mo |
| **Enterprise** | 5,000 req/min | Unlimited | Contact us |

## Anti-Firehose Guardrails

Every feed item includes:
- **`summary.logic`** — Why this item matters, in one sentence
- **`risk_score`** — 0–10 severity rating so agents can filter, not flood

These are mandatory. If we can't meaningfully score and summarize a source, we don't add it.

## Versioning

**v1.0.0** — Schemas are stable; changes are additive.

## Links

- **Site:** [diffdelta.io](https://diffdelta.io)
- **Python Client:** [pypi.org/project/diffdelta](https://pypi.org/project/diffdelta/)
- **GitHub:** [github.com/diffdelta](https://github.com/diffdelta)
- **Scenario:** [The Security Bot Scenario](https://diffdelta.io/scenario/security-bot)
- **Contact:** [human@diffdelta.io](mailto:human@diffdelta.io)

## Trademark Notice

"DiffDelta" is a trademark of its author.
This license does not grant rights to use the name or branding.
