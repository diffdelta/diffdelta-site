// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Stripe Checkout
// Why: Creates a Stripe Checkout Session and redirects the
// user to complete payment. No API key required.
// GET /api/v1/checkout → 303 redirect to Stripe
// ─────────────────────────────────────────────────────────

import { errorResponse } from "../../_shared/response";
import type { Env } from "../../_shared/types";

interface StripeSession {
  id: string;
  url: string | null;
  error?: { message: string };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const origin = new URL(request.url).origin;

  // ── Validate Stripe is configured ──
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
    return errorResponse(
      "Payment system not configured yet. Please check back soon.",
      503
    );
  }

  // ── Create Stripe Checkout Session ──
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": env.STRIPE_PRICE_ID,
      "line_items[0][quantity]": "1",
      success_url: `${origin}/pro-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#pricing`,
      allow_promotion_codes: "true",
      "subscription_data[metadata][source]": "diffdelta_website",
    }),
  });

  const session: StripeSession = await res.json();

  if (!session.url) {
    console.error("Stripe checkout creation failed:", session.error?.message);
    return errorResponse(
      "Failed to create checkout session. Please try again.",
      500
    );
  }

  // ── Redirect to Stripe Checkout ──
  return Response.redirect(session.url, 303);
};
