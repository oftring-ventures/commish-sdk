import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { executeAuth, runAuthCommand } from "../packages/sdk/bin/auth-command.mjs";
import { managementClient, tokenHash } from "../packages/sdk/bin/management-client.mjs";
import { executeManagement } from "../packages/sdk/bin/management-command.mjs";
import { executeKeys, runKeysCommand } from "../packages/sdk/bin/keys-command.mjs";
import { runDoctorCommand } from "../packages/sdk/bin/doctor-command.mjs";
import { executeTest } from "../packages/sdk/bin/test-command.mjs";
const token = `cm_mgmt_test_${"s".repeat(43)}`;
const env = { COMMISH_MANAGEMENT_TOKEN: token };
const proposal = { challengeHash: tokenHash(token), workspaceId: "wrk_123456789012", applicationId: "app_123456789012",
  mode: "test", kind: "session", scopes: ["credentials.read", "credentials.write"], expiresIn: 600 };
const grantFor = (input, status = "authorized") => ({ protocol: "commish-management-v1", requestId: input.challengeHash,
  id: `mgt_${input.challengeHash.slice(0, 24)}`, pairingCode: `${input.challengeHash.slice(0, 4)}-${input.challengeHash.slice(4, 8)}`.toUpperCase(),
  ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "challengeHash")), status,
  requestExpiresAt: "2099-01-01T00:00:00Z", expiresAt: status === "pending" ? null : "2099-01-01T01:00:00Z" });
const respond = data => Response.json({ data });
const envelope = (operation, result, patch = {}) => respond({ protocol: "commish-management-v1", operation,
  workspaceId: proposal.workspaceId, applicationId: proposal.applicationId, mode: "test", result, ...patch });
