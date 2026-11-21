import {
  Commish,
  createReferralLinkResolver,
  LINK_CHECK_HEADER,
  type ReferralLinkOutcome,
  referralLinkNotice,
} from "@commish/sdk";
import { headers } from "next/headers.js";
import { notFound, redirect, unstable_rethrow } from "next/navigation.js";
import type { ReferralLinkRouteSource } from "./links.js";

/**
 * Root links (https://brand.com/<name>): the page that receives the fallback
 * rewrite. `export default createReferralLinkPage(...)` in
 * `app/commish-link/[creator]/page.tsx`, with `export const dynamic = "force-dynamic"`.
 *
 * It is a page, not a route handler, so that a path which is not a creator
 * shows your own `not-found` page, exactly as before the rewrite was added:
 *
 * - known, eligible creator: a temporary redirect to the verified destination
 * - not a creator, a check from Commish, or Commish unreachable for a path
 *   that never resolved: your not-found page
 * - temporary pause, or an outage for a creator seen in the last ten minutes:
 *   a short notice that is kept out of indexes
 *
 * Its requests are marked as root requests, which Commish answers only while
 * root links are switched on for the product in the dashboard.
 */
export function createReferralLinkPage(source: ReferralLinkRouteSource) {
  // One resolver per page module, so its miss cache and lookup budget persist across requests.
  const resolve = createReferralLinkResolver({
    root: true,
    handoff: async () => {
      throw new Error("Commish link page is not configured");
    },
  });
  // biome-ignore lint/correctness/noComponentHookFactories: the page module calls this factory once at module scope, so the component identity is stable
  return async function ReferralLinkPage({ params }: { params: Promise<{ creator: string }> }) {
    let outcome: ReferralLinkOutcome = { kind: "not_found" };
    try {
      const options = typeof source === "function" ? await source() : source;
      // A check from Commish arrives as a header; outside a request there is none.
      let check: string | null = null;
      try {
        check = (await headers()).get(LINK_CHECK_HEADER);
      } catch (error) {
        unstable_rethrow(error);
      }
      outcome = await resolve((await params).creator, {
        check,
        onError: options.onError,
        handoff: (input) =>
          new Commish({ secretKey: options.secretKey, baseUrl: options.apiUrl }).links.handoff(
            input,
          ),
      });
    } catch (error) {
      // Never swallow Next's own control flow; anything else is not a creator link.
      unstable_rethrow(error);
    }
    if (outcome.kind === "redirect") redirect(outcome.location);
    // A check only needs the request to reach Commish through this server.
    if (outcome.kind === "not_found" || outcome.kind === "probe") notFound();
    const text = referralLinkNotice(outcome.kind === "paused" ? outcome.reason : null);
    // A page cannot set a status, so the notice stays 200 and out of indexes.
    return (
      <main style={{ maxWidth: 640, margin: "6rem auto", padding: 24 }}>
        <meta name="robots" content="noindex, nofollow" />
        <h1>{text.title}</h1>
        <p>{text.body}</p>
      </main>
    );
  };
}
