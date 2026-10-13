import { releaseVersion } from "./stable-release.mjs";
import assert from "node:assert/strict";
import { pnpmVersion } from "./toolchain.mjs";
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

import { verifyNextBrowserTypes, verifyNextProviderTypes } from "./verify-next-types.mjs";
import { readProviderTypeInputs, providerTypesLock } from "./provider-types-lock.mjs";
import { peerAllows } from "./package-shape.mjs";

export const nextBrowserScope = "next-browser-node-bridge";
export const nextMetadataScope = "next-metadata-installed-node";
export const nextProviderLayoutScope = "next-provider-types-layout";
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

export async function metadataProbe(cookieHelpers = false, capture = false) {
  const { default: assert } = await import("node:assert/strict");
  const root = await import("@commish/next");
  assert.deepEqual(Object.keys(root), [
    ...(capture ? ["COMMISH_COOKIE"] : []), "applyCommishStripeMetadata",
    ...(capture ? ["createAttributionHandler"] : []),
    ...(cookieHelpers ? ["getCommishAttribution", "withCommishStripeMetadata"] : []),
  ], "Next root export names");
  if (capture) {
    assert.equal(root.COMMISH_COOKIE, "commish_attribution");
    await assert.rejects(() => root.createAttributionHandler({ apiUrl: "http://127.0.0.1:1" })(
      new Request("http://consumer.test", { method: "POST", body: "{}",
        headers: { "x-commish-capture-id": "a".repeat(32) } })), /request scope/);
  }
  if (cookieHelpers) {
    await assert.rejects(() => root.getCommishAttribution(), /request scope/);
    await assert.rejects(() => root.withCommishStripeMetadata({}), /request scope/);
  }
  const apply = root.applyCommishStripeMetadata;
  for (const mode of ["payment", "subscription"]) {
    const input = Object.freeze({
      mode,
      client_reference_id: "customer_1",
      metadata: Object.freeze({ order: "keep" }),
      subscription_data: Object.freeze({
        trial_period_days: 14,
        metadata: Object.freeze({ source: "keep" }),
      }),
    });
    assert.equal(apply(input, null), input);
    assert.deepEqual(
      apply(input, "attribution_1"),
      {
        ...input,
        metadata: { order: "keep", commish_attribution: "attribution_1" },
        subscription_data:
          mode === "payment"
            ? input.subscription_data
            : {
                trial_period_days: 14,
                metadata: {
                  source: "keep",
                  commish_attribution: "attribution_1",
                  commish_customer_id: "customer_1",
                },
              },
      },
      "Next installed metadata behavior",
    );
  }
}

