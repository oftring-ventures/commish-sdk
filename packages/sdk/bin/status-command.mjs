import { argumentsFor, errorReceipt, fail } from "./cli-http.mjs";
import { managementMode } from "./management-client.mjs";
import { parseSetupConfig } from "./setup-config.mjs";
import { readSetupFile } from "./setup-files.mjs";
import { readSetupProgress, setupAppOrigin, setupFingerprint } from "./setup-progress.mjs";
import { setupCredentialMatches } from "./setup-secrets.mjs";

const defaultConfig = "commish.setup.json";
// Setup in the order an install reaches it, read from local files only.
const steps = ["configuration", "setup_approved", "resources_provisioned"];
export const statusHelp = () => ({
  version: 1,
  status: "help",
  command: "status [--mode test|live] [--config <path>] [--json]",
  flags: [
    "--mode test|live",
    "--config <path>",
    "--app-url <url>",
    "--json",
    "--non-interactive",
    "--help",
  ],
  purpose:
    "Reports each setup step recorded for the install in the current directory with its status, the evidence that status rests on and the exact next command.",
  steps,
  stepStatuses: ["met", "unmet", "unknown"],
  reads: {
    localFiles: [
      defaultConfig,
      ".commish/setup/<mode>/*.json",
      ".commish/setup/<mode>/credentials.env (checked against the mode and recorded resources, never printed)",
    ],
    requests: [],
  },
  // A step is met only if commish setup, rerun now with these inputs, would also
  // treat it as done.
  sameSetup:
    "The configuration, --mode and --app-url are compared with the fingerprint setup recorded; a difference is setup_config_conflict and nothing recorded counts for this configuration.",
  mutations: false,
  // The install setup would address: its configuration decides before the shell.
  mode: "--mode, else the configuration file's mode (test when it names none), else COMMISH_MODE, else test",
  output: "text; --json prints one JSON object on stdout",
  exitCodes: { 0: "every_step_met", 1: "error", 2: "a_step_is_unmet_or_unknown" },
  integrationVerified: false,
});

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function readConfiguration(root, path, modeFlag) {
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
  // As setup does: --mode replaces the file's mode, which defaults to test.
  if (modeFlag !== undefined) input.mode = modeFlag;
  const mode = input.mode === undefined ? "test" : input.mode,
    parsed = parseSetupConfig(input);
  return {
    ...(parsed.kind === "ready"
      ? { state: "ready", config: parsed.config }
      : { state: parsed.kind, fields: parsed.fields }),
    ...(["test", "live"].includes(mode) ? { mode } : {}),
  };
}
// Whether the file is the one setup writes: no key material is kept or reported.
function privateFile(root, path, matches) {
  try {
    return matches(readSetupFile(root, path, { privateFile: true, recover: false }))
      ? "present"
      : "invalid";
  } catch (error) {
    if (error.message === "setup_file_missing") return "absent";
    throw error;
  }
}

