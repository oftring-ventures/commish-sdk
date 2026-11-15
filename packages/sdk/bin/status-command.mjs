import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { argumentsFor, CliError, errorReceipt, fail } from "./cli-http.mjs";
import {
  managementClient,
  managementMode,
  managementUrl,
  readManagementAuthorization,
} from "./management-client.mjs";
import { parseSetupConfig } from "./setup-config.mjs";
import { readSetupFile } from "./setup-files.mjs";
import { setupOnboardingScopes } from "./setup-onboarding.mjs";
import { readSetupProgress, setupAppOrigin, setupFingerprint } from "./setup-progress.mjs";
import { setupCredentialMatches } from "./setup-secrets.mjs";

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
    "--app-url <url>",
    "--auth-file <path>",
    "--management-url <url>",
    "--json",
    "--non-interactive",
    "--help",
  ],
  purpose:
    "Reports each setup step recorded for the install in the current directory, and whether management access is still usable, with its status, the evidence that status rests on and the exact next command.",
  steps,
  stepStatuses: ["met", "unmet", "unknown"],
  reads: {
    localFiles: [
      defaultConfig,
      ".commish/setup/<mode>/*.json",
      ".commish/setup/<mode>/credentials.env (checked against the mode and recorded resources, never printed)",
      ".commish/management/<request-id>/authorization.json",
    ],
    requests: ["GET /grants"],
  },
  authorization:
    "Uses --auth-file or COMMISH_MANAGEMENT_TOKEN; otherwise the newest stored grant for this workspace and mode that includes diagnostics.read, the scope the remaining onboarding checks need.",
  // A step is met only if commish setup, rerun now with these inputs, would also
  // treat it as done.
  sameSetup:
    "The configuration, --mode and --app-url are compared with the fingerprint setup recorded; a difference is setup_config_conflict and nothing recorded counts for this configuration.",
  // A printed command runs as written, here: it carries the inputs status was
  // given or resolved, and says what the environment has to look like.
  commands:
    "Each command carries --mode and, where status was given or resolved them, --config, --app-url, --management-url and --auth-file. environment.unset names a variable to clear first. A path that is not plain (letters, digits, . _ - /) is shown as <config> or <auth-file>; <authorizationFile> is the file a preceding auth login returns.",
  mutations: false,
  // The install setup would address: its configuration decides before the shell.
  mode: "--mode, else the configuration file's mode (test when it names none), else COMMISH_MODE, else test",
  output: "text; --json prints one JSON object on stdout",
  exitCodes: { 0: "every_step_met", 1: "error", 2: "a_step_is_unmet_or_unknown" },
  integrationVerified: false,
});

