import { assertCreatorPage, Commish, CommishError, type CreatorPage } from "@commish/sdk";

export type CreatorPageOptions = {
  secretKey: string;
  programId: string;
  /** Exact verified merchant origin. Never infer this from forwarded headers. */
  origin: string;
  prefix?: string;
  apiUrl?: string;
  integrationPath?: string;
  /** Requires the buyer-promotions Checkout integration. */
  buyerPromotions?: boolean;
};
export type PageOptionsSource =
  | CreatorPageOptions
  | (() => CreatorPageOptions | Promise<CreatorPageOptions>);

export async function resolveCreatorPage(
  options: CreatorPageOptions,
  handle: string,
): Promise<CreatorPage> {
  const prefix = options.prefix ?? "/c";
  if (!/^\/[a-z][a-z0-9-]{0,29}$/.test(prefix)) throw new TypeError("Invalid page prefix");
  const { data } = await new Commish({
    secretKey: options.secretKey,
    baseUrl: options.apiUrl,
  }).pages.resolve({
    programId: options.programId,
    handle,
    signal: AbortSignal.timeout(4000),
  });
  assertCreatorPage(data);
  if (data.origin !== options.origin || data.canonicalPath !== `${prefix}/${handle}`)
    throw new Error("Commish page configuration does not match this installation");
  return data;
}

/** Use ONLY in next.config rewrites().fallback, after all merchant routing. */
export function creatorPageFallbackRewrite(handlerPath = "/api/commish/alias") {
  if (!/^\/[a-zA-Z0-9/-]+$/.test(handlerPath)) throw new TypeError("Invalid alias handler path");
  return {
    source: "/:creator([a-z0-9][a-z0-9_-]{2,39})",
    destination: `${handlerPath}/:creator`,
  };
}

export type CreatorAliasHandlerOptions = {
  /**
   * Render your own not-found response for one-segment paths that are not a
   * creator alias (default: an empty 404). Never called for creator aliases.
   */
  notFound?: (request: Request) => Response | Promise<Response>;
};

// Unmatched one-segment URLs are mostly crawlers, and a published alias is read
// far more often than it changes. Remember both outcomes briefly and cap uncached
// lookups per instance so neither crawler noise nor a popular link becomes
// Commish traffic, and so crawler noise cannot starve a verified alias.
const HIT_TTL_MS = 60_000,
  STALE_TTL_MS = 600_000,
  MISS_TTL_MS = 60_000,
  FAILURE_TTL_MS = 10_000,
  MAX_ENTRIES = 1024,
  LOOKUP_WINDOW_MS = 10_000,
  MAX_LOOKUPS_PER_WINDOW = 60;
type VerifiedAlias = { page: CreatorPage; freshUntil: number; staleUntil: number };
const hits = new Map<string, VerifiedAlias>();
const misses = new Map<string, number>();
const pending = new Map<string, Promise<CreatorPage | null>>();
let windowStart = 0,
  windowLookups = 0;
function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}
function forget(key: string, ttl: number) {
  hits.delete(key);
  remember(misses, key, Date.now() + ttl);
}
async function lookupAlias(
  options: CreatorPageOptions,
  handle: string,
): Promise<CreatorPage | null> {
  // Everything resolveCreatorPage checks belongs in the key, so a hit cached
  // for one installation is never served to another sharing the program.
  const key = JSON.stringify([
    options.apiUrl ?? "",
    options.programId,
    options.origin,
    options.prefix ?? "/c",
    handle,
  ]);
  const now = Date.now();
  const hit = hits.get(key);
  if (hit && hit.freshUntil > now) return hit.page;
  const expiry = misses.get(key);
  if (expiry !== undefined) {
    if (expiry > now) return null;
    misses.delete(key);
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  if (now - windowStart >= LOOKUP_WINDOW_MS) {
    windowStart = now;
    windowLookups = 0;
  }
  // An exhausted budget protects Commish from crawler noise; a recently verified
  // alias keeps redirecting until its next revalidation fits in the budget.
  if (windowLookups >= MAX_LOOKUPS_PER_WINDOW) return hit && hit.staleUntil > now ? hit.page : null;
  windowLookups += 1;
  const lookup = resolveCreatorPage(options, handle)
    .then((page) => {
      if (!page.rootAliasEnabled) {
        forget(key, MISS_TTL_MS);
        return null;
      }
      const verifiedAt = Date.now();
      remember(hits, key, {
        page,
        freshUntil: verifiedAt + HIT_TTL_MS,
        staleUntil: verifiedAt + STALE_TTL_MS,
      });
      return page;
    })
    .catch((error: unknown) => {
      if (error instanceof CommishError && error.status === 404) {
        forget(key, MISS_TTL_MS);
        return null;
      }
      // Any other failure is an outage, not a verdict: a recently verified alias
      // keeps redirecting, and only an unverified handle is remembered as a miss.
      const stale = hits.get(key);
      if (stale && stale.staleUntil > Date.now()) {
        stale.freshUntil = Date.now() + FAILURE_TTL_MS;
        return stale.page;
      }
      forget(key, FAILURE_TTL_MS);
      return null;
    })
    .finally(() => pending.delete(key));
  pending.set(key, lookup);
  return lookup;
}

/**
 * Also usable by an existing CMS catch-all, ONLY after it explicitly
 * relinquishes a path. Anything that is not a verified creator alias stays a
 * merchant 404, and aliases never turn into 5xx errors: during a Commish outage
 * an alias verified within the last ten minutes keeps redirecting, and every
 * other path is a 404.
 */
export function createCreatorAliasHandler(
  source: PageOptionsSource,
  handlerOptions: CreatorAliasHandlerOptions = {},
) {
  // biome-ignore lint/correctness/noComponentHookFactories: a route handler, not a component; the merchant's route module calls this factory once
  return async function GET(request: Request, context: { params: Promise<{ creator: string }> }) {
    const headers = { "cache-control": "private, no-store" };
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers });
    let page: CreatorPage | null = null;
    try {
      const handle = (await context.params).creator;
      if (/^[a-z0-9][a-z0-9_-]{2,39}$/.test(handle)) {
        const options = typeof source === "function" ? await source() : source;
        page = await lookupAlias(options, handle);
      }
    } catch {
      page = null;
    }
    if (page)
      return new Response(null, {
        status: 307,
        headers: {
          ...headers,
          location: new URL(page.canonicalPath, page.origin).href,
          "x-commish-page-id": page.pageId,
        },
      });
    if (handlerOptions.notFound) return handlerOptions.notFound(request);
    return new Response(null, { status: 404, headers });
  };
}
