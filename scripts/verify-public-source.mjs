import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { verifyNextBuild } from "./verify-next-build.mjs";
import { verifySdkBrowserConsumer } from "./verify-sdk-browser-consumer.mjs";
import {
  verifyNextBrowserConsumer,
  verifyNextProviderConsumer,
} from "./verify-next-browser-consumer.mjs";

const automation = [
  ".github/workflows/public-source.yml",
  ".github/workflows/public-review.yml",
  ".github/workflows/public-review-merge-group.yml",
  "scripts/verify-public-source.mjs",
  "scripts/verify-public-source.test.mjs",
  "scripts/next-metadata.test.mjs",
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
  "scripts/verify-framework-package.mjs",
  "scripts/verify-framework-package.test.mjs",
  "scripts/fixtures/next-peer-bin.txt",
  "scripts/verify-next-build.mjs",
  "scripts/verify-next-build.test.mjs",
  "scripts/next-framework-lock.mjs",
  "scripts/fixtures/next-build.mjs",
  "scripts/fixtures/next-capture.mjs",
  "scripts/fixtures/next-provider.mjs",
  "scripts/fixtures/next-cli.mjs",
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
];
const bootstrap = {
  ".gitignore": "e8e70120c7fb8891ed746bb896e739a62f7f6ea1df6225461506760c146f6614",
  LICENSE: "03f0077d06d3281e364be7f1cbb440d6996c65d3a6a19a73de41a7c6d02be702",
  "README.md": "e54066163aa6be032484c7193f096cbcd0d9a57b55d65a9b4d4c8bc27382972e",
};
const roots = [...Object.keys(bootstrap), "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
const common = ["package.json", "LICENSE", "README.md", "build.mjs", "tsconfig.build.json"];
const sources = {
  sdk: ["browser", "types", "webhooks", "index", "reads"],
  next: ["browser", "provider", "index", "metadata", "capture"],
};
const sha = (data) => createHash("sha256").update(data).digest("hex");
const bytes = (files, name) => {
  assert(files.has(name), "missing required file");
  return files.get(name).data;
};
const json = (files, name) => JSON.parse(bytes(files, name));
const pair = (name, server = false) => ({
  ...(server ? { browser: null } : {}),
  types: `./dist/${name}.d.ts`,
  default: `./dist/${name}.js`,
});

export function inspect(files) {
  const allowed = new Set([
    ...roots,
    ...automation,
    "packages/next/bin/init.mjs",
    ...Object.entries(sources).flatMap(([pkg, names]) =>
      [...common, ...names.map((name) => `src/${name}.${name === "provider" ? "tsx" : "ts"}`)].map(
        (name) => `packages/${pkg}/${name}`,
      ),
    ),
  ]);
  for (const [name, file] of files) {
    assert(allowed.has(name), "unexpected source path");
    assert.equal(
      file.mode,
      name === "packages/next/bin/init.mjs" ? "100755" : "100644",
      "invalid source mode",
    );
  }
  for (const name of automation) bytes(files, name);
  if (!files.has("package.json")) {
    assert.equal(files.size, automation.length + 3, "incomplete package tree is not bootstrap");
    for (const [name, hash] of Object.entries(bootstrap))
      assert.equal(sha(bytes(files, name)), hash, "bootstrap bytes differ");
    return [];
  }
  for (const name of roots) bytes(files, name);
  const packages = files.has("packages/next/package.json") ? ["sdk", "next"] : ["sdk"];
  const expectedBuild = packages.map((name) => `pnpm --filter @commish/${name} build`).join(" && ");
  assert.deepEqual(
    json(files, "package.json"),
    {
      name: "commish-public-packages",
      private: true,
      packageManager: "pnpm@11.1.3",
      engines: { node: ">=24 <25" },
      scripts: { build: expectedBuild },
    },
    "unsupported root manifest",
  );
  const react = files.has("packages/next/src/provider.tsx");
  const framework = packages.includes("next") &&
    Object.hasOwn(json(files, "packages/next/package.json").devDependencies ?? {}, "next");
  assert(!react || framework, "Next provider requires its framework dependencies");
  const workspace = `packages:\n${packages.map((name) => `  - packages/${name}\n`).join("")}engineStrict: true\n${framework ? "overrides:\n  baseline-browser-mapping: 2.11.18\n  caniuse-lite: 1.0.30001809\n" : ""}`;
  assert.equal(
    bytes(files, "pnpm-workspace.yaml").toString(),
    workspace,
    "unsupported workspace configuration",
  );
  const expectedLock =
    packages.length === 1
      ? "7e23bad69c9b8a88d53fc992196178aecdef08a6311e54752201de147b1314f2"
      : framework
        ? "81c9949580d3ed18cfe1c75e3616ef666f403b127a08c39e6899546b6d871f7b"
        : "0c15096dcc1644b3d0e3fd288da4ab13ddef54d9b609bc2a8547cc9d7d88bc3f";
  assert.equal(sha(bytes(files, "pnpm-lock.yaml")), expectedLock, "unsupported lockfile");
  for (const name of files.keys())
    if (name.startsWith("packages/"))
      assert(packages.includes(name.split("/")[1]), "orphan package source");
  return packages.map((pkg) => {
    const dir = `packages/${pkg}`;
    for (const name of common.filter((name) => name !== "README.md"))
      bytes(files, `${dir}/${name}`);
    bytes(files, `${dir}/src/browser.ts`);
    const manifest = json(files, `${dir}/package.json`);
    assert.equal(manifest.name, `@commish/${pkg}`);
    assert.equal(manifest.version, "0.1.0-beta.9");
    assert.equal(manifest.type, "module");
    assert.deepEqual(
      manifest.scripts,
      {
        build: "node build.mjs",
        prepack: "pnpm build",
        typecheck: "tsc -p tsconfig.build.json --noEmit",
      },
      "unexpected lifecycle command",
    );
    assert(
      !manifest.dependencies && !manifest.optionalDependencies,
      "unexpected production dependencies",
    );
    const dev = { typescript: "5.9.2", "@types/node": "24.13.3" };
    const peers = {};
    if (pkg === "next") {
      dev["@commish/sdk"] = "workspace:*";
      peers["@commish/sdk"] = manifest.version;
    }
    if (pkg === "next" && framework) {
      Object.assign(dev, {
        next: "16.3.4",
        react: "19.2.8",
        "react-dom": "19.2.8",
        "@types/react": "19.2.18",
        "@types/react-dom": "19.2.5",
      });
      Object.assign(peers, { next: ">=16.2.12 <17", react: ">=19.2.8 <20" });
    }
    assert.deepEqual(manifest.devDependencies, dev, "unsupported development dependencies");
    assert.deepEqual(manifest.peerDependencies ?? {}, peers, "unsupported peer dependencies");
    const exports = { "./browser": pair("browser") };
    const has = (name) => files.has(`${dir}/src/${name}.ts`);
    if (has("index")) {
      exports["."] = pair("index", true);
      if (pkg === "sdk") {
        bytes(files, `${dir}/src/reads.ts`);
        bytes(files, `${dir}/src/types.ts`);
      }
    } else if (pkg === "sdk" && has("types")) exports["."] = pair("types", true);
    if (pkg === "sdk" && has("webhooks")) exports["./webhooks"] = pair("webhooks", true);
    if (pkg === "next" && react) exports["./react"] = pair("provider");
    assert.deepEqual(manifest.exports, exports, "exports do not match present source");
    const bin =
      pkg === "next" && files.has(`${dir}/bin/init.mjs`)
        ? { "commish-next": "./bin/init.mjs" }
        : undefined;
    if (bin) assert(has("index"), "Next CLI requires its server source");
    assert.deepEqual(manifest.bin, bin, "bin does not match present source");
    if (bin) bytes(files, `${dir}/bin/init.mjs`);
    if (pkg === "next" && has("metadata"))
      assert(has("index") && framework, "Next metadata module requires its framework server root");
    if (pkg === "next" && has("capture"))
      assert(has("metadata") && has("index") && framework, "Next capture requires its cookie helpers");
    const targets = [
      ...Object.values(exports).flatMap(Object.values),
      ...Object.values(bin ?? {}),
    ].filter((value) => typeof value === "string");
    return { dir, manifest, targets };
  });
}

export function archiveFiles(compressed) {
  const tar = gunzipSync(compressed, { maxOutputLength: 10_000_000 });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length && tar[offset]) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, "");
    const name = field(0, 100),
      size = Number.parseInt(field(124, 12).trim(), 8);
    const mode = Number.parseInt(field(100, 8).trim(), 8);
    assert(
      /^(package\/(?:dist\/)?[a-zA-Z0-9_.-]+|package\/bin\/init.mjs)$/.test(name) &&
        !files.has(name),
      "unsafe archive entry",
    );
    assert(
      !name.split("/").some((segment) => segment === "." || segment === ".."),
      "archive dot segment",
    );
    assert(
      (header[156] === 0 || header[156] === 48) && field(345, 155) === "",
      "unsupported archive entry type",
    );
    assert(
      Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length,
      "invalid archive length",
    );
    files.set(name, { data: tar.subarray(offset + 512, offset + 512 + size), mode });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(
    tar.subarray(offset).length >= 1024 && tar.subarray(offset).every((byte) => byte === 0),
    "invalid archive terminator",
  );
  return files;
}

