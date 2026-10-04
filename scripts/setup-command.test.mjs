import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSetupCommand } from "../packages/sdk/bin/setup-command.mjs";
const executable = fileURLToPath(new URL("../packages/sdk/bin/init.mjs", import.meta.url));
const config = { version: 1, application: { name: "Guestbook" }, destination: { origin: "https://guestbook.example", proofFile: "public/.well-known/commish-verification.txt" },
  program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: [] },
  terms: { commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" }, perSaleCap: null, disclosureText: "I earn a commission." },
  participantConsent: "commish_hosted", webhook: null, stripe: "later" };
function fixture(t, configured = false) {
  const root = mkdtempSync(join(tmpdir(), "commish-command-")), output = [], notices = [], signals = new EventEmitter();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (configured) writeFileSync(join(root, "commish.setup.json"), JSON.stringify(config));
  return { root, output, notices, signals, options: { root, out: v => output.push(v), diagnostic: v => notices.push(v), signals } };
}
test("the executable reports actionable missing inputs without changing the repository", t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [executable, "setup", "--json", "--no-open", "--non-interactive"], { cwd: f.root, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 2); assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout); assert.equal(body.status, "input_required");
  assert(body.fields.includes("terms")); assert.equal(body.integrationVerified, false);
  assert.deepEqual(readdirSync(f.root), []);
});
test("help is available without configuration and unknown arguments never echo values", async t => {
  const f = fixture(t);
  assert.equal(await runSetupCommand(["--help", "--json"], f.options), 0);
  assert(JSON.parse(f.output.pop()).flags.includes("--no-open"));
  assert.equal(await runSetupCommand(["--token", "private-fixture", "--json"], f.options), 1);
  assert.equal(JSON.parse(f.output.pop()).code, "invalid_arguments");
  assert.equal(f.signals.listenerCount("SIGINT"), 0); assert.equal(f.signals.listenerCount("SIGTERM"), 0);
  assert.deepEqual(readdirSync(f.root), []);
});
test("JSON mode separates pairing notices from its single non-secret final receipt", async t => {
  const f = fixture(t, true);
  const receipt = { status: "configured", mode: "test", credentialsFile: ".commish/setup/test/credentials.env", integrationVerified: false };
  const code = await runSetupCommand(["--json", "--no-open", "--wait", "0"], { ...f.options,
    execute: async (root, input, options, { signal, notify }) => {
      assert.equal(root, f.root); assert.equal(input.mode, "test"); assert.equal(options.noOpen, true); assert.equal(options.waitSeconds, 0);
      assert.equal(signal.aborted, false);
      notify({ status: "authorization_required", approvalUrl: "https://app.commish.sh/cli/setup/pair_123456789012", pairingCode: "ABCD-EFGH" });
      return receipt;
    } });
  assert.equal(code, 0); assert.equal(f.output.length, 1); assert.deepEqual(JSON.parse(f.output[0]), receipt);
  assert.equal(JSON.parse(f.notices[0]).status, "authorization_required");
});
test("human output distinguishes local configuration from verified integration and resumable action", async t => {
  const f = fixture(t, true);
  const result = { status: "action_required", mode: "test", workspaceId: "wrk_123456789012", applicationId: "app_123456789012", programId: "prg_123456789012",
    credentialsFile: ".commish/setup/test/credentials.env", webhookFile: ".commish/setup/test/webhook.env", readiness: { actions: ["connect_stripe"] }, integrationVerified: false };
  assert.equal(await runSetupCommand([], { ...f.options, execute: async () => result }), 2);
  assert.match(f.output[0], /Setup action required \(TEST\)/); assert.match(f.output[0], /connect_stripe/);
  assert.match(f.output[0], /Integration remains unverified/);
});
test("errors and interrupted requests have sanitized output and release signal listeners", async t => {
  const f = fixture(t, true);
  for (const message of ["private-fixture", "setup_file_conflict"]) {
    assert.equal(await runSetupCommand(["--json"], { ...f.options, execute: async () => { throw new Error(message); } }), 1);
    const result = JSON.parse(f.output.pop()); assert.equal(result.code, message === "private-fixture" ? "service_unavailable" : message);
    assert(!JSON.stringify(result).includes("private-fixture"));
  }
  assert.equal(await runSetupCommand(["--json"], { ...f.options, execute: async (_root, _input, _options, { signal }) => {
    f.signals.emit("SIGINT"); assert.equal(signal.aborted, true); throw new Error("private-fixture");
  } }), 130);
  assert.equal(JSON.parse(f.output.pop()).code, "setup_interrupted");
  assert.equal(f.signals.listenerCount("SIGINT"), 0); assert.equal(f.signals.listenerCount("SIGTERM"), 0);
});

