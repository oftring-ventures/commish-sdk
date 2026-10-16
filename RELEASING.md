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

The complete source pair targets the stable version declared in both package
manifests, which `scripts/stable-release.mjs` reads, on npm's `latest` tag.
Package stability is independent of TEST/LIVE mode and workspace eligibility.
Both packages include MIT LICENSE
and setup documentation, and Next requires the same SDK minor version. Release candidate
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
A real publication plan additionally requires the public `v<version>` tag/workflow identity,
separate exact-candidate approval and a hosted acceptance evidence hash. Protected
environment configuration, GitHub run/artifact verification and execution remain
responsibilities of the publishing workflow; a plan alone authorizes no registry write.

The publication handoff verifier is read-only. Given an accepted `Public source` run
and its retained candidate artifact, it confirms through the GitHub API that the run
succeeded from this repository, that its head is an ancestor of `main`, that the
artifact is unexpired and its bytes match the API digest, and that the candidate
inside binds that exact run, source and manifest. It then writes the approval digests
the preflight library consumes. It needs only a read token and performs no publication.

The protected `Publish approved packages` workflow requires an immutable release
tag `v<version>` matching the manifest version `scripts/stable-release.mjs` reads, by manual dispatch.
Prerelease versions and mismatched source, pair or tag identities are rejected.
Its executor defaults to dry-run outside
that workflow and never retries an upload automatically. Both exact registry
versions are preflighted before uploading SDK then Next; existing identical versions
are skipped. npm's publish-time malware scan hides a new version for minutes, so
after a successful upload the executor polls its registry integrity every 30 seconds
for up to 30 minutes. Only a clean E404 means "not yet visible"; different integrity,
any other lookup failure or the deadline stops the pair. A failed/uncertain upload gets
one readback and stops. A stopped run may have published one package that the scan
still hides: wait out the scan window before reading an E404 as unpublished, then
inspect both registry versions before authorizing another attempt.

Before dispatch, the release owner must complete this handoff:

1. Merge the publishing source and qualify a fresh candidate from that exact commit.
   Independently compare its Linux and macOS archives. The candidate, release tag,
   and workflow revision must share one SHA; an older pre-workflow candidate cannot
   be published by this workflow.
2. Record approved hosted TEST acceptance, then explicitly authorize these two
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
4. For the first release only, npm requires each package to exist before it can
   accept a trusted-publisher binding. After explicit publication authorization,
   authenticate the release owner with npm and bootstrap-publish the two approved
   archives in SDK-then-Next order. Verify each registry integrity before continuing.
   Then configure each package's GitHub Actions trusted publisher with organization
   `oftring-ventures`, repository `commish-sdk`, workflow `publish-packages.yml`,
   environment `npm-publication`, and direct `npm publish` permission. Restrict
   traditional package publishing to require 2FA and disallow tokens. Later releases
   use GitHub OIDC and need no npm token. See
   [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
5. Dispatch on the tag with the accepted candidate run and artifact IDs; review the
   protected job. Retain its integrity receipt and run clean external installations
   of the exact package versions. The manually bootstrapped first version has registry
   integrity evidence but no GitHub OIDC provenance; provenance begins with the first
   version uploaded by the trusted publisher. A registry integrity receipt does not
   establish hosted/live acceptance or release readiness.
6. Publish a GitHub Release for the tag from the CHANGELOG entry
   (`gh release create v<version> --verify-tag --notes-file <notes>`). Remove the
   stale `beta` dist-tag from both packages (`npm dist-tag rm <package> beta`)
   once nothing depends on it; `latest` is the only supported tag.

For each subsequent stable release, update both package manifests (the SDK
manifest declares the release version and the Next manifest must match it),
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
`npx -y commish@latest` runs the CLI. It stays outside the pnpm workspace and the
paired release: the source gate allows only its four files, and
`scripts/launcher.test.mjs` keeps its version, its exact `@commish/sdk` dependency
and its license equal to the SDK's.

npm adds a trusted publisher only to a package that already exists, so a
maintainer account with 2FA publishes the first version once, from a clean
checkout of the reviewed commit, after the matching `@commish/sdk` version is on
npm:

```sh
cd launcher
npm publish --dry-run
npm publish
```

Then add the trusted publisher for this repository's `publish-packages.yml` and
`npm-publication` environment with npm publish allowed, and require 2FA with
tokens disallowed. Until the release workflow includes the launcher, publish the
matching launcher version the same way after each SDK release.
