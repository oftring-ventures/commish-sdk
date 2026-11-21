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
  const again = f.run("links", "init", "--apply", "--json");
  assert.deepEqual(again.out.files, [{ path: "app/c/[creator]/route.ts", status: "unchanged" }]);
  assert.equal(
    again.out.status,
    "no_changes",
    "a run that wrote nothing does not claim an install",
  );
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
    // The root link page's own segment; a prefix route there would collide with it.
    ["/commish-link", "reserved_link_prefix"],
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
  assert.equal(refused.error.code, "existing_page_namespace_requires_manual_integration");
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
  assert.equal(served.out.status, "no_changes");
  assert.deepEqual(served.out.files, [
    { path: "app/c/[creator]/page.tsx", status: "served_by_pages" },
  ]);
  assert.throws(() => readFileSync(join(pages.root, "app/c/[creator]/route.ts")));

  const sibling = fixture(t);
  mkdirSync(join(sibling.root, "app/c/[slug]"), { recursive: true });
  writeFileSync(join(sibling.root, "app/c/[slug]/page.tsx"), "export default function Page() {}\n");
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

test("links init --root adds the root page and a fallback config only where it is safe", (t) => {
  const fresh = fixture(t);
  const planned = fresh.run("links", "init", "--root", "--json");
  assert.equal(planned.out.rootRewrite, "fallback_rewrite_supported");
  assert.deepEqual(
    planned.out.files.map(({ path, status }) => `${status} ${path}`),
    [
      "create app/c/[creator]/route.ts",
      "create app/commish-link/[creator]/page.tsx",
      "create next.config.mjs",
    ],
  );
  // The order a fresh install has to follow: the prefix route is verified first.
  assert.match(planned.out.next[0], /links verify`.*turn on short links.*links verify --root/s);
  assert.equal(
    fresh.run("links", "init", "--root", "--apply", "--json").out.status,
    "files_installed",
  );
  const page = readFileSync(join(fresh.root, "app/commish-link/[creator]/page.tsx"), "utf8");
  // A page, so a path that is not a creator shows the site's own not-found page.
  assert.match(page, /createReferralLinkPage/);
  assert.match(page, /@commish\/next\/links\/page/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  const config = readFileSync(join(fresh.root, "next.config.mjs"), "utf8");
  assert.match(config, /fallback: \[referralLinkFallbackRewrite\(\)\]/);
  assert.match(config, /beforeFiles: \[\]/);
  // A second run reports what is there instead of asking for another merge.
  const again = fresh.run("links", "init", "--root", "--apply", "--json");
  assert.equal(again.out.status, "no_changes");
  assert.equal(again.out.rootRewrite, "fallback_rewrite_present");
  assert.deepEqual(
    again.out.files.map(({ path, status }) => `${status} ${path}`),
    [
      "unchanged app/c/[creator]/route.ts",
      "unchanged app/commish-link/[creator]/page.tsx",
      "unchanged next.config.mjs",
    ],
  );
  assert.doesNotMatch(again.out.next[0], /Add `referralLinkFallbackRewrite/);

  const configured = fixture(t);
  writeFileSync(
    join(configured.root, "next.config.ts"),
    "export default { reactStrictMode: true };\n",
  );
  writeFileSync(join(configured.root, "middleware.ts"), "export function middleware() {}\n");
  const merge = configured.run("links", "init", "--root", "--apply", "--json");
  assert.equal(merge.out.rootRewrite, "manual_config_merge_required");
  assert.match(merge.out.next[0], /LAST entry of the `fallback` list/);
  assert.match(merge.out.next[0], /returns an array today.*afterFiles: \[\.\.\.thatArray\]/s);
  assert.deepEqual(merge.out.routingReviewRequired, ["middleware.ts"]);
  assert.equal(
    readFileSync(join(configured.root, "next.config.ts"), "utf8"),
    "export default { reactStrictMode: true };\n",
  );
  assert.ok(readFileSync(join(configured.root, "app/commish-link/[creator]/page.tsx"), "utf8"));

  // A rule that already matches every path leaves no safe place for the fallback.
  const proxied = fixture(t);
  writeFileSync(
    join(proxied.root, "next.config.mjs"),
    'export default { rewrites: async () => ({ fallback: [{ source: "/:path*", destination: "https://legacy.example/:path*" }] }) };\n',
  );
  const blocked = proxied.run("links", "init", "--root", "--json");
  assert.equal(blocked.out.rootRewrite, "catch_all_rewrite_blocks_root_links");
  assert.match(blocked.out.next[0], /Keep prefix links/);
  assert.match(blocked.out.next[0], /`\/:path\*`/);

  const cms = fixture(t);
  mkdirSync(join(cms.root, "app/[...slug]"), { recursive: true });
  writeFileSync(join(cms.root, "app/[...slug]/page.tsx"), "export default function Page() {}\n");
  const owned = cms.run("links", "init", "--root", "--json");
  assert.equal(owned.out.rootRewrite, "manual_cms_fallback_required");
  assert.deepEqual(
    owned.out.files.map(({ path }) => path),
    ["app/c/[creator]/route.ts"],
    "no root page is written where a rewrite could never reach it",
  );
});

