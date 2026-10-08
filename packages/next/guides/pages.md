# Commish Pages — unreleased preview

Experimental measurement requires same-origin browser Web Locks to establish one visitor identity across concurrent tabs. Unsupported browsers or bounded identity failures receive the standard page without new experimental measurement; consent-authorized attribution and shopping remain available.

This checkout targets the optional Pages module in paired version 0.3.0. It is **not included in the published 0.2.3 packages**. Use a reviewed, paired candidate artifact with its checksum and consumer lockfile for evaluation. Package publication and production enablement require separate approval. Do not install an older registry release and expect these exports to exist.

## Product boundaries

Install once and serve current and future participating creators at `https://brand.com/c/maya`. Commish supplies versioned, approved content; your application runs the installed renderer. Dynamic requests—not builds—check publication permission, partnership eligibility, accepted terms, verified destination, credentials and environment. Content and supported layouts change without redeploying. New renderer capabilities require an SDK upgrade.

Pages is not a checkout or discount engine. The button goes to your existing shopping flow. Assigned coupons are displayed without claiming automatic application. Brands authorize imagery; brand-authored testimonials are not part of the pilot. Creator page permission is separate from directory visibility; declining or withdrawing leaves the partnership intact. Unpublished/unknown/withdrawn pages are 404; previously published ended partnerships show a neutral store link without attribution; dependency failures show temporary unavailability.

## Install

Use Node 24, paired `@commish/sdk` and `@commish/next` candidate artifacts, Next >=16.3.8 <17, and React >=19.2.8 <20. Existing non-Pages integrations remain optional and unchanged.

```sh
pnpm exec commish-next pages init --dry-run --json
pnpm exec commish-next pages init --apply --json
# Optional: a different one-segment prefix, chosen before publication
pnpm exec commish-next pages init --prefix /creators --dry-run --json
```

The existing no-argument `commish-next` command remains a dry run. Pages creates only missing files and refuses conflicts/symlinks. It never rewrites authentication, layout, environment files, package dependencies, or agent instructions. If code already occupies the namespace, integrate manually with the helpers below. This includes dynamic or CMS routes that could serve the selected namespace: setup stops before creating any files, and the developer must explicitly delegate that namespace before integrating Pages.

Provide server-only `COMMISH_SECRET_KEY`, `COMMISH_PAGES_PROGRAM_ID`, `COMMISH_PAGES_ORIGIN` (exact verified HTTPS origin), and optional `COMMISH_API_URL`. Retain your application's matching `NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY`. Never place a secret key in `NEXT_PUBLIC_*`, JSX props, browser storage, logs, or committed files. Use application-scoped credentials for the same TEST/LIVE environment; a workspace-wide key cannot resolve Pages.

The core route is small:

```tsx
// app/c/[creator]/page.tsx
import { createCreatorPage } from "@commish/next/pages";
import { pagesOptions } from "../../commish-pages";
export const dynamic = "force-dynamic";
export default createCreatorPage(pagesOptions);
```

`pagesOptions()` returns `{secretKey, programId, origin, prefix:'/c', apiUrl}` from server configuration. The underlying server API is `await commish.pages.resolve({programId, handle})`. Resolve is uncached and abortable; 404 is distinct from an unavailable service.

## Consent and checkout

Connect `createCreatorPageHandlers({options: pagesOptions, publishableKey, consent})` in the generated same-origin POST route. `consent(request)` must read your actual consent manager and return `{attribution, measurement}`. Both default to false. Browser-supplied consent fields are not accepted. Do not enable either by default unless that accurately reflects your consent policy.

Direct typed visits can capture without `commish_ref`. The normal shopping click waits for bounded capture; an outage does not prevent shopping and does not claim successful new attribution. Preserve the existing first-click/last-click and coupon integration. Do not replace referral metadata with a creator ID.

In your **authenticated server checkout handler**, after reading current measurement consent:

```ts
import { withCommishStripeMetadata } from "@commish/next";
import { withCommishPageMeasurement } from "@commish/next/pages/handlers";
const params = await withCommishPageMeasurement(
  await withCommishStripeMetadata(checkoutParams),
  consent.measurement,
);
// Pass params to your existing server-side Stripe Checkout creation.
```

Measurement uses a separate opaque `commish_page_visit` reference. For a custom provider, carry this server-read reference in the trusted `conversions.create` metadata after confirming payment. Never report purchases from the browser. Respect consent again at checkout, including withdrawal.

For subscriptions, the helper also copies the reference into `subscription_data.metadata`, so a later paid trial invoice can be measured. Reporting reads trusted Stripe receipts independently of whether a commission is due, within a 30-day window. Unknown invoice-to-refund linkage appears as a gap with unavailable net revenue, not zero refunds.

