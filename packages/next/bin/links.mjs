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

function plan(prefix) {
  // Next ignores src/app when a root app directory exists.
  const app = stat("app") ? "app" : stat("src/app") ? "src/app" : null;
  if (!app) throw new Error("next_app_router_required");
  safe(`${app}/`);
  const typed = Boolean(stat("tsconfig.json") || stat(`${app}/layout.tsx`));
  const directory = `${app}${prefix}/[creator]`;
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
  const extensions = ["js", "jsx", "ts", "tsx"];
  // A Commish Pages page at this address already forwards creators who have no
  // page, so nothing is installed beside it.
  const page = extensions.map((extension) => `${directory}/page.${extension}`).find(stat);
  if (page)
    return {
      app,
      path,
      content,
      status: readFileSync(page, "utf8").includes("@commish/next/pages")
        ? "served_by_pages"
        : "conflict",
      existing: page,
    };
  const other = extensions
    .map((extension) => `${directory}/route.${extension}`)
    .find((candidate) => candidate !== path && stat(candidate));
  if (other) return { app, path, content, status: "conflict", existing: other };
  const entry = stat(path);
  if (entry)
    return {
      app,
      path,
      content,
      status: entry.isFile() && readFileSync(path, "utf8") === content ? "unchanged" : "conflict",
      existing: path,
    };
  // Another dynamic segment beside [creator] would make the address ambiguous.
  const parent = `${app}${prefix}`;
  const siblings = stat(parent)?.isDirectory()
    ? readdirSync(parent).filter((name) => name.startsWith("[") && name !== "[creator]")
    : [];
  if (siblings.length)
    return { app, path, content, status: "conflict", existing: `${parent}/${siblings[0]}` };
  return { app, path, content, status: "create" };
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
    if (route.status === "conflict") throw new Error("existing_files_require_manual_integration");
    if (route.status === "create") {
      mkdirSync(dirname(route.path), { recursive: true });
      writeFileSync(route.path, route.content, { flag: "wx" });
    }
  }
  return {
    status: selected.apply ? "files_installed" : "plan",
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
