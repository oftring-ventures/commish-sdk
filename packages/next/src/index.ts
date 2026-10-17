import type { Commish, PreparedCheckoutPromotion } from "@commish/sdk";
import { cookies } from "next/headers.js";
import { COMMISH_COOKIE } from "./capture.js";

export { COMMISH_COOKIE, createAttributionHandler } from "./capture.js";

import { applyCommishStripeMetadata, type StripeCheckoutParams } from "./metadata.js";

export { applyCommishStripeMetadata };

export async function getCommishAttribution(): Promise<string | null> {
  return (await cookies()).get(COMMISH_COOKIE)?.value ?? null;
}

export async function withCommishStripeMetadata<T extends StripeCheckoutParams>(
  params: T,
): Promise<T> {
  return applyCommishStripeMetadata(params, await getCommishAttribution());
}

type BuyerPromotionCheckoutParams = StripeCheckoutParams & {
  mode: "payment" | "subscription";
  client_reference_id: string;
  customer?: string;
  line_items: { price: string; quantity: number }[];
  discounts?: unknown;
  allow_promotion_codes?: boolean;
};

/**
 * Thrown when Stripe Checkout creation or confirmation fails after Commish
 * prepared the attempt. A prepared trial stays reserved until
 * `checkoutPromotions.reconcile({ attemptId })` confirms abandonment.
 */
export class CommishCheckoutError extends Error {
  override readonly name = "CommishCheckoutError";
  constructor(
    readonly attemptId: string,
    cause: unknown,
  ) {
    super("Stripe Checkout failed after Commish prepared the attempt", { cause });
  }
}

/** Uses the merchant's Stripe client and Checkout UI; never creates a payment itself. */
export async function createCommishCheckout<
  T extends BuyerPromotionCheckoutParams,
  S extends { id: string },
>(options: {
  commish: {
    checkoutPromotions: Pick<Commish["checkoutPromotions"], "prepare" | "confirm">;
  };
  programId: string;
  attemptId: string;
  params: T;
  createSession: (params: T, options: { idempotencyKey: string }) => Promise<S>;
}): Promise<S> {
  const { params } = options;
  if (
    params.discounts !== undefined ||
    params.subscription_data?.trial_end !== undefined ||
    params.subscription_data?.trial_period_days !== undefined
  )
    throw new Error(
      "Configure the discount and trial in Commish before using createCommishCheckout",
    );
  const cookie = await getCommishAttribution();
  // A malformed cookie is not a referral and must not fail the checkout.
  const attributionId = cookie && /^atr_[A-Za-z0-9_-]{12,}$/.test(cookie) ? cookie : null;
  const { data: prepared } = await options.commish.checkoutPromotions.prepare({
    programId: options.programId,
    attemptId: options.attemptId,
    attributionId,
    mode: params.mode,
    customerId: params.client_reference_id,
    ...(params.customer ? { stripeCustomerId: params.customer } : {}),
    // Stripe receives the merchant's full line items; Commish needs only these.
    lineItems: params.line_items.map(({ price, quantity }) => ({ price, quantity })),
  });
  // The session and the subscription it creates carry exactly the referral
  // Commish prepared; a stale merchant-supplied referral is dropped from both.
  const metadata = { ...params.metadata };
  delete metadata.commish_attribution;
  const subscription = params.subscription_data?.metadata && {
    ...params.subscription_data.metadata,
  };
  delete subscription?.commish_attribution;
  const next = applyPreparedCheckoutPromotion(
    applyCommishStripeMetadata(
      attributionId
        ? params
        : {
            ...params,
            metadata,
            ...(subscription
              ? { subscription_data: { ...params.subscription_data, metadata: subscription } }
              : {}),
          },
      attributionId,
    ),
    prepared,
  );
  try {
    const session = await options.createSession(next, {
      idempotencyKey: prepared.stripeIdempotencyKey,
    });
    await options.commish.checkoutPromotions.confirm({
      attemptId: prepared.attemptId,
      sessionId: session.id,
    });
    return session;
  } catch (error) {
    throw new CommishCheckoutError(prepared.attemptId, error);
  }
}

export function applyPreparedCheckoutPromotion<T extends BuyerPromotionCheckoutParams>(
  params: T,
  prepared: PreparedCheckoutPromotion,
): T {
  const { subscription_data: trial, metadata, ...checkout } = prepared.parameters;
  const next = {
    ...params,
    ...checkout,
    metadata: { ...params.metadata, ...metadata },
    ...(trial
      ? {
          subscription_data: {
            ...params.subscription_data,
            ...trial,
          },
        }
      : {}),
  };
  if (checkout.discounts) delete next.allow_promotion_codes;
  // Commish never turns on code entry a merchant turned off.
  else if (params.allow_promotion_codes === false) next.allow_promotion_codes = false;
  return next;
}
