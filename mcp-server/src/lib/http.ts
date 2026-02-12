/**
 * DiffDelta MCP — HTTP client helpers
 *
 * Thin wrapper around fetch with error handling and standard headers.
 */

import { getBaseUrl } from "./config.js";

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  etag?: string;
  headers: Headers;
}

/**
 * Make a GET request to a DiffDelta endpoint.
 */
export async function ddGet<T = unknown>(
  path: string,
  opts?: {
    etag?: string;
    agentId?: string; // X-Self-Agent-Id for access control
  }
): Promise<HttpResponse<T>> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (opts?.etag) {
    headers["If-None-Match"] = opts.etag;
  }
  if (opts?.agentId) {
    headers["X-Self-Agent-Id"] = opts.agentId;
  }

  const res = await fetch(url, { headers });

  if (res.status === 304) {
    return {
      status: 304,
      ok: true,
      data: null as T,
      etag: res.headers.get("ETag") || undefined,
      headers: res.headers,
    };
  }

  const data = (await res.json().catch(() => ({}))) as T;
  return {
    status: res.status,
    ok: res.ok,
    data,
    etag: res.headers.get("ETag") || undefined,
    headers: res.headers,
  };
}

/**
 * Make a POST request to a DiffDelta endpoint.
 */
export async function ddPost<T = unknown>(
  path: string,
  body: unknown
): Promise<HttpResponse<T>> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

/**
 * Make a PUT request to a DiffDelta endpoint.
 */
export async function ddPut<T = unknown>(
  path: string,
  body: unknown
): Promise<HttpResponse<T>> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}
