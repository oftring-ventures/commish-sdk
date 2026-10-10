import { createHash } from "node:crypto";
import { apiUrl, fail, requestJson } from "./cli-http.mjs";
import { readSetupFile } from "./setup-files.mjs";
import catalog from "./management-catalog.json" with { type: "json" };

export const managementCatalog = catalog;
export const tokenHash = token => createHash("sha256").update(token).digest("hex");
export const managementMode = (value, env) => {
  const mode = value ?? env.COMMISH_MODE ?? "test";
  if (!["test", "live"].includes(mode)) fail("invalid_arguments");
  return mode;
};
export function managementUrl(value, env) {
  return apiUrl(value ?? env.COMMISH_MANAGEMENT_URL ?? "https://app.commish.sh/api/management/v1", "/api/management/v1");
}
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function validateManagementGrant(value, token, expected) {
  const hash = tokenHash(token), mode = token.match(/^cm_mgmt_(test|live)_[A-Za-z0-9_-]{43}$/)?.[1];
  if (!mode || !record(value) || value.protocol !== catalog.protocol || value.requestId !== hash || value.mode !== mode ||
    value.id !== `mgt_${hash.slice(0, 24)}` || value.pairingCode !== `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase() ||
    !/^wrk_[A-Za-z0-9_-]{12,}$/.test(value.workspaceId) ||
    value.applicationId !== null && !/^app_[A-Za-z0-9_-]{12,}$/.test(value.applicationId) ||
    !["session", "automation"].includes(value.kind) || !["pending", "authorized", "denied", "revoked", "expired"].includes(value.status) ||
    !Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length > 15 || new Set(value.scopes).size !== value.scopes.length ||
    value.scopes.some(scope => !Object.values(catalog.operations).some(op => op.scope === scope)) ||
    !Number.isInteger(value.expiresIn) || value.expiresIn < 60 || value.expiresIn > 2_592_000 ||
    !Number.isFinite(Date.parse(value.requestExpiresAt)) || value.expiresAt !== null && !Number.isFinite(Date.parse(value.expiresAt)) ||
    value.status === "authorized" && value.expiresAt === null) fail("invalid_response");
  const writes = value.scopes.some(scope => !scope.endsWith(".read"));
  if (value.kind === "automation" && writes || value.kind === "session" && value.expiresIn > (writes ? 600 : 3600) ||
    value.applicationId !== null && value.scopes.some(scope => scope.startsWith("webhooks."))) fail("invalid_response");
  if (expected && ["workspaceId", "applicationId", "mode", "kind", "expiresIn"].some(field => value[field] !== expected[field]) ||
    expected && [...value.scopes].sort().join() !== [...expected.scopes].sort().join()) fail("authorization_context_mismatch");
  return value;
}
export function readManagementAuthorization(root, filename) {
  let state;
  try { state = JSON.parse(readSetupFile(root, filename, { privateFile: true })); }
  catch { fail("invalid_authorization_file"); }
  if (!record(state) || state.version !== 1 || typeof state.baseUrl !== "string" || typeof state.token !== "string" ||
    !/^cm_mgmt_(test|live)_[A-Za-z0-9_-]{43}$/.test(state.token) || !record(state.proposal)) fail("invalid_authorization_file");
  const baseUrl = managementUrl(state.baseUrl, {});
  if (state.proposal.challengeHash !== tokenHash(state.token)) fail("invalid_authorization_file");
  const hash = tokenHash(state.token);
  try { validateManagementGrant({ ...state.proposal, protocol: catalog.protocol, requestId: hash, id: `mgt_${hash.slice(0, 24)}`,
    pairingCode: `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase(), status: "pending", expiresAt: null, requestExpiresAt: "2099-01-01T00:00:00Z" }, state.token); }
  catch { fail("invalid_authorization_file"); }
  return { ...state, baseUrl };
}
export function managementClient({ root = process.cwd(), env = process.env, authFile, mode: selected, url, fetcher = fetch, signal } = {}) {
  const mode = managementMode(selected, env);
  const stored = authFile ? readManagementAuthorization(root, authFile) : null;
  if (stored && env.COMMISH_MANAGEMENT_TOKEN) fail("ambiguous_authorization");
  const token = stored?.token ?? env.COMMISH_MANAGEMENT_TOKEN;
  if (typeof token !== "string" || !/^cm_mgmt_(test|live)_[A-Za-z0-9_-]{43}$/.test(token)) fail("management_authorization_required");
  if (!token.startsWith(`cm_mgmt_${mode}_`)) fail("key_mode_mismatch");
  const baseUrl = managementUrl(url ?? stored?.baseUrl, env);
  if (stored && baseUrl !== stored.baseUrl) fail("authorization_context_mismatch");
  const send = async (method, path, body) => requestJson(`${baseUrl}${path}`, {
    method, signal, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, fetcher);
  return {
    baseUrl, mode,
    async status() { return validateManagementGrant((await send("GET", "/grants")).body.data, token, stored?.proposal); },
    async revoke() { return validateManagementGrant((await send("DELETE", "/grants")).body.data, token, stored?.proposal); },
    async call(operation, input = {}) {
      if (!Object.hasOwn(catalog.operations, operation) || operation === "webhooks.secret") fail("unknown_operation");
      const op = catalog.operations[operation];
      const query = op.method === "GET" ? new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)])).toString() : "";
      const result = await send(op.method, `/${operation}${query ? `?${query}` : ""}`, op.method === "POST" ? input : undefined);
      const value = result.body.data;
      if (!record(value) || value.protocol !== catalog.protocol || value.operation !== operation || value.mode !== mode ||
        !/^wrk_[A-Za-z0-9_-]{12,}$/.test(value.workspaceId) ||
        value.applicationId !== null && !/^app_[A-Za-z0-9_-]{12,}$/.test(value.applicationId) || !("result" in value) ||
        stored && (value.workspaceId !== stored.proposal.workspaceId || value.applicationId !== stored.proposal.applicationId)) fail("invalid_response");
      return { version: 1, status: "ok", operation, context: { mode, workspaceId: value.workspaceId, applicationId: value.applicationId,
        apiUrl: baseUrl, credential: "delegated_management_grant" }, data: value.result, requestId: result.requestId, httpStatus: result.httpStatus };
    },
    async downloadWebhookSecret(input) {
      const grant = await this.status();
      if (grant.status !== "authorized" || !grant.scopes.includes("webhooks.write")) fail("scope_denied");
      let response;
      try { response = await fetcher(`${baseUrl}/webhooks.secret`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input), redirect: "error", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }); } catch { fail(signal?.aborted ? "interrupted" : "service_unavailable"); }
      if (!response.ok) { await response.body?.cancel(); fail("secret_download_failed"); }
      if (response.headers.get("content-type") !== "application/octet-stream" || response.headers.get("x-commish-workspace-id") !== grant.workspaceId ||
        response.headers.get("x-commish-mode") !== mode || response.headers.get("x-commish-webhook-id") !== input.endpointId ||
        response.headers.get("x-commish-management-id") !== grant.id) { await response.body?.cancel(); fail("invalid_response"); }
      const chunks = []; let size = 0;
      if (!response.body) fail("invalid_response");
      for await (const chunk of response.body) { size += chunk.byteLength; if (size > 512) fail("invalid_response"); chunks.push(chunk); }
      const value = Buffer.concat(chunks).toString("utf8");
      if (!/^whsec_[A-Za-z0-9_-]{32,}$/.test(value)) fail("invalid_response");
      return value;
    },
  };
}
