import assert from "node:assert/strict";
import { releaseVersion } from "./stable-release.mjs";

// Structural rules for the public pair. The source verifier and the release
// normalizer both apply them, so a manifest change is reviewed once, here, instead
// of being pinned byte-for-byte in several scripts.
export const packageNames = ["sdk", "next"];
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const exact = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
// Export entry → source stem per package; other modules under src/ are internal.
// Server entries hold secret-bearing code and must never resolve in browser
// bundles; the SDK client only needs fetch, so it may also resolve on edge runtimes.
const entries = {
  sdk: { ".": "index", "./browser": "browser", "./webhooks": "webhooks" },
  next: {
    ".": "index",
    "./browser": "browser",
    "./react": "provider",
    "./pages": "pages",
    "./pages/handlers": "pages-handlers",
    "./pages/routing": "pages-routing",
  },
};
const browserEntries = new Set(["./browser", "./react"]);
const conditions = ["types", "browser", "edge-light", "workerd", "default"];
// Scripts that package managers run on install or publish never ship or run here.
const lifecycle = ["preinstall", "install", "postinstall", "prepare", "prepublish",
  "prepublishOnly", "publish", "postpublish", "postpack"];
const required = {
  sdk: ["typescript", "@types/node"],
  next: ["typescript", "@types/node", "@commish/sdk", "next", "react", "react-dom", "@types/react", "@types/react-dom"],
};

// Framework peers start at the versions the fixtures build and test against, and
// never below these floors (next 16.3.8 carries the image-optimization fix).
const peerFloors = { next: "16.3.8", react: "19.2.8" };
const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// The pair ships together: a peer may pin the exact SDK version or allow its patch line.
export function peerAllows(range, version) {
  const match = /^(~?)((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))$/.exec(range ?? "");
  if (!match || !exact.test(version)) return false;
  if (!match[1]) return match[2] === version;
  const [major, minor, patch] = version.split(".").map(Number);
  return Number(match[3]) === major && Number(match[4]) === minor && Number(match[5]) <= patch;
}

export function inspectPackageManifest(pkg, manifest, has) {
  assert(packageNames.includes(pkg), "unknown package");
  assert(record(manifest), "invalid package manifest");
  assert.equal(manifest.name, `@commish/${pkg}`, "unexpected package name");
  assert.equal(manifest.version, releaseVersion, "package version differs from the release version");
  assert.equal(manifest.type, "module", "packages are ESM only");
  assert(!Object.hasOwn(manifest, "private"), "release source must not be private");
  assert(typeof manifest.description === "string" && manifest.description.trim(), "missing release description");
  assert.equal(manifest.license, "MIT", "release license differs");
  assert.deepEqual(manifest.repository, {
    type: "git", url: "git+https://github.com/oftring-ventures/commish-sdk.git", directory: `packages/${pkg}`,
  }, "unsupported repository metadata");
  assert.deepEqual(manifest.publishConfig, { access: "public", tag: "latest" }, "unsupported publish configuration");
  assert(record(manifest.engines) && Object.keys(manifest.engines).join() === "node" &&
    /^>=(0|[1-9][0-9]*)(\.[0-9]+){0,2}( <(0|[1-9][0-9]*))?$/.test(manifest.engines.node), "unsupported engines");
  if (Object.hasOwn(manifest, "sideEffects")) assert.equal(manifest.sideEffects, false, "release source must be side-effect free");
  for (const name of ["dependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"])
    assert(!Object.hasOwn(manifest, name), "unexpected production dependency");
  const scripts = manifest.scripts ?? {};
  assert(record(scripts), "invalid scripts");
  for (const name of lifecycle) assert(!Object.hasOwn(scripts, name), `${name} lifecycle script is not allowed`);
  assert.equal(scripts.build, "node build.mjs", "unexpected build command");
  assert.equal(scripts.prepack, "pnpm build", "unexpected prepack command");
  assert.equal(scripts.typecheck, "tsc -p tsconfig.build.json --noEmit", "unexpected typecheck command");
  const dev = manifest.devDependencies ?? {};
  assert(record(dev), "invalid development dependencies");
  for (const [name, version] of Object.entries(dev))
    assert(version === "workspace:*" ? pkg === "next" && name === "@commish/sdk" : exact.test(version),
      `development dependency ${name} must pin an exact version`);
  for (const name of required[pkg]) assert(Object.hasOwn(dev, name), `missing development dependency ${name}`);
  if (pkg === "next") assert.equal(dev["@commish/sdk"], "workspace:*", "Next must build against the workspace SDK");
  const peers = manifest.peerDependencies;
  if (pkg === "sdk") assert.equal(peers, undefined, "the SDK declares no peers");
  else {
    assert(record(peers) && Object.keys(peers).sort().join() === "@commish/sdk,next,react", "unsupported Next peers");
    assert(peerAllows(peers["@commish/sdk"], releaseVersion), "Next peer must allow the released SDK");
    for (const name of ["next", "react"]) {
      const range = /^>=((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)) <(0|[1-9][0-9]*)$/.exec(peers[name] ?? "");
      assert(range, `unsupported ${name} peer range`);
      assert.equal(range[1], dev[name], `${name} peer floor must be the tested version`);
      assert.equal(Number(range[5]), Number(range[2]) + 1, `${name} peer range must stay within its major`);
      assert(compareVersions(range[1], peerFloors[name]) >= 0, `${name} peer floor is below ${peerFloors[name]}`);
    }
  }
  const exported = manifest.exports;
  assert(record(exported), "missing exports");
  const targets = [];
  for (const [entry, value] of Object.entries(exported)) {
    if (entry === "./package.json") {
      assert.equal(value, "./package.json", "package.json export must be the manifest");
      continue;
    }
    const stem = entries[pkg][entry];
    assert(stem, `unknown export ${entry}`);
    assert(has(stem), `export ${entry} has no source`);
    assert(record(value), `export ${entry} must map conditions`);
    const names = Object.keys(value);
    assert.equal(names[0], "types", `types condition of ${entry} must come first`);
    for (const name of names) assert(conditions.includes(name), `unknown export condition in ${entry}`);
    assert.equal(value.types, `./dist/${stem}.d.ts`, `unexpected types target for ${entry}`);
    assert.equal(value.default, `./dist/${stem}.js`, `unexpected default target for ${entry}`);
    if (browserEntries.has(entry)) assert(!Object.hasOwn(value, "browser"), `${entry} is a browser entry`);
    else assert(Object.hasOwn(value, "browser") && value.browser === null, `${entry} carries server secrets and must not resolve in browsers`);
    for (const name of ["edge-light", "workerd"])
      if (Object.hasOwn(value, name)) {
        assert(pkg === "sdk" && entry === ".", `${name} is supported only by the SDK client`);
        assert.equal(value[name], value.default, `${name} must resolve the default build`);
        // Conditions match in key order and edge resolvers also match `browser`, so an
        // edge condition listed after `browser: null` would never be reached.
        assert(names.indexOf(name) < names.indexOf("browser"), `${name} must precede the browser condition`);
      }
    targets.push(value.types, value.default);
  }
  for (const [entry, stem] of Object.entries(entries[pkg]))
    if (has(stem)) assert(Object.hasOwn(exported, entry), `source ${stem} has no export`);
  assert(Object.hasOwn(exported, "."), "missing root export");
  const bin = { [pkg === "sdk" ? "commish" : "commish-next"]: "./bin/init.mjs" };
  assert.deepEqual(manifest.bin, bin, "bin does not match the package entry point");
  assert.deepEqual([...(manifest.files ?? [])].sort(),
    [...(pkg === "next" ? ["guides"] : []), "dist", "README.md", "LICENSE", "bin"].sort(), "unsupported files list");
  return { targets: [...targets, ...Object.values(bin)] };
}

