import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resourceCommands, resourceGroups } from "../packages/sdk/bin/api-command.mjs";

const executable = fileURLToPath(new URL("../packages/sdk/bin/init.mjs", import.meta.url));
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "commish-help-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
// No credentials and an unusable endpoint: help must not need either.
const run = (root, args) =>
  spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH, COMMISH_API_URL: "http://127.0.0.1:1/api/v1" },
  });
const commands = ["init", "setup", "verify", "agent", "api", "auth", "manage", "keys", "doctor"];
const subcommands = [
  ["auth", "login"],
  ["auth", "status"],
  ["auth", "revoke"],
  ["manage", "list"],
  ["manage", "schema", "programs.activate"],
  ["manage", "programs.activate"],
  ["keys", "create"],
  ["keys", "rotate"],
  ["test", "fixture"],
  ["test", "conversion"],
  ["test", "webhook"],
  ["test", "rehearsal"],
  ["api", "list"],
  ["api", "schema", "getProgram"],
  ["api", "getProgram"],
  ...Object.keys(resourceCommands).map((command) => command.split(" ")),
];

test("--help prints help for every dispatched command, with and without --json", (t) => {
  const root = directory(t);
  for (const command of [[], ...[...commands, "test", ...resourceGroups].map((name) => [name])]) {
    const text = run(root, [...command, "--help"]);
    assert.equal(text.status, 0, `${command} --help: ${text.stderr}`);
    assert.equal(text.stderr, "", `${command} --help`);
    assert(text.stdout.trim().length > 0, `${command} --help`);
    const json = run(root, [...command, "--help", "--json"]);
    assert.equal(json.status, 0, `${command} --help --json: ${json.stderr}`);
    assert.equal(json.stderr, "", `${command} --help --json`);
    assert.doesNotThrow(() => JSON.parse(json.stdout), `${command} --help --json`);
  }
  for (const command of subcommands) {
    const result = run(root, [...command, "--help"]);
    assert.equal(result.status, 0, `${command.join(" ")} --help: ${result.stderr}`);
    assert.equal(result.stderr, "", command.join(" "));
    assert.equal(JSON.parse(result.stdout).status, "help", command.join(" "));
  }
  assert.deepEqual(readdirSync(root), []);
});

test("verify documents itself without reading credentials or contacting the API", (t) => {
  const root = directory(t);
  for (const flag of ["--help", "-h"]) {
    const text = run(root, ["verify", flag]);
    assert.deepEqual([text.status, text.stderr], [0, ""]);
    assert.match(text.stdout, /^Usage: commish verify \[--json\]\n/);
    assert.match(text.stdout, /COMMISH_SECRET_KEY/);
    for (const args of [
      ["verify", flag, "--json"],
      ["verify", "--json", flag],
    ]) {
      const result = run(root, args);
      assert.deepEqual([result.status, result.stderr], [0, ""]);
      const help = JSON.parse(result.stdout);
      assert.equal(help.status, "help");
      assert.equal(help.command, "verify [--json]");
      assert.deepEqual(
        help.requiredEnvironment,
        JSON.parse(run(root, ["--help", "--json"]).stdout).requiredEnvironment,
      );
      assert.equal(help.integrationVerified, false);
    }
  }
  // Anything beside help and --json is still refused, without echoing it.
  for (const args of [
    ["verify", "--help", "--private-fixture"],
    ["verify", "--help", "--help"],
    ["verify", "--help", "private-fixture"],
  ]) {
    const refused = run(root, [...args, "--json"]);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.equal(JSON.parse(refused.stderr).code, "invalid_arguments");
    assert(!refused.stderr.includes("private-fixture"));
  }
  // Without help the command still verifies, and reports the missing configuration.
  const unconfigured = run(root, ["verify", "--json"]);
  assert.equal(unconfigured.status, 1);
  assert.equal(JSON.parse(unconfigured.stderr).code, "invalid_configuration");
});

test("init answers --help in JSON too", (t) => {
  const root = directory(t);
  for (const args of [
    ["init", "--help", "--json"],
    ["init", "--json", "-h"],
  ]) {
    const result = run(root, args);
    assert.deepEqual([result.status, result.stderr], [0, ""]);
    const help = JSON.parse(result.stdout);
    assert.equal(help.status, "help");
    assert.equal(help.command, "init [--json]");
    assert.equal(help.networkRequests, false);
  }
  assert.equal(
    JSON.parse(run(root, ["init", "--help", "--write", "--json"]).stderr).code,
    "invalid_arguments",
  );
  assert.deepEqual(readdirSync(root), []);
});
