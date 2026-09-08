import type { PublicPayout, PublicMembership, PublicWebhookDelivery } from "@commish/sdk";
import { captureReferral } from "@commish/sdk/browser";
const payout: PublicPayout = {
  id: "pay_fixture",
  mode: "test",
  status: "pending",
  processedAt: null,
};
// @ts-expect-error Public diagnostic types do not grant live access.
const live: PublicPayout = { ...payout, mode: "live" };
const membership: PublicMembership["status"] = "active";
const delivery: PublicWebhookDelivery["status"] = "failed";
void [captureReferral, payout, live, membership, delivery];
