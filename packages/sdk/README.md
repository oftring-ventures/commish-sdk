# @commish/sdk

Commish's test-money pilot SDK for Node 24. This prerelease is distributed as an
exact tarball until npm publication is separately authorized. Source is licensed under the MIT License; see LICENSE.

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
Only test-money pilot behavior is supported; renewal ingress is deferred.

## Install and configure

Install both exact `0.1.0-beta.9` tarballs from the candidate handoff after
checking its `SHA512SUMS`; keep the consumer lockfile. No Commish checkout or
database credentials are required. A tarball is a release candidate, not proof
of npm publication or hosted acceptance.

```sh
pnpm add /absolute/candidate/commish-sdk-0.1.0-beta.9.tgz \
  /absolute/candidate/commish-next-0.1.0-beta.9.tgz
```

Obtain a test secret key scoped to the verified application, a publishable key,
program ID and endpoint signing secret from hosted setup. The API URL includes
`/api/v1`; the public-site URL is separate. Use HTTPS for hosted origins. Never
put the secret key or endpoint signing secret in `NEXT_PUBLIC_*`, browser props,
logs or source control. A deployment must contain the candidate read routes;
installing the package does not deploy Commish.

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

The nine-field metadata receipt describes current workspace-owned test endpoint
inventory, including disabled endpoint history. It contains no payload, endpoint
URL, error text or money and grants no replay/execution authority. Delivery IDs
identify attempts; they are not guaranteed to be the original event ID on replay.
Application provenance and sealed historical scope are not inferred. Live keys
remain denied. Retrieve returns `{ data }` for the same metadata contract; missing
or foreign delivery IDs return 404. Credentials are revalidated on every request.

Retrieve a related test payout's diagnostic status:

```ts
const { data: payout } = await commish.payouts.retrieve("pay_123456789012");
console.log(payout.status, payout.processedAt);
```

The receipt contains only `id`, `mode`, `status` and `processedAt`. It does not
expose consolidated totals, fees or provider/recipient details, and grants no
execution or retry authority. A retained commission allocation must belong to
the current key's workspace and optional application; recruitment-only payouts
without such an allocation return 404. Failed payouts remain readable after a
replacement changes the commission's current payout pointer. Live keys are denied.

List the current key's test memberships, or iterate without hidden retries:

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

Beta.4 contains the customer read methods and invitation ID validation added
since the immutable beta.3 handoff, plus these cursor checks. Install the matching
SDK/Next pair and refresh the consumer lockfile. Existing valid API cursors keep
their meaning; custom fixtures using padded base64 or more than 512 characters
must use the API's base64url envelope. Accepted beta.3 archives remain unchanged.

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
  mode: "test";
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
        event.mode !== "test" ||
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

Pin exact beta versions. This beta uses `/api/v1`; beta changes can break callers
only with a new immutable package version and migration note. Tolerate additive
JSON fields and unhandled event types; never use status strings as payment truth.
No live-money, renewal-invoice ingress or full API catalog is promised.

Migrating from workspace source imports: remove `@commish/contracts`, database
and domain imports; use the SDK's exported types and public HTTP reads. Use ESM
on Node 24. Server imports are `@commish/sdk` and `@commish/sdk/webhooks`; browser
imports are `@commish/sdk/browser`. Deep `src`/`dist` imports are blocked. Beta.2
adds typed diagnostic reads/pagination and rejects unsafe browser capture targets
and invalid webhook freshness settings. Keep SDK and Next on the same beta.

Beta.3 makes release archives reproducible across macOS and Linux. Install the
new exact pair and refresh your lockfile; HTTP and runtime behavior are unchanged.

Beta.5 adds `memberships.list` and `memberships.iterate` with the existing
strict cursor bounds and error propagation. Install the new exact package pair;
beta.4 artifacts remain immutable. Existing detail calls need no changes.

Beta.6 adds `payouts.retrieve` and the exported `PublicPayout` status/time union.
Install the new exact SDK/Next pair; all beta.5 artifacts remain immutable.
Existing calls need no changes. This is local candidate support, not registry
publication or hosted payout acceptance.

Beta.7 adds workspace-only `webhookDeliveries.list` / `iterate` and exported
metadata/options types. Install the exact new package pair; beta.6 artifacts
remain immutable. This grants no replay, application-scoped egress or live access.

Beta.8 adds `webhookDeliveries.retrieve` using the same workspace-only metadata
contract. Install the exact new package pair; beta.7 artifacts remain immutable.
No replay or application-scoped delivery capability is added.

Beta.9 provides MIT-licensed public source and reserved mirror metadata. Runtime
behavior is unchanged. Preserve prior candidates; publication and hosted acceptance
remain separately recorded.
