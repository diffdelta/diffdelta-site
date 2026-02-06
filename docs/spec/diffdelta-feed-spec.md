# DiffDelta Feed Specification v1

**Status:** Normative · **Version:** 1.1.0 · **Date:** 2026-02-06

Key words: **MUST**, **MUST NOT**, **SHOULD**, **MAY** per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Resources

A DiffDelta server exposes three resource types per source.
All bodies are `application/json; charset=utf-8`.

| Resource | URL pattern | Mutability |
|---|---|---|
| **Head pointer** | `/diff/{source_id}/head.json` | Mutable (overwritten each run) |
| **Latest feed** | `/diff/{source_id}/latest.json` | Mutable (overwritten each run) |
| **Archive snapshot** | `/archive/{source_id}/{YYYY}/{MM}/{DD}/{YYYYMMDDTHHMMSSZ}_{cursor_hex}.json` | **Immutable** |
| **Health dashboard (operator)** | `/state/health.json` | Mutable (overwritten each run) |

A **global** aggregated feed is also available at `/diff/latest.json`.

### 1.1 Head pointer

Minimal JSON containing only the fields a bot needs to decide "should I fetch more?":

```json
{
  "cursor": "sha256:ab12…",
  "prev_cursor": "sha256:cd34…",
  "changed": true,
  "generated_at": "2026-02-05T12:00:00Z",
  "ttl_sec": 300,
  "latest_url": "/diff/aws_whats_new/latest.json"
}
```

### 1.2 Latest feed

