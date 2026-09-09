import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const providerTypeDependencies = { "@types/react": "19.2.18", csstype: "3.2.3" };
const typePackages = [
  [
    "@types/react",
    "19.2.18",
    "sha512-AnzbBERsrLKtk2XSfTbYRLjQPdy116Sty4q+T+Bp3IC4l6jNBvreVPAHmpq9qhXQM7CXZPjLVmGMw9sy+hxQ3w==",
  ],
  [
    "csstype",
    "3.2.3",
    "sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==",
  ],
];
const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// inspect binds the whole source lock. Registry types install frozen before the offline pair.
export function providerTypesLock(sdk, next, sourceLock) {
  for (const [, , integrity] of typePackages)
    assert(sourceLock.includes(integrity), "provider type integrity absent from source lock");
  const manifests = [sdk, next].map(({ packed }) =>
    JSON.parse(packed.get("package/package.json").data),
  );
  for (const manifest of manifests)
    assert.deepEqual(manifest.engines, { node: ">=24 <25" }, "provider package engines changed");
  const sdkId = "@commish/sdk@file:sdk.tgz";
  const typeImports = `      '@types/react':
        specifier: 19.2.18
        version: 19.2.18
      csstype:
        specifier: 3.2.3
        version: 3.2.3`;
  const typeRecords = typePackages
    .map(
      ([name, version, integrity]) =>
        `  ${name.startsWith("@") ? `'${name}@${version}'` : `${name}@${version}`}:
    resolution: {integrity: ${integrity}}`,
    )
    .join("\n\n");
  const typeSnapshots = `  '@types/react@19.2.18':
    dependencies:
      csstype: 3.2.3

  csstype@3.2.3: {}`;
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
    version: 0.1.0-beta.9
    engines: {node: '>=24 <25'}
${manifests[1].bin ? "    hasBin: true\n" : ""}    peerDependencies:
      '@commish/sdk': 0.1.0-beta.9
      next: '>=16.2.12 <17'
      react: '>=19.2.8 <20'

  '${sdkId}':
    resolution: {integrity: ${sri(sdk.archive)}, tarball: file:sdk.tgz}
    version: 0.1.0-beta.9
    engines: {node: '>=24 <25'}

${typeRecords}

snapshots:

  '@commish/next@file:next.tgz(${sdkId})':
    dependencies:
      '@commish/sdk': file:sdk.tgz

  '${sdkId}': {}

${typeSnapshots}
`,
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
export function readProviderTypeInputs(consumer) {
  const roots = ["@types/react", "csstype"].map((name) => {
    const root = ownedChild(consumer, join(consumer, "node_modules", name));
    const manifest = JSON.parse(readFileSync(join(root, "package.json")));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, name === "csstype" ? "3.2.3" : "19.2.18");
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
