import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { candidateScopes } from "./public-candidate.mjs";
import { executePublication, registryVisibility, stopDiagnostic } from "./publication-executor.mjs";

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
    const metadata = { name: `@commish/${pkg}`, version: "0.2.2", license: "MIT",
      repository: { url: `git+https://github.com/${repository}.git` }, publishConfig: { access: "public", tag: "latest" },
      ...(pkg === "next" ? { peerDependencies: { "@commish/sdk": "0.2.2" } } : {}) };
    const data = Buffer.from(JSON.stringify(metadata)), header = Buffer.alloc(512);
    header.write("package/package.json"); header.write("0000644", 100); header.write(data.length.toString(8).padStart(11, "0"), 124);
    header.write("0", 156); header.fill(32, 148, 156); header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0"), 148);
    const bytes = gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)])); bytes[9] = 255;
    const file = `commish-${pkg}-0.2.2.tgz`; files.set(file, bytes);
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
    GITHUB_REF: "refs/tags/v0.2.2", GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-packages.yml@refs/tags/v0.2.2`,
    COMMISH_NPM_APPROVED_SOURCE: source, COMMISH_NPM_APPROVED_MANIFEST_SHA256: ci.manifestSha256,
    COMMISH_NPM_APPROVED_CI_RECEIPT_SHA256: hash(files.get("ci-receipt.json")), COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256: "b".repeat(64) };
  const calls = [], registry = new Map(), scanning = new Map(), clock = { now: 0, sleeps: [] }, notices = [];
  let directory;
  const f = { hide: 0, lookupMs: 0 };
  const run = (args) => {
    calls.push(args);
    if (args[0] === "view") {
      clock.now += f.lookupMs;
      // npm's publish-time scan answers E404 for a version it has already accepted.
      if (scanning.get(args[1]) > 0) { scanning.set(args[1], scanning.get(args[1]) - 1); return missing; }
      return registry.has(args[1]) ? { status: 0, stdout: JSON.stringify(registry.get(args[1])) } : missing;
    }
    directory = dirname(args[1]);
    if (!args.includes("--dry-run")) {
      const item = artifacts.find((a) => args[1].endsWith(a.file)), key = `${item.name}@${item.version}`;
      registry.set(key, item.integrity); scanning.set(key, f.hide);
    }
    return ok;
  };
  // A real wait sleeps at most 2 * 60 times; a runaway poll fails here instead of hanging the suite.
  const sleep = async (ms) => { assert(clock.sleeps.push(ms) <= 1_000, "runaway registry poll"); clock.now += ms; };
  return Object.assign(f, { artifacts, evidence, env, calls, registry, clock, notices, directory: () => directory, run,
    options: { runId: "42", artifactId: "7", env },
    deps: { evidence: async () => evidence, run, sleep, now: () => clock.now, notify: (message) => notices.push(message) } });
}
const kinds = (calls) => calls.map((a) => a[0]);
const uploads = (calls) => calls.filter((a) => a[0] === "publish");

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
  assert.deepEqual(f.clock.sleeps, []); assert.deepEqual(f.notices, []); assert(!existsSync(f.directory()));
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

test("a confirmed upload polls through scan-time E404 until its exact integrity is visible", async () => {
  const maxWaits = registryVisibility.timeoutMs / registryVisibility.intervalMs;
  for (const hide of [3, maxWaits]) {
    const f = fixture(); f.hide = hide;
    const receipt = await executePublication({ ...f.options, publish: true }, f.deps);
    const readbacks = Array(hide + 1).fill("view");
    assert.deepEqual(kinds(f.calls), ["view", "view", "publish", ...readbacks, "publish", ...readbacks]);
    assert.deepEqual(uploads(f.calls).map((a) => a[1].split("/").pop()), f.artifacts.map((a) => a.file));
    assert.deepEqual(receipt.executed, ["@commish/sdk", "@commish/next"]); assert(receipt.registryIntegrityVerified);
    assert.deepEqual(f.clock.sleeps, Array(2 * hide).fill(registryVisibility.intervalMs));
    assert.deepEqual(f.notices, f.artifacts.map((a) => `${a.name}@${a.version} is not visible yet; waiting for npm's publish-time scan.`));
    assert(!existsSync(f.directory()));
  }
});

