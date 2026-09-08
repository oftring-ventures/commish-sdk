import type {
  CursorPage,
  CustomerListOptions,
  PageOptions,
  WebhookDeliveryListOptions,
} from "./types.js";

// Match the public API's bounded base64url envelope without decoding its position.
function isPageCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[^A-Za-z0-9_-]/.test(value)
  );
}

export function publicId(value: string, prefix: string): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}_[A-Za-z0-9_-]{12,}$`).test(value)
  )
    throw new TypeError(`Expected a public ${prefix} ID`);
  return encodeURIComponent(value);
}

export function pageQuery(options: PageOptions): string {
  const query = new URLSearchParams();
  if (options.limit !== undefined) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new TypeError("Page limit must be an integer between 1 and 100");
    query.set("limit", String(options.limit));
  }
  if (options.cursor !== undefined) {
    if (!isPageCursor(options.cursor))
      throw new TypeError("Expected an opaque pagination cursor");
    query.set("cursor", options.cursor);
  }
  return query.size ? `?${query}` : "";
}

export function customerPageQuery(options: CustomerListOptions): string {
  const query = new URLSearchParams(pageQuery(options));
  for (const key of ["createdAfter", "createdBefore"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value || value.length > 100)
      throw new TypeError("Expected a customer creation-time filter string");
    query.set(key, value);
  }
  return query.size ? `?${query}` : "";
}

export function webhookDeliveryPageQuery(
  options: WebhookDeliveryListOptions,
): string {
  const query = new URLSearchParams(pageQuery(options));
  if (options.endpointId !== undefined)
    query.set("endpointId", publicId(options.endpointId, "whe"));
  if (options.status !== undefined) {
    if (
      !["pending", "processing", "delivered", "failed"].includes(options.status)
    )
      throw new TypeError("Expected a webhook delivery status");
    query.set("status", options.status);
  }
  return query.size ? `?${query}` : "";
}

/** Sequential reads; each page authenticates again. No hidden retries or snapshots. */
export async function* iteratePages<T>(
  fetchPage: (options: PageOptions) => Promise<CursorPage<T>>,
  options: PageOptions = {},
): AsyncGenerator<T> {
  const seen = new Set<string>();
  let cursor = options.cursor;
  if (cursor) seen.add(cursor);
  do {
    const page = await fetchPage({ ...options, cursor });
    const next = page.next_cursor;
    if (
      !Array.isArray(page.data) ||
      (next !== null && (!isPageCursor(next) || seen.has(next)))
    )
      throw new Error(
        "Commish returned an invalid or repeated pagination cursor",
      );
    if (next) seen.add(next);
    yield* page.data;
    cursor = next ?? undefined;
  } while (cursor);
}
