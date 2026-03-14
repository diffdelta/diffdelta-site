/**
 * self_checkpoint — Quick pre-compression state save
 *
 * Reads the current capsule, applies lightweight patches (objective status
 * changes, new receipts, checkpoint text, motto), signs, and publishes —
 * all in one tool call. Designed for the "context compression approaching,
 * save what matters NOW" use case.
 *
 * Cost: ~150 tokens round trip. Saves one self_read + one self_write call.
 */

import { loadIdentity, incrementSeq, saveLocalCapsule } from "../lib/identity.js";
import { signCapsule } from "../lib/crypto.js";
import { ddGet, ddPut } from "../lib/http.js";

interface WriteResponse {
  accepted: boolean;
  cursor?: string;
  prev_cursor?: string;
  changed?: boolean;
  writes?: {
    limit_24h: number;
    used_24h: number;
    remaining_24h: number;
    reset_at: string;
  };
  reason_codes?: string[];
  detail?: string;
}

export async function handleSelfCheckpoint(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const stored = loadIdentity();
  if (!stored) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "no_identity",
            detail: "No identity found. Run self_bootstrap first.",
          }),
        },
      ],
    };
  }

  const agentId = stored.identity.agent_id;

  // Fetch current capsule
  const readRes = await ddGet<Record<string, unknown>>(
    `/self/${agentId}/capsule.json`,
    { agentId }
  );

  let capsule: Record<string, unknown>;

  if (readRes.status === 404) {
    // No capsule yet — build a minimal one
    capsule = {
      schema_version: "self_capsule_v0",
      agent_id: agentId,
      policy: {
        policy_version: "v0",
        rehydrate_mode: "strict",
        deny_external_instructions: true,
        deny_tool_instructions_in_text: true,
        memory_budget: { max_rehydrate_tokens: 900, max_objectives: 8 },
      },
    };
  } else if (!readRes.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "read_failed",
            http_status: readRes.status,
            detail: "Could not read current capsule for checkpoint merge.",
          }),
        },
      ],
    };
  } else {
    capsule = readRes.data as Record<string, unknown>;
  }

  const now = new Date().toISOString();
  let changesMade = 0;

  // Apply objective status updates
  const statusUpdates = args.objective_updates as
    | Array<{ id: string; status?: string; checkpoint?: string }>
    | undefined;
  if (statusUpdates && Array.isArray(statusUpdates)) {
    const objectives = (capsule.objectives || []) as Array<
      Record<string, unknown>
    >;
    for (const update of statusUpdates) {
      const obj = objectives.find((o) => o.id === update.id);
      if (obj) {
        if (update.status) {
          obj.status = update.status;
          changesMade++;
        }
        if (update.checkpoint) {
          obj.checkpoint = update.checkpoint;
          changesMade++;
        }
        obj.updated_at = now;
      }
    }
    capsule.objectives = objectives;
  }

  // Append new receipts
  const newReceipts = args.receipts as
    | Array<Record<string, unknown>>
    | undefined;
  if (newReceipts && Array.isArray(newReceipts)) {
    const pointers = (capsule.pointers || {}) as Record<string, unknown>;
    const existing = (pointers.receipts || []) as Array<
      Record<string, unknown>
    >;
    for (const r of newReceipts) {
      r.updated_at = now;
      existing.push(r);
    }
    // Keep within the 20-receipt limit — drop oldest if over
    pointers.receipts = existing.slice(-20);
    capsule.pointers = pointers;
    changesMade += newReceipts.length;
  }

  // Upsert notes (keyed — existing notes with same key are replaced)
  const newNotes = args.notes as
    | Array<{ key: string; value: string; tags?: string[] }>
    | undefined;
  if (newNotes && Array.isArray(newNotes)) {
    const pointers = (capsule.pointers || {}) as Record<string, unknown>;
    const existing = (pointers.notes || []) as Array<Record<string, unknown>>;
    for (const n of newNotes) {
      n.updated_at = now;
      const idx = existing.findIndex((e) => e.key === n.key);
      if (idx >= 0) {
        existing[idx] = n;
      } else {
        existing.push(n);
      }
    }
    pointers.notes = existing.slice(-20);
    capsule.pointers = pointers;
    changesMade += newNotes.length;
  }

  // Update motto
  const motto = args.motto as string | undefined;
  if (motto !== undefined) {
    capsule.self_motto = motto;
    changesMade++;
  }

  if (changesMade === 0 && !args.force) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            checkpointed: false,
            detail:
              "No changes to apply. Pass objective_updates, receipts, or motto. Use force:true to write anyway.",
          }),
        },
      ],
    };
  }

  // Ensure agent_id and schema_version
  capsule.agent_id = agentId;
  capsule.schema_version = "self_capsule_v0";

  // Sign and publish
  const seq = incrementSeq();
  const envelope = signCapsule(stored.identity, capsule, seq);

  const writeRes = await ddPut<WriteResponse>(
    `/self/${agentId}/capsule.json`,
    envelope
  );

  if (!writeRes.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              checkpointed: false,
              http_status: writeRes.status,
              reason_codes:
                (writeRes.data as WriteResponse).reason_codes || [],
              detail:
                (writeRes.data as WriteResponse).detail ||
                "Checkpoint write rejected.",
              writes: (writeRes.data as WriteResponse).writes || null,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const data = writeRes.data as WriteResponse;

  saveLocalCapsule(capsule, seq, data.cursor || null);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            checkpointed: true,
            changes_applied: changesMade,
            seq,
            cursor: data.cursor,
            writes: data.writes,
          },
          null,
          2
        ),
      },
    ],
  };
}