In your consent-update **server handler**, call `await withdrawCreatorPageMeasurement(pagesOptions)` when measurement is withdrawn. Import it from `@commish/next/pages/handlers`. It clears checkout measurement immediately and revokes observation of subsequent payments, including already-created subscription checkouts. If `{recorded:false}` is returned, retry; the anonymous visitor cookie remains solely to retry revocation. Keep the CMP choice denied meanwhile. This hook works while Pages is paused. Do not simply delete cookies and leave previously issued checkout references active.

## Safe short URLs

```sh
pnpm exec commish-next pages init --root-aliases --dry-run --json
```

Only a **fallback rewrite** may feed the alias handler. Existing pages, assets, redirects, dynamic routes, CMS and authentication run first. Never add a wildcard proxy/middleware interceptor or `beforeFiles` rewrite.

```js
import { creatorPageFallbackRewrite } from "@commish/next/pages/routing";
// Merge into your existing configuration, preserving all current rules:
async function rewrites() {
  return {
    beforeFiles: [],
    afterFiles: [],
    fallback: [creatorPageFallbackRewrite()],
  };
}
```

Do not copy the empty arrays over existing rules. When there is no config and no root dynamic route, `--apply --root-aliases` can create the fallback config. Existing configurations require a reviewed manual merge. A CMS catch-all prevents automatic fallback even when it returns notFound(); only that CMS may explicitly relinquish a path and call `createCreatorAliasHandler`. If uncertain, keep aliases off and use `/c/`.

The brand must independently enable aliases in Commish. An eligible root alias returns 307 to the canonical prefix. Every other one-segment path, and every Commish failure, stays a 404 (never a 5xx); pass `createCreatorAliasHandler(pagesOptions, { notFound })` to return your own not-found response there. Misses are remembered briefly and uncached lookups are bounded per server instance. A 404 at the root is **not** permission to claim it. Promote a preferred short link only after a probe proves the exact redirect and target page:

```sh
pnpm exec commish-next pages verify-alias --creator maya --dry-run
pnpm exec commish-next pages verify-alias --creator maya --apply
```

Reverify after merchant routing changes. Disabling aliases retains canonical links. Handles already reserved for a creator never silently transfer after a rename.

## Content, experiments and diagnostics

In the program dashboard, save and preview approved content, then publish. Invite or enroll creators and ask for their separate page choice. Existing creators choose in Creator → Brand pages. A paused program is not described as an ended partnership.

Testing defaults off. Opt-in uses two presentation layouts, stable 50/50 allocation, approved content only, and per-published-version results. No automatic winner promotion. Browser visibility gates exposures; redirects, server rendering and prefetching do not count. Results show visitors, exposures, shopping clicks, observed conversions and revenue/refunds. Observed conversions are not a completeness guarantee: inspect measurement gaps and supported payment paths before interpreting a test.

```sh
pnpm exec commish-next pages doctor --json
pnpm exec commish-next pages doctor --creator maya --json
```

Doctor is read-only. “Files installed”, “API resolved”, “alias verified”, and “end-to-end verified” are distinct. A valid API response is not evidence of capture, checkout, or conversion. Check credentials/mode, publication consent, terms/referral readiness, published content, origin/prefix agreement, route ownership, consent and cookies in that order. Do not resolve a 503 by labelling the partnership ended.

With `--creator`, doctor checks the resolved origin/prefix, canonical page marker, and optional temporary root redirect without sending merchant credentials to those pages. It also checks installed package exports/versions and whether matching publishable credentials are configured. It never performs a capture, changes consent, promotes an alias, or claims a real conversion journey passed. Pass your custom `--prefix` when checking a non-default installation.

## Acceptance, upgrades and removal

Before LIVE: install actual candidate artifacts into a clean external app; build; test a direct visit, fast click, capture, real TEST checkout, trusted conversion, duplicate delivery and refund. Start with ten eligible creators, then activate ten more without changing/deploying the merchant app. Verify all canonical links and only compatible aliases. Exercise consent refusal/withdrawal, old handles, key revocation, TEST/LIVE separation, service outages, mobile keyboard navigation and prefetch exclusion.

Upgrade the paired packages in a normal reviewed dependency change and rerun those checks. To remove Pages, pause it in Commish, disable aliases and experiments independently, remove only the Pages routes/fallback rewrite/configuration you installed, and remove page measurement plumbing/cookies according to your retention policy. Keep the original attribution integration if still used. Never delete historical financial records or reuse reserved creator addresses.

Import the renderer from `@commish/next/pages`, same-origin/checkout helpers from `@commish/next/pages/handlers`, and fallback routing from `@commish/next/pages/routing`. Keeping these boundaries separate supports both Next.js production bundlers without importing rendering contexts into API routes.
