# @commish/next

MIT-licensed Next.js App Router integration for the Commish test-money pilot.
This source checkpoint is verified with Node 24.15.0, Next 16.3.4 and React 19.2.8.
It does not establish npm availability or acceptance against a hosted Commish API.
Use the exact paired SDK/Next artifacts and consumer lockfile from your accepted
candidate receipt; the release workflow and registry install instructions follow
in separate release preparation work.

## Capture route

Set `COMMISH_API_URL` to the supplied TEST API base, including `/api/v1`, and
`COMMISH_SECRET_KEY` to the application-scoped TEST secret. Keep both on the server.
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
in an HttpOnly cookie. Configure the API base explicitly for the TEST deployment;
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
failure keeps the referral for retry. Wait for capture before starting Checkout.

## Server Checkout and dry-run setup

In your existing authenticated server Checkout route, await
`withCommishStripeMetadata(params)` from `@commish/next` before passing the result
to your existing Stripe **test** Checkout integration. The helper preserves other
parameters and applies the request's attribution to payment or subscription
metadata. `getCommishAttribution()` reads that cookie directly; both helpers
require a Next request context. The root export is blocked in browser builds.
The provider belongs at `@commish/next/react`; `@commish/next/browser` also exports
`captureReferral` for direct browser integration.

After installing an accepted pair, run `pnpm exec commish-next` from the consumer
project root. It prints the route/layout changes above, prefers `src/app` when
both App Router locations exist, and never writes files. Missing App Router
directories produce an error and exit status 1. Review and apply the setup manually.

Package installation does not connect a Stripe account, configure a program,
activate a creator, or prove a conversion. Complete the hosted TEST setup and
record its acceptance separately from package build and installation evidence.
