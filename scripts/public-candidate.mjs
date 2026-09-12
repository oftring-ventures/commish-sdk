import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const digest = (bytes) => createHash("sha512").update(bytes).digest();
export const candidateScopes = [
  "sdk-browser-node-primitives", "sdk-public-types-external-ts", "sdk-client-types-external-ts",
  "sdk-webhook-node", "sdk-http-node-fetch", "sdk-reads-node-fetch", "next-browser-node-bridge",
  "next-browser-types-external-ts", "next-provider-types-layout", "next-provider-types-external-ts",
  "next-production-build-external", "next-metadata-installed-node", "next-cookie-request-context-external",
  "next-attribution-capture-request-external", "next-provider-installed-hook-wiring", "next-cli-installed-dry-run",
];

export function portablePackageArchive(bytes) {
  assert(bytes.length >= 18, "incomplete package gzip archive");
  assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x1f, 0x8b, 8, 0]));
  const archive = Buffer.from(bytes);
  archive[9] = 255; // RFC 1952 OS unknown; compressed payload remains unchanged.
  return archive;
}

export function candidateDirectory(root, input) {
  assert(typeof input === "string" && isAbsolute(input), "candidate output must be absolute");
  const requested = resolve(input), output = join(realpathSync(dirname(requested)), basename(requested));
  root = realpathSync(root);
  for (const part of [relative(root, output), relative(output, root)])
    assert(isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`), "candidate overlaps checkout");
  assert.equal(lstatSync(output, { throwIfNoEntry: false }), undefined, "candidate output already exists");
  return output;
}

// Work is owned by verifyPackages and removed by its finally block.
export function normalizePackage(files, dir, manifest, original, work, run, parseArchive) {
  const wanted = ["package/package.json", "package/LICENSE", "package/README.md",
    ...[...files.keys()].filter((name) => name.startsWith(`${dir}/src/`)).flatMap((name) => {
      const stem = name.slice(`${dir}/src/`.length).replace(/\.tsx?$/, "");
      return [`package/dist/${stem}.js`, `package/dist/${stem}.d.ts`];
    }), ...(manifest.bin ? ["package/bin/init.mjs"] : [])].sort();
  assert.deepEqual([...original.keys()].sort(), wanted, "unexpected release member inventory");
  const stage = join(work, "release-stage", manifest.name.slice(9)), destination = `${stage}-packed`;
  mkdirSync(stage, { recursive: true }); mkdirSync(destination);
  const expected = new Map();
  for (const name of wanted) {
    const mode = name === "package/bin/init.mjs" ? 0o755 : 0o644;
    assert.equal(original.get(name).mode & 0o777, mode);
    // Pinned pnpm pack serializes package.json without a trailing newline.
    const data = name === "package/package.json" ? Buffer.from(JSON.stringify(manifest, null, 2))
      : original.get(name).data;
    if (["package/LICENSE", "package/README.md", "package/bin/init.mjs"].includes(name))
      assert(data.equals(files.get(`${dir}/${name.slice(8)}`).data), "release source member changed");
    const path = join(stage, name.slice(8)); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, { mode, flag: "wx" }); expected.set(name, { data, mode });
  }
  run("pnpm", ["pack", "--pack-destination", destination], stage);
  const name = `commish-${manifest.name.slice(9)}-${manifest.version}.tgz`;
  assert.deepEqual(readdirSync(destination), [name], "unexpected normalized archive");
  const archive = portablePackageArchive(readFileSync(join(destination, name))), packed = parseArchive(archive);
  assert.deepEqual([...packed.keys()].sort(), wanted, "normalized member inventory differs");
  for (const [name, member] of expected) {
    assert(packed.get(name).data.equals(member.data), "normalized member bytes differ");
    assert.equal(packed.get(name).mode & 0o777, member.mode, "normalized member mode differs");
  }
  return { archive, packed };
}

export function writeCandidate(root, output, source, artifacts, scopes, manifests, parseArchive) {
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.deepEqual([...scopes].sort(), [...candidateScopes].sort(), "incomplete candidate consumer evidence");
  assert.equal(artifacts.length, 2, "candidate requires the exact pair");
  const records = artifacts.map(({ archive }, index) => {
    const packed = parseArchive(archive);
    const manifest = JSON.parse(packed.get("package/package.json").data), name = `@commish/${index ? "next" : "sdk"}`;
    assert.equal(manifest.name, name); assert.equal(manifest.version, "0.1.0-beta.10");
    assert.deepEqual(manifest, manifests[index], "candidate manifest differs from normalized source");
    if (index) assert.equal(manifest.peerDependencies["@commish/sdk"], manifest.version);
    const hash = digest(archive);
    return { name, version: manifest.version, file: `commish-${name.slice(9)}-${manifest.version}.tgz`,
      bytes: archive.length, sha512: hash.toString("hex"), integrity: `sha512-${hash.toString("base64")}`,
      members: [...packed.keys()].sort().map((name) => {
        const member = packed.get(name);
        return { name, bytes: member.data.length, mode: member.mode & 0o777, sha512: digest(member.data).toString("hex") };
      }) };
  });
  output = candidateDirectory(root, output); // Recheck immediately before exclusive creation.
  const manifest = { source, status: "local-artifacts-verified", npmPublished: false, hostedAccepted: false,
    node: process.version, consumerScopes: scopes, artifacts: records };
  mkdirSync(output, { mode: 0o700 });
  for (const [index, item] of records.entries())
    writeFileSync(join(output, item.file), artifacts[index].archive, { flag: "wx" });
  writeFileSync(join(output, "SHA512SUMS"), records.map((a) => `${a.sha512}  ${a.file}\n`).join(""), { flag: "wx" });
  // Record acceptance only after both archives and their checksums have been written.
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return { output, ...manifest };
}
