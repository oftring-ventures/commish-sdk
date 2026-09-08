/** Public HTTP types. Keep in sync with the private contract via parity tests. */
export type CommissionStatus =
  | "unfunded"
  | "pending"
  | "payable"
  | "disputed"
  | "allocated"
  | "processing"
  | "paid"
  | "reversed"
  | "withheld";

export type ConversionInput = {
  externalId: string;
  programId: string;
  customerId: string;
  emailHash?: string;
  amount: number;
  currency: "usd";
  attributionToken?: string;
  couponCode?: string;
  occurredAt: string;
  metadata: Record<string, string>;
};

export type CustomerIdentifyInput = {
  externalId?: string;
  email?: string;
  stripe?: {
    accountId: string;
    customerId?: string;
    paymentIntentId?: string;
    chargeId?: string;
  };
};

export type CustomerIdentification = {
  id: string;
  mode: "test" | "live";
  created: boolean;
  replayed: boolean;
};

export type PublicCustomer = {
  id: string;
  mode: "test";
  createdAt: string;
};
export type CustomerListOptions = {
  limit?: number;
  cursor?: string;
  createdAfter?: string;
  createdBefore?: string;
};

export type InvitationInput = {
  programId: string;
  email: string;
  terms?:
    | { type: "percentage"; basisPoints: number }
    | { type: "fixed"; amount: number; currency: "usd" };
  note?: string;
};

export type RefundInput = {
  externalId: string;
  conversionId: string;
  programId?: string;
  amount: number;
  currency: "usd";
  occurredAt: string;
  reason?: string;
};

export type ConversionReceipt =
  | { id: string; commissionId: null; status: null }
  | { id: string; commissionId: string; status: CommissionStatus };
export type RefundReceipt = { id: string; adjustment: number };
export type PublicConversion = {
  id: string;
  programId: string;
  membershipId: string | null;
  externalId: string;
  mode: "test";
  amount: number;
  currency: "usd";
  occurredAt: string;
  createdAt: string;
};
export type PublicRefund = {
  id: string;
  conversionId: string;
  externalId: string;
  mode: "test";
  amount: number;
  currency: "usd";
  occurredAt: string;
  createdAt: string;
};
export type PublicCommission = {
  id: string;
  conversionId: string;
  parentCommissionId: string | null;
  refundId: string | null;
  mode: "test";
  amount: number;
  currency: "usd";
  status: CommissionStatus;
  reason: string;
  availableAt: string;
  createdAt: string;
  payout:
    | null
    | { id: string; status: "pending"; processedAt: null }
    | {
        id: string;
        status: "processing" | "paid" | "failed" | "canceled";
        processedAt: string;
      };
};
export type PublicPayout =
  | { id: string; mode: "test"; status: "pending"; processedAt: null }
  | {
      id: string;
      mode: "test";
      status: "processing" | "paid" | "failed" | "canceled";
      processedAt: string;
    };
export type WebhookDeliveryStatus =
  "pending" | "processing" | "delivered" | "failed";
export type PublicWebhookDelivery = {
  id: string;
  endpointId: string;
  mode: "test";
  eventType:
    | "invitation.created"
    | "invitation.accepted"
    | "membership.activated"
    | "conversion.created"
    | "conversion.refunded"
    | "commission.pending"
    | "commission.unfunded"
    | "commission.payable"
    | "commission.reversed"
    | "commission.disputed"
    | "sale.dispute_opened"
    | "sale.dispute_recovery_required"
    | "funding.failed"
    | "payout.processing"
    | "payout.paid"
    | "payout.failed"
    | "payout.canceled";
  status: WebhookDeliveryStatus;
  attemptCount: number;
  responseStatus: number | null;
  deliveredAt: string | null;
  createdAt: string;
};
export type WebhookDeliveryListOptions = PageOptions & {
  endpointId?: string;
  status?: WebhookDeliveryStatus;
};
export type CommissionTerms =
  | { type: "percentage"; basisPoints: number }
  | { type: "fixed"; amount: number; currency: "usd" };
export type ProgramTerm = {
  programId: string;
  version: number;
  commission: CommissionTerms;
  recurrence:
    | { kind: "first_payment" }
    | { kind: "lifetime" }
    | { kind: "fixed_months"; months: number };
  perSaleCap: { amount: number; currency: "usd" } | null;
  disclosureText: string;
  prohibitedClaims: string[];
  effectiveAt: string;
  createdAt: string;
};
export type PublicProgram = {
  id: string;
  applicationId: string;
  name: string;
  slug: string;
  mode: "test";
  status: "draft" | "active" | "paused" | "suspended" | "archived";
  attributionPolicy: "first_click" | "last_click";
  terms: ProgramTerm | null;
};
export type PublicMembership = {
  id: string;
  programId: string;
  creatorId: string;
  creatorHandle: string;
  mode: "test";
  status: "invited" | "applied" | "active" | "terminated" | "suspended";
  activatedAt: string | null;
  termsAcceptance: {
    acceptedAt: string;
    terms: ProgramTerm | null;
    commissionOverride: CommissionTerms | null;
  } | null;
};
export type PageOptions = { limit?: number; cursor?: string };
export type CursorPage<T> = { data: T[]; next_cursor: string | null };
