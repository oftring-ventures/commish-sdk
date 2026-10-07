import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(
  new URL("../packages/next/bin/init.mjs", import.meta.url),
);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "commish-pages-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "app"));
  writeFileSync(
    join(root, "app/layout.tsx"),
    "export default function Layout() {}\n",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { next: "16.3.6" } }),
  );
  return {
    root,
    run: (...args) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf8",
      }),
  };
}
test("no arguments remain a dry run and Pages apply creates only missing files", (t) => {
  const f = fixture(t),
    before = readdirSync(join(f.root, "app"));
  assert.equal(f.run().status, 0);
  assert.deepEqual(readdirSync(join(f.root, "app")), before);
  let result = f.run("pages", "--dry-run", "--json");
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).integrationVerified, false);
  assert.deepEqual(readdirSync(join(f.root, "app")), before);
  result = f.run("pages", "--apply", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(join(f.root, "app/c/[creator]/page.tsx"), "utf8"),
    /createCreatorPage/,
  );
  result = f.run("pages", "--apply", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    JSON.parse(result.stdout).files.every(
      (file) => file.status === "unchanged",
    ),
  );
});
test("custom files and symlinks are never overwritten", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "app/c/[creator]"), { recursive: true });
  writeFileSync(join(f.root, "app/c/[creator]/page.tsx"), "merchant-owned");
  assert.notEqual(f.run("pages", "--apply").status, 0);
  assert.equal(
    readFileSync(join(f.root, "app/c/[creator]/page.tsx"), "utf8"),
    "merchant-owned",
  );
  assert.deepEqual(readdirSync(join(f.root, "app")), ["c", "layout.tsx"]);
  symlinkSync(join(f.root, "app"), join(f.root, "app/linked"));
  assert.notEqual(f.run("pages", "--apply").status, 0);
});
test("CMS catch-alls require manual namespace delegation without changing merchant files", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "app/[[...slug]]"));
  writeFileSync(join(f.root, "app/[[...slug]]/page.tsx"), "cms-owned");
  const result = f.run("pages", "--root-aliases", "--apply", "--json");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /dynamic_route_ownership_requires_manual_integration/,
  );
  assert.deepEqual(readdirSync(join(f.root, "app")), [
    "[[...slug]]",
    "layout.tsx",
  ]);
  assert.ok(!readdirSync(f.root).includes("next.config.mjs"));
  assert.equal(
    readFileSync(join(f.root, "app/[[...slug]]/page.tsx"), "utf8"),
    "cms-owned",
  );
});
for (const route of [
  "[section]/[slug]",
  "api/[...route]",
  "(cms)/[section]/[slug]",
]) {
  test(`dynamic route ${route} cannot be silently shadowed`, (t) => {
    const f = fixture(t);
    mkdirSync(join(f.root, "app", route), { recursive: true });
    writeFileSync(join(f.root, "app", route, "page.tsx"), "merchant-owned");
    const result = f.run("pages", "--apply", "--json");
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /dynamic_route_ownership_requires_manual_integration/,
    );
    assert.ok(!readdirSync(join(f.root, "app")).includes("c"));
  });
}
test("doctor is read-only and rejects apply", (t) => {
  const f = fixture(t);
  assert.equal(f.run("pages", "doctor", "--json").status, 0);
  assert.notEqual(f.run("pages", "doctor", "--apply").status, 0);
  assert.deepEqual(readdirSync(join(f.root, "app")), ["layout.tsx"]);
});
test("doctor checks every Pages entry point and the installed peer floors without executing package code", (t) => {
  const f = fixture(t);
  const put = (name, manifest) => {
    const dir = join(f.root, "node_modules", name);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    for (const file of ["index", "pages", "pages-handlers", "pages-routing"])
      writeFileSync(
        join(dir, "dist", `${file}.js`),
        "throw new Error('doctor must not execute this');",
      );
  };
  put("@commish/sdk", { version: "0.2.3", exports: "./dist/index.js" });
  const adapter = {
    version: "0.2.3",
    exports: {
      "./pages": "./dist/pages.js",
      "./pages/handlers": "./dist/pages-handlers.js",
      "./pages/routing": "./dist/pages-routing.js",
    },
    peerDependencies: { next: ">=16.3.6 <17", react: ">=19.2.8 <20" },
  };
  put("@commish/next", adapter);
  put("next", { version: "16.3.6" });
  put("react", { version: "19.2.7" });
  const status = () =>
    JSON.parse(f.run("pages", "doctor", "--json").stdout).installedPackages
      .status;
  assert.equal(status(), "peer_review_required");
  put("react", { version: "19.2.8" });
  assert.equal(status(), "pages_export_present_check_build");
  delete adapter.exports["./pages/handlers"];
  put("@commish/next", adapter);
  assert.equal(status(), "pages_export_or_peer_not_installed");
});
