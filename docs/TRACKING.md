# DiffDelta Usage Tracking Guide

This document explains how to track usage of DiffDelta feeds to understand:
- Which endpoints are most popular
- How efficiently bots are using the three-layer protocol
- Source popularity
- Client library adoption
- Geographic distribution

---

## Current Limitations

**Static files bypass middleware:**
- `/diff/*.json` files are served directly from Cloudflare CDN
- No middleware execution → no tracking via Functions
- Cloudflare Analytics shows raw HTTP traffic but lacks endpoint-level insights

**What we can track:**
- ✅ API endpoints (`/api/*`) — go through middleware
- ✅ Rate limit counters (per-window, not aggregated)
- ✅ Pro tier usage (via `/api/v1/account`)

**What we can't track (without Logpush):**
- ❌ Static JSON file requests (`/diff/head.json`, `/diff/latest.json`)
- ❌ Cache hit rates (304 vs 200)
- ❌ Source-specific polling patterns
- ❌ Client library identification

---

## Solution 1: Cloudflare Logpush (Recommended)

**Best for:** Comprehensive tracking of all requests, including static files.

### Setup

1. **Cloudflare Dashboard** → Your domain (`diffdelta.io`) → **Analytics & Logs** → **Logpush**
2. **Create job** → Select **"HTTP Requests"**
3. **Choose destination:**
   - **Datadog** (free tier: 15GB/month) — best for querying
   - **Google Cloud Storage** — cheapest, requires processing
   - **AWS S3** — same as GCS
   - **Splunk** — enterprise option
   - **Custom webhook** — send to your own endpoint

### What You Get

Every HTTP request includes:
- `ClientIP` — IP address (anonymized if configured)
- `ClientRequestURI` — Full path (`/diff/head.json`, `/diff/source/cisa_kev/latest.json`)
- `ClientRequestMethod` — `GET`, `POST`, etc.
- `EdgeResponseStatus` — `200`, `304`, `404`, etc.
- `EdgeResponseBytes` — Response size
- `ClientRequestUserAgent` — Bot identification
- `ClientRequestHeaders` — Includes `X-DiffDelta-Key`, `If-None-Match`
- `ClientCountry` — Country code
- `ClientASN` — ASN number
- `CacheCacheStatus` — `HIT`, `MISS`, `DYNAMIC`

### Query Examples (Datadog)

```sql
-- Most popular endpoints (last 24h)
SELECT 
  split_part(@ClientRequestURI, '?', 1) as endpoint,
  count(*) as requests
FROM logs
WHERE @ClientRequestURI LIKE '/diff/%'
  AND @timestamp > now() - 1d
GROUP BY endpoint
ORDER BY requests DESC

-- 304 vs 200 (cursor reuse efficiency)
SELECT 
  CASE 
    WHEN @EdgeResponseStatus = 304 THEN '304 (cached)'
    WHEN @EdgeResponseStatus = 200 THEN '200 (fresh)'
    ELSE 'other'
  END as type,
  count(*) as count
FROM logs
WHERE @ClientRequestURI LIKE '%/head.json'
  AND @timestamp > now() - 1d
GROUP BY type

-- Source popularity
SELECT 
  regexp_extract(@ClientRequestURI, r'/diff/source/([^/]+)', 1) as source,
  count(*) as requests
FROM logs
WHERE @ClientRequestURI LIKE '/diff/source/%'
  AND @timestamp > now() - 7d
GROUP BY source
ORDER BY requests DESC

-- Client library identification
SELECT 
  @ClientRequestUserAgent as client,
  count(*) as requests
FROM logs
WHERE @ClientRequestURI LIKE '/diff/%'
  AND @timestamp > now() - 1d
GROUP BY client
ORDER BY requests DESC

-- Geographic distribution
SELECT 
  @ClientCountry as country,
  count(*) as requests
FROM logs
WHERE @ClientRequestURI LIKE '/diff/%'
  AND @timestamp > now() - 1d
GROUP BY country
ORDER BY requests DESC

-- Cache hit rate by endpoint
SELECT 
  split_part(@ClientRequestURI, '?', 1) as endpoint,
  @CacheCacheStatus as cache_status,
  count(*) as count
FROM logs
WHERE @ClientRequestURI LIKE '/diff/%'
  AND @timestamp > now() - 1d
GROUP BY endpoint, cache_status
ORDER BY endpoint, cache_status
```

### Cost

- **Cloudflare Logpush:** Free (included in Pro plan, $20/mo)
- **Datadog:** Free tier (15GB/month), then $0.10/GB
- **GCS/S3:** ~$0.01/GB storage + egress costs

---

## Solution 2: Custom Telemetry Endpoint (Lightweight)

**Best for:** Opt-in tracking without external services.

### Implementation

I've added two endpoints:

1. **`/telemetry/ping`** — Bots optionally ping this after each request
2. **`/api/v1/analytics`** — Dashboard endpoint to view aggregates