test("links init --root checks who owns the root page's address", (t) => {
  // The same page in a route group: Next would refuse to build both.
  const grouped = fixture(t);
  mkdirSync(join(grouped.root, "app/(site)/commish-link/[creator]"), { recursive: true });
  writeFileSync(
    join(grouped.root, "app/(site)/commish-link/[creator]/page.tsx"),
    "export default function Page() {}\n",
  );
  const duplicate = grouped.run("links", "init", "--root", "--apply", "--json");
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.error.code, "existing_page_namespace_requires_manual_integration");
  assert.throws(() => readFileSync(join(grouped.root, "app/commish-link/[creator]/page.tsx")));
  // The same page with another extension is not silently doubled either.
  const other = fixture(t);
  mkdirSync(join(other.root, "app/commish-link/[creator]"), { recursive: true });
  writeFileSync(
    join(other.root, "app/commish-link/[creator]/page.js"),
    "export default function Page() {}\n",
  );
  assert.equal(other.run("links", "init", "--root", "--json").out.files[1].status, "conflict");
});

test("on a Commish Pages site links init --root asks for the alias handler's opt-in", (t) => {
  const pages = fixture(t);
  mkdirSync(join(pages.root, "app/c/[creator]"), { recursive: true });
  writeFileSync(
    join(pages.root, "app/c/[creator]/page.tsx"),
    'import { createCreatorPage } from "@commish/next/pages";\n',
  );
  const missing = pages.run("links", "init", "--root", "--apply", "--json");
  assert.equal(missing.out.status, "no_changes");
  assert.equal(missing.out.rootRewrite, "pages_alias_handler_required");
  assert.match(missing.out.next[0], /pages init --root-aliases/);
  const handler = "app/api/commish/alias/[creator]/route.ts";
  mkdirSync(join(pages.root, "app/api/commish/alias/[creator]"), { recursive: true });
  writeFileSync(
    join(pages.root, handler),
    "export const GET = createCreatorAliasHandler(pagesOptions);\n",
  );
  const asked = pages.run("links", "init", "--root", "--apply", "--json");
  assert.equal(asked.out.rootRewrite, "pages_alias_opt_in_required");
  assert.deepEqual(asked.out.files[1], { path: handler, status: "manual_edit_required" });
  assert.match(asked.out.next[0], /\{ rootLinks: true \}/);
  // Never edited for the merchant.
  assert.equal(
    readFileSync(join(pages.root, handler), "utf8"),
    "export const GET = createCreatorAliasHandler(pagesOptions);\n",
  );
  writeFileSync(
    join(pages.root, handler),
    "export const GET = createCreatorAliasHandler(pagesOptions, { rootLinks: true });\n",
  );
  const served = pages.run("links", "init", "--root", "--apply", "--json");
  assert.equal(served.out.status, "no_changes");
  assert.equal(served.out.rootRewrite, "served_by_pages");
  assert.throws(() => readFileSync(join(pages.root, "next.config.mjs")));
});

