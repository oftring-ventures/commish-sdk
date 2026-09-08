import {
  Commish,
  type ConversionCreateInput,
  type CustomerIdentifyInput,
  type PublicPayout,
  type PublicWebhookDelivery,
} from "@commish/sdk";
const customer: CustomerIdentifyInput = { externalId: "buyer" };
const sale: ConversionCreateInput = {
  externalId: "sale",
  programId: "prg_123456789012",
  customerId: "buyer",
  amount: 100,
  currency: "usd",
  occurredAt: "2026-09-03T00:00:00Z",
};
async function read(commish: Commish) {
  const identified = await commish.customers.identify(customer, { idempotencyKey: "customer" });
  const customerId: string = identified.data.id;
  const converted = await commish.conversions.create(sale, { idempotencyKey: "sale" });
  const conversionId: string = converted.data.id;
  // @ts-expect-error Mutation options must contain an idempotency key.
  void commish.conversions.create(sale, {});
  void [customerId, conversionId];
  const deliveryDetail: { data: PublicWebhookDelivery } =
    await commish.webhookDeliveries.retrieve("evt_123456789012");
  // @ts-expect-error Delivery details contain no destination URL.
  void deliveryDetail.data.url;
  const deliveries = await commish.webhookDeliveries.list({ status: "failed" });
  for await (const delivery of commish.webhookDeliveries.iterate({
    endpointId: "whe_123456789012",
  })) {
    const metadata: PublicWebhookDelivery = delivery;
    const status: "pending" | "processing" | "delivered" | "failed" = metadata.status;
    // @ts-expect-error Raw event payloads are not public delivery metadata.
    void metadata.payload;
    void status;
  }
  void deliveries;
  const payout: PublicPayout = (await commish.payouts.retrieve("pay_123456789012")).data;
  const payoutMode: "test" = payout.mode;
  if (payout.status === "pending") {
    const pendingTime: null = payout.processedAt;
    void pendingTime;
  } else {
    const processedTime: string = payout.processedAt;
    void processedTime;
  }
  // @ts-expect-error Consolidated payout amounts are not public.
  void payout.amount;
  void payoutMode;
  const result = await commish.memberships.retrieve("mbr_123456789012");
  const version: number | undefined = result.data.termsAcceptance?.terms?.version;
  const members = await commish.memberships.list({ limit: 1 });
  const next: string | null = members.next_cursor;
  for await (const member of commish.memberships.iterate()) {
    const mode: "test" = member.mode;
    void mode;
  }
  void next;
  for await (const entry of commish.conversions.iterateCommissions("cnv_123456789012")) {
    const cents: number = entry.amount;
    void cents;
  }
  return version;
}
void read;
void [Commish, customer, sale];
