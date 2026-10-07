import { CommishError, type CreatorPage } from "@commish/sdk";
import { notFound } from "next/navigation.js";
import { CreatorPageView } from "./pages-client.js";
import {
  resolveCreatorPage,
  type CreatorPageOptions,
  type PageOptionsSource,
} from "./pages-routing.js";
export {
  resolveCreatorPage,
  createCreatorAliasHandler,
  creatorPageFallbackRewrite,
  type CreatorPageOptions,
  type PageOptionsSource,
} from "./pages-routing.js";

/** One dynamic route covers current and future participating creators. */
export function createCreatorPage(source: PageOptionsSource) {
  return async function Page({
    params,
  }: {
    params: Promise<{ creator: string }>;
  }) {
    let options: CreatorPageOptions;
    let page: CreatorPage;
    try {
      options = typeof source === "function" ? await source() : source;
      page = await resolveCreatorPage(options, (await params).creator);
    } catch (error) {
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
        integrationPath={options.integrationPath ?? "/api/commish/pages"}
      />
    );
  };
}
