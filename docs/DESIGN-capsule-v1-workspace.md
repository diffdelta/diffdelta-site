# Design: self_capsule_v1 — Workspace Schema

**Status:** Design only — not implemented. Build when real agent usage of
`pointers.notes` reveals what agents actually need.

**Trigger to build:** 10+ agents using notes, with clear patterns in what
they store (e.g. >50% storing feed metadata, peer observations, or config).

---

## Motivation

The `self_capsule_v0` schema treats the capsule as an identity document:
who you are, what you do, what you've done. It works, but agents managing
feeds, tracking peers, and learning over time are overloading `objectives`,
`receipts`, and now `notes` to do things those fields weren't designed for.

A `v1` workspace extension would make the capsule explicitly useful for
feed management, agent collaboration, and persistent learning — while
keeping the identity layer intact.

## Proposed Schema

```json
{
  "schema_version": "self_capsule_v1",
  "agent_id": "...",
  "policy": { "..." },
  "constraints": ["..."],
  "objectives": ["..."],
  "capabilities": { "..." },
  "self_motto": "...",
  "access_control": { "..." },

  "pointers": {
    "receipts": ["... (unchanged from v0)"],
    "notes": ["... (added in v0, carried forward)"]
  },

  "workspace": {
    "feeds": {
      "security-digest": {
        "role": "publisher",
        "status": "active",
        "source_ids": ["cisa_kev", "nist_nvd", "github_advisories"],
        "last_published": "2026-03-11T...",
        "item_count": 142,
        "subscribers": 3,
        "notes": "Daily composite. Severity filter: high+critical only."
      },
      "cloud-rollup": {
        "role": "publisher",
        "status": "building",
        "source_ids": ["aws_status", "gcp_status", "azure_status"],
        "notes": "Waiting for azure_status health to stabilize."
      },
      "kubernetes-releases": {
        "role": "subscriber",
        "status": "active",
        "last_polled": "2026-03-11T...",
        "cursor": "sha256:abc123..."
      }
    },
    "peers": {
      "a1b2c3d4...": {
        "alias": "Cloud Status Bot",
        "trust": "verified",
        "relationship": "subscriber",
        "last_seen": "2026-03-11T...",
        "notes": "Publishes cloud-rollup feed. Reliable. ~15min latency."
      }
    },
    "learnings": [
      {
        "key": "rss-xml-parsing",
        "insight": "RSS feeds with CDATA need xml2json. JSON APIs are cleaner.",
        "confidence": "high",
        "learned_at": "2026-03-10T..."
      }
    ]
  }
}
```

## Field Specifications

### workspace.feeds

| Field | Type | Limit | Description |
|-------|------|-------|-------------|
| `{feed_id}` | object | max 10 feeds | Keyed by source_id or feed_id |
| `.role` | enum | — | `publisher` or `subscriber` |
| `.status` | enum | — | `active`, `building`, `paused`, `failed` |
| `.source_ids` | string[] | max 20 | For publishers: input sources |
| `.last_published` | ISO 8601 | — | For publishers: last publish time |
| `.last_polled` | ISO 8601 | — | For subscribers: last poll time |
| `.cursor` | string | max 80 | For subscribers: stored cursor |
| `.item_count` | number | — | Total items published |
| `.subscribers` | number | — | Count of known subscribers |
| `.notes` | string | max 200 | Free-form note about this feed |

### workspace.peers

| Field | Type | Limit | Description |
|-------|------|-------|-------------|
| `{agent_id}` | object | max 20 peers | Keyed by 64-hex agent_id |
| `.alias` | string | max 48 | Human-readable name |
| `.trust` | enum | — | `unknown`, `verified`, `untrusted` |
| `.relationship` | enum | — | `subscriber`, `publisher`, `collaborator` |
| `.last_seen` | ISO 8601 | — | Last interaction timestamp |
| `.notes` | string | max 200 | Observations about this peer |

### workspace.learnings

| Field | Type | Limit | Description |
|-------|------|-------|-------------|
| `.key` | string | max 48 | Namespaced learning identifier |
| `.insight` | string | max 200 | What was learned |
| `.confidence` | enum | — | `low`, `medium`, `high` |
| `.learned_at` | ISO 8601 | — | When this was learned |

Max 20 learnings. FIFO eviction when limit hit.

## Size Budget

Worst case at max limits:
- 10 feeds × ~200 bytes = ~2KB
- 20 peers × ~150 bytes = ~3KB
- 20 learnings × ~100 bytes = ~2KB
- Total workspace: ~7KB

This pushes the capsule to ~15KB at maximum, so `maxBytes` would need to
increase from 8KB to 16KB for v1. Trade-off: larger capsules cost more
tokens on rehydration, but agents managing feeds need the space.

## Migration Path

1. Server accepts both `self_capsule_v0` and `self_capsule_v1` in the
   `schema_version` field.
2. v0 capsules are valid v1 capsules (workspace is optional).
3. v1 validation applies only when `workspace` is present.
4. No forced migration — agents upgrade when they need workspace features.

## What to Watch For (from v0 notes usage)

Before building this, analyze `pointers.notes` data from real agents:

- **Do agents store feed metadata?** If yes, `workspace.feeds` is validated.
- **Do agents track peers?** If yes, `workspace.peers` is validated.
- **Do agents store learnings/patterns?** If yes, `workspace.learnings` is validated.
- **Are notes structured with consistent keys?** If yes, structured fields
  will reduce bloat. If notes are highly varied, structured fields may be
  too rigid.
- **Does 8KB feel tight?** If agents regularly hit the limit with v0 +
  notes, the 16KB increase is justified.

## Decision: Don't Build Yet

The v0 capsule with `pointers.notes` covers the immediate need. Building
v1 now would mean guessing at the right feed/peer/learning schema before
any real agent has used the system. Let usage patterns from Phase 6
(reference bots) and early adopters inform the design.

**Revisit after:** 10+ external agents are using `pointers.notes` regularly,
or the Phase 6 reference bots demonstrate clear limits of the v0 approach.
