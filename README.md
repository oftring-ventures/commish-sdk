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
The React provider and CLI are not available at this source checkpoint.
The pinned Next framework dependencies support an isolated installed server-helper
probe, production build, concurrent cookie requests and capture requests against
an owned loopback upstream. The React provider consumer
remains a separate scope.
No npm publication, release artifact provenance or hosted acceptance is claimed.

With Node 24 and pnpm 11.1.3:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
```

Only the entry points described above are available at this source checkpoint.
