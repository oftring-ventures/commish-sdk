import assert from "node:assert/strict";
import test from "node:test";
import { applyPreparedCheckoutPromotion } from "../packages/next/dist/index.js";
import { Commish } from "../packages/sdk/dist/index.js";

const attemptId = "00000000-0000-4000-8000-000000000001";
const prepared = {
  attemptId,
  checkoutAttemptId: "cart:one",
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
for (const merchantPolicy of ["create_invoice", "pause"]) {
  for (const duration of [{ trial_end: 1800000000 }, { trial_period_days: 2 }]) {
    test(`prepared ${Object.keys(duration)[0]} cancellation overrides merchant ${merchantPolicy}`, () => {
      const params = {
        mode: "subscription",
        client_reference_id: "buyer",
        line_items: [{ price: "price_plan", quantity: 1 }],
        payment_method_collection: "if_required",
        metadata: { order: "kept" },
        subscription_data: {
          metadata: { plan: "kept" },
          description: "Merchant subscription",
          trial_settings: { end_behavior: { missing_payment_method: merchantPolicy } },
        },
      };
      const trial = {
        ...duration,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      };
      const result = applyPreparedCheckoutPromotion(params, {
        ...prepared,
        parameters: { ...prepared.parameters, subscription_data: trial },
      });
      assert.deepEqual(result.subscription_data, {
        metadata: { plan: "kept" },
        description: "Merchant subscription",
        ...trial,
      });
      assert.equal(result.payment_method_collection, "if_required");
      assert.deepEqual(result.metadata, {
        order: "kept",
        commish_promotion_attempt: attemptId,
      });
      assert.equal(result.expires_at, prepared.parameters.expires_at);
      assert.deepEqual(result.discounts, prepared.parameters.discounts);
      assert.equal(
        params.subscription_data.trial_settings.end_behavior.missing_payment_method,
        merchantPolicy,
      );
    });
  }
}

test("discount-only preparation preserves merchant subscription settings", () => {
  const subscription = {
    metadata: { plan: "kept" },
    trial_settings: { end_behavior: { missing_payment_method: "pause" } },
  };
  const result = applyPreparedCheckoutPromotion(
    {
      mode: "subscription",
      client_reference_id: "buyer",
      line_items: [{ price: "price_plan", quantity: 1 }],
      subscription_data: subscription,
    },
    prepared,
  );
  assert.deepEqual(result.subscription_data, subscription);
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

const page = {
  protocol: "commish-pages-v1",
  pageId: "cpg_123456789012",
  programId: "prg_123456789012",
  mode: "test",
  origin: "https://merchant.test",
  canonicalPath: "/creators/tim",
  rootAliasEnabled: false,
  status: "ready",
  revision: "00000000-0000-4000-8000-000000000001",
  creator: { handle: "tim" },
  content: {
    brand: { name: "Merchant", logoUrl: null, accentColor: "#123456" },
    headline: "Tim’s offer",
    description: "Welcome",
    productImageUrl: null,
    benefits: [],
    offer: { title: "Welcome", description: "Save on eligible products" },
    cta: { label: "Shop", url: "https://merchant.test/shop" },
    disclosures: ["Tim may earn a commission."],
  },
  couponCode: null,
  preferredPath: "/creators/tim",
  experimentEnabled: false,
};
const buyerPromotion = {
  name: "Welcome",
  discount: { percentOff: 20, amountOff: null, duration: "once" },
  trial: { unit: "months", count: 2 },
  code: "TIM20",
};
const response = { protocol: "commish-pages-v2", page, buyerPromotion };

test("Pages v2 negotiates an offer without changing the nested v1 contract", async () => {
  const client = new Commish({
    secretKey: "cm_test_sk_promotions12345",
    fetch: async (_url, options) => {
      assert.equal(
        new Headers(options.headers).get("x-commish-pages-protocol"),
        "commish-pages-v2",
      );
      return Response.json({ data: response });
    },
  });
  assert.deepEqual(
    (await client.pages.resolveWithPromotions({ programId: page.programId, handle: "tim" })).data,
    response,
  );
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

const sdk = (respond) => {
  const calls = [];
  const client = new Commish({
    secretKey: "cm_test_sk_promotions12345",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return respond();
    },
  });
  return { calls, client };
};
const request = {
  programId: "prg_123456789012",
  attemptId: " cart:one ",
  attributionId: null,
  mode: "subscription",
  customerId: "buyer",
  stripeCustomerId: "cus_buyer",
  lineItems: [{ price: "price_plan", quantity: 1 }],
};
const preparing = (parameters, input = request, response = prepared) =>
  sdk(() => Response.json({ data: { ...response, parameters } })).client.checkoutPromotions.prepare(
    input,
  );
const cancellingTrial = {
  trial_period_days: 2,
  trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
};
const trialOnly = {
  expires_at: prepared.parameters.expires_at,
  metadata: prepared.parameters.metadata,
  allow_promotion_codes: false,
  subscription_data: cancellingTrial,
};

test("server client accepts one native trial duration and rejects ambiguous durations", async () => {
  assert.deepEqual((await preparing(trialOnly)).data.parameters, trialOnly);
  for (const subscription_data of [
    { ...cancellingTrial, trial_end: 1800000000 },
    { ...cancellingTrial, trial_period_days: 1 },
  ])
    await assert.rejects(
      () => preparing({ ...trialOnly, subscription_data }),
      /Invalid checkout promotion response/,
    );
});

for (const [name, parameters] of [
  ["both discount switches", { ...prepared.parameters, allow_promotion_codes: true }],
  ["a missing expiry", { ...prepared.parameters, expires_at: undefined }],
  [
    "another attempt's metadata",
    { ...prepared.parameters, metadata: { commish_promotion_attempt: "other" } },
  ],
])
  test(`server client rejects a patch with ${name}`, async () => {
    await assert.rejects(() => preparing(parameters), /Invalid checkout promotion response/);
  });

test("server client rejects code entry beside a trial without a fixed discount", async () => {
  for (const allow_promotion_codes of [true, undefined])
    await assert.rejects(
      () => preparing({ ...trialOnly, allow_promotion_codes }),
      /Invalid checkout promotion response/,
    );
  const discounted = { ...prepared.parameters, subscription_data: cancellingTrial };
  assert.deepEqual((await preparing(discounted)).data.parameters, discounted);
});

// Hex letters make lowercasing observable; an all-digit UUID would hide it.
const lettered = "00000000-0000-4000-8000-00000000abcd";
test("confirmation sends and compares the normalized attempt UUID", async () => {
  const sessionId = "cs_test_session";
  const { calls, client } = sdk(() => Response.json({ data: { attemptId: lettered, sessionId } }));
  assert.deepEqual(
    await client.checkoutPromotions.confirm({
      attemptId: ` ${lettered.toUpperCase()} `,
      sessionId,
    }),
    { data: { attemptId: lettered, sessionId } },
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), { attemptId: lettered, sessionId });
  assert.equal(new Headers(calls[0].options.headers).get("idempotency-key"), lettered);
  await assert.rejects(
    () => client.checkoutPromotions.confirm({ attemptId: "cart-1", sessionId }),
    TypeError,
  );
  await assert.rejects(
    () => client.checkoutPromotions.reconcile({ attemptId: "cart-1" }),
    TypeError,
  );
  assert.equal(calls.length, 1);
});

for (const data of [
  { attemptId: lettered, released: false },
  { attemptId: "00000000-0000-4000-8000-000000000002", released: true },
  {},
])
  test(`reconciliation rejects a response for another state: ${JSON.stringify(data)}`, async () => {
    await assert.rejects(
      () =>
        sdk(() => Response.json({ data })).client.checkoutPromotions.reconcile({
          attemptId: lettered,
        }),
      { name: "CommishError", code: "invalid_response" },
    );
  });

test("reconciliation accepts the released requested attempt", async () => {
  const { calls, client } = sdk(() =>
    Response.json({ data: { attemptId: lettered, released: true } }),
  );
  assert.deepEqual(
    await client.checkoutPromotions.reconcile({ attemptId: lettered.toUpperCase() }),
    { data: { attemptId: lettered, released: true } },
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), { attemptId: lettered });
  assert.equal(new Headers(calls[0].options.headers).get("idempotency-key"), lettered);
});

test("an expired attempt's ID is exposed for reconciliation", async () => {
  const expired = (details) =>
    sdk(() =>
      Response.json(
        {
          error: {
            code: "checkout_attempt_expired",
            message: "Expired",
            request_id: "req_1",
            details,
          },
        },
        { status: 409 },
      ),
    ).client.checkoutPromotions.prepare({
      programId: "prg_123456789012",
      attemptId: "cart-1",
      attributionId: null,
      mode: "payment",
      customerId: "buyer",
      lineItems: [{ price: "price_hardware", quantity: 1 }],
    });
  await assert.rejects(() => expired({ attemptId }), {
    name: "CommishError",
    status: 409,
    code: "checkout_attempt_expired",
    requestId: "req_1",
    details: { attemptId },
  });
  for (const details of [[attemptId], "attempt", undefined])
    await assert.rejects(
      () => expired(details),
      (error) => error.code === "checkout_attempt_expired" && error.details === undefined,
    );
});

test("server client binds a prepared response to its request", async () => {
  const trial = { ...prepared.parameters, subscription_data: cancellingTrial };
  assert.deepEqual((await preparing(trial)).data.parameters, trial);
  for (const input of [
    { ...request, attemptId: "cart:two" },
    { ...request, mode: "payment" },
    { ...request, stripeCustomerId: undefined },
  ])
    await assert.rejects(() => preparing(trial, input), /Invalid checkout promotion response/);
  for (const checkoutAttemptId of [undefined, 1])
    await assert.rejects(
      () => preparing(prepared.parameters, request, { ...prepared, checkoutAttemptId }),
      /Invalid checkout promotion response/,
    );
});
