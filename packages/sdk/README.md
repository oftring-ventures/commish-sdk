# @commish/sdk

Commish's SDK for Node 22 or later connects creator referrals to purchases, commissions and
webhooks. It supports permanent TEST and LIVE environments and includes a CLI for
setup and API operations. The SDK ships ESM JavaScript and TypeScript declarations
with no production dependencies. It is MIT licensed. The CLI runs on macOS, Linux
and WSL; native Windows is not supported because private credential files rely on
POSIX permissions.

```ts
import { Commish } from "@commish/sdk";

const commish = new Commish({
  secretKey: process.env.COMMISH_SECRET_KEY!,
  baseUrl: process.env.COMMISH_API_URL, // includes /api/v1
});
```

The root export is server-only. It needs only `fetch`, so it runs on Node 22 or
later and on edge runtimes (Next.js Edge routes and middleware, Cloudflare
Workers); bundlers never resolve it for browsers. Browser code imports
`@commish/sdk/browser` and uses a publishable key. Verify raw webhook bodies with
`verifyWebhook(body, signatureHeader, signingSecret)` from
`@commish/sdk/webhooks`; its default timestamp tolerance is 300 seconds. The
webhook helpers use `node:crypto`, so they and the `@commish/next` server
helpers run on the Node runtime only.

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

