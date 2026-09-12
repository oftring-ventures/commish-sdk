import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { publicPackageManifests } from "./public-package-manifest.mjs";

function source() {
  const files = new Map();
  for (const pkg of ["sdk", "next"]) {
    const root = `packages/${pkg}`;
    const names = ["package.json", "LICENSE", "README.md", ...["src", ...(pkg === "next" ? ["bin"] : [])]
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
  assert.equal(pair[1].peerDependencies["@commish/sdk"], pair[0].version);
  assert.deepEqual(pair.map((m) => Object.keys(m).sort()), [
    ["description", "engines", "exports", "license", "name", "publishConfig", "repository", "type", "version"],
    ["bin", "description", "engines", "exports", "license", "name", "peerDependencies", "publishConfig", "repository", "type", "version"],
  ]);
});

test("private, mismatched and incomplete release source is rejected before normalization", () => {
  for (const pkg of ["sdk", "next"]) for (const patch of [
    (m) => { m.private = true; }, (m) => { m.private = false; },
    (m) => { m.version = "0.1.0-beta.9"; }, (m) => { m.license = "UNLICENSED"; },
    (m) => { m.repository.directory = "private"; }, (m) => { delete m.exports["."]; },
    (m) => { m.publishConfig.tag = "latest"; }, (m) => { m.dependencies = {}; },
    (m) => { m.peerDependencies = {}; }, (m) => { m.files.push("src"); },
  ]) {
    const files = source(); change(files, pkg, patch);
    assert.throws(() => publicPackageManifests(files));
  }
  for (const [name] of source()) {
    const files = source(); files.delete(name);
    assert.throws(() => publicPackageManifests(files));
  }
  for (const name of ["packages/sdk/LICENSE", "packages/next/LICENSE", "packages/next/bin/init.mjs"]) {
    const files = source(); files.get(name).data = Buffer.from("changed");
    assert.throws(() => publicPackageManifests(files));
  }
  const files = source(); files.get("packages/next/bin/init.mjs").mode = "100644";
  assert.throws(() => publicPackageManifests(files));
});
