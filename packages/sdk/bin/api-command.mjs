import catalog from "./api-catalog.json" with { type: "json" };
import { argumentsFor, apiUrl, errorReceipt, fail, requestJson } from "./cli-http.mjs";
import { readSetupFile } from "./setup-files.mjs";

export const resourceCommands = {
  "programs retrieve": ["getProgram", "programId"],
  "customers list": ["listCustomers"], "customers retrieve": ["getCustomer", "customerId"],
  "customers identify": ["identifyCustomer"],
  "memberships list": ["listMemberships"], "memberships retrieve": ["getMembership", "membershipId"],
  "conversions lookup": ["lookupConversion", "externalId"], "conversions retrieve": ["getConversion", "conversionId"],
  "conversions refunds": ["listConversionRefunds", "conversionId"], "conversions commissions": ["listConversionCommissions", "conversionId"],
  "conversions create": ["createConversion"], "refunds retrieve": ["getRefund", "refundId"], "refunds create": ["createRefund"],
  "commissions retrieve": ["getCommission", "commissionId"], "payouts retrieve": ["getPayout", "payoutId"],
  "webhook-deliveries list": ["listWebhookDeliveries"], "webhook-deliveries retrieve": ["getWebhookDelivery", "deliveryId"],
  "invitations create": ["createInvitation", "programId"],
};
export const resourceGroups = new Set(Object.keys(resourceCommands).map(key => key.split(" ")[0]));
const strings = ["mode", "api-url", "body-file", "idempotency-key", "cursor", "limit", "created-after", "created-before", "endpoint-id", "status", "max-pages"];
const boolean = ["json", "help", "non-interactive", "all"];
const queryFlags = { cursor: "cursor", limit: "limit", "created-after": "createdAfter", "created-before": "createdBefore", "endpoint-id": "endpointId", status: "status" };
export function apiHelp() {
  return { version: 1, status: "help", commands: ["api list", "api schema <operationId>", "api <operationId> [options]", ...Object.keys(resourceCommands)],
    flags: [...strings.map(name => `--${name} <value>`), ...boolean.map(name => `--${name}`), "--param name=value", "--query name=value"],
    environment: ["COMMISH_SECRET_KEY", "COMMISH_API_URL", "COMMISH_MODE"], defaultMode: "test",
    credential: "integration_secret_key", pagination: { automatic: false, allMaximumPages: 100, partialReceipt: true },
    mutationPolicy: "explicit_body_file_and_idempotency_key_no_automatic_retries",
    unsupported: ["browser_attribution_capture_use_browser_sdk", "management_use_management_authorization", "pages_use_pages_sdk"],
    output: { success: "one_json_object_on_stdout", error: "one_json_object_on_stderr", secrets: "never_accepted_as_flags" } };
}
function assignments(items = []) {
  const values = new Map();
  for (const item of items) {
    const at = item.indexOf("=");
    if (at < 1 || at === item.length - 1 || values.has(item.slice(0, at))) fail("invalid_arguments");
    values.set(item.slice(0, at), item.slice(at + 1));
  }
  return values;
}
function validParameter(value, schema) {
  if (schema.type === "integer") return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) &&
    Number(value) >= (schema.minimum ?? 0) && Number(value) <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
  return typeof value === "string" && value.length >= (schema.minLength ?? 1) && value.length <= (schema.maxLength ?? 512) &&
    (!schema.pattern || new RegExp(schema.pattern).test(value)) && (!schema.enum || schema.enum.includes(value)) &&
    (schema.format !== "date-time" || Number.isFinite(Date.parse(value)));
}
export async function executeApi(args, { env = process.env, root = process.cwd(), fetcher = fetch } = {}) {
  const { values: v, positionals: p } = argumentsFor(args, strings, boolean, ["param", "query"]);
  if (v.help || p.length === 1 && p[0] === "api") return apiHelp();
  if (p[0] === "api" && p[1] === "list" && p.length === 2) return { version: 1, status: "ok", data: catalog.operations };
  if (p[0] === "api" && p[1] === "schema" && p.length === 3) {
    if (!Object.hasOwn(catalog.operations, p[2])) fail("unknown_operation");
    return { version: 1, status: "ok", operation: p[2], data: catalog.operations[p[2]] };
  }
  const alias = resourceCommands[`${p[0]} ${p[1]}`];
  const operationId = p[0] === "api" ? p[1] : alias?.[0];
  if (!Object.hasOwn(catalog.operations, operationId ?? "")) fail("unknown_operation");
  if (p.length !== (p[0] === "api" ? 2 : alias[1] ? 3 : 2)) fail("invalid_arguments");
  const op = catalog.operations[operationId], params = assignments(v.param), query = assignments(v.query);
  for (const [flag, field] of Object.entries(queryFlags)) if (v[flag] !== undefined) {
    if (query.has(field)) fail("invalid_arguments");
    query.set(field, v[flag]);
  }
  if (alias?.[1]) {
    const target = op.parameters.some(item => item.in === "path" && item.name === alias[1]) ? params : query;
    if (target.has(alias[1])) fail("invalid_arguments");
    target.set(alias[1], p[2]);
  }
  const expected = op.parameters.filter(item => ["path", "query"].includes(item.in));
  for (const [kind, supplied] of [["path", params], ["query", query]]) {
    for (const [name, value] of supplied) {
      const field = expected.find(item => item.in === kind && item.name === name);
      if (!field || !validParameter(value, field.schema)) fail("invalid_arguments");
    }
    if (expected.some(item => item.in === kind && item.required && !supplied.has(item.name))) fail("missing_input");
  }
  if ((v.all || v["max-pages"]) && !op.paginated || v["max-pages"] && !v.all) fail("invalid_arguments");
  const maximum = v["max-pages"] ?? "100";
  if (!/^[1-9][0-9]{0,2}$/.test(maximum) || Number(maximum) > 100) fail("invalid_arguments");
  let body;
  if (op.method !== "GET") {
    if (!v["body-file"] || !v["idempotency-key"]) fail("mutation_input_required");
    if (!/^[\x21-\x7e]{1,255}$/.test(v["idempotency-key"])) fail("invalid_arguments");
    try { body = JSON.parse(readSetupFile(root, v["body-file"], { profile: "configuration" })); }
    catch { fail("invalid_body_file"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid_body_file");
  } else if (v["body-file"] || v["idempotency-key"]) fail("invalid_arguments");
  const mode = v.mode ?? env.COMMISH_MODE ?? "test";
  if (!["test", "live"].includes(mode)) fail("invalid_arguments");
  const secret = env.COMMISH_SECRET_KEY ?? "", keyMode = secret.match(/^cm_(test|live)_sk_[A-Za-z0-9_-]{12,}$/)?.[1];
  if (!keyMode) fail("invalid_configuration");
  if (keyMode !== mode) fail("key_mode_mismatch");
  const base = apiUrl(v["api-url"] ?? env.COMMISH_API_URL ?? "https://app.commish.sh/api/v1");
  const path = op.path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(params.get(name)));
  const seen = new Set(query.has("cursor") ? [query.get("cursor")] : []), collected = [];
  let pages = 0, last;
  do {
    const suffix = new URLSearchParams(query).toString();
    last = await requestJson(`${base}${path}${suffix ? `?${suffix}` : ""}`, {
      method: op.method, headers: { authorization: `Bearer ${secret}`, accept: "application/json",
        ...(body ? { "content-type": "application/json", "idempotency-key": v["idempotency-key"] } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, fetcher);
    pages++;
    if (op.paginated) {
      const cursor = last.body.next_cursor;
      if (!Array.isArray(last.body.data) || last.body.data.length > 100 ||
        cursor !== null && (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor) || seen.has(cursor))) fail("invalid_response");
      collected.push(...last.body.data);
      if (cursor === null) break;
      seen.add(cursor); query.set("cursor", cursor);
    }
  } while (op.paginated && v.all && pages < Number(maximum));
  return { version: 1, status: "ok", operation: operationId,
    context: { mode, apiUrl: base, credential: "integration_secret_key", workspaceKeyOnly: op.workspaceKeyOnly },
    data: op.paginated ? collected : last.body.data,
    ...(op.paginated ? { next_cursor: last.body.next_cursor, complete: last.body.next_cursor === null, pages } : {}),
    requestId: last.requestId, httpStatus: last.httpStatus };
}
export async function runApiCommand(args, { out = console.log, diagnostic = console.error, ...options } = {}) {
  try { out(JSON.stringify(await executeApi(args, options))); return 0; }
  catch (error) { diagnostic(JSON.stringify(errorReceipt(error))); return 1; }
}