test("links verify --root reports the switch and the fallback separately", async (t) => {
  let root = { enabled: true, verified: true };
  const bodies = [];
  const fetcher = mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({
      data: {
        verified: true,
        route: {
          origin: "https://brand.example",
          prefix: "/c",
          template: "https://brand.example/c/{creator}",
        },
        root,
      },
    });
  });
  const previous = process.env.COMMISH_SECRET_KEY;
  t.after(() => {
    fetcher.mock.restore();
    if (previous === undefined) delete process.env.COMMISH_SECRET_KEY;
    else process.env.COMMISH_SECRET_KEY = previous;
  });
  process.env.COMMISH_SECRET_KEY = secretKey;
  const passed = await runLinks(["verify", "--root"]);
  assert.deepEqual(passed.root, { enabled: true, verified: true });
  assert.deepEqual(bodies[0], { prefix: "/c", root: true });
  root = { enabled: false, verified: false };
  const off = await runLinks(["verify", "--root"]);
  assert.deepEqual(off.root, { enabled: false, verified: false });
  assert.match(off.next[0], /switched off for this product/);
  root = { enabled: true, verified: false };
  const unreached = await runLinks(["verify", "--root"]);
  assert.match(unreached.next[0], /do not reach the link route with the check header/);
  // The switch could not be read (an older Commish, or the root check could not run).
  root = { enabled: null, verified: false };
  const unknown = await runLinks(["verify", "--root"]);
  assert.deepEqual(unknown.root, { enabled: null, verified: false });
  assert.match(unknown.next[0], /could not check the root fallback just now/);
  root = { verified: false };
  assert.deepEqual((await runLinks(["verify", "--root"])).root, { enabled: null, verified: false });
  assert.equal((await runLinks(["verify"])).root, undefined);
});

test("links init applies the same ownership rules as pages init", (t) => {
  // A page in a route group answers the same URL: Next would refuse to build both.
  const grouped = fixture(t);
  mkdirSync(join(grouped.root, "app/(shop)/c/[slug]"), { recursive: true });
  writeFileSync(
    join(grouped.root, "app/(shop)/c/[slug]/page.tsx"),
    "export default function Page() {}\n",
  );
  const group = grouped.run("links", "init", "--apply", "--json");
  assert.equal(group.status, 1);
  assert.equal(group.error.code, "existing_page_namespace_requires_manual_integration");
  assert.throws(() => readFileSync(join(grouped.root, "app/c/[creator]/route.ts")));
  assert.equal(
    grouped.run("links", "init", "--json").out.manualIntegration,
    "existing_page_namespace_requires_manual_integration",
  );

  // A Commish Pages page inside a route group still serves the links.
  const groupedPages = fixture(t);
  mkdirSync(join(groupedPages.root, "app/(marketing)/c/[creator]"), { recursive: true });
  writeFileSync(
    join(groupedPages.root, "app/(marketing)/c/[creator]/page.tsx"),
    'import { createCreatorPage } from "@commish/next/pages";\n',
  );
  assert.deepEqual(groupedPages.run("links", "init", "--apply", "--json").out.files, [
    { path: "app/(marketing)/c/[creator]/page.tsx", status: "served_by_pages" },
  ]);

  // The Pages Router shares the namespace.
  const legacy = fixture(t);
  mkdirSync(join(legacy.root, "pages/c"), { recursive: true });
  writeFileSync(join(legacy.root, "pages/c/[slug].js"), "export default function Page() {}\n");
  assert.equal(
    legacy.run("links", "init", "--apply", "--json").error.code,
    "existing_page_namespace_requires_manual_integration",
  );

  // A root catch-all owns every path; only it can hand /c/* over.
  for (const [dir, file] of [
    ["app/[...slug]", "page.tsx"],
    ["app/[[...slug]]", "page.tsx"],
    ["app/(site)/[section]/[item]", "page.tsx"],
  ]) {
    const cms = fixture(t);
    mkdirSync(join(cms.root, dir), { recursive: true });
    writeFileSync(join(cms.root, dir, file), "export default function Page() {}\n");
    const refused = cms.run("links", "init", "--apply", "--json");
    assert.equal(refused.error.code, "dynamic_route_ownership_requires_manual_integration", dir);
    assert.throws(() => readFileSync(join(cms.root, "app/c/[creator]/route.ts")));
  }
  const legacyCatchAll = fixture(t);
  mkdirSync(join(legacyCatchAll.root, "pages"), { recursive: true });
  writeFileSync(
    join(legacyCatchAll.root, "pages/[...slug].js"),
    "export default function Page() {}\n",
  );
  assert.equal(
    legacyCatchAll.run("links", "init", "--apply", "--json").error.code,
    "dynamic_route_ownership_requires_manual_integration",
  );

  // An unrelated dynamic route elsewhere is not a reason to refuse.
  const unrelated = fixture(t);
  mkdirSync(join(unrelated.root, "app/blog/[slug]"), { recursive: true });
  writeFileSync(
    join(unrelated.root, "app/blog/[slug]/page.tsx"),
    "export default function Page() {}\n",
  );
  assert.equal(unrelated.run("links", "init", "--apply", "--json").out.status, "files_installed");
});

