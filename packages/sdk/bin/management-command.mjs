import { argumentsFor, errorReceipt, fail } from "./cli-http.mjs";
import { managementCatalog, managementClient } from "./management-client.mjs";
import { readSetupFile, writeSetupFile } from "./setup-files.mjs";
import { protectPrivateState } from "./setup-progress.mjs";

export const managementHelp = () => ({ version: 1, status: "help", protocol: managementCatalog.protocol,
  commands: ["manage list", "manage schema <operation>", "manage <operation>"],
  flags: ["--auth-file <path>", "--mode test|live", "--management-url <url>", "--body-file <path>", "--query name=value", "--program <id>", "--application <id>", "--endpoint <id>", "--limit <1-100>", "--cursor <cursor>", "--all", "--max-pages <1-100>", "--output-file <.commish/path>", "--json", "--non-interactive"],
  authorization: "commish auth login; a separate scoped management grant is required",
  mutationPolicy: "explicit_body_file_no_automatic_retries; retain operationKey/idempotencyKey from the operation schema",
  webhookSecret: "webhooks.secret requires an owner-only, ignored output file; no secret is printed",
  schema: "bundled versioned snapshot; server validates every input", defaultMode: "test" });
export function privateOutputPath(value) {
  if (typeof value !== "string" || !/^\.commish\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:env|json|txt)$/.test(value)) fail("unsafe_file_path");
  return value;
}
export async function executeManagement(args, options = {}) {
  const { root = process.cwd() } = options;
  const { values: v, positionals: p } = argumentsFor(args,
    ["auth-file", "mode", "management-url", "body-file", "program", "application", "endpoint", "limit", "cursor", "max-pages", "output-file"],
    ["help", "json", "all", "non-interactive"], ["query"]);
  if (v.help || !p.length) return managementHelp();
  if (p[0] === "list" && p.length === 1) return { version: 1, status: "ok", data: managementCatalog };
  if (p[0] === "schema" && p.length === 2 && Object.hasOwn(managementCatalog.operations, p[1]))
    return { version: 1, status: "ok", operation: p[1], data: managementCatalog.operations[p[1]] };
  if (p.length !== 1 || !Object.hasOwn(managementCatalog.operations, p[0])) fail("unknown_operation");
  const operation = p[0], definition = managementCatalog.operations[operation], fields = definition.input.properties;
  let input = {};
  const query = new Map();
  for (const assignment of v.query ?? []) {
    const at = assignment.indexOf("=");
    if (at < 1 || at === assignment.length - 1 || query.has(assignment.slice(0, at))) fail("invalid_arguments");
    query.set(assignment.slice(0, at), assignment.slice(at + 1));
  }
  for (const [flag, field] of Object.entries({ program: "programId", application: "applicationId", endpoint: "endpointId", limit: "limit", cursor: "cursor" })) {
    if (v[flag] !== undefined) { if (query.has(field)) fail("invalid_arguments"); query.set(field, v[flag]); }
  }
  const paginated = definition.method === "GET" && fields.cursor !== undefined;
  if ((v.all || v["max-pages"]) && !paginated || v["max-pages"] && !v.all) fail("invalid_arguments");
  const maximum = v["max-pages"] ?? "100";
  if (!/^[1-9][0-9]{0,2}$/.test(maximum) || Number(maximum) > 100) fail("invalid_arguments");
  if (definition.method === "GET") {
    if (v["body-file"] || v["output-file"]) fail("invalid_arguments");
    for (const [name, value] of query) {
      const schema = fields[name];
      if (!schema || !value || value.length > (schema.maxLength ?? 512) || schema.pattern && !new RegExp(schema.pattern).test(value)) fail("invalid_arguments");
      if (schema.type === "integer") {
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > (schema.maximum ?? 100)) fail("invalid_arguments");
        input[name] = Number(value);
      } else input[name] = value;
    }
    if (definition.input.required?.some(name => !Object.hasOwn(input, name))) fail("missing_input");
  } else {
    if (query.size || !v["body-file"]) fail("mutation_input_required");
    try { input = JSON.parse(readSetupFile(root, v["body-file"], { profile: "configuration" })); } catch { fail("invalid_body_file"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_body_file");
    if (operation !== "webhooks.secret" && v["output-file"]) fail("invalid_arguments");
  }
  const client = managementClient({ ...options, authFile: v["auth-file"], mode: v.mode, url: v["management-url"] });
  if (operation === "webhooks.secret") {
    const path = privateOutputPath(v["output-file"]);
    protectPrivateState(root);
    const secret = await client.downloadWebhookSecret(input);
    writeSetupFile(root, path, `COMMISH_WEBHOOK_SIGNING_SECRET=${secret}\n`, { privateFile: true });
    return { version: 1, status: "ok", operation, mode: client.mode, endpointId: input.endpointId, secretFile: path };
  }
  const seen = new Set(input.cursor ? [input.cursor] : []), items = [];
  let result, pages = 0;
  do {
    result = await client.call(operation, input); pages++;
    if (!paginated) return result;
    const page = result.data;
    if (!page || !Array.isArray(page.items) || page.items.length > 100 ||
      page.nextCursor !== null && (typeof page.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(page.nextCursor) || seen.has(page.nextCursor))) fail("invalid_response");
    items.push(...page.items);
    if (page.nextCursor === null) break;
    seen.add(page.nextCursor); input.cursor = page.nextCursor;
  } while (v.all && pages < Number(maximum));
  return { ...result, data: items, nextCursor: result.data.nextCursor, complete: result.data.nextCursor === null, pages };
}
export async function runManagementCommand(args, { out = console.log, diagnostic = console.error, ...options } = {}) {
  try { out(JSON.stringify(await executeManagement(args, options))); return 0; }
  catch (error) { diagnostic(JSON.stringify(errorReceipt(error))); return 1; }
}
