import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectPackageManifest, packageNames } from "./package-shape.mjs";

export const licenseHash = "03f0077d06d3281e364be7f1cbb440d6996c65d3a6a19a73de41a7c6d02be702";

// Only the complete, reviewed pair is normalized for release: the shipped manifest
// carries the validated public fields and drops build configuration.
export function publicPackageManifests(files) {
  const read = (name) => {
    assert(files.has(name), `missing release source: ${name}`);
    return files.get(name).data;
  };
  return packageNames.map((pkg) => {
    const root = `packages/${pkg}`,
      manifest = JSON.parse(read(`${root}/package.json`));
    const has = (stem) =>
      files.has(`${root}/src/${stem}.ts`) || files.has(`${root}/src/${stem}.tsx`);
    inspectPackageManifest(pkg, manifest, has);
    assert(read(`${root}/README.md`).length > 0, "missing release documentation");
    assert.equal(
      createHash("sha256")
        .update(read(`${root}/LICENSE`))
        .digest("hex"),
      licenseHash,
      "release MIT license differs",
    );
    assert(
      read(`${root}/bin/init.mjs`).toString().startsWith("#!/usr/bin/env node\n"),
      "entry point must start with the node shebang",
    );
    assert.equal(
      files.get(`${root}/bin/init.mjs`).mode,
      "100755",
      "entry point must be executable",
    );
    for (const [name, file] of files)
      if (name.startsWith(`${root}/bin/`) && name !== `${root}/bin/init.mjs`) {
        assert.match(
          name.slice(root.length + 5),
          /^[a-z0-9-]+\.(mjs|json)$/,
          "unsupported CLI module name",
        );
        assert(file.data.length > 0, "empty CLI module");
        assert.equal(file.mode, "100644", "CLI modules are plain files");
      }
    if (manifest.files.includes("guides"))
      for (const name of ["pages", "agents"])
        assert(read(`${root}/guides/${name}.md`).length > 0, "missing shipped guide");
    const {
      name,
      version,
      description,
      license,
      repository,
      type,
      engines,
      sideEffects,
      exports,
      peerDependencies,
      bin,
      publishConfig,
    } = manifest;
    return {
      name,
      version,
      description,
      license,
      repository,
      type,
      engines,
      ...(sideEffects === undefined ? {} : { sideEffects }),
      exports,
      ...(peerDependencies ? { peerDependencies } : {}),
      bin,
      publishConfig,
    };
  });
}
