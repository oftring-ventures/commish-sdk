import type { PublicMembership, PublicPayout, PublicWebhookDelivery } from "@commish/sdk";
import { captureReferral } from "@commish/sdk/browser";

const payout: PublicPayout = {
  id: "pay_fixture",
  mode: "test",
  status: "pending",
  processedAt: null,
};
// Every public resource reports the authenticated key's mode, TEST or LIVE.
const live: PublicPayout = { ...payout, mode: "live" };
const membership: PublicMembership["status"] = "active";
const delivery: PublicWebhookDelivery["status"] = "failed";
void [captureReferral, payout, live, membership, delivery];
