import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import test from "node:test";
import { archiveFiles, failureDiagnostic, inspect, verify, verifyPackages } from "./verify-public-source.mjs";
import { releaseVersion } from "./stable-release.mjs";

const root = new URL("../", import.meta.url);
// The tracked tree with its index modes: the same inventory `verify` reads from HEAD.
function repositoryTree() {
  const files = new Map();
  const listing = execFileSync("git", ["ls-files", "-z", "--stage"], { cwd: root }).toString();
  for (const entry of listing.split("\0").filter(Boolean)) {
    const [metadata, name] = entry.split("\t"), [mode] = metadata.split(" ");
    files.set(name, { mode, data: readFileSync(new URL(name, root)) });
  }
  return files;
}
function put(files, name, value) {
  files.set(name, {
    mode: "100644",
    data: Buffer.from(typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value),
  });
}
const patch = (files, name, change) => {
  const manifest = JSON.parse(files.get(name).data);
  change(manifest);
  put(files, name, manifest);
};
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
const stubConsumers = (log) => ({
  sdk: (archive, packed, run, context) => {
    log.push("sdk-consumer");
    assert(archive.length > 0 && packed.has("package/dist/index.js") && packed.has("package/bin/init.mjs"));
    assert.equal(typeof run, "function");
    assert(context.lock.length > 0 && existsSync(context.build));
    return { scopes: ["sdk-scope"] };
  },
  nextBrowser: (sdk, next) => {
    log.push("next-browser");
    assert(sdk.packed.has("package/dist/webhooks.js") && next.packed.has("package/dist/provider.js"));
    return ["next-browser-scope"];
  },
  nextProvider: () => {
    log.push("next-provider");
    return ["next-provider-scope"];
  },
  nextBuild: async () => {
    log.push("next-build");
    return ["next-build-scope"];
  },
});
// Stands in for pnpm: build writes every declared dist target, pack archives them.
function stubRun(packages, calls, failure) {
  let work;
  const run = (command, args, cwd) => {
    assert.equal(command, "pnpm");
    calls.push(args[0]);
    work ??= cwd;
    if (args[0] === failure) throw new Error("controlled command failure");
    if (args[0] === "install")
      assert.deepEqual(args, ["install", "--frozen-lockfile", "--ignore-scripts", "--registry=https://registry.npmjs.org"]);
    const pkg = packages.find(({ dir }) => cwd === join(work, dir));
    if (args[0] === "build") {
      mkdirSync(join(cwd, "dist"), { recursive: true });
      for (const target of pkg.targets.filter((name) => name.startsWith("./dist/")))
        writeFileSync(join(cwd, target), `// ${target}\n`);
    }
    if (args[0] === "pack") {
      const manifest = structuredClone(pkg.manifest);
      delete manifest.scripts.prepack;
      const entries = [["package/package.json", JSON.stringify(manifest)]];
      for (const target of pkg.targets)
        if (!(failure === "missing-export" && target.endsWith(".d.ts")))
          entries.push([`package/${target.slice(2)}`, readFileSync(join(cwd, target)), "0",
            target.startsWith("./bin/") ? "0000755" : "0000644"]);
      writeFileSync(join(args[2], "fixture.tgz"), tar(entries));
      if (failure === "mutated-lock") writeFileSync(join(work, "pnpm-lock.yaml"), "changed");
    }
  };
  return { run, work: () => work };
}

test("the committed pair is admitted and archive targets follow the exports", () => {
  const packages = inspect(repositoryTree());
  assert.deepEqual(packages.map(({ dir, manifest }) => [dir, manifest.name, manifest.version]), [
    ["packages/sdk", "@commish/sdk", releaseVersion],
    ["packages/next", "@commish/next", releaseVersion],
  ]);
  assert.deepEqual([...packages[0].targets].sort(), ["./bin/init.mjs", "./dist/browser.d.ts", "./dist/browser.js",
    "./dist/index.d.ts", "./dist/index.js", "./dist/webhooks.d.ts", "./dist/webhooks.js"]);
  assert.deepEqual([...packages[1].targets].sort(), ["./bin/init.mjs", ...["browser", "index", "pages", "pages-handlers",
    "pages-routing", "provider"].flatMap((stem) => [`./dist/${stem}.d.ts`, `./dist/${stem}.js`])].sort());
});

