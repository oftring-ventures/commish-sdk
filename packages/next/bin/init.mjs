#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };

const args = process.argv.slice(2);
const json = args.includes("--json");
const usage = {
  status: "help",
  commands: ["init [--write] [--json]", "pages <init|doctor|verify-alias> [options]", "--version"],
  moved: { setup: "commish setup", verify: "commish verify --json" },
  integrationVerified: false,
};
const usageText = [
  "Usage: commish-next [init] [--write] [--json]",
  "       commish-next pages <init|doctor|verify-alias> [--apply|--dry-run] [--root-aliases] [--prefix /c] [--creator handle] [--json]",
  "       commish-next --version",
  "Credential setup and verification live in @commish/sdk: commish setup, commish verify --json.",
].join("\n");
// Private-file safety relies on POSIX modes; use WSL on Windows.
if (process.platform === "win32") {
  console.error(json ? JSON.stringify({ status: "error", code: "unsupported_platform", platform: "win32",
    guidance: "Run the Commish CLI on macOS, Linux or WSL." })
    : "The Commish CLI supports macOS, Linux and WSL; native Windows is not supported.");
  process.exit(1);
}
if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
  console.log(json ? JSON.stringify({ name: manifest.name, version: manifest.version }) : manifest.version);
  process.exit(0);
}
if (args.some((arg) => ["--help", "-h", "help"].includes(arg)) &&
    args.every((arg) => ["--help", "-h", "help", "--json"].includes(arg))) {
  console.log(json ? JSON.stringify(usage) : usageText);
  process.exit(0);
}
if (["setup", "verify"].includes(args[0])) {
  // Both moved to the framework-independent CLI, which keeps key material on disk
  // before any request and resumes safely; this package keeps install and Pages.
  const command = `commish ${args[0]}`;
  console.error(json ? JSON.stringify({ status: "error", code: "command_moved", command,
    guidance: `Run ${command} from @commish/sdk; commish-next keeps the installer and Pages commands.` })
    : `commish-next ${args[0]} moved to ${command} (@commish/sdk).`);
  process.exit(1);
}
if (args[0] === "pages") {
  try {
    const { runPages } = await import("./pages.mjs");
    const result = await runPages(args.slice(1));
    console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  } catch (error) {
    // Pages reports stable snake_case codes; anything else (a transport or runtime
    // error) is reported as unavailable so receipts never carry raw messages.
    if (process.env.COMMISH_DEBUG === "1") console.error(error);
    const code = /^[a-z][a-z0-9_]{2,80}$/.test(error?.message ?? "") ? error.message : "pages_unavailable";
    console.error(JSON.stringify({ status: "error", code, integrationVerified: false }));
    process.exitCode = 1;
  }
} else try {
  let parsed;
  try {
    parsed = parseArgs({ args, strict: true, allowPositionals: true,
      options: { write: { type: "boolean" }, json: { type: "boolean" } } });
  } catch {
    throw new Error(usageText);
  }
  if (parsed.positionals.length > 1 || (parsed.positionals[0] ?? "init") !== "init" ||
      new Set(args).size !== args.length) throw new Error(usageText);
  const stat = (path) => {
    try { return lstatSync(path); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  // Next ignores src/app when a root app directory exists.
  const app = stat("app") ? "app" : stat("src/app") ? "src/app" : null;
  if (!app) throw new Error("No Next.js App Router directory found.");
  const safePath = (path) => {
    let current = ".";
    for (const part of path.split("/")) {
      current = join(current, part);
      const entry = stat(current);
      if (entry && (entry.isSymbolicLink() || (current !== path && !entry.isDirectory())))
        throw new Error(`Refusing unsafe path: ${current}`);
    }
  };
  safePath(`${app}/`);
  const typed = Boolean(stat("tsconfig.json") || stat(`${app}/layout.tsx`));
  const files = {
    [`${app}/api/commish/attribution/route.${typed ? "ts" : "js"}`]: `import { createAttributionHandler } from "@commish/next";

export const runtime = "nodejs";
export const POST = createAttributionHandler({
  apiUrl: process.env.COMMISH_API_URL,
  secretKey: process.env.COMMISH_SECRET_KEY,
});
`,
    [`${app}/commish-provider.${typed ? "tsx" : "jsx"}`]: `import { CommishProvider } from "@commish/next/react";
${typed ? 'import type { ReactNode } from "react";\n' : ""}
export default function CommishRootProvider({ children }${typed ? ": { children: ReactNode }" : ""}) {
  return (
    <CommishProvider
      publishableKey={process.env.NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY${typed ? "!" : ""}}
      applicationId={process.env.NEXT_PUBLIC_COMMISH_APPLICATION_ID${typed ? "!" : ""}}
    >
      {children}
    </CommishProvider>
  );
}
`,
  };
  for (const extension of ["js", "jsx", "ts", "tsx"])
    if (stat(`${app}/api/commish/attribution/page.${extension}`))
      throw new Error("The attribution URL already has a page. Choose a different capturePath and integrate using the Next setup guide.");
  const plan = Object.entries(files).map(([path, content]) => {
    safePath(path);
    for (const extension of ["js", "jsx", "ts", "tsx"])
      if (path.replace(/\.[^.]+$/, `.${extension}`) !== path &&
          stat(path.replace(/\.[^.]+$/, `.${extension}`)))
        throw new Error(`Conflicting file extension for ${path}; integrate using the Next setup guide.`);
    const entry = stat(path);
    return { path, status: !entry ? "create" :
      entry.isFile() && readFileSync(path, "utf8") === content ? "unchanged" : "conflict" };
  });
  const conflicts = plan.filter(({ status }) => status === "conflict");
  if (conflicts.length) throw new Error(`Existing custom files: ${conflicts.map(({ path }) => path).join(", ")}. No files changed; integrate using the Next setup guide.`);
  const write = Boolean(parsed.values.write);
  if (write) for (const { path, status } of plan) if (status === "create") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, files[path], { flag: "wx" });
  }
  const result = {
    status: write ? "files_installed" : "plan", app, files: plan,
    requiredEnvironment: ["COMMISH_API_URL", "COMMISH_SECRET_KEY",
      "NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY", "NEXT_PUBLIC_COMMISH_APPLICATION_ID"],
    next: [
      `Import CommishRootProvider from './commish-provider' in the existing ${app}/layout file and wrap its existing children. Preserve the layout's other content.`,
      "Set matching application credentials for the selected TEST or LIVE mode. Keep COMMISH_SECRET_KEY server-only.",
      "Await referral capture before Checkout; await withCommishStripeMetadata(params) in your authenticated server Checkout handler.",
      "Build the application, then verify a referral capture and attributed Checkout in TEST before LIVE activation.",
    ],
    integrationVerified: false,
  };
  console.log(json ? JSON.stringify(result) : [
    write ? "Commish integration files installed." : "Commish setup plan (use --write to install).",
    ...plan.map(({ path, status }) => `${status}: ${path}`),
    `Required environment: ${result.requiredEnvironment.join(", ")}`,
    ...result.next,
  ].join("\n"));
} catch (error) {
  if (process.env.COMMISH_DEBUG === "1") console.error(error);
  console.error(json ? JSON.stringify({ status: "error", message: error.message }) : error.message);
  process.exitCode = 1;
}
