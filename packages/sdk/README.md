# @commish/sdk

Commish's Node 24 SDK connects creator referrals to purchases, commissions and
webhooks. It supports permanent TEST and LIVE environments and includes a CLI for
setup and API operations. The SDK ships ESM JavaScript and TypeScript declarations
with no production dependencies. It is MIT licensed.

```ts
import { Commish } from "@commish/sdk";

const commish = new Commish({
  secretKey: process.env.COMMISH_SECRET_KEY!,
  baseUrl: process.env.COMMISH_API_URL, // includes /api/v1
});
```

The root export is server-only. Browser code imports `@commish/sdk/browser` and
uses a publishable key. Verify raw webhook bodies with
`verifyWebhook(body, signatureHeader, signingSecret)` from
`@commish/sdk/webhooks`; its default timestamp tolerance is 300 seconds.

Artifacts contain ESM JavaScript and declarations with no production dependencies
or private Commish imports. Preserve write idempotency keys across retries.

The framework-independent `commish verify --json` command checks a server credential
against its application and program. Set `COMMISH_SECRET_KEY`,
`COMMISH_PUBLISHABLE_KEY`, `COMMISH_APPLICATION_ID`, and `COMMISH_PROGRAM_ID`;
optionally set `COMMISH_API_URL` including `/api/v1`. The existing Next public
environment variable names are accepted as fallbacks. Verification performs one
read, prints no keys, and leaves project files unchanged. Its
`integrationVerified: false` result distinguishes configuration checks from a
completed attributed TEST conversion. Run `commish --help` for available commands.

## Install and configure

