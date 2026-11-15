import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { argumentsFor, CliError, errorReceipt, fail } from "./cli-http.mjs";
import {
  managementClient,
  managementMode,
  readManagementAuthorization,
} from "./management-client.mjs";
import { parseSetupConfig } from "./setup-config.mjs";
import { readSetupFile } from "./setup-files.mjs";
import { setupOnboardingScopes } from "./setup-onboarding.mjs";
import { readSetupProgress } from "./setup-progress.mjs";

const defaultConfig = "commish.setup.json";
// Onboarding in the order an install reaches it. The first three read local
// files only; management access is checked with the grant's own bearer.
const steps = ["configuration", "setup_approved", "resources_provisioned", "management_access"];
export const statusHelp = () => ({
  version: 1,
  status: "help",
  command: "status [--mode test|live] [--config <path>] [--auth-file <path>] [--json]",
  flags: [
    "--mode test|live",
    "--config <path>",
    "--auth-file <path>",
    "--management-url <url>",
    "--json",
    "--non-interactive",
    "--help",
  ],
  purpose:
    "Reports each setup step recorded for the install in the current directory, and whether management access is still usable, with its status, the evidence that status rests on and the exact next command.",
  steps,
  stepStatuses: ["met", "unmet"],
  reads: {
    localFiles: [
      defaultConfig,
      ".commish/setup/<mode>/*.json",
      ".commish/setup/<mode>/credentials.env (presence and shape only)",
      ".commish/management/<request-id>/authorization.json",
    ],
    requests: ["GET /grants"],
  },
  authorization:
    "Uses --auth-file or COMMISH_MANAGEMENT_TOKEN; otherwise the newest stored grant for this workspace and mode that includes diagnostics.read, the scope the remaining onboarding checks need.",
  mutations: false,
  defaultMode: "test",
  output: "text; --json prints one JSON object on stdout",
  exitCodes: { 0: "every_step_met", 1: "error", 2: "a_step_is_unmet" },
  integrationVerified: false,
});

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function readConfiguration(root, path) {
  let text, input;
  try {
    text = readSetupFile(root, path, { profile: "configuration" });
  } catch (error) {
    if (error.message === "setup_file_missing") return { state: "missing" };
    throw error;
  }
  try {
    input = JSON.parse(text);
  } catch {
    return { state: "invalid_config", fields: ["config"] };
  }
  if (!record(input)) return { state: "invalid_config", fields: ["config"] };
  const parsed = parseSetupConfig(input);
  return parsed.kind === "ready"
    ? { state: "ready", config: parsed.config }
    : { state: parsed.kind, fields: parsed.fields };
}
// Presence and shape only: no key material is kept or reported.
function privateFile(root, path, pattern) {
  try {
    return pattern.test(readSetupFile(root, path, { privateFile: true })) ? "present" : "invalid";
  } catch (error) {
    if (error.message === "setup_file_missing") return "absent";
    throw error;
  }
}
// Stored grants for this workspace and mode that can read diagnostics, newest
// first. Unreadable or foreign files are skipped, never reported.
function storedGrants(root, mode, workspaceId) {
  let entries;
  try {
    entries = readdirSync(join(root, ".commish", "management"), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{24}$/.test(entry.name))
    .slice(0, 64)
    .flatMap((entry) => {
      const path = `.commish/management/${entry.name}/authorization.json`;
      try {
        const { proposal } = readManagementAuthorization(root, path);
        return proposal.mode === mode &&
          proposal.workspaceId === workspaceId &&
          proposal.scopes.includes("diagnostics.read")
          ? [{ path, modified: lstatSync(join(root, path)).mtimeMs }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 3)
    .map((item) => item.path);
}
const failureCode = (error) =>
  error instanceof CliError && /^[a-z_]{1,64}$/.test(error.message)
    ? error.message
    : "service_unavailable";

export async function executeStatus(args, options = {}) {
  const { root = process.cwd(), env = process.env } = options;
  const { values: v, positionals: p } = argumentsFor(
    args,
    ["mode", "config", "auth-file", "management-url"],
    ["help", "json", "non-interactive"],
  );
  if (v.help) return statusHelp();
  if (p.length) fail("invalid_arguments");
  const mode = managementMode(v.mode, env),
    configuration = readConfiguration(root, v.config ?? defaultConfig),
    config = configuration.state === "ready" ? configuration.config : null;
  let journal;
  try {
    journal = readSetupProgress(root, mode);
  } catch (error) {
    // Recorded progress that does not parse is reported, never guessed around.
    if (error?.message === "invalid_setup_progress") fail("invalid_setup_progress");
    throw error;
  }
  const workspaceId = journal.workspace?.id ?? null,
    applicationId = journal.application?.id ?? null,
    programId = journal.program?.id ?? null;
  const approval = { humanAction: "open_the_approval_url_and_confirm_the_pairing_code" };
  // The path given to --config is not repeated; the command names where it goes.
  const provision = {
    kind: "command",
    command: `commish setup --config ${v.config === undefined ? defaultConfig : "<config>"} --mode ${mode} --no-open --non-interactive --json`,
    ...approval,
  };
  const report = [];
  const add = (step, status, evidence, extra = {}) =>
    report.push({ step, status, evidence, ...extra });

  // A setup that started had a complete configuration, even if it came from flags.
  const configured =
    configuration.state === "ready" || (configuration.state === "missing" && journal.intent);
  add(
    "configuration",
    configured ? "met" : "unmet",
    {
      source: v.config === undefined ? defaultConfig : "--config",
      configuration: configuration.state,
      ...(configuration.fields ? { fields: configuration.fields } : {}),
      ...(journal.intent ? { setupStartedAt: journal.intent.createdAt } : {}),
    },
    configured ? {} : { next: { kind: "command", command: "commish setup --plan --json" } },
  );
  add(
    "setup_approved",
    workspaceId ? "met" : "unmet",
    { source: `${journal.directory}/workspace.json`, workspaceId },
    workspaceId ? {} : { next: provision },
  );
  const wantsWebhook = Boolean(config?.webhook) || journal.webhook !== null;
  const files = {
    credentialsFile: privateFile(
      root,
      `${journal.directory}/credentials.env`,
      new RegExp(`^COMMISH_MODE=${mode}\\n(?:COMMISH_[A-Z_]+=[\\x21-\\x7e]+\\n){4}$`),
    ),
    ...(wantsWebhook
      ? {
          webhookFile: privateFile(
            root,
            `${journal.directory}/webhook.env`,
            /^COMMISH_WEBHOOK_SIGNING_SECRET=whsec_[A-Za-z0-9_-]{32,}\n$/,
          ),
        }
      : {}),
  };
  const provisioned =
    Boolean(applicationId && programId && journal.credential) &&
    files.credentialsFile === "present" &&
    (!wantsWebhook || (journal.webhook !== null && files.webhookFile === "present"));
  add(
    "resources_provisioned",
    provisioned ? "met" : "unmet",
    {
      source: journal.directory,
      applicationId,
      programId,
      credentialId: journal.credential?.id ?? null,
      ...(wantsWebhook ? { webhookId: journal.webhook?.id ?? null } : {}),
      ...files,
    },
    provisioned ? {} : { next: provision },
  );

  // Management access: an explicit file or token, else the newest stored grant.
  const explicit = v["auth-file"] !== undefined || Boolean(env.COMMISH_MANAGEMENT_TOKEN);
  const candidates = explicit
    ? [v["auth-file"]]
    : workspaceId
      ? storedGrants(root, mode, workspaceId)
      : [];
  let client = null,
    access = { source: "none", status: "missing" },
    authFile;
  for (const path of candidates) {
    const source = path ?? "COMMISH_MANAGEMENT_TOKEN";
    let candidate;
    try {
      candidate = managementClient({
        root,
        env,
        mode,
        authFile: path,
        url: v["management-url"],
        fetcher: options.fetcher,
        signal: options.signal,
      });
    } catch (error) {
      // A file or token the caller named must be usable; a stored one is skipped.
      if (explicit) throw error;
      continue;
    }
    try {
      const grant = await candidate.status();
      access = {
        source,
        status: grant.status,
        kind: grant.kind,
        workspaceId: grant.workspaceId,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
      };
      if (grant.status === "authorized") {
        client = candidate;
        authFile = path;
        break;
      }
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      access = { source, status: "unavailable", code: failureCode(error) };
      // An outage is the same for every candidate; a refused grant is not.
      if (error.message === "service_unavailable" || error.detail?.retryable) break;
    }
  }
  const usable = client !== null && access.scopes.includes("diagnostics.read");
  const login = !workspaceId
    ? provision
    : {
        kind: "command",
        command:
          access.status === "pending" && access.source.startsWith(".commish/")
            ? `commish auth login --auth-file ${access.source} --mode ${mode} --no-open --non-interactive --json`
            : `commish auth login --workspace ${workspaceId} --workspace-scope ` +
              (mode === "test"
                ? `--onboarding --scopes ${setupOnboardingScopes.join(",")}`
                : "--scopes resources.read,diagnostics.read,programs.read,terms.read,destinations.read") +
              ` --mode ${mode} --no-open --non-interactive --json`,
        ...approval,
      };
  add("management_access", usable ? "met" : "unmet", access, usable ? {} : { next: login });
  const open = report.find((item) => item.status === "unmet");
  return {
    version: 1,
    status: report.every((item) => ["met", "not_applicable"].includes(item.status))
      ? "complete"
      : "incomplete",
    mode,
    workspaceId,
    applicationId,
    programId,
    steps: report,
    nextStep: open?.step ?? null,
    next: open?.next ?? null,
    integrationVerified: false,
  };
}
function statusText(result) {
  if (result.status === "help")
    return (
      `commish ${result.command}\n\n${result.purpose}\n` +
      `Steps: ${result.steps.join(", ")}.\n` +
      "Reads commish.setup.json and .commish/ in the current directory, then checks the management grant with one request. Changes nothing.\n" +
      "Exit 0 means every step is met, 2 that a step is unmet, 1 an error. Use --json for evidence."
    );
  const next = result.next;
  return (
    `Commish status (${result.mode.toUpperCase()}): ${result.status}.\n` +
    result.steps
      .map(
        (item) =>
          `  ${item.status.padEnd(14)} ${item.step}${item.reason ? ` (${item.reason})` : ""}\n`,
      )
      .join("") +
    (next
      ? `Next (${result.nextStep}): run ${next.command}` +
        (next.humanAction ? `\nThen a person must ${next.humanAction.replaceAll("_", " ")}.` : "")
      : "Every step is met.") +
    "\nIntegration remains unverified by this command. Use --json for evidence."
  );
}
export async function runStatusCommand(
  args,
  { out = console.log, diagnostic = console.error, ...options } = {},
) {
  const json = args.includes("--json");
  try {
    const result = await executeStatus(args, options);
    out(json ? JSON.stringify(result) : statusText(result));
    return result.status === "incomplete" ? 2 : 0;
  } catch (error) {
    const receipt = errorReceipt(error);
    diagnostic(json ? JSON.stringify(receipt) : `Status failed: ${receipt.code}.`);
    return 1;
  }
}
