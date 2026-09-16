import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const frameworkDependencies = {
  "@types/node": "24.13.3",
  "@types/react": "19.2.18",
  "@types/react-dom": "19.2.5",
  next: "16.3.4",
  react: "19.2.8",
  "react-dom": "19.2.8",
  typescript: "5.9.2",
};
export const frameworkWorkspace = `packages: ['.']
autoInstallPeers: false
engineStrict: true
overrides:
  baseline-browser-mapping: 2.11.18
  caniuse-lite: 1.0.30001809
`;
// These two SRI-bound local test tarballs have no registry publication timestamp.
// All registry dependencies retain pnpm's release-age policy.
export const frameworkPairWorkspace = `${frameworkWorkspace}minimumReleaseAgeExclude:
  - '@commish/sdk@0.1.0-beta.10'
  - '@commish/next@0.1.0-beta.10'
`;
const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// Project only this reviewed, complete registry closure; the local pair is added offline.
export function frameworkLocks(source, sdk, next) {
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "81c9949580d3ed18cfe1c75e3616ef666f403b127a08c39e6899546b6d871f7b",
    "unsupported framework source lock",
  );
  const text = source.toString();
  const header = text
    .slice(0, text.indexOf("importers:\n"))
    .replace("autoInstallPeers: true", "autoInstallPeers: false");
  const imports = text.slice(
    text.indexOf("      '@types/node':"),
    text.indexOf("\n\n  packages/sdk:"),
  );
  const [packages, snapshots] = text.split("\npackages:\n\n")[1].split("\nsnapshots:\n\n");
  const nextVersion = "16.3.4(@types/node@24.13.3)(react-dom@19.2.8(react@19.2.8))(react@19.2.8)";
  const sdkId = "@commish/sdk@file:sdk.tgz";
  const peerSuffix = `(${sdkId})(next@${nextVersion})(react@19.2.8)`;
  const packageRecord = (name, artifact, peers = "") => `  '@commish/${name}@file:${name}.tgz':
    resolution: {integrity: ${sri(artifact.archive)}, tarball: file:${name}.tgz}
    version: 0.1.0-beta.10
    engines: {node: '>=24 <25'}
${JSON.parse(artifact.packed.get("package/package.json").data).bin ? "    hasBin: true\n" : ""}${peers}
`;
  return {
    registry: `${header}importers:\n\n  .:\n    dependencies:\n${imports}\n\npackages:\n\n${packages}\nsnapshots:\n\n${snapshots}`,
    paired: `${header}importers:

  .:
    dependencies:
      '@commish/next':
        specifier: file:./next.tgz
        version: file:next.tgz${peerSuffix}
      '@commish/sdk':
        specifier: file:./sdk.tgz
        version: file:sdk.tgz
${imports}

packages:

${packageRecord(
  "next",
  next,
  `    peerDependencies:
      '@commish/sdk': 0.1.0-beta.10
      next: '>=16.2.12 <17'
      react: '>=19.2.8 <20'
`,
)}${packageRecord("sdk", sdk)}${packages}
snapshots:

  '@commish/next@file:next.tgz${peerSuffix}':
    dependencies:
      '@commish/sdk': file:sdk.tgz
      next: ${nextVersion}
      react: 19.2.8

  '${sdkId}': {}

${snapshots}`,
    registryIds: [...packages.matchAll(/^  '?([^\s'][^'\n]*)'?:\n/gm)].map((match) => match[1]),
    requiredIds: snapshots
      .split(/\n(?=  \S)/)
      .filter((block) => !block.includes("    optional: true"))
      .map((block) => block.match(/^  '?([^'(\n:]+)(?:\(|'?:)/)?.[1])
      .filter(Boolean),
  };
}
