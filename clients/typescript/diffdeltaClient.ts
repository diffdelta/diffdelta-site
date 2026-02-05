/**
 * DiffDelta Reference Client — TypeScript
 *
 * Zero external dependencies.  Uses the standard `fetch` API (Node 18+ / browsers).
 * Implements the DiffDelta Feed Spec v1 polling protocol with ETag / 304 support.
 *
 * @example
 * ```ts
 * const client = new DiffDeltaClient("https://diffdelta.io");
 * const { changed, head } = await client.fetchHead("aws_whats_new");
 * if (changed && head) {
 *   const feed = await client.fetchLatest(head.latest_url);
 *   for (const item of feed.buckets.new) console.log(item.headline);
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadPointer {
  cursor: string;
  prev_cursor: string;
  changed: boolean;
  generated_at: string;
  ttl_sec: number;
  latest_url: string;
}

export interface SourceStatus {
  changed: boolean;
  cursor: string;
  prev_cursor: string;
  ttl_sec: number;
  status: "ok" | "error" | "disabled";
  stale?: boolean;
  stale_age_sec?: number;
  last_ok_at?: string;
  delta_counts?: { new: number; updated: number; removed: number };
  error?: { code: string; http_status?: number };
}

export interface DeltaItem {
  source: string;
  id: string;
  url: string;
  headline: string;
  published_at: string;
  updated_at: string;
  risk: { score: number; reasons?: string[] };
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
  cursor: string;
  prev_cursor: string;
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
  [key: string]: unknown;
}

export interface FetchHeadResult {
  /** True if there is new semantic content since the last poll. */
  changed: boolean;
  /** Head pointer JSON, or null on 304. */
  head: HeadPointer | null;
}

// ---------------------------------------------------------------------------
// In-memory cursor cache (with optional file stub)
// ---------------------------------------------------------------------------

class CursorCache {
  private data: Map<string, string> = new Map();

  get(key: string): string | undefined {
    return this.data.get(key);
  }

  set(key: string, cursor: string): void {
    this.data.set(key, cursor);
  }

  /**
   * Stub for file-based persistence.
   * In Node, implement with fs.readFileSync / fs.writeFileSync
   * targeting ~/.cache/diffdelta/cursor_cache.json.
   */
  async loadFromDisk(_path?: string): Promise<void> {
    // Implement for persistent caching:
    // const data = JSON.parse(await fs.promises.readFile(path, "utf-8"));
    // for (const [k, v] of Object.entries(data)) this.data.set(k, v as string);
  }

  async saveToDisk(_path?: string): Promise<void> {
    // Implement for persistent caching:
    // const obj = Object.fromEntries(this.data);
    // await fs.promises.writeFile(path, JSON.stringify(obj, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const USER_AGENT = "diffdelta-ts-client/0.1.0";

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

  private async get<T>(
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

      if (resp.status === 304) {
        const respEtag = (resp.headers.get("etag") ?? "").replace(/"/g, "");
        return { status: 304, body: null, etag: respEtag };
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} from ${fullUrl}`);
      }

      const body = (await resp.json()) as T;
      const respEtag = (resp.headers.get("etag") ?? "").replace(/"/g, "");
      return { status: resp.status, body, etag: respEtag };
    } finally {
      clearTimeout(timer);
    }
  }

  // -- public API ----------------------------------------------------------

  /**
   * Poll the head pointer for a source.
   *
   * Sends `If-None-Match` with the locally cached cursor.
   * Returns `{ changed: false, head: null }` on 304 (nothing new).
   */
  async fetchHead(sourceId: string): Promise<FetchHeadResult> {
    const cacheKey = `head:${sourceId}`;
    const storedCursor = this.cache.get(cacheKey);

    const url = `/diff/source/${sourceId}/head.json`;
    const { status, body, etag } = await this.get<HeadPointer>(
      url,
      storedCursor
    );

    if (status === 304) {
      return { changed: false, head: null };
    }

    // Update cached cursor
    const cursor = body?.cursor ?? etag;
    if (cursor) {
      this.cache.set(cacheKey, cursor);
    }

    const changed = body?.changed ?? true;
    return { changed, head: body };
  }

  /**
   * Fetch the full latest feed.
   *
   * @param urlOrSourceId  Relative URL or bare source ID.
   */
  async fetchLatest(urlOrSourceId: string): Promise<Feed> {
    const url = urlOrSourceId.includes("/")
      ? urlOrSourceId
      : `/diff/source/${urlOrSourceId}/latest.json`;

    const { body } = await this.get<Feed>(url);
    if (!body) throw new Error(`Empty response from ${url}`);
    return body;
  }

  /** Fetch the global aggregated feed. */
  async fetchGlobal(): Promise<Feed> {
    const { body } = await this.get<Feed>("/diff/latest.json");
    if (!body) throw new Error("Empty response from /diff/latest.json");
    return body;
  }

  /**
   * Walk the prev_cursor chain via archive snapshots.
   *
   * Returns an array of feed snapshots (newest first), up to `limit`.
   */
  async walkBack(sourceId: string, limit = 10): Promise<Feed[]> {
    const snapshots: Feed[] = [];
    const feed = await this.fetchLatest(sourceId);
    snapshots.push(feed);

    const zero = "sha256:" + "0".repeat(64);
    let prev = feed.prev_cursor ?? zero;

    for (let i = 1; i < limit; i++) {
      if (!prev || prev === zero) break;

      const cursorHex = prev.replace("sha256:", "").slice(0, 12);
      const archiveUrl = `/archive/${sourceId}/prev_${cursorHex}.json`;

      try {
        const { body } = await this.get<Feed>(archiveUrl);
        if (!body) break;
        snapshots.push(body);
        prev = body.prev_cursor ?? zero;
      } catch {
        break; // Archive not available
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
  const { changed, head } = await client.fetchHead(sourceId);

  if (!changed || !head) {
    console.log("304 — nothing new. Stopping.");
    return;
  }

  if (!head.changed) {
    console.log("Server says changed:false — no semantic change.");
    return;
  }

  console.log(`Changed! Cursor: ${head.cursor.slice(0, 24)}…`);
  const feed = await client.fetchLatest(head.latest_url ?? sourceId);

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
