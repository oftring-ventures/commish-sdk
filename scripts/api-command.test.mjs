import { createHmac } from "node:crypto";
import { executeTest } from "../packages/sdk/bin/test-command.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { executeApi, runApiCommand, resourceCommands } from "../packages/sdk/bin/api-command.mjs";
import catalog from "../packages/sdk/bin/api-catalog.json" with { type: "json" };
const env = { COMMISH_SECRET_KEY: "cm_test_sk_fixture123456789" };
const response = data => Response.json(data);
const noRequest = () => assert.fail("unexpected network request");
test("operation and schema discovery work offline without credentials", async () => {
  const result = await executeApi(["api", "list", "--json"], { env: {}, fetcher: noRequest });
  assert.equal(Object.keys(result.data).length, 18);
  for (const [name] of Object.values(resourceCommands)) assert(catalog.operations[name]);
  assert((await executeApi(["api", "schema", "createConversion"], { fetcher: noRequest })).data.body.required.includes("externalId"));
});
test("resource aliases and generic API preserve documented paths and queries", async () => {
  const requests = [];
  const fetcher = async (url, init) => { requests.push({ url, init }); return response({ data: null }); };
  await executeApi(["conversions", "lookup", "invoice with/slash", "--json"], { env, fetcher });
  assert.equal(requests[0].url, "https://app.commish.sh/api/v1/conversions?externalId=invoice+with%2Fslash");
  await executeApi(["api", "getProgram", "--param", "programId=prg_123456789012"], { env, fetcher });
  assert.equal(requests[1].url, "https://app.commish.sh/api/v1/programs/prg_123456789012");
  assert.equal(requests[1].init.redirect, "error"); assert.equal(requests[1].init.cache, "no-store");
});
test("LIVE is explicit and secrets, unknown arguments and invalid contexts are rejected before network", async () => {
  const live = { COMMISH_SECRET_KEY: "cm_live_sk_fixture123456789" };
  await assert.rejects(executeApi(["customers", "list"], { env: live, fetcher: noRequest }), /key_mode_mismatch/);
  for (const flags of [["--api-url", "https://evil.example/other"], ["--api-url", "http://remote.example/api/v1"], ["--secret", "private-fixture"], ["--limit", "0"], ["--mode", "test", "--mode", "live"], ["--query", "unknown=x"]])
    await assert.rejects(executeApi(["customers", "list", ...flags], { env, fetcher: noRequest }));
  const result = await executeApi(["customers", "list", "--mode", "live"], { env: live, fetcher: async () => response({ data: [], next_cursor: null }) });
  assert.equal(result.context.mode, "live");
});
test("pagination is bounded, preserves filters and returns a resumable cursor", async () => {
  let calls = 0;
  const fetcher = async url => {
    const query = new URL(url).searchParams;
    assert.equal(query.get("createdAfter"), "2026-01-01T00:00:00Z");
    if (calls) assert.equal(query.get("cursor"), `cursor${calls}`);
    return response({ data: [{ id: ++calls }], next_cursor: `cursor${calls}` });
  };
  const result = await executeApi(["customers", "list", "--created-after", "2026-01-01T00:00:00Z", "--all", "--max-pages", "2"], { env, fetcher });
  assert.equal(calls, 2); assert.equal(result.complete, false); assert.equal(result.next_cursor, "cursor2"); assert.equal(result.data.length, 2);
  await assert.rejects(executeApi(["customers", "list", "--all", "--cursor", "repeated"], { env, fetcher: async () => response({ data: [], next_cursor: "repeated" }) }), /invalid_response/);
});
test("errors on later pages do not emit misleading partial successes or leak provider messages", async () => {
  let calls = 0; const stdout = [], stderr = [];
  const exit = await runApiCommand(["customers", "list", "--all"], { env, out: x => stdout.push(x), diagnostic: x => stderr.push(x),
    fetcher: async () => ++calls === 1 ? response({ data: [{ id: "customer" }], next_cursor: "next" }) : Response.json({ error: { code: "private-fixture", message: env.COMMISH_SECRET_KEY } }, { status: 403 }) });
  assert.equal(exit, 1); assert.deepEqual(stdout, []); assert.equal(JSON.parse(stderr[0]).code, "request_failed");
  assert(!stderr.join().includes("private-fixture")); assert(!stderr.join().includes(env.COMMISH_SECRET_KEY));
});
test("mutations require an explicit file and reusable identity, never retry", async t => {
  const root = mkdtempSync(join(tmpdir(), "commish-api-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(executeApi(["customers", "identify"], { root, env, fetcher: noRequest }), /mutation_input_required/);
  writeFileSync(join(root, "customer.json"), JSON.stringify({ externalId: "example-customer" }));
  let calls = 0;
  await assert.rejects(executeApi(["customers", "identify", "--body-file", "customer.json", "--idempotency-key", "customer-1"], { root, env,
    fetcher: async (_url, init) => { calls++; assert.equal(init.headers["idempotency-key"], "customer-1"); assert.deepEqual(JSON.parse(init.body), { externalId: "example-customer" }); return Response.json({ error: { code: "service_unavailable" } }, { status: 503 }); } }), /service_unavailable/);
  assert.equal(calls, 1);
});
test("invalid response envelopes and oversized bodies fail closed", async () => {
  for (const body of [{}, { data: [], next_cursor: "../x" }, { data: [], next_cursor: "x".repeat(513) }])
    await assert.rejects(executeApi(["customers", "list"], { env, fetcher: async () => response(body) }), /invalid_response/);
  await assert.rejects(executeApi(["customers", "list"], { env, fetcher: async () => new Response("x".repeat(1_048_577)) }), /invalid_response/);
});
test("executable exposes the versioned guide and standard CLI exit behavior", () => {
  const executable = new URL("../packages/sdk/bin/init.mjs", import.meta.url);
  for (const args of [["api", "list", "--json"], ["agent", "--json"], ["customers", "--help", "--json"]]) {
    const result = spawnSync(process.execPath, [executable.pathname, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});

test("TEST helpers forbid LIVE and remote receivers; webhook signatures match the exact body", async () => {
  await assert.rejects(executeTest(["conversion", "--mode", "live"], { env: {}, fetcher: noRequest }), /test_mode_required/);
  await assert.rejects(executeTest(["webhook", "--url", "https://remote.example/hook"], { env: {}, fetcher: noRequest }), /loopback_url_required/);
  const secret = `whsec_${"w".repeat(43)}`;
  const result = await executeTest(["webhook", "--url", "http://127.0.0.1:3000/hook"], { env: { COMMISH_WEBHOOK_SIGNING_SECRET: secret }, fetcher: async (_url, init) => {
    const [timestamp, signature] = init.headers["commish-signature"].split(",").map(part => part.split("=")[1]);
    assert.equal(signature, createHmac("sha256", secret).update(`${timestamp}.${init.body}`).digest("hex"));
    assert.equal(JSON.parse(init.body).mode, "test"); return new Response("do not echo receiver data", { status: 200 });
  } });
  assert.equal(result.synthetic, true); assert.equal(result.integrationVerified, false); assert(!JSON.stringify(result).includes(secret));
});
