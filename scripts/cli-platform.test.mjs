import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Simulate native Windows before the entry point loads.
const windows = 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})';
const run = (bin, args) =>
  spawnSync(
    process.execPath,
    [
      "--import",
      windows,
      fileURLToPath(new URL(`../packages/${bin}/bin/init.mjs`, import.meta.url)),
      ...args,
    ],
    { encoding: "utf8" },
  );

test("native Windows answers version and usage but refuses every command", () => {
  for (const bin of ["sdk", "next"]) {
    const version = run(bin, ["--version"]);
    assert.equal(version.status, 0, bin);
    assert.match(version.stdout, /^[0-9]+\.[0-9]+\.[0-9]+\n$/, bin);
    assert.equal(run(bin, ["--help", "--json"]).status, 0, bin);
    const refused = run(bin, ["verify", "--json"]);
    assert.equal(refused.status, 1, bin);
    assert.equal(JSON.parse(refused.stderr).code, "unsupported_platform", bin);
  }
});
