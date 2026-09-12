# Commish public packages

MIT-licensed source for the Commish test-money pilot.
Available: the complete SDK, the `@commish/next/browser` bridge, and the server-only
`applyCommishStripeMetadata` helper from `@commish/next`. The helper preserves existing
Checkout fields and adds attribution to payment or subscription metadata; it does
not create a Checkout session. `getCommishAttribution` reads the current request's
`commish_attribution` cookie, and `withCommishStripeMetadata` applies it to Checkout
parameters without changing their other fields. Both require a Next request context.
`createAttributionHandler` forwards capture requests to Commish, uses the request cookie
for previous attribution, and stores successful attribution in an HttpOnly cookie.
Its server-only `secretKey` option must never come from browser input.
`CommishProvider` from `@commish/next/react` captures referrals when its configuration
or the current route changes, and renders its children inside the application layout.
`commish-next` prints a dry-run setup plan without changing consumer files.
See [Next setup](packages/next/README.md) for the route and layout changes.
The pinned Next framework dependencies support an isolated installed server-helper
probe, production build, concurrent cookie requests and capture requests against
an owned loopback upstream. The provider also passes the installed type and production
framework consumers; controlled hook tests verify its capture configuration and route dependencies.
No npm publication, release artifact provenance or hosted acceptance is claimed.

With Node 24 and pnpm 11.1.3:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
```

The complete source pair targets `0.1.0-beta.10`. Both packages include MIT LICENSE
and setup documentation, and Next requires that exact SDK version. Release candidate
preparation and hosted acceptance remain separate steps; use an accepted artifact
receipt before installing the pair.

To prepare a new local candidate from a reviewed clean commit, pass a new absolute
output directory whose parent exists outside the checkout:

```sh
EXPECTED_SHA="$(git rev-parse HEAD)" node scripts/verify-public-source.mjs /absolute/new-candidate
```

The command builds and normalizes both packages, runs the existing installed
consumers against those exact archives, then writes two tarballs, `SHA512SUMS`
and a manifest with source, archive/member hashes and consumer scopes. It refuses
existing outputs. A failed write may leave partial files without a valid receipt;
use a fresh directory after investigating. No npm or hosted acceptance is implied.

The read-only `Public source` workflow prepares the same candidate on Linux x64
and retains it for 30 days as `public-candidate-<source SHA>-<run ID>-<attempt>`.
Its additional `ci-receipt.json` binds the manifest and archives to the reported
repository, run, workflow revision and actual checked-out source. Pull-request
trigger and workflow SHAs can differ from that source; all three are recorded.
Before accepting a handoff, verify the successful run, source and artifact identity
against GitHub, then compare both downloaded tarballs byte-for-byte with an
independent macOS candidate built from the same source. The receipt alone is not
publication authority. Candidate CI has no publication credentials or write permissions.
