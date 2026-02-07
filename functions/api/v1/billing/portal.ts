// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Stripe Billing Portal
// Why: Creates a Stripe Billing Portal session so Pro users
// can manage their subscription, update payment method,
// view invoices, and cancel. No need to build our own billing UI.
// POST /api/v1/billing/portal
// ─────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../../../_shared/response";
import type { Env, KeyData } from "../../../_shared/types";
import type { AuthResult } from "../../../_shared/auth";

interface PortalSession {
  id: string;
  url: string;
  error?: { message: string };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env, data } = context;
  const auth = (data as Record<string, unknown>).auth as AuthResult;

  if (!auth?.key_hash) {
    return errorResponse("Not authenticated", 401);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return errorResponse("Billing system not configured", 503);
  }

  // ── Read key data to get Stripe customer ID ──
  const raw = await env.KEYS.get(`key:${auth.key_hash}`);
  if (!raw) {
    return errorResponse("Key not found", 404);
  }

  const keyData: KeyData = JSON.parse(raw);

  if (!keyData.customer_id) {
    return errorResponse(
      "No billing account linked to this key. Contact human@diffdelta.io for help.",
      400
    );
  }

  // ── Create Stripe Billing Portal session ──
  const origin = new URL(request.url).origin;

  const res = await fetch(
    "https://api.stripe.com/v1/billing_portal/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: keyData.customer_id,
        return_url: `${origin}/pro`,
      }),
    }
  );

  const session: PortalSession = await res.json();

  if (!session.url) {
    console.error("Stripe portal creation failed:", session.error?.message);
    return errorResponse(
      "Failed to create billing portal session. Try again or contact human@diffdelta.io.",
      500
    );
  }

  return jsonResponse({
    url: session.url,
    message: "Redirect to this URL to manage your subscription.",
  });
};
