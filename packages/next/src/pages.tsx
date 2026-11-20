import {
  type BuyerPromotionSummary,
  Commish,
  CommishError,
  type CreatorPage,
  LINK_CHECK_HEADER,
  type LinkHandoff,
} from "@commish/sdk";
import { headers } from "next/headers.js";
import { notFound, redirect, unstable_rethrow } from "next/navigation.js";
import { CreatorPageView } from "./pages-client.js";
import {
  type CreatorPageOptions,
  type PageOptionsSource,
  resolveCreatorPage,
} from "./pages-routing.js";

export {
  type CreatorAliasHandlerOptions,
  type CreatorPageOptions,
  createCreatorAliasHandler,
  creatorPageFallbackRewrite,
  type PageOptionsSource,
  resolveCreatorPage,
} from "./pages-routing.js";

// A page cannot set a status or headers, so these stay 200; they are kept out
// of indexes instead. The bare link route answers the same states with 503.
const notice = (title: string, body: string) => (
  <main style={{ maxWidth: 640, margin: "6rem auto", padding: 24 }}>
    <meta name="robots" content="noindex, nofollow" />
    <h1>{title}</h1>
    <p>{body}</p>
  </main>
);

async function linkFallback(source: PageOptionsSource, params: Promise<{ creator: string }>) {
  let link: LinkHandoff;
  try {
    const options = typeof source === "function" ? await source() : source;
    // Forward a root path check from Commish; outside a request there is none.
    let check: string | undefined;
    try {
      check = (await headers()).get(LINK_CHECK_HEADER) ?? undefined;
    } catch (error) {
      unstable_rethrow(error);
    }
    ({ data: link } = await new Commish({
      secretKey: options.secretKey,
      baseUrl: options.apiUrl,
    }).links.handoff({
      handle: (await params).creator,
      ...(check ? { check } : {}),
      signal: AbortSignal.timeout(4000),
    }));
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof CommishError && error.status === 404) notFound();
    return notice("This page is temporarily unavailable", "Please try again shortly.");
  }
  if (link.status === "ready") redirect(link.location);
  // Commish's route check only needs the request to reach this server.
  if (link.status === "probe")
    return (
      <main data-commish-link-probe="">
        <meta name="robots" content="noindex, nofollow" />
      </main>
    );
  return link.reason === "funding_paused"
    ? notice(
        "This referral link is paused",
        "The business has paused its funding, so new referrals are not being accepted right now. Please pause sharing this link until the business restores its funding.",
      )
    : notice(
        "Promotion is temporarily unavailable",
        "Promotion is temporarily unavailable. Please pause sharing this link while the business completes its checks.",
      );
}

/** One dynamic route covers current and future participating creators. */
export function createCreatorPage(source: PageOptionsSource) {
  // biome-ignore lint/correctness/noComponentHookFactories: the page module calls this factory once at module scope, so the component identity is stable
  return async function Page({ params }: { params: Promise<{ creator: string }> }) {
    let options: CreatorPageOptions;
    let page: CreatorPage;
    let promotion: BuyerPromotionSummary | null | undefined;
    try {
      options = typeof source === "function" ? await source() : source;
      const handle = (await params).creator;
      if (options.buyerPromotions) {
        const { data } = await new Commish({
          secretKey: options.secretKey,
          baseUrl: options.apiUrl,
        }).pages.resolveWithPromotions({
          programId: options.programId,
          handle,
          signal: AbortSignal.timeout(4000),
        });
        page = data.page;
        if (
          page.origin !== options.origin ||
          page.canonicalPath !== `${options.prefix ?? "/c"}/${handle}`
        )
          throw new Error("Page installation mismatch");
        promotion = data.buyerPromotion;
      } else page = await resolveCreatorPage(options, handle);
    } catch (error) {
      // Never swallow Next's own control flow (dynamic bailout, redirects).
      unstable_rethrow(error);
      // A creator without a published page still has a referral link here:
      // forward the buyer exactly as the bare link route would.
      if (error instanceof CommishError && error.status === 404)
        return linkFallback(source, params);
      // No brand/creator content or ended-offer claim on dependency failure.
      return (
        <main style={{ maxWidth: 640, margin: "6rem auto", padding: 24 }}>
          <h1>This page is temporarily unavailable</h1>
          <p>Please try again shortly.</p>
        </main>
      );
    }
    return (
      <CreatorPageView
        key={`${page.pageId}:${page.status === "ready" ? page.revision : "ended"}`}
        page={page}
        buyerPromotion={promotion}
        integrationPath={options.integrationPath ?? "/api/commish/pages"}
      />
    );
  };
}
