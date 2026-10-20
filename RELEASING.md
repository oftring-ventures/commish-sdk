# Maintainer release process

This runbook is for package maintainers. Application developers install published
packages from npm and follow the [SDK guide](packages/sdk/README.md) or
[Next.js guide](packages/next/README.md); they do not qualify release artifacts.

With the Node version in `.node-version` and the pnpm version in the root
`package.json` `packageManager` field (the workflows read both from those files):

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
pnpm lint
pnpm test
```

`pnpm lint` checks formatting and the lint rules in `biome.json` (`pnpm format` applies
them); CI runs the same check and
reports test coverage for the CLI and release scripts.

The complete release, the SDK and Next pair plus the `commish` launcher, targets the
stable version declared in the SDK manifest, which `scripts/stable-release.mjs` reads,
on npm's `latest` tag. Package stability is independent of TEST/LIVE mode and
workspace eligibility. Every package includes MIT LICENSE and documentation, Next
requires the same SDK minor version, and the launcher pins the exact SDK version.
Release candidate preparation and hosted acceptance remain separate steps; use an
accepted artifact receipt before installing the release.

To prepare a new local candidate from a reviewed clean commit, pass a new absolute
output directory whose parent exists outside the checkout:

```sh
EXPECTED_SHA="$(git rev-parse HEAD)" node scripts/verify-public-source.mjs /absolute/new-candidate
```

The command builds and normalizes the pair and packs the launcher, runs the installed
consumers against those exact archives, then writes three tarballs, `SHA512SUMS`
and a manifest with source, archive/member hashes and consumer scopes. It refuses
existing outputs. A failed write may leave partial files without a valid receipt;
use a fresh directory after investigating. No npm or hosted acceptance is implied.

The read-only `Public source` workflow prepares the same candidate on Linux x64
and retains it for 30 days as `public-candidate-<source SHA>-<run ID>-<attempt>`.
Its additional `ci-receipt.json` binds the manifest and archives to the reported
repository, run, workflow revision and actual checked-out source. Pull-request
trigger and workflow SHAs can differ from that source; all three are recorded.
Before accepting a handoff, verify the successful run, source and artifact identity
against GitHub, then compare every downloaded tarball byte-for-byte with an
independent macOS candidate built from the same source. The receipt alone is not
publication authority. Candidate CI has no publication credentials or write permissions.

The publication preflight library reads only a candidate whose source, manifest
and CI receipt hashes match a separately accepted handoff. It checks every archive
and member, and preflights every exact registry version before planning any
upload. Identical existing versions are skipped; different bytes or unavailable
lookups stop the release. Plans default to npm dry-run and execute no commands.
A real staging plan additionally requires the public `v<version>` tag/workflow identity,
separate exact-candidate approval and a hosted acceptance evidence hash. Protected
environment configuration, GitHub run/artifact verification and execution remain
responsibilities of the publishing workflow; a plan alone authorizes no registry write.

The publication handoff verifier is read-only. Given an accepted `Public source` run
and its retained candidate artifact, it confirms through the GitHub API that the run
succeeded from this repository, that its head is an ancestor of `main`, that the
artifact is unexpired and its bytes match the API digest, and that the candidate
inside binds that exact run, source and manifest. It then writes the approval digests
the preflight library consumes. It needs only a read token and performs no publication.

The protected `Stage approved packages` workflow requires an immutable release
tag `v<version>` matching the manifest version, by manual dispatch. Prerelease
versions and mismatched source, artifact or tag identities are rejected. The
workflow installs npm 11.21.0 from the public registry; staged publishing requires
npm 11.15.0 or later. The executor rejects another CLI version.

The executor defaults to `npm stage publish --dry-run`. Its only upload mode is
`--stage`; `--publish` is rejected. It preflights every public registry version,
stages the SDK, Next and launcher archives in order, and verifies each CLI receipt's
package, version and integrity against the approved archive. It records the unique
stage IDs and stops at `awaiting-maintainer-approval`. It never runs `npm stage
approve`, publishes directly, or interprets a staged upload as public availability.

Staging does not wait for a public registry version: a maintainer must first approve
it with npm 2FA. The workflow retains its receipt even after a partial failure,
including any package whose upload outcome is uncertain. Never automatically retry
an upload. On failure, inspect npm's staged packages and the public registry before
another dispatch. An E404 from `npm view` does not distinguish an absent version
from a staged version or a published version hidden by npm's malware scan. Existing
stages reserve their package version; never reject or replace one merely to retry.

Before dispatch, the release owner must complete this handoff:

1. Merge the publishing source and qualify a fresh candidate from that exact commit.
   Independently compare its Linux and macOS archives. The candidate, release tag,
   and workflow revision must share one SHA; an older pre-workflow candidate cannot
   be published by this workflow.
2. Record approved hosted TEST acceptance, then explicitly authorize these three
   archives. Configure the GitHub `npm-publication` environment with the required
   reviewer and the founder-approved single-owner manual approval model, plus a
   deployment rule allowing release tags (`v*`). Release tags are immutable through
   the repository ruleset that protects `refs/tags/v*`; never move or delete a
   published tag.
3. Save independently approved values as environment variables in that GitHub
   environment (configuration variables, not secrets):
   `COMMISH_NPM_APPROVED_SOURCE`, `COMMISH_NPM_APPROVED_MANIFEST_SHA256`,
   `COMMISH_NPM_APPROVED_CI_RECEIPT_SHA256`, and
   `COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256`. Never derive approval inside the job.
4. Configure **all three** npm packages with a GitHub Actions trusted publisher:
   organization `oftring-ventures`, repository `commish-sdk`, workflow
   `publish-packages.yml`, environment `npm-publication`. Leave **Allow npm publish**
   and **Allow npm dist-tag** unchecked; only staging is allowed. Require 2FA and
   disallow bypass tokens for traditional publishing. Do not introduce npm write
   tokens into CI. All packages already exist; bootstrap publishing is unnecessary.
5. Dispatch on the tag with the accepted candidate run and artifact IDs, then approve
   the protected GitHub job. Retain the `npm-staging-*` receipt. This approval allows
   staging only; it is separate from the maintainer's subsequent npm approval.
6. As the authenticated npm maintainer, inspect each stage with `npm stage view
   <stage-id> --json` and `npm stage download <stage-id>`. Verify package name,
   version, `latest` tag and the downloaded tarball's SHA-512 against the accepted
   candidate. Preserve that readback evidence. The CLI upload receipt alone does
   not establish server-side bytes. Never approve an uncertain or mismatched stage.
7. The maintainer approves each verified stage in npm with 2FA, SDK first, then Next,
   then launcher. Wait for each exact public registry integrity before approving its
   dependent package. npm's malware scan may hide an approved version for minutes;
   a clean E404 is pending visibility, not authorization to upload again. After
   approval, verify integrity and OIDC provenance for all three versions, then run
   clean external installations of the exact versions. Do not call staging success
   release completion.
8. Publish a GitHub Release for the tag from the CHANGELOG entry
   (`gh release create v<version> --verify-tag --notes-file <notes>`). Remove stale
   `beta` dist-tags only once nothing depends on them. Staging uses the immutable
   `latest` tag; the trusted publishers have no separate dist-tag mutation access.

See [npm staged publishing](https://docs.npmjs.com/staged-publishing/) and
[trusted publishing](https://docs.npmjs.com/trusted-publishers/). A new publisher
binding expires if its first successful publish does not occur within two days;
configure it shortly before the release and complete the maintainer approval.

For each subsequent stable release, update the three package manifests (the SDK
manifest declares the release version; the Next manifest, the launcher version and
its exact `@commish/sdk` dependency must match it),
exact consumer fixtures, the CHANGELOG entry and documentation together. Preserve
the separate candidate approval, hosted evidence and registry verification gates.

## Pages acceptance scope

Before publishing a Pages candidate, run `node scripts/verify-pages-artifact.mjs`
and the applicable browser checks against the installed archives. The release
fixture exercises ten eligible creators followed by ten newly eligible creators
without a merchant redeployment, route priority, aliases, consent exclusion,
pauses, endings and withdrawal. Retain separate hosted TEST evidence for Page
publication/creator permission, capture, checkout, conversion and delivery; local
fixtures or a successful build do not establish hosted acceptance. Preserve the
relevant duplicate/refund, key-revocation, mode/application-isolation, failure,
mobile-accessibility and prefetch checks in release evidence. This maintainer
fixture size is not a customer onboarding requirement.

## The `commish` launcher

`launcher/` is the source of the unscoped `commish` npm package, so
`npx -y commish@latest` runs the CLI. It stays outside the pnpm workspace, because the
frozen lockfile cannot resolve an exact dependency on an SDK version that is not
published yet, but it is part of every release. The candidate packs it after the
pair, installs it offline against the candidate SDK archive and runs its `--version`;
the workflow uploads it last. `scripts/package-shape.mjs` keeps its version and its
exact `@commish/sdk` dependency equal to the release.

Version 0.4.0 was published by hand, so its bytes differ from a normalized candidate
archive: the first workflow release of the launcher must be a new version. Configure
its stage-only publisher with the same restrictions as the SDK and Next packages.
`publishConfig.registry` keeps registry operations on the public registry.
