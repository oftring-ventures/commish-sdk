import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSetupProgress } from "../packages/sdk/bin/setup-progress.mjs";
import { provisionSetupCredential, persistSetupWebhookSecret } from "../packages/sdk/bin/setup-secrets.mjs";
const config = { version: 1, application: { name: "Guestbook" }, destination: { origin: "https://guestbook.example", proofFile: "public/.well-known/commish-verification.txt" },
  program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: [] },
  terms: { commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" }, perSaleCap: null, disclosureText: "I earn a commission." },
  participantConsent: "commish_hosted", webhook: null, stripe: "later" };
function fixture(t, mode = "test") {
  const root = mkdtempSync(join(tmpdir(), "commish-secrets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const progress = openSetupProgress(root, { ...config, mode }), calls = [];
  const details = { mode, applicationId: "app_123456789012", programId: "prg_123456789012" };
  const session = { async createCredential(input) {
    calls.push(input);
    return { mode, apiKey: { id: "key_123456789012", applicationId: input.applicationId, publishableKey: input.publishableKey, revokedAt: null } };
  } };
  return { root, progress, calls, details, session };
}
test("uncertain issuance retries the original persisted material and emits metadata only", async t => {
  const f = fixture(t), original = f.session.createCredential;
  f.session.createCredential = async input => { await original(input); throw new Error("service_unavailable"); };
  await assert.rejects(provisionSetupCredential(f.root, f.progress, f.session, f.details), /service_unavailable/);
  const before = readFileSync(join(f.root, f.progress.directory, "credentials.env"), "utf8");
  const secret = before.match(/^COMMISH_SECRET_KEY=(.+)$/m)[1];
  assert.equal(f.calls[0].secretHash, createHash("sha256").update(secret).digest("hex"));
  assert(!JSON.stringify(f.calls).includes(secret));
  f.session.createCredential = original;
  const result = await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  assert.deepEqual(f.calls[0], f.calls[1]); assert(!JSON.stringify(result).includes(secret));
  assert.equal(readFileSync(join(f.root, result.path), "utf8"), before);
  assert.equal(statSync(join(f.root, result.path)).mode & 0o777, 0o600);
  assert.deepEqual(f.progress.read("credential"), { id: result.credentialId });
  rmSync(join(f.root, result.path));
  await assert.rejects(provisionSetupCredential(f.root, f.progress, f.session, f.details), /setup_credential_missing/);
  assert.equal(f.calls.length, 2);
});
test("refuses changed identity or customized credentials without issuing replacements", async t => {
  const f = fixture(t); await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  await assert.rejects(provisionSetupCredential(f.root, f.progress, f.session, { ...f.details, programId: "prg_other1234567" }), /setup_credential_conflict/);
  writeFileSync(join(f.root, f.progress.directory, "credentials.env"), "CUSTOM=preserve\n", { mode: 0o600 });
  await assert.rejects(provisionSetupCredential(f.root, f.progress, f.session, f.details), { message: "setup_credential_conflict" });
  assert.equal(f.calls.length, 1);
  assert.equal(readFileSync(join(f.root, f.progress.directory, "credentials.env"), "utf8"), "CUSTOM=preserve\n");
});
test("LIVE material remains explicitly mode-bound", async t => {
  const f = fixture(t, "live"), result = await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  assert.equal(result.mode, "live"); assert.match(f.calls[0].publishableKey, /^cm_live_pk_/);
  await assert.rejects(provisionSetupCredential(f.root, f.progress, f.session, { ...f.details, mode: "test" }), /invalid_setup_step/);
});
test("writes bound webhook secrets privately and preserves conflicting local configuration", async t => {
  const f = fixture(t), secret = `whsec_${"x".repeat(43)}`, details = { mode: "test", endpointId: "whe_123456789012", input: {} };
  let value = secret;
  const session = { downloadWebhookSecret: async () => value };
  const result = await persistSetupWebhookSecret(f.root, f.progress, session, details);
  assert(!JSON.stringify(result).includes(secret)); assert.equal(statSync(join(f.root, result.path)).mode & 0o777, 0o600);
  await persistSetupWebhookSecret(f.root, f.progress, session, details);
  value = `whsec_${"y".repeat(43)}`;
  await assert.rejects(persistSetupWebhookSecret(f.root, f.progress, session, details), /setup_file_conflict/);
  value = { signingSecret: secret };
  await assert.rejects(persistSetupWebhookSecret(f.root, f.progress, session, details), { message: "invalid_response" });
});