Install `@commish/sdk@0.3.0` from npm and keep the consumer lockfile. Next.js
applications can additionally install the matching `@commish/next@0.3.0` package.
No Commish checkout or database credentials are required. This guide describes
0.3.0; check [npm](https://www.npmjs.com/package/@commish/sdk) for published
availability, or use the documentation on your installed version's release tag.

```sh
pnpm add --save-exact @commish/sdk@0.3.0
```

Obtain a mode-matched secret key scoped to the verified application, a publishable
key, program ID and endpoint signing secret from hosted setup. The API URL includes
`/api/v1`; the public-site URL is separate. Use HTTPS for hosted origins. Never
put the secret key or endpoint signing secret in `NEXT_PUBLIC_*`, browser props,
logs or source control. Hosted integrations use `https://app.commish.sh/api/v1`
by default; a custom Commish deployment must support the API operations you use.

## Authorization boundaries

Use your own Commish account and workspace. TEST setup does not require a Commish
founder, platform operator or a maintainer's release-acceptance process.

| Task | Authority and human steps |
| --- | --- |
| Plan setup or inspect command schemas | No account or credential; runs offline. |
| Call integration APIs from your application or CLI | Mode-matched integration key; no browser approval per request. The key's scope and current workspace eligibility still apply. |
| Provision through `commish setup` | Browser sign-in/signup, email verification, authenticator verification and approval of workspace, mode, scopes and proposed business choices. Approved setup authority lasts at most ten minutes. |
| Manage resources through `commish auth login` | Separate browser-approved management grant; integration keys cannot authorize management. Interactive reads last up to one hour and writes up to ten minutes. |
| Run read-only management automation | Explicitly approved read scopes, up to 30 days. It survives sign-out but remains subject to expiry, revocation, account suspension and manager access. |
| Connect Stripe or accept creator terms/Page publication | The relevant account holder completes provider consent or their own participation/publication choice. CLI approval does not make those choices for them. |

Longer-lived management writes are not supported. `--non-interactive` removes
terminal prompts; it does not bypass browser authentication or consent.
`--no-open` lets an agent present the approval link instead of opening it.
Session management grants also require the approving browser session to remain
signed in. [Management authorization](#authorize-management-access) describes
scope selection, status checks and revocation.

Setup and management login store credentials in owner-only, ignored local files.
Keep them out of chat, Git, logs and browser code. Setup currently requires that
private local storage; it does not provision directly into a secret manager.
Management commands can instead receive an existing approved token through
`COMMISH_MANAGEMENT_TOKEN`. Deliver application keys to your deployment using your
normal secret-management workflow.

## Understand verification results

- **Installed:** the package or integration files are present.
- **Configured:** credentials, application and program can be checked. Setup and
  `commish verify` deliberately return `integrationVerified: false`: those checks
  do not observe a purchase.
- **Integration evidence:** exercise a TEST referral and simulated purchase, then
  inspect its conversion, commission and webhook delivery. `commish doctor`
  reports the conditions observed and those still missing; incomplete evidence
  returns exit 2. Refunds, recurring purchases, payouts and LIVE readiness need
  their own checks.

A configured result is useful progress, not an installation failure. Follow its
remaining actions; do not repeat setup solely to make `integrationVerified` true.

## Set up from your repository

Since 0.2.1, `pnpm exec commish setup --plan --json` previews setup first.
Planning reads local configuration and bounded package metadata, reports missing
inputs by field, and identifies framework/package-manager hints. It makes no
network requests, opens no browser, runs no repository scripts and writes no
files. It never reads environment or credential files. Conflicting lockfiles or
linked metadata produce warnings; Next detection still requires an adapter peer
range check. Exit 0 means the supplied configuration is valid, while 2 means it
needs input or correction. Neither outcome verifies an integration or authorizes
the subsequent setup. The JSON lists conditional human actions separately from
the agent's next steps; it does not invent business choices or count unobserved
clicks.

`pnpm exec commish setup` provisions a workspace, application, destination,
application-scoped credential, draft program, terms and optional webhook. It
requires a deployment with the `commish-cli-setup-v2` setup API. Complete browser
authorization once per run; the CLI then performs the approved operations.
Authentication, email verification, authenticator checks, workspace consent and
Stripe's connection flow remain browser steps. No platform-owner access is needed.

First prepare `commish.setup.json` with your business choices. This example is
illustrative: explicitly choose your commission, recurrence, cap and eligible
Stripe products before running it. An empty product list means **all products**.

```json
{
  "version": 1,
  "workspace": { "kind": "new", "name": "Guestbook", "slug": "guestbook" },
  "application": { "name": "Guestbook" },
  "destination": {
    "origin": "https://your-product.example",
    "proofFile": "public/.well-known/commish-verification.txt"
  },
  "program": {
    "name": "Customer referrals",
    "slug": "customer-referrals",
    "category": "SaaS",
    "eligibleStripeProductIds": ["prod_REPLACE_WITH_YOUR_PRODUCT"]
  },
  "terms": {
    "commission": { "type": "percentage", "basisPoints": 1500 },
    "recurrence": { "kind": "first_payment" },
    "perSaleCap": null,
    "disclosureText": "I earn a commission when you purchase through my link."
  },
  "participantConsent": "commish_hosted",
  "webhook": null,
  "stripe": "connect"
}
```

The config contains no credentials and may be committed after reviewing its
business information. `participantConsent: "commish_hosted"` selects the hosted
invitation/acceptance path; setup does not enroll customers or accept terms for
them. Use `webhook: null` to explicitly defer registration, or provide
`{"url":"https://your-product.example/api/commish/events","eventTypes":["commission.payable"]}`.
Choose `stripe: "later"` to defer the provider connection.

```sh
pnpm exec commish setup --json --no-open --non-interactive
```

TEST is the default. LIVE requires explicit `"mode": "live"` in configuration or
`--mode live`, plus the workspace's current eligibility. A browser page displays the same pairing code as the CLI;
check both before approving. New users can sign up and verify email while the
request waits. A pending request lasts up to an hour; approved authority lasts
at most ten minutes. The CLI attempts revocation when the run ends; if cleanup
cannot reach Commish, the grant remains bounded by that expiration. Rerun to authorize again.

Since 0.2.3, setup adds reviewed business choices to that same approval.
It sends the proposed program and terms to the dedicated reviewed-session endpoint
and requires the server to return the identical proposal before authorization can
continue. Commission, recurrence, caps and product eligibility are enforced by
the setup commands after approval. This requires a Commish deployment with the
reviewed-session endpoint (app.commish.sh since 2026-10-06); 0.2.2 and earlier
retain their existing workspace/mode/scope approval.
0.2.3 also opens a focused Stripe connection page for the authorized
workspace and mode. Stripe consent and credentials remain in the browser; the CLI
receives only a fixed internal path and polls readiness. Direct legacy sessions
continue to use the settings handoff unless they explicitly request the setup flow.

Omit `workspace` to discover and select your available workspaces in the approval
page. Specify `--workspace-id wrk_...` for a known workspace, or both
`--workspace-name` and `--workspace-slug` to request creation. An existing
workspace requires current owner/admin permission. Each retry binds to the saved
workspace; it never silently switches to another one.

Use `--config path.json` for another repository-relative configuration file.
Explicit flags override its values: `--application-name`, `--origin`,
`--proof-file`, `--program-json`, `--terms-json`, `--webhook-json`, `--stripe` and
`--participant-consent`. Run `commish setup --help` for all flags. No terminal
prompts are required. Missing choices return `input_required` before network
access. `--non-interactive` still requires browser consent; `--no-open` lets an
agent present handoff links instead of launching the browser automatically.
Use `--app-url` only for a Commish deployment you trust; it receives setup authority.

Publish the generated proof file at the exact URL printed by the CLI, using your
product's normal deployment process. Adjust `proofFile` for your framework's
static directory. The CLI waits up to `--wait 300` seconds for destination or
Stripe completion; `--wait 0` returns immediately after provisioning. This flag
does not shorten the initial authorization wait. Provider actions resume in the
CLI after completion, or on a new authorized run if the wait expires.

Progress and handoff events go to stderr; `--json` produces one final receipt on
stdout. Exit 0 means practical configuration completed, 2 means input or browser
action remains, 1 means a sanitized error, and 130 means interruption. A
`configured` receipt can still list activation, Stripe, LIVE eligibility or TEST
acceptance steps. It always has `integrationVerified: false`. Follow the readiness
actions and complete an attributed TEST conversion before declaring integration
verified. Program activation remains an explicit action in Commish.

Setup stores resumable progress and private mode-specific files under the ignored
`.commish/setup/test` or `.commish/setup/live` directory. `credentials.env` contains
`COMMISH_MODE`, `COMMISH_APPLICATION_ID`, `COMMISH_PROGRAM_ID`,
`COMMISH_PUBLISHABLE_KEY` and `COMMISH_SECRET_KEY`; an optional `webhook.env`
contains the endpoint signing material. Private files have owner-only permissions.
The CLI prints paths, never secret values. Supply them to your existing secret
manager/environment runner; they are not automatically loaded or deployed.

Rerun the **same command and configuration** after interruption or uncertainty.
Completed resource IDs, credential material and webhook identity are reused.
Existing differing files, symlinks, tracked private state and changed setup
configuration fail safely. Preserve the original state when resolving a conflict;
do not delete it to force a retry. Later changes to program economics use the
existing Commish program-management and terms workflow.

## Invite, activate and diagnose

Run on your server; the separate creator follows the returned claim URL and
accepts through Commish's hosted UI. Preserve the logical invitation key for
retries. An invitation is not activation or payout readiness.

```ts
const invitation = await commish.invitations.create(
  { programId: process.env.COMMISH_PROGRAM_ID!, email: "creator@example.com" },
  { idempotencyKey: "pilot-invitation-1" },
);
// Present invitation.data.claimUrl only to the intended creator.
const program = await commish.programs.retrieve(
  process.env.COMMISH_PROGRAM_ID!,
);
// Obtain the membership ID from the signed membership.activated event.
const membership = await commish.memberships.retrieve(
  "mbr_REPLACE_WITH_PUBLIC_ID",
);
console.log(program.data.status, membership.data.status);
```

Workspace-wide delivery diagnostics require a separately provisioned workspace
server credential: choose **Workspace server credential** in Dashboard → Developers
→ API keys. Application integration keys receive `workspace_key_required` (403);
use a separate `Commish` instance with the workspace credential for these reads.

```ts
const workspace = new Commish({
  secretKey: process.env.COMMISH_WORKSPACE_TEST_SECRET_KEY!,
  baseUrl: process.env.COMMISH_API_URL,
});
for await (const delivery of workspace.webhookDeliveries.iterate({
  status: "failed",
})) {
  console.log(delivery.id, delivery.endpointId, delivery.responseStatus);
}
const deliveryPage = await workspace.webhookDeliveries.list({ limit: 50 });
const { data: delivery } =
  await workspace.webhookDeliveries.retrieve("evt_123456789012");
```

The nine-field metadata receipt describes current workspace-owned endpoint
inventory in the key's mode, including disabled endpoint history. It contains no payload, endpoint
URL, error text or money and grants no replay/execution authority. Delivery IDs
identify attempts; they are not guaranteed to be the original event ID on replay.
Application provenance and sealed historical scope are not inferred. A key reads
only deliveries in its own mode. Retrieve returns `{ data }` for the same metadata contract; missing
or foreign delivery IDs return 404. Credentials are revalidated on every request.

Retrieve a related payout's diagnostic status:

```ts
const { data: payout } = await commish.payouts.retrieve("pay_123456789012");
console.log(payout.status, payout.processedAt);
```

The receipt contains only `id`, `mode`, `status` and `processedAt`. It does not
expose consolidated totals, fees or provider/recipient details, and grants no
execution or retry authority. A retained commission allocation must belong to
the current key's workspace and optional application; recruitment-only payouts
without such an allocation return 404. Failed payouts remain readable after a
replacement changes the commission's current payout pointer. A key reads only
payouts in its own mode.

List the current key's memberships, or iterate without hidden retries:

```ts
const page = await commish.memberships.list({ limit: 50 });
for await (const member of commish.memberships.iterate({ limit: 50 })) {
  console.log(member.id, member.status);
}
```

Each page authenticates again and applies the current workspace/application
scope. The API must include the membership collection route before using these
methods. Cursors retain their exact bytes; pages are current reads rather than a
snapshot. Stop iteration to stop fetching. Read methods need no idempotency key.

`membership.data.termsAcceptance` preserves the latest recorded immutable
program term and custom commission offer. Null means no recorded acceptance.
`program.data.terms` is current configuration and may be newer. These are
diagnostic facts; existing transaction-time eligibility checks remain authoritative.
Platform legal acceptance and creator admission are hosted creator responsibilities.

After a Stripe test Checkout, use its PaymentIntent ID (`pi_...`) as the
conversion external ID. Provider processing is asynchronous: use bounded
backoff or signed events before deciding the conversion is absent.

```ts
const found = await commish.conversions.lookup("pi_REPLACE_WITH_TEST_PAYMENT");
if (found.data) {
  const conversion = await commish.conversions.retrieve(found.data.id);
  for await (const refund of commish.conversions.iterateRefunds(
    conversion.data.id,
  )) {
    console.log(refund.id, refund.amount); // integer USD cents
  }
  for await (const earning of commish.conversions.iterateCommissions(
    conversion.data.id,
  )) {
    console.log(earning.id, earning.amount, earning.status, earning.payout);
  }
}
```

For explicit pagination, `listRefunds(id, { limit: 50, cursor })` and
`listCommissions` return `{ data, next_cursor }`. Pass the opaque cursor unchanged
until null; valid limits are 1–100. Pages authenticate separately and observe
current records, not a frozen snapshot. Async iterators fetch sequentially and
stop on errors or repeated cursors. They never retry silently. Cursors must be
1–512 base64url characters (`A-Z`, `a-z`, `0-9`, `_`, `-`), matching the API.
Invalid input is rejected before a request; an invalid continuation rejects the
page before yielding its rows or fetching another page. Cursor contents remain
opaque: the SDK does not decode, normalize or manufacture a continuation.

Lookup returns `{ data: null }` when absent. Detail reads return 404 for absent
or out-of-scope resources. A conversion receipt's `status` describes its
commission, not Stripe payment status; both commission fields are null when
no commission was created. Refund `amount` is positive payment cents;
commission `amount` is signed earnings cents, including separate correction rows.
Do not treat pending/payable/processing as bank-paid. Payout evidence on a
commission is its associated payout ID/status/time, not a payout total.

## Equivalent HTTP

All paths below are relative to the configured `/api/v1` base. OpenAPI 3.1 is
served at `/openapi.json` on the matching Commish public-site deployment.

```sh
curl --fail-with-body -X POST "$COMMISH_API_URL/programs/$COMMISH_PROGRAM_ID/invitations" \
  -H "Authorization: Bearer $COMMISH_SECRET_KEY" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: pilot-invitation-1' \
  --data '{"email":"creator@example.com"}'
curl --fail-with-body "$COMMISH_API_URL/programs/$COMMISH_PROGRAM_ID" \
  -H "Authorization: Bearer $COMMISH_SECRET_KEY"
curl --fail-with-body --get "$COMMISH_API_URL/conversions" \
  -H "Authorization: Bearer $COMMISH_SECRET_KEY" \
  --data-urlencode 'externalId=pi_REPLACE_WITH_TEST_PAYMENT'
curl --fail-with-body "$COMMISH_API_URL/conversions/$COMMISH_CONVERSION_ID/refunds?limit=50" \
  -H "Authorization: Bearer $COMMISH_SECRET_KEY"
```

Provider-neutral writers may identify a customer and report their own sale/refund.
For a Stripe-native purchase, refund through Stripe test mode and let Commish's
provider ingress record it; **do not submit a second direct conversion/refund**.
This direct-write example applies only to a provider-neutral conversion:

```ts
const customer = await commish.customers.identify(
  { externalId: "buyer-42" },
  { idempotencyKey: "identify-buyer-42" },
);
const sale = await commish.conversions.create(
  {
    externalId: "order-42",
    programId: process.env.COMMISH_PROGRAM_ID!,
    customerId: "buyer-42",
    amount: 1000,
    currency: "usd",
    occurredAt: "2026-09-03T12:00:00Z",
    attributionToken: "atr_REPLACE_WITH_CAPTURE_RECEIPT",
  },
  { idempotencyKey: "sale-order-42" },
);
const refund = await commish.refunds.create(
  {
    externalId: "refund-order-42-1",
    conversionId: sale.data.id,
    amount: 250,
    currency: "usd",
    occurredAt: "2026-09-03T13:00:00Z",
  },
  { idempotencyKey: "refund-order-42-1" },
);
void [customer.data.id, refund.data.adjustment];
```

The identify receipt's `cst_` ID is Commish identity; `customerId` on a direct
conversion remains your stable external customer identity. Use actual event
timestamps for new requests and persist them with the request for exact retries.
All writes require `Idempotency-Key`. The SDK returns the HTTP `{ data }` envelope.

## Webhook verification and processing

The envelope is `{ id, type, mode, createdAt, data }`. Payload subject fields are
snake_case: `conversion.created` → `conversion_id`, `conversion.refunded` →
`refund_id`, commission events → `commission_id`, `membership.activated` →
`membership_id`, invitation events → `invitation_id`, and payout events →
`payout_id`. Membership/invitation payloads also carry workspace/mode context.
Treat workspace context as opaque; it is not an API authorization credential.

Copy this verifier into your Node or Next server. Supply a durable inbox callback
that atomically inserts by event `id` (duplicates succeed), then processes effects
asynchronously. Do not use an in-memory set or acknowledge before durable receipt.

```ts
import { verifyWebhook } from "@commish/sdk/webhooks";

type Event = {
  id: string;
  type: string;
  mode: "test" | "live";
  createdAt: string;
  data: Record<string, unknown>;
};
export function webhookHandler(accept: (event: Event) => Promise<void>) {
  return async (request: Request): Promise<Response> => {
    const raw = await request.text();
    if (
      !verifyWebhook(
        raw,
        request.headers.get("commish-signature") ?? "",
        process.env.COMMISH_WEBHOOK_SIGNING_SECRET!,
      )
    )
      return new Response("Invalid signature", { status: 400 });
    let event: Event;
    try {
      event = JSON.parse(raw);
      if (
        !event ||
        typeof event.id !== "string" ||
        !/^evt_[A-Za-z0-9_-]{12,}$/.test(event.id) ||
        (event.mode !== "test" && event.mode !== "live") ||
        typeof event.type !== "string" ||
        typeof event.createdAt !== "string" ||
        !event.data ||
        typeof event.data !== "object" ||
        Array.isArray(event.data)
      )
        return new Response("Invalid event", { status: 400 });
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    try {
      await accept(event);
    } catch {
      return new Response("Inbox unavailable", { status: 503 });
    }
    return new Response(null, { status: 204 });
  };
}
```

Verification uses HMAC-SHA256 of `<timestamp>.<raw-body>` and constant-time
comparison, with 300-second default tolerance. Keep server clocks synchronized;
never parse/re-serialize before verification. A retry has the same event ID and
a fresh signature. Deliveries can repeat or arrive out of order: resolve current
state with `refunds.retrieve`, `commissions.retrieve`, `memberships.retrieve` or
conversion reads. Payout events can refresh your tracked commission histories.
Subscriptions are workspace scoped; a valid event for another application may
resolve to 404 under your application key. Durably record and ignore that event
instead of expanding key permissions.

The delivery worker accepts 2xx; network errors, 408, 425, 429 and 5xx retry up to
ten attempts. Other statuses terminate delivery. The hosted dashboard supports
authorized terminal replay. Test duplicate, stale/tampered signature, temporary
503, terminal response and replay behavior before hosted acceptance.

## Errors, versions and migration

Errors are `{ error: { code, message, request_id } }`. `CommishError` exposes
`status`, `code`, and `requestId` (including the response-header fallback).
Persist request IDs for diagnosis without logging authorization headers.
Retry network/503/429 failures with bounded exponential backoff and jitter, the
same payload and original idempotency key. Exact replay preserves record identity;
409 conflicting reuse requires investigation. Fix 400/401/403/404/422 inputs or
configuration instead of blind retries. A timeout does not prove the write failed.

Pin package versions and retain your lockfile. Use the versioned `/api/v1`
contract; tolerate additive JSON fields and unhandled event types. Never treat
status strings alone as proof that money moved.

Import only public exports: `@commish/sdk` and `@commish/sdk/webhooks` on the
server, and `@commish/sdk/browser` in the browser. Deep `src`/`dist` imports and
private Commish contracts, database or domain modules are not supported.

## Optional creator Pages

Version 0.3.0 adds server-only `commish.pages.resolve({ programId, handle })`.
It returns a versioned page description using an application-scoped key. Pages
require configured brand content and the creator's separate publication choice.
See the [Next Pages guide](https://github.com/oftring-ventures/commish-sdk/blob/v0.3.0/packages/next/guides/pages.md)
for rendering, routing and visitor consent. Existing referral integrations do not
need to adopt Pages; versions before 0.3.0 do not include it.

## Headless operations and agent use

`commish agent --json` is the versioned workflow guide. Discovery works offline:

```sh
commish api list --json
commish api schema createConversion --json
commish manage list --json
commish manage schema programs.activate --json
```

Integration commands use `COMMISH_SECRET_KEY` from your environment and default to
TEST. LIVE reads accept `--mode live` or `COMMISH_MODE=live`; a LIVE write always
requires `--mode live` on the command line, so a loaded `credentials.env` alone
never sends one (`live_mode_flag_required`). Never put keys on the command line.
Examples:

```sh
commish customers list --limit 50 --json
commish conversions lookup merchant-order-123 --json
commish conversions commissions cnv_123456789012 --all --json
commish api getProgram --param programId=prg_123456789012 --json
commish conversions create --body-file conversion.json --idempotency-key order-123 --json
```

`api <operationId>` is a fixed catalog of documented public operations, with
`--param name=value` and `--query name=value`. It does not forward arbitrary URLs
or RPCs. Resource commands cover programs, customers, memberships, conversions,
refunds, commissions, payouts, invitations and webhook deliveries. Browser
attribution capture uses the browser SDK; Pages continue through the Pages SDK.
Existing integration-key boundaries still apply: customer reads are workspace
and mode scoped; webhook metadata requires a workspace key.

Successful commands emit one JSON object on stdout. Errors emit a sanitized
JSON object on stderr with a stable code and, when available, HTTP status,
request ID and `retryAfter` seconds (`busy` and `rate_limited` are retryable). No
mutation retries automatically. Retain each write's exact input
and idempotency identity when resolving uncertainty. `--all` follows at most
100 pages; `--max-pages` can lower that bound. Check `complete` and retain the
returned cursor before considering a list exhaustive. A failed later page
produces an error rather than a partial success receipt.

### Authorize management access

Management uses a separate credential; integration keys cannot authorize it.
Choose exact scopes and either one application or explicit `--workspace-scope`:

```sh
commish auth login --workspace wrk_123456789012 --application app_123456789012 \
  --scopes resources.read,programs.read,terms.read,diagnostics.read \
  --automation --expires-in 86400 --no-open --non-interactive --json
```

The CLI emits an approval URL and pairing code on stderr. A workspace owner or
admin signs in, verifies an authenticator, checks the requested authority and
approves it. The CLI never falls back to dashboard automation. The grant and
its mode remain bound to the request. Write sessions last at most ten minutes;
read sessions at most one hour; explicit read-only automation at most thirty
days. Automation survives sign-out, but expiry, revocation, account suspension
or loss of workspace manager access removes its authority.

The returned `authorizationFile` is owner-only and ignored under `.commish/`.
Pass that path to subsequent commands; do not copy its contents into prompts or
logs. `--wait 0` returns immediately with exit 2 while approval is pending. To
resume, repeat login with `--auth-file <returned-path>` and the same mode.
`auth status` and `auth revoke` use that file too. The approval page also allows
revocation. CI may receive `COMMISH_MANAGEMENT_TOKEN` through its secret manager
instead of a local file; supplying both is rejected.

```sh
commish manage programs.list --auth-file .commish/management/REQUEST/authorization.json --json
commish manage terms.list --program prg_123456789012 --auth-file .commish/management/REQUEST/authorization.json --json
commish doctor --program prg_123456789012 --auth-file .commish/management/REQUEST/authorization.json --json
commish auth revoke --auth-file .commish/management/REQUEST/authorization.json --json
```

`REQUEST` above is a placeholder for the exact path returned by login. Custom
servers may be selected with `--management-url` or `COMMISH_MANAGEMENT_URL`;
they receive the credential, so use only an endpoint you trust. The CLI pins a
stored authorization to its original endpoint and refuses redirects.

### Explicit management writes

Request only the write scopes needed for the task with a fresh interactive
`auth login`. `manage <operation> --body-file reviewed.json` exposes all supported
writes; inspect its schema first. Terms require explicit commission, recurrence,
cap, return window, prohibited claims, disclosure and effective time. Activation
requires the selected term version and expected current status/term version.
Read state first, review the business choices, then submit them unchanged.

`keys create` and `keys rotate` generate and save integration key material
privately before the first request. They return a credential-file path, never
the secret. Keep the same operation identity on retries:

```sh
commish keys create --application app_123456789012 --label 'Merchant server' \
  --idempotency-key merchant-key-1 --auth-file .commish/management/REQUEST/authorization.json --json
commish keys rotate --application app_123456789012 --key key_123456789012 \
  --label 'Merchant server' --idempotency-key merchant-rotation-1 \
  --auth-file .commish/management/REQUEST/authorization.json --json
```

Creation needs `credentials.write`; rotation also needs `credentials.read` to
verify the original key's application. Workspace keys require
`--workspace-scope`. Use `manage credentials.revoke` to revoke a key.

Destination registration returns ownership proof; only successful proof
verification marks it verified. Destinations belong to the application across
TEST/LIVE. Webhook management requires a workspace grant. Creation/rotation
return metadata; `manage webhooks.secret --body-file receipt.json --output-file
.commish/webhook.env` downloads signing material through its separate binary
transport using the original endpoint ID and idempotency key. Webhook replay
requires `webhooks.replay`. Invitations require an explicit expected term
version; participants still accept their own terms. Stripe connection still
requires provider consent in the browser. Existing LIVE eligibility and
financial guards remain in force.

### Diagnose and test

`doctor` requires `diagnostics.read`. It reports readiness and actual linked
conversion, commission and delivery IDs, plus unmet conditions. Exit 2 means a
condition is unmet or not evaluated. Its bounded evidence window covers the
latest ten conversions and twenty related deliveries per conversion. A delivered
webhook shows HTTP acceptance, not correct business processing by its recipient.
`basicFlowObserved` describes this narrow evidence; `integrationVerified` remains
false. LIVE provider readiness, refunds, renewals, settlement and payouts need
separate checks.

```sh
commish test fixture --program prg_123456789012 --json
commish test conversion --body-file reviewed-test-conversion.json --idempotency-key test-order-1 --json
commish test webhook --url http://127.0.0.1:3000/api/commish/webhook --json
```

The fixture command only prints a template under `data`; save and review that
object before submitting it. Add real TEST referral attribution to exercise
commission creation. The conversion command uses the normal manual TEST API.
Never submit a Stripe purchase through both its Stripe integration and the
manual API. Test Stripe purchases through the normal Stripe TEST integration.

The webhook command signs a clearly synthetic TEST event with
`COMMISH_WEBHOOK_SIGNING_SECRET` and sends it only to a literal loopback address.
It creates no stored conversion or delivery and proves only receiver HTTP
acceptance. Remote forwarding and MCP are not included.