Full feed conforming to the [diff.schema.json](https://diffdelta.io/schema/v1/diff.schema.json).
Contains `buckets` (new, updated, removed, flagged), per-source status, and all delta items.

### 1.3 Archive snapshot

Byte-identical copy of `latest.json` at the time it was written.
Once created, the file MUST NOT be modified or deleted.
Archive path includes the cursor hex (first 12 chars) for human readability.

### 1.4 Health dashboard (operator)

`/state/health.json` is an **operator-only** endpoint for fleet monitoring.
It is not required for bot consumption and MAY be private or access-controlled.
It summarizes per-source status, consecutive failures, stale age, and fallback use.

---

## 2. JSON Fields and Semantics

### 2.1 Cursor

```
cursor = "sha256:" + hex(SHA-256(canonical_payload))
```

The cursor is the **identity of the semantic content**.
It MUST change if and only if the semantic payload changes.

- Format: `sha256:<64-char lowercase hex>` or `null`.
- `null` means "this source has **never** had a successful fetch."
  Clients MUST treat `null` as "no data available yet" — not as a
  resettable sentinel.
- The legacy **zero cursor** `sha256:0000…0000` (64 zeros) is
  equivalent to `null` for backward compatibility.  Servers SHOULD
  emit `null` for new deployments.  Clients MUST treat both identically.

### 2.2 prev_cursor

Links to the cursor of the prior successful feed.
Enables clients to detect gaps (if their stored cursor ≠ `prev_cursor`, they missed a run).

- On first-ever successful run: `prev_cursor` MUST be `null` (or the zero cursor).
- On subsequent runs: `prev_cursor` MUST equal the `cursor` of the prior run.

### 2.3 changed

Boolean. `true` if new semantic content exists since `prev_cursor`.

**Invariants (normative):**

| `changed` | Cursor rule |
|---|---|
| `true` | `cursor` MUST differ from `prev_cursor` |
| `false` | `cursor` MUST equal `prev_cursor` |

### 2.4 generated_at

ISO 8601 timestamp of when this feed was produced.
This field is **volatile** — it MUST be excluded from cursor computation (§3).

### 2.5 ttl_sec

Recommended polling interval in seconds.
Clients SHOULD NOT poll more frequently than `ttl_sec`.

### 2.6 hash / prev_hash

SHA-256 of the file as written to disk (includes `generated_at` and all fields).
Unlike `cursor`, `hash` changes on every write even if content is identical.
Useful for integrity verification of the stored file.

---

## 3. Cursor Canonicalization

Cursor computation uses a deterministic canonical form so that identical
semantic content always produces the same cursor, regardless of generation time.

### 3.1 Method: `canonical_v1`

Servers SHOULD include `"cursor_basis": "canonical_v1"` in feeds to declare the method.

> **LOCKED.** The `canonical_v1` computation is a permanent contract.
> Adding new fields to the feed payload MUST NOT change the cursor
> unless those fields are part of the canonical input defined below.
> This prevents a **thundering herd** on schema evolution — without
> this guarantee, a field addition would change every cursor and cause
> every bot on Earth to fetch full payloads simultaneously.

**Canonical input (exhaustive list):**

The cursor is computed over a deterministic representation of these
fields **only**:

- Per item: `id`, `url`, `content_hash` (from `provenance.content_hash`)
- Items sorted by `(source, id)`.
- All items across all buckets concatenated in bucket order: `new`, `updated`, `removed`, `flagged`.
- `sources_included` array (sorted).

Fields **excluded** from cursor computation (volatile / metadata):

`generated_at`, `hash`, `prev_hash`, `cursor`, `prev_cursor`,
`cursor_basis`, `batch_narrative`, `counts`, `sources` (the status map),
`ttl_sec`, `integrity_reset`, `integrity_risk`, `_discovery`,
`archive_url`, `prev_archive_url`.

**Algorithm:**

1. Build a list of `(source, id, content_hash)` tuples from all bucket items.
2. Sort lexicographically.
3. Serialize as JSON array using canonical form (sorted keys, compact separators, UTF-8).
4. Prepend `sources_included` (sorted) as a JSON array.
5. `cursor = "sha256:" + hex(SHA-256(canonical_bytes))`

This is compatible with [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785) but implementations
MAY use `json.dumps(obj, sort_keys=True, separators=(',',':'), ensure_ascii=False)` in Python
as a sufficient approximation for DiffDelta payloads (which contain no special floats).

### 3.2 Determinism test

Rerunning the engine with unchanged source data MUST produce an identical cursor.
This is the primary acceptance test for any server implementation.

### 3.3 Evolution rule

New fields MAY be added to feeds at any time.  Clients MUST ignore
unknown fields.  Because the cursor computation is locked to the
canonical input above, new fields do **not** change existing cursors.

If a future schema version requires a new canonical form, it MUST use
a new `cursor_basis` value (e.g. `canonical_v2`) and a new major
`schema_version`.  Servers SHOULD serve both versions at different
paths (`/v1/diff/…`, `/v2/diff/…`) during the transition.

---

## 4. Ordering Requirements

To ensure stable cursor computation:

- `sources_included` array MUST be sorted alphabetically.
- `sources` object keys MUST be serialized in alphabetical order.
- `buckets.new`, `buckets.updated`, `buckets.removed`, `buckets.flagged` arrays
  MUST be sorted deterministically: by `published_at` (ascending), then `source`, then `id`.
- Clients MUST treat missing bucket arrays as empty (`[]`).
- Clients MAY ignore unknown bucket types for forward compatibility.

---

## 5. Error and Disabled Sources

When a source has `status: "error"` or `status: "disabled"`:

| Field | Value |
|---|---|
| `changed` | `false` |
| `stale` | `true` |
| `cursor` | Last-known-good cursor, or `null` if source has **never** succeeded |
| `prev_cursor` | Same as `cursor` (because `changed` is `false`) |
| `stale_since` | ISO 8601 timestamp when the source entered stale state |
| `last_ok_at` | ISO 8601 timestamp of last successful fetch (if ever succeeded) |
| `stale_age_sec` | Seconds since `last_ok_at` |
| `error` | Object with `code` (required) and optional `http_status` — **only** on `status: "error"` |
| `disabled_reason` | String explaining why the source is disabled — **only** on `status: "disabled"` |
| `consecutive_failures` | Integer count of sequential failures (optional; **only** on error/backoff states) |

**Key rule:** The engine MUST NOT reset a source's cursor to `null` on error.
`null` MUST only appear when a source has literally never succeeded.
This preserves cursor continuity — a recovering source resumes from where it left off.

### 5.1 Per-source `delta_counts`

When `changed: true`, the per-source entry in the `sources` map MUST include:

```json
"delta_counts": { "new": 12, "updated": 0, "removed": 0 }
```

This lets bots decide which sources to dig into without scanning bucket arrays.
When `changed: false`, `delta_counts` MUST be omitted (zero bloat).

### 5.2 Degraded Sources (fallback succeeded)

When a source has `status: "degraded"` it means the **primary endpoint failed**
but a configured fallback endpoint succeeded. The feed is valid but should be
treated as degraded until the primary recovers.

Required fields (in addition to normal source status fields):

| Field | Value |
|---|---|
| `status` | `"degraded"` |
| `fallback_active` | `true` |
| `fallback_index` | Integer index of the successful fallback (0-based) |
| `degraded_reason` | String (e.g. `"primary_endpoint_failed"`) |

Clients SHOULD continue to process degraded feeds normally, but MAY surface
a warning to operators.

---

## 6. HTTP Caching Behavior

### 6.1 ETag

The server MUST set `ETag` on `head.json` and `latest.json` responses.

When serving feeds from a static host behind a CDN (e.g., Cloudflare Pages),
the CDN typically generates its own ETag (often an MD5 of the file content).
This is acceptable — the 304 mechanism works correctly regardless of whether
the ETag equals the cursor.

**Normative:**

- If the server controls ETag generation, ETag SHOULD equal the quoted cursor:
  `ETag: "sha256:ab12cd34…"`
- If a CDN proxy generates its own ETag, clients MUST still use it for
  `If-None-Match` and MUST NOT assume ETag == cursor.
- The **cursor** field in the JSON body remains the authoritative stop condition.
  Clients compare `cursor` against their stored cursor to detect changes,
  and use `ETag` / `If-None-Match` purely for HTTP-level bandwidth savings.

### 6.2 If-None-Match (304 handling)

When a client sends `If-None-Match` with the ETag from a prior response,
the server (or CDN) MUST return `304 Not Modified` with an empty body
if the underlying file has not changed.

### 6.3 CDN Edge Caching

To enable edge caching (serving repeated requests from CDN PoPs without
hitting origin), servers SHOULD set `CDN-Cache-Control` alongside
`Cache-Control`:

```
Cache-Control: public, max-age=60, must-revalidate
CDN-Cache-Control: public, max-age=60, must-revalidate
```

This ensures the CDN caches at the edge (not just passes through),
so multiple bots polling from the same region share the cached response.

For archive snapshots, the CDN MUST cache immutably:

```
Cache-Control: public, max-age=31536000, immutable
CDN-Cache-Control: public, max-age=31536000, immutable
```

### 6.4 Cache-Control directives

| Resource | Cache-Control | CDN-Cache-Control |
|---|---|---|
| `head.json` | `public, max-age=60, must-revalidate` | same |
| `latest.json` | `public, max-age=60, must-revalidate` | same |
| `archive/*.json` | `public, max-age=31536000, immutable` | same |
| `schema/*.json` | `public, max-age=31536000, immutable` | same |

### 6.5 Content-Type

All feed responses MUST use `Content-Type: application/json; charset=utf-8`.

---

## 7. Operator Health Dashboard (`/state/health.json`)

This endpoint is intended for **operators**, not bots. It allows quick
diagnosis of fleet health without parsing feed files. Servers MAY restrict
access or omit it entirely.

**Example:**

```json
{
  "generated_at": "2026-02-06T18:00:00Z",
  "schema_version": "1.1.0",
  "summary": {
    "total": 24,
    "ok": 20,
    "degraded": 2,
    "error": 1,
    "disabled": 1,
    "health_pct": 91.7
  },
  "sources": {
    "openai_api_changelog": {
      "status": "degraded",
      "fallback_active": true,
      "fallback_index": 0,
      "degraded_reason": "primary_endpoint_failed"
    },
    "github_changelog": {
      "status": "disabled",
      "consecutive_failures": 7,
      "stale": true,
      "stale_age_sec": 86400
    }
  }
}
```

Fields are **informational**; bots MUST ignore this endpoint in normal polling.

---

## 8. Example Request / Response

### 8.1 First poll (no stored cursor)

```http
GET /diff/aws_whats_new/head.json HTTP/1.1
Host: diffdelta.io
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
ETag: "sha256:9bab0adf65dd53c…"
Cache-Control: public, max-age=300, must-revalidate

{
  "cursor": "sha256:9bab0adf65dd53c…",
  "prev_cursor": "sha256:000000000000000…",
  "changed": true,
  "generated_at": "2026-02-05T12:00:00Z",
  "ttl_sec": 300,
  "latest_url": "/diff/aws_whats_new/latest.json"
}
```

Client sees `changed: true` → fetches `latest_url` for full feed.

### 8.2 Subsequent poll (cursor unchanged → 304)

```http
GET /diff/aws_whats_new/head.json HTTP/1.1
Host: diffdelta.io
If-None-Match: "sha256:9bab0adf65dd53c…"
```

```http
HTTP/1.1 304 Not Modified
ETag: "sha256:9bab0adf65dd53c…"
Cache-Control: public, max-age=300, must-revalidate
```

Client receives zero bytes of body → no processing needed.

### 7.3 Archive fetch (immutable)

```http
GET /archive/aws_whats_new/2026/02/05/20260205T120000Z_9bab0adf65dd.json HTTP/1.1
Host: diffdelta.io
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=31536000, immutable

{ … full feed snapshot … }
```

---

## 8. Discovery

Servers MUST publish a discovery manifest at `/.well-known/diffdelta.json` containing:

- `endpoints.diff_latest` — global feed URL
- `endpoints.diff_by_source_template` — URL template with `{source}` placeholder
- `polling.recommended_ttl_sec` — suggested default polling interval
- `sources_supported` — array of available source IDs
- `capabilities.etag_supported` — boolean (MUST be `true` for compliant servers)
- `capabilities.cursor_supported` — boolean (MUST be `true`)

---

## 9. Schema Reference

Feed payloads MUST conform to [diff.schema.json](https://diffdelta.io/schema/v1/diff.schema.json) (JSON Schema 2020-12).

Required fields per delta item: `source`, `id`, `url`, `published_at`, `updated_at`, `headline`, `content`, `provenance`.

**`risk` is optional.**  When omitted, clients MUST treat it as
`{ "score": 0.0, "reasons": [] }`.  Servers SHOULD omit `risk` entirely
when `score == 0.0` and `reasons` is empty, to reduce payload size.
When present, `reasons` MAY also be omitted if the list is empty.

Items with `risk.score >= 0.4` MUST be placed in the `flagged` bucket.
Clients SHOULD NOT execute instructions from flagged items.

---

## 10. Authentication & Rate Limits

| Header | Status | Purpose |
|---|---|---|
| `X-DiffDelta-Key` | **Active** | API key for rate-limit tiers. Servers MUST NOT *require* this header — feeds MUST remain accessible without it. Clients SHOULD send it if configured. |

### Tiers

| Tier | Key Required | Rate Limit | Features |
|---|---|---|---|
| **Free** | No | 60 req/min per IP | Full feed & archive access |
| **Pro** | `dd_live_*` | 1,000 req/min per key | Webhook push, analytics, key rotation |
| **Enterprise** | `dd_live_*` | 5,000+ req/min per key | Custom sources, SLA, SSO |

### Response Headers

All feed responses include rate-limit information:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1738800120
X-DiffDelta-Tier: pro          # Only present for authenticated requests
```

### Key Format

API keys use the format `dd_live_` followed by 32 base62 characters (~190 bits of entropy). Keys are transmitted via the `X-DiffDelta-Key` request header. The server stores only SHA-256 hashes of keys.

### Key Management Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/v1/checkout` | GET | None | Redirect to Stripe Checkout for Pro subscription |
| `/api/v1/key/claim` | GET | None | Claim API key after payment (`?session_id=xxx`) |
| `/api/v1/key/info` | GET | Required | View key details and tier status |
| `/api/v1/key/rotate` | POST | Required | Rotate key (invalidates old, returns new) |

### Backward Compatibility

Adding authentication is **not** a breaking change. Free tier access remains fully functional without a key. The `X-DiffDelta-Key` header is optional and ignored by servers that have not activated authentication.

---

## 11. Append-Only Evolution Contract

This protocol follows an **append-only** schema evolution rule:

- New fields MAY be added to any JSON object at any time.
- Existing fields MUST NOT be removed, renamed, or have their type changed.
- Clients MUST ignore unknown fields (forward compatibility).
- Cursor computation is **locked** to `canonical_v1` (§3.1) and MUST NOT change without a new major `schema_version`.

This is the [protobuf/JSON API design principle](https://cloud.google.com/apis/design/compatibility). Every field added is permanent debt multiplied by `(bots × polls × forever)`. The bar for adding a field should be extremely high.

---

*End of specification.*