const rootFields = ["name", "private", "packageManager", "engines", "scripts", "devDependencies"];
export function inspectRootManifest(manifest, pnpmVersion) {
  assert(record(manifest), "invalid root manifest");
  assert.equal(manifest.name, "commish-public-packages", "unexpected root name");
  assert.equal(manifest.private, true, "the root must stay private");
  assert.equal(manifest.packageManager, `pnpm@${pnpmVersion}`, "root packageManager differs from the toolchain");
  assert(typeof manifest.engines?.node === "string", "root engines must declare node");
  const scripts = manifest.scripts ?? {};
  assert.equal(scripts.build, packageNames.map((name) => `pnpm --filter @commish/${name} build`).join(" && "), "unexpected root build command");
  for (const name of lifecycle) assert(!Object.hasOwn(scripts, name), `${name} lifecycle script is not allowed`);
  for (const name of ["dependencies", "optionalDependencies"])
    assert(!Object.hasOwn(manifest, name), "the root must not ship runtime dependencies");
  for (const [name, version] of Object.entries(manifest.devDependencies ?? {}))
    assert(exact.test(version), `root development dependency ${name} must pin an exact version`);
  // No pnpm field: overrides, patches and build permissions stay in reviewed places.
  for (const key of Object.keys(manifest)) assert(rootFields.includes(key), `unsupported root manifest field ${key}`);
}

export function inspectWorkspace(text) {
  assert.match(text, /^packages:\n/, "workspace must list packages first");
  assert.deepEqual([...text.matchAll(/^  - (.*)$/gm)].map((match) => match[1]),
    packageNames.map((name) => `packages/${name}`), "unsupported workspace packages");
  assert.match(text, /^engineStrict: true$/m, "workspace must enforce engines");
  // Only these settings: registries, patches, build permissions and hooks stay out.
  let section;
  for (const line of text.split("\n").filter(Boolean)) {
    if (!line.startsWith(" ")) {
      section = line;
      assert(["packages:", "engineStrict: true", "overrides:"].includes(line), `unsupported workspace setting ${line}`);
    } else if (section === "overrides:")
      assert.match(line, /^  [a-z0-9@][a-z0-9@/._-]*: (0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
        "workspace overrides must pin exact versions");
    else assert(section === "packages:" && line.startsWith("  - "), `unsupported workspace setting ${line}`);
  }
}

// Every dependency resolves from the public registry by integrity; the only link
// is the workspace SDK that Next builds against.
export function inspectLockfile(text) {
  assert(text.startsWith("lockfileVersion: '9.0'\n"), "unsupported lockfile version");
  const sections = text.split(/\n(?=\S)/);
  const importers = sections.find((section) => section.startsWith("importers:"));
  assert(importers, "lockfile has no importers");
  assert.deepEqual([...importers.matchAll(/^  ('?)([^\s:'][^:']*)\1:/gm)].map((match) => match[2]).sort(),
    [".", ...packageNames.map((name) => `packages/${name}`)].sort(), "unsupported lockfile importers");
  for (const line of text.split("\n")) {
    assert(!/\b(tarball|file|https?):|\btype: (git|directory)\b/.test(line), "lockfile must resolve from the registry only");
    if (/^\s+resolution:/.test(line))
      assert.match(line, /^\s+resolution: \{integrity: sha512-[A-Za-z0-9+/]+=*\}$/, "lockfile resolution without integrity");
    if (/\blink:/.test(line)) assert.match(line, /^\s+version: link:\.\.\/sdk$/, "unexpected lockfile link");
  }
}
