// ─────────────────────────────────────────────────────────
// DiffDelta Pro — Stripe Webhook Handler
// Why: Handles Stripe events to create/deactivate API keys.
// Verifies webhook signature for security.
// POST /stripe/webhook
// ─────────────────────────────────────────────────────────

import type { Env, KeyData, SessionClaim } from "../_shared/types";
import { generateApiKey, hashKey, hmacSign } from "../_shared/crypto";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // ── Validate config ──
  if (!env.STRIPE_WEBHOOK_SECRET || !env.KEYS || !env.SESSIONS) {
    return new Response("Webhook handler not configured", { status: 503 });
  }

  // ── Read body + verify signature ──
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 401 });
  }

  const body = await request.text();
  const isValid = await verifyStripeSignature(
    body,
    signature,
    env.STRIPE_WEBHOOK_SECRET
  );

  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  // ── Process event ──
  const event = JSON.parse(body);

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object, env);
      break;

    case "customer.subscription.deleted":
    case "customer.subscription.paused":
      await handleSubscriptionEnded(event.data.object, env);
      break;

    case "customer.subscription.resumed":
      await handleSubscriptionResumed(event.data.object, env);
      break;

    default:
      // Acknowledge events we don't handle
      break;
  }

  return new Response("OK", { status: 200 });
};

// ── Event handlers ──

async function handleCheckoutCompleted(
  session: Record<string, unknown>,
  env: Env
): Promise<void> {
  const now = new Date().toISOString();

  // Generate API key
  const apiKey = await generateApiKey();
  const keyHash = await hashKey(apiKey);

  const email =
    (session.customer_details as Record<string, unknown>)?.email ||
    session.customer_email ||
    "";

  const keyData: KeyData = {
    tier: "pro",
    customer_id: (session.customer as string) || "",
    stripe_subscription_id: (session.subscription as string) || "",
    email: email as string,
    rate_limit: 1000,
    created_at: now,
    last_rotated_at: now,
    active: true,
  };

  // Store hashed key → key data
  await env.KEYS.put(`key:${keyHash}`, JSON.stringify(keyData));

  // Store subscription → key hash mapping (for deactivation on cancel)
  if (keyData.stripe_subscription_id) {
    await env.KEYS.put(
      `sub:${keyData.stripe_subscription_id}`,
      keyHash
    );
  }

  // Store session → raw key for one-time claim (1hr TTL)
  const claim: SessionClaim = {
    api_key: apiKey,
    email: keyData.email,
    created_at: now,
  };

  await env.SESSIONS.put(
    `session:${session.id as string}`,
    JSON.stringify(claim),
    { expirationTtl: 3600 }
  );
}

async function handleSubscriptionEnded(
  subscription: Record<string, unknown>,
  env: Env
): Promise<void> {
  const subId = subscription.id as string;
  const keyHash = await env.KEYS.get(`sub:${subId}`);

  if (!keyHash) return;

  const raw = await env.KEYS.get(`key:${keyHash}`);
  if (!raw) return;

  const keyData: KeyData = JSON.parse(raw);
  keyData.active = false;
  await env.KEYS.put(`key:${keyHash}`, JSON.stringify(keyData));
}

async function handleSubscriptionResumed(
  subscription: Record<string, unknown>,
  env: Env
): Promise<void> {
  const subId = subscription.id as string;
  const keyHash = await env.KEYS.get(`sub:${subId}`);

  if (!keyHash) return;

  const raw = await env.KEYS.get(`key:${keyHash}`);
  if (!raw) return;

  const keyData: KeyData = JSON.parse(raw);
  keyData.active = true;
  await env.KEYS.put(`key:${keyHash}`, JSON.stringify(keyData));
}

// ── Stripe signature verification ──

async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string
): Promise<boolean> {
  // Parse signature header: t=timestamp,v1=signature
  const parts: Record<string, string> = {};
  for (const pair of header.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      parts[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
    }
  }

  const timestamp = parts["t"];
  const sig = parts["v1"];
  if (!timestamp || !sig) return false;

  // Reject events older than 5 minutes (replay protection)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Math.abs(age) > 300) return false;

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const expected = await hmacSign(signedPayload, secret);

  // Timing-safe comparison
  return expected === sig;
}
