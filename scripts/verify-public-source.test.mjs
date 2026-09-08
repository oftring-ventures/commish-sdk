import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect, verify } from "./verify-public-source.mjs";

function bootstrap() {
  const files = new Map();
  put(files, "LICENSE", readFileSync(new URL("../LICENSE", import.meta.url)));
  put(files, ".gitignore", "node_modules/\ndist/\n*.tgz\n");
  put(
    files,
    "README.md",
    "# Commish public packages\n\nMIT-licensed source for the Commish test-money pilot.\n\nThis repository is receiving independently buildable source layers.\nNo npm publication, release artifact provenance or hosted acceptance is claimed.\n\nSee LICENSE for copyright and permission terms.\n",
  );
  for (const name of [
    ".github/workflows/public-source.yml",
    "scripts/verify-public-source.mjs",
    "scripts/verify-public-source.test.mjs",
  ])
    put(files, name, "");
  return files;
}
function put(files, name, value) {
  files.set(name, {
    mode: "100644",
    data: Buffer.from(
      typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value,
    ),
  });
}

test("only the exact approved bootstrap receives the empty package plan", () => {
  assert.deepEqual(inspect(bootstrap()), []);
  for (const [name, value] of [
    ["README.md", "different"],
    ["packages/sdk/src/browser.ts", "export {}"],
    ["package.json", "{}"],
    ["packages/sdk/package.json", "{}"],
    ["packages/next/package.json", "{}"],
    ["pnpm-workspace.yaml", "packages: []"],
    ["pnpm-lock.yaml", "lockfileVersion: 9"],
    ["surprise.ts", ""],
    [".github/workflows/extra.yml", ""],
  ]) {
    const files = bootstrap();
    put(files, name, value);
    assert.throws(() => inspect(files));
  }
  for (const name of bootstrap().keys()) {
    const files = bootstrap();
    files.delete(name);
    assert.throws(() => inspect(files));
  }
  const linked = bootstrap();
  linked.get("LICENSE").mode = "120000";
  assert.throws(() => inspect(linked));
});
test("verification binds its receipt to the actual immutable checkout and rejects dirty source", () => {
  const root = mkdtempSync(join(tmpdir(), "commish-public-git-test-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  try {
    git("init");
    git("config", "core.hooksPath", "/dev/null");
    for (const [name, { data }] of bootstrap()) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), data);
    }
    git("add", ".");
    git(
      "-c",
      "user.name=Public verifier test",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "fixture",
    );
    const head = git("rev-parse", "HEAD");
    assert.deepEqual(verify(root, head), {
      sha: head,
      scope: "exact-bootstrap-and-automation",
      packages: [],
      consumerChecks: false,
      publication: false,
    });
    for (const sha of [undefined, "", "a".repeat(40)]) assert.throws(() => verify(root, sha));
    writeFileSync(join(root, "README.md"), "dirty");
    assert.throws(() => verify(root, head));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