test("links init --root reads only rewrites for a rule that takes every path", (t) => {
  const config = (text) => {
    const project = fixture(t);
    writeFileSync(join(project.root, "next.config.mjs"), text);
    return project.run("links", "init", "--root", "--json").out.rootRewrite;
  };
  // Security headers and a www-to-apex redirect for every path route nothing.
  assert.equal(
    config(
      'export default { async headers() { return [{ source: "/:path*", headers: [{ key: "x-frame-options", value: "DENY" }] }]; } };\n',
    ),
    "manual_config_merge_required",
  );
  assert.equal(
    config(
      'export default { async redirects() { return [{ source: "/(.*)", has: [{ type: "host", value: "www.brand.example" }], destination: "https://brand.example/:path*", permanent: true }]; } };\n',
    ),
    "manual_config_merge_required",
  );
  // A fallback with a one-or-more parameter takes every one-segment path too.
  assert.equal(
    config(
      "export default {\n  // the old site's pages\n  async rewrites() {\n    return { fallback: [{ source: '/:path+', destination: 'https://legacy.example/:path+' }] };\n  },\n};\n",
    ),
    "catch_all_rewrite_blocks_root_links",
  );
  assert.equal(
    config(
      'export default { rewrites: async () => [{ source: "/blog/:path*", destination: "https://blog.example/:path*" }] };\n',
    ),
    "manual_config_merge_required",
    "a rule under a prefix leaves one-segment paths free",
  );
});

test("links init --root asks for a root loading file to move into a route group", (t) => {
  for (const app of ["app", "src/app"]) {
    const project = fixture(t);
    if (app === "src/app") {
      rmSync(join(project.root, "app"), { recursive: true });
      mkdirSync(join(project.root, "src/app"), { recursive: true });
      writeFileSync(
        join(project.root, "src/app/layout.tsx"),
        "export default function Layout() {}\n",
      );
    }
    writeFileSync(
      join(project.root, `${app}/loading.tsx`),
      "export default function Loading() {}\n",
    );
    const planned = project.run("links", "init", "--root", "--json");
    assert.deepEqual(planned.out.loadingBoundaryReviewRequired, [`${app}/loading.tsx`]);
    assert.match(planned.out.next[0], new RegExp(`Move ${app}/loading\\.tsx into a route group`));
    assert.match(planned.out.next[0], /answer 200/);
  }
  const grouped = fixture(t);
  mkdirSync(join(grouped.root, "app/(site)"));
  writeFileSync(
    join(grouped.root, "app/(site)/loading.tsx"),
    "export default function Loading() {}\n",
  );
  const fine = grouped.run("links", "init", "--root", "--json");
  assert.equal(fine.out.loadingBoundaryReviewRequired, undefined);
  assert.equal(grouped.run("links", "init", "--json").out.loadingBoundaryReviewRequired, undefined);
});
