export type CheckoutPromotionInput = {
  programId: string;
  attemptId: string;
  attributionId: string | null;
  mode: "payment" | "subscription";
  customerId: string;
  stripeCustomerId?: string;
  lineItems: { price: string; quantity: number }[];
};
export type PreparedCheckoutPromotion = {
  attemptId: string;
  /** Echo of the request's cart attempt key. */
  checkoutAttemptId: string;
  stripeIdempotencyKey: string;
  promotionName: string | null;
  parameters: {
    expires_at: number;
    discounts?: [{ promotion_code: string }];
    allow_promotion_codes?: boolean;
    subscription_data?: {
      trial_end?: number;
      trial_period_days?: number;
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } };
    };
    metadata: { commish_promotion_attempt: string };
  };
};
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
/** Commish returns attempt UUIDs in lowercase; send and compare that form. */
export function promotionAttemptId(value: string): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!uuid.test(id)) throw new TypeError("Use the prepared Commish checkout attempt ID");
  return id;
}
/**
 * Validates a prepare response; with the request, also that it answers that
 * cart attempt and grants a trial only to a subscription with a customer.
 */
export function assertPreparedCheckoutPromotion(
  value: unknown,
  input?: CheckoutPromotionInput,
): asserts value is PreparedCheckoutPromotion {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const only = (v: Record<string, unknown>, allowed: string[]) =>
    Object.keys(v).every((key) => allowed.includes(key));
  const invalid = () => {
    throw new Error("Invalid checkout promotion response");
  };
  if (
    !record(value) ||
    !only(value, [
      "attemptId",
      "checkoutAttemptId",
      "stripeIdempotencyKey",
      "promotionName",
      "parameters",
    ]) ||
    typeof value.attemptId !== "string" ||
    !uuid.test(value.attemptId) ||
    typeof value.checkoutAttemptId !== "string" ||
    (input && value.checkoutAttemptId !== input.attemptId.trim()) ||
    value.stripeIdempotencyKey !== `commish:checkout:${value.attemptId}` ||
    (value.promotionName !== null && typeof value.promotionName !== "string") ||
    !record(value.parameters)
  )
    return invalid();
  const p = value.parameters;
  if (
    !only(p, [
      "expires_at",
      "discounts",
      "allow_promotion_codes",
      "subscription_data",
      "metadata",
    ]) ||
    !record(p.metadata) ||
    !only(p.metadata, ["commish_promotion_attempt"]) ||
    p.metadata.commish_promotion_attempt !== value.attemptId
  )
    return invalid();
  if (!Number.isSafeInteger(p.expires_at) || typeof p.expires_at !== "number" || p.expires_at <= 0)
    return invalid();
  if (p.allow_promotion_codes !== undefined && typeof p.allow_promotion_codes !== "boolean")
    return invalid();
  if (
    p.discounts !== undefined &&
    (!Array.isArray(p.discounts) ||
      p.discounts.length !== 1 ||
      !record(p.discounts[0]) ||
      !only(p.discounts[0], ["promotion_code"]) ||
      typeof p.discounts[0].promotion_code !== "string" ||
      !/^promo_[A-Za-z0-9]+$/.test(p.discounts[0].promotion_code) ||
      p.allow_promotion_codes !== undefined)
  )
    return invalid();
  if (p.subscription_data !== undefined) {
    const s = p.subscription_data;
    if (input && (input.mode !== "subscription" || !input.stripeCustomerId)) return invalid();
    // Native code entry cannot exclude discounts the trial would consume.
    if (
      (p.discounts === undefined && p.allow_promotion_codes !== false) ||
      !record(s) ||
      !only(s, ["trial_end", "trial_period_days", "trial_settings"]) ||
      (s.trial_end !== undefined) === (s.trial_period_days !== undefined) ||
      (s.trial_end !== undefined &&
        (!Number.isSafeInteger(s.trial_end) ||
          typeof s.trial_end !== "number" ||
          s.trial_end <= 0)) ||
      (s.trial_period_days !== undefined &&
        (!Number.isSafeInteger(s.trial_period_days) ||
          typeof s.trial_period_days !== "number" ||
          s.trial_period_days < 2 ||
          s.trial_period_days > 730)) ||
      !record(s.trial_settings) ||
      !only(s.trial_settings, ["end_behavior"]) ||
      !record(s.trial_settings.end_behavior) ||
      !only(s.trial_settings.end_behavior, ["missing_payment_method"]) ||
      s.trial_settings.end_behavior.missing_payment_method !== "cancel"
    )
      return invalid();
  }
}
