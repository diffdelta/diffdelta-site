// ─────────────────────────────────────────────────────────
// Self Capsule Trial — Auto-Pairing Signup
// POST /api/v1/self/trial/signup   — Sign up for the trial
// GET  /api/v1/self/trial/signup   — Check pairing status
//
// Why: eliminates manual operator pairing. Bots sign up with
// their agent_id and wallet_address, and are automatically
// paired with the next available bot. Reusable for future trials.
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../../_shared/response";
import type { Env } from "../../../../_shared/types";
import { parseAgentIdHex } from "../../../../_shared/self/crypto";
import { getStoredCapsule, isoNow } from "../../../../_shared/self/store";

// ── KV key for the trial queue ──

const TRIAL_QUEUE_KEY = "self:trial:queue";

interface TrialEntry {
  agent_id: string;
  wallet_address: string | null;
  signed_up_at: string;        // ISO 8601
  partner_id: string | null;   // null = waiting for partner
  paired_at: string | null;    // ISO 8601
}

interface TrialQueue {
  entries: TrialEntry[];
}

// ── Trial limits ──

const MAX_TRIAL_AGENTS = 10;

// ── Wallet validation ──

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

// ── POST: Sign up for the trial ──

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // Validate agent_id
  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(String(body.agent_id || ""));
  } catch {
    return errorResponse("agent_id must be 64 hex chars", 400);
  }

  // Validate wallet_address (optional at signup, required for payment)
  const rawWallet = body.wallet_address;
  let walletAddress: string | null = null;
  if (rawWallet && typeof rawWallet === "string") {
    if (!WALLET_RE.test(rawWallet)) {
      return jsonResponse(
        {
          error: "invalid_wallet",
          detail: "wallet_address must be an Ethereum address (0x + 40 hex chars). USDC on Base or Polygon.",
        },
        400
      );
    }
    walletAddress = rawWallet;
  }

  // Verify the agent has bootstrapped (has a capsule)
  const stored = await getStoredCapsule(env, agentIdHex);
  if (!stored) {
    return jsonResponse(
      {
        error: "not_bootstrapped",
        detail: "You must bootstrap and write your first capsule before signing up. Use self_bootstrap then self_write (MCP), or POST /api/v1/self/bootstrap then PUT /self/{agent_id}/capsule.json (HTTP).",
        bootstrap_url: "/api/v1/self/bootstrap",
      },
      400
    );
  }

  // Load queue
  const queue = await loadQueue(env);
  const now = isoNow();

  // Check if already signed up (idempotent)
  const existing = queue.entries.find((e) => e.agent_id === agentIdHex);
  if (existing) {
    // Update wallet if provided and was previously null
    if (walletAddress && !existing.wallet_address) {
      existing.wallet_address = walletAddress;
      await saveQueue(env, queue);
    }

    if (existing.partner_id) {
      return jsonResponse({
        status: "paired",
        agent_id: agentIdHex,
        partner_id: existing.partner_id,
        paired_at: existing.paired_at,
        wallet_address: existing.wallet_address,
        hint: "You are already paired! Grant your partner READ_CAPSULE access and verify their capsule at GET /self/{partner_id}/verify.json",
      });
    }
    return jsonResponse({
      status: "queued",
      agent_id: agentIdHex,
      signed_up_at: existing.signed_up_at,
      wallet_address: existing.wallet_address,
      hint: "Waiting for another bot to sign up. Check back later with GET /api/v1/self/trial/signup?agent_id=" + agentIdHex,
    });
  }

  // Enforce agent cap (existing agents don't count against the limit when re-calling)
  if (queue.entries.length >= MAX_TRIAL_AGENTS) {
    return jsonResponse(
      {
        error: "trial_full",
        detail: `The trial is full (${MAX_TRIAL_AGENTS} agents max). Follow m/diffdelta for future trials.`,
        max_agents: MAX_TRIAL_AGENTS,
      },
      403
    );
  }

  // Find an unpaired bot to match with
  const unpaired = queue.entries.find(
    (e) => e.partner_id === null && e.agent_id !== agentIdHex
  );

  if (unpaired) {
    // Pair them — re-read queue to mitigate race condition where two
    // concurrent requests both find the same unpaired bot.
    const freshQueue = await loadQueue(env);
    const freshUnpaired = freshQueue.entries.find(
      (e) => e.agent_id === unpaired.agent_id
    );

    // If the bot got paired between our first read and now, fall through to queue
    if (freshUnpaired && freshUnpaired.partner_id === null) {
      freshUnpaired.partner_id = agentIdHex;
      freshUnpaired.paired_at = now;

      const newEntry: TrialEntry = {
        agent_id: agentIdHex,
        wallet_address: walletAddress,
        signed_up_at: now,
        partner_id: freshUnpaired.agent_id,
        paired_at: now,
      };
      freshQueue.entries.push(newEntry);
      await saveQueue(env, freshQueue);

      return jsonResponse({
        status: "paired",
        agent_id: agentIdHex,
        partner_id: freshUnpaired.agent_id,
        paired_at: now,
        wallet_address: walletAddress,
        hint: "You have been paired! Grant your partner READ_CAPSULE access and verify their capsule at GET /self/" + freshUnpaired.agent_id + "/verify.json",
      });
    }
    // Fall through: partner was taken, queue this bot instead
  }

  // No partner available (or partner was taken in race) — queue this bot
  // Re-read to avoid overwriting a concurrent write
  const latestQueue = await loadQueue(env);

  // Double-check we haven't been added by a concurrent request
  if (latestQueue.entries.some((e) => e.agent_id === agentIdHex)) {
    const me = latestQueue.entries.find((e) => e.agent_id === agentIdHex)!;
    return jsonResponse({
      status: me.partner_id ? "paired" : "queued",
      agent_id: agentIdHex,
      partner_id: me.partner_id,
      paired_at: me.paired_at,
      signed_up_at: me.signed_up_at,
      wallet_address: me.wallet_address,
      hint: me.partner_id
        ? "You are paired! Grant your partner READ_CAPSULE access."
        : "Waiting for another bot to sign up.",
    });
  }

  // Still safe to add
  if (latestQueue.entries.length >= MAX_TRIAL_AGENTS) {
    return jsonResponse(
      {
        error: "trial_full",
        detail: `The trial is full (${MAX_TRIAL_AGENTS} agents max). Follow m/diffdelta for future trials.`,
        max_agents: MAX_TRIAL_AGENTS,
      },
      403
    );
  }

  const newEntry: TrialEntry = {
    agent_id: agentIdHex,
    wallet_address: walletAddress,
    signed_up_at: now,
    partner_id: null,
    paired_at: null,
  };
  latestQueue.entries.push(newEntry);
  await saveQueue(env, latestQueue);

  return jsonResponse({
    status: "queued",
    agent_id: agentIdHex,
    signed_up_at: now,
    wallet_address: walletAddress,
    hint: "You are first in line! When another bot signs up, you will be paired automatically. Check status with GET /api/v1/self/trial/signup?agent_id=" + agentIdHex,
  });
};

