/**
 * diffdelta://head — MCP resource for the global DiffDelta health/head pointer
 */

import { ddGet } from "../lib/http.js";

export const HEAD_RESOURCE = {
  uri: "diffdelta://head",
  name: "DiffDelta Head",
  description:
    "Global DiffDelta health check and head pointer — shows service status, " +
    "last update time, and feed cursor for quick 'is anything new?' checks.",
  mimeType: "application/json",
};

export async function readHeadResource(): Promise<string> {
  const res = await ddGet<Record<string, unknown>>("/healthz.json");

  if (!res.ok) {
    return JSON.stringify({
      error: "Could not fetch DiffDelta head",
      status: res.status,
    });
  }

  return JSON.stringify(res.data, null, 2);
}