export async function executeStatus(args, options = {}) {
  const { root = process.cwd(), env = process.env } = options;
  const { values: v, positionals: p } = argumentsFor(
    args,
    ["mode", "config", "app-url"],
    ["help", "json", "non-interactive"],
  );
  if (v.help) return statusHelp();
  if (p.length) fail("invalid_arguments");
  try {
    setupAppOrigin(v["app-url"]);
  } catch {
    fail("invalid_arguments");
  }
  const configuration = readConfiguration(root, v.config ?? defaultConfig, v.mode),
    mode = managementMode(v.mode ?? configuration.mode, env),
    // Values given to --config and --app-url are not repeated; commands name where they go.
    configFlag = `--config ${v.config === undefined ? defaultConfig : "<config>"}`,
    appFlag = v["app-url"] === undefined ? "" : " --app-url <app-url>";
  let journal;
  try {
    journal = readSetupProgress(root, mode);
  } catch (error) {
    // Recorded progress that does not parse is reported, never guessed around.
    if (error?.message === "invalid_setup_progress") fail("invalid_setup_progress");
    throw error;
  }
  // Setup resumes only the setup it recorded: the same configuration, mode and
  // deployment. A different one fails there with setup_config_conflict, so
  // nothing recorded here counts for it.
  const conflict =
      configuration.state === "ready" &&
      journal.intent !== null &&
      setupFingerprint(configuration.config, v["app-url"]).fingerprint !==
        journal.intent.fingerprint,
    config = configuration.state === "ready" && !conflict ? configuration.config : null,
    conflicted = conflict ? { reason: "setup_config_conflict" } : {};
  const workspaceId = journal.workspace?.id ?? null,
    applicationId = journal.application?.id ?? null,
    programId = journal.program?.id ?? null;
  // The action that continues setup. Two cases have no command that can
  // succeed: a conflicting configuration, and a setup started from flags, which
  // left no file to name and whose flags only its caller knows.
  const provision = {
    ...(conflict
      ? {
          kind: "guidance",
          guidance: `The configuration, mode or app URL differs from the setup recorded in ${journal.directory}, so rerunning setup fails with setup_config_conflict. Restore the original configuration, or repeat the original commish setup command if it was started with other flags; inspect ${journal.directory} before starting a separate setup.`,
        }
      : configuration.state === "missing" && journal.intent
        ? {
            kind: "guidance",
            guidance:
              "Setup was started from flags, so there is no configuration file to rerun. Repeat the original commish setup command with the same flags, or restore its configuration file; setup resumes from the recorded progress.",
          }
        : {
            kind: "command",
            command: `commish setup ${configFlag} --mode ${mode}${appFlag} --no-open --non-interactive --json`,
          }),
    humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
  };
  const report = [];
  const add = (step, status, evidence, extra = {}) =>
    report.push({ step, status, evidence, ...extra });

  // A setup that started had a complete configuration, even if it came from flags.
  const configured =
    (configuration.state === "ready" && !conflict) ||
    (configuration.state === "missing" && journal.intent);
  add(
    "configuration",
    configured ? "met" : "unmet",
    {
      source: v.config === undefined ? defaultConfig : "--config",
      configuration: configuration.state,
      ...(configuration.fields ? { fields: configuration.fields } : {}),
      ...(journal.intent ? { setupStartedAt: journal.intent.createdAt } : {}),
      ...(configuration.state === "ready" && journal.intent
        ? { matchesRecordedSetup: !conflict }
        : {}),
    },
    configured
      ? {}
      : conflict
        ? { ...conflicted, next: provision }
        : {
            next: {
              kind: "command",
              command: `commish setup ${v.config === undefined ? "" : `${configFlag} `}--plan --json`,
            },
          },
  );
  add(
    "setup_approved",
    !workspaceId ? "unmet" : conflict ? "unknown" : "met",
    { source: `${journal.directory}/workspace.json`, workspaceId },
    workspaceId && !conflict ? {} : { ...conflicted, next: provision },
  );
  // Whether a webhook belongs to this setup. Setup records the endpoint last,
  // after the credential, and keeps no note of what was asked for: without a
  // complete configuration and without a recorded endpoint it cannot be told
  // whether provisioning finished or stopped before the webhook.
  const webhook = config?.webhook
      ? "configured"
      : journal.webhook !== null
        ? "recorded"
        : config
          ? "not_configured"
          : "unknown",
    wantsWebhook = webhook === "configured" || webhook === "recorded";
  const files = {
    credentialsFile: privateFile(
      root,
      `${journal.directory}/credentials.env`,
      // The check setup itself applies before it reuses the file.
      (body) => setupCredentialMatches(body, { mode, applicationId, programId }),
    ),
    ...(wantsWebhook
      ? {
          webhookFile: privateFile(root, `${journal.directory}/webhook.env`, (body) =>
            /^COMMISH_WEBHOOK_SIGNING_SECRET=whsec_[A-Za-z0-9_-]{32,}\n$/.test(body),
          ),
        }
      : {}),
  };
  const provisioned =
    Boolean(applicationId && programId && journal.credential) &&
    files.credentialsFile === "present" &&
    (!wantsWebhook || (journal.webhook !== null && files.webhookFile === "present"));
  // Met rests on the recorded resources plus a known answer about the webhook,
  // for the setup this configuration identifies.
  const settled = provisioned && webhook !== "unknown" && !conflict;
  // Setup never regenerates or replaces a credential file: with the key
  // recorded and the file gone, or a file that is not the one it wrote, a
  // rerun fails, so the action is to restore the file.
  const credentialFailure =
    files.credentialsFile === "invalid"
      ? "setup_credential_conflict"
      : files.credentialsFile === "absent" && journal.credential
        ? "setup_credential_missing"
        : null;
  // The same holds for a signing-secret file that is not one setup wrote.
  const webhookFailure = files.webhookFile === "invalid" ? "setup_file_conflict" : null;
  add(
    "resources_provisioned",
    settled ? "met" : provisioned ? "unknown" : "unmet",
    {
      source: journal.directory,
      applicationId,
      programId,
      credentialId: journal.credential?.id ?? null,
      webhook,
      ...(wantsWebhook ? { webhookId: journal.webhook?.id ?? null } : {}),
      ...files,
    },
    settled
      ? {}
      : conflict
        ? { ...conflicted, next: provision }
        : credentialFailure
          ? {
              reason: credentialFailure,
              next: {
                kind: "guidance",
                guidance: `Setup will not regenerate or replace ${journal.directory}/credentials.env and fails with ${credentialFailure}. Restore the file as setup wrote it, or revoke the recorded key (commish manage credentials.revoke) before starting a separate setup.`,
              },
            }
          : webhookFailure
            ? {
                reason: webhookFailure,
                next: {
                  kind: "guidance",
                  guidance: `Setup will not replace ${journal.directory}/webhook.env and fails with ${webhookFailure}. Remove the altered file, then rerun the same commish setup command, which saves the signing secret again.`,
                },
              }
            : {
                ...(provisioned ? { reason: "webhook_request_not_recorded" } : {}),
                next: provision,
              },
  );
  // The first step, in order, that someone can act on.
  const open = report.find(
    (item) => item.status === "unmet" || (item.status === "unknown" && item.next),
  );
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
      "Exit 0 means every step is met, 2 that a step is unmet or unknown, 1 an error. Use --json for evidence."
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
      ? `Next (${result.nextStep}): ${next.kind === "command" ? `run ${next.command}` : next.guidance}` +
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
