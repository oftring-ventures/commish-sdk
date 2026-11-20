import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { runLinks } from "../packages/next/bin/links.mjs";

const secretKey = "cm_live_sk_fixture_123456789012";
const cli = fileURLToPath(new URL("../packages/next/bin/init.mjs", import.meta.url));
function fixture(t, typed = true) {
  const root = mkdtempSync(join(tmpdir(), "commish-links-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "app"));
  writeFileSync(
    join(root, `app/layout.${typed ? "tsx" : "jsx"}`),
    "export default function Layout() {}\n",
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16.4.6" } }));
  return {
    root,
    run: (...args) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
      return {
        status: result.status,
        out: result.stdout ? JSON.parse(result.stdout) : null,
        error: result.stderr ? JSON.parse(result.stderr) : null,
      };
    },
  };
}

test("links init plans by default and applies only a missing route", (t) => {
  const f = fixture(t);
  const planned = f.run("links", "init", "--json");
  assert.equal(planned.status, 0);
  assert.equal(planned.out.status, "plan");
  assert.deepEqual(planned.out.files, [{ path: "app/c/[creator]/route.ts", status: "create" }]);
  assert.throws(() => readFileSync(join(f.root, "app/c/[creator]/route.ts")));
  const applied = f.run("links", "init", "--apply", "--json");
  assert.equal(applied.out.status, "files_installed");
  const source = readFileSync(join(f.root, "app/c/[creator]/route.ts"), "utf8");
  assert.match(source, /createReferralLinkRoute\(\(\) => \(\{/);
  assert.match(source, /from "@commish\/next\/links"/);
  assert.match(source, /process\.env\.COMMISH_SECRET_KEY!/);
  assert.deepEqual(f.run("links", "init", "--apply", "--json").out.files, [
    { path: "app/c/[creator]/route.ts", status: "unchanged" },
  ]);
  assert.equal(applied.out.integrationVerified, false);
});

test("links init honours a custom prefix and plain JavaScript projects", (t) => {
  const f = fixture(t, false);
  const applied = f.run("links", "init", "--prefix", "/creators", "--apply", "--json");
  assert.deepEqual(applied.out.files, [
    { path: "app/creators/[creator]/route.js", status: "create" },
  ]);
  const source = readFileSync(join(f.root, "app/creators/[creator]/route.js"), "utf8");
  assert.ok(!source.includes("COMMISH_SECRET_KEY!"));
  for (const [prefix, code] of [
    ["c", "invalid_link_prefix"],
    ["/api", "reserved_link_prefix"],
    ["/C", "invalid_link_prefix"],
  ])
    assert.equal(f.run("links", "init", "--prefix", prefix, "--json").error.code, code);
});

test("links init never overwrites a merchant route and steps aside for Commish Pages", (t) => {
  const custom = fixture(t);
  mkdirSync(join(custom.root, "app/c/[creator]"), { recursive: true });
  writeFileSync(
    join(custom.root, "app/c/[creator]/route.ts"),
    "export const GET = () => new Response();\n",
  );
  assert.equal(custom.run("links", "init", "--json").out.files[0].status, "conflict");
  const refused = custom.run("links", "init", "--apply", "--json");
  assert.equal(refused.status, 1);
  assert.equal(refused.error.code, "existing_files_require_manual_integration");
  assert.equal(
    readFileSync(join(custom.root, "app/c/[creator]/route.ts"), "utf8"),
    "export const GET = () => new Response();\n",
  );

  const pages = fixture(t);
  mkdirSync(join(pages.root, "app/c/[creator]"), { recursive: true });
  writeFileSync(
    join(pages.root, "app/c/[creator]/page.tsx"),
    'import { createCreatorPage } from "@commish/next/pages";\n',
  );
  const served = pages.run("links", "init", "--apply", "--json");
  assert.equal(served.status, 0);
  assert.deepEqual(served.out.files, [
    { path: "app/c/[creator]/page.tsx", status: "served_by_pages" },
  ]);
  assert.throws(() => readFileSync(join(pages.root, "app/c/[creator]/route.ts")));

  const sibling = fixture(t);
  mkdirSync(join(sibling.root, "app/c/[slug]"), { recursive: true });
  assert.equal(sibling.run("links", "init", "--json").out.files[0].status, "conflict");

  const linked = fixture(t);
  mkdirSync(join(linked.root, "elsewhere"));
  symlinkSync(join(linked.root, "elsewhere"), join(linked.root, "app/c"));
  assert.equal(linked.run("links", "init", "--apply", "--json").error.code, "unsafe_install_path");

  const none = fixture(t);
  rmSync(join(none.root, "app"), { recursive: true });
  assert.equal(none.run("links", "init", "--json").error.code, "next_app_router_required");
});

test("links verify reports the checked route and never claims an integration", async (t) => {
  const calls = [];
  let verified = true;
  const fetcher = mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({
      data: {
        verified,
        route: verified
          ? {
              origin: "https://brand.example",
              prefix: "/c",
              template: "https://brand.example/c/{creator}",
            }
          : null,
      },
    });
  });
  const previous = { key: process.env.COMMISH_SECRET_KEY, api: process.env.COMMISH_API_URL };
  t.after(() => {
    fetcher.mock.restore();
    for (const [name, value] of [
      ["COMMISH_SECRET_KEY", previous.key],
      ["COMMISH_API_URL", previous.api],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  delete process.env.COMMISH_SECRET_KEY;
  await assert.rejects(() => runLinks(["verify"]), /secret_key_required/);
  process.env.COMMISH_SECRET_KEY = secretKey;
  process.env.COMMISH_API_URL = "https://commish.example/api/v1";
  const passed = await runLinks(["verify", "--origin", "https://brand.example"]);
  assert.equal(passed.status, "verified");
  assert.equal(passed.route.template, "https://brand.example/c/{creator}");
  assert.equal(passed.integrationVerified, false);
  assert.deepEqual(calls[0], {
    url: "https://commish.example/api/v1/link-route/verify",
    body: { prefix: "/c", origin: "https://brand.example" },
  });
  verified = false;
  const failed = await runLinks(["verify", "--prefix", "/creators"]);
  assert.equal(failed.status, "unverified");
  assert.equal(failed.route, null);
  assert.match(failed.next[0], /\/creators\/<handle>/);
  await assert.rejects(() => runLinks(["verify", "--apply"]), /invalid_links_command/);
  await assert.rejects(
    () => runLinks(["verify", "--origin", "https://brand.example/x"]),
    /invalid_link_origin/,
  );
  await assert.rejects(
    () => runLinks(["init", "--origin", "https://brand.example"]),
    /invalid_links_command/,
  );
  fetcher.mock.mockImplementation(async () =>
    Response.json(
      { error: { code: "origin_unverified", message: "Verify this website." } },
      { status: 409 },
    ),
  );
  await assert.rejects(() => runLinks(["verify"]), /origin_unverified/);
});
