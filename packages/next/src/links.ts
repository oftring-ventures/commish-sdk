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
export function createReferralLinkRoute(
  source: ReferralLinkRouteSource,
  /** `root: true` for the route that receives the fallback rewrite of root links (brand.com/<name>). */
  routeOptions: { root?: boolean } = {},
) {
  let notFound: ReferralLinkRouteOptions["notFound"];
  let configured: ReferralLinkRouteOptions | undefined;
  // One handler per route module, so its miss cache and lookup budget persist across requests.
  const handler = createReferralLinkHandler({
    root: routeOptions.root,
    onError: (error, context) => configured?.onError?.(error, context),
    notFound: (request) =>
      notFound ? notFound(request) : new Response(null, { status: 404, headers: noStore }),
    handoff: async (input) => {
      if (!configured) throw new Error("Commish link route is not configured");
      return new Commish({
        secretKey: configured.secretKey,
        baseUrl: configured.apiUrl,
      }).links.handoff(input);
    },
  });
  // biome-ignore lint/correctness/noComponentHookFactories: a route handler, not a component; the merchant's route module calls this factory once
  return async function GET(request: Request, context: { params: Promise<{ creator: string }> }) {
    let handle = "";
    // Read configuration per request, so a missing key is the same static
    // notice as an outage, never an unhandled error.
    try {
      configured = typeof source === "function" ? await source() : source;
      notFound = configured.notFound;
      handle = (await context.params).creator;
    } catch {
      configured = undefined;
    }
    return handler(request, configured ? handle : "unconfigured");
  };
}

const noStore = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };

/**
 * Root links (https://brand.com/<name>). Use ONLY in next.config
 * `rewrites().fallback`, after all of your own routing, so your pages always
 * win. It sends every other one-segment path to the root link route, which
 * answers 404 for anything that is not a creator.
 */
export function referralLinkFallbackRewrite(handlerPath = "/api/commish/link") {
  if (!/^\/[a-zA-Z0-9/-]+$/.test(handlerPath)) throw new TypeError("Invalid link handler path");
  return {
    source: "/:creator([a-z0-9][a-z0-9_-]{2,39})",
    destination: `${handlerPath}/:creator`,
  };
}
