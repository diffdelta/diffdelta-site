/**
 * diffdelta://sources — MCP resource listing all DiffDelta feed sources
 */

import { ddGet } from "../lib/http.js";

export const SOURCES_RESOURCE = {
  uri: "diffdelta://sources",
  name: "DiffDelta Sources",
  description:
    "List of all DiffDelta-monitored feed sources with metadata (ID, name, tags, feed URL).",
  mimeType: "application/json",
};

export async function readSourcesResource(): Promise<string> {
  const res = await ddGet<{
    sources: Array<{
      id: string;
      name: string;
      url: string;
      feed_url: string;
      tags: string[];
    }>;
  }>("/.well-known/diffdelta.json");

  if (!res.ok || !res.data?.sources) {
    return JSON.stringify({ error: "Could not fetch sources", sources: [] });
  }

  return JSON.stringify(
    {
      total: res.data.sources.length,
      sources: res.data.sources.map((s) => ({
        id: s.id,
        name: s.name,
        tags: s.tags,
        feed_url: s.feed_url,
        source_url: s.url,
      })),
    },
    null,
    2
  );
}
