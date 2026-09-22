#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(24).toString("base64url");
const safeUrl = (raw) => {
  let value;
  try { value = new URL(raw); } catch { throw new Error("invalid_app_url"); }
  if (value.username || value.password || value.search || value.hash || value.pathname !== "/" ||
      !(value.protocol === "https:" || value.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(value.hostname)))
    throw new Error("invalid_app_url");
  return value;
};
const responseJson = async (response) => {
  if (Number(response.headers.get("content-length")) > 65_536 || !response.body)
    throw new Error("invalid_response");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 65_536) throw new Error("invalid_response");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid_response"); }
};
const setupOptions = (values) => {
  const result = { appUrl: "https://app.commish.sh", keyLabel: "Agent setup", open: true };
  const keys = new Set();
  for (let index = 0; index < values.length; index++) {
    const name = values[index];
    if (name === "--json" || name === "--no-open") {
      if (keys.has(name)) throw new Error("invalid_arguments");
      keys.add(name);
      if (name === "--json") result.json = true;
      else result.open = false;
      continue;
    }
    const fields = {
      "--workspace": "workspaceId", "--output": "output",
      "--application-name": "applicationName", "--key-label": "keyLabel",
      "--app-url": "appUrl",
    };
    const field = fields[name], value = values[++index];
    if (!field || keys.has(name) || !value || value.startsWith("--"))
      throw new Error("invalid_arguments");
    keys.add(name); result[field] = value;
  }
  if (!/^wrk_[A-Za-z0-9_-]{12,}$/.test(result.workspaceId ?? "") ||
      !result.output || !result.applicationName?.trim() || result.applicationName.length > 100 ||
      !result.keyLabel.trim() || result.keyLabel.length > 100)
    throw new Error("invalid_arguments");
  result.applicationName = result.applicationName.trim();
  result.keyLabel = result.keyLabel.trim();
  result.appUrl = safeUrl(result.appUrl);
  return result;
};
const openBrowser = (url) => {
  const command = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.on("error", () => {}); child.unref();
};
const credentialTarget = (output) => {
  const target = resolve(output), parent = dirname(target);
  const parentEntry = lstatSync(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink())
    throw new Error("unsafe_output_path");
  try {
    lstatSync(target);
    const error = new Error("output_exists"); error.code = "EEXIST"; throw error;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return target;
};
const saveCredentials = (output, values) => {
  const target = credentialTarget(output), parent = dirname(target);
  const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  const body = Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join("");
  try {
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    linkSync(temporary, target);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
  return target;
};
const setupReceipt = (body, expected) => {
  const value = body?.data, app = value?.application, key = value?.apiKey;
  if (value?.protocol !== "commish-cli-setup-v1" || value.status !== "complete" ||
      value.workspaceId !== expected.workspaceId || typeof value.expiresAt !== "string" ||
      typeof value.replayed !== "boolean" || !/^app_[A-Za-z0-9_-]{12,}$/.test(app?.id ?? "") ||
      app?.name !== expected.applicationName || !Array.isArray(app?.verifiedOrigins) ||
      typeof app?.createdAt !== "string" || !/^key_[A-Za-z0-9_-]{12,}$/.test(key?.id ?? "") ||
      key?.applicationId !== app.id || key?.mode !== "test" ||
      key?.publishableKey !== expected.publishableKey || key?.label !== expected.keyLabel ||
      typeof key?.createdAt !== "string" || key?.lastUsedAt !== null || key?.revokedAt !== null)
    throw new Error("invalid_response");
  return value;
};
const setup = async (values) => {
  const options = setupOptions(values), output = credentialTarget(options.output),
    verifier = randomBytes(32).toString("base64url"),
    publishableKey = `cm_test_pk_${token()}`, secretKey = `cm_test_sk_${token()}`,
    expiresAt = new Date(Date.now() + 570_000).toISOString(),
    request = {
      workspaceId: options.workspaceId, challengeHash: hash(verifier),
      applicationName: options.applicationName, keyLabel: options.keyLabel,
      publishableKey, secretHash: hash(secretKey),
      idempotencyKey: `cli-setup:${randomUUID()}`, expiresAt,
    }, approval = new URL("/cli/setup", options.appUrl);
  approval.search = new URLSearchParams(request).toString();
  process.stderr.write(`Authorize TEST setup in your browser:\n${approval.href}\n`);
  if (options.open) openBrowser(approval.href);
  const exchange = new URL("/api/cli/setup-grants/exchange", options.appUrl);
  let receipt;
  while (Date.now() < Date.parse(expiresAt)) {
    let response;
    try {
      response = await fetch(exchange, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ verifier }), redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const body = await responseJson(response);
      if (response.ok) { receipt = setupReceipt(body, { ...options, publishableKey }); break; }
      if (response.status !== 408 && response.status !== 429 && response.status !== 428 &&
          response.status < 500)
        throw new Error(body?.error?.code === "setup_grant_expired" ? "setup_expired" : "setup_denied");
    } catch (error) {
      if (["setup_expired", "setup_denied", "invalid_response"].includes(error.message)) throw error;
    }
    await delay(2_000);
  }
  if (!receipt) throw new Error("setup_expired");
  const file = saveCredentials(output, {
    COMMISH_API_URL: new URL("/api/v1", options.appUrl).href,
    COMMISH_SECRET_KEY: secretKey,
    NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY: publishableKey,
    NEXT_PUBLIC_COMMISH_APPLICATION_ID: receipt.application.id,
  });
  return {
    status: "test_credentials_configured", mode: "test", workspaceId: options.workspaceId,
    applicationId: receipt.application.id, apiKeyId: receipt.apiKey.id, output: file,
    replayed: receipt.replayed, integrationVerified: false,
    next: "Configure a TEST program, then run commish-next verify --json with COMMISH_PROGRAM_ID.",
  };
};

const args = process.argv.slice(2);
const json = args.includes("--json");
if (args[0] === "setup") {
  try {
    const result = await setup(args.slice(1));
    console.log(json ? JSON.stringify(result) :
      `Commish TEST credentials saved to ${result.output}.\n${result.next}`);
  } catch (error) {
    const code = ["invalid_arguments", "invalid_app_url", "unsafe_output_path", "invalid_response",
      "setup_expired", "setup_denied"].includes(error?.message) ? error.message :
      error?.code === "EEXIST" ? "output_exists" : "setup_unavailable";
    console.error(json ? JSON.stringify({ status: "error", code }) : `Setup failed: ${code}.`);
    process.exitCode = 1;
  }
} else if (args[0] === "verify") {
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
    const mode = key[1] === "live" ? "live" : "test";
    if (mode !== publishable[1]) fail("key_mode_mismatch");
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
    if (program.mode !== mode) fail("program_mode_mismatch");
    const result = {
      status: "configuration_verified", mode, applicationId, programId,
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
