import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";

// node --test isolates each file, so this request cookie stub stays local to this file.
const cookie = { value: "atr_123456789012" };
globalThis.commishCheckoutTestCookie = cookie;
const headersStub =
  "data:text/javascript,export const cookies = async () => " +
  "({ get: () => ({ value: globalThis.commishCheckoutTestCookie.value }) });";
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === "next/headers.js"
      ? { url: headersStub, shortCircuit: true }
      : nextResolve(specifier, context),
});
const { CommishCheckoutError, applyPreparedCheckoutPromotion, createCommishCheckout } =
  await import("../packages/next/dist/index.js");

const attemptId = "00000000-0000-4000-8000-000000000001";
const cancellingTrial = (duration) => ({
  ...duration,
  trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
});
const prepared = {
  attemptId,
  checkoutAttemptId: "cart-1",
  stripeIdempotencyKey: `commish:checkout:${attemptId}`,
  promotionName: "Welcome",
  parameters: {
    expires_at: 1799999000,
    discounts: [{ promotion_code: "promo_TIM" }],
    metadata: { commish_promotion_attempt: attemptId },
    subscription_data: cancellingTrial({ trial_end: 1800000000 }),
  },
};
const params = {
  mode: "subscription",
  client_reference_id: "buyer",
  customer: "cus_buyer",
  line_items: [{ price: "price_plan", quantity: 1 }],
  success_url: "https://merchant.test/success",
  allow_promotion_codes: true,
  metadata: { merchant: "kept" },
  subscription_data: { metadata: { plan: "kept" } },
};
const commishFor = (data = prepared, confirm = async (input) => ({ data: input })) => ({
  checkoutPromotions: { prepare: mock.fn(async () => ({ data })), confirm: mock.fn(confirm) },
});
const checkout = (overrides) =>
  createCommishCheckout({
    commish: commishFor(),
    programId: "prg_123456789012",
    attemptId: "cart-1",
    params,
    createSession: mock.fn(async () => ({ id: "cs_test_checkout" })),
    ...overrides,
  });

test("checkout merge preserves merchant settings and applies one native discount", () => {
  const merged = applyPreparedCheckoutPromotion(params, prepared);
  assert.equal(merged.success_url, params.success_url);
  assert.deepEqual(merged.discounts, [{ promotion_code: "promo_TIM" }]);
  assert.deepEqual(merged.subscription_data, {
    metadata: { plan: "kept" },
    ...prepared.parameters.subscription_data,
  });
  assert.equal(merged.metadata.merchant, "kept");
  assert.equal(Object.hasOwn(merged, "allow_promotion_codes"), false);
  assert.equal(params.allow_promotion_codes, true);
});

for (const merchantPolicy of ["create_invoice", "pause"]) {
  for (const duration of [{ trial_end: 1800000000 }, { trial_period_days: 2 }]) {
    test(`checkout keeps prepared ${Object.keys(duration)[0]} cancellation over merchant ${merchantPolicy}`, async () => {
      const merchantParams = {
        ...params,
        payment_method_collection: "if_required",
        subscription_data: {
          ...params.subscription_data,
          description: "Merchant subscription",
          trial_settings: { end_behavior: { missing_payment_method: merchantPolicy } },
        },
      };
      const trial = cancellingTrial(duration);
      const commish = commishFor({
        ...prepared,
        parameters: { ...prepared.parameters, subscription_data: trial },
      });
      const createSession = mock.fn(async () => ({ id: "cs_test_checkout" }));
      assert.deepEqual(await checkout({ commish, params: merchantParams, createSession }), {
        id: "cs_test_checkout",
      });
      const [sent, options] = createSession.mock.calls[0].arguments;
      assert.deepEqual(options, { idempotencyKey: prepared.stripeIdempotencyKey });
      assert.equal(sent.payment_method_collection, "if_required");
      assert.equal(sent.expires_at, prepared.parameters.expires_at);
      assert.deepEqual(sent.discounts, prepared.parameters.discounts);
      assert.deepEqual(sent.metadata, {
        merchant: "kept",
        commish_attribution: "atr_123456789012",
        ...prepared.parameters.metadata,
      });
      assert.deepEqual(sent.subscription_data, {
        metadata: {
          plan: "kept",
          commish_attribution: "atr_123456789012",
          commish_customer_id: "buyer",
        },
        description: "Merchant subscription",
        ...trial,
      });
      assert.deepEqual(commish.checkoutPromotions.confirm.mock.calls[0].arguments, [
        { attemptId, sessionId: "cs_test_checkout" },
      ]);
      assert.equal(
        merchantParams.subscription_data.trial_settings.end_behavior.missing_payment_method,
        merchantPolicy,
      );
    });
  }
}

