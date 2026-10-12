# Commish SDK and Next.js integration

Connect creator referrals to purchases, commissions and webhook events in your
application. The SDK includes a CLI for setup and API operations; the optional
Next.js adapter handles referral capture, Checkout metadata and creator Pages.
Both packages are MIT licensed.

## Install

Use Node 24 and your application's package manager. Keep the dependency lockfile.
This source documents version 0.3.0; check the [npm SDK package](https://www.npmjs.com/package/@commish/sdk)
for published availability. Documentation on a release tag matches that release.

```sh
pnpm add --save-exact @commish/sdk@0.3.0
# Optional, for Next.js App Router applications:
pnpm add --save-exact @commish/next@0.3.0
```

The Next adapter requires the matching SDK version, Next >=16.3.8 <17 and
React >=19.2.8 <20. Other frameworks can use the core SDK directly.

## Start in TEST

```sh
pnpm exec commish setup --plan --json
```

The plan runs locally without an account, network requests or file changes. It
reports the business choices you need to supply. Follow the
[SDK setup guide](packages/sdk/README.md#set-up-from-your-repository) to configure
an offer, approve setup and connect your application. For Next.js, follow the
[capture and Checkout guide](packages/next/README.md). Creator Pages are optional;
see the [Pages guide](packages/next/guides/pages.md).

TEST and LIVE are permanent, separate environments. TEST lets you validate a
referral and simulated purchase without real payments. LIVE requires explicit
selection and the workspace's eligibility and provider setup.

## What an agent can do

The CLI plans and provisions integrations, calls the public API, manages approved
resources and reports integration diagnostics. Commands expose JSON output and
offline schemas through `commish agent --json`, `commish api list --json` and
`commish manage list --json`.

Application API calls use an integration key without a browser interaction per
request. Setup and management use separate browser-approved authority: the
workspace owner/admin signs in, completes the authenticator check and approves
the requested workspace, mode and scopes. Read-only management automation can
last up to 30 days; interactive reads up to one hour; writes up to ten minutes.
Longer-lived management writes are not supported. Stripe connection and each
creator's terms and Page publication choices remain human actions.

Your own workspace administrators and participants complete those steps; no
Commish founder or platform-owner approval is needed for TEST setup. See
[authorization boundaries](packages/sdk/README.md#authorization-boundaries) for
credential handling, expiration and revocation.

Installation, configuration and a working transaction are different milestones.
Setup and `commish verify` check configuration; an attributed TEST conversion,
commission and webhook delivery provide evidence of the integrated flow. The
[diagnostics guide](packages/sdk/README.md#diagnose-and-test) explains remaining
conditions without treating a successful install as a completed integration.

## Package guides

- [SDK, API commands and setup](packages/sdk/README.md)
- [Next.js referral capture and Checkout](packages/next/README.md)
- [Creator Pages](packages/next/guides/pages.md)
- [Pages instructions for coding agents](packages/next/guides/agents.md)
- [Maintainer build and release process](RELEASING.md)
