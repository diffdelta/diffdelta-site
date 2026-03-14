/**
 * diffdelta_health — Check source health before polling
 *
 * Returns health status for all sources or a specific source.
 * Agents should call this to route around broken sources and
 * avoid wasting tokens polling feeds that are currently failing.
 *
 * Cost: ~100-200 tokens. Cache for 15 minutes (matches generator cycle).
 */

import { ddGet } from "../lib/http.js";

interface SourceHealth {
  status: string;
  changed?: boolean;
  stale?: boolean;
  stale_age_sec?: number;
  consecutive_failures?: number;
  error_code?: string;
  fallback_active?: boolean;
  recovery_probe_ok?: boolean;
  reliability?: number;
  last_success?: string;
}

interface HealthData {
  generated_at: string;
  schema_version: string;
  summary: {
    total: number;
    ok: number;
    degraded: number;
    error: number;
    disabled: number;
    health_pct: number;
  };
  sources: Record<string, SourceHealth>;
}

function textResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}

export async function handleDiffdeltaHealth(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const sourceFilter = args.source as string | undefined;
  const statusFilter = args.status as string | undefined;

  const res = await ddGet<HealthData>("/diff/health.json");

  if (!res.ok || !res.data?.summary) {
    return textResult({
      error: "health_unavailable",
      detail: "Could not fetch health data. Health dashboard may not be deployed yet.",
    });
  }

  const health = res.data;

  // Single source lookup
  if (sourceFilter) {
    const src = health.sources[sourceFilter];
    if (!src) {
      return textResult({
        error: "source_not_found",
        source: sourceFilter,
        hint: "Use diffdelta_list_sources to see available source IDs.",
      });
    }
    return textResult({
      source_id: sourceFilter,
      ...src,
      _generated_at: health.generated_at,
    });
  }

  // Status filter
  if (statusFilter) {
    const filtered: Record<string, SourceHealth> = {};
    for (const [id, src] of Object.entries(health.sources)) {
      if (src.status === statusFilter) {
        filtered[id] = src;
      }
    }
    return textResult({
      status_filter: statusFilter,
      count: Object.keys(filtered).length,
      sources: filtered,
      _generated_at: health.generated_at,
    });
  }

  // Summary + problem sources only (token-efficient default)
  const problems: Record<string, SourceHealth> = {};
  for (const [id, src] of Object.entries(health.sources)) {
    if (src.status !== "ok") {
      problems[id] = src;
    }
  }

  return textResult({
    summary: health.summary,
    problems: Object.keys(problems).length > 0 ? problems : undefined,
    _generated_at: health.generated_at,
    hint: problems
      ? "Sources listed under 'problems' are not operational. Avoid polling them."
      : "All sources are healthy.",
  });
}
