import { parseArgs } from "node:util";
import { parseSetupConfig } from "./setup-config.mjs";
import { readSetupFile } from "./setup-files.mjs";

const strings = ["config", "app-url", "mode", "workspace-id", "workspace-name", "workspace-slug", "application-name",
  "origin", "proof-file", "program-json", "terms-json", "webhook-json", "stripe", "participant-consent", "wait"];
const booleans = ["json", "no-open", "non-interactive", "plan", "help"];
export const setupFlags = [...strings.map(name => `--${name} <value>`), ...booleans.map(name => `--${name}`)];
const fail = () => { throw new Error("invalid_arguments"); };
function json(value) { try { return JSON.parse(value); } catch { fail(); } }

// Inputs are non-secret business configuration. Diagnostics name only known
// fields; malformed JSON or option values never appear in output.
export function parseSetupArguments(root, args) {
  let parsed;
  try {
    parsed = parseArgs({ args, strict: true, allowPositionals: false, tokens: true,
      options: Object.fromEntries([...strings.map(name => [name, { type: "string" }]), ...booleans.map(name => [name, { type: "boolean" }])]) });
  } catch { fail(); }
  const names = parsed.tokens.filter(t => t.kind === "option").map(t => t.name);
  if (new Set(names).size !== names.length) fail();
  const v = parsed.values;
  if (v.help) return { kind: "help", json: v.json === true, flags: setupFlags };
  const appUrl = v["app-url"] ?? "https://app.commish.sh";
  let endpoint;
  try { endpoint = new URL(appUrl); } catch { fail(); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
      !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname))) fail();
  const wait = v.wait ?? "300";
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(wait) || Number(wait) > 600) fail();
  let input = { version: 1 };
  try { input = json(readSetupFile(root, v.config ?? "commish.setup.json", { profile: "configuration" })); }
  catch (error) { if (v.config !== undefined || error.message !== "setup_file_missing") throw error; }
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  if (v.mode !== undefined) input.mode = v.mode;
  if (v["workspace-id"] !== undefined) {
    if (v["workspace-name"] !== undefined || v["workspace-slug"] !== undefined) fail();
    input.workspace = { kind: "existing", id: v["workspace-id"] };
  } else if (v["workspace-name"] !== undefined || v["workspace-slug"] !== undefined) {
    if (v["workspace-name"] === undefined || v["workspace-slug"] === undefined) fail();
    input.workspace = { kind: "new", name: v["workspace-name"], slug: v["workspace-slug"] };
  }
  if (v["application-name"] !== undefined) input.application = { name: v["application-name"] };
  for (const [flag, field] of [["origin", "origin"], ["proof-file", "proofFile"]])
    if (v[flag] !== undefined) input.destination = { ...input.destination, [field]: v[flag] };
  for (const field of ["program", "terms", "webhook"])
    if (v[`${field}-json`] !== undefined) input[field] = json(v[`${field}-json`]);
  for (const [flag, field] of [["stripe", "stripe"], ["participant-consent", "participantConsent"]])
    if (v[flag] !== undefined) input[field] = v[flag];
  return { ...parseSetupConfig(input), options: { appUrl: endpoint.origin, json: v.json === true,
    ...(v.plan ? { plan: true } : {}),
    noOpen: v["no-open"] === true, nonInteractive: v["non-interactive"] === true, waitSeconds: Number(wait) } };
}