test("planning expands missing business decisions without provisioning or writing files", async t => {
  const f = fixture(t);
  const execute = async () => assert.fail("a plan must never authorize or provision");
  assert.equal(await runSetupCommand(["--plan", "--json"], { ...f.options, execute }), 2);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, "plan"); assert.equal(result.networkRequests, false); assert.equal(result.mutations, false);
  assert(result.configuration.missingInputs.some(input => input.field === "terms.recurrence" && input.source === "business_decision"));
  assert(result.configuration.missingInputs.some(input => input.field === "destination.proofFile" && input.source === "repository_or_developer"));
  assert.equal(result.integrationVerified, false); assert.equal(result.mode, null);
  assert.deepEqual(readdirSync(f.root), []); assert.deepEqual(f.notices, []);
});

test("planning reads bounded metadata without echoing scripts, environment contents or business values", async t => {
  const f = fixture(t, true);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.3", dependencies: { next: "16.3.4" }, scripts: { install: "private-fixture" } }));
  writeFileSync(join(f.root, ".env"), "PRIVATE=private-fixture");
  writeFileSync(join(f.root, "pnpm-lock.yaml"), "private-fixture");
  mkdirSync(join(f.root, "src/app"), { recursive: true });
  const before = readdirSync(f.root, { recursive: true });
  assert.equal(await runSetupCommand(["--plan", "--json"], { ...f.options, execute: async () => assert.fail("provisioning invoked") }), 0);
  const output = f.output.pop(), result = JSON.parse(output);
  assert(!output.includes("private-fixture")); assert(!output.includes("I earn a commission"));
  assert.equal(result.repository.framework, "next"); assert.equal(result.repository.packageManager, "pnpm");
  assert.equal(result.repository.adapter, "next_peer_check_required");
  assert.deepEqual(result.repository.appDirectories, ["src/app"]);
  assert.equal(result.configuration.status, "ready"); assert.equal(result.mode, "test");
  assert.deepEqual(readdirSync(f.root, { recursive: true }), before);
  assert.deepEqual(f.notices, []);
});

test("planning reports ambiguity and refuses symlinked metadata without following it", async t => {
  const f = fixture(t, true);
  symlinkSync("/etc/hosts", join(f.root, "package.json"));
  symlinkSync("/etc", join(f.root, "src"));
  writeFileSync(join(f.root, "pnpm-lock.yaml"), ""); writeFileSync(join(f.root, "package-lock.json"), "");
  assert.equal(await runSetupCommand(["--plan", "--json"], f.options), 0);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.repository.packageManager, "unknown");
  assert(result.repository.warnings.includes("conflicting_package_managers"));
  assert(result.repository.warnings.includes("package_manifest_unavailable"));
  assert(result.repository.warnings.includes("framework_directory_unavailable"));
  writeFileSync(join(f.root, "commish.setup.json"), JSON.stringify({ ...config, secret: "private-fixture" }));
  assert.equal(await runSetupCommand(["--plan", "--json"], f.options), 2);
  const invalid = f.output.pop(); assert(!invalid.includes("private-fixture"));
  assert.deepEqual(JSON.parse(invalid).configuration.invalidFields, ["config"]);
});

test("the installed entry point exposes planning before configuration and does not create progress", t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [executable, "setup", "--plan", "--json"], { cwd: f.root, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 2); assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).status, "plan"); assert.deepEqual(readdirSync(f.root), []);
});
