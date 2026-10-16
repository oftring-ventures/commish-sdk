import assert from "node:assert/strict";
import test from "node:test";
import { applyPreparedCheckoutPromotion } from "../packages/next/dist/index.js";
import { Commish } from "../packages/sdk/dist/index.js";

const attemptId = "00000000-0000-4000-8000-000000000001";
const prepared = {
  attemptId,
  stripeIdempotencyKey: `commish:checkout:${attemptId}`,
  promotionName: "Welcome",
  parameters: {
    expires_at: 1800000000,
    discounts: [{ promotion_code: "promo_TIM" }],
    metadata: { commish_promotion_attempt: attemptId },
  },
};
test("published server client prepares native parameters with a stable cart identity", async () => {
  const calls = [];
  const client = new Commish({
    secretKey: "cm_test_sk_promotions12345",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ data: prepared });
    },
  });
  assert.deepEqual(
    (
      await client.checkoutPromotions.prepare({
        programId: "prg_123456789012",
        attemptId: "cart:one",
        attributionId: null,
        customerId: "buyer",
        mode: "payment",
        lineItems: [{ price: "price_one", quantity: 1 }],
      })
    ).data,
    prepared,
  );
  assert.equal(calls[0].options.headers["idempotency-key"], "cart:one");
  assert.equal(new URL(calls[0].url).pathname, "/api/v1/checkout-promotions/prepare");
});
test("server client rejects unexpected financial fields in a response", async () => {
  const client = new Commish({
    secretKey: "cm_test_sk_promotions12345",
    fetch: async () =>
      Response.json({
        data: {
          ...prepared,
          parameters: {
            ...prepared.parameters,
            payment_intent_data: { application_fee_amount: 100 },
          },
        },
      }),
  });
  await assert.rejects(
    () => client.checkoutPromotions.prepare({ attemptId: "cart:one" }),
    /Invalid checkout promotion response/,
  );
});
test("Next merge preserves merchant settings and never sends both discount switches", () => {
  const result = applyPreparedCheckoutPromotion(
    {
      mode: "payment",
      client_reference_id: "buyer",
      line_items: [{ price: "price_one", quantity: 1 }],
      success_url: "https://merchant.test/success",
      metadata: { order: "kept" },
      allow_promotion_codes: true,
    },
    prepared,
  );
  assert.equal(result.success_url, "https://merchant.test/success");
  assert.equal(result.metadata.order, "kept");
  assert.equal(result.expires_at, 1800000000);
  assert.equal(Object.hasOwn(result, "allow_promotion_codes"), false);
});

test("trial-only Checkout overrides merchant code entry", () => {
  const result = applyPreparedCheckoutPromotion(
    {
      mode: "subscription",
      client_reference_id: "buyer",
      line_items: [{ price: "price_plan", quantity: 1 }],
      allow_promotion_codes: true,
    },
    {
      ...prepared,
      parameters: {
        expires_at: prepared.parameters.expires_at,
        metadata: prepared.parameters.metadata,
        allow_promotion_codes: false,
        subscription_data: {
          trial_period_days: 2,
          trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        },
      },
    },
  );
  assert.equal(result.allow_promotion_codes, false);
  assert.equal(result.subscription_data.trial_period_days, 2);
});
