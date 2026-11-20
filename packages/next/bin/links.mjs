import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const stat = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
// Refuse to write through a symlink or beneath a non-directory.
function safe(path) {
  let current = ".";
  for (const part of path.split("/")) {
    current = join(current, part);
    const entry = stat(current);
    if (entry && (entry.isSymbolicLink() || (current !== path && !entry.isDirectory())))
      throw new Error("unsafe_install_path");
  }
}
function options(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        apply: { type: "boolean" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        prefix: { type: "string" },
        origin: { type: "string" },
        root: { type: "boolean" },
      },
    });
  } catch {
    throw new Error("invalid_links_command");
  }
  if (new Set(args).size !== args.length) throw new Error("duplicate_option");
  const command = parsed.positionals[0] ?? "init";
  if (parsed.positionals.length > 1 || !["init", "verify"].includes(command))
    throw new Error("invalid_links_command");
  if (parsed.values.apply && parsed.values["dry-run"]) throw new Error("invalid_links_command");
  const prefix = parsed.values.prefix ?? "/c";
  if (!/^\/[a-z][a-z0-9-]{0,29}$/.test(prefix)) throw new Error("invalid_link_prefix");
  if (["/api", "/admin", "/auth", "/login"].includes(prefix))
    throw new Error("reserved_link_prefix");
  const origin = parsed.values.origin;
  if (origin !== undefined) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("invalid_link_origin");
    }
    if (url.protocol !== "https:" || url.origin !== origin) throw new Error("invalid_link_origin");
    if (command !== "verify") throw new Error("invalid_links_command");
  }
  if (command === "verify" && (parsed.values.apply || parsed.values["dry-run"]))
    throw new Error("invalid_links_command");
  return {
    command,
    apply: Boolean(parsed.values.apply),
    prefix,
    origin,
    root: Boolean(parsed.values.root),
  };
}

