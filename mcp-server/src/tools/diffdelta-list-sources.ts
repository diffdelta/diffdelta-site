/**
 * diffdelta_list_sources — Discover available DiffDelta feeds
 *
 * Returns all feeds DiffDelta monitors, with metadata: source ID, name,
 * URL, tags, and feed endpoint. Use this to discover what's available
 * before using diffdelta_check or diffdelta_poll.
 *
 * Cost: ~200 tokens. Call once at startup, cache the result.
 */

import { z } from "zod";
import { ddGet } from "../lib/http.js";

export const DIFFDELTA_LIST_SOURCES_TOOL = {
  name: "diffdelta_list_sources",
  description: [
    "Discover all available DiffDelta feed sources.",
    "",
    "Returns a list of feeds with metadata: source ID, name, tags,",
    "and feed URL. Use this to discover what you can monitor before",
    "calling diffdelta_check or diffdelta_poll.",
    "",
    "Optionally filter by tag (e.g. 'security', 'infrastructure').",
    "Costs ~200 tokens. Call once and cache — sources change rarely.",
  ].join("\n"),
  inputSchema: z.object({
    tag: z
      .string()
      .optional()
      .describe("Optional tag to filter sources (e.g. 'security', 'infrastructure')."),
  }),
};

interface WellKnown {
  protocol: string;
  sources: Array<{
    id: string;
    name: string;
    url: string;
    feed_url: string;
    tags: string[];
  }>;
}

export async function handleDiffdeltaListSources(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tag = args.tag as string | undefined;

  const res = await ddGet<WellKnown>("/.well-known/diffdelta.json");

  if (!res.ok || !res.data?.sources) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "service_unavailable",
            detail: "Could not fetch source list from DiffDelta.",
          }),
        },
      ],
    };
  }

  let sources = res.data.sources;

  // Filter by tag if provided
  if (tag) {
    const lowerTag = tag.toLowerCase().trim();
    sources = sources.filter((s) =>
      s.tags?.some((t) => t.toLowerCase() === lowerTag)
    );
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            total: sources.length,
            filter: tag || null,
            sources: sources.map((s) => ({
              id: s.id,
              name: s.name,
              tags: s.tags,
              feed_url: s.feed_url,
              source_url: s.url,
            })),
            hint: "Use diffdelta_check with source IDs to check for changes, then diffdelta_poll to fetch items.",
          },
          null,
          2
        ),
      },
    ],
  };
}
