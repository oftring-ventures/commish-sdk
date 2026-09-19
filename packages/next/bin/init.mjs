#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
try {
  if (args.some((arg) => !["init", "--write", "--json"].includes(arg)) ||
      new Set(args).size !== args.length) throw new Error("Usage: commish-next [init] [--write] [--json]");
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
  const write = args.includes("--write");
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
  console.error(json ? JSON.stringify({ status: "error", message: error.message }) : error.message);
  process.exitCode = 1;
}
