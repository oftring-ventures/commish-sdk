import { cookies } from "next/headers.js";
import { applyCommishStripeMetadata, type StripeCheckoutParams } from "./metadata.js";

export { applyCommishStripeMetadata };

export async function getCommishAttribution(): Promise<string | null> {
  return (await cookies()).get("commish_attribution")?.value ?? null;
}

export async function withCommishStripeMetadata<T extends StripeCheckoutParams>(
  params: T,
): Promise<T> {
  return applyCommishStripeMetadata(params, await getCommishAttribution());
}