test("source shape fails closed on modes, orphans, toolchain drift, lockfile origins and manifest contracts", () => {
  const sdk = "packages/sdk/package.json", next = "packages/next/package.json", lock = "pnpm-lock.yaml";
  const lockText = (files) => files.get(lock).data.toString();
  const workspaceText = (files) => files.get("pnpm-workspace.yaml").data.toString();
  for (const [label, change, expected] of [
    ["symlinked license", (f) => { f.get("LICENSE").mode = "120000"; }, /invalid source mode/],
    ["executable module", (f) => { f.get("packages/sdk/bin/cli-http.mjs").mode = "100755"; }, /invalid source mode/],
    ["plain entry point", (f) => { f.get("packages/sdk/bin/init.mjs").mode = "100644"; }, /invalid source mode/],
    ["orphan package", (f) => put(f, "packages/other/index.ts", ""), /orphan package source/],
    ["dot segment", (f) => put(f, "packages/sdk/../x", ""), /unsafe source path/],
    ["changed license", (f) => put(f, "LICENSE", "different"), /MIT license differs/],
    ["changed package license", (f) => put(f, "packages/next/LICENSE", "different"), /MIT license differs/],
    ["toolchain drift", (f) => put(f, ".node-version", "1.2.3\n"), /node-version differs/],
    ["missing workflow", (f) => f.delete(".github/workflows/publish-packages.yml"), /missing required file/],
    ["missing gate test", (f) => f.delete("scripts/publication-workflow.test.mjs"), /missing required file/],
    ["root lifecycle script", (f) => patch(f, "package.json", (m) => { m.scripts.postinstall = "x"; }), /lifecycle/],
    ["root package manager", (f) => patch(f, "package.json", (m) => { m.packageManager = "pnpm@11"; }), /packageManager/],
    ["root runtime dependency", (f) => patch(f, "package.json", (m) => { m.dependencies = { left: "1.0.0" }; }), /runtime dependencies/],
    ["root ranged dev dependency", (f) => patch(f, "package.json", (m) => { m.devDependencies = { lint: "^1.0.0" }; }), /exact version/],
    ["extra workspace package", (f) => put(f, "pnpm-workspace.yaml", "packages:\n  - packages/sdk\n  - packages/next\n  - apps/*\nengineStrict: true\n"), /workspace packages/],
    ["workspace without engines", (f) => put(f, "pnpm-workspace.yaml", "packages:\n  - packages/sdk\n  - packages/next\n"), /enforce engines/],
    ["lockfile version", (f) => put(f, lock, "lockfileVersion: '6.0'\n"), /lockfile version/],
    ["lockfile tarball", (f) => put(f, lock, `${lockText(f)}\n  left@1.0.0:\n    resolution: {tarball: https://example.invalid/left.tgz}\n`), /registry only/],
    ["lockfile git", (f) => put(f, lock, `${lockText(f)}\n  left@1.0.0:\n    resolution: {type: git, repo: 'git@example.invalid:repo.git', commit: abc}\n`), /registry only/],
    ["lockfile directory", (f) => put(f, lock, `${lockText(f)}\n  left@1.0.0:\n    resolution: {type: directory, directory: '../../outside'}\n`), /registry only/],
    ["lockfile without integrity", (f) => put(f, lock, `${lockText(f)}\n  left@1.0.0:\n    resolution: {commit: abc}\n`), /without integrity/],
    ["lockfile foreign link", (f) => put(f, lock, lockText(f).replace("link:../sdk", "link:../../outside")), /lockfile link/],
    ["lockfile extra importer", (f) => put(f, lock, lockText(f).replace("\n  packages/next:\n", "\n  apps/web:\n    dependencies: {}\n\n  packages/next:\n")), /importers/],
    ["install script", (f) => patch(f, sdk, (m) => { m.scripts.install = "do-something"; }), /lifecycle/],
    ["runtime dependency", (f) => patch(f, sdk, (m) => { m.dependencies = { unexpected: "1.0.0" }; }), /production dependency/],
    ["ranged dev dependency", (f) => patch(f, sdk, (m) => { m.devDependencies.typescript = "latest"; }), /exact version/],
    ["missing dev dependency", (f) => patch(f, sdk, (m) => { delete m.devDependencies.typescript; }), /missing development dependency/],
    ["export without source", (f) => patch(f, next, (m) => { m.exports["./webhooks"] = { types: "./dist/webhooks.d.ts", default: "./dist/webhooks.js" }; }), /unknown export/],
    ["source without export", (f) => patch(f, sdk, (m) => { delete m.exports["./webhooks"]; }), /has no export/],
    ["untyped entry", (f) => patch(f, sdk, (m) => { m.exports["./browser"] = { default: "./dist/browser.js" }; }), /types condition/],
    ["types not first", (f) => patch(f, sdk, (m) => { m.exports["./browser"] = { default: "./dist/browser.js", types: "./dist/browser.d.ts" }; }), /types condition/],
    ["server entry in browsers", (f) => patch(f, sdk, (m) => { const { browser: _unused, ...rest } = m.exports["."]; void _unused; m.exports["."] = rest; }), /must not resolve in browsers/],
    ["browser entry excluded", (f) => patch(f, sdk, (m) => { m.exports["./browser"] = { types: "./dist/browser.d.ts", browser: null, default: "./dist/browser.js" }; }), /is a browser entry/],
    ["unknown condition", (f) => patch(f, sdk, (m) => { m.exports["."].import = "./dist/index.js"; }), /unknown export condition/],
    ["edge runtime on webhooks", (f) => patch(f, sdk, (m) => { m.exports["./webhooks"]["edge-light"] = "./dist/webhooks.js"; }), /supported only by the SDK client/],
    ["edge runtime behind browser", (f) => patch(f, sdk, (m) => { m.exports["."] = { types: "./dist/index.d.ts", browser: null, "edge-light": "./dist/index.js", default: "./dist/index.js" }; }), /must precede the browser condition/],
    ["edge runtime to another build", (f) => patch(f, sdk, (m) => { m.exports["."]["edge-light"] = "./dist/browser.js"; }), /resolve the default build/],
    ["outside target", (f) => patch(f, sdk, (m) => { m.exports["./browser"].default = "../../outside.js"; }), /default target/],
    ["manifest export", (f) => patch(f, sdk, (m) => { m.exports["./package.json"] = "./dist/index.js"; }), /package.json export/],
    ["other bin", (f) => patch(f, sdk, (m) => { m.bin = { other: "./bin/other" }; }), /entry point/],
    ["shipping source", (f) => patch(f, sdk, (m) => { m.files.push("src"); }), /files list/],
    ["side effects", (f) => patch(f, sdk, (m) => { m.sideEffects = true; }), /side-effect free/],
    ["engines", (f) => patch(f, sdk, (m) => { m.engines = { node: "24" }; }), /engines/],
    ["private release", (f) => patch(f, next, (m) => { m.private = true; }), /private/],
    ["version drift", (f) => patch(f, next, (m) => { m.version = "0.0.1"; }), /release version/],
    ["sdk peer mismatch", (f) => patch(f, next, (m) => { m.peerDependencies["@commish/sdk"] = "0.0.1"; }), /allow the released SDK/],
    ["sdk peer caret", (f) => patch(f, next, (m) => { m.peerDependencies["@commish/sdk"] = `^${releaseVersion}`; }), /allow the released SDK/],
    ["react peer missing", (f) => patch(f, next, (m) => { delete m.peerDependencies.react; }), /Next peers/],
    ["next peer unbounded", (f) => patch(f, next, (m) => { m.peerDependencies.next = ">=16"; }), /next peer range/],
    ["sdk with peers", (f) => patch(f, sdk, (m) => { m.peerDependencies = { react: ">=19.0.0 <20" }; }), /no peers/],
    ["shebang", (f) => { put(f, "packages/sdk/bin/init.mjs", "console.log(1)\n"); f.get("packages/sdk/bin/init.mjs").mode = "100755"; }, /shebang/],
    ["registry configuration", (f) => put(f, ".npmrc", "registry=https://example.invalid/\n"), /unexpected source path/],
    ["package registry configuration", (f) => put(f, "packages/sdk/.npmrc", "@types:registry=https://example.invalid/\n"), /unexpected source path/],
    ["install hook", (f) => put(f, ".pnpmfile.cjs", "module.exports = {};\n"), /unexpected source path/],
    ["extra workflow", (f) => put(f, ".github/workflows/deploy.yml", "on: push\n"), /unexpected source path/],
    ["nested source", (f) => put(f, "packages/sdk/src/internal/config.ts", ""), /unexpected source path/],
    ["unlisted document", (f) => put(f, "docs/internal-runbook.md", ""), /unexpected source path/],
    ["root pnpm settings", (f) => patch(f, "package.json", (m) => { m.pnpm = { onlyBuiltDependencies: ["left"] }; }), /root manifest field/],
    ["workspace registry", (f) => put(f, "pnpm-workspace.yaml", `${workspaceText(f)}registries:\n  default: https://example.invalid/\n`), /workspace setting/],
    ["workspace build permissions", (f) => put(f, "pnpm-workspace.yaml", `${workspaceText(f)}dangerouslyAllowAllBuilds: true\n`), /workspace setting/],
    ["ranged override", (f) => put(f, "pnpm-workspace.yaml", workspaceText(f).replace(": 2.11.18", ": ^2.11.18")), /exact versions/],
    ["next peer below the floor", (f) => patch(f, next, (m) => { m.peerDependencies.next = ">=15.0.0 <16"; m.devDependencies.next = "15.0.0"; }), /below 16\.3\.8/],
    ["untested next peer floor", (f) => patch(f, next, (m) => { m.peerDependencies.next = ">=16.4.0 <17"; }), /tested version/],
    ["react peer across majors", (f) => patch(f, next, (m) => { m.peerDependencies.react = ">=19.2.8 <99"; }), /within its major/],
  ]) {
    const files = repositoryTree();
    change(files);
    assert.throws(() => inspect(files), expected, label);
  }
});

