import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { nextBuildChild as child, nextBuildFiles as files } from "./inspect-next-build.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function verifyShim(consumer, root, name, source, modules, targetName) {
  const target = child(source, join(source, targetName));
  assert(lstatSync(target).isFile() && (lstatSync(target).mode & 0o777) === 0o755);
  assert(
    readFileSync(target, "utf8").startsWith("#!/usr/bin/env node\n"),
    "unsupported bin program",
  );
  const path = join(root, "node_modules/.bin", name);
  assert(
    lstatSync(path).isFile() && (lstatSync(path).mode & 0o777) === 0o755,
    "invalid bin type/mode",
  );
  assert.equal(child(root, path), path);
  const nodePath = [
    join(source, "node_modules"),
    modules,
    child(consumer, join(consumer, "node_modules/.pnpm/node_modules")),
  ].join(":");
  const destination = relative(dirname(path), target);
  // Exact pnpm 11.1.3 / cmd-shim 9.0.3 POSIX Node output for this fixed install profile.
  const expected = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=\`cygpath -w "$basedir"\`
        fi
    ;;
esac

if [ -z "$NODE_PATH" ]; then
  export NODE_PATH="${nodePath}"
else
  export NODE_PATH="${nodePath}:$NODE_PATH"
fi
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${destination}" "$@"
else
  exec node  "$basedir/${destination}" "$@"
fi
# cmd-shim-target=${target}
`;
  assert.equal(readFileSync(path, "utf8"), expected, "generated bin content differs");
  return {
    name: relative(root, path),
    mode: 0o755,
    sha256: hash(expected),
    target,
    targetSha256: hash(readFileSync(target)),
  };
}

// Registry bytes are frozen by the caller before extension and compared again after this check.
export function verifyFrameworkPackage(consumer, root, artifact, registry) {
  consumer = realpathSync(consumer);
  root = child(consumer, root);
  const members = files(root);
  const manifest = JSON.parse(artifact.packed.get("package/package.json").data);
  assert(["@commish/sdk", "@commish/next"].includes(manifest.name));
  for (const [name, member] of artifact.packed) {
    const path = child(root, join(root, name.slice(8)));
    assert(readFileSync(path).equals(member.data), "framework installed pair differs");
    assert.equal(lstatSync(path).mode & 0o777, member.mode & 0o777, "framework pair mode differs");
  }
  const generated = [];
  if (manifest.name === "@commish/next") {
    const own = createRequire(join(root, "package.json"));
    const outer = createRequire(join(consumer, "package.json"));
    const nextManifest = child(consumer, own.resolve("next/package.json"));
    assert.equal(
      nextManifest,
      child(consumer, outer.resolve("next/package.json")),
      "bin peer identity differs",
    );
    const next = JSON.parse(readFileSync(nextManifest));
    assert.equal(next.name, "next");
    assert.equal(next.version, "16.3.4");
    assert.deepEqual(next.bin, { next: "./dist/bin/next" });
    const source = dirname(nextManifest);
    const frozen = registry.find(([id]) => id === "next@16.3.4");
    assert(frozen && frozen[1] === relative(consumer, source), "bin source identity differs");
    for (const name of ["package.json", "dist/bin/next"]) {
      const path = child(source, join(source, name));
      assert.deepEqual(
        [name, hash(readFileSync(path)), lstatSync(path).mode & 0o777],
        frozen[2].find(([file]) => file === name),
        "bin source bytes changed",
      );
    }
    generated.push(verifyShim(consumer, root, "next", source, dirname(source), "dist/bin/next"));
    if (manifest.bin) {
      assert.deepEqual(manifest.bin, { "commish-next": "./bin/init.mjs" });
      generated.push(
        verifyShim(consumer, root, "commish-next", root, dirname(dirname(root)), "bin/init.mjs"),
      );
    }
  }
  const names = new Set(generated.map((entry) => entry.name));
  assert.deepEqual(
    members
      .filter((path) => !names.has(relative(root, path)))
      .map((path) => `package/${relative(root, path)}`)
      .sort(),
    [...artifact.packed.keys()].sort(),
    "framework installed member inventory differs",
  );
  return generated;
}
