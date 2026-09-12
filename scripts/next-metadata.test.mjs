import assert from "node:assert/strict";
import test from "node:test";
import { applyCommishStripeMetadata } from "../packages/next/src/index.ts";

test("missing attribution preserves the original Checkout object", () => {
  const input = Object.freeze({ mode: "payment", metadata: Object.freeze({ order: "one" }) });
  assert.equal(applyCommishStripeMetadata(input, null), input);
  assert.equal(applyCommishStripeMetadata(input, ""), input);
});

test("payment attribution preserves unrelated metadata without changing subscription data", () => {
  const subscription = Object.freeze({ metadata: Object.freeze({ keep: "subscription" }) });
  const input = Object.freeze({
    mode: "payment",
    client_reference_id: "customer_1",
    amount: 4200,
    metadata: Object.freeze({
      order: "one",
      count: 2,
      optional: null,
      commish_attribution: "old",
    }),
    subscription_data: subscription,
  });
  const result = applyCommishStripeMetadata(input, "attribution_1");
  assert.notEqual(result, input);
  assert.notEqual(result.metadata, input.metadata);
  assert.deepEqual(result, {
    ...input,
    metadata: { order: "one", count: 2, optional: null, commish_attribution: "attribution_1" },
  });
  assert.equal(result.subscription_data, subscription);
  assert.equal(input.metadata.commish_attribution, "old");
});

test("subscription attribution preserves nested fields and correlates its customer", () => {
  const input = Object.freeze({
    mode: "subscription",
    client_reference_id: "customer_1",
    metadata: Object.freeze({ checkout: "keep" }),
    subscription_data: Object.freeze({
      trial_period_days: 14,
      metadata: Object.freeze({ source: "keep", commish_customer_id: "old" }),
    }),
  });
  const result = applyCommishStripeMetadata(input, "attribution_2");
  assert.deepEqual(result.metadata, { checkout: "keep", commish_attribution: "attribution_2" });
  assert.deepEqual(result.subscription_data, {
    trial_period_days: 14,
    metadata: {
      source: "keep",
      commish_attribution: "attribution_2",
      commish_customer_id: "customer_1",
    },
  });
  assert.equal(input.subscription_data.metadata.commish_customer_id, "old");
});

test("subscription defaults do not invent a customer reference", () => {
  assert.deepEqual(applyCommishStripeMetadata({ mode: "subscription" }, "attribution_3"), {
    mode: "subscription",
    metadata: { commish_attribution: "attribution_3" },
    subscription_data: { metadata: { commish_attribution: "attribution_3" } },
  });
});
