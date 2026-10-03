import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSetupProgress } from "../packages/sdk/bin/setup-progress.mjs";
import { provisionSetup } from "../packages/sdk/bin/setup-provisioning.mjs";
const config = { version: 1, application: { name: "Guestbook" }, destination: { origin: "https://guestbook.example", proofFile: "public/.well-known/commish-verification.txt" },
  program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: [] },
  terms: { commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" }, perSaleCap: null, disclosureText: "I earn a commission." },
  participantConsent: "commish_hosted", webhook: { url: "https://guestbook.example/hooks", eventTypes: ["commission.payable"] }, stripe: "later" };
const authorization = { status: "authorized", mode: "test", workspaceId: "wrk_123456789012" };
const applicationId = "app_123456789012", programId = "prg_123456789012";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "commish-provision-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = []; let failKeyOnce = false, failProof = false;
  const track = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
  const session = {
    createApplication: track("application", () => ({ application: { id: applicationId } })),
    registerDestination: track("destination", () => ({ destination: { status: "pending", challenge: { value: "public-origin-proof" } } })),
    verifyDestination: track("verify", () => { if (failProof) throw new Error("challenge_mismatch"); return {}; }),
    createProgram: track("program", () => ({ program: { id: programId } })),
    createTerms: track("terms", input => ({ term: { ...input, effectiveAt: "2026-10-03T10:00:00.123456Z" } })),
    createCredential: track("credential", input => {
      if (failKeyOnce) { failKeyOnce = false; throw new Error("service_unavailable"); }
      return { mode: "test", apiKey: { id: "key_123456789012", applicationId, publishableKey: input.publishableKey, revokedAt: null } };
    }),
    createWebhook: track("webhook", () => ({ endpoint: { id: "whe_123456789012" } })),
    downloadWebhookSecret: track("secret", () => `whsec_${"z".repeat(43)}`),
    readReadiness: track("readiness", () => ({ program: { id: programId, applicationId }, stripeStatus: "not_connected", actions: ["connect_stripe"], integrationVerified: false })),
  };
  const progress = () => openSetupProgress(root, config);
  return { root, calls, session, progress, uncertain: () => { failKeyOnce = true; }, unpublished: () => { failProof = true; } };
}
test("resumes after uncertain issuance with identical material and without recreating saved resources", async t => {
  const f = fixture(t); f.uncertain();
  await assert.rejects(provisionSetup(f.root, config, f.progress(), f.session, authorization), /service_unavailable/);
  const before = readFileSync(join(f.root, ".commish/setup/test/credentials.env"), "utf8");
  const result = await provisionSetup(f.root, config, f.progress(), f.session, authorization);
  assert.equal(f.calls.filter(c => c.name === "application").length, 1); assert.equal(f.calls.filter(c => c.name === "program").length, 1);
  const keys = f.calls.filter(c => c.name === "credential"); assert.deepEqual(keys[0].args, keys[1].args);
  assert.equal(readFileSync(join(f.root, result.credentialsFile), "utf8"), before);
  assert.equal(result.integrationVerified, false); assert.equal(result.effectiveAt, "2026-10-03T10:00:00.123456Z");
  assert(!JSON.stringify(result).includes("cm_test_sk_")); assert(!JSON.stringify(result).includes("whsec_"));
  assert(f.calls.filter(c => c.name === "terms").every(c => !Object.hasOwn(c.args[0], "effectiveAt")));
});
test("completes practical configuration while reporting a publishable proof action", async t => {
  const f = fixture(t); f.unpublished();
  const result = await provisionSetup(f.root, config, f.progress(), f.session, authorization);
  assert.deepEqual(result.proof, { path: config.destination.proofFile, url: "https://guestbook.example/.well-known/commish-verification.txt", code: "challenge_mismatch" });
  assert.equal(readFileSync(join(f.root, config.destination.proofFile), "utf8"), "public-origin-proof\n");
  assert.equal(result.termVersion, 1); assert.equal(f.calls.at(-1).name, "readiness");
});
test("rejects wrong workspace or mode before resource requests", async t => {
  const f = fixture(t), progress = f.progress(); progress.save("workspace", { id: "wrk_abcdefghijkl" });
  await assert.rejects(provisionSetup(f.root, config, progress, f.session, authorization), /setup_file_conflict/);
  await assert.rejects(provisionSetup(f.root, config, progress, f.session, { ...authorization, mode: "live" }), /authorization_required/);
  assert.equal(f.calls.length, 0);
});
test("refuses a resumed program moved to another application", async t => {
  const f = fixture(t);
  f.progress().save("application", { id: applicationId }); f.progress().save("program", { id: programId });
  f.session.readReadiness = async () => ({ program: { applicationId: "app_abcdefghijkl" } });
  await assert.rejects(provisionSetup(f.root, config, f.progress(), f.session, authorization), /setup_config_conflict/);
  assert.equal(f.calls.filter(c => ["terms", "credential", "webhook"].includes(c.name)).length, 0);
});
