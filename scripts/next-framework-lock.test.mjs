import assert from "node:assert/strict";
import test from "node:test";
import { frameworkLocks, readFrameworkSource } from "./next-framework-lock.mjs";

const sri =
  "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const record = (id, extra = "") => `  ${id}:\n    resolution: {integrity: ${sri}}${extra}`;
// A workspace lock with root-only tooling (lint) that the Next consumer never installs.
const sourceLock = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  caniuse-lite: 1.0.0

importers:

  .:
    devDependencies:
      lint:
        specifier: 3.0.0
        version: 3.0.0

  packages/next:
    devDependencies:
      '@commish/sdk':
        specifier: workspace:*
        version: link:../sdk
      next:
        specifier: 16.3.8
        version: 16.3.8(react@19.2.8)
      react:
        specifier: 19.2.8
        version: 19.2.8

  packages/sdk:
    devDependencies:
      typescript:
        specifier: 5.9.2
        version: 5.9.2

packages:

${record("caniuse-lite@1.0.0")}

${record("lint@3.0.0", "\n    hasBin: true")}

${record("lint-native@3.0.0", "\n    cpu: [arm64]\n    os: [darwin]")}

${record("next@16.3.8", "\n    engines: {node: '>=20.9.0'}\n    hasBin: true\n    peerDependencies:\n      react: ^19.0.0")}

${record("react@19.2.8")}

${record("swc-native@16.3.8", "\n    cpu: [arm64]\n    os: [darwin]")}

${record("typescript@5.9.2", "\n    hasBin: true")}

snapshots:

  caniuse-lite@1.0.0: {}

  lint@3.0.0:
    optionalDependencies:
      lint-native: 3.0.0

  lint-native@3.0.0:
    optional: true

  next@16.3.8(react@19.2.8):
    dependencies:
      caniuse-lite: 1.0.0
      react: 19.2.8
    optionalDependencies:
      swc-native: 16.3.8

  react@19.2.8: {}

  swc-native@16.3.8:
    optional: true

  typescript@5.9.2: {}
`;
const artifact = (name, manifest) => ({
  archive: Buffer.from(`${name} archive`),
  packed: new Map([["package/package.json", { data: Buffer.from(JSON.stringify(manifest)) }]]),
});
const sdk = artifact("sdk", {
  name: "@commish/sdk",
  version: "0.5.0",
  engines: { node: ">=22" },
  bin: { commish: "./bin/init.mjs" },
});
const next = artifact("next", {
  name: "@commish/next",
  version: "0.5.0",
  engines: { node: ">=22" },
  bin: { "commish-next": "./bin/init.mjs" },
  peerDependencies: { react: ">=19.2.8 <20", "@commish/sdk": "~0.5.0", next: ">=16.3.8 <17" },
});

test("the framework fixture lock projects only the Next package's closure", () => {
  const source = readFrameworkSource(sourceLock);
  assert.deepEqual(source.dependencies, { next: "16.3.8", react: "19.2.8" });
  assert.deepEqual(source.overrides, [["caniuse-lite", "1.0.0"]]);
  const locks = frameworkLocks(sourceLock, sdk, next);
  assert.deepEqual(locks.registryIds, [
    "caniuse-lite@1.0.0",
    "next@16.3.8",
    "react@19.2.8",
    "swc-native@16.3.8",
  ]);
  assert.deepEqual(locks.requiredIds, ["caniuse-lite@1.0.0", "next@16.3.8", "react@19.2.8"]);
  assert(
    !locks.registry.includes("lint") && !locks.registry.includes("typescript"),
    "root tooling leaked into the consumer lock",
  );
  assert(
    locks.registry.includes("  swc-native@16.3.8:\n    optional: true"),
    "optional platform packages stay in the closure",
  );
  assert.match(
    locks.registry,
    /^importers:\n\n  \.:\n    dependencies:\n      next:\n        specifier: 16\.3\.8\n        version: 16\.3\.8\(react@19\.2\.8\)\n      react:/m,
  );
  assert(
    locks.registry.includes("autoInstallPeers: false") &&
      !locks.registry.includes("autoInstallPeers: true"),
  );
  assert.equal(
    locks.workspace,
    "packages: ['.']\nautoInstallPeers: false\nengineStrict: true\noverrides:\n  caniuse-lite: 1.0.0\n",
  );
  assert.equal(
    locks.pairWorkspace,
    `${locks.workspace}minimumReleaseAgeExclude:\n  - '@commish/sdk@0.5.0'\n  - '@commish/next@0.5.0'\n`,
  );
  // The pair records carry the archives' engines and the peers in sorted, pnpm-quoted form.
  assert(
    locks.paired.includes("  '@commish/next@file:next.tgz':\n    resolution: {integrity: sha512-"),
  );
  assert(
    locks.paired.includes(
      "    version: 0.5.0\n    engines: {node: '>=22'}\n    hasBin: true\n    peerDependencies:\n      '@commish/sdk': ~0.5.0\n      next: '>=16.3.8 <17'\n      react: '>=19.2.8 <20'\n",
    ),
  );
  assert(
    locks.paired.includes(
      "  '@commish/next@file:next.tgz(@commish/sdk@file:sdk.tgz)(next@16.3.8(react@19.2.8))(react@19.2.8)':\n    dependencies:\n      '@commish/sdk': file:sdk.tgz\n      next: 16.3.8(react@19.2.8)\n      react: 19.2.8\n",
    ),
  );
});

test("unsupported lockfiles and unresolved dependencies are refused", () => {
  for (const text of [
    "invalid",
    sourceLock.replace("\n  packages/next:\n", "\n  packages/other:\n"),
    sourceLock.replace("        version: link:../sdk\n", "        version: 0.5.0\n"),
    sourceLock.replace("\n  react@19.2.8: {}\n", "\n"),
    sourceLock.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'"),
  ])
    assert.throws(() => frameworkLocks(text, sdk, next), /unsupported framework source lock/);
});
