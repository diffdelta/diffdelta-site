// ─────────────────────────────────────────────────────────
// DiffDelta — Telemetry Ingest
// POST /api/v1/telemetry/ingest
// Why: Captures agent behavioral exhaust (which feeds they poll,
// what they compose, what they publish) as structured events.
// This data powers the composition graph and training corpus.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";

const MAX_REQUEST_BYTES = 16_384; // 16KB — telemetry payloads are small
const MAX_EVENTS_PER_BATCH = 25;
const MAX_SOURCE_IDS = 20;
const VALID_EVENT_TYPES = ["poll", "check", "publish", "discover", "compose", "probe", "create_source"] as const;
type EventType = typeof VALID_EVENT_TYPES[number];

interface TelemetryEvent {
  event: EventType;
  source_ids?: string[];
  items_consumed?: number;
  items_produced?: number;
  duration_ms?: number;
  meta?: Record<string, unknown>;
}

interface IngestRequest {
  agent_id?: string;
  events?: unknown[];
}

function isValidEventType(t: unknown): t is EventType {
  return typeof t === "string" && (VALID_EVENT_TYPES as readonly string[]).includes(t);
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, Math.round(val)));
}

function sanitizeSourceId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim().slice(0, 100);
  if (!/^[a-z0-9_\-]{1,100}$/i.test(trimmed)) return null;
  return trimmed;
}

function sanitizeMeta(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 10) break;
    const key = String(k).slice(0, 32).replace(/[^a-z0-9_\-]/gi, "_");
    const val = String(v).slice(0, 200);
    if (key) {
      out[key] = val;
      count++;
    }
  }
  return count > 0 ? out : undefined;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // ── Body size cap ──
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > MAX_REQUEST_BYTES) {
    return errorResponse("Request body too large", 413);
  }

  let body: IngestRequest;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // ── Rate limit: 60 ingests/hour per identifier ──
  const agentId = typeof body.agent_id === "string" && /^[0-9a-f]{64}$/.test(body.agent_id)
    ? body.agent_id
    : null;
  const identifier = agentId || request.headers.get("CF-Connecting-IP") || "unknown";
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const rlKey = `telemetry-rl:${identifier}:${hourBucket}`;
  const rlCount = parseInt((await env.FEEDS.get(rlKey)) || "0", 10);
  if (rlCount >= 60) {
    return errorResponse("Telemetry rate limit exceeded (60/hour)", 429);
  }

  // ── Validate events ──
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return errorResponse("events array is required and must not be empty", 400);
  }
  if (body.events.length > MAX_EVENTS_PER_BATCH) {
    return errorResponse(`Maximum ${MAX_EVENTS_PER_BATCH} events per batch`, 400);
  }

  const now = new Date().toISOString();
  const accepted: TelemetryEvent[] = [];

  for (const raw of body.events) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const evt = raw as Record<string, unknown>;

    if (!isValidEventType(evt.event)) continue;

    const sourceIds = Array.isArray(evt.source_ids)
      ? evt.source_ids.map(sanitizeSourceId).filter((s): s is string => s !== null).slice(0, MAX_SOURCE_IDS)
      : undefined;

    accepted.push({
      event: evt.event as EventType,
      source_ids: sourceIds && sourceIds.length > 0 ? sourceIds : undefined,
      items_consumed: clampInt(evt.items_consumed, 0, 10_000, 0) || undefined,
      items_produced: clampInt(evt.items_produced, 0, 10_000, 0) || undefined,
      duration_ms: clampInt(evt.duration_ms, 0, 300_000, 0) || undefined,
      meta: sanitizeMeta(evt.meta),
    });
  }

  if (accepted.length === 0) {
    return errorResponse("No valid events in batch", 422);
  }

  // ── Store: append to daily event log + increment rollup counters ──
  const dateKey = now.slice(0, 10); // YYYY-MM-DD

  // 1. Append raw events to daily log (capped, newest appended)
  const logKey = `telemetry:log:${dateKey}:${identifier}`;
  const existing = await env.FEEDS.get(logKey);
  const log: Array<{ t: string; agent?: string } & TelemetryEvent> = existing ? JSON.parse(existing) : [];

  for (const evt of accepted) {
    log.push({
      t: now,
      agent: agentId || undefined,
      ...evt,
    });
  }

  // Cap at 500 events per agent per day to prevent abuse
  const capped = log.slice(-500);
  await env.FEEDS.put(logKey, JSON.stringify(capped), { expirationTtl: 86400 * 30 });

  // 2. Increment daily rollup counters per event type
  const counterPromises: Promise<void>[] = [];
  const eventCounts: Record<string, number> = {};
  for (const evt of accepted) {
    eventCounts[evt.event] = (eventCounts[evt.event] || 0) + 1;
  }

  for (const [eventType, count] of Object.entries(eventCounts)) {
    const counterKey = `telemetry:count:${dateKey}:${eventType}`;
    counterPromises.push(
      (async () => {
        const current = parseInt((await env.FEEDS.get(counterKey)) || "0", 10);
        await env.FEEDS.put(counterKey, String(current + count), { expirationTtl: 86400 * 90 });
      })()
    );
  }

  // 3. Track source popularity (which sources get polled/checked most)
  const sourceCounts: Record<string, number> = {};
  for (const evt of accepted) {
    if (evt.source_ids) {
      for (const sid of evt.source_ids) {
        sourceCounts[sid] = (sourceCounts[sid] || 0) + 1;
      }
    }
  }

  for (const [sourceId, count] of Object.entries(sourceCounts)) {
    const sourceKey = `telemetry:source:${dateKey}:${sourceId}`;
    counterPromises.push(
      (async () => {
        const current = parseInt((await env.FEEDS.get(sourceKey)) || "0", 10);
        await env.FEEDS.put(sourceKey, String(current + count), { expirationTtl: 86400 * 90 });
      })()
    );
  }

  // 4. Increment rate limit counter
  counterPromises.push(
    env.FEEDS.put(rlKey, String(rlCount + accepted.length), { expirationTtl: 7200 })
  );

  await Promise.all(counterPromises);

  return jsonResponse({
    accepted: accepted.length,
    dropped: body.events.length - accepted.length,
  });
};
