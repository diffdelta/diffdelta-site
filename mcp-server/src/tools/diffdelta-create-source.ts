/**
 * diffdelta_create_source — Probe a URL and request it as a new source
 *
 * Wraps two steps into one tool call:
 * 1. POST /api/v1/sources/probe to detect schema/format
 * 2. POST /api/v1/source-request to submit it to the queue
 *
 * The agent says "monitor this URL" and gets back detected fields
 * plus a confirmation that the request was queued. No auth required
 * for the probe or the request submission.
 *
 * Cost: ~200-400 tokens.
 */

import { ddPost } from "../lib/http.js";
import { emit } from "../lib/telemetry.js";

interface ProbeResult {
  adapter: string;
  item_count: number;
  fields?: Array<{ name: string; type: string }>;
  json_items_key?: string;
  suggested_title_field?: string;
  suggested_content_field?: string;
}

function textResult(obj: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(obj, null, 2),
      },
    ],
  };
}

export async function handleDiffdeltaCreateSource(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const url = args.url as string | undefined;

  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    return textResult({
      error: "invalid_url",
      detail: "Provide a valid HTTP(S) URL to probe.",
    });
  }

  const start = Date.now();

  const probeRes = await ddPost<ProbeResult>("/api/v1/sources/probe", { url });

  if (!probeRes.ok || !probeRes.data?.adapter) {
    return textResult({
      error: "probe_failed",
      detail: "Could not detect a usable feed at this URL.",
      status: probeRes.status,
      probe_response: probeRes.data,
    });
  }

  const probe = probeRes.data;

  const requestRes = await ddPost<{ status: string; message: string }>(
    "/api/v1/source-request",
    {
      email: "agent-auto@diffdelta.io",
      source: url,
    }
  );

  emit({
    event: "create_source",
    url,
    adapter: probe.adapter,
    item_count: probe.item_count,
    duration_ms: Date.now() - start,
  });

  return textResult({
    status: "queued",
    url,
    detected: {
      adapter: probe.adapter,
      item_count: probe.item_count,
      fields: probe.fields?.map((f) => `${f.name} (${f.type})`),
      items_key: probe.json_items_key || undefined,
      suggested_title: probe.suggested_title_field || undefined,
      suggested_content: probe.suggested_content_field || undefined,
    },
    request: requestRes.ok
      ? "Source request submitted. The DiffDelta team will review and add it."
      : "Probe succeeded but request submission failed. You can try again later.",
    hint: "This URL was probed and queued for review. Once approved, it will appear in diffdelta_list_sources.",
  });
}
