import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { archiveFiles } from "./verify-public-source.mjs";
import { candidateScopes } from "./public-candidate.mjs";

const repository = "oftring-ventures/commish-sdk";
const hash = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

// Approval digests come from the separately accepted handoff, never from these files themselves.
export function readPublicationCandidate(directory, approved) {
  assert.match(approved.source, /^[a-f0-9]{40}$/);
  for (const key of ["manifestSha256", "ciReceiptSha256"]) assert.match(approved[key], /^[a-f0-9]{64}$/);
  directory = resolve(directory); assert(lstatSync(directory).isDirectory());
  const files = ["manifest.json", "ci-receipt.json", "SHA512SUMS", "commish-sdk-0.1.0-beta.10.tgz", "commish-next-0.1.0-beta.10.tgz"];
  assert.deepEqual(readdirSync(directory).sort(), [...files].sort());
  for (const file of files) assert(lstatSync(join(directory, file)).isFile(), "candidate files must be regular");
  const read = (file) => readFileSync(join(directory, file));
  const manifestBytes = read("manifest.json"), ciBytes = read("ci-receipt.json");
  assert.equal(hash(manifestBytes), approved.manifestSha256, "unapproved candidate manifest");
  assert.equal(hash(ciBytes), approved.ciReceiptSha256, "unapproved CI receipt");
  const manifest = JSON.parse(manifestBytes), ci = JSON.parse(ciBytes);
  assert.equal(manifest.source, approved.source); assert.equal(manifest.status, "local-artifacts-verified");
  assert.equal(manifest.npmPublished, false); assert.equal(manifest.hostedAccepted, false);
  assert.equal(manifest.node, "v24.15.0");
  assert.deepEqual([...manifest.consumerScopes].sort(), [...candidateScopes].sort());
  assert.equal(manifest.artifacts.length, 2);
  for (const [index, item] of manifest.artifacts.entries()) {
    assert.equal(item.name, `@commish/${index ? "next" : "sdk"}`); assert.equal(item.version, "0.1.0-beta.10");
    assert.equal(item.file, files[index + 3]);
    const bytes = read(item.file); assert.equal(bytes.length, item.bytes);
    assert.equal(hash(bytes, "sha512"), item.sha512, "candidate bytes changed");
    assert.equal(`sha512-${hash(bytes, "sha512", "base64")}`, item.integrity);
    const packed = archiveFiles(bytes);
    const members = [...packed].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, member]) =>
      ({ name, bytes: member.data.length, mode: member.mode & 0o777, sha512: hash(member.data, "sha512") }));
    assert.deepEqual(members, item.members, "candidate member inventory changed");
    const metadata = JSON.parse(packed.get("package/package.json").data);
    assert.equal(metadata.name, item.name); assert.equal(metadata.version, item.version);
    assert.equal(metadata.license, "MIT"); assert.equal(metadata.repository.url, `git+https://github.com/${repository}.git`);
    assert.deepEqual(metadata.publishConfig, { access: "public", tag: "beta" });
    for (const key of ["private", "scripts", "dependencies", "devDependencies", "optionalDependencies"])
      assert(!Object.hasOwn(metadata, key), "unexpected publication metadata");
    if (index) assert.equal(metadata.peerDependencies["@commish/sdk"], item.version);
  }
  const artifacts = manifest.artifacts;
  assert.equal(read("SHA512SUMS").toString(), artifacts.map((item) => `${item.sha512}  ${item.file}\n`).join(""));
  assert.equal(ci.repository, repository); assert.equal(ci.source, approved.source);
  assert.equal(ci.manifestSha256, approved.manifestSha256); assert.equal(ci.node, manifest.node);
  assert.deepEqual(ci.runner, { os: "Linux", arch: "X64" }); assert.equal(ci.job, "source");
  assert.equal(ci.npmPublished, false); assert.equal(ci.hostedAccepted, false);
  for (const key of ["runId", "runAttempt"]) assert.match(ci[key], /^[1-9][0-9]*$/);
  assert.deepEqual(ci.artifacts, artifacts.map(({ file, bytes, sha512 }) => ({ file, bytes, sha512 })));
  return { directory, source: approved.source, manifestSha256: approved.manifestSha256,
    ciReceiptSha256: approved.ciReceiptSha256, artifacts, ci };
}

export function requirePublicationApproval(candidate, env) {
  assert.equal(env.GITHUB_ACTIONS, "true"); assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch"); assert.equal(env.GITHUB_JOB, "publish");
  assert.equal(env.RUNNER_OS, "Linux"); assert.equal(env.RUNNER_ARCH, "X64");
  assert.equal(env.COMMISH_NPM_ENVIRONMENT, "npm-publication");
  assert.equal(env.GITHUB_SHA, candidate.source); assert.equal(env.GITHUB_WORKFLOW_SHA, candidate.source);
  assert.equal(env.GITHUB_REF, "refs/tags/v0.1.0-beta.10");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/publish-packages.yml@${env.GITHUB_REF}`);
  for (const [field, name] of [["source", "SOURCE"], ["manifestSha256", "MANIFEST_SHA256"], ["ciReceiptSha256", "CI_RECEIPT_SHA256"]])
    assert.equal(env[`COMMISH_NPM_APPROVED_${name}`], candidate[field], "separate exact-candidate approval required");
  assert.match(env.COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256, /^[a-f0-9]{64}$/, "separate hosted acceptance required");
}

export function isMissingRegistryVersion(result) {
  if (result.status !== 1 || result.signal || result.error) return false;
  const codes = [];
  for (const output of [result.stdout, result.stderr]) {
    try { const code = JSON.parse(output || "{}").error?.code; if (code !== undefined) codes.push(code); }
    catch { /* npm may accompany a structured error with plain-text diagnostics. */ }
  }
  return codes.length > 0 && codes.every((code) => code === "E404");
}

// Pure plan only: the caller must API-verify the accepted run and recheck bytes before executing.
export function publicationPlan(candidate, registryResults, { publish = false, env = {} } = {}) {
  assert.equal(typeof publish, "boolean");
  if (publish) requirePublicationApproval(candidate, env);
  assert.equal(registryResults.length, 2);
  const pending = candidate.artifacts.filter((item, index) => {
    const result = registryResults[index];
    if (result.status === 0 && !result.signal && !result.error) {
      assert.equal(JSON.parse(result.stdout), item.integrity, "registry version has different bytes"); return false;
    }
    assert(isMissingRegistryVersion(result), "registry lookup unavailable; refuse publication"); return true;
  });
  return pending.map((item) => ({ name: item.name, integrity: item.integrity, argv: ["publish", join(candidate.directory, item.file),
    "--ignore-scripts", "--access=public", "--tag=beta", publish ? "--provenance" : "--dry-run", "--registry=https://registry.npmjs.org"] }));
}
