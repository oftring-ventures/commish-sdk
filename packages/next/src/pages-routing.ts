import {
  Commish,
  CommishError,
  assertCreatorPage,
  type CreatorPage,
} from "@commish/sdk";

export type CreatorPageOptions = {
  secretKey: string;
  programId: string;
  /** Exact verified merchant origin. Never infer this from forwarded headers. */
  origin: string;
  prefix?: string;
  apiUrl?: string;
  integrationPath?: string;
};
export type PageOptionsSource =
  CreatorPageOptions | (() => CreatorPageOptions | Promise<CreatorPageOptions>);

export async function resolveCreatorPage(
  options: CreatorPageOptions,
  handle: string,
): Promise<CreatorPage> {
  const prefix = options.prefix ?? "/c";
  if (!/^\/[a-z][a-z0-9-]{0,29}$/.test(prefix))
    throw new TypeError("Invalid page prefix");
  const { data } = await new Commish({
    secretKey: options.secretKey,
    baseUrl: options.apiUrl,
  }).pages.resolve({
    programId: options.programId,
    handle,
    signal: AbortSignal.timeout(4000),
  });
  assertCreatorPage(data);
  if (
    data.origin !== options.origin ||
    data.canonicalPath !== `${prefix}/${handle}`
  )
    throw new Error(
      "Commish page configuration does not match this installation",
    );
  return data;
}

/** Use ONLY in next.config rewrites().fallback, after all merchant routing. */
export function creatorPageFallbackRewrite(handlerPath = "/api/commish/alias") {
  if (!/^\/[a-zA-Z0-9/-]+$/.test(handlerPath))
    throw new TypeError("Invalid alias handler path");
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

// Unmatched one-segment URLs are mostly crawlers. Remember misses briefly and
// cap uncached lookups per instance so they never become Commish traffic.
const MISS_TTL_MS = 60_000,
  FAILURE_TTL_MS = 10_000,
  MAX_MISSES = 1024,
  LOOKUP_WINDOW_MS = 10_000,
  MAX_LOOKUPS_PER_WINDOW = 60;
const misses = new Map<string, number>();
const pending = new Map<string, Promise<CreatorPage | null>>();
let windowStart = 0,
  windowLookups = 0;
function rememberMiss(key: string, ttl: number) {
  misses.delete(key);
  if (misses.size >= MAX_MISSES)
    misses.delete(misses.keys().next().value as string);
  misses.set(key, Date.now() + ttl);
}
async function lookupAlias(
  options: CreatorPageOptions,
  handle: string,
): Promise<CreatorPage | null> {
  const key = `${options.programId}/${handle}`;
  const expiry = misses.get(key);
  if (expiry !== undefined) {
    if (expiry > Date.now()) return null;
    misses.delete(key);
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const now = Date.now();
  if (now - windowStart >= LOOKUP_WINDOW_MS) {
    windowStart = now;
    windowLookups = 0;
  }
  if (windowLookups >= MAX_LOOKUPS_PER_WINDOW) return null;
  windowLookups += 1;
  const lookup = resolveCreatorPage(options, handle)
    .then((page) => {
      if (!page.rootAliasEnabled) rememberMiss(key, MISS_TTL_MS);
      return page.rootAliasEnabled ? page : null;
    })
    .catch((error: unknown) => {
      rememberMiss(
        key,
        error instanceof CommishError && error.status === 404
          ? MISS_TTL_MS
          : FAILURE_TTL_MS,
      );
      return null;
    })
    .finally(() => pending.delete(key));
  pending.set(key, lookup);
  return lookup;
}

/**
 * Also usable by an existing CMS catch-all, ONLY after it explicitly
 * relinquishes a path. Anything that is not a verified creator alias, including
 * a Commish outage, stays a merchant 404: aliases never turn into 5xx errors.
 */
export function createCreatorAliasHandler(
  source: PageOptionsSource,
  handlerOptions: CreatorAliasHandlerOptions = {},
) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ creator: string }> },
  ) {
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
