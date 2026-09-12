type StripeMetadata = Record<string, string | number | null>;
type StripeCheckoutParams = {
  mode?: string;
  client_reference_id?: string;
  metadata?: StripeMetadata;
  subscription_data?: {
    metadata?: StripeMetadata;
    [key: string]: unknown;
  };
};

export function applyCommishStripeMetadata<T extends StripeCheckoutParams>(
  params: T,
  attribution: string | null,
): T {
  if (!attribution) return params;
  return {
    ...params,
    metadata: { ...params.metadata, commish_attribution: attribution },
    ...(params.mode === "subscription"
      ? {
          subscription_data: {
            ...params.subscription_data,
            metadata: {
              ...params.subscription_data?.metadata,
              commish_attribution: attribution,
              ...(params.client_reference_id
                ? { commish_customer_id: params.client_reference_id }
                : {}),
            },
          },
        }
      : {}),
  };
}
