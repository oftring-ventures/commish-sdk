# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository (Security →
Report a vulnerability). Do not open a public issue or pull request for a
suspected vulnerability. Include the package version, a reproduction and the
impact you observed. The maintainers acknowledge reports as soon as possible and
coordinate the fix and its disclosure with you.

Reports about the hosted Commish service can use the same channel; they are
routed to the service owners.

## Supported versions

Security fixes are published for the current minor version of `@commish/sdk`
and `@commish/next` on npm's `latest` tag. Both packages release together with
one version. Earlier versions should upgrade.

## Scope

This repository holds the public SDK, the Next.js adapter, their CLIs and the
release tooling. Credentials never belong in reports: redact secret keys,
management tokens and webhook signing secrets before sending a reproduction.