test("new flat modules, tests, fixtures and guides need no gate change", () => {
  const files = repositoryTree();
  for (const name of ["scripts/new-check.mjs", "scripts/new-check.test.mjs", "scripts/fixtures/new-fixture.ts",
    "packages/sdk/src/new-module.ts", "packages/sdk/bin/new-command.mjs", "packages/next/guides/new-guide.md"])
    put(files, name, "");
  inspect(files);
});

test("archive inspection rejects traversal, duplicate paths, links, truncated bodies and nested modules", () => {
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
    [["package/src/index.ts", ""]],
    [["package/bin/nested/a.mjs", ""]],
    [["package/bin/Upper.mjs", ""]],
    [["package/bin/a.js", ""]],
    [["package/guides/notes.txt", ""]],
    [["package/.npmrc", ""]],
  ])
    assert.throws(() => archiveFiles(tar(entries)));
  for (const name of ["package/bin/new-command.mjs", "package/bin/api-catalog.json", "package/guides/pages.md", "package/dist/pages-client.js"])
    assert.equal(archiveFiles(tar([[name, "x"]])).size, 1);
  assert.throws(() => archiveFiles(gzipSync(Buffer.alloc(512))));
});

test("package commands run frozen install, ordered build/typecheck/pack per package and consumers, then clean up", async () => {
  for (const failure of [null, "install", "build", "typecheck", "pack", "missing-export", "mutated-lock"]) {
    const files = repositoryTree(), packages = inspect(files), calls = [], log = [];
    const { run, work } = stubRun(packages, calls, failure);
    if (failure) await assert.rejects(() => verifyPackages(files, packages, run, undefined, undefined, stubConsumers(log)));
    else {
      const evidence = await verifyPackages(files, packages, run, undefined, undefined, stubConsumers(log));
      assert.deepEqual(calls, ["install", "build", "typecheck", "pack", "build", "typecheck", "pack"]);
      assert.deepEqual(log, ["sdk-consumer", "next-browser", "next-provider", "next-build"]);
      assert.deepEqual(evidence.scopes, ["sdk-scope", "next-browser-scope", "next-provider-scope", "next-build-scope"]);
    }
    assert(work() && !existsSync(work()), "owned working tree must be removed");
  }
});

