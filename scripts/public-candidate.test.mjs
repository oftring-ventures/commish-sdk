import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";
import { archiveFiles } from "./verify-public-source.mjs";
import { candidateDirectory, candidateScopes, normalizePackage, portablePackageArchive, writeCandidate } from "./public-candidate.mjs";

function tar(files) {
  return gzipSync(Buffer.concat([...files.flatMap(([name, data, mode = 0o644]) => {
    data = Buffer.from(data); const header = Buffer.alloc(512);
    header.write(name); header.write(mode.toString(8).padStart(7, "0"), 100);
    header.write(data.length.toString(8).padStart(11, "0"), 124); header.write("0", 156);
    header.fill(32, 148, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"), 148);
    return [header, data, Buffer.alloc((512 - data.length % 512) % 512)];
  }), Buffer.alloc(1024)]));
}
function fixture(run) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "commish-candidate-test-"))), root = join(work, "checkout");
  mkdirSync(root);
  try { run(work, root); } finally { rmSync(work, { recursive: true, force: true }); assert(!existsSync(work)); }
}

test("portable gzip normalization preserves payload and rejects unsupported headers", () => {
  const mac = gzipSync("package contents"), linux = Buffer.from(mac); mac[9] = 19; linux[9] = 3;
  const bytes = portablePackageArchive(mac);
  assert.deepEqual(bytes, portablePackageArchive(linux)); assert.equal(mac[9], 19);
  assert.deepEqual(bytes.subarray(10), mac.subarray(10)); assert.equal(bytes[9], 255);
  assert.deepEqual(gunzipSync(bytes), Buffer.from("package contents"));
  assert.throws(() => portablePackageArchive(Buffer.from("short")));
  linux[3] = 2; assert.throws(() => portablePackageArchive(linux));
});

test("candidate paths reject overlap, relative paths, existing outputs and symlink aliases", () => fixture((work, root) => {
  assert.equal(candidateDirectory(root, join(work, "new")), join(work, "new"));
  symlinkSync(root, join(work, "alias")); symlinkSync(join(work, "missing"), join(work, "dangling"));
  for (const path of ["relative", root, work, join(root, "new"), join(work, "alias/new"), join(work, "dangling")])
    assert.throws(() => candidateDirectory(root, path));
  assert(!existsSync(join(work, "new")));
}));

test("normalized packing keeps exact payload and modes while stripping source metadata", () => fixture((work) => {
  const manifest = { name: "@commish/sdk", version: "0.1.0-beta.10" }, dir = "packages/sdk";
  const files = new Map([['src/index.ts', 'export {};'], ['LICENSE', 'license'], ['README.md', 'readme']]
    .map(([name, data]) => [`${dir}/${name}`, { data: Buffer.from(data) }]));
  const entries = [['package/package.json', JSON.stringify({ ...manifest, private: true, scripts: { build: "source-only" } })],
    ['package/LICENSE', 'license'], ['package/README.md', 'readme'], ['package/dist/index.js', 'export {};'], ['package/dist/index.d.ts', 'export {};']];
  const original = archiveFiles(tar(entries));
  const run = (command, args, cwd) => {
    assert.equal(command, "pnpm"); assert.deepEqual(args.slice(0, 2), ["pack", "--pack-destination"]);
    const packed = entries.map(([name]) => [name, name === "package/package.json"
      ? JSON.stringify(JSON.parse(readFileSync(join(cwd, name.slice(8)))), null, 2) : readFileSync(join(cwd, name.slice(8)))]);
    writeFileSync(join(args[2], "commish-sdk-0.1.0-beta.10.tgz"), tar(packed));
  };
  const result = normalizePackage(files, dir, manifest, original, work, run, archiveFiles);
  assert.deepEqual(JSON.parse(result.packed.get("package/package.json").data), manifest);
  assert.equal(JSON.parse(original.get("package/package.json").data).private, true);
  assert.equal(result.archive[9], 255);
  const extra = new Map(original); extra.set("package/surprise.js", { data: Buffer.from("extra"), mode: 0o644 });
  assert.throws(() => normalizePackage(files, dir, manifest, extra, work, run, archiveFiles), /member inventory/);
  const changed = new Map(original); changed.set("package/README.md", { data: Buffer.from("changed"), mode: 0o644 });
  const other = join(work, "other"); mkdirSync(other);
  assert.throws(() => normalizePackage(files, dir, manifest, changed, other, run, archiveFiles), /source member changed/);
}));

test("candidate receipt binds exact archive bytes and refuses incomplete evidence or replacement", () => fixture((work, root) => {
  const source = "a".repeat(40), output = join(work, "candidate");
  const manifests = ["sdk", "next"].map((pkg) => ({ name: `@commish/${pkg}`, version: "0.1.0-beta.10",
    ...(pkg === "next" ? { peerDependencies: { "@commish/sdk": "0.1.0-beta.10" } } : {}) }));
  const artifacts = manifests.map((m) => ({ archive: tar([["package/package.json", JSON.stringify(m)]]) }));
  const write = (sha = source, pair = artifacts, scopes = candidateScopes) => writeCandidate(root, output, sha, pair, scopes, manifests, archiveFiles);
  assert.throws(() => write("bad")); assert.throws(() => write(source, artifacts.slice(1)));
  assert.throws(() => write(source, [...artifacts].reverse())); assert.throws(() => write(source, artifacts, candidateScopes.slice(1)));
  assert.throws(() => write(source, artifacts, [...candidateScopes, candidateScopes[0]]));
  assert.throws(() => write(source, [{ archive: Buffer.from("bad") }, artifacts[1]]));
  assert(!existsSync(output));
  const receipt = write();
  assert.equal(receipt.source, source); assert.equal(receipt.npmPublished, false); assert.equal(receipt.hostedAccepted, false);
  assert.equal(readdirSync(output).length, 4);
  for (const item of receipt.artifacts) {
    const bytes = readFileSync(join(output, item.file));
    assert.equal(item.sha512, createHash("sha512").update(bytes).digest("hex"));
    assert.equal(item.members[0].name, "package/package.json");
  }
  const before = readFileSync(join(output, "manifest.json")); assert.throws(() => write(), /already exists/);
  assert.deepEqual(readFileSync(join(output, "manifest.json")), before);
}));
