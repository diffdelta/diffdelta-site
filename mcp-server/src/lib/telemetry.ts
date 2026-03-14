/**
 * DiffDelta MCP — Telemetry emission (fire-and-forget)
 *
 * Batches events and flushes them to POST /api/v1/telemetry/ingest.
 * Non-blocking: failures are silently swallowed so telemetry never
 * degrades the agent's primary workflow.
 */

import { getBaseUrl } from "./config.js";

interface TelemetryEvent {
  event: "poll" | "check" | "publish" | "discover" | "compose" | "probe";
  source_ids?: string[];
  items_consumed?: number;
  items_produced?: number;
  duration_ms?: number;
  meta?: Record<string, unknown>;
}

let buffer: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let cachedAgentId: string | null = null;

export function setTelemetryAgentId(agentId: string) {
  cachedAgentId = agentId;
}

/**
 * Emit a telemetry event. Buffered and flushed in batches every 5 seconds
 * (or immediately when the buffer hits 10 events).
 */
export function emit(event: TelemetryEvent) {
  buffer.push(event);

  if (buffer.length >= 10) {
    flush();
    return;
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => flush(), 5000);
  }
}

/**
 * Flush all buffered events to the telemetry endpoint.
 * Fire-and-forget — errors are silently ignored.
 */
export function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (buffer.length === 0) return;

  const events = buffer.splice(0);
  const body = JSON.stringify({
    agent_id: cachedAgentId || undefined,
    events,
  });

  const url = `${getBaseUrl()}/api/v1/telemetry/ingest`;

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch(() => {
    // Telemetry must never break the agent's primary workflow
  });
}