// Every file under a directory; a symlink anywhere means the tree is not ours to reason about.
function filesAt(root) {
  const result = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${item.name}`;
    if (item.isSymbolicLink()) throw new Error("symlink_requires_manual_integration");
    if (item.isDirectory()) result.push(...filesAt(path));
    else result.push(path);
  }
  return result;
}

// The same ownership rules as `commish-next pages init`: route groups do not
// change a URL, the Pages Router shares the namespace, and a dynamic or
// catch-all route that could answer the address means only its owner can hand
// the address over. File non-overwrite alone does not establish that.
function plan(prefix) {
  // Next ignores src/app when a root app directory exists.
  const app = stat("app") ? "app" : stat("src/app") ? "src/app" : null;
  if (!app) throw new Error("next_app_router_required");
  safe(`${app}/`);
  const typed = Boolean(stat("tsconfig.json") || stat(`${app}/layout.tsx`));
  const segment = prefix.slice(1);
  const directory = `${app}/${segment}/[creator]`;
  const path = `${directory}/route.${typed ? "ts" : "js"}`;
  const content = `import { createReferralLinkRoute } from "@commish/next/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One route serves every current and future creator: ${prefix}/<handle>.
export const GET = createReferralLinkRoute(() => ({
  secretKey: process.env.COMMISH_SECRET_KEY${typed ? "!" : ""},
  apiUrl: process.env.COMMISH_API_URL,
}));
`;
  safe(path);
  const inventory = filesAt(app);
  const legacy = ["pages", "src/pages"]
    .filter((dir) => {
      const item = stat(dir);
      if (item?.isSymbolicLink()) throw new Error("symlink_requires_manual_integration");
      if (item?.isDirectory()) safe(dir);
      return item?.isDirectory();
    })
    .flatMap((dir) =>
      filesAt(dir).map((file) => file.slice(dir.length + 1).replace(/(\/index)?\.[^./]+$/, "")),
    );
  const normalized = (file) =>
    file
      .slice(app.length + 1)
      .split("/")
      .filter((part) => !/^\(.+\)$/.test(part))
      .join("/");
  const routeParts = (file) => normalized(file).split("/").slice(0, -1);
  const overlaps = (left, right) => {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const a = left[i],
        b = right[i];
      if (a?.includes("...")) return a.startsWith("[[") || b !== undefined;
      if (b?.includes("...")) return b.startsWith("[[") || a !== undefined;
      if (!a || !b) return false;
      if (a !== b && !a.startsWith("[") && !b.startsWith("[")) return false;
    }
    return true;
  };
  const isRoute = (file) => /\/(page|route)\.[jt]sx?$/.test(file);
  const base = { app, path, content };
  // A Commish Pages page at this address, inside a route group or not, already
  // forwards creators who have no page, so nothing is installed beside it.
  const pagesPage = inventory.find(
    (file) =>
      /\/page\.[jt]sx?$/.test(file) &&
      routeParts(file).join("/") === `${segment}/[creator]` &&
      readFileSync(file, "utf8").includes("@commish/next/pages"),
  );
  if (pagesPage) return { ...base, status: "served_by_pages", existing: pagesPage };
  const entry = stat(path);
  if (entry?.isFile() && readFileSync(path, "utf8") === content)
    return { ...base, status: "unchanged", existing: path };
  // Anything else already under the prefix, in either router, owns it.
  const occupied =
    inventory.find((file) => file !== path && normalized(file).startsWith(`${segment}/`)) ??
    (entry ? path : undefined) ??
    legacy.find((route) => route === segment || route.startsWith(`${segment}/`));
  if (occupied)
    return {
      ...base,
      status: "conflict",
      existing: occupied,
      manualIntegration: "existing_page_namespace_requires_manual_integration",
    };
  // A dynamic or catch-all route that could also answer /<prefix>/<handle>.
  const target = [segment, "[creator]"];
  const ambiguous =
    inventory.find((file) => isRoute(file) && overlaps(routeParts(file), target)) ??
    legacy.find((route) => overlaps(route.split("/"), target));
  if (ambiguous)
    return {
      ...base,
      status: "conflict",
      existing: ambiguous,
      manualIntegration: "dynamic_route_ownership_requires_manual_integration",
    };
  return { ...base, status: "create" };
}

// Root links (brand.com/<name>): a dedicated route that receives a fallback
// rewrite, so the site's own pages always win. Only a project without a Next
// config gets one written; an existing config is merged by hand.
function rootPlan(app, typed, servedByPages) {
  if (servedByPages)
    return {
      files: [],
      rewrite: "served_by_pages",
      next: "Root links are served by the Commish Pages alias handler here. Run `commish-next pages init --root-aliases --dry-run` and follow it.",
    };
  const path = `${app}/api/commish/link/[creator]/route.${typed ? "ts" : "js"}`;
  const content = `import { createReferralLinkRoute } from "@commish/next/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Receives the fallback rewrite of root links: /<name>. Anything that is not a creator is a 404.
export const GET = createReferralLinkRoute(
  () => ({
    secretKey: process.env.COMMISH_SECRET_KEY${typed ? "!" : ""},
    apiUrl: process.env.COMMISH_API_URL,
  }),
  { root: true },
);
`;
  safe(path);
  const entry = stat(path);
  const route = {
    path,
    content,
    status: !entry
      ? "create"
      : entry.isFile() && readFileSync(path, "utf8") === content
        ? "unchanged"
        : "conflict",
  };
  const configs = ["js", "mjs", "cjs", "ts", "mts"].map((ext) => `next.config.${ext}`).filter(stat);
  // A root dynamic or catch-all route answers every path first; only its owner can hand one over.
  const topLevel = (file) =>
    file
      .slice(app.length + 1)
      .split("/")
      .filter((part) => !/^\(.+\)$/.test(part));
  const rootDynamic =
    filesAt(app).some((file) => {
      const parts = topLevel(file);
      return parts[0]?.startsWith("[") && /^(page|route)\.[jt]sx?$/.test(parts.at(-1));
    }) ||
    ["pages", "src/pages"].some(
      (dir) => stat(dir)?.isDirectory() && readdirSync(dir).some((name) => name.startsWith("[")),
    );
  if (rootDynamic)
    return {
      files: [route],
      rewrite: "manual_cms_fallback_required",
      next: `A dynamic route at the top of ${app}/ answers every path. Have it call the root link route for paths it does not own, then run \`commish-next links verify --root\`.`,
    };
  if (configs.length)
    return {
      files: [route],
      rewrite: "manual_config_merge_required",
      next: `Add \`referralLinkFallbackRewrite()\` from "@commish/next/links" to the \`fallback\` list of \`rewrites()\` in ${configs[0]}, keeping every existing rule. Never use beforeFiles or middleware for this.`,
    };
  const config = `import { referralLinkFallbackRewrite } from "@commish/next/links";

export default {
  async rewrites() {
    // Fallback only: every page, asset and route of your own is matched first.
    return { beforeFiles: [], afterFiles: [], fallback: [referralLinkFallbackRewrite()] };
  },
};
`;
  safe("next.config.mjs");
  return {
    files: [route, { path: "next.config.mjs", content: config, status: "create" }],
    rewrite: "fallback_rewrite_supported",
    next: "Deploy, turn on short links for this product in the Commish dashboard, then run `commish-next links verify --root`.",
  };
}

