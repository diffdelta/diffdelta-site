/**
 * diffdelta_poll — Fetch items from a DiffDelta feed
 *
 * After diffdelta_check tells you a source has changed, use this to
 * fetch the actual items. Returns structured, pre-diffed JSON — not
 * raw HTML. The feed is already processed by DiffDelta's deterministic
 * change detection.
 *
 * Cost: varies by feed size, but always structured JSON (not raw web content).
 */

import { z } from "zod";
import { ddGet } from "../lib/http.js";

export const DIFFDELTA_POLL_TOOL = {
  name: "diffdelta_poll",
  description: [
    "Fetch items from a DiffDelta feed source.",
    "",
    "Returns structured, pre-diffed JSON items from a specific source.",
    "Use this after diffdelta_check shows changed:true for a source.",
    "",
    "The items are already processed by DiffDelta's deterministic change",
    "detection — you get clean structured data, not raw HTML. Each item",
    "has a cursor for tracking what you've seen.",
    "",
    "Cost: varies by feed size. Always less than fetching raw web content.",
  ].join("\n"),
  inputSchema: z.object({
    source: z
      .string()
      .describe(
        "Source ID to poll (e.g. 'github-advisories'). " +
          "Use diffdelta_list_sources to discover available feeds."
      ),
  }),
};

interface FeedResponse {
  source: {
    id: string;
    name: string;
    url: string;
    tags: string[];
  };
  items: Array<{
    id: string;
    title?: string;
    url?: string;
    published_at?: string;
    [key: string]: unknown;
  }>;
  cursor: string;
  generated_at: string;
  items_count: number;
}

export async function handleDiffdeltaPoll(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const source = args.source as string;

  if (!source || typeof source !== "string") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "invalid_input",
            detail: "source must be a string (e.g. 'github-advisories').",
          }),
        },
      ],
    };
  }

  const feedUrl = `/diff/${source}.json`;
  const res = await ddGet<FeedResponse>(feedUrl);

  if (res.status === 404) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "source_not_found",
            source,
            detail: `No feed found at ${feedUrl}. Use diffdelta_list_sources to see available feeds.`,
          }),
        },
      ],
    };
  }

  if (!res.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "request_failed",
            http_status: res.status,
            source,
          }),
        },
      ],
    };
  }

  const feed = res.data as FeedResponse;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            source: feed.source?.id || source,
            cursor: feed.cursor,
            generated_at: feed.generated_at,
            items_count: Array.isArray(feed.items) ? feed.items.length : 0,
            items: feed.items,
          },
          null,
          2
        ),
      },
    ],
  };
}
