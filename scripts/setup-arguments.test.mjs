import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSetupFile } from "../packages/sdk/bin/setup-files.mjs";
import { parseSetupArguments } from "../packages/sdk/bin/setup-arguments.mjs";
const config = { version: 1, application: { name: "Guestbook" }, destination: { origin: "https://guestbook.example", proofFile: "public/.well-known/commish-verification.txt" },
  program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: [] },
  terms: { commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" }, perSaleCap: null, disclosureText: "I earn a commission." },
  participantConsent: "commish_hosted", webhook: null, stripe: "later" };
function root(t) { const path = mkdtempSync(join(tmpdir(), "commish-args-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
test("missing choices produce fixed input requirements without accessing the network", t => {
  const result = parseSetupArguments(root(t), ["--json", "--no-open", "--non-interactive"]);
  assert.equal(result.kind, "input_required"); assert(result.fields.includes("terms"));
  assert.deepEqual(result.options, { appUrl: "https://app.commish.sh", json: true, noOpen: true, nonInteractive: true, waitSeconds: 300 });
});
test("loads non-secret configuration with TEST default and explicit overrides", t => {
  const path = root(t); writeFileSync(join(path, "commish.setup.json"), JSON.stringify(config));
  const parsed = parseSetupArguments(path, []); assert.equal(parsed.kind, "ready"); assert.equal(parsed.config.mode, "test");
  assert.equal(parseSetupArguments(path, ["--mode=live"]).config.mode, "live");
  const selected = parseSetupArguments(path, ["--workspace-id", "wrk_123456789012", "--application-name", "Book", "--wait", "0"]);
  assert.equal(selected.config.workspace.id, "wrk_123456789012"); assert.equal(selected.config.application.name, "Book"); assert.equal(selected.options.waitSeconds, 0);
});
test("accepts a complete agent command using explicit JSON business inputs", t => {
  const parsed = parseSetupArguments(root(t), ["--workspace-name", "Guestbook", "--workspace-slug", "guestbook",
    "--application-name", "Guestbook", "--origin", config.destination.origin, "--proof-file", config.destination.proofFile,
    "--program-json", JSON.stringify(config.program), "--terms-json", JSON.stringify(config.terms), "--webhook-json", "null",
    "--stripe", "later", "--participant-consent", "commish_hosted"]);
  assert.equal(parsed.kind, "ready"); assert.deepEqual(parsed.config.workspace, { kind: "new", name: "Guestbook", slug: "guestbook" });
});
test("rejects duplicate, unknown, ambiguous and secret-bearing arguments without echoing values", t => {
  const path = root(t);
  for (const args of [["--mode", "test", "--mode", "live"], ["--json", "--json"], ["--token", "private-value"], ["extra"],
    ["--wait", "601"], ["--workspace-name", "Only name"], ["--workspace-id", "wrk_123456789012", "--workspace-slug", "guestbook"],
    ["--app-url", "https://user:private-value@app.commish.sh"], ["--program-json", "{private-value"]])
    assert.throws(() => parseSetupArguments(path, args), { message: "invalid_arguments" });
  const parsed = parseSetupArguments(path, ["--terms-json", '{"private-value":"hidden"}']);
  assert.equal(parsed.kind, "invalid_config"); assert(!JSON.stringify(parsed).includes("private-value"));
});
test("help works before file access and explicit missing or linked configuration fails safely", t => {
  const path = root(t);
  assert.equal(parseSetupArguments("/nonexistent", ["--help"]).kind, "help");
  assert.throws(() => parseSetupArguments(path, ["--config", "missing.json"]), /setup_file_missing/);
  symlinkSync("/etc/hosts", join(path, "commish.setup.json"));
  assert.throws(() => parseSetupArguments(path, []), /unsafe_file_path/);
});

test("configuration files share the bounded API capacity without broadening private-file limits", t => {
  const path = root(t), name = "commish.setup.json";
  const large = { ...config, program: { ...config.program, eligibleStripeProductIds: Array.from({ length: 100 }, (_, i) => `prod_${i}_${"a".repeat(700)}`) } };
  writeFileSync(join(path, name), JSON.stringify(large));
  assert(Buffer.byteLength(JSON.stringify(large)) > 65536);
  assert.equal(parseSetupArguments(path, []).kind, "ready");
  assert.throws(() => readSetupFile(path, name), /invalid_setup_file/);
  assert.throws(() => readSetupFile(path, name, { profile: "configuration", privateFile: true }), /invalid_setup_file/);
  writeFileSync(join(path, name), "x".repeat(1_048_577));
  assert.throws(() => parseSetupArguments(path, []), /invalid_setup_file/);
});
