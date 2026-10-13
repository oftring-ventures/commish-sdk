import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { readFrameworkSource, yamlKey, yamlValue } from "./next-framework-lock.mjs";

const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The provider declaration gate installs @types/react and its one dependency from
// the registry at the versions the workspace lockfile resolved, bound by integrity,
// then adds the offline pair. Engines and peers come from the archives themselves.
export function providerTypeVersions(sourceLock) {
  const lock = readFrameworkSource(sourceLock);
  const reactTypes = lock.dependencies["@types/react"];
  assert(reactTypes, "provider type dependency absent from source lock");
  const csstype = lock.snapshots.match(
    new RegExp(
      `^  '@types/react@${escapePattern(reactTypes)}':\\n    dependencies:\\n      csstype: (\\S+)$`,
      "m",
    ),
  )?.[1];
  assert(csstype, "provider type dependency absent from source lock");
  return { "@types/react": reactTypes, csstype };
}

export function providerTypesLock(sdk, next, sourceLock) {
  const lock = readFrameworkSource(sourceLock);
  const { "@types/react": reactTypes, csstype } = providerTypeVersions(sourceLock);
  const integrity = (id) => {
    const match = lock.packages.match(
      new RegExp(
        `^  ${escapePattern(id)}:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}$`,
        "m",
      ),
    );
    assert(match, "provider type integrity absent from source lock");
    return match[1];
  };
  const typePackages = [
    ["@types/react", reactTypes, integrity(`'@types/react@${reactTypes}'`)],
    ["csstype", csstype, integrity(`csstype@${csstype}`)],
  ];
  const manifests = [sdk, next].map(({ packed }) =>
    JSON.parse(packed.get("package/package.json").data),
  );
  assert(typeof manifests[0].engines?.node === "string", "provider package engines missing");
  for (const manifest of manifests)
    assert.deepEqual(manifest.engines, manifests[0].engines, "provider package engines differ");
  const engines = `engines: {node: ${yamlValue(manifests[0].engines.node)}}`;
  const peers = manifests[1].peerDependencies ?? {};
  const sdkId = "@commish/sdk@file:sdk.tgz";
  const typeImports = `      '@types/react':
        specifier: ${reactTypes}
        version: ${reactTypes}
      csstype:
        specifier: ${csstype}
        version: ${csstype}`;
  const typeRecords = typePackages
    .map(
      ([name, version, hash]) =>
        `  ${name.startsWith("@") ? `'${name}@${version}'` : `${name}@${version}`}:
    resolution: {integrity: ${hash}}`,
    )
    .join("\n\n");
  const typeSnapshots = `  '@types/react@${reactTypes}':
    dependencies:
      csstype: ${csstype}

  csstype@${csstype}: {}`;
  const header = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
`;
  return {
    registry: `${header}${typeImports}

packages:

${typeRecords}

snapshots:

${typeSnapshots}
`,
    paired: `${header}      '@commish/next':
        specifier: file:./next.tgz
        version: file:next.tgz(${sdkId})
      '@commish/sdk':
        specifier: file:./sdk.tgz
        version: file:sdk.tgz
${typeImports}

packages:

  '@commish/next@file:next.tgz':
    resolution: {integrity: ${sri(next.archive)}, tarball: file:next.tgz}
    version: ${manifests[1].version}
    ${engines}
${manifests[1].bin ? "    hasBin: true\n" : ""}    peerDependencies:
${Object.keys(peers)
  .sort()
  .map((name) => `      ${yamlKey(name)}: ${yamlValue(peers[name])}`)
  .join("\n")}

  '${sdkId}':
    resolution: {integrity: ${sri(sdk.archive)}, tarball: file:sdk.tgz}
    version: ${manifests[0].version}
    ${engines}
${manifests[0].bin ? "    hasBin: true\n" : ""}
${typeRecords}

snapshots:

  '@commish/next@file:next.tgz(${sdkId})':
    dependencies:
      '@commish/sdk': file:sdk.tgz

  '${sdkId}': {}

${typeSnapshots}
`,
    dependencies: { "@types/react": reactTypes, csstype },
  };
}

function ownedChild(root, path) {
  const actual = realpathSync(path),
    part = relative(root, actual);
  assert(
    part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`),
    "provider type path escaped its root",
  );
  return actual;
}

// Bind type package identity and every byte across extension and the browser probe.
export function readProviderTypeInputs(consumer, dependencies) {
  const roots = ["@types/react", "csstype"].map((name) => {
    const root = ownedChild(consumer, join(consumer, "node_modules", name));
    const manifest = JSON.parse(readFileSync(join(root, "package.json")));
    assert.equal(manifest.name, name);
    assert.equal(
      manifest.version,
      dependencies[name],
      "provider type version differs from the source lock",
    );
    for (const file of name === "csstype" ? ["index.d.ts"] : ["index.d.ts", "jsx-runtime.d.ts"])
      ownedChild(root, join(root, file));
    return root;
  });
  const files = roots.flatMap((root) =>
    readdirSync(root, { recursive: true, withFileTypes: true }).flatMap((entry) => {
      assert(entry.isFile() || entry.isDirectory(), "Next type dependency contains a link");
      if (entry.isDirectory()) return [];
      const path = ownedChild(root, join(entry.parentPath, entry.name));
      return [[path, readFileSync(path), statSync(path).mode & 0o777]];
    }),
  );
  return { roots, files };
}
