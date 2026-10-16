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
  const attributionId = await getCommishAttribution();
  const { data: prepared } = await options.commish.checkoutPromotions.prepare({
    programId: options.programId,
    attemptId: options.attemptId,
    attributionId,
    mode: params.mode,
    customerId: params.client_reference_id,
    ...(params.customer ? { stripeCustomerId: params.customer } : {}),
    lineItems: params.line_items,
  });
  const next = applyPreparedCheckoutPromotion(
    applyCommishStripeMetadata(params, attributionId),
    prepared,
  );
  const session = await options.createSession(next, {
    idempotencyKey: prepared.stripeIdempotencyKey,
  });
  await options.commish.checkoutPromotions.confirm({
    attemptId: prepared.attemptId,
    sessionId: session.id,
  });
  return session;
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
            trial_settings: params.subscription_data?.trial_settings ?? trial.trial_settings,
          },
        }
      : {}),
  };
  if (checkout.discounts) delete next.allow_promotion_codes;
  return next;
}
