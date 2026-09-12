# Commish public packages

MIT-licensed source for the Commish test-money pilot.
Available: the complete SDK, the `@commish/next/browser` bridge, and the server-only
`applyCommishStripeMetadata` helper from `@commish/next`. The helper preserves existing
Checkout fields and adds attribution to payment or subscription metadata; it does
not create a Checkout session. Next capture routes, cookie readers, React provider
and CLI are not available at this source checkpoint.
No npm publication, release artifact provenance or hosted acceptance is claimed.

With Node 24 and pnpm 11.1.3:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
```

Only the entry points described above are available at this source checkpoint.
