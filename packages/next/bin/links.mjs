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
  // /commish-link is where the root link page lives, so a prefix route there would share its segment.
  if (["/api", "/admin", "/auth", "/login", "/commish-link"].includes(prefix))
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
function claim(app, segment, path, content) {
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
  const base = { path, content, inventory, routeParts };
  const entry = stat(path);
  if (entry?.isFile() && readFileSync(path, "utf8") === content)
    return { ...base, status: "unchanged", existing: path };
  // Anything else already under the segment, in either router, owns it. That
  // includes the same route in a route group or with another extension.
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
  // A dynamic or catch-all route that could also answer /<segment>/<handle>.
  const target = [...segment.split("/"), "[creator]"];
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

function plan(prefix) {
  // Next ignores src/app when a root app directory exists.
  const app = stat("app") ? "app" : stat("src/app") ? "src/app" : null;
  if (!app) throw new Error("next_app_router_required");
  safe(`${app}/`);
  const typed = Boolean(stat("tsconfig.json") || stat(`${app}/layout.tsx`));
  const segment = prefix.slice(1);
  const path = `${app}/${segment}/[creator]/route.${typed ? "ts" : "js"}`;
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
  // A Commish Pages page at this address, inside a route group or not, already
  // forwards creators who have no page, so nothing is installed beside it.
  const inventory = filesAt(app);
  const pagesPage = inventory.find(
    (file) =>
      /\/page\.[jt]sx?$/.test(file) &&
      file
        .slice(app.length + 1)
        .split("/")
        .filter((part) => !/^\(.+\)$/.test(part))
        .slice(0, -1)
        .join("/") === `${segment}/[creator]` &&
      readFileSync(file, "utf8").includes("@commish/next/pages"),
  );
  if (pagesPage) return { app, path, content, status: "served_by_pages", existing: pagesPage };
  const { inventory: _files, routeParts: _parts, ...claimed } = claim(app, segment, path, content);
  return { app, ...claimed };
}

// The verify commands carry the installed prefix: an omitted --prefix means /c.
const rootSteps = (prefix) => {
  const flag = prefix === "/c" ? "" : ` --prefix ${prefix}`;
  return `Deploy. Then, in this order: run \`commish-next links verify${flag}\` (short links need a verified link route), turn on short links for this product in the Commish dashboard, and run \`commish-next links verify --root${flag}\`.`;
};

// A rewrite source that takes every one-segment path: /:path, /:path*, /:path+,
// /:path(.*), /:path(.+), /(.*) or /(.+). Only rules inside rewrites count: a headers() or
// redirects() rule that matches every path does not route anything.
const CATCH_ALL = /^\/(?:\(\.[*+]\)|:[A-Za-z_]\w*(?:[*+]|\(\.[*+]\))?)$/;
function catchAllRewrite(text) {
  const keyword = /\brewrites\b/g;
  for (let match = keyword.exec(text); match; match = keyword.exec(text)) {
    // The rewrites function or list: from the first { or [ after the name to
    // its matching close, skipping strings and comments.
    let index = match.index + match[0].length;
    while (index < text.length && !"{[".includes(text[index])) index += 1;
    const start = index;
    let depth = 0;
    for (; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (char === "/" && next === "/") {
        const end = text.indexOf("\n", index);
        index = end < 0 ? text.length : end;
      } else if (char === "/" && next === "*") {
        const end = text.indexOf("*/", index + 2);
        index = end < 0 ? text.length : end + 1;
      } else if ("'\"`".includes(char)) {
        for (index += 1; index < text.length && text[index] !== char; index += 1) {
          if (text[index] === "\\") index += 1;
        }
      } else if ("{[(".includes(char)) {
        depth += 1;
      } else if ("}])".includes(char)) {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = text.slice(start, index + 1);
    for (const [, source] of body.matchAll(/source\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      if (CATCH_ALL.test(source)) return source;
    }
    keyword.lastIndex = Math.max(keyword.lastIndex, index + 1);
  }
  return null;
}

// Root links (brand.com/<name>): a page that receives a fallback rewrite, so
// the site's own pages always win and a path that is not a creator shows the
// site's own not-found page. Only a project without a Next config gets one
// written; an existing config is merged by hand.
function rootPlan(app, typed, servedByPages, prefix) {
  const ROOT_STEPS = rootSteps(prefix);
  const review = ["middleware", "proxy", "src/middleware", "src/proxy"]
    .flatMap((name) => [`${name}.ts`, `${name}.js`])
    .filter(stat);
  if (servedByPages) {
    // On a Commish Pages site the alias handler serves bare root links, and
    // only once it opts in; this command never edits a file that exists.
    const handlers = filesAt(app).filter(
      (file) =>
        /\/route\.[jt]sx?$/.test(file) &&
        readFileSync(file, "utf8").includes("createCreatorAliasHandler"),
    );
    if (!handlers.length)
      return {
        files: [],
        review,
        rewrite: "pages_alias_handler_required",
        next: "Root links on a Commish Pages site are served by the Pages alias handler, which is not installed. Run `commish-next pages init --root-aliases --dry-run`, follow it, then run this command again.",
      };
    const opted = handlers.find((file) => /rootLinks\s*:\s*true/.test(readFileSync(file, "utf8")));
    // Bare root paths reach the alias handler only through its fallback rewrite.
    const pagesConfig = ["js", "mjs", "cjs", "ts", "mts"]
      .map((ext) => `next.config.${ext}`)
      .find(stat);
    const routed =
      pagesConfig !== undefined &&
      readFileSync(pagesConfig, "utf8").includes("creatorPageFallbackRewrite(");
    if (opted && !routed)
      return {
        files: [{ path: opted, status: "unchanged" }],
        review,
        rewrite: "pages_alias_rewrite_required",
        next: `${pagesConfig ?? "next.config"} has no \`creatorPageFallbackRewrite()\`, so bare root paths never reach ${opted}. Add it from "@commish/next/pages/routing" as the LAST entry of the \`fallback\` list of \`rewrites()\` (\`commish-next pages init --root-aliases --dry-run\` shows the merge). ${ROOT_STEPS}`,
      };
    return opted
      ? {
          files: [{ path: opted, status: "unchanged" }],
          review,
          rewrite: "served_by_pages",
          next: ROOT_STEPS,
        }
      : {
          files: [{ path: handlers[0], status: "manual_edit_required" }],
          review,
          rewrite: "pages_alias_opt_in_required",
          next: `In ${handlers[0]}, pass \`{ rootLinks: true }\` as the second argument of \`createCreatorAliasHandler\`, keeping any \`notFound\` you already pass. Without it the handler serves page aliases only. ${ROOT_STEPS}`,
        };
  }
  // A root dynamic or catch-all route answers every path first; only its owner can hand one over.
  const topLevel = (file) =>
    file
      .slice(app.length + 1)
      .split("/")
      .filter((part) => !/^\(.+\)$/.test(part));
  // Only a pattern that can match exactly one segment answers /<name>: [x], a
  // catch-all [...x] or [[...x]] at the top, or [x] followed by an optional [[...y]].
  const catchAllPart = (part) => /^\[\[?\.\.\./.test(part ?? "");
  const matchesOneSegment = (segments) =>
    catchAllPart(segments[0]) ||
    (segments[0]?.startsWith("[") &&
      (segments.length === 1 || (segments.length === 2 && /^\[\[\.\.\./.test(segments[1]))));
  const rootDynamic =
    filesAt(app).some((file) => {
      const parts = topLevel(file);
      return /^(page|route)\.[jt]sx?$/.test(parts.at(-1)) && matchesOneSegment(parts.slice(0, -1));
    }) ||
    ["pages", "src/pages"].some(
      (dir) =>
        stat(dir)?.isDirectory() &&
        filesAt(dir).some((file) => {
          const parts = file
            .slice(dir.length + 1)
            .replace(/\.[^./]+$/, "")
            .split("/");
          if (parts.at(-1) === "index") parts.pop();
          return parts[0] !== "api" && matchesOneSegment(parts);
        }),
    );
  if (rootDynamic)
    return {
      files: [],
      review,
      rewrite: "manual_cms_fallback_required",
      next: `A dynamic route at the top of ${app}/ answers every path, so a fallback rewrite is never reached. Only that route can hand a path over, for the paths it does not own. A page (\`[slug]/page.tsx\`): create \`const RootLink = createReferralLinkPage(source)\` from "@commish/next/links/page" at module scope and \`return RootLink({ params })\`. A route handler: create \`const rootLink = createReferralLinkRoute(source, { root: true })\` from "@commish/next/links" at module scope and \`return rootLink(request, context)\`. ${ROOT_STEPS}`,
    };
  // A loading file at the top of the app wraps the root link page: unknown
  // paths would answer 200 and creator links a client-side refresh.
  const loading = ["tsx", "ts", "jsx", "js"].map((ext) => `${app}/loading.${ext}`).filter(stat);
  const path = `${app}/commish-link/[creator]/page.${typed ? "tsx" : "js"}`;
  const content = `import { createReferralLinkPage } from "@commish/next/links/page";

export const dynamic = "force-dynamic";
// Receives the fallback rewrite of root links: /<name>. A path that is not a
// creator shows your own not-found page.
export default createReferralLinkPage(() => ({
  secretKey: process.env.COMMISH_SECRET_KEY${typed ? "!" : ""},
  apiUrl: process.env.COMMISH_API_URL,
}));
`;
  const claimed = claim(app, "commish-link", path, content);
  const page = {
    path,
    content,
    status: claimed.status,
    ...(claimed.status === "conflict"
      ? { existing: claimed.existing, manualIntegration: claimed.manualIntegration }
      : {}),
  };
  const configs = ["js", "mjs", "cjs", "ts", "mts"].map((ext) => `next.config.${ext}`).filter(stat);
  if (configs.length) {
    const text = readFileSync(configs[0], "utf8");
    // Already merged, by this command or by hand: say so instead of asking again.
    if (text.includes("referralLinkFallbackRewrite("))
      return {
        files: [page, { path: configs[0], status: "unchanged" }],
        review,
        loading,
        rewrite: "fallback_rewrite_present",
        next: ROOT_STEPS,
      };
    // A rule that already matches every path leaves no place for this one:
    // behind it root links are never reached, ahead of it your own pages are not.
    const catchAll = catchAllRewrite(text);
    // Like a top-level dynamic route: no root page is written where a rewrite can never reach it.
    if (catchAll)
      return {
        files: [],
        review,
        loading,
        rewrite: "catch_all_rewrite_blocks_root_links",
        next: `${configs[0]} already has a rewrite that matches every path (\`${catchAll}\`). Root links cannot be added as a fallback beside it: placed after that rule they are never reached, and placed before it they would take one-segment paths away from the site that rule serves. Keep prefix links, or narrow that rule so it no longer matches one-segment paths.`,
      };
    return {
      files: [page],
      review,
      loading,
      rewrite: "manual_config_merge_required",
      next: `Add \`referralLinkFallbackRewrite()\` from "@commish/next/links" as the LAST entry of the \`fallback\` list of \`rewrites()\` in ${configs[0]}, keeping every existing rule ahead of it. If \`rewrites()\` returns an array today, return \`{ afterFiles: [...thatArray], fallback: [referralLinkFallbackRewrite()] }\` instead. Never use beforeFiles or middleware for this. ${ROOT_STEPS}`,
    };
  }
  const config = `import { referralLinkFallbackRewrite } from "@commish/next/links";

export default {
  async rewrites() {
    // Fallback only, and last: every page, asset and route of your own is matched first.
    return { beforeFiles: [], afterFiles: [], fallback: [referralLinkFallbackRewrite()] };
  },
};
`;
  safe("next.config.mjs");
  return {
    files: [page, { path: "next.config.mjs", content: config, status: "create" }],
    review,
    loading,
    rewrite: "fallback_rewrite_supported",
    next: ROOT_STEPS,
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
      ...(selected.root
        ? {
            root: {
              // The dashboard switch; null when Commish could not tell.
              enabled: typeof data.root?.enabled === "boolean" ? data.root.enabled : null,
              verified: data.root?.verified === true,
            },
          }
        : {}),
      integrationVerified: false,
      next: data.verified
        ? [
            ...(selected.root
              ? [
                  data.root?.verified
                    ? "Unknown paths at the top of your site reach the link route. Each creator's link switches to the short form once Commish has checked their name."
                    : data.root?.enabled === false
                      ? "Short links are switched off for this product. Turn them on in the Commish dashboard (the product's Creator links on your website section), then run this command again."
                      : typeof data.root?.enabled !== "boolean"
                        ? "Commish could not check the root fallback just now. Run this command again shortly."
                        : "Short links are on, but unknown paths at the top of your site do not reach the link route with the check header. Confirm the fallback rewrite from `commish-next links init --root` is deployed, and that @commish/next is 0.10.0 or later on that deployment.",
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
    ? rootPlan(route.app, typed, route.status === "served_by_pages", selected.prefix)
    : null;
  if (selected.apply) {
    const writes = [route, ...(root?.files ?? [])];
    if (route.status === "conflict") throw new Error(route.manualIntegration);
    const blocked = writes.find((file) => file.status === "conflict");
    if (blocked)
      throw new Error(blocked.manualIntegration ?? "existing_files_require_manual_integration");
    for (const file of writes)
      if (file.status === "create") {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content, { flag: "wx" });
      }
  }
  // A conflict on the root page names its reason as the prefix route's would.
  const rootManual = root?.files.find((file) => file.manualIntegration)?.manualIntegration;
  return {
    // "files_installed" only when this run wrote something.
    status: !selected.apply
      ? "plan"
      : [route, ...(root?.files ?? [])].some((file) => file.status === "create")
        ? "files_installed"
        : "no_changes",
    ...((route.manualIntegration ?? rootManual)
      ? { manualIntegration: route.manualIntegration ?? rootManual }
      : {}),
    app: route.app,
    prefix: selected.prefix,
    files: [
      {
        path: route.status === "served_by_pages" ? route.existing : route.path,
        status: route.status,
        ...(route.status === "conflict" ? { existing: route.existing } : {}),
      },
      ...(root?.files ?? []).map(({ path, status, existing, manualIntegration }) => ({
        path,
        status,
        ...(existing ? { existing } : {}),
        ...(manualIntegration ? { manualIntegration } : {}),
      })),
    ],
    ...(root ? { rootRewrite: root.rewrite } : {}),
    // Middleware or a proxy runs before every rewrite; confirm it lets root paths through.
    ...(root?.review.length ? { routingReviewRequired: root.review } : {}),
    ...(root?.loading?.length ? { loadingBoundaryReviewRequired: root.loading } : {}),
    requiredEnvironment: ["COMMISH_API_URL", "COMMISH_SECRET_KEY"],
    next: [
      ...(root?.loading?.length
        ? [
            `Move ${root.loading[0]} into a route group (such as ${route.app}/(site)/) so it no longer wraps ${route.app}/commish-link: at the top of ${route.app}/ it makes every unknown one-segment path answer 200, and creator links a client-side refresh instead of a redirect.`,
          ]
        : []),
      ...(root ? [root.next] : []),
      "Deploy, then run `commish-next links verify` with the same prefix so Commish checks the route on your verified website.",
      "Until that check passes, creators keep their commish.sh links. Nothing changes for existing links.",
      "Keep the existing referral capture on the destination page; the link route only forwards the buyer there.",
    ],
    integrationVerified: false,
  };
}
