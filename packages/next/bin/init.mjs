#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
if (args[0] === "verify") {
  const fail = (code) => { throw new Error(code); };
  try {
    if (args.slice(1).some((arg) => arg !== "--json") || new Set(args).size !== args.length)
      fail("invalid_arguments");
    const env = process.env;
    const secret = env.COMMISH_SECRET_KEY ?? "";
    const key = secret.match(/^cm_(test|live)_sk_[A-Za-z0-9_-]{12,}$/);
    const publishable = (env.NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY ?? "").match(/^cm_(test|live)_pk_[A-Za-z0-9_-]{12,}$/);
    const applicationId = env.NEXT_PUBLIC_COMMISH_APPLICATION_ID;
    const programId = env.COMMISH_PROGRAM_ID;
    if (!key || !publishable || !/^app_[A-Za-z0-9_-]{12,}$/.test(applicationId ?? "") ||
        !/^prg_[A-Za-z0-9_-]{12,}$/.test(programId ?? "")) fail("invalid_configuration");
    if (key[1] !== publishable[1]) fail("key_mode_mismatch");
    let api;
    try { api = new URL(env.COMMISH_API_URL ?? "https://app.commish.sh/api/v1"); }
    catch { fail("invalid_api_url"); }
    if (api.username || api.password || api.search || api.hash ||
        !/^\/api\/v1\/?$/.test(api.pathname) ||
        !(api.protocol === "https:" || api.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(api.hostname))) fail("invalid_api_url");
    const response = await fetch(`${api.href.replace(/\/$/, "")}/programs/${programId}`, {
      method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail(({ 401: "invalid_api_key", 403: "access_denied", 404: "program_not_found" })[response.status] ?? "verification_unavailable");
    }
    const chunks = []; let size = 0;
    if (!response.body) fail("invalid_response");
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 65_536) fail("invalid_response");
      chunks.push(chunk);
    }
    let program;
    try { program = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data; }
    catch { fail("invalid_response"); }
    if (!program || program.id !== programId ||
        !["test", "live"].includes(program.mode) ||
        !["draft", "active", "paused", "suspended", "archived"].includes(program.status)) fail("invalid_response");
    if (program.applicationId !== applicationId) fail("application_mismatch");
    if (program.mode !== key[1]) fail("program_mode_mismatch");
    const result = {
      status: "configuration_verified", mode: key[1], applicationId, programId,
      programStatus: program.status,
      checks: ["secret_key_authenticated", "program_accessible", "application_matches", "mode_matches", "publishable_key_mode_matches"],
      unverified: ["publishable_key_binding", "consumer_wiring", "attribution", "checkout", "webhooks", "refunds", "renewals", "payouts"],
      integrationVerified: false,
    };
    console.log(json ? JSON.stringify(result) :
      `Configuration verified (${result.mode}, program ${programId}, status ${program.status}).\n` +
      "Publishable-key binding and end-to-end integration remain unverified. Use --json for individual checks.");
  } catch (error) {
    const codes = ["invalid_arguments", "invalid_configuration", "key_mode_mismatch", "invalid_api_url",
      "invalid_api_key", "access_denied", "program_not_found", "verification_unavailable",
      "invalid_response", "application_mismatch", "program_mode_mismatch"];
    const code = codes.includes(error?.message) ? error.message : "verification_unavailable";
    console.error(json ? JSON.stringify({ status: "error", code, integrationVerified: false }) : `Verification failed: ${code}.`);
    process.exitCode = 1;
  }
} else try {
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