export async function verifyPackages(files, packages, run, checkout = process.cwd()) {
  let evidence = { scopes: [] },
    sdkArchive;
  const work = mkdtempSync(join(tmpdir(), "commish-public-source-"));
  try {
    for (const [name, file] of files) {
      mkdirSync(join(work, name, ".."), { recursive: true });
      writeFileSync(join(work, name), file.data, { mode: Number.parseInt(file.mode, 8) & 0o777 });
    }
    run(
      "pnpm",
      ["install", "--frozen-lockfile", "--ignore-scripts", "--registry=https://registry.npmjs.org"],
      work,
    );
    for (const { dir, manifest, targets } of packages) {
      const cwd = join(work, dir),
        destination = join(work, "packed", dir);
      mkdirSync(destination, { recursive: true });
      run("pnpm", ["build"], cwd);
      run("pnpm", ["typecheck"], cwd);
      run("pnpm", ["pack", "--pack-destination", destination], cwd);
      const archives = readdirSync(destination);
      assert.equal(archives.length, 1, "expected one package archive");
      const archive = readFileSync(join(destination, archives[0]));
      const packed = archiveFiles(archive);
      const packedManifest = JSON.parse(bytes(packed, "package/package.json"));
      assert.equal(packedManifest.name, manifest.name);
      assert.equal(packedManifest.version, manifest.version);
      assert.deepEqual(packedManifest.exports, manifest.exports);
      assert.deepEqual(packedManifest.bin, manifest.bin);
      assert(!packedManifest.scripts?.prepack, "prepack must not ship");
      for (const target of targets) {
        const entry = packed.get(`package/${target.slice(2)}`);
        assert(
          entry && entry.data.equals(readFileSync(join(cwd, target))),
          "declared target is missing or changed in archive",
        );
        assert.equal(
          entry.mode & 0o777,
          target.startsWith("./bin/") ? 0o755 : 0o644,
          "invalid packed target mode",
        );
      }
      if (manifest.name === "@commish/sdk") {
        sdkArchive = { archive, packed };
        evidence = verifySdkBrowserConsumer(archive, packed, run, {
          build: realpathSync(work),
          checkout: realpathSync(checkout),
          lock: Buffer.from(bytes(files, "pnpm-lock.yaml")),
        });
      } else {
        assert(sdkArchive, "Next browser consumer requires the verified SDK pair");
        evidence.scopes.push(
          ...verifyNextBrowserConsumer(
            sdkArchive,
            { archive, packed },
            {
              build: realpathSync(work),
              checkout: realpathSync(checkout),
              lock: Buffer.from(bytes(files, "pnpm-lock.yaml")),
            },
          ),
        );
        evidence.scopes.push(
          ...verifyNextProviderConsumer(
            sdkArchive,
            { archive, packed },
            {
              build: realpathSync(work),
              checkout: realpathSync(checkout),
              lock: Buffer.from(bytes(files, "pnpm-lock.yaml")),
            },
          ),
        );
        evidence.scopes.push(
          ...(await verifyNextBuild(
            sdkArchive,
            { archive, packed },
            {
              build: realpathSync(work),
              checkout: realpathSync(checkout),
              lock: Buffer.from(bytes(files, "pnpm-lock.yaml")),
            },
          )),
        );
      }
    }
    for (const [name, file] of files)
      assert(
        readFileSync(join(work, name)).equals(file.data),
        "source or lock changed during verification",
      );
    return evidence;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function verify(root, expectedSha) {
  const git = (...args) => execFileSync("git", args, { cwd: root });
  const head = git("rev-parse", "HEAD").toString().trim();
  assert(
    /^[a-f0-9]{40}$/.test(expectedSha ?? "") && head === expectedSha,
    "checked-out SHA does not match expected SHA",
  );
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all").length,
    0,
    "source checkout must be clean",
  );
  assert.equal(process.versions.node, "24.15.0", "Node must be 24.15.0");
  const files = new Map(
    git("ls-tree", "-rz", "HEAD")
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const [metadata, name] = entry.split("\t"),
          [mode, type, oid] = metadata.split(" ");
        assert.equal(type, "blob", "source must contain only regular files");
        return [name, { mode, data: git("cat-file", "blob", oid) }];
      }),
  );
  const packages = inspect(files);
  let evidence = { scopes: [] };
  if (packages.length) {
    assert.equal(
      execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      "11.1.3",
      "pnpm must be 11.1.3",
    );
    evidence = await verifyPackages(
      files,
      packages,
      (command, args, cwd) =>
        execFileSync(command, args, { cwd, stdio: "inherit", timeout: 600_000 }),
      root,
    );
  }
  return {
    sha: head,
    scope: packages.length
      ? "frozen-install-build-typecheck-pack-exports"
      : "exact-bootstrap-and-automation",
    packages: packages.map(({ manifest }) => manifest.name),
    consumerScopes: evidence.scopes,
    ...(evidence.typeCompiler ? { typeCompiler: evidence.typeCompiler } : {}),
    consumerChecks: false,
    publication: false,
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await verify(process.cwd(), process.env.EXPECTED_SHA)));
  } catch {
    console.error("Public source verification failed; no acceptance receipt issued.");
    process.exitCode = 1;
  }
}
