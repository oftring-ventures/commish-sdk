import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  managementClient,
  readManagementAuthorization,
  tokenHash,
} from "../packages/sdk/bin/management-client.mjs";
import {
  proposeSetupOnboarding,
  setupOnboardingScopes,
  storeSetupOnboarding,
} from "../packages/sdk/bin/setup-onboarding.mjs";
import { protectPrivateState } from "../packages/sdk/bin/setup-progress.mjs";

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "commish-onboarding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  protectPrivateState(root);
  return root;
}
const context = { workspaceId: "wrk_123456789012", appUrl: "https://app.commish.sh" };
const grant = (proposal, patch = {}) => ({
  protocol: "commish-management-v1",
  requestId: proposal.request.challengeHash,
  id: `mgt_${proposal.request.challengeHash.slice(0, 24)}`,
  pairingCode:
    `${proposal.request.challengeHash.slice(0, 4)}-${proposal.request.challengeHash.slice(4, 8)}`.toUpperCase(),
  workspaceId: context.workspaceId,
  applicationId: null,
  mode: "test",
  kind: "onboarding",
  scopes: proposal.request.scopes,
  expiresIn: proposal.request.expiresIn,
  status: "authorized",
  requestExpiresAt: "2099-01-01T00:00:00Z",
  expiresAt: "2099-01-02T00:00:00Z",
  ...patch,
});

test("a proposal carries a Test bearer, its hash and the narrow post-setup scopes", () => {
  const proposal = proposeSetupOnboarding();
  assert.match(proposal.token, /^cm_mgmt_test_[A-Za-z0-9_-]{43}$/);
  assert.equal(proposal.request.challengeHash, tokenHash(proposal.token));
  assert.equal(proposal.request.expiresIn, 86400);
  assert.deepEqual(proposal.request.scopes, setupOnboardingScopes);
  for (const scope of ["invitations.write", "credentials.write", "webhooks.write"])
    assert(!proposal.request.scopes.includes(scope));
  assert.notEqual(proposeSetupOnboarding().token, proposal.token);
});

test("the approved grant is stored privately, confirmed with its bearer and usable by management commands", async (t) => {
  const root = directory(t),
    proposal = proposeSetupOnboarding(),
    calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ data: grant(proposal) });
  };
  const receipt = await storeSetupOnboarding(root, proposal, { ...context, fetcher });
  assert.deepEqual(receipt, {
    authorizationFile: `.commish/management/${proposal.request.challengeHash.slice(0, 24)}/authorization.json`,
    scopes: setupOnboardingScopes,
    status: "authorized",
    expiresAt: "2099-01-02T00:00:00Z",
  });
  assert(!JSON.stringify(receipt).includes(proposal.token));
  assert.equal(calls[0].url, "https://app.commish.sh/api/management/v1/grants");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${proposal.token}`);
  assert.equal(statSync(join(root, receipt.authorizationFile)).mode & 0o777, 0o600);
  const stored = readManagementAuthorization(root, receipt.authorizationFile);
  assert.equal(stored.proposal.kind, "onboarding");
  assert.equal(stored.proposal.workspaceId, context.workspaceId);
  assert(readFileSync(join(root, receipt.authorizationFile), "utf8").includes(proposal.token));
  const status = await managementClient({
    root,
    env: {},
    mode: "test",
    authFile: receipt.authorizationFile,
    fetcher,
  }).status();
  assert.equal(status.kind, "onboarding");
});

test("a grant that cannot be confirmed, or comes back widened, is reported and never assumed", async (t) => {
  for (const [respond, status, code] of [
    [
      () => Response.json({ error: { code: "service_unavailable" } }, { status: 503 }),
      "unconfirmed",
      "service_unavailable",
    ],
    [
      (proposal) => Response.json({ data: grant(proposal, { mode: "live" }) }),
      "unconfirmed",
      "invalid_response",
    ],
    [
      (proposal) => Response.json({ data: grant(proposal, { workspaceId: "wrk_other1234567" }) }),
      "unconfirmed",
      "authorization_context_mismatch",
    ],
    [
      (proposal) => Response.json({ data: grant(proposal, { status: "revoked" }) }),
      "revoked",
      undefined,
    ],
  ]) {
    const proposal = proposeSetupOnboarding();
    const receipt = await storeSetupOnboarding(directory(t), proposal, {
      ...context,
      fetcher: async () => respond(proposal),
    });
    assert.equal(receipt.status, status);
    assert.equal(receipt.code, code);
    assert(!JSON.stringify(receipt).includes(proposal.token));
  }
});

test("a grant that cannot be stored safely is reported and setup goes on without it", async (t) => {
  const root = directory(t),
    outside = mkdtempSync(join(tmpdir(), "commish-outside-")),
    proposal = proposeSetupOnboarding();
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(root, ".commish"), { recursive: true });
  symlinkSync(outside, join(root, ".commish/management"));
  let called = false;
  const receipt = await storeSetupOnboarding(root, proposal, {
    ...context,
    fetcher: async () => {
      called = true;
      return Response.json({ data: grant(proposal) });
    },
  });
  assert.equal(receipt.status, "unavailable");
  assert.equal(receipt.authorizationFile, null);
  assert.match(receipt.code, /^[a-z_]+$/);
  assert.equal(called, false);
  assert(!JSON.stringify(receipt).includes(proposal.token));
});

test("an interrupted confirmation names the stored file on its error", async (t) => {
  const controller = new AbortController(),
    proposal = proposeSetupOnboarding();
  const failure = await storeSetupOnboarding(directory(t), proposal, {
    ...context,
    signal: controller.signal,
    fetcher: async () => {
      controller.abort();
      throw new Error("aborted");
    },
  }).catch((error) => error);
  assert.equal(failure.message, "setup_interrupted");
  assert.equal(failure.onboarding.status, "unconfirmed");
  assert.match(failure.onboarding.authorizationFile, /^\.commish\/management\//);
  assert(!JSON.stringify(failure.onboarding).includes(proposal.token));
});
