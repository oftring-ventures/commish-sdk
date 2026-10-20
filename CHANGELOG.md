# Changelog

Notable changes to `@commish/sdk`, `@commish/next`, and `commish`, which release
together with one version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