Install `@commish/sdk@0.9.0` from npm and keep the consumer lockfile. Next.js
applications can additionally install the matching `@commish/next@0.9.0` package.
No Commish checkout or database credentials are required. This guide describes
0.9.0; check [npm](https://www.npmjs.com/package/@commish/sdk) for published
availability, or use the documentation on your installed version's release tag.

```sh
pnpm add --save-exact @commish/sdk@0.9.0
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
| Finish installing and testing in Test | An onboarding grant (`commish auth login --onboarding`): Test only, up to one day, approved once with an authenticator check. It writes without the browser session staying signed in, never sends invitations, and ends on expiry, revocation, a password change, account suspension or loss of manager access. |
| Run read-only management automation | Explicitly approved read scopes, up to 30 days. It survives sign-out but remains subject to expiry, revocation, account suspension and manager access. |
| Connect Stripe or accept creator terms/Page publication | The relevant account holder completes provider consent or their own participation/publication choice. CLI approval does not make those choices for them. |

Longer-lived management writes exist only in Test, through an onboarding grant. No command prompts on the
terminal: a missing input fails before any request with an error that names it.
`--non-interactive` states that contract and every command accepts it; it does
not bypass browser authentication or consent.
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

To get the TEST referral link without the dashboard, rehearse the program with
a management grant that holds `programs.write` (the onboarding grant from setup
does):

```sh
commish test rehearsal --program prg_123456789012 \
  --auth-file .commish/management/REQUEST/authorization.json --json
```

It creates the approving owner's or admin's own Test partnership on an active
program and returns `referralUrl`; running it again returns the same
partnership. The owner needs no creator role and no handle: for an owner who is
not a creator, the server prepares a private test profile with a generated
handle. It grants no role, is never public, and is taken over with the handle
they choose if they later become a creator. An owner who already is a creator
rehearses as their own profile; if they have none yet, pass `--handle`.
When a person has to act it exits 2 with `status: "action_required"`:
`creator_handle_required` asks for a handle (a creator without a profile),
`creator_handle_unavailable` asks for another one (it is taken or reserved),
`creator_role_required` names the page where an account with a creator profile
but no creator role adds the role, and `program_not_active` means the offer has
to be activated first. Opening the link and buying in Test remains the proof;
the command only removes the dashboard step.

A configured result is useful progress, not an installation failure. Follow its
remaining actions; do not repeat setup solely to make `integrationVerified` true.

## Set up from your repository

`commish init` prints a setup playbook for coding agents. A bare `commish` prints
the same playbook, so `npx -y commish@latest` works before anything is installed.
It comes from the same local scan as planning (`package.json` and which lockfiles
and app directories exist) and names the install, plan, setup, wiring and verify
commands for your package manager and framework, the business choices to collect
and the milestones to report. It makes no network requests and writes no files;
`--json` returns the commands alongside the Markdown.

`commish agent setup` keeps that guidance where coding agents look for it. It
plans by default and changes files only with `--write`. Run it in the application
directory: a directory without `package.json` is refused as
`application_root_not_found`, so a run in a home directory cannot install a skill
for every project.

- `AGENTS.md` gets a Commish section between `<!-- commish:begin -->` and
  `<!-- commish:end -->`, each alone on its own line. The file is created when
  absent. Only the text between the markers is ever replaced, so a rerun updates
  the section in place and otherwise changes nothing. A file that names a marker
  anywhere else, for example quoted in a sentence, is a conflict.
- `.claude/skills/commish/SKILL.md` gets the playbook's rules, steps and
  references for the installed version. A skill file this command did not write
  is reported as a conflict and left alone.
- `CLAUDE.md` is never edited. When it exists without importing `AGENTS.md`,
  the receipt reports `claudeMd: "agents_md_not_referenced"`; add a line
  `@AGENTS.md` to it so Claude Code loads the section. Only an import outside code that resolves to
  this `AGENTS.md` counts (`@AGENTS.md`, `@./AGENTS.md`, an absolute or `~/` path), as does a `CLAUDE.md` that is a
  link to `AGENTS.md`; naming the file in a sentence does not load it.

Both texts are cut from the `commish init` playbook of the CLI that writes them;
when Creator Pages are installed the section also carries the copyable block of
the [Pages agent guide](https://github.com/oftring-ventures/commish-sdk/blob/v0.9.0/packages/next/guides/agents.md).
Rerun the command with `--write` after upgrading. `--remove` plans, and with
`--write` performs, the removal of the section and the skill; it works in any
directory. An `AGENTS.md` that ended with a line break comes back byte for byte;
one that did not keeps the line break the insertion added, and one left with no
bytes is deleted, so a file that was empty before the install is not restored.
When `CLAUDE.md` imports an `AGENTS.md` that removal deletes, the receipt adds
the next step `remove_agents_md_reference_from_claude_md`. `--json` returns
one receipt listing each file as `create`, `update`, `delete`, `unchanged` or
`absent` (`created`, `updated` and `deleted` once written). The command never
prompts, and `--non-interactive` is accepted. Exit 0 is a plan or a completed
write; 1 is a sanitized error. `agent_guidance_conflict`, with a `reason` per
file, and `application_root_not_found` change no file. Any other error carries
`mutations` and, when a write failed part-way, `files` with what had already
changed (`created`, `updated`, `deleted`) and what was `not_written` or
`not_removed`; the skill is written before `AGENTS.md` and removed after it, and
a rerun finishes the job.

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

`terms.returnWindowDays` is optional: the days a buyer may return a purchase, as
an integer from 0 to 180. Omit it to accept the server default of 30 days; the
CLI sends nothing and never chooses one for you. The final receipt reports the
stored value as `returnWindowDays` (`null` when the server does not name one).
Like every business choice, adding or changing it after setup has started is a
different configuration: resume with the original file.

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

The Stripe connection link is a page for the signed-in workspace owner or admin
and stays valid after the setup session ends. It is announced on stderr as
`browser_action_required`, and a receipt that still waits for Stripe repeats it
as `browserActions: [{ "action": "connect_stripe", "url": "..." }]`, so a caller
that reads output only after the command exits can still pass it on. Once the
owner has connected Stripe, `commish doctor` reports `stripe_connection`; a new
approval is not needed for that step alone.

Progress and handoff events go to stderr, one JSON object per line with
`--json`. Each stage is reported once as it is reached: `authorization_required`,
`authorized`, `provisioned` (resources exist and the credential files are
written), `publish_required`, `browser_action_required`, `destination_verified`
and `stripe_connected`. `waiting` carries the `code` of what is still
outstanding: it repeats while the destination check fails, and
`stripe_not_connected` is reported once while the CLI polls for Stripe. A stage
that was not reached before the wait ended is not reported; the final receipt
says what remains. `--json` produces one final receipt on
stdout. Exit 0 means practical configuration completed, 2 means input or browser
action remains, 1 means a sanitized error, and 130 means interruption. A
`configured` receipt can still list activation, Stripe, LIVE eligibility or TEST
acceptance steps. It always has `integrationVerified: false`. Follow the readiness
actions and complete an attributed TEST conversion before declaring integration
verified. Program activation remains an explicit action in Commish.

Setup stores resumable progress and private mode-specific files under the ignored
`.commish/setup/test` or `.commish/setup/live` directory. `credentials.env` contains
`COMMISH_MODE`, `COMMISH_APPLICATION_ID`, `COMMISH_PROGRAM_ID`,
`COMMISH_PUBLISHABLE_KEY` and `COMMISH_SECRET_KEY`. It then repeats the two
public values as `NEXT_PUBLIC_COMMISH_APPLICATION_ID` and
`NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY` and names the deployment's API in
`COMMISH_API_URL`, so the file holds everything `commish-next` lists as
required and nothing has to be copied between names. A file written by an
earlier version has the first five lines only; setup still reuses it and does
not rewrite it. An optional `webhook.env`
contains the endpoint signing material. Private files have owner-only permissions.
The CLI prints paths, never secret values. Supply them to your existing secret
manager/environment runner; they are not automatically loaded or deployed.

In TEST, the same approval also grants **onboarding access**: a management
grant for the work that outlasts the setup session's ten minutes. The receipt
reports it as `onboarding`, with a private `authorizationFile`, the granted
scopes and its expiry. It lasts up to one day, works in Test only, cannot send
invitations or change credentials, and is shown to the approver on the same
consent page. Use it instead of asking for another approval:

```sh
commish manage destinations.verify --body-file verify.json \
  --auth-file .commish/management/REQUEST/authorization.json --mode test --json
commish manage programs.activate --body-file activate.json \
  --auth-file .commish/management/REQUEST/authorization.json --mode test --json
commish doctor --program prg_123456789012 \
  --auth-file .commish/management/REQUEST/authorization.json --mode test --json
```

`--no-onboarding` declines it. LIVE setup never requests it. A server that does
not support the single approval is provisioned as before and the receipt
reports `"onboarding": null`. Each approved run stores its own grant; revoke one
early with `commish auth revoke --auth-file <path> --mode test`.

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
server credential: choose **Business server credential** in Dashboard → Developers
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
`program.data.terms` is current configuration and may be newer. A term's
`returnWindowDays` is the days a buyer may return a purchase (0 to 180); it is
optional in the type because a term may not report one. These are
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
See the [Next Pages guide](https://github.com/oftring-ventures/commish-sdk/blob/v0.9.0/packages/next/guides/pages.md)
for rendering, routing and visitor consent. Existing referral integrations do not
need to adopt Pages; versions before 0.3.0 do not include it.

## Headless operations and agent use

`commish agent --json` is the versioned workflow guide; `commish init` is the
repository-specific starting point for setup. Discovery works offline:

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
request ID and `retryAfter` seconds. An error caused by an input that was not
supplied lists it in `missing`, in the form it is supplied (for example
`["--program <id>"]`, `["--body-file <path>", "--idempotency-key <identity>"]`
or `["COMMISH_SECRET_KEY"]`); supplied values are never echoed. A write's `--body-file` follows the same
rules as [`manage --body-file`](#explicit-management-writes): a refused file
fails before any request with `code: "invalid_body_file"` and one of the same
fixed `reason` values. Errors from HTTP 429, 502, 503 and 504
responses are marked `retryable`. No mutation retries automatically. Retain each write's exact input
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

Installing an integration usually outlasts a ten-minute write session: the
ownership proof has to be deployed and the first referral rehearsed. For that
work request an onboarding grant instead:

```sh
commish auth login --workspace wrk_123456789012 --workspace-scope --onboarding \
  --scopes resources.read,diagnostics.read,programs.write,terms.write,destinations.write \
  --no-open --non-interactive --json
```

It works in Test only, lasts up to one day (`--expires-in` shortens it) and
cannot hold `invitations.write`. Each command keeps its own verification
policy, so Test credential and webhook changes still need the approving
authenticator check to be under an hour old. Live writes always use a write
session.

The returned `authorizationFile` is owner-only and ignored under `.commish/`.
Pass that path to subsequent commands; do not copy its contents into prompts or
logs. `--wait 0` returns immediately with exit 2 while approval is pending. To
resume, repeat login with `--auth-file <returned-path>` and the same mode; error and
interrupt receipts name that file as `authorizationFile`.
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

`manage destinations.set_primary` makes a verified website of an application
its primary referral destination, the one a creator's link opens. It needs
`destinations.write`, which setup's onboarding access already holds. Take the
website's `org_` id from `manage destinations.list`:

```sh
printf '{"applicationId":"app_123456789012","originId":"org_123456789012"}' > primary.json
commish manage destinations.set_primary --body-file primary.json \
  --auth-file .commish/management/REQUEST/authorization.json --mode test --json
```

Test and Live referral links share the primary destination, so once the
application has a Live program the server asks for a Live credential and
answers `workspace_live_access_required` to a Test one.

`manage products.list` lists the products of the Stripe account connected to
the workspace in the credential's mode, each with its active prices, so the ids
for a program's `eligibleStripeProductIds` need not be asked for. It needs
`resources.read`, which setup's onboarding access already holds, and fails with
`stripe_connection_required` until Stripe is connected in that mode:

```sh
commish manage products.list --limit 20 --all --max-pages 10 \
  --auth-file .commish/management/REQUEST/authorization.json --json
```

A page holds at most 20 products (10 by default) and the server allows ten
`products.list` calls a minute per credential. `--all` on its own therefore
cannot finish a catalog of more than 200 products: the eleventh page fails with
`rate_limited` and, as for any failed later page, the pages already read are
not returned. Keep `--max-pages` at 10 or fewer, counting other `products.list`
calls in the same minute. When `complete` is `false`, wait a minute and continue
with `--cursor <nextCursor>`.

### Explicit management writes

Request only the write scopes needed for the task with a fresh interactive
`auth login`. `manage <operation> --body-file reviewed.json` exposes all supported
writes; inspect its schema first. Terms require explicit commission, recurrence,
cap, return window, prohibited claims, disclosure and effective time. Activation
requires the selected term version and expected current status/term version.
Read state first, review the business choices, then submit them unchanged.

`--body-file` takes a path **relative to the directory the command runs in,
inside the current repository**: no absolute path, no `..` segment and no
symbolic link. A file elsewhere, such as a system temporary directory, is
refused; copy it into the repository first. The file must hold one JSON object
in a regular UTF-8 file of at most 1 MiB. For example, to activate the draft
program that setup created, with its first term version:

```sh
commish manage schema programs.activate --json
cat > activate.json <<'JSON'
{
  "programId": "prg_123456789012",
  "termVersion": 1,
  "expectedCurrentTermVersion": null,
  "expectedCurrentStatus": "draft"
}
JSON
commish manage programs.activate --body-file activate.json \
  --auth-file .commish/management/REQUEST/authorization.json --mode test --json
```

A refused file fails before any request with `code: "invalid_body_file"` and a
fixed `reason` and `guidance`; the path and the file's contents are never echoed:

| `reason` | Meaning |
| --- | --- |
| `path_not_repository_relative` | The path is absolute, leaves the repository or passes through a symbolic link. |
| `file_missing` | No file exists at that relative path. |
| `file_unreadable` | Not a readable regular UTF-8 file of at most 1 MiB. |
| `invalid_json` | The file is not valid JSON. |
| `json_object_required` | The JSON is valid but is not a single object. |

`keys create` and `keys rotate` generate and save integration key material
privately before the first request. They return a credential-file path, never
the secret. An application key's file has the same layout as setup's
`credentials.env` without the program line: it repeats the public values as
`NEXT_PUBLIC_COMMISH_APPLICATION_ID` and `NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY`
and names the deployment's API in `COMMISH_API_URL`, so a rotated key needs no
hand copying. Keep the same operation identity on retries:

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

### See where an install stands

`commish status` reports, for the install in the current directory, each
onboarding step with its status, the evidence that status rests on and the
exact next command or browser action. Use it to resume an install, or to decide
what to ask a person for:

```sh
commish status --json
```

| Step | Met when | Read from |
| --- | --- | --- |
| `configuration` | `commish.setup.json` (or `--config`) is complete, or setup already started from flags. | Local file |
| `setup_approved` | A workspace owner approved setup: `workspace.json` records the workspace. | `.commish/setup/<mode>/` |
| `resources_provisioned` | The application, program and credential are recorded and `credentials.env` is the file setup wrote, plus the webhook endpoint and `webhook.env` when a webhook is configured or recorded. `unknown` when nothing says whether a webhook belongs to the setup. | `.commish/setup/<mode>/` |
| `management_access` | A management grant for this workspace and mode is authorized and includes `diagnostics.read`. | The grant, with its own bearer |
| `destination_verified` | The destination origin is verified (`verified_origin`). | Diagnostics |
| `stripe_connected` | The workspace's Stripe account is connected in this mode (`stripe_connection`). | Diagnostics |
| `eligible_products` | The program has eligible Stripe products (`eligible_products`). | Diagnostics |
| `program_active` | The program is active on an active term version (`program_active`, `active_terms`). | Diagnostics |
| `rehearsal` | An attributed conversion was observed, which proves a referral link existed and was used. | Diagnostics |
| `attributed_test_conversion` | A Test purchase met every activation gate and produced an attributed conversion and a commission. | Diagnostics |
| `webhook_delivery` | A related webhook was delivered; `not_applicable` without an enabled endpoint. | Diagnostics |
| `integration_activated` | The Test integration was activated (`testActivatedAt`, reprinted as an ISO 8601 instant). | Diagnostics |

Each step is `met`, `unmet`, `not_applicable` or `unknown`. `unknown` always
carries a `reason`, and is never a guess:

| `reason` | Meaning |
| --- | --- |
| `setup_config_conflict` | The configuration, mode or app URL is not the setup recorded here; nothing recorded counts for it until the original is restored. |
| `webhook_request_not_recorded` | The recorded resources are complete, but there is neither a complete configuration nor a recorded endpoint to say whether a webhook is still owed. |
| `program_not_provisioned` | Setup has not recorded a program here, so there is nothing to ask about. |
| `management_access_required` | No usable grant; `management_access` names the command that asks for one. |
| `no_read_operation_reports_the_test_partnership` | Nothing reports the rehearsal partnership until a conversion is attributed. `commish test rehearsal` is safe to repeat and returns the same referral link. |
| `not_evaluated_in_live`, `check_not_reported` | Diagnostics did not evaluate that check. Provider readiness is evaluated in Test only. |
| an error code, such as `rate_limited` | The diagnostics read failed with that code. |

`steps[].evidence` names its `source` and the facts read from it: identifiers,
file presence, the grant's state, scopes and expiry, and the diagnostics check
states. `next` is one of:

- `{ "kind": "command", "command": "..." }`, with `before` when something has to
  happen first, `bodyFile` and `body` when the command reads a body file,
  `humanAction` when a person has to approve in the browser, and `followedBy` for the
  action that follows it. A write is only suggested with a grant that can run
  it: when the grant in hand lacks a scope, the command asks for one that has
  it, `requiredScopes` names what was missing and `followedBy` is the write, to run
  with the `authorizationFile` that login returns;
- `{ "kind": "browser", "url": "...", "actor": "workspace_owner_or_admin", "action": "..." }`
  for the steps only a signed-in owner can take: connecting Stripe, choosing
  eligible products and activating the integration;
- `{ "kind": "guidance", "guidance": "..." }` for work in your application, such
  as setting `client_reference_id`, and for a setup that was started from
  flags, whose command only its caller knows.

The top-level `nextStep` and `next` repeat the first step, in order, that
someone can act on. While `rehearsal` is `unknown` that is the rehearsal
command, whose `followedBy` is the Test purchase that makes the step `met`.
The activation body is a template: read the term version with the command in
`before`; the server refuses the write if the program has moved on from the
state setup leaves.

The first three steps read local files only. Management access is checked with
one request, using the grant's own bearer: `--auth-file` or
`COMMISH_MANAGEMENT_TOKEN` when given, otherwise the newest grant stored under
`.commish/management/` for this workspace and mode that includes
`diagnostics.read` (the onboarding grant from setup qualifies). When no grant is
usable, the next command asks for one: an onboarding grant in Test, a
read-only session in LIVE; a stored request that is still pending is resumed,
even when an older grant sits beside it. A grant named with `--auth-file` or
the token that belongs to another workspace than the one setup recorded does
not count: it is reported with `workspace_mismatch`. One diagnostics read then
answers every remaining step, so the evidence window is the one
`commish doctor` describes.

A printed command runs as written, in the environment status ran in and
against the deployment status addressed. It carries `--mode` always and, where
status was given or resolved them, `--config`, `--app-url`, `--management-url`
(from the flag, from `--app-url`, or from the stored grant's own endpoint) and
`--auth-file`. When `COMMISH_MANAGEMENT_TOKEN` is set, a suggested `auth login`
carries `"environment": { "unset": ["COMMISH_MANAGEMENT_TOKEN"] }`, because
`auth login` refuses to start beside a token. A path that is not plain
(letters, digits, `.`, `_`, `-`, `/`) is shown as `<config>` or `<auth-file>`
instead of being quoted. No token or key is ever part of a command. The same
holds for the commands of the later steps: with a token as the grant they name
no file and carry `--management-url` when the command would not find the
endpoint by itself; a command that follows a login names
`<authorizationFile>`, the file that login returns, and carries the same
`environment.unset` because a grant file is refused beside a token; and
`commish test rehearsal` carries `--mode test`, so a shell with
`COMMISH_MODE=live` does not refuse it.

The command changes nothing: it makes two reads and writes no file. The
credential file counts only when it is the one setup wrote: its fields, key
formats, mode and the recorded application and program are checked. No key or
bearer is printed, and server text is never repeated. A setup that was started
from flags has no configuration file to name, so its next action is guidance to
repeat the original command rather than a command. A step is `met` only if
`commish setup`, rerun now with the same inputs, would also treat it as done.
Setup resumes only the setup it recorded, so the configuration, `--mode` and
`--app-url` (pass the one setup was run with) are compared with the recorded
fingerprint, using setup's own function. When they differ, `configuration` is
`unmet` with `setup_config_conflict`, the recorded setup steps are `unknown`
with the same reason rather than `met`, and the action is guidance to restore
the original configuration, never a command that would fail.
`evidence.matchesRecordedSetup` reports the comparison. In the same way, a
recorded key whose `credentials.env` is gone or altered gets guidance to
restore the file (`setup_credential_missing`, `setup_credential_conflict`),
because setup never regenerates it, and an altered `webhook.env` gets guidance
to remove it (`setup_file_conflict`). Setup records the webhook
endpoint last and keeps no note of what was asked for, so
`resources_provisioned` is `met` only when the evidence says whether a webhook
belongs to the setup (`evidence.webhook`): a complete configuration
(`configured` or `not_configured`) or a recorded endpoint (`recorded`). Without
either it is `unknown` with `webhook_request_not_recorded`, never `met`:
restore the configuration file, or repeat the original command, which resumes
and is safe to repeat. A state file that an interrupted setup left
half-published is refused with `unsafe_file_permissions` rather than repaired;
rerun the same `commish setup` command, which repairs it. Text is the default
output; `--json` prints one object with `status` (`complete` or `incomplete`),
`steps`, `nextStep` and `next`. Exit 0 means every step is met or not
applicable, 2 that a step is unmet or unknown and 1 an error. Each mode keeps
its own progress. The mode is the one `commish setup` would use: `--mode`, else
the configuration file's `mode` (Test when it names none), and only without a
configuration file `COMMISH_MODE`, else Test. In LIVE the Test-only steps are
`not_applicable` and provider readiness is `unknown`. A complete status is
recorded progress and observed evidence, not verification:
`integrationVerified` stays false.

### Diagnose and test

`doctor` requires `diagnostics.read`. It reports readiness and actual linked
conversion, commission and delivery IDs, plus unmet conditions. Exit 2 means a
condition is unmet or not evaluated. Its bounded evidence window covers the
latest ten conversions and twenty related deliveries per conversion. A delivered
webhook shows HTTP acceptance, not correct business processing by its recipient.
`basicFlowObserved` describes this narrow evidence; `integrationVerified` remains
false. LIVE provider readiness, refunds, renewals, settlement and payouts need
separate checks.

Reading the report:

- A check that is met carries no `action`; each unmet check names its next step.
- `stable_customer_identity` needs the Checkout session's `client_reference_id`
  to be your own stable customer ID. A purchase without it is still recorded.
- A workspace with no enabled webhook endpoint in the mode reports
  `related_webhook_delivered` as `not_applicable`; it is not an unmet condition.
- A commission with status `unfunded` is recorded and attributed. It waits for
  workspace funding before it can be paid, and is the expected result of a first
  TEST purchase.

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