### Setup

1. **Create KV namespace:**
   ```bash
   wrangler kv:namespace create ANALYTICS
   ```
   Add to `wrangler.toml` or Cloudflare Pages dashboard.

2. **Update client libraries** (optional — bots can opt-in):
   ```python
   # After fetching head.json
   import requests
   requests.get("https://diffdelta.io/telemetry/ping", params={
       "endpoint": "/diff/head.json",
       "source": "cisa_kev",
       "client": "diffdelta-python/0.1.1",
       "cached": "true"  # if 304 response
   })
   ```

### What Gets Tracked

- Endpoint popularity (hourly/day buckets)
- Client library identification
- Source popularity
- Cache hit rates (304 vs 200)

### Limitations

- **Opt-in only** — bots must explicitly ping `/telemetry/ping`
- **KV doesn't support wildcards** — can't aggregate "all endpoints" efficiently
- **Not real-time** — aggregates are computed on read

**Recommendation:** Use Logpush for comprehensive tracking, telemetry endpoint for opt-in client library stats.

---

## Solution 3: Cloudflare Web Analytics (Privacy-Friendly)

**Best for:** High-level traffic overview without detailed endpoint breakdowns.

### Setup

1. **Cloudflare Dashboard** → **Web Analytics**
2. Enable for `diffdelta.io`
3. Add snippet to HTML pages (already included in `index.html`)

### What You Get

- Page views (HTML only, not JSON)
- Unique visitors
- Top referrers
- Geographic distribution
- Device types

**Limitation:** Only tracks HTML pages, not JSON feeds.

---

## Solution 4: Enhance Middleware (API Endpoints Only)

**Best for:** Tracking Pro tier API usage.

### Current State

Middleware already tracks:
- Rate limit counters (per-window)
- Authentication (tier identification)

### Enhancement Ideas

Add logging to middleware for `/api/*` requests:

```typescript
// In _middleware.ts, after rate limit check:
if (env.ANALYTICS && path.startsWith("/api/")) {
  const hour = Math.floor(Date.now() / 1000 / 3600);
  const key = `api:${hour}:${path}`;
  await env.ANALYTICS.put(key, String((parseInt(await env.ANALYTICS.get(key) || "0", 10)) + 1), {
    expirationTtl: 86400 * 7,
  });
}
```

This tracks API endpoint usage but **not** static JSON files.

---

## Recommended Approach

**For comprehensive tracking:**
1. ✅ **Set up Cloudflare Logpush** → Datadog or GCS
2. ✅ **Query logs** for endpoint popularity, cache hit rates, source popularity
3. ✅ **Create dashboards** (Datadog/Grafana) for real-time monitoring

**For client library adoption:**
1. ✅ **Add telemetry ping** to client libraries (opt-in)
2. ✅ **Track via `/telemetry/ping`** endpoint
3. ✅ **View aggregates** via `/api/v1/analytics`

**For Pro tier users:**
1. ✅ **Enhance `/api/v1/account`** to return usage stats
2. ✅ **Show in Pro dashboard** (`pro.html`)

---

## Metrics to Track

### Critical Metrics

1. **Endpoint popularity:**
   - `/diff/head.json` (most common — cursor checks)
   - `/diff/digest.json` (intelligence summary)
   - `/diff/latest.json` (full feed)
   - `/diff/source/{id}/head.json` (per-source polling)

2. **Protocol efficiency:**
   - **304 rate** — % of requests that are cached (high = bots using cursors correctly)
   - **Layer 1 → Layer 2 → Layer 3 ratio** — Are bots stopping at digest?

3. **Source popularity:**
   - Which sources get polled most?
   - Security vs releases vs cloud-status

4. **Client library adoption:**
   - `diffdelta-python/X.X.X`
   - `@diffdelta/client/X.X.X`
   - Raw HTTP (no library)

5. **Geographic distribution:**
   - Where are bots running?
   - CDN cache efficiency by region

### Business Metrics

1. **Free vs Pro tier:**
   - Requests by tier (via `X-DiffDelta-Key` header)
   - Conversion rate (free → Pro)

2. **Rate limit hits:**
   - How many bots hit 429?
   - Which tier?

3. **Error rates:**
   - 404s (invalid endpoints)
   - 500s (server errors)

---

## Next Steps

1. **Set up Logpush** → Datadog (easiest) or GCS (cheapest)
2. **Create dashboards** for key metrics
3. **Update client libraries** to optionally ping `/telemetry/ping`
4. **Enhance Pro dashboard** to show usage stats from `/api/v1/account`

---

## Questions?

- **Logpush setup:** See [Cloudflare docs](https://developers.cloudflare.com/logs/logpush/)
- **Datadog queries:** See [Datadog Logs](https://docs.datadoghq.com/logs/)
- **Telemetry endpoint:** See `functions/telemetry/ping.ts`
