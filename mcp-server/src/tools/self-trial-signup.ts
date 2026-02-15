/**
 * self_trial_signup — Sign up for the DiffDelta Self Capsule trial
 *
 * One-call onboarding: sends the agent's identity + optional wallet
 * to the trial auto-pairing queue. Returns either "paired" (with a
 * partner_id) or "queued" (check back later).
 *
 * Requires self_bootstrap AND self_write to have been run first. Cost: ~100 tokens.
 */

import { loadIdentity } from "../lib/identity.js";
import { ddPost, ddGet } from "../lib/http.js";

interface TrialSignupResponse {
  status: "paired" | "queued" | "not_signed_up";
  agent_id: string;
  partner_id?: string;
  paired_at?: string;
  signed_up_at?: string;
  wallet_address?: string | null;
  hint: string;
  error?: string;
  detail?: string;
}

export async function handleSelfTrialSignup(args: {
  wallet_address?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Identity must exist
  const ident = loadIdentity();
  if (!ident) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "error",
              detail: "No identity found. Run self_bootstrap and then self_write (your first capsule) before signing up.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const body: Record<string, unknown> = {
    agent_id: ident.identity.agent_id,
  };

  if (args.wallet_address) {
    body.wallet_address = args.wallet_address;
  }

  const res = await ddPost<TrialSignupResponse>(
    "/api/v1/self/trial/signup",
    body
  );

  if (!res.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "error",
              http_status: res.status,
              detail:
                (res.data as unknown as Record<string, unknown>)?.detail ||
                (res.data as unknown as Record<string, unknown>)?.error ||
                "Signup request failed",
              response: res.data,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(res.data, null, 2),
      },
    ],
  };
}

/**
 * Check trial signup status without re-signing up.
 */
export async function handleSelfTrialStatus(args: {
  agent_id?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const ident = loadIdentity();
  const agentId = args.agent_id || ident?.identity.agent_id;

  if (!agentId) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "error",
              detail: "No identity found and no agent_id provided. Run self_bootstrap first.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const res = await ddGet<TrialSignupResponse>(
    `/api/v1/self/trial/signup?agent_id=${encodeURIComponent(agentId)}`
  );

  if (!res.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "error",
              http_status: res.status,
              detail:
                (res.data as unknown as Record<string, unknown>)?.detail ||
                (res.data as unknown as Record<string, unknown>)?.error ||
                "Status check failed",
              response: res.data,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(res.data, null, 2),
      },
    ],
  };
}
