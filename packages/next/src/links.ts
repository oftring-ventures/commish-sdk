import { Commish, createReferralLinkHandler } from "@commish/sdk";

export type ReferralLinkRouteOptions = {
  /** Application-scoped secret key for the same TEST or LIVE mode as this deployment. Server only. */
  secretKey: string;
  apiUrl?: string;
  /** Render your own not-found response for handles Commish does not know (default: an empty 404). */
  notFound?: (request: Request) => Response | Promise<Response>;
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
export function createReferralLinkRoute(source: ReferralLinkRouteSource) {
  // biome-ignore lint/correctness/noComponentHookFactories: a route handler, not a component; the merchant's route module calls this factory once
  return async function GET(request: Request, context: { params: Promise<{ creator: string }> }) {
    let notFound: ReferralLinkRouteOptions["notFound"];
    let handle = "";
    // Read configuration per request and inside the handoff, so a missing key
    // is the same static notice as an outage, never an unhandled error.
    let options: ReferralLinkRouteOptions | undefined;
    try {
      options = typeof source === "function" ? await source() : source;
      notFound = options.notFound;
      handle = (await context.params).creator;
    } catch {
      options = undefined;
    }
    const configured = options;
    return createReferralLinkHandler({
      notFound,
      handoff: async (input) => {
        if (!configured) throw new Error("Commish link route is not configured");
        return new Commish({
          secretKey: configured.secretKey,
          baseUrl: configured.apiUrl,
        }).links.handoff(input);
      },
    })(request, configured ? handle : "unconfigured");
  };
}
