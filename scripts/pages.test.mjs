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
import { runPages } from "../packages/next/bin/pages.mjs";
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
test("doctor reports a customized namespace instead of failing", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "app/c"), { recursive: true });
  writeFileSync(join(f.root, "app/c/loading.tsx"), "merchant-owned");
  assert.notEqual(f.run("pages", "--apply").status, 0);
  const result = f.run("pages", "doctor", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).manualIntegration,
    "existing_page_namespace_requires_manual_integration",
  );
});
test("Pages Router files and src middleware are inventoried", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "pages/c"), { recursive: true });
  writeFileSync(join(f.root, "pages/c/[creator].tsx"), "merchant-owned");
  assert.notEqual(f.run("pages", "--apply").status, 0);
  assert.equal(
    readFileSync(join(f.root, "pages/c/[creator].tsx"), "utf8"),
    "merchant-owned",
  );
  rmSync(join(f.root, "pages"), { recursive: true });
  mkdirSync(join(f.root, "src"));
  writeFileSync(join(f.root, "src/proxy.js"), "export function proxy() {}");
  assert.equal(
    JSON.parse(f.run("pages", "doctor", "--json").stdout).routingReviewRequired,
    true,
  );
});
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

for (const failedProbe of [
  "canonical",
  "alias",
  "configuration",
  "malformed",
]) {
  test(`doctor preserves independent diagnostic results after ${failedProbe} failure`, async (t) => {
    const f = fixture(t),
      cwd = process.cwd();
    const values = {
      COMMISH_API_URL: "https://api.example.test/api/v1",
      COMMISH_SECRET_KEY: "cm_test_sk_fixture_123456789012",
      COMMISH_PAGES_PROGRAM_ID: "prg_123456789012",
      COMMISH_PAGES_ORIGIN: "https://brand.example",
    };
    const before = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    );
    t.after(() => {
      process.chdir(cwd);
      for (const [key, value] of Object.entries(before))
        value === undefined
          ? delete process.env[key]
          : (process.env[key] = value);
    });
    process.chdir(f.root);
    Object.assign(process.env, values);
    if (failedProbe === "configuration")
      delete process.env.COMMISH_PAGES_ORIGIN;
    t.mock.method(globalThis, "fetch", async (url) => {
      if (String(url).startsWith("https://api.example.test/")) {
        if (failedProbe === "malformed") return Response.json({ data: null });
        return Response.json({
          data: {
            pageId: "cpg_123456789012",
            origin: values.COMMISH_PAGES_ORIGIN,
            canonicalPath: "/c/maya",
            rootAliasEnabled: true,
            status: "ready",
            mode: "test",
          },
        });
      }
      if (String(url).endsWith("/c/maya")) {
        if (failedProbe === "canonical")
          return new Response("x".repeat(262145));
        return new Response('data-commish-page="cpg_123456789012"');
      }
      if (failedProbe === "alias") throw new Error("timeout");
      return new Response(null, {
        status: 307,
        headers: {
          location: "https://brand.example/c/maya",
          "x-commish-page-id": "cpg_123456789012",
        },
      });
    });
    const result = await runPages(["doctor", "--creator", "maya", "--json"]);
    assert.equal(result.resolution, "api_resolved_not_browser_verified");
    assert.equal(
      result.configuration,
      failedProbe === "malformed"
        ? "invalid_api_response"
        : failedProbe === "configuration"
          ? "origin_or_prefix_mismatch"
          : "matches_resolved_page",
    );
    if (failedProbe !== "configuration" && failedProbe !== "malformed") {
      assert.equal(
        result.canonicalRoute,
        failedProbe === "canonical"
          ? "missing_conflicting_or_unavailable"
          : "correct_page_marker",
      );
      assert.equal(
        result.aliasRoute,
        failedProbe === "alias"
          ? "conflict_or_unavailable"
          : "correct_temporary_redirect_not_promoted",
      );
    }
  });
}
