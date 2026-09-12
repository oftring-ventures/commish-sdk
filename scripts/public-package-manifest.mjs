import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Only this complete, reviewed pair may be normalized for release preparation.
export function publicPackageManifests(files) {
  const read = (name) => {
    assert(files.has(name), `missing release source: ${name}`);
    return files.get(name).data;
  };
  const target = (name, server = false) => ({
    ...(server ? { browser: null } : {}),
    types: `./dist/${name}.d.ts`, default: `./dist/${name}.js`,
  });
  return ["sdk", "next"].map((pkg) => {
    const root = `packages/${pkg}`, manifest = JSON.parse(read(`${root}/package.json`));
    assert(!Object.hasOwn(manifest, "private"), "release source must not be private");
    const common = {
      name: `@commish/${pkg}`, version: "0.1.0-beta.10", license: "MIT",
      repository: { type: "git", url: "git+https://github.com/oftring-ventures/commish-sdk.git", directory: root },
      type: "module", engines: { node: ">=24 <25" },
      publishConfig: { access: "public", tag: "beta" },
    };
    for (const [name, value] of Object.entries(common))
      assert.deepEqual(manifest[name], value, `unsupported release ${name}`);
    assert(typeof manifest.description === "string" && manifest.description.trim(), "missing release description");
    const exports = pkg === "sdk"
      ? { ".": target("index", true), "./browser": target("browser"), "./webhooks": target("webhooks", true) }
      : { ".": target("index", true), "./browser": target("browser"), "./react": target("provider") };
    assert.deepEqual(manifest.exports, exports, "incomplete release exports");
    const peers = pkg === "sdk" ? undefined
      : { "@commish/sdk": common.version, next: ">=16.2.12 <17", react: ">=19.2.8 <20" };
    assert.deepEqual(manifest.peerDependencies, peers, "unsupported release peers");
    const bin = pkg === "sdk" ? undefined : { "commish-next": "./bin/init.mjs" };
    assert.deepEqual(manifest.bin, bin, "incomplete release bin");
    assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE", ...(bin ? ["bin"] : [])]);
    for (const name of ["dependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"])
      assert(!Object.hasOwn(manifest, name), "unexpected release dependency");
    for (const name of pkg === "sdk" ? ["browser.ts", "index.ts", "types.ts", "reads.ts", "webhooks.ts"]
      : ["browser.ts", "index.ts", "metadata.ts", "capture.ts", "provider.tsx"])
      assert(read(`${root}/src/${name}`).length > 0, "empty release source");
    if (bin) {
      assert(read(`${root}/bin/init.mjs`).toString().startsWith("#!/usr/bin/env node\n"));
      assert.equal(files.get(`${root}/bin/init.mjs`).mode, "100755");
    }
    assert(read(`${root}/README.md`).length > 0, "missing release documentation");
    assert.equal(createHash("sha256").update(read(`${root}/LICENSE`)).digest("hex"),
      "03f0077d06d3281e364be7f1cbb440d6996c65d3a6a19a73de41a7c6d02be702", "release MIT license differs");
    return { ...common, description: manifest.description, exports,
      ...(peers ? { peerDependencies: peers } : {}), ...(bin ? { bin } : {}) };
  });
}
