/**
 * DiffDelta Reference Client — TypeScript
 *
 * Zero external dependencies.  Uses the standard `fetch` API (Node 18+ / browsers).
 * Implements the DiffDelta Feed Spec v1.1 polling protocol.
 *
 * **Key behavior:** Every call to `poll()` or `fetchLatest()` goes through
 * head.json first, sends `If-None-Match` with the cached ETag, and only
 * fetches the full payload when content has actually changed.
 * This is not optional — it's how the protocol scales.
 *
 * @example
 * ```ts
 * const client = new DiffDeltaClient("https://diffdelta.io");
 *
 * // Recommended: use poll() — head-first by default
 * const feed = await client.poll("aws_whats_new");
 * if (feed) {
 *   for (const item of feed.buckets.new) console.log(item.headline);
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadPointer {
  cursor: string | null;
  prev_cursor: string | null;
  changed: boolean;
  generated_at: string;
  ttl_sec: number;
  latest_url: string;
}

export interface SourceStatus {
  name?: string;
  changed: boolean;
  cursor: string | null;
  prev_cursor: string | null;
  ttl_sec: number;
  status: "ok" | "error" | "disabled" | "unknown";
  delta_counts?: { new: number; updated: number; removed: number };
  stale?: boolean;
  stale_since?: string;
  stale_age_sec?: number;
  last_ok_at?: string;
  error?: { code: string; http_status?: number };
  disabled_reason?: string;
  latest_url?: string;
  head_url?: string;
}

export interface DeltaItem {
  source: string;
  id: string;
  url: string;
  headline: string;
  published_at: string;
  updated_at: string;
  /** Optional — omitted when score==0 and no reasons.  Treat missing as {score:0}. */
  risk?: { score: number; reasons?: string[] };
  provenance: {
    fetched_at: string;
    evidence_urls: string[];
    content_hash: string;
  };
  content: { lang: string; excerpt_text?: string };
  item_hash?: string;
  [key: string]: unknown;
}

export interface Feed {
  schema_version: string;
  generated_at: string;
  cursor: string | null;
  prev_cursor: string | null;
  changed: boolean;
  ttl_sec: number;
  sources_included: string[];
  sources: Record<string, SourceStatus>;
  buckets: {
    new: DeltaItem[];
    updated: DeltaItem[];
    removed: DeltaItem[];
    flagged: DeltaItem[];
    [key: string]: DeltaItem[];
  };
  batch_narrative: string;
  cursor_basis?: string;
  _discovery?: Record<string, string>;
  [key: string]: unknown;
}

export interface FetchHeadResult {
  /** True if there is new semantic content since the last poll. */
  changed: boolean;
  /** Head pointer JSON, or null on 304. */
  head: HeadPointer | null;
}

// ---------------------------------------------------------------------------
// In-memory cursor / ETag cache
// ---------------------------------------------------------------------------

class CursorCache {
  private data: Map<string, string> = new Map();