const noRequest = () => assert.fail("Unexpected network access");
function directory(t) { const root = mkdtempSync(join(tmpdir(), "commish-headless-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test("new commands and their schemas are discoverable by the installed entry point without network", () => {
  for (const args of [["auth", "--help"], ["manage", "list"], ["manage", "schema", "terms.create"], ["keys", "--help"], ["doctor", "--help"], ["test", "--help"]]) {
    const result = spawnSync(process.execPath, [new URL("../packages/sdk/bin/init.mjs", import.meta.url).pathname, ...args, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});
test("authorization persists privately before begin, sends only the hash, and resumes the same request", async t => {
  const root = directory(t), notices = []; let input, rawToken, calls = 0;
  const fetcher = async (_url, init) => {
    calls++; input = JSON.parse(init.body);
    const file = `.commish/management/${input.challengeHash.slice(0, 24)}/authorization.json`;
    const saved = JSON.parse(readFileSync(join(root, file))); rawToken = saved.token;
    assert.equal(tokenHash(rawToken), input.challengeHash); assert(!init.body.includes(rawToken));
    assert.equal(statSync(join(root, file)).mode & 0o777, 0o600);
    return respond(grantFor(input, "pending"));
  };
  const result = await executeAuth(["login", "--workspace", proposal.workspaceId, "--application", proposal.applicationId,
    "--scopes", "diagnostics.read", "--automation", "--wait", "0"], { root, env: {}, fetcher, notify: value => notices.push(value) });
  assert.equal(result.status, "pending"); assert.equal(notices.length, 1); assert.equal(calls, 1);
  assert(!JSON.stringify([result, notices]).includes(rawToken));
  const resumed = await executeAuth(["login", "--auth-file", result.authorizationFile, "--wait", "0"], { root, env: {}, fetcher });
  assert.equal(resumed.grant.requestId, result.grant.requestId);
  await assert.rejects(executeAuth(["login", "--auth-file", result.authorizationFile, "--management-url", "https://other.example/api/management/v1"], { root, env: {}, fetcher: noRequest }), /authorization_context_mismatch/);
});
test("automation writes, implicit LIVE and app-scoped workspace webhooks fail before network", async t => {
  const root = directory(t);
  for (const args of [["--automation", "--scopes", "credentials.write"], ["--scopes", "webhooks.read"]])
    await assert.rejects(executeAuth(["login", "--workspace", proposal.workspaceId, "--application", proposal.applicationId, ...args], { root, env: {}, fetcher: noRequest }), /invalid_arguments/);
  assert.throws(() => managementClient({ env: { COMMISH_MANAGEMENT_TOKEN: token.replace("_test_", "_live_") } }), /key_mode_mismatch/);
});
test("revoking an already denied request confirms authority is removed", async () => {
  const output = [];
  const code = await runAuthCommand(["revoke"], { env, out: value => output.push(JSON.parse(value)), diagnostic: noRequest,
    fetcher: async (_url, init) => { assert.equal(init.method, "DELETE"); return respond(grantFor(proposal, "denied")); } });
  assert.equal(code, 0); assert.equal(output[0].status, "revoked"); assert.equal(output[0].grant.status, "denied");
});
test("management calls preserve bounded pagination and reject wrong mode or repeated cursors", async () => {
  let calls = 0;
  const result = await executeManagement(["programs.list", "--all", "--max-pages", "2", "--application", proposal.applicationId], { env,
    fetcher: async url => { calls++; assert.equal(new URL(url).searchParams.get("applicationId"), proposal.applicationId); return envelope("programs.list", { items: [{ id: calls }], nextCursor: `cursor${calls}` }); } });
  assert.equal(result.pages, 2); assert.equal(result.complete, false); assert.equal(result.data.length, 2);
  await assert.rejects(executeManagement(["programs.list"], { env, fetcher: async () => envelope("programs.list", { items: [], nextCursor: null }, { mode: "live" }) }), /invalid_response/);
  await assert.rejects(executeManagement(["programs.list", "--all", "--cursor", "same"], { env, fetcher: async () => envelope("programs.list", { items: [], nextCursor: "same" }) }), /invalid_response/);
  await assert.rejects(executeManagement(["programs.activate"], { env, fetcher: noRequest }), /mutation_input_required/);
  await assert.rejects(executeManagement(["programs.list", "--query", "actorId=untrusted"], { env, fetcher: noRequest }), /invalid_arguments/);
});
test("credentials retain exact private material across a lost response; changed business choices never issue another key", async t => {
  const root = directory(t), requests = [], output = [], errors = []; let lost = true;
  const args = ["create", "--application", proposal.applicationId, "--label", "CI key", "--idempotency-key", "fixture-credential-1"];
  const fetcher = async (url, init) => {
    if (url.endsWith("/grants")) return respond(grantFor(proposal));
    const input = JSON.parse(init.body); requests.push(input);
    assert(!init.body.includes("cm_test_sk_"));
    if (lost) { lost = false; throw new Error("untrusted provider detail"); }
    return envelope("credentials.create", { apiKey: { id: "key_123456789012", mode: "test", applicationId: input.applicationId, publishableKey: input.publishableKey, revokedAt: null }, replayed: true });
  };
  assert.equal(await runKeysCommand(args, { root, env, fetcher, out: x => output.push(x), diagnostic: x => errors.push(x) }), 1);
  assert.equal(output.length, 0); assert(!errors.join().includes("untrusted"));
  const result = await executeKeys(args, { root, env, fetcher });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(statSync(join(root, result.credentialFile)).mode & 0o777, 0o600);
  assert(!JSON.stringify(result).includes("cm_test_sk_"));
  const changed = args.map(value => value === "CI key" ? "Different intent" : value);
  await assert.rejects(executeKeys(changed, { root, env, fetcher }), /credential_intent_conflict/);
  assert.equal(requests.length, 2);
});
test("rotation preflights the explicit application context before changing authority", async () => {
  const fetcher = async url => url.endsWith("/grants") ? respond(grantFor(proposal)) : envelope("credentials.list", {
    items: [{ id: "key_123456789012", applicationId: "app_other123456789", mode: "test" }], nextCursor: null });
  await assert.rejects(executeKeys(["rotate", "--application", proposal.applicationId, "--key", "key_123456789012", "--label", "Rotated", "--idempotency-key", "fixture-rotation"], { env, fetcher }), /credential_context_mismatch/);
});
test("webhook signing material uses a bound binary response and a private output file", async t => {
  const root = directory(t), input = { endpointId: "whe_123456789012", idempotencyKey: "fixture-webhook" };
  writeFileSync(join(root, "webhook.json"), JSON.stringify(input));
  const grant = grantFor({ ...proposal, applicationId: null, scopes: ["webhooks.write"] });
  const fetcher = async url => url.endsWith("/grants") ? respond(grant) : new Response(`whsec_${"w".repeat(43)}`, {
    headers: { "content-type": "application/octet-stream", "x-commish-workspace-id": proposal.workspaceId, "x-commish-mode": "test",
      "x-commish-webhook-id": input.endpointId, "x-commish-management-id": grant.id } });
  const args = ["webhooks.secret", "--body-file", "webhook.json"];
  await assert.rejects(executeManagement([...args, "--output-file", "public.env"], { root, env, fetcher: noRequest }), /unsafe_file_path/);
  const result = await executeManagement([...args, "--output-file", ".commish/webhook.env"], { root, env, fetcher });
  assert.equal(statSync(join(root, result.secretFile)).mode & 0o777, 0o600); assert(!JSON.stringify(result).includes("whsec_"));
});
test("doctor preserves unmet conditions and uses a non-success exit for incomplete evidence", async () => {
  const stdout = [];
  const code = await runDoctorCommand(["--program", "prg_123456789012"], { env, out: x => stdout.push(x), fetcher: async () => envelope("diagnostics.get", { report: {
    version: 1, programId: "prg_123456789012", mode: "test", status: "incomplete", integrationVerified: false, unmetConditions: [{ code: "commission_observed" }] } }) });
  assert.equal(code, 2); assert.equal(JSON.parse(stdout[0]).integrationVerified, false);
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
