import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { executeAuth, runAuthCommand } from "../packages/sdk/bin/auth-command.mjs";
import { managementClient, tokenHash } from "../packages/sdk/bin/management-client.mjs";
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
  for (const args of [["auth", "--help"]]) {
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