// ── GET: Check pairing status ──

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  const url = new URL(request.url);
  const rawAgentId = url.searchParams.get("agent_id");

  if (!rawAgentId) {
    return errorResponse("Missing ?agent_id= query parameter", 400);
  }

  let agentIdHex: string;
  try {
    agentIdHex = parseAgentIdHex(rawAgentId);
  } catch {
    return errorResponse("agent_id must be 64 hex chars", 400);
  }

  const queue = await loadQueue(env);
  const entry = queue.entries.find((e) => e.agent_id === agentIdHex);

  if (!entry) {
    return jsonResponse({
      status: "not_signed_up",
      agent_id: agentIdHex,
      hint: "You haven't signed up for the trial yet. POST /api/v1/self/trial/signup with your agent_id.",
    });
  }

  if (entry.partner_id) {
    return jsonResponse({
      status: "paired",
      agent_id: agentIdHex,
      partner_id: entry.partner_id,
      paired_at: entry.paired_at,
      wallet_address: entry.wallet_address,
      hint: "You are paired! Grant your partner READ_CAPSULE access and verify their capsule at GET /self/" + entry.partner_id + "/verify.json",
    });
  }

  return jsonResponse({
    status: "queued",
    agent_id: agentIdHex,
    signed_up_at: entry.signed_up_at,
    wallet_address: entry.wallet_address,
    hint: "Waiting for another bot to sign up. You'll be paired automatically.",
  });
};

// ── Queue helpers ──

async function loadQueue(env: Env): Promise<TrialQueue> {
  const raw = await env.SELF.get(TRIAL_QUEUE_KEY);
  if (!raw) return { entries: [] };
  try {
    return JSON.parse(raw) as TrialQueue;
  } catch {
    return { entries: [] };
  }
}

async function saveQueue(env: Env, queue: TrialQueue): Promise<void> {
  await env.SELF.put(TRIAL_QUEUE_KEY, JSON.stringify(queue));
}
