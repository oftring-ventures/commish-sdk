import assert from "node:assert/strict";
import { frameworkRegistryBinHash, verifyFrameworkPackage } from "./verify-framework-package.mjs";
import { nextCommandScope } from "./next-command-scope.mjs";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  frameworkDependencies,
  frameworkLocks,
  frameworkWorkspace,
  frameworkPairWorkspace,
} from "./next-framework-lock.mjs";
import { nextBuildFixture, nextCookieBuildFixture, nextServerBuildFixture } from "./fixtures/next-build.mjs";
import { nextCaptureBuildFixture } from "./fixtures/next-capture.mjs";
import { metadataProbe, nextMetadataScope } from "./verify-next-browser-consumer.mjs";
import {
  inspectNextBuild,
  nextBuildChild as child,
  nextBuildFiles as files,
} from "./inspect-next-build.mjs";

export const nextBuildScope = "next-production-build-external";
export const nextServerBuildScope = "next-server-production-build-external";
export const nextCaptureScope = "next-attribution-capture-request-external";
export const nextCookieScope = "next-cookie-request-context-external";
const hash = (data) => createHash("sha256").update(data).digest("hex");
function registrySnapshot(consumer, locks, pairRoots = []) {
  const store = child(consumer, join(consumer, "node_modules/.pnpm"));
  const seen = new Set(),
    result = [],
    paired = [];
  for (const entry of readdirSync(join(consumer, "node_modules"), {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isSymbolicLink()) child(consumer, join(entry.parentPath, entry.name));
  for (const entry of readdirSync(store, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name !== "node_modules",
  )) {
    const modules = join(store, entry.name, "node_modules");
    const roots = readdirSync(modules, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        entry.name.startsWith("@")
          ? readdirSync(join(modules, entry.name), { withFileTypes: true })
              .filter((item) => item.isDirectory())
              .map((item) => join(modules, entry.name, item.name))
          : [join(modules, entry.name)],
      );
    for (const path of roots) {
      const root = child(consumer, path),
        manifest = JSON.parse(readFileSync(join(root, "package.json")));
      if (["@commish/sdk", "@commish/next"].includes(manifest.name)) {
        paired.push(root);
        continue;
      }
      const id = `${manifest.name}@${manifest.version}`;
      assert(
        locks.registryIds.includes(id) && !seen.has(id),
        "unexpected framework dependency closure",
      );
      seen.add(id);
      result.push([
        id,
        relative(consumer, root),
        files(root)
          .map((file) => [
            relative(root, file),
            relative(root, file).startsWith("node_modules/.bin/")
              ? frameworkRegistryBinHash(consumer, root, relative(root, file).slice(18))
              : hash(readFileSync(file)),
            statSync(file).mode & 0o777,
          ])
          .sort(),
      ]);
    }
  }
  assert.deepEqual(paired.sort(), [...pairRoots].sort(), "unexpected installed pair roots");
  for (const id of locks.requiredIds) assert(seen.has(id), "missing frozen framework dependency");
  return result.sort();
}

// The ordinary gate has already validated the complete pair and every promised target.
export async function verifyNextBuild(sdk, next, context, execute) {
  const manifest = JSON.parse(next.packed.get("package/package.json").data);
  const provider = Object.hasOwn(manifest.exports, "./react");
  const server = Object.hasOwn(manifest.exports, ".") &&
    Object.hasOwn(manifest.peerDependencies ?? {}, "next");
  if (!provider && !server) return [];
  if (provider) assert.deepEqual(manifest.exports["./react"], {
    types: "./dist/provider.d.ts",
    default: "./dist/provider.js",
  });
  if (server) {
    assert.deepEqual(manifest.exports["."], {
      browser: null, types: "./dist/index.d.ts", default: "./dist/index.js",
    }, "unsupported server root");
    assert.deepEqual(manifest.peerDependencies, {
      "@commish/sdk": "0.1.0-beta.9", next: ">=16.2.12 <17", react: ">=19.2.8 <20",
    }, "unsupported server peers");
  }
  const cookieHelpers = next.packed.has("package/dist/metadata.js");
  assert(!cookieHelpers || server, "cookie helpers require the framework server root");
  const capture = next.packed.has("package/dist/capture.js");
  assert(!capture || cookieHelpers, "capture requires cookie helpers");
  const fixture = { ...(provider ? nextBuildFixture : nextServerBuildFixture),
    ...(cookieHelpers ? nextCookieBuildFixture : {}), ...(capture ? nextCaptureBuildFixture : {}) };
  const sdkRoot = JSON.parse(sdk.packed.get("package/package.json").data).exports["."];
  if (sdkRoot?.default !== "./dist/index.js") return [];
  const sources = [context.build, context.checkout].map((path) => realpathSync(path));
  assert(
    readFileSync(join(sources[0], "pnpm-lock.yaml")).equals(context.lock),
    "framework source lock changed",
  );
  const locks = frameworkLocks(context.lock, sdk, next);
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "commish-next-build-")));
  const commands = nextCommandScope();
  execute ??= commands.run;
  let failure;
  try {
    for (const source of sources)
      for (const part of [relative(source, consumer), relative(consumer, source)])
        assert(
          isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`),
          "framework consumer overlaps source",
        );
    const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_DISABLE_COMPILE_CACHE: "1", NODE_ENV: "production" };
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"]) delete env[name];
    const run = (command, args, timeout = 120_000) =>
      execute(command, args, {
        cwd: consumer,
        env,
        encoding: "utf8",
        stdio: "pipe",
        timeout,
        maxBuffer: 2_097_152,
      });
    const writeManifest = (dependencies) =>
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          packageManager: "pnpm@11.1.3",
          dependencies,
        }),
      );
    writeManifest(frameworkDependencies);
    writeFileSync(join(consumer, "pnpm-workspace.yaml"), frameworkWorkspace);
    writeFileSync(join(consumer, "pnpm-lock.yaml"), locks.registry);
    for (const [name, artifact] of [
      ["sdk", sdk],
      ["next", next],
    ])
      writeFileSync(join(consumer, `${name}.tgz`), artifact.archive);
    const install = async (options) => {
      assert.equal((await run("pnpm", ["--version"])).trim(), "11.1.3", "framework pnpm version");
      await run("pnpm", [
        "install",
        "--ignore-scripts",
        "--registry=https://registry.npmjs.org",
        ...options,
      ]);
    };
    await install(["--frozen-lockfile"]);
    assert.equal(
      readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8"),
      locks.registry,
      "framework registry lock changed",
    );
    const registry = registrySnapshot(consumer, locks);
    writeManifest({
      ...frameworkDependencies,
      "@commish/sdk": "file:./sdk.tgz",
      "@commish/next": "file:./next.tgz",
    });
    // A cold offline store cannot reliably reconstruct optional peer metadata.
    // Install the exact projected closure instead of resolving it a second time.
    writeFileSync(join(consumer, "pnpm-lock.yaml"), locks.paired);
    writeFileSync(join(consumer, "pnpm-workspace.yaml"), frameworkPairWorkspace);
    await install(["--offline", "--frozen-lockfile"]);
    assert.equal(
      readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8"),
      locks.paired,
      "framework paired lock differs",
    );
    const pairRoots = ["sdk", "next"].map((name) =>
      child(consumer, join(consumer, "node_modules/@commish", name)),
    );
    const verifyBytes = () => {
      for (const [index, artifact] of [sdk, next].entries()) {
        assert(
          readFileSync(join(consumer, `${index ? "next" : "sdk"}.tgz`)).equals(artifact.archive),
          "framework archive changed",
        );
        verifyFrameworkPackage(consumer, pairRoots[index], artifact, registry);
      }
      assert.deepEqual(
        registrySnapshot(consumer, locks, pairRoots),
        registry,
        "framework registry bytes changed",
      );
    };
    verifyBytes();
    if (server) {
      writeFileSync(join(consumer, "metadata.mjs"), `await (${metadataProbe.toString()})(${cookieHelpers}, ${capture});\n`);
      await run(process.execPath, ["metadata.mjs"]);
      verifyBytes();
    }
    const require = createRequire(join(consumer, "package.json"));
    for (const [name, version] of Object.entries(frameworkDependencies)) {
      const root = child(consumer, dirname(require.resolve(`${name}/package.json`)));
      assert.equal(
        JSON.parse(readFileSync(join(root, "package.json"))).version,
        version,
        "framework version changed",
      );
    }
    const peerRequire = createRequire(join(pairRoots[1], "package.json"));
    for (const name of ["@commish/sdk/browser", "next/navigation.js", "react"])
      assert.equal(
        realpathSync(peerRequire.resolve(name)),
        realpathSync(require.resolve(name)),
        "framework peer identity differs",
      );
    for (const [name, data] of Object.entries(fixture)) {
      mkdirSync(dirname(join(consumer, name)), { recursive: true });
      writeFileSync(join(consumer, name), data);
    }
    const executable = child(consumer, require.resolve("next/dist/bin/next"));
    assert.equal(
      (await run(process.execPath, [executable, "--version"])).trim(),
      "Next.js v16.3.4",
      "wrong framework CLI",
    );
    await run(process.execPath, [executable, "build", "--webpack"], 600_000);
    inspectNextBuild(consumer);
    if (cookieHelpers) {
      await run(process.execPath, ["cookie-probe.mjs"]);
      inspectNextBuild(consumer);
    }
    for (const [name, data] of Object.entries(fixture))
      assert.equal(readFileSync(join(consumer, name), "utf8"), data, "Next build fixture changed");
    verifyBytes();
    assert.equal(
      readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8"),
      locks.paired,
      "framework lock changed during build",
    );
    assert.equal(
      readFileSync(join(consumer, "pnpm-workspace.yaml"), "utf8"),
      frameworkPairWorkspace,
      "framework workspace changed",
    );
    assert(
      readFileSync(join(sources[0], "pnpm-lock.yaml")).equals(context.lock),
      "framework source lock changed",
    );
    return [provider ? nextBuildScope : nextServerBuildScope, ...(server ? [nextMetadataScope] : []),
      ...(cookieHelpers ? [nextCookieScope] : []), ...(capture ? [nextCaptureScope] : [])];
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await commands.close(() => rmSync(consumer, { recursive: true, force: true }), failure);
  }
}
