import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
// pnpm writes YAML keys and scalars plain unless they start with an indicator or
// contain spaces: scoped names and ranges such as '>=16.3.8 <17' are single-quoted.
export const yamlKey = (name) => (/^[A-Za-z0-9_.-]+$/.test(name) ? name : `'${name}'`);
export const yamlValue = (value) =>
  /^[A-Za-z0-9~_.][A-Za-z0-9~_.-]*$/.test(value) ? value : `'${value}'`;

// Reads what the framework fixtures need from the workspace lockfile: its header
// settings and overrides, the Next package's registry dependencies with their
// resolved versions, and the registry closure. Any other lockfile shape is refused.
export function readFrameworkSource(source) {
  const text = source.toString();
  const importersAt = text.indexOf("\nimporters:\n"),
    packagesAt = text.indexOf("\npackages:\n\n"),
    snapshotsAt = text.indexOf("\nsnapshots:\n\n");
  assert(
    text.startsWith("lockfileVersion: '9.0'\n") && importersAt > 0 && packagesAt > importersAt && snapshotsAt > packagesAt,
    "unsupported framework source lock",
  );
  const start = text.indexOf("\n  packages/next:\n", importersAt);
  assert(start > 0 && start < packagesAt, "unsupported framework source lock");
  const block = text.slice(start + 1, text.indexOf("\n\n", start + 1));
  const entries = [...block.matchAll(/^      ('?)([^\s:'][^:']*)\1:\n        specifier: (.+)\n        version: (.+)$/gm)]
    .map(([, , name, specifier, version]) => ({ name, specifier, version }));
  assert(entries.some(({ name, version }) => name === "@commish/sdk" && version === "link:../sdk"),
    "unsupported framework source lock");
  const registry = entries.filter(({ name }) => name !== "@commish/sdk");
  assert(registry.length > 0 && registry.every(({ specifier }) => /^\d+\.\d+\.\d+$/.test(specifier)),
    "unsupported framework source lock");
  const overrides = [...(text.match(/^overrides:\n((?:  .+\n)+)/m)?.[1] ?? "").matchAll(/^  (\S+): (\S+)$/gm)]
    .map(([, name, version]) => [name, version]);
  return {
    header: text.slice(0, importersAt + 1).replace("autoInstallPeers: true", "autoInstallPeers: false"),
    overrides,
    dependencies: Object.fromEntries(registry.map(({ name, specifier }) => [name, specifier])),
    resolved: Object.fromEntries(registry.map(({ name, version }) => [name, version])),
    imports: registry
      .map(({ name, specifier, version }) => `      ${yamlKey(name)}:\n        specifier: ${specifier}\n        version: ${version}`)
      .join("\n"),
    registry,
    packages: text.slice(packagesAt + 12, snapshotsAt),
    snapshots: text.slice(snapshotsAt + 13),
  };
}

const blocksOf = (section) => {
  const blocks = new Map();
  for (const block of section.split(/\n(?=  \S)/)) {
    const id = block.match(/^  ('?)([^'\n]+?)\1:/)?.[2];
    if (id) blocks.set(id, block.replace(/\n+$/, ""));
  }
  return blocks;
};
const edgesOf = (block) =>
  [...block.matchAll(/^      ('?)([^\s:'][^:']*)\1: (\S+)$/gm)].map(([, , name, spec]) => `${name}@${spec}`);

// Keep only the packages reachable from the Next package's registry dependencies.
// The workspace lockfile also resolves root-only tooling, which the framework
// consumer never installs and must not be asked to.
function projectClosure(registry, packagesText, snapshotsText) {
  const packages = blocksOf(packagesText), snapshots = blocksOf(snapshotsText);
  const needed = new Set();
  const queue = registry.map(({ name, version }) => `${name}@${version}`);
  while (queue.length) {
    const id = queue.pop();
    if (needed.has(id)) continue;
    const block = snapshots.get(id);
    assert(block, `unsupported framework source lock: unresolved ${id.split("(")[0]}`);
    needed.add(id);
    queue.push(...edgesOf(block));
  }
  const bases = new Set([...needed].map((id) => id.replace(/\(.*$/, "")));
  for (const base of bases) assert(packages.has(base), "unsupported framework source lock");
  const emit = (blocks, keep) => `${[...blocks].filter(([id]) => keep.has(id)).map(([, block]) => block).join("\n\n")}\n`;
  return { packages: emit(packages, bases), snapshots: emit(snapshots, needed) };
}

const peerLines = (manifest) =>
  manifest.peerDependencies
    ? `    peerDependencies:\n${Object.keys(manifest.peerDependencies).sort()
      .map((name) => `      ${yamlKey(name)}: ${yamlValue(manifest.peerDependencies[name])}`).join("\n")}\n`
    : "";

// Project the reviewed registry closure for the framework consumer, then the same
// closure with the local pair added offline. Versions, engines and peers come from
// the lockfile and the archives themselves.
export function frameworkLocks(source, sdk, next) {
  const lock = readFrameworkSource(source);
  const manifests = [sdk, next].map((artifact) => JSON.parse(artifact.packed.get("package/package.json").data));
  for (const manifest of manifests)
    assert(typeof manifest.engines?.node === "string" && typeof manifest.version === "string", "framework pair manifests incomplete");
  const { next: nextVersion, react: reactVersion } = lock.resolved;
  assert(nextVersion && reactVersion, "unsupported framework source lock");
  const closure = projectClosure(lock.registry, lock.packages, lock.snapshots);
  const sdkId = "@commish/sdk@file:sdk.tgz";
  const peerSuffix = `(${sdkId})(next@${nextVersion})(react@${reactVersion})`;
  const packageRecord = (name, artifact, manifest) => `  '@commish/${name}@file:${name}.tgz':
    resolution: {integrity: ${sri(artifact.archive)}, tarball: file:${name}.tgz}
    version: ${manifest.version}
    engines: {node: ${yamlValue(manifest.engines.node)}}
${manifest.bin ? "    hasBin: true\n" : ""}${peerLines(manifest)}
`;
  const workspace = `packages: ['.']\nautoInstallPeers: false\nengineStrict: true\n${
    lock.overrides.length ? `overrides:\n${lock.overrides.map(([name, version]) => `  ${name}: ${version}`).join("\n")}\n` : ""}`;
  return {
    registry: `${lock.header}importers:\n\n  .:\n    dependencies:\n${lock.imports}\n\npackages:\n\n${closure.packages}\nsnapshots:\n\n${closure.snapshots}`,
    paired: `${lock.header}importers:

  .:
    dependencies:
      '@commish/next':
        specifier: file:./next.tgz
        version: file:next.tgz${peerSuffix}
      '@commish/sdk':
        specifier: file:./sdk.tgz
        version: file:sdk.tgz
${lock.imports}

packages:

${packageRecord("next", next, manifests[1])}${packageRecord("sdk", sdk, manifests[0])}${closure.packages}
snapshots:

  '@commish/next@file:next.tgz${peerSuffix}':
    dependencies:
      '@commish/sdk': file:sdk.tgz
      next: ${nextVersion}
      react: ${reactVersion}

  '${sdkId}': {}

${closure.snapshots}`,
    registryIds: [...closure.packages.matchAll(/^  '?([^\s'][^'\n]*)'?:\n/gm)].map((match) => match[1]),
    requiredIds: closure.snapshots
      .split(/\n(?=  \S)/)
      .filter((block) => !block.includes("    optional: true"))
      .map((block) => block.match(/^  '?([^'(\n:]+)(?:\(|'?:)/)?.[1])
      .filter(Boolean),
    dependencies: lock.dependencies,
    workspace,
    // The two SRI-bound local test tarballs have no registry publication timestamp.
    // All registry dependencies retain pnpm's release-age policy.
    pairWorkspace: `${workspace}minimumReleaseAgeExclude:\n  - '@commish/sdk@${manifests[0].version}'\n  - '@commish/next@${manifests[1].version}'\n`,
  };
}
