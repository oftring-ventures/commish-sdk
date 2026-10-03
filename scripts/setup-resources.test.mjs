import assert from "node:assert/strict";
import test from "node:test";
import { createSetupSession } from "../packages/sdk/bin/setup-session.mjs";
import { createSetupResources } from "../packages/sdk/bin/setup-resources.mjs";

const app = { id: "app_123456789012", name: "Guestbook", createdAt: "2026-10-03T00:00:00Z", verifiedOrigins: [] };
const destination = { id: "org_123456789012", origin: "https://guestbook.example", createdAt: app.createdAt, status: "pending", verifiedAt: null,
  challenge: { path: "/.well-known/commish-verification.txt", value: `cm_verify_org_123456789012.${"a".repeat(43)}` } };
const bound = { workspaceId: "wrk_123456789012", mode: "test", operations: ["application.write", "destination.write"] };
function fixture() {
  const calls = []; let value = { ...bound, replayed: false, application: app, destination, secret: "do not emit" };
  const resources = createSetupResources(async (...args) => { calls.push(args); return value; }, () => bound);
  return { resources, calls, set: (next) => { value = { ...value, ...next }; } };
}
test("requires observed approval and the exact capability before dispatch", async () => {
  for (const [context, message] of [[{ ...bound, workspaceId: undefined }, "authorization_required"], [{ ...bound, operations: [] }, "access_denied"]]) {
    const resources = createSetupResources(() => assert.fail("must not dispatch"), () => context);
    await assert.rejects(resources.createApplication({ name: "Guestbook" }), { message });
  }
});
test("uses fixed routes and reconstructs non-secret application and destination receipts", async () => {
  const f = fixture();
  assert.equal((await f.resources.createApplication({ name: "Guestbook" })).application.id, app.id);
  assert.deepEqual(f.calls[0], ["POST", "/api/cli/setup/applications", { name: "Guestbook" }]);
  const receipt = await f.resources.registerDestination({ applicationId: app.id, origin: "https://Guestbook.example/" });
  assert.equal(receipt.destination.origin, destination.origin); assert.equal(receipt.integrationVerified, false);
  assert(!JSON.stringify(receipt).includes("do not emit"));
  f.set({ destination: { ...destination, status: "verified", verifiedAt: app.createdAt, challenge: null } });
  assert.equal((await f.resources.verifyDestination({ applicationId: app.id, origin: destination.origin })).destination.status, "verified");
  assert.equal(f.calls.at(-1)[0], "PUT");
});
test("rejects caller authority, unsafe origins and altered receipts", async () => {
  const f = fixture();
  await assert.rejects(f.resources.createApplication({ name: "Guestbook", mode: "live" }), /invalid_request/);
  for (const origin of ["http://localhost", "https://user:secret@guestbook.example", "https://guestbook.example/path"])
    await assert.rejects(f.resources.registerDestination({ applicationId: app.id, origin }), /invalid_request/);
  for (const changed of [{ workspaceId: "wrk_abcdefghijkl" }, { mode: "live" }, { application: { ...app, name: "Other" } }]) {
    const f = fixture(); f.set(changed); await assert.rejects(f.resources.createApplication({ name: "Guestbook" }), /invalid_response/);
  }
  await assert.rejects(f.resources.verifyDestination({ applicationId: app.id, origin: destination.origin }), /invalid_response/);
  f.set({ destination: { ...destination, challenge: { ...destination.challenge, value: "wrong" } } });
  await assert.rejects(f.resources.registerDestination({ applicationId: app.id, origin: destination.origin }), /invalid_response/);
});
test("the session sends its in-memory bearer on provisioning POSTs and never in their body", async () => {
  let hash; const calls = [], now = Date.now();
  const session = createSetupSession({ operations: bound.operations }, { fetcher: async (url, options) => {
    calls.push({ url, ...options }); const input = options.body && JSON.parse(options.body);
    let data;
    if (url.endsWith("/setup-sessions") && options.method === "POST") {
      hash = input.challengeHash;
      data = { decision: "pending", mode: "test", operations: bound.operations, workspaceRequest: null,
        pairingCode: `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase(), requestExpiresAt: new Date(now + 3600000).toISOString() };
    } else data = url.endsWith("/applications") ? { ...bound, application: app, replayed: false } :
      { ...bound, status: "authorized", expiresAt: new Date(now + 600000).toISOString() };
    return Response.json({ data: { ...data, protocol: "commish-cli-setup-v2", requestId: hash } });
  } });
  await session.begin(); await session.poll(); const receipt = await session.createApplication({ name: "Guestbook" });
  assert.match(calls[2].headers.authorization, /^Bearer /); assert.equal(calls[2].headers.authorization, calls[1].headers.authorization);
  assert.deepEqual(JSON.parse(calls[2].body), { name: "Guestbook" });
  assert(!JSON.stringify(receipt).includes(calls[2].headers.authorization.slice(7)));
});

const programInput = { applicationId: app.id, name: "Guestbook", slug: "guestbook", description: "", category: "SaaS",
  visibility: "private", joinPolicy: "approval", attributionPolicy: "last_click", eligibleStripeProductIds: ["prod_guestbook"],
  creatorKit: { summary: "", talkingPoints: [], assets: [] } };
const program = { ...programInput, id: "prg_123456789012", mode: "test", status: "draft", activeTermVersion: null, createdAt: app.createdAt, updatedAt: app.createdAt };
const terms = { programId: program.id, version: 1, commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" },
  perSaleCap: null, disclosureText: "I earn a referral commission.", prohibitedClaims: [], effectiveAt: "2026-10-03T00:00:00.123Z" };
function financialFixture() {
  const calls = [], context = { ...bound, operations: ["program.write", "terms.write"] };
  let result = { ...context, program, term: { ...terms, effectiveAt: "2026-10-03T00:00:00.123000Z", createdAt: app.createdAt }, replayed: true };
  return { calls, context, change: (patch) => { result = { ...result, ...patch }; }, resources: createSetupResources(async (...args) => { calls.push(args); return result; }, () => context) };
}
test("program and terms provisioning uses explicit choices and fixed scoped routes", async () => {
  const f = financialFixture();
  assert.equal((await f.resources.createProgram(programInput)).program.id, program.id);
  assert.equal((await f.resources.createTerms(terms)).term.effectiveAt, terms.effectiveAt);
  assert.deepEqual(f.calls.map(c => c.slice(0, 2)), [["POST", "/api/cli/setup/programs"], ["POST", "/api/cli/setup/terms"]]);
  f.context.operations = ["program.write"];
  await assert.rejects(f.resources.createTerms(terms), /access_denied/);
});
test("refuses missing business choices and never broadens caller scope", async () => {
  const f = financialFixture();
  const { eligibleStripeProductIds, ...omitted } = programInput;
  for (const input of [omitted, { ...programInput, workspaceId: bound.workspaceId }, { ...programInput, joinPolicy: "automatic" }])
    await assert.rejects(f.resources.createProgram(input), /invalid_request/);
  for (const input of [{ ...terms, recurrence: undefined }, { ...terms, perSaleCap: undefined },
    { ...terms, commission: { type: "percentage", basisPoints: 10001 } }, { ...terms, commission: { type: "fixed", amount: 100, currency: "eur" } },
    { ...terms, mode: "live" }, { ...terms, effectiveAt: "2026-10-03T00:00:00.123456Z" }])
    await assert.rejects(f.resources.createTerms(input), /invalid_request/);
  assert.equal(f.calls.length, 0);
});
test("rejects changed economics or program bindings and excludes unknown server fields", async () => {
  for (const changed of [{ program: { ...program, mode: "live" } }, { program: { ...program, eligibleStripeProductIds: [] } },
    { program: { ...program, applicationId: "app_abcdefghijkl" } }]) {
    const f = financialFixture(); f.change(changed); await assert.rejects(f.resources.createProgram(programInput), /invalid_response/);
  }
  for (const changed of [{ ...terms, commission: { type: "percentage", basisPoints: 1000 } },
    { ...terms, programId: "prg_abcdefghijkl" }, { ...terms, effectiveAt: "2026-10-03T00:00:00.123001Z" }]) {
    const f = financialFixture(); f.change({ term: { ...changed, createdAt: app.createdAt } }); await assert.rejects(f.resources.createTerms(terms), /invalid_response/);
  }
  const f = financialFixture(); f.change({ program: { ...program, secret: "never output" }, term: { ...terms, createdAt: app.createdAt, secret: "never output" } });
  assert(!JSON.stringify([await f.resources.createProgram(programInput), await f.resources.createTerms(terms)]).includes("never output"));
});

const credential = { applicationId: app.id, label: "Guestbook", publishableKey: "cm_test_pk_guestbook123456",
  secretHash: "b".repeat(64), idempotencyKey: "guestbook-key-1" };
function credentialFixture(mode = "test") {
  const input = { ...credential, publishableKey: `cm_${mode}_pk_guestbook123456` }, calls = [];
  const context = { ...bound, mode, operations: ["credential.write"] };
  let value = { ...context, replayed: true, apiKey: { id: "key_123456789012", ...input, mode,
    revokedAt: null, lastUsedAt: null, createdAt: app.createdAt, secretKey: "never-output-raw-material" } };
  return { input, calls, context, set: patch => { value = { ...value, ...patch }; }, value,
    resources: createSetupResources(async (...args) => { calls.push(args); return value; }, () => context) };
}
test("credential provisioning sends only the locally computed hash and projects safe TEST/LIVE metadata", async () => {
  for (const mode of ["test", "live"]) {
    const f = credentialFixture(mode), receipt = await f.resources.createCredential(f.input);
    assert.deepEqual(f.calls, [["POST", "/api/cli/setup/credentials", f.input]]);
    assert.equal(receipt.mode, mode); assert.equal(receipt.replayed, true);
    assert.equal(receipt.apiKey.id, "key_123456789012");
    assert(!JSON.stringify(receipt).includes(credential.secretHash));
    assert(!JSON.stringify(receipt).includes("never-output-raw-material"));
    assert(!Object.hasOwn(receipt.apiKey, "idempotencyKey"));
  }
});
test("credentials require explicit scope, consent and mode-bound material before a request", async () => {
  const f = credentialFixture();
  for (const input of [{ ...f.input, applicationId: null }, { ...f.input, secretHash: "invalid" },
    { ...f.input, publishableKey: "cm_live_pk_guestbook123456" }, { ...f.input, secretKey: "do-not-send" }])
    await assert.rejects(f.resources.createCredential(input), /invalid_request/);
  f.context.operations = [];
  await assert.rejects(f.resources.createCredential(f.input), /access_denied/);
  assert.equal(f.calls.length, 0);
});
test("credential responses must preserve identity, scope, label, mode and usable material", async () => {
  for (const patch of [{ applicationId: "app_abcdefghijkl" }, { mode: "live" }, { label: "Changed" },
    { publishableKey: "cm_test_pk_changed123456" }, { revokedAt: app.createdAt }, { createdAt: "invalid" }]) {
    const f = credentialFixture(); f.set({ apiKey: { ...f.value.apiKey, ...patch } });
    await assert.rejects(f.resources.createCredential(f.input), /invalid_response/);
  }
});

const hookInput = { url: "https://guestbook.example/hook", eventTypes: ["payout.paid", "commission.payable"], idempotencyKey: "guestbook-hook" };
test("webhook registration projects only exact endpoint metadata and secret download uses a fixed route", async () => {
  const context = { ...bound, operations: ["webhook.write"] }, calls = [];
  const endpoint = { id: "whe_123456789012", mode: "test", url: hookInput.url, eventTypes: [...hookInput.eventTypes].sort(), disabledAt: null, createdAt: app.createdAt };
  let value = { ...context, replayed: true, endpoint: { ...endpoint, signingSecret: "never-in-receipt" }, secretHash: "never-in-receipt" };
  const resources = createSetupResources(async (...args) => { calls.push(args); return value; }, () => context);
  const receipt = await resources.createWebhook(hookInput);
  assert.deepEqual(receipt.endpoint, endpoint); assert.equal(receipt.integrationVerified, false);
  assert(!JSON.stringify(receipt).includes("never-in-receipt"));
  assert.deepEqual(calls[0].slice(0, 2), ["POST", "/api/cli/setup/webhooks"]);
  for (const change of [{ mode: "live" }, { url: "https://other.example/hook" }, { eventTypes: ["payout.paid"] }, { disabledAt: app.createdAt }]) {
    value = { ...context, replayed: true, endpoint: { ...endpoint, ...change } };
    await assert.rejects(resources.createWebhook(hookInput), /invalid_response/);
  }
  context.operations = [];
  await assert.rejects(resources.downloadWebhookSecret(hookInput, endpoint.id), /access_denied/);
  for (const url of ["https:guestbook.example/hook", "https://guestbook.example/hook?token=hidden", "https://127.0.0.1/hook", "https://user:secret@guestbook.example/hook"])
    await assert.rejects(resources.createWebhook({ ...hookInput, url }), /invalid_request/);
});

function readinessFixture(mode = "test") {
  const context = { ...bound, mode, operations: ["readiness.read", "stripe.connect"] }, calls = [];
  const input = { programId: program.id, credentialId: "key_123456789012" };
  const data = { ...context, replayed: true, program: { id: program.id, applicationId: app.id, status: "draft", activeTermVersion: null, availableTermVersion: 1 },
    destinationVerified: true, credentialActive: true, webhookActive: null, stripeConnection: { mode, status: "not_connected" },
    integrationDiagnostics: mode === "test" ? { programId: program.id, mode, status: "blocked", unmetGates: ["attributed_checkout"] } : null,
    liveAccess: mode === "live" ? { workspaceId: bound.workspaceId, effectiveLiveAccess: "disabled" } : null,
    actions: ["connect_stripe"], path: `/dashboard/workspace/${bound.workspaceId}/settings?mode=${mode}`, action: "connect_stripe_in_browser" };
  return { context, data, input, calls, resources: createSetupResources(async (...args) => { calls.push(args); return data; }, () => context) };
}
test("readiness separates TEST evidence from LIVE eligibility and redacts nested extras", async () => {
  for (const mode of ["test", "live"]) {
    const f = readinessFixture(mode); f.data.providerSecret = "do-not-output"; f.data.program.secret = "do-not-output";
    const result = await f.resources.readReadiness(f.input);
    assert.equal(result.integrationVerified, false); assert.equal(result.stripeStatus, "not_connected");
    assert.deepEqual(result.testEvidence, mode === "test" ? { status: "blocked", unmetGates: ["attributed_checkout"] } : null);
    assert.equal(result.liveAccess, mode === "live" ? "disabled" : null);
    assert(!JSON.stringify(result).includes("do-not-output"));
    assert.deepEqual(f.calls[0], ["POST", "/api/cli/setup/readiness", f.input]);
  }
});
test("readiness rejects changed scope, mismatched evidence and fabricated recovery actions", async () => {
  for (const patch of [{ mode: "live" }, { workspaceId: "wrk_abcdefghijkl" }, { webhookActive: false },
    { program: { ...readinessFixture().data.program, id: "prg_abcdefghijkl" } },
    { stripeConnection: { mode: "live", status: "connected" } }, { actions: ["send-private-secret"] },
    { integrationDiagnostics: { programId: program.id, mode: "test", status: "ready", unmetGates: ["attributed_checkout"] } }]) {
    const f = readinessFixture(); Object.assign(f.data, patch);
    await assert.rejects(f.resources.readReadiness(f.input), /invalid_response/);
  }
  const f = readinessFixture(); f.context.operations = [];
  await assert.rejects(f.resources.readReadiness(f.input), /access_denied/);
  await assert.rejects(f.resources.stripeHandoff(), /access_denied/); assert.equal(f.calls.length, 0);
});
test("Stripe handoff contains only the current workspace and mode settings path", async () => {
  for (const mode of ["test", "live"]) {
    const f = readinessFixture(mode);
    assert.equal((await f.resources.stripeHandoff()).path, f.data.path);
    assert.deepEqual(f.calls[0], ["POST", "/api/cli/setup/stripe", undefined]);
    f.data.path = "https://connect.stripe.com/oauth?state=private";
    await assert.rejects(f.resources.stripeHandoff(), /invalid_response/);
  }
});
test("configuration transport accepts the server's bounded large program receipt", async () => {
  const input = { ...programInput, eligibleStripeProductIds: Array.from({ length: 100 }, (_, i) => `prod_${i}_${"a".repeat(700)}`) };
  const now = Date.now(), operations = ["program.write"]; let hash, oversized = false;
  const session = createSetupSession({ operations }, { fetcher: async (url, options) => {
    if (url.endsWith("/programs")) return oversized ? new Response("x".repeat(1_048_577)) : Response.json({ data: {
      protocol: "commish-cli-setup-v2", requestId: hash, ...bound, replayed: false,
      program: { ...program, ...input, eligibleStripeProductIds: [...input.eligibleStripeProductIds].sort() },
    } });
    if (options.method === "POST") {
      hash = JSON.parse(options.body).challengeHash;
      return Response.json({ data: { protocol: "commish-cli-setup-v2", requestId: hash, mode: "test", operations,
        decision: "pending", workspaceRequest: null, requestExpiresAt: new Date(now + 3600000).toISOString(),
        pairingCode: `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase() } });
    }
    return Response.json({ data: { protocol: "commish-cli-setup-v2", requestId: hash, ...bound, operations,
      status: "authorized", expiresAt: new Date(now + 600000).toISOString() } });
  } });
  await session.begin(); await session.poll();
  assert.equal((await session.createProgram(input)).program.eligibleStripeProductIds.length, 100);
  oversized = true; await assert.rejects(session.createProgram(input), /invalid_response/);
});
