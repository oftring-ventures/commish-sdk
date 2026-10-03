import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSetupFile, writeSetupFile } from "../packages/sdk/bin/setup-files.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "commish-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
test("publishes complete files, reuses matching bytes and preserves custom content", t => {
  const root = fixture(t), path = "public/.well-known/commish-verification.txt";
  assert.deepEqual(writeSetupFile(root, path, "public proof"), { path, written: true });
  assert.deepEqual(writeSetupFile(root, path, "public proof"), { path, written: false });
  assert.equal(readSetupFile(root, path), "public proof");
  assert.throws(() => writeSetupFile(root, path, "replacement"), /setup_file_conflict/);
  assert.equal(readFileSync(join(root, path), "utf8"), "public proof");
  assert.deepEqual(readdirSync(join(root, "public/.well-known")), ["commish-verification.txt"]);
});
test("rejects target and ancestor symlinks, traversal and absolute paths", t => {
  const root = fixture(t), other = fixture(t); writeFileSync(join(other, "custom"), "keep");
  symlinkSync(other, join(root, "linked")); symlinkSync(join(other, "custom"), join(root, "file"));
  for (const path of ["linked/new", "file", "../escape", join(other, "new"), "."])
    assert.throws(() => writeSetupFile(root, path, "change"), /unsafe_file_path|setup_file_unavailable/);
  assert.throws(() => readSetupFile(root, "file"), /unsafe_file_path/);
  assert.equal(readFileSync(join(other, "custom"), "utf8"), "keep");
  assert.deepEqual(readdirSync(other), ["custom"]);
});
test("private files are owner-only and unsafe existing permissions or hardlinks fail closed", t => {
  const root = fixture(t); writeSetupFile(root, "credentials.env", "fixture only", { privateFile: true });
  const path = join(root, "credentials.env"); assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readSetupFile(root, "credentials.env", { privateFile: true }), "fixture only");
  chmodSync(path, 0o644);
  assert.throws(() => writeSetupFile(root, "credentials.env", "fixture only", { privateFile: true }), /unsafe_file_permissions/);
  chmodSync(path, 0o600); linkSync(path, join(root, "copy"));
  assert.throws(() => readSetupFile(root, "credentials.env", { privateFile: true }), /unsafe_file_permissions/);
});
test("rejects oversized, malformed UTF-8 and nonregular files without returning file bytes", t => {
  const root = fixture(t); writeFileSync(join(root, "large"), "x".repeat(65537));
  writeFileSync(join(root, "invalid"), Buffer.from([0xff]));
  for (const path of ["large", "invalid"]) assert.throws(() => readSetupFile(root, path), /invalid_setup_file/);
  assert.throws(() => writeSetupFile(root, "new", "x".repeat(65537)), /invalid_setup_file/);
  writeSetupFile(root, "nested/file", "test");
  assert.throws(() => readSetupFile(root, "nested"), /invalid_setup_file/);
  assert.throws(() => readSetupFile(root, "missing"), { message: "setup_file_missing" });
});

test("recovers a private publication interrupted before temporary-link cleanup", t => {
  const root = fixture(t);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const link = fs.linkSync;
    fs.linkSync = (...args) => { link(...args); process.kill(process.pid, "SIGKILL"); };
    syncBuiltinESMExports();
    const { writeSetupFile } = await import(${JSON.stringify(new URL("../packages/sdk/bin/setup-files.mjs", import.meta.url).href)});
    writeSetupFile(process.argv[1], "credentials.env", "fixture only", { privateFile: true });
  `, root], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL");
  assert.equal(statSync(join(root, "credentials.env")).nlink, 2);
  assert.equal(readSetupFile(root, "credentials.env", { privateFile: true }), "fixture only");
  assert.deepEqual(writeSetupFile(root, "credentials.env", "fixture only", { privateFile: true }), { path: "credentials.env", written: false });
  assert.deepEqual(readdirSync(root), ["credentials.env"]);
});
test("identical private writers may replay during another writer's publication window", t => {
  const root = fixture(t);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import assert from "node:assert/strict";
    import { syncBuiltinESMExports } from "node:module";
    let writeSetupFile;
    const link = fs.linkSync;
    fs.linkSync = (...args) => {
      link(...args);
      assert.equal(writeSetupFile(process.argv[1], "credentials.env", "fixture only", { privateFile: true }).written, false);
    };
    syncBuiltinESMExports();
    ({ writeSetupFile } = await import(${JSON.stringify(new URL("../packages/sdk/bin/setup-files.mjs", import.meta.url).href)}));
    writeSetupFile(process.argv[1], "credentials.env", "fixture only", { privateFile: true });
  `, root], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(readdirSync(root), ["credentials.env"]);
});
test("matching replay preserves the UTF-8 BOM as part of exact file contents", t => {
  const root = fixture(t), body = "\ufeffpublic proof";
  writeSetupFile(root, "proof", body);
  assert.equal(readSetupFile(root, "proof"), body);
  assert.equal(writeSetupFile(root, "proof", body).written, false);
  assert.throws(() => writeSetupFile(root, "proof", "public proof"), /setup_file_conflict/);
});
