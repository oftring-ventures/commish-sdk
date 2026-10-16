import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (name) => readFileSync(new URL(name, root));
const json = (name) => JSON.parse(read(name));

test("the launcher pins the SDK release it shares a version with", () => {
  const launcher = json("launcher/package.json"),
    sdk = json("packages/sdk/package.json");
  assert.equal(launcher.name, "commish");
  assert.equal(launcher.version, sdk.version);
  assert.deepEqual(launcher.dependencies, { "@commish/sdk": sdk.version });
  assert.deepEqual(launcher.bin, { commish: "./bin/commish.mjs" });
  assert.equal(launcher.engines.node, sdk.engines.node);
  assert.equal(launcher.license, "MIT");
  assert.deepEqual(read("launcher/LICENSE"), read("LICENSE"));
  for (const field of ["scripts", "devDependencies", "peerDependencies", "optionalDependencies"])
    assert(!Object.hasOwn(launcher, field), `launcher must not declare ${field}`);
});

test("the launcher runs the SDK CLI with the same arguments, streams and exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "commish-launcher-"));
  try {
    const launcher = join(dir, "node_modules/commish"),
      sdk = join(dir, "node_modules/@commish/sdk");
    mkdirSync(join(launcher, "bin"), { recursive: true });
    mkdirSync(join(sdk, "bin"), { recursive: true });
    copyFileSync(new URL("launcher/package.json", root), join(launcher, "package.json"));
    copyFileSync(new URL("launcher/bin/commish.mjs", root), join(launcher, "bin/commish.mjs"));
    writeFileSync(
      join(sdk, "package.json"),
      JSON.stringify({
        name: "@commish/sdk",
        type: "module",
        bin: { commish: "./bin/init.mjs" },
        exports: { "./package.json": "./package.json" },
      }),
    );
    writeFileSync(
      join(sdk, "bin/init.mjs"),
      [
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
        'process.stderr.write("progress\\n");',
        "process.exitCode = 2;",
      ].join("\n"),
    );
    const result = spawnSync(
      process.execPath,
      [join(launcher, "bin/commish.mjs"), "setup", "--plan", "--json"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stdout), ["setup", "--plan", "--json"]);
    assert.equal(result.stderr, "progress\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
