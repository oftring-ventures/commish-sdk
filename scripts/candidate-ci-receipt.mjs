import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateScopes } from "./public-candidate.mjs";

const hash = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

// A run receipt binds bytes to reported CI identity; GitHub API verification is still required.
export function writeCiReceipt(directory, env) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_REPOSITORY, "oftring-ventures/commish-sdk");
  assert.equal(env.GITHUB_JOB, "source");
  assert.equal(env.RUNNER_OS, "Linux"); assert.equal(env.RUNNER_ARCH, "X64");
  assert(["push", "pull_request", "merge_group"].includes(env.GITHUB_EVENT_NAME));
  for (const name of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) assert.match(env[name], /^[1-9][0-9]*$/);
  for (const name of ["EXPECTED_SHA", "GITHUB_SHA", "GITHUB_WORKFLOW_SHA"]) assert.match(env[name], /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_WORKFLOW_REF, /^oftring-ventures\/commish-sdk\/\.github\/workflows\/public-source\.yml@refs\/(heads|pull|tags)\/[^\s]+$/);
  assert.equal(lstatSync(directory).isDirectory(), true);
  const bytes = readFileSync(join(directory, "manifest.json")), manifest = JSON.parse(bytes);
  assert.equal(manifest.source, env.EXPECTED_SHA, "candidate source differs from checkout");
  assert.equal(manifest.status, "local-artifacts-verified");
  assert.equal(manifest.npmPublished, false); assert.equal(manifest.hostedAccepted, false);
  assert.equal(manifest.node, "v24.15.0");
  assert.deepEqual([...manifest.consumerScopes].sort(), [...candidateScopes].sort());
  assert.equal(manifest.artifacts.length, 2);
  const artifacts = manifest.artifacts.map((item, index) => {
    const pkg = index ? "next" : "sdk";
    assert.equal(item.name, `@commish/${pkg}`); assert.equal(item.version, "0.1.0-beta.10");
    assert.equal(item.file, `commish-${pkg}-${item.version}.tgz`);
    const archive = readFileSync(join(directory, item.file));
    assert.equal(archive.length, item.bytes);
    assert.equal(hash(archive, "sha512"), item.sha512, "candidate archive hash differs");
    assert.equal(`sha512-${hash(archive, "sha512", "base64")}`, item.integrity);
    return { file: item.file, bytes: item.bytes, sha512: item.sha512 };
  });
  const files = ["manifest.json", "SHA512SUMS", ...artifacts.map((item) => item.file)].sort();
  assert.deepEqual(readdirSync(directory).sort(), files, "unexpected candidate inventory or existing receipt");
  for (const file of files) assert(lstatSync(join(directory, file)).isFile(), "candidate member must be a regular file");
  assert.equal(readFileSync(join(directory, "SHA512SUMS"), "utf8"), artifacts.map((item) => `${item.sha512}  ${item.file}\n`).join(""));
  const receipt = { repository: env.GITHUB_REPOSITORY, source: env.EXPECTED_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF, workflowSha: env.GITHUB_WORKFLOW_SHA, triggerSha: env.GITHUB_SHA,
    event: env.GITHUB_EVENT_NAME, job: env.GITHUB_JOB, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    runner: { os: env.RUNNER_OS, arch: env.RUNNER_ARCH }, node: manifest.node,
    manifestSha256: hash(bytes), artifacts, npmPublished: false, hostedAccepted: false };
  writeFileSync(join(directory, "ci-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "expected one candidate directory");
  writeCiReceipt(process.argv[2], process.env);
}
