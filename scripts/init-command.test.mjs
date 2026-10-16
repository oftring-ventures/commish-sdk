import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nextPeers } from "../packages/sdk/bin/init-command.mjs";

const executable = fileURLToPath(new URL("../packages/sdk/bin/init.mjs", import.meta.url));
const read = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url)));
const { version } = read("packages/sdk/package.json");
const windows = 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})';
const run = (root, args, preload = []) =>
  spawnSync(process.execPath, [...preload, executable, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
  });
function repository(t, files = {}, directories = []) {
  const root = mkdtempSync(join(tmpdir(), "commish-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of directories) mkdirSync(join(root, directory), { recursive: true });
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(root, name), typeof body === "string" ? body : JSON.stringify(body));
  return root;
}

test("a bare run prints the repository's playbook without reading secrets or writing files", (t) => {
  const root = repository(
    t,
    {
      "package.json": { dependencies: { next: "16.3.8", react: "19.2.8" } },
      "pnpm-lock.yaml": "",
      ".env": "SECRET=private-fixture",
    },
    ["app"],
  );
  const before = readdirSync(root, { recursive: true });
  const bare = run(root, []);
  assert.equal(bare.status, 0);
  assert.equal(bare.stderr, "");
  const explicit = run(root, ["init"]);
  assert.deepEqual([explicit.status, explicit.stdout], [0, bare.stdout]);
  assert(!bare.stdout.includes("private-fixture"));
  assert.match(bare.stdout, /^# Set up Commish in this repository\n/);
  for (const command of [
    `pnpm add --save-exact @commish/sdk@${version} @commish/next@${version}`,
    "pnpm exec commish setup --plan --json",
    "pnpm exec commish setup --config commish.setup.json --mode test --no-open --non-interactive --json",
    "pnpm exec commish-next --json",
    "pnpm exec commish verify --json",
  ])
    assert(bare.stdout.includes(`\`${command}\``), command);
  assert(bare.stdout.includes(`blob/v${version}/packages/sdk/README.md`));
  assert.deepEqual(readdirSync(root, { recursive: true }), before);
});

test("commands follow the detected package manager and framework", (t) => {
  for (const [files, add, cli, next] of [
    [{ "package-lock.json": "{}" }, "npm install --save-exact", "npx commish", false],
    [{ "yarn.lock": "" }, "yarn add --exact", "yarn commish", false],
    [{ "bun.lock": "" }, "bun add --exact", "bunx commish", false],
    [{}, "npm install --save-exact", "npx commish", false],
    [{ "pnpm-lock.yaml": "", "yarn.lock": "" }, "npm install --save-exact", "npx commish", false],
  ]) {
    const root = repository(t, { "package.json": { name: "shop" }, ...files });
    const result = run(root, ["init", "--json"]);
    assert.equal(result.status, 0);
    const guide = JSON.parse(result.stdout);
    assert.equal(guide.status, "guide");
    assert.equal(guide.sdkVersion, version);
    assert.equal(guide.mutations, false);
    assert.equal(guide.networkRequests, false);
    assert.equal(guide.integrationVerified, false);
    assert.equal(guide.commands.install, `${add} @commish/sdk@${version}`);
    assert.equal(guide.commands.plan, `${cli} setup --plan --json`);
    assert.equal(Object.hasOwn(guide.commands, "wire"), next);
    assert(guide.markdown.includes("captureReferral"));
    assert(!guide.markdown.includes("@commish/next@"));
  }
  const ambiguous = repository(t, { "package.json": { dependencies: { next: "16.3.8" } } }, [
    "app",
    "src/app",
  ]);
  const guide = JSON.parse(run(ambiguous, ["init", "--json"]).stdout);
  assert(!Object.hasOwn(guide.commands, "wire"));
  assert(guide.markdown.includes("Next.js without a single app directory"));
  assert(guide.markdown.includes("ambiguous_app_directory"));
});

test("a directory without package.json asks for the application root", (t) => {
  const result = run(repository(t), []);
  assert.equal(result.status, 0);
  assert(result.stdout.includes("No package.json here."));
});

test("the playbook's Next peer ranges match @commish/next", () => {
  const { peerDependencies } = read("packages/next/package.json");
  assert.deepEqual(nextPeers, { next: peerDependencies.next, react: peerDependencies.react });
});

test("init rejects unknown arguments without echoing them and documents itself", (t) => {
  const root = repository(t);
  const rejected = run(root, ["init", "--private-fixture"]);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  assert(!rejected.stderr.includes("private-fixture"));
  assert.equal(
    JSON.parse(run(root, ["init", "--write", "--json"]).stderr).code,
    "invalid_arguments",
  );
  const help = run(root, ["init", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: commish init \[--json\]/);
});

test("native Windows keeps the bare usage text and refuses init", (t) => {
  const root = repository(t, { "package.json": { name: "shop" } });
  const bare = run(root, [], ["--import", windows]);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /^Commish developer CLI\n/);
  const refused = run(root, ["init", "--json"], ["--import", windows]);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).code, "unsupported_platform");
});