test("verification binds its receipt to the actual immutable checkout and rejects dirty source", async () => {
  const checkout = mkdtempSync(join(tmpdir(), "commish-public-git-test-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
  const git = (...args) =>
    execFileSync("git", args, { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  try {
    git("init");
    git("config", "core.hooksPath", "/dev/null");
    const files = repositoryTree();
    for (const [name, { data, mode }] of files) {
      mkdirSync(join(checkout, name, ".."), { recursive: true });
      writeFileSync(join(checkout, name), data, { mode: Number.parseInt(mode, 8) & 0o777 });
    }
    git("add", ".");
    git("-c", "user.name=Public verifier test", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgSign=false", "commit", "-m", "fixture");
    const head = git("rev-parse", "HEAD");
    const packages = inspect(files), calls = [], log = [];
    const options = { run: stubRun(packages, calls, null).run, consumers: stubConsumers(log) };
    assert.deepEqual(await verify(checkout, head, undefined, options), {
      sha: head,
      scope: "frozen-install-build-typecheck-pack-exports",
      packages: ["@commish/sdk", "@commish/next"],
      consumerScopes: ["sdk-scope", "next-browser-scope", "next-provider-scope", "next-build-scope"],
      consumerChecks: false,
      publication: false,
    });
    for (const sha of [undefined, "", "a".repeat(40)])
      await assert.rejects(() => verify(checkout, sha, undefined, options), /expected SHA/);
    writeFileSync(join(checkout, "README.md"), "dirty");
    await assert.rejects(() => verify(checkout, head, undefined, options), /must be clean/);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

const reviewWorkflow = readFileSync(
  new URL("../.github/workflows/public-review.yml", import.meta.url),
  "utf8",
);
const admissionScript = reviewWorkflow
  .split("          script: |\n")[1]
  .split("\n")
  .filter((_line, index, lines) =>
    lines.slice(0, index + 1).every((part) => part.startsWith("            ")),
  )
  .map((line) => line.slice(12))
  .join("\n");
const runAdmission = new (Object.getPrototypeOf(async () => {}).constructor)(
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

test("the failure diagnostic names the assertion without printing generated diffs", () => {
  let authored;
  try { assert.equal(1, 2, "unsupported lockfile"); } catch (error) { authored = error; }
  assert.equal(failureDiagnostic(authored),
    "Public source verification failed (ERR_ASSERTION: unsupported lockfile); no acceptance receipt issued.");
  let generated;
  try { assert.equal("secret-bearing actual", "expected"); } catch (error) { generated = error; }
  assert.equal(failureDiagnostic(generated),
    "Public source verification failed (ERR_ASSERTION); no acceptance receipt issued.");
  assert.equal(failureDiagnostic(new Error("ENOENT: /private/path")),
    "Public source verification failed (unknown); no acceptance receipt issued.");
  assert.equal(failureDiagnostic(undefined),
    "Public source verification failed (unknown); no acceptance receipt issued.");
});
