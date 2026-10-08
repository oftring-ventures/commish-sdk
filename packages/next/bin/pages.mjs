import {
  lstatSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const stat = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
function safe(path) {
  let at = ".";
  for (const part of path.split("/")) {
    at = join(at, part);
    const item = stat(at);
    if (item?.isSymbolicLink() || (item && at !== path && !item.isDirectory()))
      throw new Error("unsafe_install_path");
  }
}
function filesAt(root) {
  const result = [];
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${item.name}`;
    if (item.isSymbolicLink())
      throw new Error("symlink_requires_manual_integration");
    if (item.isDirectory()) result.push(...filesAt(path));
    else result.push(path);
  }
  return result;
}
function options(args) {
  const value = {
    command: "init",
    prefix: "/c",
    apply: false,
    aliases: false,
    json: false,
    creator: null,
  };
  if (args[0] && !args[0].startsWith("--")) value.command = args.shift();
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error("duplicate_option");
    seen.add(arg);
    if (arg === "--apply") value.apply = true;
    else if (arg === "--dry-run") value.apply = false;
    else if (arg === "--root-aliases") value.aliases = true;
    else if (arg === "--json") value.json = true;
    else if (arg === "--prefix") value.prefix = args[++i];
    else if (arg === "--creator") value.creator = args[++i];
    else throw new Error("unknown_pages_option");
  }
  if (
    !["init", "doctor", "verify-alias"].includes(value.command) ||
    (seen.has("--apply") && seen.has("--dry-run"))
  )
    throw new Error("invalid_pages_command");
  if (!/^\/[a-z][a-z0-9-]{0,29}$/.test(value.prefix))
    throw new Error("invalid_page_prefix");
  if (["/api", "/_next", "/admin", "/auth", "/login"].includes(value.prefix))
    throw new Error("reserved_page_prefix");
  if (
    value.creator !== null &&
    !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(value.creator)
  )
    throw new Error("invalid_creator");
  if (value.command === "doctor" && value.apply)
    throw new Error("doctor_is_read_only");
  return value;
}
function plan(value, diagnostic = false) {
  const app = stat("app") ? "app" : stat("src/app") ? "src/app" : null;
  if (!app) throw new Error("next_app_router_required");
  safe(`${app}/`);
  const inventory = filesAt(app),
    segment = value.prefix.slice(1);
  // Pages Router files win or collide at build time; inventory them too.
  const legacy = ["pages", "src/pages"]
    .filter((dir) => stat(dir)?.isDirectory())
    .flatMap((dir) =>
      filesAt(dir).map((path) =>
        path.slice(dir.length + 1).replace(/(\/index)?\.[^./]+$/, ""),
      ),
    );
  const typed = !!(stat("tsconfig.json") || stat(`${app}/layout.tsx`));
  const ts = typed ? "ts" : "js",
    jsx = typed ? "tsx" : "jsx";
  const rootDynamic = inventory.some((path) => {
    const parts = path
      .slice(app.length + 1)
      .split("/")
      .filter((part) => !/^\(.+\)$/.test(part));
    return (
      parts[0]?.startsWith("[") && /^(page|route)\.[jt]sx?$/.test(parts.at(-1))
    );
  });
  const configFiles = [
    "next.config.ts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
  ].filter((path) => stat(path));
  const aliasCompatibility =
    rootDynamic || legacy.some((route) => /^\[[^/]*\]$/.test(route))
      ? "manual_cms_fallback_required"
      : configFiles.length
        ? "manual_config_merge_required"
        : "fallback_rewrite_supported";
  const files = {
    [`${app}/commish-pages.${ts}`]: `// Server-only configuration. Never move these values into a client module.\nexport const pagesOptions = () => ({\n  secretKey: process.env.COMMISH_SECRET_KEY${typed ? "!" : ""},\n  programId: process.env.COMMISH_PAGES_PROGRAM_ID${typed ? "!" : ""},\n  origin: process.env.COMMISH_PAGES_ORIGIN${typed ? "!" : ""},\n  prefix: ${JSON.stringify(value.prefix)},\n  apiUrl: process.env.COMMISH_API_URL,\n});\n`,
    [`${app}/${segment}/[creator]/page.${jsx}`]: `import { createCreatorPage } from "@commish/next/pages";\nimport { pagesOptions } from "../../commish-pages";\n\nexport const dynamic = "force-dynamic";\nexport default createCreatorPage(pagesOptions);\n`,
    [`${app}/api/commish/pages/route.${ts}`]: `import { createCreatorPageHandlers } from "@commish/next/pages/handlers";\nimport { pagesOptions } from "../../../commish-pages";\n\nexport const runtime = "nodejs";\nexport const { POST } = createCreatorPageHandlers({\n  options: pagesOptions,\n  publishableKey: () => process.env.NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY${typed ? "!" : ""},\n  // Connect your consent manager before enabling measurement or attribution.\n  consent: () => ({ attribution: false, measurement: false }),\n});\n`,
  };
  if (value.aliases) {
    files[`${app}/api/commish/alias/[creator]/route.${ts}`] =
      `import { createCreatorAliasHandler } from "@commish/next/pages/routing";\nimport { pagesOptions } from "../../../../commish-pages";\n\nexport const runtime = "nodejs";\nexport const GET = createCreatorAliasHandler(pagesOptions);\n`;
    if (aliasCompatibility === "fallback_rewrite_supported")
      files["next.config.mjs"] =
        `import { creatorPageFallbackRewrite } from "@commish/next/pages/routing";\n\nexport default {\n  async rewrites() { return { fallback: [creatorPageFallbackRewrite()] }; },\n};\n`;
  }
  const proposed = Object.entries(files).map(([path, content]) => {
    safe(path);
    const alternate = ["js", "jsx", "ts", "tsx", "mjs", "cjs"].some(
      (extension) => {
        const candidate = path.replace(/\.[^.]+$/, `.${extension}`);
        return candidate !== path && !!stat(candidate);
      },
    );
    const present = stat(path);
    return {
      path,
      status: alternate
        ? "conflict"
        : !present
          ? "create"
          : present.isFile() && readFileSync(path, "utf8") === content
            ? "unchanged"
            : "conflict",
    };
  });
  const normalized = (path) =>
    path
      .slice(app.length + 1)
      .split("/")
      .filter((part) => !/^\(.+\)$/.test(part))
      .join("/");
  const routingConflicts = inventory.filter((path) => {
    const route = normalized(path);
    return (
      (route.startsWith(`${segment}/`) ||
        route.startsWith("api/commish/pages/") ||
        (value.aliases && route.startsWith("api/commish/alias/"))) &&
      !(path in files)
    );
  });
  const routeParts = (path) => normalized(path).split("/").slice(0, -1);
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
  // A new static namespace also outranks existing dynamic/CMS routes. File
  // non-overwrite alone is not enough to establish permission to take a URL.
  const ambiguousRoutes = inventory.filter(
    (path) =>
      !(path in files) &&
      /\/(page|route)\.[jt]sx?$/.test(path) &&
      Object.keys(files).some(
        (target) =>
          /\/(page|route)\.[jt]sx?$/.test(target) &&
          overlaps(routeParts(path), routeParts(target)),
      ),
  );
  const legacyConflicts = legacy.filter(
    (route) =>
      route === segment ||
      route.startsWith(`${segment}/`) ||
      route.startsWith("api/commish/"),
  );
  const manualIntegration = ambiguousRoutes.length
    ? "dynamic_route_ownership_requires_manual_integration"
    : routingConflicts.length || legacyConflicts.length
      ? "existing_page_namespace_requires_manual_integration"
      : null;
  // The read-only doctor reports a customized install instead of failing.
  if (manualIntegration && !diagnostic) throw new Error(manualIntegration);
  let compatibility = "unverified";
  try {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const next = manifest.dependencies?.next ?? manifest.devDependencies?.next;
    compatibility =
      typeof next === "string" && /(?:^|[~^])16\./.test(next)
        ? "next_16_declared_check_peer_versions"
        : "check_next_peer_compatibility";
  } catch {
    /* Diagnostic remains read-only and reports missing information. */
  }
  return {
    app,
    files,
    proposed,
    aliasCompatibility,
    compatibility,
    manualIntegration,
    existingAttributionRoute: inventory.some((path) =>
      /api\/commish\/attribution\/route\.[jt]s$/.test(path),
    ),
    routingReviewRequired: [
      "middleware.ts",
      "middleware.js",
      "proxy.ts",
      "proxy.js",
      "src/middleware.ts",
      "src/middleware.js",
      "src/proxy.ts",
      "src/proxy.js",
    ].some((path) => stat(path)),
  };
}
function endpoint(environment) {
  const url = new URL(
    environment.COMMISH_API_URL ?? "https://app.commish.sh/api/v1",
  );
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname))
    )
  )
    throw new Error("unsafe_api_url");
  const key = environment.COMMISH_SECRET_KEY;
  if (!/^cm_(test|live)_sk_[A-Za-z0-9_-]{12,}$/.test(key ?? ""))
    throw new Error("application_secret_key_required");
  const program = environment.COMMISH_PAGES_PROGRAM_ID;
  if (!/^prg_[A-Za-z0-9_-]{12,}$/.test(program ?? ""))
    throw new Error("program_id_required");
  return { base: url.href.replace(/\/$/, ""), key, program };
}
function installedPackages() {
  const require = createRequire(resolve("package.json"));
  try {
    const sdkPath = require.resolve("@commish/sdk"),
      pagesPath = require.resolve("@commish/next/pages");
    for (const entry of ["handlers", "routing"])
      if (
        dirname(require.resolve(`@commish/next/pages/${entry}`)) !==
        dirname(pagesPath)
      )
        throw new Error("inconsistent_pages_exports");
    const sdk = JSON.parse(
      readFileSync(join(dirname(sdkPath), "../package.json"), "utf8"),
    );
    const adapter = JSON.parse(
      readFileSync(join(dirname(pagesPath), "../package.json"), "utf8"),
    );
    const next = JSON.parse(
      readFileSync(require.resolve("next/package.json"), "utf8"),
    );
    const react = JSON.parse(
      readFileSync(require.resolve("react/package.json"), "utf8"),
    );
    const supported = (version, range) => {
      const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      const bounds = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(range ?? "");
      if (!actual || !bounds || Number(actual[1]) >= Number(bounds[4]))
        return false;
      for (let i = 1; i <= 3; i++) {
        if (Number(actual[i]) !== Number(bounds[i]))
          return Number(actual[i]) > Number(bounds[i]);
      }
      return true;
    };
    return {
      status:
        sdk.version === adapter.version &&
        supported(next.version, adapter.peerDependencies?.next) &&
        supported(react.version, adapter.peerDependencies?.react)
          ? "pages_export_present_check_build"
          : "peer_review_required",
      sdk: sdk.version,
      adapter: adapter.version,
      next: next.version,
      react: react.version,
    };
  } catch {
    return { status: "pages_export_or_peer_not_installed" };
  }
}
async function probe(url) {
  const response = await fetch(url, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  });
  let bytes = 0,
    body = "";
  if (response.body) {
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 262144) {
          await reader.cancel();
          throw new Error("probe_too_large");
        }
        body += decoder.decode(item.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  return { response, body };
}
export async function runPages(args) {
  const value = options([...args]);
  if (value.command === "verify-alias") {
    if (!value.creator) throw new Error("creator_required");
    if (!value.apply)
      return {
        status: "plan",
        next: "Use --apply to probe and update the preferred-link verification result.",
        integrationVerified: false,
      };
    const { base, key, program } = endpoint(process.env);
    const response = await fetch(
      `${base}/pages/${program}/${value.creator}/verify-alias`,
      {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!response.ok) throw new Error("alias_verification_unavailable");
    return {
      status: (await response.json()).data?.verified
        ? "alias_verified"
        : "alias_conflict_or_unavailable",
      integrationVerified: false,
    };
  }
  const setup = plan(value, value.command === "doctor");
  const conflicts = setup.proposed.filter((file) => file.status === "conflict");
  if (value.apply && conflicts.length)
    throw new Error("existing_files_require_manual_integration");
  if (value.apply)
    for (const file of setup.proposed)
      if (file.status === "create") {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, setup.files[file.path], { flag: "wx" });
      }
  let resolution = "not_checked";
  let canonicalRoute = "not_checked",
    aliasRoute = "not_checked",
    configuration = "not_checked";
  let attributionReadiness = "not_checked";
  if (value.command === "doctor" && value.creator) {
    try {
      const { base, key, program } = endpoint(process.env);
      const response = await fetch(
        `${base}/pages/${program}/${value.creator}`,
        {
          redirect: "error",
          cache: "no-store",
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(4000),
        },
      );
      resolution = response.ok
        ? "api_resolved_not_browser_verified"
        : response.status === 404
          ? "not_published_or_unknown"
          : response.status === 401 || response.status === 403
            ? "credential_or_scope_denied"
            : "temporarily_unavailable";
      if (response.ok) {
        const data = await response.json().then(
          (value) => value?.data,
          () => null,
        );
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          configuration = "invalid_api_response";
        } else {
          let origin;
          try {
            origin = new URL(process.env.COMMISH_PAGES_ORIGIN);
          } catch {
            // Keep successful API resolution separate from local configuration.
          }
          if (
            !origin ||
            origin.protocol !== "https:" ||
            origin.origin !== process.env.COMMISH_PAGES_ORIGIN ||
            data.origin !== origin.origin ||
            data.canonicalPath !== `${value.prefix}/${value.creator}` ||
            !/^cpg_[A-Za-z0-9_-]{12,}$/.test(data.pageId)
          ) {
            configuration = "origin_or_prefix_mismatch";
          } else {
            configuration = "matches_resolved_page";
            try {
              const canonical = await probe(
                new URL(data.canonicalPath, origin),
              );
              canonicalRoute =
                canonical.response.status === 200 &&
                canonical.body.includes(`data-commish-page="${data.pageId}"`)
                  ? "correct_page_marker"
                  : "missing_conflicting_or_unavailable";
            } catch {
              canonicalRoute = "missing_conflicting_or_unavailable";
            }
            if (data.rootAliasEnabled) {
              try {
                const alias = await probe(new URL(`/${value.creator}`, origin));
                aliasRoute =
                  alias.response.status === 307 &&
                  alias.response.headers.get("location") ===
                    new URL(data.canonicalPath, origin).href &&
                  alias.response.headers.get("x-commish-page-id") ===
                    data.pageId
                    ? "correct_temporary_redirect_not_promoted"
                    : "conflict_or_unavailable";
              } catch {
                aliasRoute = "conflict_or_unavailable";
              }
            } else aliasRoute = "disabled";
            const publicKey =
              process.env.NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY ?? "";
            attributionReadiness =
              data.status !== "ready"
                ? "ended_no_new_attribution"
                : publicKey.startsWith(`cm_${data.mode}_pk_`)
                  ? "credentials_present_consent_capture_checkout_unverified"
                  : "matching_publishable_key_required";
          }
        }
      }
    } catch {
      resolution = "configuration_or_connection_unavailable";
    }
  }
  return {
    status:
      value.command === "doctor"
        ? "diagnostic"
        : value.apply
          ? "files_installed"
          : "plan",
    app: setup.app,
    files: setup.proposed,
    packageCompatibility: setup.compatibility,
    aliasCompatibility: setup.aliasCompatibility,
    manualIntegration: setup.manualIntegration,
    installedPackages: installedPackages(),
    configuration,
    canonicalRoute,
    aliasRoute,
    attributionReadiness,
    existingAttributionRoute: setup.existingAttributionRoute,
    routingReviewRequired: setup.routingReviewRequired,
    resolution,
    integrationVerified: false,
    next: [
      "Set COMMISH_PAGES_PROGRAM_ID and COMMISH_PAGES_ORIGIN on the server; retain matching existing application credentials.",
      "Connect merchant consent controls in the generated same-origin handler. Both permissions default to denied.",
      "Keep merchant routes and auth unchanged. Merge optional aliases into rewrites().fallback only; CMS catch-alls need an explicit manual fallback.",
      "At authenticated checkout, call withCommishPageMeasurement(params, currentMeasurementConsent) in addition to your existing attribution helper.",
      "Enable Pages and approve/publish content in Commish. Creators independently choose page publication.",
      "Run a TEST typed visit → capture → actual checkout → trusted conversion → refund before claiming end-to-end verification.",
      "Read @commish/next/guides/pages.md and guides/agents.md. Agent instructions are never rewritten automatically.",
    ],
  };
}
