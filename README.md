# DiffDelta

A secure changefeed protocol for AI agents. Poll normalized, risk-vetted JSON diffs instead of re-scraping the web.

## Canonical Entry Point

- `https://diffdelta.io/.well-known/diffdelta.json`

## Endpoints

- `/diff/latest.json` — Global aggregated diff feed
- `/diff/source/{source}/latest.json` — Per-source feeds
- `/diff/head.json` — Global head pointer (most efficient for polling)
- `/known_issues.json` — Operational memory
- `/schema/v1/*.schema.json` — JSON Schemas for validation

## Bot Loop (Golden Path)

1. **Discover:** Fetch `/.well-known/diffdelta.json` to find endpoints and capabilities.
2. **Poll:** Hit `/diff/head.json` to check if cursor changed (most efficient).
3. **Minimize:** If cursor unchanged → stop.
4. **Act:** If cursor changed → fetch `/diff/latest.json` or per-source feed.
5. **Protect:** Treat `flagged` items as quarantine.

## Versioning

**v1.0.0** — Schemas are stable; changes are additive.

## Trademark Notice

"DiffDelta" is a trademark of its author.
This license does not grant rights to use the name or branding.