// Both archives and their maps have passed the caller's exact archive/target validation.
export function verifyNextBrowserConsumer(...args) {
  return verifyNextConsumer(false, ...args);
}
export function verifyNextProviderConsumer(...args) {
  return verifyNextConsumer(true, ...args);
}
function verifyNextConsumer(provider, sdk, next, context, execute = execFileSync) {
  assert(context, "missing paired consumer source context");
  const sources = [context.build, context.checkout].map((path) => realpathSync(path));
  const manifests = [sdk, next].map(({ packed }) =>
    JSON.parse(packed.get("package/package.json").data),
  );
  for (const [index, manifest] of manifests.entries()) {
    assert.equal(manifest.name, index ? "@commish/next" : "@commish/sdk");
    assert.equal(manifest.version, releaseVersion);
    for (const field of ["dependencies", "optionalDependencies"])
      assert.deepEqual(manifest[field] ?? {}, {}, "unexpected paired runtime dependency");
    const browser = manifest.exports["./browser"];
    assert(browser && !Object.hasOwn(browser, "browser") && browser.types === "./dist/browser.d.ts" &&
      browser.default === "./dist/browser.js", "unsupported browser entry");
  }
  assert.deepEqual(manifests[0].peerDependencies ?? {}, {});
  // The source gate validated the full export shape; the paired consumer re-checks the
  // properties its probes rely on: secret-bearing entries stay out of browsers and the
  // peers name the released SDK and bounded framework ranges.
  const nextExports = manifests[1].exports;
  for (const entry of Object.keys(nextExports)) {
    assert(["./browser", ".", "./react", "./pages", "./pages/handlers", "./pages/routing"].includes(entry),
      "unsupported Next export tuple");
    if (["./browser", "./react"].includes(entry)) assert(!Object.hasOwn(nextExports[entry], "browser"), "unsupported Next export tuple");
    else assert.equal(nextExports[entry].browser, null, "unsupported Next export tuple");
  }
  const peers = manifests[1].peerDependencies ?? {};
  const range = /^>=\d+\.\d+\.\d+ <\d+$/;
  assert(peerAllows(peers["@commish/sdk"], manifests[0].version), "unexpected Next peers");
  for (const name of Object.keys(peers))
    assert(name === "@commish/sdk" || (["next", "react"].includes(name) && range.test(peers[name])), "unexpected Next peers");
  if (Object.hasOwn(nextExports, "./react"))
    assert(Object.hasOwn(peers, "next"), "provider framework peer missing");
  for (const [index, { packed }] of [sdk, next].entries())
    for (const target of [
      ...Object.values(manifests[index].exports).flatMap(Object.values),
      ...Object.values(manifests[index].bin ?? {}),
    ].filter((value) => typeof value === "string"))
      assert(packed.has(`package/${target.slice(2)}`), "missing promised paired artifact");
  if (provider && !Object.hasOwn(manifests[1].exports, "./react")) return [];
  if (provider)
    assert(
      readFileSync(join(context.build, "pnpm-lock.yaml")).equals(context.lock),
      "provider source lock changed",
    );
  const locks = provider ? providerTypesLock(sdk, next, context.lock) : null;
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
    const pairDependencies = {
      "@commish/sdk": "file:./sdk.tgz",
      "@commish/next": "file:./next.tgz",
    };
    const writeManifest = (dependencies) =>
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          packageManager: `pnpm@${pnpmVersion}`,
          dependencies,
        }),
      );
    writeManifest(provider ? locks.dependencies : pairDependencies);
    writeFileSync(join(consumer, "sdk.tgz"), sdk.archive);
    writeFileSync(join(consumer, "next.tgz"), next.archive);
    const common = ["--ignore-scripts", "--ignore-workspace", "--config.auto-install-peers=false"];
    const checkVersion = () =>
      assert.equal(run("pnpm", ["--version"]).trim(), pnpmVersion, "paired consumer pnpm version");
    checkVersion();
    let originalTypes;
    if (provider) {
      writeFileSync(join(consumer, "pnpm-lock.yaml"), locks.registry);
      run("pnpm", [
        "install",
        "--frozen-lockfile",
        "--registry=https://registry.npmjs.org",
        ...common,
      ]);
      assert.equal(
        readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8"),
        locks.registry,
        "provider registry lock changed",
      );
      originalTypes = readProviderTypeInputs(consumer, locks.dependencies);
      writeManifest({ ...pairDependencies, ...locks.dependencies });
      checkVersion();
      run("pnpm", ["install", "--offline", "--no-frozen-lockfile", ...common]);
      assert.equal(
        readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8"),
        locks.paired,
        "provider paired lock differs",
      );
      assert.deepEqual(
        readProviderTypeInputs(consumer, locks.dependencies),
        originalTypes,
        "provider types changed during extension",
      );
    } else run("pnpm", ["install", "--offline", ...common]);
    const modules = join(consumer, "node_modules"),
      store = join(modules, ".pnpm");
    assert.deepEqual(
      readdirSync(modules)
        .filter((name) => !name.startsWith("."))
        .sort(),
      provider ? ["@commish", "@types", "csstype"] : ["@commish"],
    );
    assert.deepEqual(readdirSync(join(modules, "@commish")).sort(), ["next", "sdk"]);
    const installed = ["sdk", "next"].map((name) =>
      inside(consumer, join(modules, "@commish", name)),
    );
    const extra = provider
      ? Object.keys(locks.dependencies).map((name) => inside(consumer, join(modules, name)))
      : [];
    const expected = [...installed, ...extra]
      .map((path) => relative(realpathSync(store), inside(realpathSync(store), path)).split(sep)[0])
      .sort();
    assert.equal(
      new Set(expected).size,
      provider ? 4 : 2,
      "paired packages must be separate artifacts",
    );
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
    const metadata = !provider && Object.hasOwn(manifests[1].exports, ".") &&
      !Object.hasOwn(manifests[1].peerDependencies, "next");
    if (metadata) {
      writeFileSync(join(consumer, "metadata.mjs"), `await (${metadataProbe.toString()})();\n`);
      run(process.execPath, ["metadata.mjs"]);
    }
    const typeScopes = (provider ? verifyNextProviderTypes : verifyNextBrowserTypes)(
      consumer,
      sdk.packed,
      next.packed,
      { ...context, ...(provider ? { typeVersions: locks.dependencies } : {}) },
      execute,
    );
    if (provider)
      assert.equal(
        readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8"),
        locks.paired,
        "provider consumer lock changed",
      );
    if (provider)
      assert.deepEqual(
        readProviderTypeInputs(consumer, locks.dependencies),
        originalTypes,
        "provider types changed during probe",
      );
    checkBytes();
    return [
      provider ? nextProviderLayoutScope : nextBrowserScope,
      ...(metadata ? [nextMetadataScope] : []),
      ...typeScopes,
    ];
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}
