# Changelog

Notable changes to `@commish/sdk`, `@commish/next`, and `commish`, which release
together with one version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.7.1 - 2026-11-14

### Fixed

- `commish setup` accepts `terms.returnWindowDays` (an integer from 0 to 180),
  which the published setup schema already listed, and reports an invalid value
  under that field name instead of `terms`. An omitted value is not sent, and the
  final receipt reports the window the server stored next to `termVersion`.
  Progress saved by 0.7.0 still resumes.
- `commish verify --help` and `commish init --help --json` print help instead of
  failing with `invalid_arguments`.
- `commish manage --body-file` explains a refused file with a fixed `reason`
  (`path_not_repository_relative`, `file_missing`, `file_unreadable`,
  `invalid_json` or `json_object_required`) and `guidance`, without echoing the
  path or contents. Body files must still be inside the repository.
- `commish agent --json` returns a `configurationGuideUrl` pinned to the release
  tag, like its other links, instead of `main`.

### Changed

- A `commish setup` receipt that is still waiting for Stripe repeats the
  connection link as `browserActions: [{ action: "connect_stripe", url }]`, and
  the text output prints it. The field is absent once Stripe is connected.
- The Next guide explains how to wait for referral capture before Checkout and
  that `client_reference_id` must be the merchant's own stable customer ID. The
  SDK guide explains how to read the `commish doctor` report.
- The SDK, Next adapter and `commish` launcher release together at 0.7.1.
  The launcher pins `@commish/sdk@0.7.1`; Next accepts `@commish/sdk@~0.7.1`.

## 0.7.0 - 2026-11-13

### Added

- TEST setup requests onboarding access in the same browser approval, so setup,
  verification and program activation can share a management grant lasting up to
  one day. `--no-onboarding` declines it; LIVE setup never requests it. Older
  servers continue to provision setup and report `onboarding: null`.
- `commish test rehearsal` creates the approving owner's or admin's own Test
  partnership and returns its referral link. Repeated calls reuse the partnership.
  Owners without a creator role or handle can rehearse with a private test profile;
  the command reports any remaining handle, role or program activation steps.

### Changed

- The setup playbook uses onboarding access and the rehearsal command to guide
  an attributed TEST purchase. Opening the referral link and buying in Test
  remains necessary to prove the integration.
- The SDK, Next adapter and `commish` launcher release together at 0.7.0.
  The launcher pins `@commish/sdk@0.7.0`; Next accepts `@commish/sdk@~0.7.0`.

## 0.6.0 - 2026-11-12

### Added

- `commish auth login --onboarding` requests a browser-approved Test management
  grant for installation and testing, lasting up to one day without requiring
  the browser session to stay signed in. Live mode, invitation writes, longer
  lifetimes and widened server receipts are refused. Credential and webhook
  changes still require an authenticator check less than one hour old.

### Security

- Raise the Next.js minimum and tested version to 16.4.1, fixing
  GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw and GHSA-p3m5-59mp-jv5r.
  Next.js applications must upgrade to 16.4.1 or later in the 16.x line
  before installing this release.

### Changed

- Setup documentation names the Business server credential shown in the
  dashboard and explains the onboarding grant's authorization limits.
- The SDK, Next adapter and `commish` launcher release together at 0.6.0.
  The launcher pins `@commish/sdk@0.6.0`; Next accepts `@commish/sdk@~0.6.0`.

## 0.5.0 - 2026-10-20

### Added

- The server SDK's `checkoutPromotions` client prepares, confirms and reconciles
  buyer-promotion Checkout attempts, validates responses against their requests,
  and exposes structured API error details through `CommishError.details`.
- Next.js checkout helpers apply prepared discounts and trials, preserve the
  trial cancellation policy, and report the prepared attempt ID through
  `CommishCheckoutError` when checkout creation or confirmation fails.
- Optional Creator Pages v2 displays eligible buyer offers while retaining
  legacy coupon display when no buyer offer applies. Promotion availability
  remains controlled by the service and program configuration.
- `commish init`, also the default bare `commish` command, prints a repository
  setup playbook with install, plan, setup, wiring and verification steps. It
  reads repository metadata without making network requests or writing files.

### Fixed

- Checkout creation removes stale merchant-supplied referral attribution from
  both Session and subscription metadata when the visitor has no valid referral,
  preventing later renewals from inheriting an unrelated creator.

### Changed

- The unscoped `commish` launcher is now qualified and published alongside the
  SDK and Next package, and pins `@commish/sdk@0.5.0` exactly. `@commish/next`
  accepts the matching SDK minor version (`~0.5.0`).

## 0.4.0 - 2026-10-13

The removals and the wider `mode` type below are breaking, hence the minor
version.

### Fixed

- Public types report `mode: "test" | "live"` for customers, conversions,
  refunds, commissions, payouts, webhook deliveries and memberships, matching
  the API, which returns every resource in the authenticated key's mode.
- The root alias handler remembers verified creator aliases, keeps a recently
  verified alias redirecting while Commish is unreachable, and no longer lets
  crawler noise or a popular link exhaust its lookup budget into 404s.
- `commish setup` and `commish auth login` keep waiting through proxy error
  pages, rate limits and transport blips during browser approval; Ctrl-C cancels
  the request in flight and still revokes the pending setup session; failure and interrupt receipts name the authorization
  file; a directory without a git executable is accepted.

### Changed

- Both packages accept Node 22 or later (`engines.node: ">=22"`). Releases are
  still built on the version in `.node-version`.
- `@commish/next` accepts the SDK patch line (`@commish/sdk@~0.3.0`) instead of
  one exact version.
- `@commish/sdk` resolves on edge runtimes (Next.js Edge routes and middleware,
  Cloudflare Workers) through `edge-light` and `workerd` export conditions.
  `@commish/sdk/webhooks` and the `@commish/next` server helpers stay Node-only.
- Export maps list `types` first, declare `sideEffects: false` and expose
  `./package.json`. `CommishError` sets `name` to `"CommishError"`.
- Pages error receipts carry only stable snake_case codes; the Pages API base
  is validated like every other command.

### Added

- `commish --version`, `commish-next --version`, `-h`, and `COMMISH_DEBUG=1`
  to print the underlying error alongside a sanitized receipt.

### Removed

- `commish-next setup` and `commish-next verify`. Use `commish setup` and
  `commish verify --json`; the old commands exit with `command_moved`.
- Native Windows. Both CLIs exit with `unsupported_platform` for every command
  except `--version` and `--help`; use WSL.

## Earlier releases

Releases before 0.4.0 are described by their Git tags: `v0.3.0`
(2026-10-12), `v0.2.3` (2026-10-06), `v0.2.2` and `v0.2.1` (2026-10-05),
and `v0.2.0` (2026-10-04). `0.1.0-beta.10` (2026-09-28) was published to npm
without a Git tag.
