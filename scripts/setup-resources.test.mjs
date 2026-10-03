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
