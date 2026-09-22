# @commish/next

MIT-licensed Next.js App Router integration for permanent Commish TEST and LIVE modes.
This source checkpoint is verified with Node 24.15.0, Next 16.3.4 and React 19.2.8.
It does not establish npm availability or acceptance against a hosted Commish API.
Use the exact paired `0.1.0-beta.10` SDK/Next packages and keep the consumer lockfile.
Accepted candidate tarballs remain available for prepublication qualification.

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
failure keeps the referral for retry. Wait for capture before starting Checkout.

## Agent-driven installation and Checkout

In your existing authenticated server Checkout route, await
`withCommishStripeMetadata(params)` from `@commish/next` before passing the result
to your existing Stripe Checkout integration. The helper preserves other
parameters and applies the request's attribution to payment or subscription
metadata. `getCommishAttribution()` reads that cookie directly; both helpers
require a Next request context. The root export is blocked in browser builds.
The provider belongs at `@commish/next/react`; `@commish/next/browser` also exports
`captureReferral` for direct browser integration.

After installing an accepted pair, run from the consumer project root:

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
record its acceptance separately from package build and installation evidence.

## Provision TEST credentials from the CLI

An owner or admin can authorize an agent-driven setup without copying a secret
from the dashboard:

```sh
pnpm exec commish-next setup \
  --workspace wrk_your_workspace_id \
  --application-name "Your product" \
  --key-label "Local agent setup" \
  --output .env.commish \
  --json
```

The command generates the TEST secret and publishable key on the developer's
machine, opens a ten-minute approval page on `https://app.commish.sh`, and polls
for the approved exchange. The browser requires an authenticated workspace owner
or admin with a recent authenticator check. Only hashes and the publishable key
cross the browser boundary; Commish never receives or stores the raw secret.

After approval, the CLI atomically creates the explicitly named output with mode
`0600`. It never overwrites an existing path. The file contains
`COMMISH_API_URL`, `COMMISH_SECRET_KEY`,
`NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY`, and
`NEXT_PUBLIC_COMMISH_APPLICATION_ID`. Add that path to the product's local secret
handling policy; do not commit it. An interrupted exchange can safely retry the
same verifier and receives the same application and key.

Use `--no-open` when the controlling agent will present the printed approval URL
itself. For a trusted local Commish runtime, `--app-url` accepts an explicit
loopback HTTP origin; other custom origins require HTTPS. Setup creates TEST
application credentials only. Program configuration and the complete transaction
journey remain separate verification steps.

## Verify configuration from the CLI

With the installed packages and configured environment, set `COMMISH_PROGRAM_ID`
to your existing program ID and run `pnpm exec commish-next verify --json`.
The command reads `COMMISH_SECRET_KEY`, `NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY`,
`NEXT_PUBLIC_COMMISH_APPLICATION_ID` and `COMMISH_PROGRAM_ID` from the process
environment. Use Node's `--env-file` support or your existing environment runner
if needed; the CLI does not search for or change dotenv files.

It performs one authenticated, read-only program lookup in the key's TEST or LIVE
mode. `configuration_verified` means the key can read that program and its
application/mode match the configured values. The receipt includes program status;
a paused or draft program is not declared ready for transactions. Publishable-key
format/mode is checked locally; its server-side application binding is **not** proved.
`integrationVerified: false` and `unverified` identify the remaining real journey.

The API defaults to `https://app.commish.sh/api/v1`. Set `COMMISH_API_URL` only to a
Commish deployment you trust: this destination receives the secret key. Custom
bases require HTTPS, except explicit loopback development addresses. Redirects are
rejected; responses and request duration are bounded. The CLI does not provision resources or issue mutation requests. Authentication
may update key-usage metadata. It never prints credentials/provider bodies or retries a request. Invalid configuration,
denied/revoked keys, inaccessible programs, mismatches and unavailable responses exit
with code 1 and a stable JSON error code. On older deployments that reject LIVE reads,
verification fails with `access_denied`; it never falls back to TEST.
