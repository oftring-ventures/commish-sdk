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
  return { command, apply: Boolean(parsed.values.apply), prefix, origin };
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
      integrationVerified: false,
      next: data.verified
        ? [
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
  if (selected.apply) {
    if (route.status === "conflict") throw new Error(route.manualIntegration);
    if (route.status === "create") {
      mkdirSync(dirname(route.path), { recursive: true });
      writeFileSync(route.path, route.content, { flag: "wx" });
    }
  }
  return {
    // "files_installed" only when this run wrote something.
    status: !selected.apply ? "plan" : route.status === "create" ? "files_installed" : "no_changes",
    ...(route.manualIntegration ? { manualIntegration: route.manualIntegration } : {}),
    app: route.app,
    prefix: selected.prefix,
    files: [
      {
        path: route.status === "served_by_pages" ? route.existing : route.path,
        status: route.status,
        ...(route.status === "conflict" ? { existing: route.existing } : {}),
      },
    ],
    requiredEnvironment: ["COMMISH_API_URL", "COMMISH_SECRET_KEY"],
    next: [
      "Deploy, then run `commish-next links verify` with the same prefix so Commish checks the route on your verified website.",
      "Until that check passes, creators keep their commish.sh links. Nothing changes for existing links.",
      "Keep the existing referral capture on the destination page; the link route only forwards the buyer there.",
    ],
    integrationVerified: false,
  };
}