// A path that can be pasted into a command line as it is.
const plain = (value) => /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value);
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
    .flatMap((entry) => {
      const path = `.commish/management/${entry.name}/authorization.json`;
      try {
        const { proposal } = readManagementAuthorization(root, path, { recover: false });
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
    ["mode", "config", "app-url", "auth-file", "management-url"],
    ["help", "json", "non-interactive"],
  );
  if (v.help) return statusHelp();
  if (p.length) fail("invalid_arguments");
  let appOrigin;
  try {
    appOrigin = setupAppOrigin(v["app-url"]);
  } catch {
    fail("invalid_arguments");
  }
  const configuration = readConfiguration(root, v.config ?? defaultConfig, v.mode),
    mode = managementMode(v.mode ?? configuration.mode, env),
    // Printed commands carry what status was given, so they address the same
    // file and deployment. Both values were validated above.
    configFlag = `--config ${v.config === undefined ? defaultConfig : plain(v.config) ? v.config : "<config>"}`,
    appFlag = v["app-url"] === undefined ? "" : ` --app-url ${appOrigin}`,
    // The management endpoint status was told to use: its own flag, else the
    // app URL's. Undefined leaves it to the grant file or the environment.
    managementFlag =
      v["management-url"] ??
      (v["app-url"] === undefined ? undefined : `${appOrigin}/api/management/v1`);
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
  const approval = { humanAction: "open_the_approval_url_and_confirm_the_pairing_code" };
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
    ...approval,
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
              command: `commish setup ${v.config === undefined ? "" : `${configFlag} `}${v.mode === undefined ? "" : `--mode ${mode} `}${appFlag ? `${appFlag.trim()} ` : ""}--plan --json`,
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

  // Management access: an explicit file or token, else the newest stored grant.
  const explicit = v["auth-file"] !== undefined || Boolean(env.COMMISH_MANAGEMENT_TOKEN);
  const candidates = explicit
    ? [v["auth-file"]]
    : workspaceId
      ? storedGrants(root, mode, workspaceId)
      : [];
  let client = null,
    authFile,
    // The endpoint of the newest candidate: the deployment the stored grants are for.
    candidateBase = null;
  const tried = [];
  for (const path of candidates) {
    const source = path ?? "COMMISH_MANAGEMENT_TOKEN";
    let candidate;
    try {
      candidate = managementClient({
        root,
        env,
        mode,
        authFile: path,
        url: managementFlag,
        fetcher: options.fetcher,
        signal: options.signal,
        recover: false,
      });
    } catch (error) {
      // A file or token the caller named must be usable; a stored one is skipped.
      if (explicit) throw error;
      continue;
    }
    candidateBase ??= candidate.baseUrl;
    try {
      const grant = await candidate.status();
      // A named grant for another workspace cannot answer for this install.
      const foreign = workspaceId !== null && grant.workspaceId !== workspaceId;
      tried.push({
        source,
        status: grant.status,
        kind: grant.kind,
        workspaceId: grant.workspaceId,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
        ...(foreign ? { code: "workspace_mismatch" } : {}),
      });
      if (grant.status === "authorized" && !foreign) {
        client = candidate;
        authFile = path;
        break;
      }
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      tried.push({ source, status: "unavailable", code: failureCode(error) });
      // An outage is the same for every candidate; a refused grant is not.
      if (error.message === "service_unavailable" || error.detail?.retryable) break;
    }
  }
  // Without an authorized grant, a request that is still pending is the one to
  // report, so it is resumed instead of replaced; otherwise the newest tried.
  const access = client
    ? tried.at(-1)
    : (tried.find((state) => state.status === "pending" && !state.code) ??
      tried[0] ?? { source: "none", status: "missing" });
  const usable = client !== null && access.scopes.includes("diagnostics.read");
  // What a command resolves by itself in this environment, and the endpoint
  // status addressed. They differ when status was pointed elsewhere by a flag
  // or by a stored grant's own endpoint; a new login then has to be told.
  let ambient = null;
  try {
    ambient = managementUrl(undefined, env);
  } catch {
    // A malformed COMMISH_MANAGEMENT_URL: the flag below overrides it.
  }
  const endpoint =
      managementFlag !== undefined
        ? managementUrl(managementFlag, env)
        : (candidateBase ?? ambient ?? managementUrl(undefined, {})),
    endpointFlag = endpoint === ambient ? "" : ` --management-url ${endpoint}`;
  // auth login refuses to start while a management token is set, and a
  // command that names a grant file refuses to run beside one.
  const withoutToken = env.COMMISH_MANAGEMENT_TOKEN
    ? { environment: { unset: ["COMMISH_MANAGEMENT_TOKEN"] } }
    : {};
  const resumable =
    access.status === "pending" && !access.code && access.source !== "COMMISH_MANAGEMENT_TOKEN";
  const login = !workspaceId
    ? provision
    : {
        kind: "command",
        command: resumable
          ? `commish auth login --auth-file ${plain(access.source) ? access.source : "<auth-file>"} --mode ${mode} --no-open --non-interactive --json`
          : `commish auth login --workspace ${workspaceId} --workspace-scope ` +
            (mode === "test"
              ? `--onboarding --scopes ${setupOnboardingScopes.join(",")}`
              : "--scopes resources.read,diagnostics.read,programs.read,terms.read,destinations.read") +
            ` --mode ${mode}${endpointFlag} --no-open --non-interactive --json`,
        ...approval,
        ...withoutToken,
      };
  add("management_access", usable ? "met" : "unmet", access, usable ? {} : { next: login });
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
      "Reads commish.setup.json and .commish/ in the current directory, then checks the management grant with one request. Changes nothing.\n" +
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
      ? `Next (${result.nextStep}): ${next.environment ? `first unset ${next.environment.unset.join(", ")}, then ` : ""}${next.kind === "command" ? `run ${next.command}` : next.guidance}` +
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