test("different integrity, other lookup failures and the deadline stop polling before the second upload", async () => {
  const answers = [{ status: 0, stdout: '"sha512-wrong"' }, { status: 1, stderr: "unavailable" },
    { status: 1, stdout: missing.stdout, stderr: '{"error":{"code":"E500"}}' }, { status: null, signal: "SIGTERM", stdout: missing.stdout },
    { status: 1, stdout: missing.stdout, error: new Error("spawnSync npm ETIMEDOUT") }];
  for (const answer of answers) for (const waits of [0, 2]) {
    const f = fixture(); f.hide = Infinity;
    // The first or third readback after the SDK upload answers with something other than a clean E404.
    const run = (args) => {
      const result = f.run(args);
      return args[0] === "view" && uploads(f.calls).length && f.clock.sleeps.length === waits ? answer : result;
    };
    await assert.rejects(executePublication({ ...f.options, publish: true }, { ...f.deps, run }),
      answer.status === 0 ? /published integrity differs/ : /publication outcome unconfirmed/);
    assert.deepEqual(kinds(f.calls), ["view", "view", "publish", ...Array(waits + 1).fill("view")]);
    assert.equal(f.clock.sleeps.length, waits); assert(!existsSync(f.directory()));
  }
  for (const lookupMs of [0, 7_000]) {
    const f = fixture(); f.hide = Infinity; f.lookupMs = lookupMs;
    await assert.rejects(executePublication({ ...f.options, publish: true }, f.deps), /not visible before the deadline/);
    assert.equal(uploads(f.calls).length, 1); assert(!existsSync(f.directory()));
    assert(f.clock.sleeps.every((ms) => ms > 0 && ms <= registryVisibility.intervalMs));
    // Lookup time counts against the deadline; with these durations the final readback starts exactly at it.
    assert.equal(f.clock.now, 2 * lookupMs + registryVisibility.timeoutMs + lookupMs);
    if (!lookupMs) assert.equal(f.calls.length, 3 + registryVisibility.timeoutMs / registryVisibility.intervalMs + 1);
  }
});

test("failed or uncertain uploads get one readback and stop without polling, retry or second upload", async () => {
  const outcomes = [{ status: 1, stderr: "npm error code E403" }, { status: null, signal: "SIGTERM" },
    { status: 0, error: new Error("spawnSync npm ETIMEDOUT") }];
  for (const outcome of outcomes) for (const hide of [0, 1]) {
    const f = fixture(); f.hide = hide;
    const run = (args) => { const result = f.run(args); return args[0] === "publish" ? outcome : result; };
    await assert.rejects(executePublication({ ...f.options, publish: true }, { ...f.deps, run }),
      hide ? /publication outcome unconfirmed/ : /publication command failed or was uncertain/);
    assert.deepEqual(kinds(f.calls), ["view", "view", "publish", "view"]);
    assert.equal(f.clock.sleeps.length, 0); assert.equal(f.notices.length, 0); assert(!existsSync(f.directory()));
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

test("every npm invocation overrides inherited scoped registry configuration", async () => {
  const f = fixture(); await executePublication({ ...f.options, publish: true }, f.deps);
  const directory = mkdtempSync(join(tmpdir(), "commish-registry-config-"));
  try {
    writeFileSync(join(directory, ".npmrc"), "@commish:registry=https://untrusted.invalid\nregistry=https://untrusted.invalid\n");
    for (const args of f.calls) {
      const registries = args.filter((arg) => arg.startsWith("--registry=") || arg.startsWith("--@commish:registry="));
      assert.deepEqual(registries, ["--registry=https://registry.npmjs.org", "--@commish:registry=https://registry.npmjs.org"]);
      // npm config is local-only; this verifies npm's real scoped configuration precedence.
      const result = spawnSync("npm", ["config", "get", "@commish:registry", ...registries], {
        cwd: directory, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, npm_config_userconfig: join(directory, ".npmrc"), npm_config_registry: "https://untrusted.invalid" },
      });
      assert.equal(result.status, 0); assert.equal(result.stdout.trim(), "https://registry.npmjs.org");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("stop diagnostics show only error codes and author-written assertion messages", async () => {
  const secret = "npm_SECRETVALUE0123456789";
  const cli = (args, env) => spawnSync(process.execPath, [new URL("./publication-executor.mjs", import.meta.url).pathname, ...args],
    { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, GITHUB_TOKEN: secret, ...env } });
  const tail = ". Inspect the accepted evidence and registry before retrying; no automatic retry occurred.\n";
  let result = cli(["42", "7", "--retry"]);
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(result.stderr, `Publication stopped (ERR_ASSERTION: unexpected arguments)${tail}`);
  // A generated assertion message would quote the environment value.
  result = cli(["42", "7"], { COMMISH_NPM_APPROVED_SOURCE: secret });
  assert.equal(result.status, 1); assert.equal(result.stderr, `Publication stopped (ERR_ASSERTION)${tail}`);
  for (const [answer, shown] of [[{ status: 0, stdout: `//registry.npmjs.org/:_authToken=${secret}` }, "unknown"],
    [{ status: 0, stdout: JSON.stringify(secret) }, "ERR_ASSERTION: registry version has different bytes"],
    [{ status: 1, stdout: secret, stderr: secret }, "ERR_ASSERTION: registry lookup unavailable; refuse publication"]]) {
    const f = fixture(); let error;
    await executePublication(f.options, { ...f.deps, run: () => answer }).catch((caught) => { error = caught; });
    assert.equal(stopDiagnostic(error), `Publication stopped (${shown})${tail.trimEnd()}`);
  }
  assert.equal(stopDiagnostic(Object.assign(new Error(secret), { code: secret.toLowerCase() })),
    `Publication stopped (unknown)${tail.trimEnd()}`);
});
