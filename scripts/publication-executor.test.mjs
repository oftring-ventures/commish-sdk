import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { candidateScopes } from "./public-candidate.mjs";
import { executePublication } from "./publication-executor.mjs";

const hash = (data, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(data).digest(encoding);
const source = "a".repeat(40), repository = "oftring-ventures/commish-sdk";
const missing = { status: 1, stdout: '{"error":{"code":"E404"}}' };
const ok = { status: 0, stdout: "" };
function zip(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, bytes] of files) {
    const local = Buffer.alloc(30), entry = Buffer.alloc(46), nameBytes = Buffer.from(name);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, bytes); central.push(entry, nameBytes); offset += 30 + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
function fixture() {
  const files = new Map();
  const artifacts = ["sdk", "next"].map((pkg) => {
    const metadata = { name: `@commish/${pkg}`, version: "0.1.0-beta.10", license: "MIT",
      repository: { url: `git+https://github.com/${repository}.git` }, publishConfig: { access: "public", tag: "beta" },
      ...(pkg === "next" ? { peerDependencies: { "@commish/sdk": "0.1.0-beta.10" } } : {}) };
    const data = Buffer.from(JSON.stringify(metadata)), header = Buffer.alloc(512);
    header.write("package/package.json"); header.write("0000644", 100); header.write(data.length.toString(8).padStart(11, "0"), 124);
    header.write("0", 156); header.fill(32, 148, 156); header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0"), 148);
    const bytes = gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)])); bytes[9] = 255;
    const file = `commish-${pkg}-0.1.0-beta.10.tgz`; files.set(file, bytes);
    return { name: metadata.name, version: metadata.version, file, bytes: bytes.length, sha512: hash(bytes, "sha512"),
      integrity: `sha512-${hash(bytes, "sha512", "base64")}`,
      members: [{ name: "package/package.json", bytes: data.length, mode: 0o644, sha512: hash(data, "sha512") }] };
  });
  const manifest = { source, status: "local-artifacts-verified", npmPublished: false, hostedAccepted: false,
    node: "v24.15.0", consumerScopes: candidateScopes, artifacts };
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  files.set("SHA512SUMS", Buffer.from(artifacts.map((a) => `${a.sha512}  ${a.file}\n`).join("")));
  const ci = { source, repository, job: "source", runId: "42", runAttempt: "1", node: manifest.node,
    runner: { os: "Linux", arch: "X64" }, npmPublished: false, hostedAccepted: false,
    manifestSha256: hash(files.get("manifest.json")), artifacts: artifacts.map(({ file, bytes, sha512 }) => ({ file, bytes, sha512 })) };
  files.set("ci-receipt.json", Buffer.from(JSON.stringify(ci)));
  const archive = zip(files);
  const evidence = { mainHead: source, zip: archive,
    run: { id: 42, run_attempt: 1, head_sha: source, path: ".github/workflows/public-source.yml", status: "completed", conclusion: "success",
      event: "push", repository: { full_name: repository }, head_repository: { full_name: repository } },
    comparison: { status: "identical", merge_base_commit: { sha: source } },
    artifact: { id: 7, name: `public-candidate-${source}-42-1`, expired: false, digest: `sha256:${hash(archive)}`,
      workflow_run: { id: 42, head_sha: source } } };
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_JOB: "publish",
    RUNNER_OS: "Linux", RUNNER_ARCH: "X64", COMMISH_NPM_ENVIRONMENT: "npm-publication", GITHUB_SHA: source, GITHUB_WORKFLOW_SHA: source,
    GITHUB_REF: "refs/tags/v0.1.0-beta.10", GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-packages.yml@refs/tags/v0.1.0-beta.10`,
    COMMISH_NPM_APPROVED_SOURCE: source, COMMISH_NPM_APPROVED_MANIFEST_SHA256: ci.manifestSha256,
    COMMISH_NPM_APPROVED_CI_RECEIPT_SHA256: hash(files.get("ci-receipt.json")), COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256: "b".repeat(64) };
  const calls = [], registry = new Map(); let directory;
  const run = (args) => {
    calls.push(args);
    if (args[0] === "view") return registry.has(args[1]) ? { status: 0, stdout: JSON.stringify(registry.get(args[1])) } : missing;
    directory = dirname(args[1]);
    if (!args.includes("--dry-run")) {
      const item = artifacts.find((a) => args[1].endsWith(a.file)); registry.set(`${item.name}@${item.version}`, item.integrity);
    }
    return ok;
  };
  return { artifacts, evidence, env, calls, registry, directory: () => directory, run,
    options: { runId: "42", artifactId: "7", env }, deps: { evidence: async () => evidence, run } };
}

test("default execution verifies real candidate bytes and dry-runs SDK before Next without publication", async () => {
  const f = fixture(); const receipt = await executePublication(f.options, f.deps);
  assert.equal(receipt.mode, "dry-run"); assert.equal(receipt.registryIntegrityVerified, false);
  assert.deepEqual(f.calls.map((a) => a[0]), ["view", "view", "publish", "publish"]);
  assert(f.calls.slice(2).every((a) => a.includes("--dry-run") && a.includes("--ignore-scripts")));
  assert.equal(f.registry.size, 0); assert(!existsSync(f.directory()));
});

test("publication checks the pair first, uploads in order and reads each exact registry integrity", async () => {
  const f = fixture(); const receipt = await executePublication({ ...f.options, publish: true }, f.deps);
  assert.deepEqual(f.calls.map((a) => a[0]), ["view", "view", "publish", "view", "publish", "view"]);
  assert.deepEqual(receipt.executed, ["@commish/sdk", "@commish/next"]); assert(receipt.registryIntegrityVerified);
  assert(f.calls.filter((a) => a[0] === "publish").every((a) => a.includes("--provenance") && !a.includes("--dry-run")));
  assert(!existsSync(f.directory()));
});

test("unapproved source, artifact and workflow evidence never reach npm", async () => {
  for (const mutate of [
    (f) => { f.env.COMMISH_NPM_APPROVED_SOURCE = "b".repeat(40); },
    (f) => { f.evidence.artifact.expired = true; },
    (f) => { f.evidence.zip[0] ^= 1; },
    (f) => { f.options.artifactId = "8"; },
    (f) => { f.env.GITHUB_REF = "refs/heads/main"; },
    (f) => { delete f.env.COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(executePublication({ ...f.options, publish: true }, f.deps)); assert.equal(f.calls.length, 0);
  }
});

test("identical existing versions resume; mismatch or unavailable lookup stops before uploads", async () => {
  const f = fixture(), sdk = f.artifacts[0]; f.registry.set(`${sdk.name}@${sdk.version}`, sdk.integrity);
  const receipt = await executePublication({ ...f.options, publish: true }, f.deps);
  assert.deepEqual(receipt.skipped, ["@commish/sdk"]); assert.deepEqual(receipt.executed, ["@commish/next"]);
  for (const answer of [{ status: 0, stdout: '"sha512-wrong"' }, { status: 1, stderr: "unavailable" }]) {
    const g = fixture(); let count = 0;
    await assert.rejects(executePublication(g.options, { ...g.deps, run: () => ++count === 1 ? missing : answer }));
    assert.equal(count, 2);
  }
});

test("unknown upload outcomes and bad registry readback stop without retry or second upload", async () => {
  for (const uncertain of [true, false]) {
    const f = fixture();
    const run = (args) => {
      const result = f.run(args);
      if (args[0] === "publish") {
        if (!uncertain) f.registry.clear();
        return uncertain ? { status: null, signal: "SIGTERM" } : result;
      }
      return result;
    };
    await assert.rejects(executePublication({ ...f.options, publish: true }, { ...f.deps, run }));
    assert.equal(f.calls.filter((a) => a[0] === "publish").length, 1); assert(!existsSync(f.directory()));
  }
});

test("candidate tampering between uploads is detected and temporary files are removed", async () => {
  const f = fixture();
  const run = (args) => {
    const result = f.run(args);
    if (args[0] === "publish") writeFileSync(join(f.directory(), f.artifacts[1].file), "changed");
    return result;
  };
  await assert.rejects(executePublication(f.options, { ...f.deps, run }), /candidate bytes changed|strictly equal/);
  assert.equal(f.calls.filter((a) => a[0] === "publish").length, 1); assert(!existsSync(f.directory()));
});
