import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { argumentsFor, CliError, errorReceipt, fail } from "./cli-http.mjs";
import { readDiagnostics } from "./doctor-command.mjs";
import {
  managementClient,
  managementMode,
  managementUrl,
  readManagementAuthorization,
} from "./management-client.mjs";
import { parseSetupConfig } from "./setup-config.mjs";
import { readSetupFile } from "./setup-files.mjs";
import { setupOnboardingScopes } from "./setup-onboarding.mjs";
import { readSetupProgress } from "./setup-progress.mjs";
import { setupCredentialMatches } from "./setup-secrets.mjs";

const defaultConfig = "commish.setup.json";
// Onboarding in the order an install reaches it. The first three read local
// files only; the rest need a management grant with diagnostics.read.
const steps = [
  "configuration",
  "setup_approved",
  "resources_provisioned",
  "management_access",
  "destination_verified",
  "stripe_connected",
  "eligible_products",
  "program_active",
  "rehearsal",
  "attributed_test_conversion",
  "webhook_delivery",
  "integration_activated",
];
// The diagnostics checks each remote step rests on.
const checksFor = {
  destination_verified: ["verified_origin"],
  stripe_connected: ["stripe_connection"],
  eligible_products: ["eligible_products"],
  program_active: ["program_active", "active_terms"],
  attributed_test_conversion: [
    "stable_customer_identity",
    "attributed_checkout",
    "provider_event_receipt",
    "attributed_conversion_observed",
    "commission_observed",
  ],
  webhook_delivery: ["related_webhook_delivered"],
};
// Fixed guidance for what the application or its owner still has to do. Server
// text is never repeated: a report is evidence, not instructions.
const conversionGuidance = {
  stable_customer_identity:
    "Set the Checkout session's client_reference_id to your own stable customer ID, then repeat the Test purchase.",
  attributed_checkout:
    "Open the referral link from commish test rehearsal and complete a Test purchase in your product.",
  provider_event_receipt:
    "Let the matching Stripe Test event reach Commish through the connected Stripe account, then check again.",
  attributed_conversion_observed:
    "Open the referral link from commish test rehearsal and complete a Test purchase in your product.",
  commission_observed:
    "Read the conversion's commissions (commish conversions commissions <conversionId>) and resolve eligibility.",
};
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
    "Reports each onboarding step for the install in the current directory with its status, the evidence that status rests on and the exact next command or browser action.",
  steps,
  stepStatuses: ["met", "unmet", "not_applicable", "unknown"],
  reads: {
    localFiles: [
      defaultConfig,
      ".commish/setup/<mode>/*.json",
      ".commish/setup/<mode>/credentials.env (checked against the mode and recorded resources, never printed)",
      ".commish/management/<request-id>/authorization.json",
    ],
    requests: ["GET /grants", "diagnostics.get"],
    requiredScope: "diagnostics.read",
  },
  authorization:
    "Uses --auth-file or COMMISH_MANAGEMENT_TOKEN; otherwise the newest stored grant for this workspace and mode that includes diagnostics.read. Without one, the steps that need it are unknown.",
  mutations: false,
  // The install setup would address: its configuration decides before the shell.
  mode: "--mode, else the configuration file's mode (test when it names none), else COMMISH_MODE, else test",
  output: "text; --json prints one JSON object on stdout",
  exitCodes: { 0: "every_step_met_or_not_applicable", 1: "error", 2: "a_step_is_unmet_or_unknown" },
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
  // Setup reads the mode from this file and defaults it to test.
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
    ["mode", "config", "auth-file", "management-url"],
    ["help", "json", "non-interactive"],
  );
  if (v.help) return statusHelp();
  if (p.length) fail("invalid_arguments");
  const configuration = readConfiguration(root, v.config ?? defaultConfig),
    config = configuration.state === "ready" ? configuration.config : null,
    mode = managementMode(v.mode ?? configuration.mode, env),
    // The path given to --config is not repeated; commands name where it goes.
    configFlag = `--config ${v.config === undefined ? defaultConfig : "<config>"}`;
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
  // A setup started from flags left no file to name, and only its caller knows
  // the flags: naming commish.setup.json would fail with setup_file_missing.
  const provision = {
    ...(configuration.state === "missing" && journal.intent
      ? {
          kind: "guidance",
          guidance:
            "Setup was started from flags, so there is no configuration file to rerun. Repeat the original commish setup command with the same flags, or restore its configuration file; setup resumes from the recorded progress.",
        }
      : {
          kind: "command",
          command: `commish setup ${configFlag} --mode ${mode} --no-open --non-interactive --json`,
        }),
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
    configured
      ? {}
      : {
          next: {
            kind: "command",
            command: `commish setup ${v.config === undefined ? "" : `${configFlag} `}--plan --json`,
          },
        },
  );
  add(
    "setup_approved",
    workspaceId ? "met" : "unmet",
    { source: `${journal.directory}/workspace.json`, workspaceId },
    workspaceId ? {} : { next: provision },
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
  // Met rests on the recorded resources plus a known answer about the webhook.
  const settled = provisioned && webhook !== "unknown";
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
    authFile;
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
        url: v["management-url"],
        fetcher: options.fetcher,
        signal: options.signal,
        recover: false,
      });
    } catch (error) {
      // A file or token the caller named must be usable; a stored one is skipped.
      if (explicit) throw error;
      continue;
    }
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
  const login = !workspaceId
    ? provision
    : {
        kind: "command",
        command:
          access.status === "pending" && !access.code && access.source.startsWith(".commish/")
            ? `commish auth login --auth-file ${access.source} --mode ${mode} --no-open --non-interactive --json`
            : `commish auth login --workspace ${workspaceId} --workspace-scope ` +
              (mode === "test"
                ? `--onboarding --scopes ${setupOnboardingScopes.join(",")}`
                : "--scopes resources.read,diagnostics.read,programs.read,terms.read,destinations.read") +
              ` --mode ${mode} --no-open --non-interactive --json`,
        ...approval,
      };
  add("management_access", usable ? "met" : "unmet", access, usable ? {} : { next: login });

  // One diagnostics read answers every remaining step.
  let checks = null,
    activatedAt = null,
    reason = !programId ? "program_not_provisioned" : !usable ? "management_access_required" : null;
  if (!reason)
    try {
      const diagnostics = (await readDiagnostics(client, programId)).data.report;
      activatedAt = diagnostics.testActivatedAt ?? null;
      if (
        !Array.isArray(diagnostics.checks) ||
        diagnostics.checks.some(
          (check) =>
            !record(check) ||
            typeof check.code !== "string" ||
            !["met", "unmet", "not_applicable", "not_evaluated"].includes(check.status),
        ) ||
        (activatedAt !== null &&
          (typeof activatedAt !== "string" || !Number.isFinite(Date.parse(activatedAt))))
      )
        fail("invalid_response");
      // Reprinted from the parsed instant, so only a timestamp can reach output.
      if (activatedAt !== null) activatedAt = new Date(activatedAt).toISOString();
      checks = new Map(diagnostics.checks.map((check) => [check.code, check.status]));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      reason = failureCode(error);
    }
  const origin = new URL(client?.baseUrl ?? managementUrl(v["management-url"], env)).origin,
    dashboard = `${origin}/dashboard/workspace/${workspaceId}/programs/${programId}`,
    owner = { actor: "workspace_owner_or_admin" };
  const actions = (tail) => ({
    destination_verified: {
      kind: "command",
      before: `Deploy ${config?.destination.proofFile ?? "the destination proof file"} so that ${config?.destination.origin ?? "<origin>"}/.well-known/commish-verification.txt serves it.`,
      command: `commish manage destinations.verify --body-file commish-destination.json${tail}`,
      bodyFile: "commish-destination.json",
      body: { applicationId, origin: config?.destination.origin ?? "<origin>" },
    },
    stripe_connected: {
      kind: "browser",
      url: `${origin}/cli/setup/workspace/${workspaceId}/stripe?mode=${mode}`,
      ...owner,
      action: "connect_stripe",
    },
    eligible_products: {
      kind: "browser",
      url: dashboard,
      ...owner,
      action: "choose_the_stripe_products_that_earn_commission",
    },
    // The expected status and version are the state setup leaves; the server
    // refuses the write if the program has moved on.
    program_active: {
      kind: "command",
      before: `Read the term version to activate: commish manage terms.list --program ${programId}${tail}`,
      command: `commish manage programs.activate --body-file commish-activate.json${tail}`,
      bodyFile: "commish-activate.json",
      body: {
        programId,
        termVersion: "<version from terms.list>",
        expectedCurrentTermVersion: null,
        expectedCurrentStatus: "draft",
      },
    },
    rehearsal: {
      kind: "command",
      command: `commish test rehearsal --program ${programId}${tail.replace(` --mode ${mode}`, "")}`,
      // The step stays unknown until a purchase is attributed, so say what follows.
      followedBy: {
        kind: "guidance",
        guidance:
          "Open the returned referralUrl and complete a Test purchase in your product. This step is met once that conversion is attributed; running the command again returns the same link.",
      },
    },
    webhook_delivery: {
      kind: "guidance",
      guidance:
        "Subscribe the webhook endpoint to conversion and commission events, then inspect its deliveries and replay eligible failures.",
    },
    integration_activated: {
      kind: "browser",
      url: `${dashboard}?tab=integration`,
      ...owner,
      action: "run_diagnostics_then_activate_integration",
    },
  });
  // A command in next must be one the grant in hand can run. Where its scopes
  // lack what the command needs, next asks for a grant that has them and
  // followedBy carries the command to run with the file that login returns.
  const needs = {
    destination_verified: ["destinations.write"],
    program_active: ["terms.read", "programs.write"],
    rehearsal: ["programs.write"],
  };
  const held = actions(
      `${authFile === undefined ? "" : ` --auth-file ${authFile}`} --mode ${mode} --json`,
    ),
    granted = actions(` --auth-file <authorizationFile> --mode ${mode} --json`);
  const next = Object.fromEntries(
    Object.keys(held).map((step) => {
      const lacking = (needs[step] ?? []).filter((scope) => !access.scopes?.includes(scope));
      return [
        step,
        lacking.length
          ? {
              kind: "command",
              command:
                `commish auth login --workspace ${workspaceId} --workspace-scope ` +
                (mode === "test"
                  ? `--onboarding --scopes ${setupOnboardingScopes.join(",")}`
                  : `--scopes ${needs[step].join(",")}`) +
                ` --mode ${mode} --no-open --non-interactive --json`,
              ...approval,
              requiredScopes: lacking,
              followedBy: granted[step],
            }
          : held[step],
      ];
    }),
  );
  const source = "diagnostics.get";
  for (const step of steps.slice(4)) {
    if (reason) add(step, "unknown", { source }, { reason });
    else if (mode === "live" && ["rehearsal", "integration_activated"].includes(step))
      add(step, "not_applicable", { source: "mode" });
    else if (step === "rehearsal") {
      // No read reports the Test partnership itself; an attributed conversion
      // proves a referral link existed and was used. Rehearsing again is safe.
      const state = checks.get("attributed_conversion_observed");
      add(
        step,
        state === "met" ? "met" : "unknown",
        { source, checks: state === undefined ? {} : { attributed_conversion_observed: state } },
        state === "met"
          ? {}
          : { reason: "no_read_operation_reports_the_test_partnership", next: next.rehearsal },
      );
    } else if (step === "integration_activated")
      add(
        step,
        activatedAt ? "met" : "unmet",
        { source, testActivatedAt: activatedAt },
        activatedAt ? {} : { next: next[step] },
      );
    else {
      const observed = Object.fromEntries(
          checksFor[step]
            .filter((code) => checks.has(code))
            .map((code) => [code, checks.get(code)]),
        ),
        states = Object.values(observed),
        evidence = { source, checks: observed };
      if (states.length !== checksFor[step].length || states.includes("not_evaluated"))
        // LIVE reports provider readiness as one unevaluated check.
        add(step, "unknown", evidence, {
          reason: mode === "live" ? "not_evaluated_in_live" : "check_not_reported",
        });
      else if (states.includes("unmet"))
        add(step, "unmet", evidence, {
          next:
            step === "attributed_test_conversion"
              ? {
                  kind: "guidance",
                  guidance:
                    conversionGuidance[checksFor[step].find((code) => observed[code] === "unmet")],
                }
              : next[step],
        });
      else
        add(
          step,
          states.every((state) => state === "not_applicable") ? "not_applicable" : "met",
          evidence,
        );
    }
  }
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
      "Reads commish.setup.json and .commish/ in the current directory, then the management grant and one diagnostics report. Changes nothing.\n" +
      "Exit 0 means every step is met, 2 that a step is unmet or unknown, 1 an error. Use --json for evidence."
    );
  // One action as text; followedBy is what comes after it, in the same shapes.
  const action = (next) =>
    (next.kind === "browser"
      ? `open ${next.url} in the browser (${next.action.replaceAll("_", " ")}).`
      : next.kind === "command"
        ? `${next.before ? `${next.before}\nThen run: ` : "run "}${next.command}` +
          (next.body ? `\nBody file ${next.bodyFile}: ${JSON.stringify(next.body)}` : "")
        : next.guidance) +
    (next.humanAction ? `\nThen a person must ${next.humanAction.replaceAll("_", " ")}.` : "") +
    (next.followedBy ? `\nAfter that: ${action(next.followedBy)}` : "");
  return (
    `Commish status (${result.mode.toUpperCase()}): ${result.status}.\n` +
    result.steps
      .map(
        (item) =>
          `  ${item.status.padEnd(14)} ${item.step}${item.reason ? ` (${item.reason})` : ""}\n`,
      )
      .join("") +
    (result.next
      ? `Next (${result.nextStep}): ${action(result.next)}`
      : result.status === "complete"
        ? "Every step is met."
        : "No next action is known; see --json for the reasons.") +
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
