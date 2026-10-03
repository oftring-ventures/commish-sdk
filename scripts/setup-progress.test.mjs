import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSetupProgress } from "../packages/sdk/bin/setup-progress.mjs";
const config = { version: 1, application: { name: "Guestbook" }, destination: { origin: "https://guestbook.example", proofFile: "public/.well-known/commish-verification.txt" },
  program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: [] },
  terms: { commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" }, perSaleCap: null, disclosureText: "I earn a commission." },
  participantConsent: "commish_hosted", webhook: null, stripe: "later" };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "commish-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
test("resumes immutable identities and idempotency after interruption without retaining authority", t => {
  const root = fixture(t), first = openSetupProgress(root, config), workspace = { id: "wrk_123456789012" };
  first.save("workspace", workspace);
  const next = openSetupProgress(root, { ...config, mode: "test" });
  assert.equal(next.idempotencyKey("credential"), first.idempotencyKey("credential"));
  assert.deepEqual(next.read("workspace"), workspace); assert.equal(next.read("program"), null);
  assert.equal(next.save("workspace", workspace).written, false);
  assert.throws(() => next.save("workspace", { id: "wrk_other1234567" }), /setup_file_conflict/);
  for (const value of [{ ...workspace, secret: "never-persist" }, { id: "never-persist" }])
    assert.throws(() => next.save("workspace", value), /invalid_setup_step/);
  assert.throws(() => next.save("session", { token: "never-persist" }), /invalid_setup_step/);
  assert.equal(statSync(join(root, next.directory, "intent.json")).mode & 0o777, 0o600);
  assert(!readFileSync(join(root, next.directory, "intent.json"), "utf8").includes("never-persist"));
});
test("rejects changed business choices and separates TEST from explicitly selected LIVE", t => {
  const root = fixture(t), first = openSetupProgress(root, config);
  assert.throws(() => openSetupProgress(root, { ...config, terms: { ...config.terms, perSaleCap: { amount: 100, currency: "usd" } } }), /setup_config_conflict/);
  assert.throws(() => openSetupProgress(root, config, { appUrl: "https://another.example" }), /setup_config_conflict/);
  const live = openSetupProgress(root, { ...config, mode: "live" });
  assert.notEqual(first.directory, live.directory);
  assert.notEqual(first.idempotencyKey("credential"), live.idempotencyKey("credential"));
  assert.throws(() => live.idempotencyKey("token"), /invalid_setup_step/);
});
test("protects ignored state in a real repository and refuses already tracked paths", t => {
  const root = fixture(t);
  assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
  const state = openSetupProgress(root, config);
  assert.equal(spawnSync("git", ["check-ignore", "--quiet", `${state.directory}/intent.json`], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["add", "--force", `${state.directory}/intent.json`], { cwd: root }).status, 0);
  assert.throws(() => openSetupProgress(root, config), /setup_state_tracked/);
});
test("rejects corrupt journal entries and preserves customized ignore files", t => {
  const root = fixture(t), state = openSetupProgress(root, config);
  writeFileSync(join(root, state.directory, "workspace.json"), '{"token":"never-echo"}', { mode: 0o600 });
  assert.throws(() => state.read("workspace"), { message: "invalid_setup_progress" });
  writeFileSync(join(root, ".commish/.gitignore"), "custom\n");
  assert.throws(() => openSetupProgress(root, config), { message: "setup_file_conflict" });
  assert.equal(readFileSync(join(root, ".commish/.gitignore"), "utf8"), "custom\n");
});
