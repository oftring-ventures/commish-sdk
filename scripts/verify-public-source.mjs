import { nodeVersion, pnpmVersion } from "./toolchain.mjs";
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
import {
  inspectLockfile,
  inspectPackageManifest,
  inspectRootManifest,
  inspectWorkspace,
  packageNames,
} from "./package-shape.mjs";
import { licenseHash, publicPackageManifests } from "./public-package-manifest.mjs";
import { candidateDirectory, normalizePackage, writeCandidate } from "./public-candidate.mjs";
import { verifySdkBrowserConsumer } from "./verify-sdk-browser-consumer.mjs";
import {
  verifyNextBrowserConsumer,
  verifyNextProviderConsumer,
} from "./verify-next-browser-consumer.mjs";

// The tree is verified by shape: files may be added under the allowed paths, but
// the release gate, the toolchain declaration and the pair's manifests must keep
// these properties.
const required = [
  ".gitignore",
  "LICENSE",
  "README.md",
  ".node-version",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".github/workflows/public-source.yml",
  ".github/workflows/public-review.yml",
  ".github/workflows/public-review-merge-group.yml",
  ".github/workflows/publish-packages.yml",
  "scripts/verify-public-source.mjs",
  "scripts/verify-public-source.test.mjs",
  "scripts/publication-workflow.test.mjs",
];
// Paths a change may add without editing this gate: flat modules, fixtures and
// guides under fixed directories. Any other path (another workflow or action,
// install or registry configuration such as .npmrc or .pnpmfile.cjs, nested or
// unlisted files) needs a reviewed change to this list.
const allowedPaths = [
  /^(?:\.gitignore|\.node-version|LICENSE|README\.md|RELEASING\.md|package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/,
  /^\.github\/workflows\/(?:public-source|public-review|public-review-merge-group|publish-packages)\.yml$/,
  /^scripts\/[a-z0-9-]+(?:\.test)?\.mjs$/,
  /^scripts\/fixtures\/[a-z0-9-]+\.(?:mjs|ts|tsx|txt)$/,
  /^packages\/(?:sdk|next)\/(?:LICENSE|README\.md|package\.json|build\.mjs|tsconfig\.build\.json)$/,
  /^packages\/(?:sdk|next)\/(?:src\/[a-z0-9-]+\.tsx?|bin\/[a-z0-9-]+\.(?:mjs|json))$/,
  /^packages\/next\/guides\/[a-z0-9-]+\.md$/,
];
const sha = (data) => createHash("sha256").update(data).digest("hex");
const bytes = (files, name) => {
  assert(files.has(name), `missing required file ${name}`);
  return files.get(name).data;
};
const json = (files, name) => JSON.parse(bytes(files, name));
const defaultConsumers = {
  sdk: verifySdkBrowserConsumer,
  nextBrowser: verifyNextBrowserConsumer,
  nextProvider: verifyNextProviderConsumer,
  nextBuild: verifyNextBuild,
};

export function inspect(files) {
  for (const [name, file] of files) {
    assert(!name.split("/").some((part) => ["", ".", ".."].includes(part)), "unsafe source path");
    assert.equal(
      file.mode,
      /^packages\/(sdk|next)\/bin\/init\.mjs$/.test(name) ? "100755" : "100644",
      "invalid source mode",
    );
    if (name.startsWith("packages/"))
      assert(packageNames.includes(name.split("/")[1]), "orphan package source");
    assert(allowedPaths.some((pattern) => pattern.test(name)), `unexpected source path ${name}`);
  }
  for (const name of required) bytes(files, name);
  assert.equal(sha(bytes(files, "LICENSE")), licenseHash, "MIT license differs");
  assert.equal(bytes(files, ".node-version").toString().trim(), nodeVersion, "source .node-version differs from the toolchain");
  inspectRootManifest(json(files, "package.json"), pnpmVersion);
  inspectWorkspace(bytes(files, "pnpm-workspace.yaml").toString());
  inspectLockfile(bytes(files, "pnpm-lock.yaml").toString());
  return packageNames.map((pkg) => {
    const dir = `packages/${pkg}`;
    for (const name of ["LICENSE", "README.md", "build.mjs", "tsconfig.build.json", "src/index.ts", "src/browser.ts"])
      bytes(files, `${dir}/${name}`);
    assert.equal(sha(bytes(files, `${dir}/LICENSE`)), licenseHash, "package MIT license differs");
    const manifest = json(files, `${dir}/package.json`);
    const has = (stem) => files.has(`${dir}/src/${stem}.ts`) || files.has(`${dir}/src/${stem}.tsx`);
    const { targets } = inspectPackageManifest(pkg, manifest, has);
    assert(bytes(files, `${dir}/bin/init.mjs`).toString().startsWith("#!/usr/bin/env node\n"), "entry point must start with the node shebang");
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
    // Only the manifest, documentation, built output, flat CLI modules and shipped guides.
    assert(
      /^package\/(?:package\.json|README\.md|LICENSE|dist\/[a-zA-Z0-9_.-]+|bin\/[a-z0-9-]+\.(?:mjs|json)|guides\/[a-z-]+\.md)$/.test(name) &&
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

export async function verifyPackages(files, packages, run, checkout = process.cwd(), releaseManifests, consumers = defaultConsumers) {
  const artifacts = [];
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
      let archive = readFileSync(join(destination, archives[0]));
      let packed = archiveFiles(archive);
      const packedManifest = JSON.parse(bytes(packed, "package/package.json"));
      assert.equal(packedManifest.name, manifest.name);
      assert.equal(packedManifest.version, manifest.version);
      assert.deepEqual(packedManifest.exports, manifest.exports);
      assert.deepEqual(packedManifest.bin, manifest.bin);
      assert(!packedManifest.scripts?.prepack, "prepack must not ship");
      for (const target of targets) {
        const entry = packed.get(`package/${target.slice(2)}`);
        assert(
          entry?.data.equals(readFileSync(join(cwd, target))),
          "declared target is missing or changed in archive",
        );
        assert.equal(
          entry.mode & 0o777,
          target.startsWith("./bin/") ? 0o755 : 0o644,
          "invalid packed target mode",
        );
      }
      if (releaseManifests) {
        ({ archive, packed } = normalizePackage(files, dir, releaseManifests[artifacts.length],
          packed, work, run, archiveFiles));
        artifacts.push({ archive, packed });
      }
      const context = {
        build: realpathSync(work),
        checkout: realpathSync(checkout),
        lock: Buffer.from(bytes(files, "pnpm-lock.yaml")),
      };
      if (manifest.name === "@commish/sdk") {
        sdkArchive = { archive, packed };
        evidence = consumers.sdk(archive, packed, run, context);
      } else {
        assert(sdkArchive, "Next browser consumer requires the verified SDK pair");
        evidence.scopes.push(...consumers.nextBrowser(sdkArchive, { archive, packed }, context));
        evidence.scopes.push(...consumers.nextProvider(sdkArchive, { archive, packed }, context));
        evidence.scopes.push(...(await consumers.nextBuild(sdkArchive, { archive, packed }, context)));
      }
    }
    for (const [name, file] of files)
      assert(
        readFileSync(join(work, name)).equals(file.data),
        "source or lock changed during verification",
      );
    return { ...evidence, ...(releaseManifests ? { artifacts } : {}) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function verify(root, expectedSha, candidateOutput, {
  run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit", timeout: 600_000 }),
  consumers = defaultConsumers,
} = {}) {
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
  assert.equal(process.versions.node, nodeVersion, "Node differs from .node-version");
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
  const output = candidateOutput === undefined ? undefined : candidateDirectory(root, candidateOutput);
  const releaseManifests = output ? publicPackageManifests(files) : undefined;
  assert.equal(
    execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    pnpmVersion,
    "pnpm differs from the root packageManager",
  );
  const evidence = await verifyPackages(files, packages, run, root, releaseManifests, consumers);
  assert.equal(git("rev-parse", "HEAD").toString().trim(), head, "source HEAD changed during verification");
  assert.equal(git("status", "--porcelain", "--untracked-files=all").length, 0, "source changed during verification");
  const candidate = output ? writeCandidate(root, output, head, evidence.artifacts, evidence.scopes,
    releaseManifests, archiveFiles) : undefined;
  return {
    sha: head,
    scope: "frozen-install-build-typecheck-pack-exports",
    packages: packages.map(({ manifest }) => manifest.name),
    consumerScopes: evidence.scopes,
    ...(evidence.typeCompiler ? { typeCompiler: evidence.typeCompiler } : {}),
    consumerChecks: false,
    publication: false,
    ...(candidate ? { candidate } : {}),
  };
}

// Command output and file bytes may carry paths or key material, so only the error
// code and an author-written assertion message are shown, never Node's generated diff.
export function failureDiagnostic(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "unknown";
  const reason = error instanceof assert.AssertionError && error.generatedMessage === false
    ? `: ${error.message.split("\n", 1)[0]}` : "";
  return `Public source verification failed (${code}${reason}); no acceptance receipt issued.`;
}

if (import.meta.main) {
  try {
    assert(process.argv.length <= 3, "unexpected verifier arguments");
    console.log(JSON.stringify(await verify(process.cwd(), process.env.EXPECTED_SHA, process.argv[2])));
  } catch (error) {
    console.error(failureDiagnostic(error));
    process.exitCode = 1;
  }
}
