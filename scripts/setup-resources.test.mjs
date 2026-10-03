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
