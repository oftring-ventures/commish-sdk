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

The publication preflight library reads only a candidate whose source, manifest
and CI receipt hashes match a separately accepted handoff. It checks every archive
and member, and preflights both exact registry versions before planning either
upload. Identical existing versions are skipped; different bytes or unavailable
lookups stop the pair. Plans default to npm dry-run and execute no commands.
A real publication plan additionally requires the public `v0.1.0-beta.10` tag/workflow identity,
separate exact-candidate approval and a hosted acceptance evidence hash. Protected
environment configuration, GitHub run/artifact verification and execution remain
responsibilities of the publishing workflow; a plan alone authorizes no registry write.

The publication handoff verifier is read-only. Given an accepted `Public source` run
and its retained candidate artifact, it confirms through the GitHub API that the run
succeeded from this repository, that its head is an ancestor of `main`, that the
artifact is unexpired and its bytes match the API digest, and that the candidate
inside binds that exact run, source and manifest. It then writes the approval digests
the preflight library consumes. It needs only a read token and performs no publication.

The protected `Publish approved packages` workflow publishes only from the immutable
`v0.1.0-beta.10` tag, by manual dispatch. Its executor defaults to dry-run outside
that workflow and never retries an upload automatically. Both exact registry
versions are preflighted before uploading SDK then Next; existing identical versions
are skipped. Each upload gets an immediate registry integrity readback. Missing or
different evidence stops the pair. A failed/uncertain run may have published one
package: inspect both registry versions before authorizing another attempt.

Before dispatch, the release owner must complete this handoff:

1. Merge the publishing source and qualify a fresh candidate from that exact commit.
   Independently compare its Linux and macOS archives. The candidate, release tag,
   and workflow revision must share one SHA; an older pre-workflow candidate cannot
   be published by this workflow.
2. Record approved hosted TEST acceptance, then explicitly authorize these two
   archives. Configure the GitHub `npm-publication` environment with required
   reviewers, self-review prevention, and a deployment rule allowing only
   `v0.1.0-beta.10`. Keep the tag immutable. Do not dispatch while publication is held.
3. Save independently approved values as environment variables in that GitHub
   environment (configuration variables, not secrets):
   `COMMISH_NPM_APPROVED_SOURCE`, `COMMISH_NPM_APPROVED_MANIFEST_SHA256`,
   `COMMISH_NPM_APPROVED_CI_RECEIPT_SHA256`, and
   `COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256`. Never derive approval inside the job.
4. Verify both npm package trusted-publisher bindings name this repository,
   `publish-packages.yml`, and `npm-publication`. The workflow uses Node 24.15.0's
   bundled npm and GitHub OIDC; no npm token or dependency installation is needed.
   See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
5. Dispatch on the tag with the accepted candidate run and artifact IDs; review the
   protected job. Retain its integrity receipt, verify registry provenance, and run
   clean external installations of the exact package versions. A registry integrity
   receipt does not establish hosted/live acceptance or release readiness.

Source preparation, tests and PR publication do not configure this environment,
create a tag, authorize registry writes or lift the founder's publication hold.
