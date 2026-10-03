import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSetupSession } from "../packages/sdk/bin/setup-session.mjs";

function fixture(input = { operations: ["workspace.read"] }) {
  const calls = [], now = Date.now(); let hash, alter = (value) => value, error;
  const session = createSetupSession(input, { now: () => now, fetcher: async (url, options) => {
    calls.push({ url, ...options });
    if (error) throw new Error(error);
    const body = options.body && JSON.parse(options.body);
    if (body) hash = body.challengeHash;
    else assert.equal(createHash("sha256").update(options.headers.authorization.slice(7)).digest("hex"), hash);
    const common = { protocol: "commish-cli-setup-v2", requestId: hash };
    const value = options.method === "POST" ? { ...common, mode: body.mode, operations: body.operations,
      workspaceRequest: body.workspaceRequest ?? null, decision: "pending",
      pairingCode: `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase(), requestExpiresAt: new Date(now + 3600000).toISOString() }
      : options.method === "DELETE" ? { ...common, status: "revoked" }
      : { ...common, status: "authorized", mode: input.mode ?? "test", operations: input.operations,
        workspaceId: "wrk_123456789012", expiresAt: new Date(now + 600000).toISOString() };
    return Response.json({ data: alter(value) });
  } });
  return { session, calls, change: (fn) => { alter = fn; }, fail: () => { error = "private provider credential"; } };
}

test("pairs using a public hash while retaining bearer authority only in memory", async () => {
  const { session, calls } = fixture();
  const pending = await session.begin();
  assert.equal(pending.mode, "test");
  assert.match(pending.pairingCode, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(pending.approvalUrl, `https://app.commish.sh/cli/authorize/${pending.requestId}`);
  const approved = await session.poll();
  assert.equal(approved.workspaceId, "wrk_123456789012");
  assert.equal((await session.revoke()).status, "revoked");
  assert.equal(JSON.stringify(session), "{}");
  const secret = calls[1].headers.authorization.slice(7);
  assert(!JSON.stringify([pending, approved, calls.map(({ url }) => url)]).includes(secret));
  assert.equal(calls[0].headers.authorization, undefined);
  assert(calls.every((call) => call.redirect === "error" && call.cache === "no-store"));
});
test("retains exact immutable choices across begin retries and input mutation", async () => {
  const input = { mode: "live", operations: ["workspace.read"], workspaceRequest: { kind: "new", name: "Guestbook", slug: "guestbook" } };
  const { session, calls, change } = fixture(input);
  input.workspaceRequest.name = "Changed";
  change((value) => ({ ...value, workspaceRequest: { slug: "guestbook", name: "Guestbook", kind: "new" } }));
  const first = await session.begin(), second = await session.begin();
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.mode, "live");
  assert.equal(calls[0].body, calls[1].body);
});
test("rejects unsafe origins, duplicate scope and invalid business choices before sending", () => {
  for (const appUrl of ["http://app.commish.sh", "https://user:secret@app.commish.sh", "https://app.commish.sh/api", "https://app.commish.sh/?secret=x"])
    assert.throws(() => createSetupSession({ operations: ["workspace.read"] }, { appUrl }), /invalid_app_url/);
  for (const input of [{ operations: [] }, { operations: ["workspace.read", "workspace.read"] },
    { operations: ["arbitrary.rpc"] }, { operations: ["workspace.read"], secret: "hidden" },
    { operations: ["workspace.read"], workspaceRequest: { kind: "new", name: "Book", slug: "a".repeat(49) } }])
    assert.throws(() => createSetupSession(input), /invalid_request/);
});
test("rejects altered pairing, scopes, mode, request, workspace and deadlines", async () => {
  for (const changes of [{ pairingCode: "0000-0000" }, { operations: ["credential.write"] }, { mode: "live" },
    { requestId: "a".repeat(64) }, { workspaceRequest: { kind: "existing", id: "wrk_123456789012" } },
    { requestExpiresAt: "2099-01-01T00:00:00Z" }]) {
    const { session, change } = fixture(); change((value) => ({ ...value, ...changes }));
    await assert.rejects(session.begin(), /invalid_response/);
  }
  const { session, change } = fixture(); await session.begin(); await session.poll();
  change((value) => ({ ...value, workspaceId: "wrk_abcdefghijkl" }));
  await assert.rejects(session.poll(), /invalid_response/);
});
test("redacts provider failures and only returns explicitly selected receipt fields", async () => {
  const { session, change, fail } = fixture();
  change((value) => ({ ...value, secret: "private provider credential" }));
  assert(!JSON.stringify(await session.begin()).includes("private provider"));
  assert(!JSON.stringify(await session.poll()).includes("private provider"));
  fail(); await assert.rejects(session.poll(), { message: "service_unavailable" });
});
test("rejects another workspace for explicit existing consent", async () => {
  const { session } = fixture({ operations: ["workspace.read"], workspaceRequest: { kind: "existing", id: "wrk_abcdefghijkl" } });
  await session.begin(); await assert.rejects(session.poll(), /invalid_response/);
});
test("bounds response bodies and accepts only known server error codes", async () => {
  for (const [response, message] of [
    [new Response("x".repeat(65537)), "invalid_response"],
    [new Response("{broken"), "invalid_response"],
    [Response.json({ error: { code: "rate_limited", message: "private detail" } }, { status: 429 }), "rate_limited"],
    [Response.json({ error: { code: "private detail" } }, { status: 500 }), "service_unavailable"],
  ]) {
    const session = createSetupSession({ operations: ["workspace.read"] }, { fetcher: async () => response });
    await assert.rejects(session.begin(), { message });
  }
});

async function webhookDownloadFixture(alter = response => response) {
  const now = Date.now(), calls = [], workspaceId = "wrk_123456789012", endpointId = "whe_123456789012";
  const signingSecret = `whsec_${"z".repeat(43)}`, input = { url: "https://guestbook.example/hook", eventTypes: ["commission.payable"], idempotencyKey: "guestbook-hook" };
  let hash;
  const session = createSetupSession({ operations: ["webhook.write"] }, { fetcher: async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith("/secret")) return alter(new Response(signingSecret, { headers: {
      "content-type": "application/octet-stream", "x-commish-setup-request-id": hash,
      "x-commish-workspace-id": workspaceId, "x-commish-mode": "test", "x-commish-webhook-id": endpointId,
    } }));
    let data;
    if (options.method === "POST") {
      hash = JSON.parse(options.body).challengeHash;
      data = { decision: "pending", mode: "test", operations: ["webhook.write"], workspaceRequest: null,
        pairingCode: `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase(), requestExpiresAt: new Date(now + 3600000).toISOString() };
    } else data = { status: "authorized", workspaceId, mode: "test", operations: ["webhook.write"], expiresAt: new Date(now + 600000).toISOString() };
    return Response.json({ data: { ...data, protocol: "commish-cli-setup-v2", requestId: hash } });
  } });
  await assert.rejects(session.downloadWebhookSecret(input, endpointId), /authorization_required/);
  await session.begin(); await session.poll();
  return { calls, session, input, endpointId, signingSecret };
}
test("downloads signing material only through a bound authenticated binary response", async () => {
  const f = await webhookDownloadFixture();
  assert.equal(await f.session.downloadWebhookSecret(f.input, f.endpointId), f.signingSecret);
  const sent = f.calls.at(-1);
  assert.equal(sent.headers.authorization, f.calls[1].headers.authorization);
  assert.equal(sent.redirect, "error"); assert.deepEqual(JSON.parse(sent.body), f.input);
  assert(!JSON.stringify(f.calls.map(c => [c.url, c.body])).includes(f.signingSecret));
  assert.equal(JSON.stringify(f.session), "{}");
});
test("rejects crossed secret bindings, JSON secrets, invalid encoding and oversized transfers without echoing bytes", async () => {
  for (const [name, value] of [["x-commish-setup-request-id", "wrong"], ["x-commish-workspace-id", "wrk_other123456"],
    ["x-commish-mode", "live"], ["x-commish-webhook-id", "whe_other123456"], ["content-type", "application/json"]]) {
    const f = await webhookDownloadFixture(r => { r.headers.set(name, value); return r; });
    await assert.rejects(f.session.downloadWebhookSecret(f.input, f.endpointId), { message: "invalid_response" });
  }
  for (const bytes of ["whsec_" + "a".repeat(513), "private bad body", new Uint8Array([0xff])]) {
    const f = await webhookDownloadFixture(r => new Response(bytes, { headers: r.headers }));
    await assert.rejects(f.session.downloadWebhookSecret(f.input, f.endpointId), { message: "invalid_response" });
  }
  const f = await webhookDownloadFixture(() => Response.json({ error: { code: "setup_expired", message: "private detail" } }, { status: 410 }));
  await assert.rejects(f.session.downloadWebhookSecret(f.input, f.endpointId), { message: "setup_expired" });
});

test("does not conflate multiple scopes with one comma-containing operation", async () => {
  const { session, change } = fixture({ operations: ["application.write", "workspace.read"] });
  change((value) => ({ ...value, operations: ["application.write,workspace.read"] }));
  await assert.rejects(session.begin(), { message: "invalid_response" });
  change((value) => value); await session.begin();
  change((value) => ({ ...value, operations: ["application.write,workspace.read"] }));
  await assert.rejects(session.poll(), { message: "invalid_response" });
});
