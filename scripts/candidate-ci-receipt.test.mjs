import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateScopes } from "./public-candidate.mjs";
import { writeCiReceipt } from "./candidate-ci-receipt.mjs";

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "commish-ci-receipt-")), source = "a".repeat(40);
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "oftring-ventures/commish-sdk", GITHUB_JOB: "source",
    RUNNER_OS: "Linux", RUNNER_ARCH: "X64", GITHUB_EVENT_NAME: "pull_request", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    EXPECTED_SHA: source, GITHUB_SHA: "b".repeat(40), GITHUB_WORKFLOW_SHA: "c".repeat(40),
    GITHUB_WORKFLOW_REF: "oftring-ventures/commish-sdk/.github/workflows/public-source.yml@refs/pull/35/merge" };
  const manifest = { source, status: "local-artifacts-verified", npmPublished: false, hostedAccepted: false,
    node: "v24.15.0", consumerScopes: candidateScopes, artifacts: ["sdk", "next"].map((pkg) => {
      const archive = Buffer.from(`${pkg} already verified archive`), digest = createHash("sha512").update(archive).digest();
      const file = `commish-${pkg}-0.1.0-beta.10.tgz`; writeFileSync(join(directory, file), archive);
      return { name: `@commish/${pkg}`, version: "0.1.0-beta.10", file, bytes: archive.length,
        sha512: digest.toString("hex"), integrity: `sha512-${digest.toString("base64")}` };
    }) };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "SHA512SUMS"), manifest.artifacts.map((item) => `${item.sha512}  ${item.file}\n`).join(""));
  try { run(directory, env, manifest); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("CI receipt distinguishes actual source, trigger and workflow and preserves candidate bytes", () => fixture((directory, env, manifest) => {
  const before = readFileSync(join(directory, "manifest.json")), receipt = writeCiReceipt(directory, env);
  assert.equal(receipt.source, manifest.source); assert.equal(receipt.triggerSha, env.GITHUB_SHA);
  assert.equal(receipt.workflowSha, env.GITHUB_WORKFLOW_SHA); assert.equal(receipt.runId, "123");
  assert.equal(receipt.manifestSha256, createHash("sha256").update(before).digest("hex"));
  assert.equal(receipt.npmPublished, false); assert.equal(receipt.hostedAccepted, false);
  assert.deepEqual(readFileSync(join(directory, "manifest.json")), before);
  const saved = readFileSync(join(directory, "ci-receipt.json"));
  assert.throws(() => writeCiReceipt(directory, env), /existing receipt/);
  assert.deepEqual(readFileSync(join(directory, "ci-receipt.json")), saved);
}));

test("CI identity, source and incomplete consumer evidence fail before a receipt is written", () => fixture((directory, env, manifest) => {
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: "false", GITHUB_REPOSITORY: "other/repo", GITHUB_JOB: "publish",
    RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "0",
    GITHUB_RUN_ATTEMPT: "-1", EXPECTED_SHA: "d".repeat(40), GITHUB_SHA: "bad", GITHUB_WORKFLOW_SHA: "bad",
    GITHUB_WORKFLOW_REF: "oftring-ventures/commish-sdk/.github/workflows/publish-packages.yml@refs/heads/main" }))
    assert.throws(() => writeCiReceipt(directory, { ...env, [key]: value }));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...manifest, consumerScopes: candidateScopes.slice(1) }));
  assert.throws(() => writeCiReceipt(directory, env)); assert(!existsSync(join(directory, "ci-receipt.json")));
}));

test("CI receipt rejects changed bytes, checksums, extra files and symlinked candidates", () => {
  for (const change of [
    (dir, m) => writeFileSync(join(dir, m.artifacts[0].file), "changed"),
    (dir) => writeFileSync(join(dir, "SHA512SUMS"), "changed"),
    (dir) => writeFileSync(join(dir, "extra"), "extra"),
    (dir, m) => { const file = join(dir, m.artifacts[0].file); rmSync(file); symlinkSync("manifest.json", file); },
  ]) fixture((directory, env, manifest) => {
    change(directory, manifest); assert.throws(() => writeCiReceipt(directory, env));
    assert(!existsSync(join(directory, "ci-receipt.json")));
  });
});

test("CI receipts retain existing branch, tag and merge-queue push coverage", () => {
  for (const [event, ref] of [["push", "heads/topic"], ["push", "tags/v0.1.0-beta.10"],
    ["merge_group", "heads/gh-readonly-queue/main/pr-35"]]) fixture((directory, env) => {
      const workflowRef = `oftring-ventures/commish-sdk/.github/workflows/public-source.yml@refs/${ref}`;
      const receipt = writeCiReceipt(directory, { ...env, GITHUB_EVENT_NAME: event, GITHUB_WORKFLOW_REF: workflowRef });
      assert.equal(receipt.event, event); assert.equal(receipt.workflowRef, workflowRef);
      assert.equal(receipt.npmPublished, false);
    });
});