test("checkout prepares with the referral and Stripe customer, then binds before returning", async () => {
  const commish = commishFor();
  const createSession = mock.fn(async () => ({
    id: "cs_test_checkout",
    url: "https://checkout.stripe.com/test",
  }));
  assert.equal((await checkout({ commish, createSession })).id, "cs_test_checkout");
  const [input] = commish.checkoutPromotions.prepare.mock.calls[0].arguments;
  assert.equal(input.attributionId, "atr_123456789012");
  assert.equal(input.stripeCustomerId, "cus_buyer");
  assert.equal(
    createSession.mock.calls[0].arguments[0].metadata.commish_attribution,
    input.attributionId,
  );
  assert.equal(commish.checkoutPromotions.confirm.mock.callCount(), 1);
});

test("checkout rejects a preexisting discount instead of replacing it", async () => {
  const commish = commishFor();
  await assert.rejects(
    () => checkout({ commish, params: { ...params, discounts: [{ coupon: "existing" }] } }),
    /Configure the discount and trial/,
  );
  assert.equal(commish.checkoutPromotions.prepare.mock.callCount(), 0);
});

test("checkout sends only price and quantity to Commish but full line items to Stripe", async () => {
  const commish = commishFor();
  const createSession = mock.fn(async () => ({ id: "cs_test_checkout" }));
  const line_items = [
    { price: "price_plan", quantity: 1, adjustable_quantity: { enabled: true, maximum: 5 } },
  ];
  await checkout({ commish, params: { ...params, line_items }, createSession });
  assert.deepEqual(commish.checkoutPromotions.prepare.mock.calls[0].arguments[0].lineItems, [
    { price: "price_plan", quantity: 1 },
  ]);
  assert.deepEqual(createSession.mock.calls[0].arguments[0].line_items, line_items);
});

test("checkout names the prepared attempt when Stripe or confirmation fails", async () => {
  const failure = new Error("Stripe unavailable");
  for (const [createSession, confirm] of [
    [async () => Promise.reject(failure), async () => Promise.reject(new Error("unused"))],
    [async () => ({ id: "cs_test" }), async () => Promise.reject(failure)],
  ])
    await assert.rejects(
      () => checkout({ commish: commishFor(prepared, confirm), createSession }),
      (error) =>
        error instanceof CommishCheckoutError &&
        error.name === "CommishCheckoutError" &&
        error.attemptId === attemptId &&
        error.cause === failure,
    );
});

test("checkout merge keeps a merchant's disabled code entry when no offer applies", () => {
  const merged = applyPreparedCheckoutPromotion(
    { ...params, allow_promotion_codes: false },
    {
      ...prepared,
      parameters: {
        expires_at: prepared.parameters.expires_at,
        metadata: prepared.parameters.metadata,
        allow_promotion_codes: true,
      },
    },
  );
  assert.equal(merged.allow_promotion_codes, false);
});

test("checkout ignores a malformed cookie and stale merchant referral metadata", async (t) => {
  cookie.value = "not-a-referral";
  t.after(() => {
    cookie.value = "atr_123456789012";
  });
  const commish = commishFor();
  const createSession = mock.fn(async () => ({ id: "cs_test_checkout" }));
  await checkout({
    commish,
    params: {
      ...params,
      metadata: { merchant: "kept", commish_attribution: "atr_stalereferral1" },
      subscription_data: {
        metadata: { plan: "kept", commish_attribution: "atr_stalereferral1" },
      },
    },
    createSession,
  });
  assert.equal(commish.checkoutPromotions.prepare.mock.calls[0].arguments[0].attributionId, null);
  const [session] = createSession.mock.calls[0].arguments;
  assert.deepEqual(session.metadata, {
    merchant: "kept",
    ...prepared.parameters.metadata,
  });
  // The subscription must not carry the stale referral into renewals.
  assert.deepEqual(session.subscription_data?.metadata, { plan: "kept" });
});