  get(key: string): string | undefined {
    return this.data.get(key);
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const USER_AGENT = "diffdelta-ts-client/0.2.0";

export class DiffDeltaClient {
  private baseUrl: string;
  private timeout: number;
  private cache: CursorCache;

  /**
   * @param baseUrl  Origin of the DiffDelta server.
   * @param timeout  HTTP timeout in milliseconds (default 15 000).
   */
  constructor(baseUrl = "https://diffdelta.io", timeout = 15_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeout = timeout;
    this.cache = new CursorCache();
  }

  // -- HTTP helpers --------------------------------------------------------

  private async httpGet<T>(
    url: string,
    etag?: string
  ): Promise<{ status: number; body: T | null; etag: string | null }> {
    const fullUrl = url.startsWith("http")
      ? url
      : `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (etag) {
      headers["If-None-Match"] = `"${etag}"`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(fullUrl, {
        headers,
        signal: controller.signal,
      });

      const respEtag = (resp.headers.get("etag") ?? "").replace(/"/g, "");

      if (resp.status === 304) {
        return { status: 304, body: null, etag: respEtag };
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} from ${fullUrl}`);
      }

      const body = (await resp.json()) as T;
      return { status: resp.status, body, etag: respEtag };
    } finally {
      clearTimeout(timer);
    }
  }

  // -- public API ----------------------------------------------------------

  /**
   * Poll the head pointer for a source.
   *
   * Sends `If-None-Match` with the locally cached ETag.
   * Returns `{ changed: false, head: null }` on 304.
   */
  async fetchHead(sourceId: string): Promise<FetchHeadResult> {
    const cacheKey = `etag:${sourceId}`;
    const storedEtag = this.cache.get(cacheKey);

    const url = `/diff/${sourceId}/head.json`;
    const { status, body, etag } = await this.httpGet<HeadPointer>(
      url,
      storedEtag
    );

    if (status === 304) {
      return { changed: false, head: null };
    }

    if (etag) {
      this.cache.set(cacheKey, etag);
    }

    const changed = body?.changed ?? true;
    return { changed, head: body };
  }

  /**
   * Head-first poll for a source.  Returns the feed or null.
   *
   * **This is the recommended entry point.**  It:
   * 1. Checks head.json (with If-None-Match).
   * 2. Returns `null` immediately on 304 or `changed: false`.
   * 3. Fetches latest.json only when content has actually changed.
   */
  async poll(sourceId: string): Promise<Feed | null> {
    const { changed, head } = await this.fetchHead(sourceId);
    if (!changed || !head) return null;
    if (!head.changed) return null;

    const latestUrl = head.latest_url ?? `/diff/${sourceId}/latest.json`;
    return this.fetchDirect<Feed>(latestUrl);
  }

  /**
   * Head-first poll for the global aggregated feed.
   * Returns the full feed, or null if nothing changed.
   */
  async pollGlobal(): Promise<Feed | null> {
    const cacheKey = "etag:_global";
    const storedEtag = this.cache.get(cacheKey);

    const { status, body, etag } = await this.httpGet<HeadPointer>(
      "/diff/head.json",
      storedEtag
    );

    if (status === 304) return null;

    if (etag) {
      this.cache.set(cacheKey, etag);
    }

    if (!(body?.changed ?? true)) return null;

    return this.fetchDirect<Feed>("/diff/latest.json");
  }

  /**
   * Fetch latest feed for a source, head-first.
   *
   * Equivalent to `poll()` — exists for backward compatibility.
   */
  async fetchLatest(sourceId: string): Promise<Feed | null> {
    return this.poll(sourceId);
  }

  /** Fetch the global aggregated feed, head-first. */
  async fetchGlobal(): Promise<Feed | null> {
    return this.pollGlobal();
  }

  /**
   * Fetch a URL directly (no head check).
   *
   * Use ONLY when you already know content has changed
   * (e.g. after walking the archive).
   */
  async fetchDirect<T>(url: string): Promise<T> {
    const { body } = await this.httpGet<T>(url);
    if (!body) throw new Error(`Empty response from ${url}`);
    return body;
  }

  /**
   * Walk the archive chain for historical snapshots.
   *
   * Fetches `/archive/{sourceId}/index.json` and retrieves up to
   * `limit` snapshots (newest first).  For onboarding / catchup only.
   */
  async walkBack(sourceId: string, limit = 10): Promise<Feed[]> {
    const snapshots: Feed[] = [];

    let index: { snapshots?: Array<{ url?: string }> };
    try {
      index = await this.fetchDirect(`/archive/${sourceId}/index.json`);
    } catch {
      return snapshots;
    }

    const entries = index.snapshots ?? [];
    const recent = entries.slice(-limit).reverse();

    for (const entry of recent) {
      if (!entry.url) continue;
      try {
        const snap = await this.fetchDirect<Feed>(entry.url);
        snapshots.push(snap);
      } catch {
        break;
      }
    }

    return snapshots;
  }
}

// ---------------------------------------------------------------------------
// CLI demo (Node.js)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const baseUrl = process.env.DIFFDELTA_BASE_URL ?? "https://diffdelta.io";
  const sourceId = process.argv[2] ?? "aws_whats_new";

  const client = new DiffDeltaClient(baseUrl);

  console.log(`Polling ${baseUrl} for source '${sourceId}' …`);
  const feed = await client.poll(sourceId);

  if (!feed) {
    console.log("Nothing new (304 or changed:false). Done.");
    return;
  }

  console.log(`Changed! Cursor: ${(feed.cursor ?? "null").slice(0, 24)}…`);

  for (const bucket of ["new", "updated", "removed", "flagged"] as const) {
    const items = feed.buckets[bucket] ?? [];
    if (items.length > 0) {
      console.log(`\n  [${bucket}] ${items.length} item(s):`);
      for (const item of items.slice(0, 5)) {
        const flag = (item.risk?.score ?? 0) >= 0.4 ? " ⚠" : "";
        console.log(`    • ${item.headline ?? "(no headline)"}${flag}`);
      }
      if (items.length > 5) {
        console.log(`    … and ${items.length - 5} more`);
      }
    }
  }

  console.log("\nDone.");
}

// Run if executed directly (Node / tsx / ts-node)
main().catch(console.error);
