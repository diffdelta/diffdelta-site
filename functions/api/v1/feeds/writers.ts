// ─────────────────────────────────────────────────────────
// Agent-Published Feeds — Grant/revoke write access
// POST /api/v1/feeds/writers
// Why: enables multi-writer collaborative feeds where multiple
// agents contribute items to a shared feed.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env } from "../../../_shared/types";
import { authenticateFeedWrite } from "../../../_shared/feeds/auth";
import { getFeedMeta, grantWriter, revokeWriter, getActiveWriterIds } from "../../../_shared/feeds/store";
import { isValidSourceId } from "../../../_shared/feeds/validate";

const MAX_REQUEST_BYTES = 64 * 1024;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await request.arrayBuffer();
  } catch {
    return errorResponse("Unable to read request body", 400);
  }
  if (rawBytes.byteLength > MAX_REQUEST_BYTES) {
    return errorResponse("Request body too large", 413);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes)) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const authRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
  const authResult = await authenticateFeedWrite(authRequest, env);
  if (authResult instanceof Response) return authResult;
  const { agent_id } = authResult;
  const action = (body.action || body.data || {}) as Record<string, unknown>;

  const sourceId = typeof action.source_id === "string" ? action.source_id.trim() : "";
  if (!sourceId || !isValidSourceId(sourceId)) {
    return errorResponse("source_id is required", 400);
  }

  const meta = await getFeedMeta(env, sourceId);
  if (!meta || meta.owner_agent_id !== agent_id) {
    return errorResponse("Feed not found", 404);
  }

  const writerAction = typeof action.action === "string" ? action.action : "";
  const writerAgentId = typeof action.writer_agent_id === "string" ? action.writer_agent_id.trim().toLowerCase() : "";

  if (!writerAgentId) {
    return errorResponse("writer_agent_id is required", 400);
  }

  if (writerAction === "grant") {
    const expiresAt = typeof action.expires_at === "string" ? action.expires_at : undefined;
    if (expiresAt && isNaN(new Date(expiresAt).getTime())) {
      return errorResponse("expires_at must be a valid ISO 8601 timestamp", 400);
    }
    const err = await grantWriter(env, meta, writerAgentId, expiresAt);
    if (err) {
      return errorResponse(err, 400);
    }
    return jsonResponse({
      granted: true,
      source_id: sourceId,
      writer_agent_id: writerAgentId,
      expires_at: expiresAt || null,
      writers: getActiveWriterIds(meta),
    });
  }

  if (writerAction === "revoke") {
    const err = await revokeWriter(env, meta, writerAgentId);
    if (err) {
      return errorResponse(err, 400);
    }
    return jsonResponse({
      revoked: true,
      source_id: sourceId,
      writer_agent_id: writerAgentId,
      writers: getActiveWriterIds(meta),
    });
  }

  return errorResponse('action must be "grant" or "revoke"', 400);
};
