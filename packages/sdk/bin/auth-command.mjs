import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { argumentsFor, errorReceipt, fail, requestJson } from "./cli-http.mjs";
import { writeSetupFile } from "./setup-files.mjs";
import { protectPrivateState } from "./setup-progress.mjs";
import { managementCatalog, managementClient, managementMode, managementUrl, readManagementAuthorization, tokenHash, validateManagementGrant } from "./management-client.mjs";

export const authHelp = () => ({ version: 1, status: "help", commands: ["auth login", "auth status", "auth revoke"],
  flags: ["--workspace <id>", "--application <id>", "--workspace-scope", "--scopes <comma-separated scopes>", "--mode test|live", "--automation", "--expires-in <seconds>", "--auth-file <path>", "--wait <seconds>", "--management-url <url>", "--json", "--no-open", "--non-interactive"],
  scopes: [...new Set(Object.values(managementCatalog.operations).map(op => op.scope))], automationReadOnly: true,
  privateStorage: ".commish/management/<request-id>/authorization.json (owner-only and git-ignored)",
  authorization: "Explicit browser consent and recent authenticator verification. Approval URL is emitted on stderr; credentials never are.",
  environment: ["COMMISH_MANAGEMENT_TOKEN", "COMMISH_MANAGEMENT_URL", "COMMISH_MODE"],
  resume: "auth login --auth-file <returned-path> --mode <approved-mode>",
  revocation: "auth revoke --auth-file <returned-path> --mode <approved-mode>",
  exitCodes: { 0: "authorized_or_revoked_or_status", 1: "sanitized_error", 2: "pending_human_action", 130: "interrupted" } });
export async function executeAuth(args, { root = process.cwd(), env = process.env, fetcher = fetch, notify = () => {},
  now = Date.now, wait = delay, signal } = {}) {
  const { values: v, positionals: p } = argumentsFor(args,
    ["workspace", "application", "scopes", "mode", "expires-in", "auth-file", "wait", "management-url"],
    ["workspace-scope", "automation", "json", "help", "no-open", "non-interactive"]);
  if (v.help || !p.length) return authHelp();
  if (p.length !== 1 || !["login", "status", "revoke"].includes(p[0])) fail("invalid_arguments");
  const mode = managementMode(v.mode, env), authFile = v["auth-file"];
  const clientOptions = { root, env, mode, authFile, url: v["management-url"], fetcher, signal };
  if (p[0] !== "login") {
    if (["workspace", "application", "scopes", "expires-in", "wait", "workspace-scope", "automation"].some(key => v[key] !== undefined)) fail("invalid_arguments");
    const client = managementClient(clientOptions), grant = await client[p[0] === "status" ? "status" : "revoke"]();
    if (p[0] === "revoke" && !["revoked", "denied"].includes(grant.status)) fail("invalid_response");
    return { version: 1, status: p[0] === "revoke" ? "revoked" : grant.status, grant, ...(authFile ? { authorizationFile: authFile } : {}) };
  }
  if (env.COMMISH_MANAGEMENT_TOKEN) fail("ambiguous_authorization");
  let state, path = authFile;
  if (authFile) {
    if (["workspace", "application", "scopes", "expires-in", "workspace-scope", "automation"].some(key => v[key] !== undefined)) fail("invalid_arguments");
    state = readManagementAuthorization(root, authFile);
    if (state.proposal.mode !== mode || v["management-url"] && managementUrl(v["management-url"], {}) !== state.baseUrl) fail("authorization_context_mismatch");
  } else {
    const scopes = v.scopes?.split(","), kind = v.automation ? "automation" : "session";
    if (!/^wrk_[A-Za-z0-9_-]{12,}$/.test(v.workspace ?? "") || Boolean(v.application) === Boolean(v["workspace-scope"]) ||
      v.application && !/^app_[A-Za-z0-9_-]{12,}$/.test(v.application) || !scopes?.length || scopes.length > 15 ||
      new Set(scopes).size !== scopes.length || scopes.some(scope => !authHelp().scopes.includes(scope))) fail("invalid_arguments");
    const writes = scopes.some(scope => !scope.endsWith(".read"));
    const expires = v["expires-in"] ?? String(kind === "automation" ? 86400 : writes ? 600 : 3600);
    if (!/^[1-9][0-9]{1,6}$/.test(expires) || Number(expires) < 60 || Number(expires) > (kind === "automation" ? 2_592_000 : writes ? 600 : 3600) ||
      kind === "automation" && writes || v.application && scopes.some(scope => scope.startsWith("webhooks."))) fail("invalid_arguments");
    const token = `cm_mgmt_${mode}_${randomBytes(32).toString("base64url")}`, hash = tokenHash(token);
    state = { version: 1, baseUrl: managementUrl(v["management-url"], env), token,
      proposal: { challengeHash: hash, workspaceId: v.workspace, applicationId: v.application ?? null, mode, kind, scopes, expiresIn: Number(expires) } };
    path = `.commish/management/${hash.slice(0, 24)}/authorization.json`;
  }
  const seconds = v.wait ?? "300";
  if (!/^(0|[1-9][0-9]{0,2})$/.test(seconds) || Number(seconds) > 600) fail("invalid_arguments");
  protectPrivateState(root);
  // Publish authority privately before begin; retries never lose their bearer.
  writeSetupFile(root, path, JSON.stringify(state) + "\n", { privateFile: true });
  const started = await requestJson(`${state.baseUrl}/grants`, { method: "POST", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify(state.proposal) }, fetcher);
  let grant = validateManagementGrant(started.body.data, state.token, state.proposal);
  const approvalUrl = `${new URL(state.baseUrl).origin}/cli/manage/${grant.requestId}`;
  if (grant.status === "pending") notify({ version: 1, status: "authorization_required", approvalUrl, pairingCode: grant.pairingCode,
    workspaceId: grant.workspaceId, applicationId: grant.applicationId, mode, scopes: grant.scopes, kind: grant.kind,
    requestExpiresAt: grant.requestExpiresAt, authorizationFile: path });
  const client = managementClient({ ...clientOptions, authFile: path }), deadline = now() + Number(seconds) * 1000;
  while (grant.status === "pending" && now() < deadline) {
    if (signal?.aborted) fail("interrupted");
    await wait(Math.min(2000, deadline - now()), undefined, { signal });
    grant = await client.status();
  }
  return { version: 1, status: grant.status, grant, authorizationFile: path, ...(grant.status === "pending" ? { approvalUrl } : {}) };
}
export async function runAuthCommand(args, { out = console.log, diagnostic = console.error, ...options } = {}) {
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const result = await executeAuth(args, { ...options, signal: options.signal ?? controller.signal, notify: value => diagnostic(JSON.stringify(value)) });
    out(JSON.stringify(result)); return result.status === "pending" ? 2 : ["denied", "expired"].includes(result.status) ? 1 : 0;
  } catch (error) {
    const interrupted = controller.signal.aborted || options.signal?.aborted;
    diagnostic(JSON.stringify(interrupted ? { version: 1, status: "error", code: "interrupted", nextAction: "Resume login with the retained authorization file or revoke it." } : errorReceipt(error)));
    return interrupted ? 130 : 1;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}
