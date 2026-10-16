import { type BuyerPromotionSummary, Commish, CommishError, type CreatorPage } from "@commish/sdk";
import { notFound, unstable_rethrow } from "next/navigation.js";
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

/** One dynamic route covers current and future participating creators. */
export function createCreatorPage(source: PageOptionsSource) {
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
      if (error instanceof CommishError && error.status === 404) notFound();
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
