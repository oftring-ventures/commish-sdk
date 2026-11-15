import { argumentsFor, errorReceipt, fail } from "./cli-http.mjs";
import { managementMode } from "./management-client.mjs";
import { parseSetupConfig } from "./setup-config.mjs";
import { readSetupFile } from "./setup-files.mjs";
import { readSetupProgress } from "./setup-progress.mjs";

const defaultConfig = "commish.setup.json";
// Setup in the order an install reaches it, read from local files only.
const steps = ["configuration", "setup_approved", "resources_provisioned"];
export const statusHelp = () => ({
  version: 1,
  status: "help",
  command: "status [--mode test|live] [--config <path>] [--json]",
  flags: ["--mode test|live", "--config <path>", "--json", "--non-interactive", "--help"],
  purpose:
    "Reports each setup step recorded for the install in the current directory with its status, the evidence that status rests on and the exact next command.",
  steps,
  stepStatuses: ["met", "unmet"],
  reads: {
    localFiles: [
      defaultConfig,
      ".commish/setup/<mode>/*.json",
      ".commish/setup/<mode>/credentials.env (presence and shape only)",
    ],
    requests: [],
  },
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

export async function executeStatus(args, options = {}) {
  const { root = process.cwd(), env = process.env } = options;
  const { values: v, positionals: p } = argumentsFor(
    args,
    ["mode", "config"],
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
  // The path given to --config is not repeated; the command names where it goes.
  const provision = {
    kind: "command",
    command: `commish setup --config ${v.config === undefined ? defaultConfig : "<config>"} --mode ${mode} --no-open --non-interactive --json`,
    humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
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
      "Reads commish.setup.json and .commish/setup/ in the current directory. Makes no request and changes nothing.\n" +
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
