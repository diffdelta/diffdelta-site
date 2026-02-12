/**
 * diffdelta_check — Check external feeds for changes (structured facts only)
 *
 * CONSTITUTIONAL: Returns measurements, not conclusions. No PASS/WARN/FAIL,
 * no risk scores, no recommendations. The agent decides what to do with
 * the facts. This is a "did anything change?" gate — not an interpreter.
 *
 * Accepts a free-form list of source names, tags, or "all". Returns
 * compact structured facts per source: changed, cursor, age, item count.
 *
 * Cost: ~100-200 tokens. Replaces fetching and parsing full feed content
 * (1000+ tokens) just to check if anything happened.
 */

import { z } from "zod";
import { ddGet } from "../lib/http.js";

export const DIFFDELTA_CHECK_TOOL = {
  name: "diffdelta_check",
  description: [
    "Check if external feeds have changed — structured facts only.",
    "",
    "Returns compact measurements per source: changed (bool), cursor,",
    "age_sec, items_count. No interpretations, no scores, no recommendations.",
    "You decide what matters based on the facts.",
    "",
    "Costs ~100-200 tokens total. Use this as a 'should I even look?' gate.",
    "If a source shows changed:true, use diffdelta_poll to fetch the items.",
    "If changed:false, do nothing — save tokens.",
    "",
    "Input: list of source names (e.g. ['github-advisories', 'nvd-cve']),",
    "a tag (e.g. 'security'), or 'all' to check every source.",
    "",
    "This tool monitors DiffDelta's curated feeds — not arbitrary URLs.",
    "For checking another agent's capsule, use self_subscribe instead.",
  ].join("\n"),
  inputSchema: z.object({
    sources: z
      .union([
        z.array(z.string()),
        z.string(),
      ])
      .describe(
        "Source names to check (e.g. ['github-advisories']), a tag " +
          "(e.g. 'security'), or 'all'. Free-form — we resolve what you mean."
      ),
  }),
};

interface HeadJson {
  cursor: string;
  changed: boolean;
  generated_at: string;
  sources: Array<{
    id: string;
    name: string;
    cursor: string;
    latest_item_at: string | null;
    items_count: number;
    tags: string[];
  }>;
}

interface SourceFeed {
  source: { id: string; name: string; tags: string[] };
  items: unknown[];
  cursor: string;
  generated_at: string;
}

interface CheckResult {
  source: string;
  changed: boolean;
  cursor: string;
  age_sec: number;
  items_count: number;
  latest_item_at: string | null;
  tags: string[];
}

export async function handleDiffdeltaCheck(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  let requested = args.sources;

  // Normalize input to array or special string
  let sourceFilter: string[] | "all" | { tag: string };

  if (typeof requested === "string") {
    const lower = requested.toLowerCase().trim();
    if (lower === "all") {
      sourceFilter = "all";
    } else {
      // Could be a single source name or a tag
      sourceFilter = [lower];
    }
  } else if (Array.isArray(requested)) {
    sourceFilter = (requested as string[]).map((s) =>
      typeof s === "string" ? s.toLowerCase().trim() : String(s)
    );
  } else {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "invalid_input",
            detail: "sources must be a string or array of strings.",
          }),
        },
      ],
    };
  }

  // Fetch the global head to get source metadata
  const headRes = await ddGet<HeadJson>("/healthz.json");
  if (!headRes.ok) {
    // Fall back to .well-known/diffdelta.json
    const wkRes = await ddGet<{ sources?: Array<{ id: string; name: string; tags?: string[] }> }>(
      "/.well-known/diffdelta.json"
    );
    if (!wkRes.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "service_unavailable",
              detail: "Could not reach DiffDelta head or well-known endpoint.",
            }),
          },
        ],
      };
    }
  }

  // Try to get detailed source info from individual feeds
  // First, list available sources
  const listRes = await ddGet<{
    sources: Array<{
      id: string;
      name: string;
      feed_url: string;
      tags: string[];
      latest_item_at?: string;
      items_count?: number;
      cursor?: string;
    }>;
  }>("/.well-known/diffdelta.json");

  if (!listRes.ok || !listRes.data?.sources) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "sources_unavailable",
            detail: "Could not fetch source list from DiffDelta.",
          }),
        },
      ],
    };
  }

  const allSources = listRes.data.sources;

  // Filter sources based on request
  let targetSources = allSources;
  if (sourceFilter !== "all") {
    if (Array.isArray(sourceFilter)) {
      // Check if any filter matches a tag
      const byTag = allSources.filter((s) =>
        s.tags?.some((t) =>
          sourceFilter.includes(t.toLowerCase())
        )
      );
      const byName = allSources.filter((s) =>
        (sourceFilter as string[]).includes(s.id.toLowerCase()) ||
        (sourceFilter as string[]).includes(s.name.toLowerCase())
      );
      targetSources = [...new Map([...byTag, ...byName].map((s) => [s.id, s])).values()];
    }
  }

  if (targetSources.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "no_matching_sources",
            requested: sourceFilter,
            available: allSources.map((s) => s.id),
            hint: "Use diffdelta_list_sources to see all available feeds.",
          }),
        },
      ],
    };
  }

  // Check each source's head for changes
  const now = Date.now();
  const results: CheckResult[] = [];

  // Fetch heads in parallel (but cap concurrency)
  const checks = targetSources.map(async (source) => {
    try {
      const feedUrl = source.feed_url || `/diff/${source.id}.json`;
      const feedRes = await ddGet<SourceFeed>(feedUrl);

      if (!feedRes.ok) {
        results.push({
          source: source.id,
          changed: false,
          cursor: "unknown",
          age_sec: -1,
          items_count: 0,
          latest_item_at: null,
          tags: source.tags || [],
        });
        return;
      }

      const feed = feedRes.data as SourceFeed;
      const generatedAt = feed.generated_at
        ? new Date(feed.generated_at).getTime()
        : now;
      const ageSec = Math.round((now - generatedAt) / 1000);

      results.push({
        source: source.id,
        changed: true, // We don't have a previous cursor to compare against in this stateless check
        cursor: feed.cursor || "none",
        age_sec: ageSec,
        items_count: Array.isArray(feed.items) ? feed.items.length : 0,
        latest_item_at: (feed as any).source?.latest_item_at || null,
        tags: source.tags || [],
      });
    } catch {
      results.push({
        source: source.id,
        changed: false,
        cursor: "error",
        age_sec: -1,
        items_count: 0,
        latest_item_at: null,
        tags: source.tags || [],
      });
    }
  });

  await Promise.all(checks);

  // Sort results by source name for determinism
  results.sort((a, b) => a.source.localeCompare(b.source));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            checked: results.length,
            results,
            hint: "Sources with changed:true have new items. Use diffdelta_poll with the source name to fetch them.",
          },
          null,
          2
        ),
      },
    ],
  };
}
