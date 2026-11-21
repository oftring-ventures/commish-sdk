import { Commish, createReferralLinkHandler } from "@commish/sdk";

export type ReferralLinkRouteOptions = {
  /** Application-scoped secret key for the same TEST or LIVE mode as this deployment. Server only. */
  secretKey: string;
  apiUrl?: string;
  /** Render your own not-found response for handles Commish does not know (default: an empty 404). */
  notFound?: (request: Request) => Response | Promise<Response>;
  /** Called when a visit fails for a reason other than an unknown handle, including missing configuration. */
  onError?: (error: unknown, context: { handle: string }) => void;
};
export type ReferralLinkRouteSource =
  | ReferralLinkRouteOptions
  | (() => ReferralLinkRouteOptions | Promise<ReferralLinkRouteOptions>);

/**
 * `export const GET = createReferralLinkRoute(...)` in `app/c/[creator]/route.ts`.
 * One dynamic route covers current and future creators: https://brand.com/c/maya
 * forwards the buyer to your verified destination with the creator's referral,
 * and the existing capture on that page records it.
 */
// Caches and budgets belong to one configuration: a route whose source returns
// different credentials per request (several brands from one app) keeps one
// instance per key and API URL, so one brand's misses never answer another's.
function perConfiguration<T>(make: () => T, limit = 16) {
  const instances = new Map<string, T>();
  return (options: { secretKey?: string; apiUrl?: string } | undefined): T => {
    const key = `${options?.apiUrl ?? ""}\u0000${options?.secretKey ?? ""}`;
    let instance = instances.get(key);
    if (instance === undefined) {
      if (instances.size >= limit) instances.delete(instances.keys().next().value as string);
      instance = make();
      instances.set(key, instance);
    }
    return instance;
  };
}

export function createReferralLinkRoute(
  source: ReferralLinkRouteSource,
  /**
   * `root: true` for a route handler that receives root links (brand.com/<name>)
   * from your own routing. The generated install uses `createReferralLinkPage`
   * from `@commish/next/links/page` instead, so unknown paths show your own
   * not-found page; a route handler can only answer them with `notFound`.
   */
  routeOptions: { root?: boolean } = {},
) {
  const unconfigured = async (): Promise<never> => {
    throw new Error("Commish link route is not configured");
  };
  // One handler per route module and configuration, so its miss cache and lookup
  // budget persist across requests without crossing between configurations.
  const handlerFor = perConfiguration(() =>
    createReferralLinkHandler({ root: routeOptions.root, handoff: unconfigured }),
  );
  // biome-ignore lint/correctness/noComponentHookFactories: a route handler, not a component; the merchant's route module calls this factory once
  return async function GET(request: Request, context: { params: Promise<{ creator: string }> }) {
    // Configuration is read for each request and travels with it, so requests
    // served at the same time never see each other's. A missing key is the
    // same static notice as an outage, never an unhandled error.
    let configured: ReferralLinkRouteOptions | undefined;
    let handle = "";
    try {
      handle = (await context.params).creator;
      configured = typeof source === "function" ? await source() : source;
    } catch {
      configured = undefined;
    }
    const options = configured;
    return handlerFor(options)(request, handle, {
      handoff: options?.secretKey
        ? (input) =>
            new Commish({ secretKey: options.secretKey, baseUrl: options.apiUrl }).links.handoff(
              input,
            )
        : unconfigured,
      onError: options?.onError,
      notFound: options?.notFound,
    });
  };
}

/**
 * Root links (https://brand.com/<name>). Use ONLY as the LAST entry of
 * next.config `rewrites().fallback`, after all of your own routing, so your
 * pages always win. It sends every other one-segment path to the root link
 * page (`createReferralLinkPage`), which shows your own not-found page for
 * anything that is not a creator.
 */
export function referralLinkFallbackRewrite(handlerPath = "/commish-link") {
  if (!/^\/[a-zA-Z0-9/-]+$/.test(handlerPath)) throw new TypeError("Invalid link handler path");
  return {
    source: "/:creator([a-z0-9][a-z0-9_-]{2,39})",
    destination: `${handlerPath}/:creator`,
  };
}
