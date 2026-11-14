import { argumentsFor, CliError, errorReceipt, fail } from "./cli-http.mjs";
import { managementCatalog, managementClient } from "./management-client.mjs";
import { readSetupFile, writeSetupFile } from "./setup-files.mjs";
import { protectPrivateState } from "./setup-progress.mjs";

// Why a body file was refused. Reasons and guidance are fixed text: neither the
// path nor anything read from the file reaches output.
const bodyFileGuidance = {
  path_not_repository_relative:
    "Pass --body-file a relative path inside the current repository (the directory the command runs in): no absolute path, no .. segment and no symbolic link. Copy the file into the repository first.",
  file_missing: "No file exists at that path, relative to the directory the command runs in.",
  file_unreadable: "The body file must be a readable regular UTF-8 file of at most 1 MiB.",
  invalid_json: "The body file is not valid JSON.",
  json_object_required: "The body file must contain one JSON object.",
};
const bodyFileFailure = (reason) =>
  new CliError("invalid_body_file", { reason, guidance: bodyFileGuidance[reason] });
function readBodyFile(root, path) {
  let text, input;
  try {
    text = readSetupFile(root, path, { profile: "configuration" });
  } catch (error) {
    throw bodyFileFailure(
      { unsafe_file_path: "path_not_repository_relative", setup_file_missing: "file_missing" }[
        error?.message
      ] ?? "file_unreadable",
    );
  }
  try {
    input = JSON.parse(text);
  } catch {
    throw bodyFileFailure("invalid_json");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw bodyFileFailure("json_object_required");
  return input;
}
export const managementHelp = () => ({
  version: 1,
  status: "help",
  protocol: managementCatalog.protocol,
  commands: ["manage list", "manage schema <operation>", "manage <operation>"],
  flags: [
    "--auth-file <path>",
    "--mode test|live",
    "--management-url <url>",
    "--body-file <path>",
    "--query name=value",
    "--program <id>",
    "--application <id>",
    "--endpoint <id>",
    "--limit <1-100>",
    "--cursor <cursor>",
    "--all",
    "--max-pages <1-100>",
    "--output-file <.commish/path>",
    "--json",
    "--non-interactive",
  ],
  authorization: "commish auth login; a separate scoped management grant is required",
  mutationPolicy:
    "explicit_body_file_no_automatic_retries; retain operationKey/idempotencyKey from the operation schema",
  bodyFile: {
    path: "relative_path_inside_the_current_repository; no absolute path, .. segment or symbolic link",
    content: "one JSON object in a regular UTF-8 file of at most 1 MiB",
    errorCode: "invalid_body_file",
    errorReasons: Object.keys(bodyFileGuidance),
  },
  webhookSecret:
    "webhooks.secret requires an owner-only, ignored output file; no secret is printed",
  schema: "bundled versioned snapshot; server validates every input",
  defaultMode: "test",
});
export function privateOutputPath(value) {
  if (
    typeof value !== "string" ||
    !/^\.commish\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:env|json|txt)$/.test(value)
  )
    fail("unsafe_file_path");
  return value;
}
export async function executeManagement(args, options = {}) {
  const { root = process.cwd() } = options;
  const { values: v, positionals: p } = argumentsFor(
    args,
    [
      "auth-file",
      "mode",
      "management-url",
      "body-file",
      "program",
      "application",
      "endpoint",
      "limit",
      "cursor",
      "max-pages",
      "output-file",
    ],
    ["help", "json", "all", "non-interactive"],
    ["query"],
  );
  if (v.help || !p.length) return managementHelp();
  if (p[0] === "list" && p.length === 1)
    return { version: 1, status: "ok", data: managementCatalog };
  if (p[0] === "schema" && p.length === 2 && Object.hasOwn(managementCatalog.operations, p[1]))
    return { version: 1, status: "ok", operation: p[1], data: managementCatalog.operations[p[1]] };
  if (p.length !== 1 || !Object.hasOwn(managementCatalog.operations, p[0]))
    fail("unknown_operation");
  const operation = p[0],
    definition = managementCatalog.operations[operation],
    fields = definition.input.properties;
  let input = {};
  const query = new Map();
  for (const assignment of v.query ?? []) {
    const at = assignment.indexOf("=");
    if (at < 1 || at === assignment.length - 1 || query.has(assignment.slice(0, at)))
      fail("invalid_arguments");
    query.set(assignment.slice(0, at), assignment.slice(at + 1));
  }
  for (const [flag, field] of Object.entries({
    program: "programId",
    application: "applicationId",
    endpoint: "endpointId",
    limit: "limit",
    cursor: "cursor",
  })) {
    if (v[flag] !== undefined) {
      if (query.has(field)) fail("invalid_arguments");
      query.set(field, v[flag]);
    }
  }
  const paginated = definition.method === "GET" && fields.cursor !== undefined;
  if (((v.all || v["max-pages"]) && !paginated) || (v["max-pages"] && !v.all))
    fail("invalid_arguments");
  const maximum = v["max-pages"] ?? "100";
  if (!/^[1-9][0-9]{0,2}$/.test(maximum) || Number(maximum) > 100) fail("invalid_arguments");
  if (definition.method === "GET") {
    if (v["body-file"] || v["output-file"]) fail("invalid_arguments");
    for (const [name, value] of query) {
      const schema = fields[name];
      if (
        !schema ||
        !value ||
        value.length > (schema.maxLength ?? 512) ||
        (schema.pattern && !new RegExp(schema.pattern).test(value))
      )
        fail("invalid_arguments");
      if (schema.type === "integer") {
        if (!/^[1-9][0-9]*$/.test(value) || Number(value) > (schema.maximum ?? 100))
          fail("invalid_arguments");
        input[name] = Number(value);
      } else input[name] = value;
    }
    if (definition.input.required?.some((name) => !Object.hasOwn(input, name)))
      fail("missing_input");
  } else {
    if (query.size || !v["body-file"]) fail("mutation_input_required");
    input = readBodyFile(root, v["body-file"]);
    if (operation !== "webhooks.secret" && v["output-file"]) fail("invalid_arguments");
  }
  const client = managementClient({
    ...options,
    authFile: v["auth-file"],
    mode: v.mode,
    url: v["management-url"],
  });
  if (operation === "webhooks.secret") {
    const path = privateOutputPath(v["output-file"]);
    protectPrivateState(root);
    const secret = await client.downloadWebhookSecret(input);
    writeSetupFile(root, path, `COMMISH_WEBHOOK_SIGNING_SECRET=${secret}\n`, { privateFile: true });
    return {
      version: 1,
      status: "ok",
      operation,
      mode: client.mode,
      endpointId: input.endpointId,
      secretFile: path,
    };
  }
  const seen = new Set(input.cursor ? [input.cursor] : []),
    items = [];
  let result,
    pages = 0;
  do {
    result = await client.call(operation, input);
    pages++;
    if (!paginated) return result;
    const page = result.data;
    if (
      !page ||
      !Array.isArray(page.items) ||
      page.items.length > 100 ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== "string" ||
          !/^[A-Za-z0-9_-]{1,255}$/.test(page.nextCursor) ||
          seen.has(page.nextCursor)))
    )
      fail("invalid_response");
    items.push(...page.items);
    if (page.nextCursor === null) break;
    seen.add(page.nextCursor);
    input.cursor = page.nextCursor;
  } while (v.all && pages < Number(maximum));
  return {
    ...result,
    data: items,
    nextCursor: result.data.nextCursor,
    complete: result.data.nextCursor === null,
    pages,
  };
}
export async function runManagementCommand(
  args,
  { out = console.log, diagnostic = console.error, ...options } = {},
) {
  try {
    out(JSON.stringify(await executeManagement(args, options)));
    return 0;
  } catch (error) {
    diagnostic(JSON.stringify(errorReceipt(error)));
    return 1;
  }
}
