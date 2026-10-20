import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { candidateScopes } from "./public-candidate.mjs";
import { executePublication, stagingNpmVersion, stopDiagnostic } from "./publication-executor.mjs";
import { releaseArtifacts } from "./stable-release.mjs";

const hash = (data, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(data).digest(encoding);
const source = "a".repeat(40),
  repository = "oftring-ventures/commish-sdk";
const missing = { status: 1, stdout: '{"error":{"code":"E404"}}' };
function zip(files) {
  const parts = [],
    central = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const local = Buffer.alloc(30),
      entry = Buffer.alloc(46),
      nameBytes = Buffer.from(name);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, bytes);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
function fixture() {
  const files = new Map();
  const artifacts = releaseArtifacts.map(({ name, file }) => {
    const metadata = {
      name,
      version: "0.5.0",
      license: "MIT",
      repository: { url: `git+https://github.com/${repository}.git` },
      publishConfig:
        name === "commish"
          ? { access: "public", registry: "https://registry.npmjs.org/", tag: "latest" }
          : { access: "public", tag: "latest" },
      ...(name === "@commish/next" ? { peerDependencies: { "@commish/sdk": "0.5.0" } } : {}),
      ...(name === "commish" ? { dependencies: { "@commish/sdk": "0.5.0" } } : {}),
    };
    const data = Buffer.from(JSON.stringify(metadata)),
      header = Buffer.alloc(512);
    header.write("package/package.json");
    header.write("0000644", 100);
    header.write(data.length.toString(8).padStart(11, "0"), 124);
    header.write("0", 156);
    header.fill(32, 148, 156);
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0"),
      148,
    );
    const bytes = gzipSync(
      Buffer.concat([header, data, Buffer.alloc(((512 - (data.length % 512)) % 512) + 1024)]),
    );
    bytes[9] = 255;
    files.set(file, bytes);
    return {
      name: metadata.name,
      version: metadata.version,
      file,
      bytes: bytes.length,
      sha512: hash(bytes, "sha512"),
      integrity: `sha512-${hash(bytes, "sha512", "base64")}`,
      members: [
        {
          name: "package/package.json",
          bytes: data.length,
          mode: 0o644,
          sha512: hash(data, "sha512"),
        },
      ],
    };
  });
  const manifest = {
    source,
    status: "local-artifacts-verified",
    npmPublished: false,
    hostedAccepted: false,
    node: "v24.15.0",
    consumerScopes: candidateScopes,
    artifacts,
  };
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  files.set("SHA512SUMS", Buffer.from(artifacts.map((a) => `${a.sha512}  ${a.file}\n`).join("")));
  const ci = {
    source,
    repository,
    job: "source",
    runId: "42",
    runAttempt: "1",
    node: manifest.node,
    runner: { os: "Linux", arch: "X64" },
    npmPublished: false,
    hostedAccepted: false,
    manifestSha256: hash(files.get("manifest.json")),
    artifacts: artifacts.map(({ file, bytes, sha512 }) => ({ file, bytes, sha512 })),
  };
  files.set("ci-receipt.json", Buffer.from(JSON.stringify(ci)));
  const archive = zip(files);
  const evidence = {
    mainHead: source,
    zip: archive,
    run: {
      id: 42,
      run_attempt: 1,
      head_sha: source,
      path: ".github/workflows/public-source.yml",
      status: "completed",
      conclusion: "success",
      event: "push",
      repository: { full_name: repository },
      head_repository: { full_name: repository },
    },
    comparison: { status: "identical", merge_base_commit: { sha: source } },
    artifact: {
      id: 7,
      name: `public-candidate-${source}-42-1`,
      expired: false,
      digest: `sha256:${hash(archive)}`,
      workflow_run: { id: 42, head_sha: source },
    },
  };
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_JOB: "publish",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    COMMISH_NPM_ENVIRONMENT: "npm-publication",
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_REF: "refs/tags/v0.5.0",
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-packages.yml@refs/tags/v0.5.0`,
    COMMISH_NPM_APPROVED_SOURCE: source,
    COMMISH_NPM_APPROVED_MANIFEST_SHA256: ci.manifestSha256,
    COMMISH_NPM_APPROVED_CI_RECEIPT_SHA256: hash(files.get("ci-receipt.json")),
    COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256: "b".repeat(64),
  };
  const calls = [],
    registry = new Map();
  let directory;
  const run = (args) => {
    calls.push(args);
    if (args[0] === "--version") return { status: 0, stdout: stagingNpmVersion };
    if (args[0] === "view")
      return registry.has(args[1])
        ? { status: 0, stdout: JSON.stringify(registry.get(args[1])) }
        : missing;
    assert.deepEqual(args.slice(0, 2), ["stage", "publish"]);
    directory = dirname(args[2]);
    const index = artifacts.findIndex((a) => args[2].endsWith(a.file)),
      item = artifacts[index];
    return {
      status: 0,
      stdout: JSON.stringify({
        [item.name]: {
          name: item.name,
          version: item.version,
          integrity: item.integrity,
          ...(!args.includes("--dry-run")
            ? { stageId: `00000000-0000-4000-8000-00000000000${index}` }
            : {}),
        },
      }),
    };
  };
  const checkpoints = [];
  return {
    artifacts,
    evidence,
    env,
    calls,
    registry,
    checkpoints,
    directory: () => directory,
    run,
    options: { runId: "42", artifactId: "7", env },
    deps: { evidence: async () => evidence, run, checkpoint: (value) => checkpoints.push(value) },
  };
}
const uploads = (calls) => calls.filter((a) => a[0] === "stage");
const names = releaseArtifacts.map((a) => a.name);

test("dry-run validates CLI output and exact archive bytes without staging", async () => {
  const f = fixture();
  const receipt = await executePublication(f.options, f.deps);
  assert.equal(receipt.status, "dry-run-complete");
  assert.equal(receipt.npmPublished, false);
  assert.deepEqual(receipt.staged, []);
  assert.deepEqual(receipt.executed, names);
  assert(uploads(f.calls).every((a) => a.includes("--dry-run") && a.includes("--ignore-scripts")));
  assert.deepEqual(
    uploads(f.calls).map((a) => a[2].split("/").pop()),
    f.artifacts.map((a) => a.file),
  );
  assert(!existsSync(f.directory()));
});

test("stage-only execution records each stage ID and stops at human approval without public polling", async () => {
  const f = fixture();
  const receipt = await executePublication({ ...f.options, stage: true }, f.deps);
  assert.deepEqual(
    f.calls.map((a) => a[0]),
    ["--version", ...names.map(() => "view"), ...names.map(() => "stage")],
  );
  assert.deepEqual(
    receipt.staged.map((a) => a.name),
    names,
  );
  assert(receipt.staged.every((a) => a.stageId && a.tag === "latest"));
  assert.equal(receipt.status, "awaiting-maintainer-approval");
  assert.equal(receipt.npmPublished, false);
  assert.equal(receipt.registryIntegrityVerified, false);
  assert.equal(receipt.hostedAcceptanceSha256, f.env.COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256);
  assert.equal(f.checkpoints.at(-1).unconfirmed, null);
  assert(!existsSync(f.directory()));
});

test("unapproved candidate, workflow or hosted evidence never reach npm", async () => {
  for (const mutate of [
    (f) => {
      f.env.COMMISH_NPM_APPROVED_SOURCE = "b".repeat(40);
    },
    (f) => {
      f.evidence.artifact.expired = true;
    },
    (f) => {
      f.evidence.zip[0] ^= 1;
    },
    (f) => {
      f.options.artifactId = "8";
    },
    (f) => {
      f.env.GITHUB_REF = "refs/heads/main";
    },
    (f) => {
      delete f.env.COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(executePublication({ ...f.options, stage: true }, f.deps));
    assert.equal(f.calls.length, 0);
  }
});

test("wrong npm version or any unavailable/conflicting registry lookup stops before staging", async () => {
  const f = fixture();
  await assert.rejects(
    executePublication(f.options, { ...f.deps, run: () => ({ status: 0, stdout: "11.12.1" }) }),
    /toolchain/,
  );
  for (const answer of [
    { status: 0, stdout: '"sha512-wrong"' },
    { status: 1, stderr: "unavailable" },
  ]) {
    const g = fixture();
    let lookups = 0;
    await assert.rejects(
      executePublication(g.options, {
        ...g.deps,
        run: (args) => (args[0] === "view" ? (++lookups === 2 ? answer : missing) : g.run(args)),
      }),
    );
    assert.equal(lookups, names.length);
    assert.equal(uploads(g.calls).length, 0);
  }
});

test("identical public versions are skipped, including an already-complete release", async () => {
  for (const count of [1, names.length]) {
    const f = fixture();
    for (const item of f.artifacts.slice(0, count))
      f.registry.set(`${item.name}@${item.version}`, item.integrity);
    const receipt = await executePublication({ ...f.options, stage: true }, f.deps);
    assert.deepEqual(receipt.skipped, names.slice(0, count));
    assert.deepEqual(receipt.executed, names.slice(count));
    assert.equal(
      receipt.status,
      count === names.length ? "already-published" : "awaiting-maintainer-approval",
    );
  }
});

test("failed, uncertain and malformed staging outcomes retain partial progress and never retry", async () => {
  const outcomes = [
    { status: 1, stderr: "E409 staged version already exists" },
    { status: null, signal: "SIGTERM" },
    { status: 0, error: new Error("timeout") },
    { status: 0, stdout: "invalid JSON" },
  ];
  for (const outcome of outcomes) {
    const f = fixture();
    const run = (args) => {
      const result = f.run(args);
      return args[0] === "stage" && uploads(f.calls).length === 2 ? outcome : result;
    };
    await assert.rejects(executePublication({ ...f.options, stage: true }, { ...f.deps, run }));
    const last = f.checkpoints.at(-1);
    assert.equal(last.status, "stopped");
    assert.deepEqual(
      last.staged.map((a) => a.name),
      names.slice(0, 1),
    );
    assert.equal(last.unconfirmed.name, names[1]);
    assert.equal(uploads(f.calls).length, 2);
    assert(!existsSync(f.directory()));
  }
});

test("staging receipts must bind package, version, archive integrity and a unique stage ID", async () => {
  for (const change of [
    (r) => {
      r.name = "wrong";
    },
    (r) => {
      r.version = "9.9.9";
    },
    (r) => {
      r.integrity = "wrong";
    },
    (r) => {
      delete r.stageId;
    },
    (r) => {
      r.stageId = "unsafe/path";
    },
  ]) {
    const f = fixture();
    const run = (args) => {
      const result = f.run(args);
      if (args[0] === "stage") {
        const d = JSON.parse(result.stdout);
        change(d[names[0]]);
        result.stdout = JSON.stringify(d);
      }
      return result;
    };
    await assert.rejects(executePublication({ ...f.options, stage: true }, { ...f.deps, run }));
    assert.equal(uploads(f.calls).length, 1);
  }
  const f = fixture();
  const run = (args) => {
    const result = f.run(args);
    if (args[0] === "stage") {
      const d = JSON.parse(result.stdout);
      Object.values(d)[0].stageId = "00000000-0000-4000-8000-000000000000";
      result.stdout = JSON.stringify(d);
    }
    return result;
  };
  await assert.rejects(
    executePublication({ ...f.options, stage: true }, { ...f.deps, run }),
    /id reused/,
  );
  assert.equal(uploads(f.calls).length, 2);
});

test("candidate tampering between stages is detected and temporary files are removed", async () => {
  const f = fixture();
  const run = (args) => {
    const result = f.run(args);
    if (args[0] === "stage") writeFileSync(join(f.directory(), f.artifacts[1].file), "changed");
    return result;
  };
  await assert.rejects(executePublication(f.options, { ...f.deps, run }));
  assert.equal(uploads(f.calls).length, 1);
  assert(!existsSync(f.directory()));
});

test("every registry command overrides inherited scoped registry configuration", async () => {
  const f = fixture();
  await executePublication({ ...f.options, stage: true }, f.deps);
  const directory = mkdtempSync(join(tmpdir(), "commish-registry-config-"));
  try {
    writeFileSync(
      join(directory, ".npmrc"),
      "@commish:registry=https://untrusted.invalid\nregistry=https://untrusted.invalid\n",
    );
    for (const args of f.calls.filter((a) => a[0] !== "--version")) {
      const registries = args.filter(
        (a) => a.startsWith("--registry=") || a.startsWith("--@commish:registry="),
      );
      assert.deepEqual(registries, [
        "--registry=https://registry.npmjs.org",
        "--@commish:registry=https://registry.npmjs.org",
      ]);
      const r = spawnSync("npm", ["config", "get", "@commish:registry", ...registries], {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          npm_config_userconfig: join(directory, ".npmrc"),
          npm_config_registry: "https://untrusted.invalid",
        },
      });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), "https://registry.npmjs.org");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects direct publishing and diagnostics never disclose subprocess secrets", async () => {
  const secret = "npm_SECRETVALUE0123456789";
  const r = spawnSync(
    process.execPath,
    [new URL("./publication-executor.mjs", import.meta.url).pathname, "42", "7", "--publish"],
    { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, GITHUB_TOKEN: secret } },
  );
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unexpected arguments/);
  assert(!r.stderr.includes(secret));
  const f = fixture();
  let caught;
  await executePublication(
    { ...f.options, stage: true },
    {
      ...f.deps,
      run: (args) =>
        args[0] === "stage" ? { status: 1, stdout: secret, stderr: secret } : f.run(args),
    },
  ).catch((e) => {
    caught = e;
  });
  assert(!stopDiagnostic(caught).includes(secret));
  assert.match(stopDiagnostic(caught), /no automatic retry/);
});
