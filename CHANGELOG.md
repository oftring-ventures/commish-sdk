# Changelog

Notable changes to `@commish/sdk` and `@commish/next`, which release together
with one version. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

The removals and the wider `mode` type below are breaking, so these changes
release as 0.4.0.

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

Releases before this changelog are described by their Git tags: `v0.3.0`
(2026-10-12), `v0.2.3` (2026-10-06), `v0.2.2` and `v0.2.1` (2026-10-05),
and `v0.2.0` (2026-10-04). `0.1.0-beta.10` (2026-09-28) was published to npm
without a Git tag.