export async function runLinks(args) {
  const selected = options(args);
  if (selected.command === "verify") {
    const secretKey = process.env.COMMISH_SECRET_KEY;
    if (!secretKey || !/^cm_(?:test|live)_sk_[A-Za-z0-9_-]{12,}$/.test(secretKey))
      throw new Error("secret_key_required");
    const { Commish } = await import("@commish/sdk");
    let data;
    try {
      ({ data } = await new Commish({
        secretKey,
        baseUrl: process.env.COMMISH_API_URL,
      }).links.verifyRoute({
        prefix: selected.prefix,
        origin: selected.origin,
        root: selected.root,
        signal: AbortSignal.timeout(30_000),
      }));
    } catch (error) {
      throw new Error(
        error?.name === "CommishError" && /^[a-z][a-z0-9_]{2,80}$/.test(error.code ?? "")
          ? error.code
          : "links_unavailable",
      );
    }
    return {
      status: data.verified ? "verified" : "unverified",
      route: data.route,
      ...(selected.root ? { root: { verified: data.root?.verified === true } } : {}),
      integrationVerified: false,
      next: data.verified
        ? [
            ...(selected.root
              ? [
                  data.root?.verified
                    ? "Unknown paths at the top of your site reach the link route. Each creator's link switches to the short form once Commish has checked their name."
                    : "Root links are not reaching the link route. Confirm short links are turned on for this product in the Commish dashboard and that the fallback rewrite is deployed.",
                ]
              : []),
            "Creators are now shown links on this website. Their commish.sh links keep working.",
            "Open one creator link in a browser and confirm the referral is captured before relying on it.",
          ]
        : [
            `Deploy the link route so that ${selected.prefix}/<handle> answers on your verified website, with COMMISH_SECRET_KEY for this TEST or LIVE mode set on that deployment.`,
            "Run this command again after the deployment is live. Creators keep their commish.sh links meanwhile.",
          ],
    };
  }
  const route = plan(selected.prefix);
  const typed = route.path.endsWith(".ts");
  const root = selected.root
    ? rootPlan(route.app, typed, route.status === "served_by_pages")
    : null;
  if (selected.apply) {
    const writes = [route, ...(root?.files ?? [])];
    if (route.status === "conflict") throw new Error(route.manualIntegration);
    if (writes.some((file) => file.status === "conflict"))
      throw new Error("existing_files_require_manual_integration");
    for (const file of writes)
      if (file.status === "create") {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content, { flag: "wx" });
      }
  }
  return {
    // "files_installed" only when this run wrote something.
    status: !selected.apply
      ? "plan"
      : [route, ...(root?.files ?? [])].some((file) => file.status === "create")
        ? "files_installed"
        : "no_changes",
    ...(route.manualIntegration ? { manualIntegration: route.manualIntegration } : {}),
    app: route.app,
    prefix: selected.prefix,
    files: [
      {
        path: route.status === "served_by_pages" ? route.existing : route.path,
        status: route.status,
        ...(route.status === "conflict" ? { existing: route.existing } : {}),
      },
      ...(root?.files ?? []).map(({ path, status }) => ({ path, status })),
    ],
    ...(root ? { rootRewrite: root.rewrite } : {}),
    requiredEnvironment: ["COMMISH_API_URL", "COMMISH_SECRET_KEY"],
    next: [
      ...(root ? [root.next] : []),
      "Deploy, then run `commish-next links verify` with the same prefix so Commish checks the route on your verified website.",
      "Until that check passes, creators keep their commish.sh links. Nothing changes for existing links.",
      "Keep the existing referral capture on the destination page; the link route only forwards the buyer there.",
    ],
    integrationVerified: false,
  };
}
