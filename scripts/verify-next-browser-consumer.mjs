import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

export const nextBrowserScope = "next-browser-node-bridge";
const pair = (name, server = false) => ({
  ...(server ? { browser: null } : {}),
  types: `./dist/${name}.d.ts`,
  default: `./dist/${name}.js`,
});
function inside(root, path) {
  const actual = realpathSync(path),
    part = relative(root, actual);
  assert(
    part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`),
    "Next consumer escaped its owned root",
  );
  return actual;
}
async function probe() {
  const { default: assert } = await import("node:assert/strict");
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const sdk = await import("@commish/sdk/browser"),
    bridge = await import("@commish/next/browser");
  assert.deepEqual(Object.keys(bridge), ["captureReferral"], "Next browser export names");
  assert.equal(typeof bridge.captureReferral, "function", "Next browser function");
  assert.equal(bridge.captureReferral, sdk.captureReferral, "Next browser identity");
  assert.equal(
    realpathSync(
      createRequire(import.meta.resolve("@commish/next/browser")).resolve("@commish/sdk/browser"),
    ),
    realpathSync(new URL(import.meta.resolve("@commish/sdk/browser"))),
    "Next browser SDK peer identity",
  );
  for (const name of [
    "@commish/sdk",
    "@commish/sdk/webhooks",
    "@commish/next",
    "@commish/next/dist/browser.js",
  ])
    await assert.rejects(import(name), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}

// Both archives and their maps have passed the caller's exact archive/target validation.
export function verifyNextBrowserConsumer(sdk, next, context, execute = execFileSync) {
  assert(context, "missing paired consumer source context");
  const sources = [context.build, context.checkout].map((path) => realpathSync(path));
  const manifests = [sdk, next].map(({ packed }) =>
    JSON.parse(packed.get("package/package.json").data),
  );
  for (const [index, manifest] of manifests.entries()) {
    assert.equal(manifest.name, index ? "@commish/next" : "@commish/sdk");
    assert.equal(manifest.version, "0.1.0-beta.9");
    for (const field of ["dependencies", "optionalDependencies"])
      assert.deepEqual(manifest[field] ?? {}, {}, "unexpected paired runtime dependency");
    assert.deepEqual(manifest.exports["./browser"], pair("browser"));
  }
  assert.deepEqual(manifests[0].peerDependencies ?? {}, {});
  const exports = { "./browser": pair("browser") },
    peers = { "@commish/sdk": manifests[0].version };
  if (Object.hasOwn(manifests[1].exports, ".")) exports["."] = pair("index", true);
  if (Object.hasOwn(manifests[1].exports, "./react")) {
    exports["./react"] = pair("provider");
    Object.assign(peers, { next: ">=16.2.12 <17", react: ">=19.2.8 <20" });
  }
  assert.deepEqual(manifests[1].exports, exports, "unsupported Next export tuple");
  assert.deepEqual(manifests[1].peerDependencies, peers, "unexpected Next peers");
  for (const [index, { packed }] of [sdk, next].entries())
    for (const target of [
      ...Object.values(manifests[index].exports).flatMap(Object.values),
      ...Object.values(manifests[index].bin ?? {}),
    ].filter((value) => typeof value === "string"))
      assert(packed.has(`package/${target.slice(2)}`), "missing promised paired artifact");
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "commish-next-browser-consumer-")));
  try {
    for (const source of sources) {
      const part = relative(source, consumer),
        reverse = relative(consumer, source);
      const outside = (path) => isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
      assert(outside(part) && outside(reverse), "paired consumer overlaps source");
    }
    const run = (command, args) =>
      execute(command, args, {
        cwd: consumer,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 120_000,
        maxBuffer: 1_048_576,
      });
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        packageManager: "pnpm@11.1.3",
        dependencies: { "@commish/sdk": "file:./sdk.tgz", "@commish/next": "file:./next.tgz" },
      }),
    );
    writeFileSync(join(consumer, "sdk.tgz"), sdk.archive);
    writeFileSync(join(consumer, "next.tgz"), next.archive);
    assert.equal(run("pnpm", ["--version"]).trim(), "11.1.3", "paired consumer pnpm version");
    run("pnpm", [
      "install",
      "--offline",
      "--ignore-scripts",
      "--ignore-workspace",
      "--config.auto-install-peers=false",
    ]);
    const modules = join(consumer, "node_modules"),
      store = join(modules, ".pnpm");
    assert.deepEqual(
      readdirSync(modules).filter((name) => !name.startsWith(".")),
      ["@commish"],
    );
    assert.deepEqual(readdirSync(join(modules, "@commish")).sort(), ["next", "sdk"]);
    const installed = ["sdk", "next"].map((name) =>
      inside(consumer, join(modules, "@commish", name)),
    );
    const expected = installed
      .map((path) => relative(realpathSync(store), path).split(sep)[0])
      .sort();
    assert.equal(new Set(expected).size, 2, "paired packages must be separate artifacts");
    assert.deepEqual(
      readdirSync(store, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
        .map((entry) => entry.name)
        .sort(),
      expected,
      "unexpected paired dependency closure",
    );
    const checkBytes = () => {
      for (const [index, { packed }] of [sdk, next].entries())
        for (const [name, entry] of packed) {
          const path = inside(consumer, join(installed[index], name.slice(8)));
          assert(readFileSync(path).equals(entry.data), "paired installed artifact differs");
          assert.equal(
            statSync(path).mode & 0o777,
            entry.mode & 0o777,
            "paired installed mode differs",
          );
        }
    };
    checkBytes();
    writeFileSync(join(consumer, "probe.mjs"), `await (${probe.toString()})();\n`);
    run(process.execPath, ["--conditions=browser", "probe.mjs"]);
    checkBytes();
    return [nextBrowserScope];
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}
