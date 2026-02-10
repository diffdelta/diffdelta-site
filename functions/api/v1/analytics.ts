// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Analytics Dashboard Endpoint
// Why: Returns aggregated usage stats for operators.
// GET /api/v1/analytics?period=day&endpoint=/diff/head.json
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // ── Admin-only (or Pro tier) ──
  // TODO: Add admin check or Pro tier requirement
  
  if (!env.ANALYTICS) {
    return errorResponse("Analytics not configured", 503);
  }
  
  const period = url.searchParams.get("period") || "day"; // "hour", "day", "week"
  const endpoint = url.searchParams.get("endpoint") || null;
  
  const now = Math.floor(Date.now() / 1000);
  let buckets: number[] = [];
  let bucketSize = 3600; // 1 hour
  
  if (period === "day") {
    bucketSize = 3600; // 1 hour buckets
    const startHour = Math.floor((now - 86400) / 3600); // Last 24 hours
    buckets = Array.from({ length: 24 }, (_, i) => startHour + i);
  } else if (period === "week") {
    bucketSize = 86400; // 1 day buckets
    const startDay = Math.floor((now - 604800) / 86400); // Last 7 days
    buckets = Array.from({ length: 7 }, (_, i) => startDay + i);
  } else {
    // hour: last 24 hours in 1-hour buckets
    bucketSize = 3600;
    const startHour = Math.floor((now - 86400) / 3600);
    buckets = Array.from({ length: 24 }, (_, i) => startHour + i);
  }
  
  // ── Aggregate counts ──
  const data: Record<string, number> = {};
  let total = 0;
  
  for (const bucket of buckets) {
    const key = endpoint
      ? `telemetry:${period === "week" ? "day" : "hour"}:${bucket}:${endpoint}`
      : `telemetry:${period === "week" ? "day" : "hour"}:${bucket}:*`;
    
    // If endpoint specified, fetch exact key
    if (endpoint) {
      const raw = await env.ANALYTICS.get(key);
      const parsed = raw ? parseInt(raw, 10) : 0;
      const count = isNaN(parsed) ? 0 : parsed;
      data[String(bucket)] = count;
      total += count;
    } else {
      // Aggregate all endpoints for this bucket
      // Note: KV doesn't support wildcards, so this is a limitation
      // For full aggregation, use Logpush or D1 instead
      const raw = await env.ANALYTICS.get(key);
      const parsed = raw ? parseInt(raw, 10) : 0;
      const count = isNaN(parsed) ? 0 : parsed;
      data[String(bucket)] = count;
      total += count;
    }
  }
  
  return jsonResponse({
    period,
    endpoint: endpoint || "all",
    buckets: buckets.map((b) => ({
      timestamp: b * bucketSize,
      count: data[String(b)] || 0,
    })),
    total,
    note: "KV-based analytics are limited. For full insights, use Cloudflare Logpush.",
  });
};
