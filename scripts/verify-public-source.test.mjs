import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { archiveFiles, inspect, verify, verifyPackages } from "./verify-public-source.mjs";

function bootstrap() {
  const files = new Map();
  put(files, "LICENSE", readFileSync(new URL("../LICENSE", import.meta.url)));
  put(files, ".gitignore", "node_modules/\ndist/\n*.tgz\n");
  put(
    files,
    "README.md",
    "# Commish public packages\n\nMIT-licensed source for the Commish test-money pilot.\n\nThis repository is receiving independently buildable source layers.\nNo npm publication, release artifact provenance or hosted acceptance is claimed.\n\nSee LICENSE for copyright and permission terms.\n",
  );
  for (const name of [
    ".github/workflows/public-source.yml",
    ".github/workflows/public-review.yml",
    ".github/workflows/public-review-merge-group.yml",
    "scripts/verify-public-source.mjs",
    "scripts/verify-public-source.test.mjs",
    "scripts/verify-sdk-browser-consumer.mjs",
    "scripts/verify-sdk-browser-consumer.test.mjs",
    "scripts/verify-next-browser-consumer.mjs",
    "scripts/verify-next-browser-consumer.test.mjs",
    "scripts/verify-next-types.mjs",
    "scripts/verify-next-types.test.mjs",
    "scripts/fixtures/types-next-browser.ts",
    "scripts/fixtures/types-next-provider.tsx",
    "scripts/provider-types-lock.mjs",
    "scripts/inspect-next-build.mjs",
    "scripts/inspect-next-build.test.mjs",
    "scripts/next-command-scope.mjs",
    "scripts/next-command-scope.test.mjs",
    "scripts/verify-sdk-types.mjs",
    "scripts/verify-sdk-types.test.mjs",
    "scripts/verify-sdk-webhooks.mjs",
    "scripts/verify-sdk-webhooks.test.mjs",
    "scripts/verify-sdk-http.mjs",
    "scripts/verify-sdk-http.test.mjs",
    "scripts/verify-sdk-reads.mjs",
    "scripts/verify-sdk-reads.test.mjs",
    "scripts/fixtures/types-common.ts",
    "scripts/fixtures/types-only.ts",
    "scripts/fixtures/types-client.ts",
  ])
    put(files, name, "");
  return files;
}
function put(files, name, value) {
  files.set(name, {
    mode: "100644",
    data: Buffer.from(
      typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value,
    ),
  });
}
function packageTree() {
  const files = bootstrap();
  put(files, "package.json", {
    name: "commish-public-packages",
    private: true,
    packageManager: "pnpm@11.1.3",
    engines: { node: ">=24 <25" },
    scripts: { build: "pnpm --filter @commish/sdk build" },
  });
  put(files, "pnpm-workspace.yaml", "packages:\n  - packages/sdk\nengineStrict: true\n");
  put(
    files,
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/sdk:
    devDependencies:
      '@types/node':
        specifier: 24.13.3
        version: 24.13.3
      typescript:
        specifier: 5.9.2
        version: 5.9.2

packages:

  '@types/node@24.13.3':
    resolution: {integrity: sha512-Dh8vAsV36ig5wa9OX4pXvMc9D3Veibfw2wix0CUwYODLD8nkj9UsLjASr49nPg+2eKzxhBV+v7L8pXvT4e639Q==}

  typescript@5.9.2:
    resolution: {integrity: sha512-CWBzXQrc/qOkhidw1OzBTQuYRbfyxDXJMVJ1XNwUHGROVmuaeiEm3OslpZ1RV96d7SKKjZKrSJu3+t/xlw3R9A==}
    engines: {node: '>=14.17'}
    hasBin: true

  undici-types@7.18.2:
    resolution: {integrity: sha512-AsuCzffGHJybSaRrmr5eHr81mwJU3kjw6M+uprWvCXiNeN9SOGwQ3Jn8jb8m3Z6izVgknn1R0FTCEAP2QrLY/w==}

snapshots:

  '@types/node@24.13.3':
    dependencies:
      undici-types: 7.18.2

  typescript@5.9.2: {}

  undici-types@7.18.2: {}
`,
  );
  put(files, "packages/sdk/package.json", {
    name: "@commish/sdk",
    version: "0.1.0-beta.9",
    type: "module",
    scripts: {
      build: "node build.mjs",
      prepack: "pnpm build",
      typecheck: "tsc -p tsconfig.build.json --noEmit",
    },
    devDependencies: { typescript: "5.9.2", "@types/node": "24.13.3" },
    exports: { "./browser": { types: "./dist/browser.d.ts", default: "./dist/browser.js" } },
  });
  for (const name of ["LICENSE", "build.mjs", "tsconfig.build.json", "src/browser.ts"])
    put(files, `packages/sdk/${name}`, "");
  return files;
}
function tar(entries) {
  return gzipSync(
    Buffer.concat([
      ...entries.flatMap(([name, value, type = "0", mode = "0000644"]) => {
        const data = Buffer.from(value),
          header = Buffer.alloc(512);
        header.write(name);
        header.write(mode, 100);
        header.write(data.length.toString(8).padStart(11, "0"), 124);
        header.write(type, 156);
        header.fill(32, 148, 156);
        header.write(
          [...header]
            .reduce((sum, byte) => sum + byte, 0)
            .toString(8)
            .padStart(6, "0"),
          148,
        );
        return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
      }),
      Buffer.alloc(1024),
    ]),
  );
}

test("only the exact approved bootstrap receives the empty package plan", () => {
  assert.deepEqual(inspect(bootstrap()), []);
  for (const [name, value] of [
    ["README.md", "different"],
    ["packages/sdk/src/browser.ts", "export {}"],
    ["package.json", "{}"],
    ["packages/sdk/package.json", "{}"],
    ["packages/next/package.json", "{}"],
    ["pnpm-workspace.yaml", "packages: []"],
    ["pnpm-lock.yaml", "lockfileVersion: 9"],
    ["surprise.ts", ""],
    [".github/workflows/extra.yml", ""],
  ]) {
    const files = bootstrap();
    put(files, name, value);
    assert.throws(() => inspect(files));
  }
  for (const name of bootstrap().keys()) {
    const files = bootstrap();
    files.delete(name);
    assert.throws(() => inspect(files));
  }
  const linked = bootstrap();
  linked.get("LICENSE").mode = "120000";
  assert.throws(() => inspect(linked));
});
test("package shapes fail closed on missing scaffolding, orphan sources, unsafe commands and exports", () => {
  assert.equal(inspect(packageTree())[0].manifest.name, "@commish/sdk");
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "packages/sdk/package.json",
    "packages/sdk/build.mjs",
    "packages/sdk/src/browser.ts",
  ]) {
    const files = packageTree();
    files.delete(name);
    assert.throws(() => inspect(files));
  }
  for (const patch of [
    { scripts: { install: "do-something" } },
    { dependencies: { unexpected: "1.0.0" } },
    { exports: {} },
    { exports: { "./browser": "../../outside.js" } },
    { bin: { other: "./bin/other" } },
    { devDependencies: { typescript: "latest" } },
  ]) {
    const files = packageTree(),
      name = "packages/sdk/package.json";
    put(files, name, { ...JSON.parse(files.get(name).data), ...patch });
    assert.throws(() => inspect(files));
  }
  for (const [name, value] of [
    ["packages/next/src/browser.ts", ""],
    ["pnpm-workspace.yaml", "packages: ['**']"],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n  tarball: https://example.invalid/a.tgz"],
    [
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n  resolution: {type: git, repo: 'git@example.invalid:repo.git', commit: abc}",
    ],
    [
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n  resolution: {type: directory, directory: '../../outside'}",
    ],
  ]) {
    const files = packageTree();
    put(files, name, value);
    assert.throws(() => inspect(files));
  }
});
test("archive inspection rejects traversal, duplicate paths, links and truncated bodies", () => {
  assert.equal(
    archiveFiles(tar([["package/dist/browser.js", "ok"]]))
      .get("package/dist/browser.js")
      .data.toString(),
    "ok",
  );
  for (const entries of [
    [["package/../outside", ""]],
    [["package/.", ""]],
    [["package/..", ""]],
    [["package/dist/.", ""]],
    [["package/dist/..", ""]],
    [
      ["package/a", ""],
      ["package/a", ""],
    ],
    [["package/a", "", "2"]],
  ])
    assert.throws(() => archiveFiles(tar(entries)));
  assert.throws(() => archiveFiles(gzipSync(Buffer.alloc(512))));
  assert.throws(() => archiveFiles(tar([["package/a", "content"]]).subarray(0, 20)));
});
test("package commands run frozen install then ordered build/typecheck/pack and clean up after any failure", () => {
  for (const failure of [
    null,
    "install",
    "build",
    "typecheck",
    "pack",
    "missing-export",
    "mutated-lock",
  ]) {
    const files = packageTree(),
      packages = inspect(files),
      calls = [];
    let work;
    const run = (command, args, cwd) => {
      if (command === process.execPath) {
        calls.push("consumer-probe");
        return;
      }
      assert.equal(command, "pnpm");
      if (args.includes("--offline")) {
        calls.push("consumer-install");
        mkdirSync(join(cwd, "node_modules/.pnpm/sdk"), { recursive: true });
        for (const [name, entry] of archiveFiles(readFileSync(join(cwd, "sdk.tgz")))) {
          const path = join(cwd, "node_modules/@commish/sdk", name.slice(8));
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, entry.data);
        }
        return;
      }
      calls.push(args[0]);
      work ??= cwd;
      if (args[0] === failure) throw new Error("controlled command failure");
      if (args[0] === "install")
        assert.deepEqual(args, [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--registry=https://registry.npmjs.org",
        ]);
      if (args[0] === "build") {
        mkdirSync(join(cwd, "dist"));
        for (const ext of ["js", "d.ts"])
          writeFileSync(join(cwd, `dist/browser.${ext}`), "export {};");
      }
      if (args[0] === "pack") {
        const manifest = structuredClone(packages[0].manifest);
        delete manifest.scripts.prepack;
        const entries = [
          ["package/package.json", JSON.stringify(manifest)],
          ["package/dist/browser.js", "export {};"],
        ];
        if (failure !== "missing-export") entries.push(["package/dist/browser.d.ts", "export {};"]);
        writeFileSync(join(args[2], "fixture.tgz"), tar(entries));
        if (failure === "mutated-lock") writeFileSync(join(work, "pnpm-lock.yaml"), "changed");
      }
    };
    if (failure) assert.throws(() => verifyPackages(files, packages, run));
    else {
      verifyPackages(files, packages, run);
      assert.deepEqual(calls, [
        "install",
        "build",
        "typecheck",
        "pack",
        "consumer-install",
        "consumer-probe",
      ]);
    }
    assert(work && !existsSync(work), "owned working tree must be removed");
  }
});
test("verification binds its receipt to the actual immutable checkout and rejects dirty source", () => {
  const root = mkdtempSync(join(tmpdir(), "commish-public-git-test-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  try {
    git("init");
    git("config", "core.hooksPath", "/dev/null");
    for (const [name, { data }] of bootstrap()) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), data);
    }
    git("add", ".");
    git(
      "-c",
      "user.name=Public verifier test",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "fixture",
    );
    const head = git("rev-parse", "HEAD");
    assert.deepEqual(verify(root, head), {
      sha: head,
      scope: "exact-bootstrap-and-automation",
      packages: [],
      consumerScopes: [],
      consumerChecks: false,
      publication: false,
    });
    for (const sha of [undefined, "", "a".repeat(40)]) assert.throws(() => verify(root, sha));
    writeFileSync(join(root, "README.md"), "dirty");
    assert.throws(() => verify(root, head));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const reviewWorkflow = readFileSync(
  new URL("../.github/workflows/public-review.yml", import.meta.url),
  "utf8",
);
const admissionScript = reviewWorkflow
  .split("          script: |\n")[1]
  .split("\n")
  .filter((line, index, lines) =>
    lines.slice(0, index + 1).every((part) => part.startsWith("            ")),
  )
  .map((line) => line.slice(12))
  .join("\n");
const runAdmission = new (Object.getPrototypeOf(async function () {}).constructor)(
  "github",
  "context",
  "core",
  "process",
  "require",
  admissionScript,
);
const publicRepository = "oftring-ventures/commish-sdk";
const reviewGate = "codex_review / Codex review gate";
function admissionFixture() {
  const base = "b".repeat(40);
  const pull = {
    number: 7,
    state: "open",
    draft: false,
    head: { sha: "a".repeat(40), repo: { full_name: publicRepository } },
    base: { sha: base, ref: "main", repo: { full_name: publicRepository } },
  };
  const state = {
    pull,
    main: base,
    checks: [],
    created: {},
    calls: [],
    outputs: {},
    context: {
      repo: { owner: "oftring-ventures", repo: "commish-sdk" },
      eventName: "pull_request_target",
      payload: { pull_request: structuredClone(pull) },
    },
    env: {
      GITHUB_WORKFLOW_SHA: base,
      GITHUB_WORKFLOW_REF: `${publicRepository}/.github/workflows/public-review.yml@refs/heads/main`,
    },
  };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: state.pull }) },
      git: { getRef: async () => ({ data: { object: { sha: state.main } } }) },
      checks: {
        listForRef: "checks",
        create: async (input) => {
          state.calls.push(input);
          return {
            data: {
              id: 71,
              name: reviewGate,
              head_sha: input.head_sha,
              app: { id: 15368 },
              ...state.created,
            },
          };
        },
      },
    },
    paginate: async (kind) => state[kind],
  };
  state.run = () =>
    runAdmission(
      github,
      state.context,
      {
        setOutput: (name, value) => {
          state.outputs[name] = value;
        },
      },
      { env: state.env },
      createRequire(import.meta.url),
    );
  return state;
}

test("trusted main binds one queued required check to the API-validated head", async () => {
  const state = admissionFixture();
  await state.run();
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], {
    owner: "oftring-ventures",
    repo: "commish-sdk",
    name: reviewGate,
    head_sha: state.pull.head.sha,
    status: "queued",
    external_id: `public-review:7:${state.main}:${state.pull.head.sha}`,
  });
  assert.deepEqual(state.outputs, {
    pr_number: "7",
    base_sha: state.main,
    head_sha: state.pull.head.sha,
    head_repository: publicRepository,
    check_run_id: "71",
    admitted: "true",
  });
});
test("fork, draft, stale and untrusted workflow paths cannot create a required check", async () => {
  for (const mutate of [
    (s) => {
      s.pull.head.repo.full_name = "outsider/fork";
    },
    (s) => {
      s.pull.draft = true;
    },
    (s) => {
      s.pull.state = "closed";
    },
    (s) => {
      s.pull.base.ref = "other";
    },
    (s) => {
      s.pull.base.repo.full_name = "outsider/base";
    },
    (s) => {
      s.pull.head.sha = "c".repeat(40);
    },
    (s) => {
      s.pull.base.sha = "c".repeat(40);
    },
    (s) => {
      s.main = "c".repeat(40);
    },
    (s) => {
      s.env.GITHUB_WORKFLOW_SHA = "c".repeat(40);
    },
    (s) => {
      s.env.GITHUB_WORKFLOW_REF = "untrusted/branch";
    },
    (s) => {
      s.context.eventName = "workflow_dispatch";
    },
    (s) => {
      s.context.eventName = "pull_request";
    },
  ]) {
    const state = admissionFixture();
    mutate(state);
    await assert.rejects(state.run());
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.outputs, {});
  }
});
test("the former A1a pull_request bootstrap cannot admit a review", async () => {
  const state = admissionFixture();
  const formerBase = "1fceca7803fb7b74f8c22c1ac5e7f650fa9deb27";
  state.main = formerBase;
  state.pull.base.sha = formerBase;
  state.context.payload.pull_request.base.sha = formerBase;
  state.context.eventName = "pull_request";
  state.env.GITHUB_WORKFLOW_SHA = formerBase;
  state.env.GITHUB_WORKFLOW_REF = `${publicRepository}/.github/workflows/public-review.yml@refs/pull/7/merge`;
  await assert.rejects(state.run(), /Unexpected event/);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.outputs, {});
});
test("existing reviews are never replaced or automatically retried", async () => {
  for (const status of ["queued", "in_progress", "completed"]) {
    const state = admissionFixture();
    state.checks = [{ name: reviewGate, status }];
    await state.run();
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.outputs, {});
  }
});
test("wrong provider check identity never reaches the review receiver", async () => {
  for (const created of [
    { id: "71" },
    { id: 0 },
    { name: "other" },
    { head_sha: "c".repeat(40) },
    { app: { id: 0 } },
  ]) {
    const state = admissionFixture();
    state.created = created;
    await assert.rejects(state.run());
    assert.deepEqual(state.outputs, {});
  }
});
test("skipped model jobs cannot impersonate the required gate and group bridging is separate", () => {
  assert.equal(
    reviewWorkflow.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1],
    "  pull_request_target:\n    types: [opened, reopened, synchronize, ready_for_review]\n",
  );
  assert.match(reviewWorkflow, /^  review_model:$/m);
  assert.doesNotMatch(reviewWorkflow, /^  codex_review:$/m);
  assert.doesNotMatch(
    reviewWorkflow,
    /name: Codex review gate|secrets: inherit|run:|actions\/checkout/,
  );
  assert.match(reviewWorkflow, /OPENAI_API_KEY: \$\{\{ secrets.OPENAI_API_KEY \}\}/);
  const group = readFileSync(
    new URL("../.github/workflows/public-review-merge-group.yml", import.meta.url),
    "utf8",
  );
  assert.match(group, /^  merge_group:$/m);
  assert.match(group, /^  codex_review:$/m);
  assert.match(group, /mode: merge_group/);
  assert.doesNotMatch(group, /pull_request:|pull_request_target:|\n\s+if:|secrets:/);
});
