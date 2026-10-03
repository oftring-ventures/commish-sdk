import { createSetupResources } from "./setup-resources.mjs";
import { createHash, randomBytes } from "node:crypto";

const operations = new Set(["workspace.read", "application.write", "destination.write",
  "credential.write", "program.write", "terms.write", "webhook.write", "stripe.connect", "readiness.read"]);
const codes = new Set(["invalid_request", "authorization_required", "access_denied", "mfa_required",
  "recent_auth_required", "live_access_required", "setup_expired", "setup_conflict", "setup_not_found", "rate_limited", "service_unavailable", "challenge_mismatch", "origin_not_public", "verification_unavailable"]);
const fail = (code) => { throw new Error(code); };
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => record(value) && Object.keys(value).sort().join() === [...names].sort().join();
const sameWorkspace = (actual, expected) => expected === undefined ? actual == null :
  keys(actual, Object.keys(expected)) && Object.entries(expected).every(([name, value]) => actual[name] === value);
const sameOperations = (value, requested) => Array.isArray(value) &&
  value.length === requested.length && value.every((item) => operations.has(item)) &&
  [...value].sort().every((item, index) => item === [...requested].sort()[index]);

// The bearer stays inside this closure: callers can persist receipts, never authority.
export function createSetupSession(input, { appUrl = "https://app.commish.sh", fetcher = fetch, now = Date.now } = {}) {
  let origin;
  try { origin = new URL(appUrl); } catch { fail("invalid_app_url"); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      !(origin.protocol === "https:" || origin.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname))) fail("invalid_app_url");
  if (!record(input) || Object.keys(input).some((key) => !["mode", "operations", "workspaceRequest"].includes(key)))
    fail("invalid_request");
  const mode = input.mode ?? "test", requested = input.operations;
  if (!["test", "live"].includes(mode) || !Array.isArray(requested) || !requested.length ||
      new Set(requested).size !== requested.length || requested.some((op) => !operations.has(op))) fail("invalid_request");
  const workspace = input.workspaceRequest;
  if (workspace !== undefined && !(keys(workspace, ["kind", "id"]) && workspace.kind === "existing" &&
      /^wrk_[A-Za-z0-9_-]{12,}$/.test(workspace.id) || keys(workspace, ["kind", "name", "slug"]) &&
      workspace.kind === "new" && typeof workspace.name === "string" && workspace.name.trim() === workspace.name &&
      workspace.name.length > 0 && workspace.name.length <= 100 && typeof workspace.slug === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workspace.slug) && workspace.slug.length >= 3 && workspace.slug.length <= 48))
    fail("invalid_request");
  const expected = structuredClone({ mode, operations: requested, ...(workspace ? { workspaceRequest: workspace } : {}) });
  const verifier = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(verifier).digest("hex");
  const pairingCode = `${hash.slice(0, 4)}-${hash.slice(4, 8)}`.toUpperCase();
  let boundWorkspace;
  const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  async function request(method, path = "/api/cli/setup-sessions", body) {
    const begin = method === "POST" && path === "/api/cli/setup-sessions";
    let response;
    try {
      response = await fetcher(`${origin.origin}${path}`, {
        method, headers: { ...(begin ? {} : { authorization: `Bearer ${verifier}` }),
          ...(begin || body ? { "content-type": "application/json" } : {}) },
        ...(begin || body ? { body: JSON.stringify(begin ? { ...expected, challengeHash: hash } : body) } : {}),
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
    } catch { fail("service_unavailable"); }
    const chunks = []; let size = 0;
    try {
      if (!response.body) fail("invalid_response");
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 65_536) fail("invalid_response");
        chunks.push(chunk);
      }
    } catch { fail("invalid_response"); }
    let payload;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail("invalid_response"); }
    if (!response.ok) fail(codes.has(payload?.error?.code) ? payload.error.code : "service_unavailable");
    const value = payload?.data;
    if (!record(value) || value.protocol !== "commish-cli-setup-v2" || value.requestId !== hash) fail("invalid_response");
    return value;
  }
  return {
    ...createSetupResources(request, () => ({ workspaceId: boundWorkspace, mode, operations: expected.operations })),
    async begin() {
      const result = await request("POST");
      if (result.mode !== mode || !sameOperations(result.operations, expected.operations) || result.pairingCode !== pairingCode ||
          !["pending", "authorized", "denied"].includes(result.decision) || !date(result.requestExpiresAt) ||
          Date.parse(result.requestExpiresAt) <= now() || Date.parse(result.requestExpiresAt) > now() + 3_660_000 ||
          !sameWorkspace(result.workspaceRequest, expected.workspaceRequest)) fail("invalid_response");
      return { protocol: result.protocol, requestId: hash, pairingCode, approvalUrl: `${origin.origin}/cli/authorize/${hash}`,
        mode, operations: [...expected.operations], requestExpiresAt: result.requestExpiresAt };
    },
    async poll() {
      const result = await request("GET");
      if (result.status === "pending" || result.status === "denied") {
        if (!date(result.requestExpiresAt)) fail("invalid_response");
        return { status: result.status, requestId: hash, requestExpiresAt: result.requestExpiresAt };
      }
      if (result.status === "revoked") return { status: "revoked", requestId: hash };
      if (result.status !== "authorized" || result.mode !== mode || !sameOperations(result.operations, expected.operations) ||
          !/^wrk_[A-Za-z0-9_-]{12,}$/.test(result.workspaceId) || !date(result.expiresAt) ||
          Date.parse(result.expiresAt) <= now() || Date.parse(result.expiresAt) > now() + 630_000 ||
          expected.workspaceRequest?.kind === "existing" && result.workspaceId !== expected.workspaceRequest.id ||
          boundWorkspace && result.workspaceId !== boundWorkspace) fail("invalid_response");
      boundWorkspace = result.workspaceId;
      return { status: "authorized", requestId: hash, workspaceId: boundWorkspace, mode,
        operations: [...expected.operations], expiresAt: result.expiresAt };
    },
    async revoke() {
      const result = await request("DELETE");
      if (result.status !== "revoked") fail("invalid_response");
      return { status: "revoked", requestId: hash };
    },
  };
}
