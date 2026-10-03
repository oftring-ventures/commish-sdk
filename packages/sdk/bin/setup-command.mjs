import { parseSetupArguments, setupFlags } from "./setup-arguments.mjs";
import { runSetup } from "./setup-workflow.mjs";

const codes = new Set(["invalid_arguments", "invalid_setup_config", "invalid_app_url", "invalid_response", "invalid_request",
  "service_unavailable", "rate_limited", "access_denied", "mfa_required", "recent_auth_required", "authorization_required",
  "live_access_required", "setup_expired", "setup_conflict", "setup_not_found", "setup_interrupted", "setup_config_conflict",
  "setup_file_missing", "setup_file_conflict", "setup_file_unavailable", "invalid_setup_file", "invalid_setup_progress",
  "unsafe_file_path", "unsafe_file_permissions", "unsupported_file_safety", "setup_git_unavailable", "setup_state_tracked",
  "setup_state_not_ignored", "setup_credential_missing", "setup_credential_conflict", "challenge_mismatch", "origin_not_public", "verification_unavailable"]);
const guidance = code => ({
  setup_expired: "Run the same command to authorize again and resume.",
  recent_auth_required: "Verify your authenticator again, then rerun the same command.",
  mfa_required: "Add an authenticator in Commish, then rerun the same command.",
  setup_config_conflict: "Use the original setup configuration; inspect .commish/setup before starting a separate setup.",
  setup_file_conflict: "An existing file differs. Preserve it and resolve the conflict before retrying.",
  setup_credential_missing: "Restore the recorded credential file or revoke the existing key before starting separate setup.",
  live_access_required: "Complete the workspace's existing LIVE eligibility steps before retrying.",
  service_unavailable: "Retry the same command; saved resources and credential material will be reused.",
}[code] ?? "Review the setup configuration and rerun the same command.");
function progressText(event) {
  if (event.status === "authorization_required") return `Authorize at ${event.approvalUrl}\nConfirm pairing code ${event.pairingCode}.`;
  if (event.status === "authorized") return `Authorized ${event.mode.toUpperCase()} workspace ${event.workspaceId}.`;
  if (event.status === "publish_required") return `Publish ${event.path} at ${event.url}. Waiting for verification.`;
  if (event.status === "browser_action_required") return `Connect Stripe ${event.mode.toUpperCase()} at ${event.url}.`;
  if (event.status === "browser_unavailable") return `Open ${event.approvalUrl ?? event.url} to continue.`;
  return `Waiting for setup${event.code ? ` (${event.code})` : ""}…`;
}
function resultText(result) {
  if (result.status === "help") return "commish setup [options]\n\n" + setupFlags.join("\n") +
    "\n\nReads commish.setup.json by default. Program, terms, webhook and participant consent are explicit business inputs.\nTEST is the default. --no-open prints browser handoffs; --wait sets a 0–600 second provisioning wait.\nWith --json, progress goes to stderr and one final receipt goes to stdout.";
  if (["input_required", "invalid_config"].includes(result.status)) return `Setup ${result.status.replaceAll("_", " ")}: ${result.fields.join(", ")}.\nProvide these in commish.setup.json or explicit flags; see commish setup --help.`;
  if (result.status === "error") return `Setup failed: ${result.code}. ${result.guidance}`;
  return `Setup ${result.status.replaceAll("_", " ")} (${result.mode.toUpperCase()}).\nWorkspace: ${result.workspaceId}\nApplication: ${result.applicationId}\nProgram: ${result.programId}\nCredentials file: ${result.credentialsFile}\n` +
    (result.webhookFile ? `Webhook secret file: ${result.webhookFile}\n` : "") +
    `Remaining steps: ${result.readiness.actions.join(", ") || "complete integration acceptance"}.\nIntegration remains unverified. Rerun this command to resume.`;
}
export async function runSetupCommand(args, { root = process.cwd(), execute = runSetup,
  out = value => console.log(value), diagnostic = value => console.error(value), signals = process,
} = {}) {
  const controller = new AbortController(), stop = () => controller.abort();
  const json = args.includes("--json");
  const finish = result => out(json ? JSON.stringify(result) : resultText(result));
  signals.on("SIGINT", stop); signals.on("SIGTERM", stop);
  try {
    const parsed = parseSetupArguments(root, args);
    if (parsed.kind === "help") { finish({ status: "help", flags: parsed.flags, integrationVerified: false }); return 0; }
    if (parsed.kind !== "ready") { finish({ status: parsed.kind, fields: parsed.fields, integrationVerified: false }); return 2; }
    const result = await execute(root, parsed.config, parsed.options, { signal: controller.signal,
      notify: event => diagnostic(json ? JSON.stringify(event) : progressText(event)) });
    finish(result); return result.status === "configured" ? 0 : 2;
  } catch (error) {
    const code = controller.signal.aborted ? "setup_interrupted" : codes.has(error?.message) ? error.message : "service_unavailable";
    finish({ status: "error", code, guidance: guidance(code), integrationVerified: false }); return code === "setup_interrupted" ? 130 : 1;
  } finally { signals.removeListener("SIGINT", stop); signals.removeListener("SIGTERM", stop); }
}
