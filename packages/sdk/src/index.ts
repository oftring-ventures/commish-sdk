import type {
  ConversionReceipt,
  CursorPage,
  PageOptions,
  PublicConversion,
  PublicRefund,
  PublicCommission,
  PublicPayout,
  PublicWebhookDelivery,
  WebhookDeliveryListOptions,
  PublicProgram,
  PublicMembership,
  ConversionInput,
  CustomerIdentification,
  CustomerListOptions,
  PublicCustomer,
  CustomerIdentifyInput,
  InvitationInput,
  RefundInput,
} from "./types.js";
import {
  customerPageQuery,
  webhookDeliveryPageQuery,
  iteratePages,
  pageQuery,
  publicId,
} from "./reads.js";
export type * from "./types.js";

export type CommishOptions = {
  secretKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export type ConversionCreateInput = Omit<ConversionInput, "metadata"> & {
  metadata?: ConversionInput["metadata"];
};

export class CommishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export class Commish {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly options: CommishOptions) {
    if (
      typeof options.secretKey !== "string" ||
      !/^cm_(?:test|live)_sk_[A-Za-z0-9_-]{12,}$/.test(options.secretKey)
    )
      throw new Error("Invalid Commish secret key");
    this.baseUrl = (options.baseUrl ?? "https://app.commish.sh/api/v1").replace(
      /\/$/,
      "",
    );
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async request<T extends object>(
    path: string,
    init: RequestInit,
    idempotencyKey?: string,
  ): Promise<T> {
    const normalizedIdempotencyKey =
      typeof idempotencyKey === "string" ? idempotencyKey.trim() : undefined;
    if (
      idempotencyKey !== undefined &&
      (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 255)
    )
      throw new TypeError(
        "Idempotency key must be between 1 and 255 characters",
      );
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.secretKey}`,
        "content-type": "application/json",
        ...(normalizedIdempotencyKey
          ? { "idempotency-key": normalizedIdempotencyKey }
          : {}),
        ...init.headers,
      },
    });
    const responseText = await response.text();
    let body: unknown;
    try {
      body = responseText ? JSON.parse(responseText) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const error =
        body && typeof body === "object" && "error" in body
          ? (body.error as {
              message?: string;
              code?: string;
              request_id?: string;
            })
          : undefined;
      throw new CommishError(
        error?.message ?? "Commish request failed",
        response.status,
        error?.code ?? "request_failed",
        error?.request_id ?? response.headers.get("x-request-id") ?? undefined,
      );
    }
    if (!body || typeof body !== "object")
      throw new CommishError(
        "Commish returned an invalid response",
        response.status,
        "invalid_response",
      );
    return body as T;
  }

  readonly conversions = {
    lookup: (externalId: string) => {
      if (
        typeof externalId !== "string" ||
        !externalId ||
        externalId.length > 255
      )
        throw new TypeError("External ID must be between 1 and 255 characters");
      return this.request<{ data: ConversionReceipt | null }>(
        `/conversions?${new URLSearchParams({ externalId })}`,
        { method: "GET" },
      );
    },
    retrieve: (id: string) =>
      this.request<{ data: PublicConversion }>(
        `/conversions/${publicId(id, "cnv")}`,
        { method: "GET" },
      ),
    listRefunds: (id: string, options: PageOptions = {}) =>
      this.request<CursorPage<PublicRefund>>(
        `/conversions/${publicId(id, "cnv")}/refunds${pageQuery(options)}`,
        { method: "GET" },
      ),
    listCommissions: (id: string, options: PageOptions = {}) =>
      this.request<CursorPage<PublicCommission>>(
        `/conversions/${publicId(id, "cnv")}/commissions${pageQuery(options)}`,
        { method: "GET" },
      ),
    iterateRefunds: (id: string, options: PageOptions = {}) =>
      iteratePages((page) => this.conversions.listRefunds(id, page), options),
    iterateCommissions: (id: string, options: PageOptions = {}) =>
      iteratePages(
        (page) => this.conversions.listCommissions(id, page),
        options,
      ),
    create: (
      input: ConversionCreateInput,
      options: { idempotencyKey: string },
    ) =>
      this.request<{ data: ConversionReceipt }>(
        "/conversions",
        { method: "POST", body: JSON.stringify(input) },
        options.idempotencyKey,
      ),
  };
  readonly customers = {
    retrieve: (id: string) =>
      this.request<{ data: PublicCustomer }>(
        `/customers/${publicId(id, "cst")}`,
        { method: "GET" },
      ),
    list: (options: CustomerListOptions = {}) =>
      this.request<CursorPage<PublicCustomer>>(
        `/customers${customerPageQuery(options)}`,
        { method: "GET" },
      ),
    iterate: (options: CustomerListOptions = {}) =>
      iteratePages(
        (page) => this.customers.list({ ...options, ...page }),
        options,
      ),
    identify: (
      input: CustomerIdentifyInput,
      options: { idempotencyKey: string },
    ) =>
      this.request<{ data: CustomerIdentification }>(
        "/customers/identify",
        { method: "POST", body: JSON.stringify(input) },
        options.idempotencyKey,
      ),
  };
  readonly refunds = {
    retrieve: (id: string) =>
      this.request<{ data: PublicRefund }>(`/refunds/${publicId(id, "rfd")}`, {
        method: "GET",
      }),
    create: (input: RefundInput, options: { idempotencyKey: string }) =>
      this.request<{ data: { id: string; adjustment: number } }>(
        "/refunds",
        { method: "POST", body: JSON.stringify(input) },
        options.idempotencyKey,
      ),
  };
  readonly commissions = {
    retrieve: (id: string) =>
      this.request<{ data: PublicCommission }>(
        `/commissions/${publicId(id, "cms")}`,
        { method: "GET" },
      ),
  };
  readonly webhookDeliveries = {
    retrieve: (id: string) =>
      this.request<{ data: PublicWebhookDelivery }>(
        `/webhook-deliveries/${publicId(id, "evt")}`,
        { method: "GET" },
      ),
    list: (options: WebhookDeliveryListOptions = {}) =>
      this.request<CursorPage<PublicWebhookDelivery>>(
        `/webhook-deliveries${webhookDeliveryPageQuery(options)}`,
        { method: "GET" },
      ),
    iterate: (options: WebhookDeliveryListOptions = {}) =>
      iteratePages(
        (page) => this.webhookDeliveries.list({ ...options, ...page }),
        options,
      ),
  };
  readonly payouts = {
    retrieve: (id: string) =>
      this.request<{ data: PublicPayout }>(`/payouts/${publicId(id, "pay")}`, {
        method: "GET",
      }),
  };
  readonly programs = {
    retrieve: (id: string) =>
      this.request<{ data: PublicProgram }>(
        `/programs/${publicId(id, "prg")}`,
        { method: "GET" },
      ),
  };
  readonly memberships = {
    list: (options: PageOptions = {}) =>
      this.request<CursorPage<PublicMembership>>(
        `/memberships${pageQuery(options)}`,
        { method: "GET" },
      ),
    iterate: (options: PageOptions = {}) =>
      iteratePages((page) => this.memberships.list(page), options),
    retrieve: (id: string) =>
      this.request<{ data: PublicMembership }>(
        `/memberships/${publicId(id, "mbr")}`,
        { method: "GET" },
      ),
  };
  readonly invitations = {
    create: (input: InvitationInput, options: { idempotencyKey: string }) =>
      this.request<{ data: { id: string; claimUrl: string } }>(
        `/programs/${publicId(input.programId, "prg")}/invitations`,
        { method: "POST", body: JSON.stringify(input) },
        options.idempotencyKey,
      ),
  };
}
