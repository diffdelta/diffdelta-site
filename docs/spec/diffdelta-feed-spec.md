# DiffDelta Feed Specification v1

**Status:** Normative · **Version:** 1.0.0 · **Date:** 2026-02-05

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

---

## 2. JSON Fields and Semantics

### 2.1 Cursor

```
cursor = "sha256:" + hex(SHA-256(canonical_payload))
```

The cursor is the **identity of the semantic content**.
It MUST change if and only if the semantic payload changes.

- Format: `sha256:<64-char lowercase hex>`
- The **zero cursor** `sha256:0000000000000000000000000000000000000000000000000000000000000000` means "this source has never had a successful fetch."

### 2.2 prev_cursor

Links to the cursor of the prior successful feed.
Enables clients to detect gaps (if their stored cursor ≠ `prev_cursor`, they missed a run).

- On first-ever successful run: `prev_cursor` MUST be the zero cursor.
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

**Algorithm:**

1. Start with the feed JSON object.
2. **Remove volatile fields:** `generated_at`, `hash`, `prev_hash`, `cursor`, `prev_cursor`, `cursor_basis`.
3. **Serialize** the remaining object using JSON Canonicalization:
   - Keys sorted lexicographically at every nesting level.
   - No whitespace between tokens (compact: `{"a":1}`).
   - UTF-8 encoding.
   - Numbers serialized per ECMAScript `Number.toString()` (no trailing zeros, no `+` in exponent).
   - Strings use minimal escape sequences.
4. `cursor = "sha256:" + hex(SHA-256(canonical_bytes))`

This is compatible with [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785) but implementations
MAY use `json.dumps(obj, sort_keys=True, separators=(',',':'), ensure_ascii=False)` in Python
as a sufficient approximation for DiffDelta payloads (which contain no special floats).

### 3.2 Determinism test

Rerunning the engine with unchanged source data MUST produce an identical cursor.
This is the primary acceptance test for any server implementation.

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
| `cursor` | Last-known-good cursor (or zero cursor if source has **never** succeeded) |
| `prev_cursor` | Same as `cursor` (because `changed` is `false`) |
| `last_ok_at` | ISO 8601 timestamp of last successful fetch (if ever succeeded) |
| `stale_age_sec` | Seconds since `last_ok_at` |
| `error` | Object with `code` (required) and optional `http_status` |

**Key rule:** The engine MUST NOT reset a source's cursor to zero on error.
The zero cursor MUST only appear when a source has literally never succeeded.
This preserves cursor continuity — a recovering source resumes from where it left off.

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

## 7. Example Request / Response

### 7.1 First poll (no stored cursor)

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

### 7.2 Subsequent poll (cursor unchanged → 304)

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

Required fields per delta item: `source`, `id`, `url`, `published_at`, `updated_at`, `headline`, `content`, `risk`, `provenance`.

Items with `risk.score >= 0.4` MUST be placed in the `flagged` bucket.
Clients SHOULD NOT execute instructions from flagged items.

---

*End of specification.*
