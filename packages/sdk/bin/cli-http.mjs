import { parseArgs } from "node:util";

export class CliError extends Error {
  constructor(code, detail = {}) { super(code); this.detail = detail; }
}
export const fail = code => { throw new CliError(code); };
export function argumentsFor(args, strings = [], booleans = [], repeated = []) {
  let parsed;
  try {
    parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true,
      options: Object.fromEntries([
        ...strings.map(name => [name, { type: "string" }]),
        ...booleans.map(name => [name, { type: "boolean" }]),
        ...repeated.map(name => [name, { type: "string", multiple: true }]),
      ]) });
  } catch { fail("invalid_arguments"); }
  const names = parsed.tokens.filter(t => t.kind === "option" && !repeated.includes(t.name)).map(t => t.name);
  if (new Set(names).size !== names.length) fail("invalid_arguments");
  return parsed;
}
export function apiUrl(value, path = "/api/v1") {
  let url;
  try { url = new URL(value); } catch { fail("invalid_api_url"); }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== path ||
    !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) fail("invalid_api_url");
  return url.href.replace(/\/$/, "");
}
const safeCodes = new Set(["invalid_request", "invalid_api_key", "unauthorized", "forbidden", "access_denied", "not_found",
  "idempotency_key_required", "idempotency_conflict", "rate_limited", "workspace_live_access_required", "mode_mismatch",
  "authorization_required", "authorization_expired", "authorization_revoked", "scope_denied", "recent_auth_required",
  "application_key_not_supported", "program_not_found", "service_unavailable", "conflict", "program_activation_preflight_required", "challenge_mismatch", "origin_not_public"]);
export async function requestJson(url, init, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...init, redirect: "error", cache: "no-store", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }); }
  catch { fail(init.signal?.aborted ? "interrupted" : "service_unavailable"); }
  const rawId = response.headers.get("x-request-id");
  const requestId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(rawId ?? "") ? rawId : null;
  let body;
  try {
    if (!response.body) fail("invalid_response");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 1_048_576) fail("invalid_response");
      chunks.push(chunk);
    }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { fail("invalid_response"); }
  if (!response.ok) throw new CliError(safeCodes.has(body?.error?.code) ? body.error.code : "request_failed",
    { httpStatus: response.status, requestId, retryable: [429, 503].includes(response.status) });
  if (!body || typeof body !== "object" || Array.isArray(body) || !("data" in body)) fail("invalid_response");
  return { body, requestId, httpStatus: response.status };
}
const fileCodes = new Set(["unsafe_file_path", "unsafe_file_permissions", "invalid_setup_file", "setup_file_conflict", "unsupported_file_safety", "setup_file_missing", "setup_file_unavailable", "setup_git_unavailable", "setup_state_tracked", "setup_state_not_ignored"]);
export function errorReceipt(error) {
  return { version: 1, status: "error", code: error instanceof CliError || fileCodes.has(error?.message) ? error.message : "service_unavailable",
    ...(error instanceof CliError ? error.detail : {}) };
}
