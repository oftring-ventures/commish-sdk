# @commish/next

Next.js App Router integration for Commish referral capture, Checkout metadata
and optional creator Pages. Supports permanent TEST and LIVE environments and is
MIT licensed. Use Node 22 or later with the same SDK minor version (`~0.8.1`) and a
supported Next version. The CLI runs on macOS, Linux and WSL; native Windows is not
supported.

```sh
pnpm add --save-exact @commish/sdk@0.8.1 @commish/next@0.8.1
```

This guide describes 0.8.1; check [npm](https://www.npmjs.com/package/@commish/next)
for published availability. Pages first appears in 0.3.0. See the
[Pages integration guide](guides/pages.md) and [agent guide](guides/agents.md).

The `next` peer range is `>=16.4.1 <17`, which excludes Next.js versions
affected by the remote-code-execution and Server Actions denial-of-service
advisories fixed in 16.4.1.
Existing merchants should upgrade Next to 16.4.1 or newer before upgrading
this package so their production application uses the patched framework.

## Capture route

Set `COMMISH_API_URL` to the selected mode's API base, including `/api/v1`, and
`COMMISH_SECRET_KEY` to its application-scoped secret. Keep both on the server.
Only the publishable key and application ID belong in the public variables below.
Create `app/api/commish/attribution/route.ts` (or under `src/app`):

```ts
import { createAttributionHandler } from "@commish/next";

export const runtime = "nodejs";
export const POST = createAttributionHandler({
  apiUrl: process.env.COMMISH_API_URL,
  secretKey: process.env.COMMISH_SECRET_KEY,
});
```

The route exchanges the referral with Commish and stores successful attribution
in an HttpOnly cookie. Configure the API base explicitly for the selected deployment;
the helper otherwise uses its default Commish API origin.

## Application layout

Wrap the existing content in `app/layout.tsx` (or `src/app/layout.tsx`):

```tsx
import { CommishProvider } from "@commish/next/react";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CommishProvider
          publishableKey={process.env.NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY!}
          applicationId={process.env.NEXT_PUBLIC_COMMISH_APPLICATION_ID!}
        >
          {children}
        </CommishProvider>
      </body>
    </html>
  );
}
```

The provider captures on client navigation through the same-origin route above.
Set `capturePath` on the provider if that route uses another same-origin path.
Successful capture removes `commish_ref` while preserving navigation state;
failure keeps the referral for retry. Wait for capture before starting Checkout:
in the client component that starts it, await `captureReferral` from
`@commish/next/browser` with the same keys as the provider. It joins a capture
the provider already started instead of sending a second one.

```tsx
"use client";
import { captureReferral } from "@commish/next/browser";

export function BuyButton() {
  return (
    <button
      onClick={async () => {
        await captureReferral({
          publishableKey: process.env.NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY!,
          applicationId: process.env.NEXT_PUBLIC_COMMISH_APPLICATION_ID!,
        });
        window.location.assign("/api/checkout");
      }}
    >
      Buy
    </button>
  );
}
```

## Agent-driven installation and Checkout

In your existing authenticated server Checkout route, await
`withCommishStripeMetadata(params)` from `@commish/next` before passing the result
to your existing Stripe Checkout integration. The helper preserves other
parameters and applies the request's attribution to payment or subscription
metadata. `getCommishAttribution()` reads that cookie directly; both helpers
require a Next request context. The root export is blocked in browser builds.

Set `client_reference_id` on the Checkout parameters to your own stable customer
ID before calling the helper. A shop without accounts gives each buyer one ID it
can find again, for example stored with their email, and reuses it on their
later orders; never send the email address itself. Without it Commish still
records the purchase, from the Checkout email, but `commish doctor` keeps
`stable_customer_identity` unmet and the TEST integration cannot be activated.
The provider belongs at `@commish/next/react`; `@commish/next/browser` also exports
`captureReferral` for direct browser integration.

After installing the matching packages, run from the consumer project root:

```sh
pnpm exec commish-next --json          # inspect the plan; no writes
pnpm exec commish-next --write --json  # install the integration files
```

The CLI creates the capture route above and `app/commish-provider.tsx` (under
`src/app` when there is no root `app`). JavaScript apps receive `.js`/`.jsx`
files; the installer does not enable TypeScript. Repeated runs preserve identical files;
custom files, conflicting extensions and symbolic links stop installation before
writing. It never reads or writes credentials. Supply matching application keys
for the selected mode through your environment configuration.

The coding agent must finish these existing application edits:

1. Import `CommishRootProvider` from `./commish-provider` in the root layout and
   wrap its existing children. Preserve other providers, metadata and layout content.
2. Add the awaited metadata helper to the authenticated Checkout handler as above.
3. Build, then exercise a TEST referral through capture and Checkout. Successful
   capture must set the HttpOnly cookie; Checkout must carry its attribution.

JSON output lists file outcomes, required environment variable names and next
steps. `files_installed` means those files exist; `integrationVerified: false`
explicitly leaves wiring, configuration and end-to-end verification outstanding.
If a custom route/provider already exists, integrate using the examples above;
the installer will not overwrite it or guess at customer code.

Package installation does not connect a Stripe account, configure a program,
activate a creator, or prove a conversion. Complete the hosted TEST setup and
verify a referral, simulated purchase, conversion and webhook delivery. A package
install or successful configuration check does not prove those steps worked.
Your own workspace administrator authorizes setup; each participant accepts their
own terms and Page publication choice. See the SDK
[authorization boundaries](https://github.com/oftring-ventures/commish-sdk/blob/v0.8.1/packages/sdk/README.md#authorization-boundaries).

## Provision TEST or LIVE credentials from the CLI

For a new integration, use the framework-independent
[`commish setup` workflow](../sdk/README.md#set-up-from-your-repository) from
`@commish/sdk`. It supports workspace creation/selection, program and terms
configuration, destination verification, webhooks and resumable progress. Then
run the Next installer above and complete layout and Checkout wiring. Setup's
`credentials.env` already carries `NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY`,
`NEXT_PUBLIC_COMMISH_APPLICATION_ID` and `COMMISH_API_URL` beside the
unprefixed names, so supply the file to the environment as it is. The file
`commish keys create` or `commish keys rotate` writes for an application key
carries them too. A file from
`@commish/sdk` 0.8.0 or earlier lacks those three lines: copy its
`COMMISH_PUBLISHABLE_KEY` and `COMMISH_APPLICATION_ID` to the `NEXT_PUBLIC_*`
names. Keep `COMMISH_SECRET_KEY` server-only.

Credential setup and configuration verification live in that CLI: run
`pnpm exec commish setup` to provision and `pnpm exec commish verify --json` with
`COMMISH_PROGRAM_ID` to check a configured key. `commish-next` keeps the installer
above and the Pages commands; its former `setup` and `verify` subcommands exit with
`command_moved` and name the replacement. `commish-next --version` prints the
installed version.

## Referral links on your own domain

By default a creator shares `https://commish.sh/p/live/<program>/<handle>`. Install
one route and creators are shown `https://your-site.com/c/<handle>` instead. The
route asks Commish where to send the buyer and forwards them to your verified
destination with the same short-lived `commish_ref` the commish.sh link uses, so
the capture route and provider above keep working unchanged.

```sh
pnpm exec commish-next links init --json           # plan only
pnpm exec commish-next links init --apply --json   # writes app/c/[creator]/route.ts
# deploy, then ask Commish to check the route on your verified website
pnpm exec commish-next links verify --json
```

```ts
// app/c/[creator]/route.ts
import { createReferralLinkRoute } from "@commish/next/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createReferralLinkRoute(() => ({
  secretKey: process.env.COMMISH_SECRET_KEY!,
  apiUrl: process.env.COMMISH_API_URL,
}));
```

- One route serves every current and future creator; no deployment per creator.
- Use `--prefix /creators` for a different one-segment prefix. The installer never
  overwrites an existing file. A Commish Pages page at the same prefix already
  forwards creators who have no page, so nothing is installed beside it.
- Creators are shown the link on your website only after `links verify` passes.
  Commish rechecks the route daily and falls back to commish.sh links if it stops
  answering. commish.sh links keep working throughout.
- A temporary funding or promotion pause shows a static notice on your domain
  instead of the store, exactly as the commish.sh link does. An unknown handle is
  a 404; pass `notFound` to render your own.
- When one website carries several programs, the link credits the creator's
  earliest partnership there. Later partnerships keep their commish.sh links.
- The key deployed with the route and the key `links verify` runs with must
  belong to the same application and the same TEST or LIVE mode. One address
  serves one mode: verifying it with the LIVE key takes it over from TEST.
- `links init` refuses, like `pages init`, when a route group, the Pages Router
  or a dynamic or catch-all route could answer the same address. A run that
  writes nothing reports `no_changes`.
- Pass `onError` to hear about visits that failed for a reason other than an
  unknown handle (a rejected key, a timeout); the visitor still gets the notice.

**With Commish Pages on the same prefix.** A published creator Page owns its
address. If one of your programs has Pages enabled and a creator's permitted
page uses `/c/maya`, that address shows the Page and credits that program's
partnership, and a bare link under the same name credits it too. Otherwise the
link credits the creator's earliest eligible partnership on your website. The
creator's dashboard only ever shows an address to the partnership it credits.
Installing Pages at a prefix where you already installed the link route:
delete `app/c/[creator]/route.ts` first, then run `pages init`; the Pages page
forwards creators who have no page, so nothing is lost.

**Other frameworks.** The same handler works with any `Request`/`Response`
server:

```ts
import { Commish, createReferralLinkHandler } from "@commish/sdk";

const commish = new Commish({ secretKey: process.env.COMMISH_SECRET_KEY! });
const link = createReferralLinkHandler({ handoff: commish.links.handoff });

// GET /c/:creator in your router
export const creatorLink = (request: Request, creator: string) => link(request, creator);
```

### Root links (`your-site.com/<name>`)

Root links drop the prefix. They share your site's own namespace, so they are
opt-in twice: you turn on short links for the product in the Commish dashboard,
and you add one fallback rewrite so that only paths none of your own routes
match reach Commish.

```sh
pnpm exec commish-next links init --root --apply --json
# deploy, turn on short links in the dashboard, then
pnpm exec commish-next links verify --root --json
```

```js
// next.config.mjs: fallback only, after every page, asset and route of yours
import { referralLinkFallbackRewrite } from "@commish/next/links";

export default {
  async rewrites() {
    return { beforeFiles: [], afterFiles: [], fallback: [referralLinkFallbackRewrite()] };
  },
};
```

- `--root` writes `app/api/commish/link/[creator]/route.ts`, the route the
  rewrite targets, and a `next.config.mjs` only when the project has no Next
  config. An existing config is merged by hand; a top-level dynamic or
  catch-all route has to hand unknown paths over itself.
- Your own pages always win. Commish checks each creator's name against your
  site and keeps that creator on the prefix link when a page of yours answers
  the path; the dashboard lists those names.
- The root route answers everything that is not a creator, and any Commish
  outage, with a 404 (your `notFound` if you pass one), never a 5xx. Unknown
  paths are remembered briefly and lookups are rationed per server instance.
- Commish sends its per-name check with an `x-commish-link-check` header. The
  handlers forward it unchanged; a custom handler must do the same.
- With Commish Pages installed, the Pages alias handler serves root links for
  creators without a page too, so no second route or rewrite is needed.

## Creator Pages

Pages is optional and requires SDK/Next 0.3.0 or later. Installing it does not
enable Page publication or LIVE activity. Configure brand content, obtain each
creator's publication permission and honor visitor consent separately.

For manual integration, create a server-only configuration function returning `{secretKey, programId, origin, prefix:'/c'}`. Keep credentials out of client props and use the exact verified merchant origin.

- In `app/c/[creator]/page.tsx`, export `dynamic='force-dynamic'` and `createCreatorPage(options)` as the default page from `@commish/next/pages`.
- In a same-origin POST route at `/api/commish/pages`, use `createCreatorPageHandlers({options,publishableKey,consent})` from `@commish/next/pages/handlers`. Read real merchant consent server-side; attribution and measurement default denied.
- Pass authenticated Checkout parameters through `withCommishPageMeasurement(params,measurementAllowed)`, alongside the existing attribution helper. Call `withdrawCreatorPageMeasurement(options)` from the consent-update server handler on withdrawal, retrying a false receipt.
- Optional aliases use `creatorPageFallbackRewrite()` from `@commish/next/pages/routing` only in fallback rewrites after merchant routing. CMS-owned paths require explicit delegation. Never add a blanket interceptor.
- The alias handler answers every one-segment path that is not a creator alias, and every Commish failure, with a 404 (never a 5xx). Pass `createCreatorAliasHandler(options, { notFound })` to return your own not-found response for those paths. Verified aliases and misses are remembered briefly, an alias verified within the last ten minutes keeps redirecting while Commish is unreachable, and uncached lookups are bounded per instance.

Content and new eligible creators resolve at request time without a merchant rebuild. Test typed visits, consent withdrawal, root conflicts, capture failures and trusted TEST conversion/refund before enabling production. Installing the module is not end-to-end verification.

## Stripe buyer promotions (opt-in)

`createCommishCheckout({ commish, programId, attemptId, params, createSession })`
prepares a native Stripe offer, calls your existing Stripe client, and confirms
the session. Persist a cart attempt ID across retries. Derive both
`client_reference_id` and `customer` from authenticated merchant records.
The callback must pass the supplied `idempotencyKey` to Stripe. Preserve the
returned expiry, discount and trial parameters. Do not preconfigure a competing
discount or trial. Existing `withCommishStripeMetadata` behavior is unchanged.

If Stripe Checkout creation or confirmation fails after preparation, the
helper throws `CommishCheckoutError` with the prepared `attemptId`; store it
with the cart. After 24 hours plus five minutes, use
`commish.checkoutPromotions.reconcile({ attemptId })` to release an unused trial
reservation only after Stripe confirms abandonment. Retrying `prepare` with the
same cart attempt returns that ID too, or a `checkout_attempt_expired` error
whose `details.attemptId` names it.
Native Stripe codes apply discounts and creator attribution without a cookie;
trials require referral preparation. Enable these helpers only when the Commish
service has buyer promotions enabled.
