import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readSetupFile } from "./setup-files.mjs";

const business = new Set(["program.eligibleStripeProductIds",
  "terms.commission", "terms.recurrence", "terms.perSaleCap", "terms.disclosureText", "participantConsent", "webhook", "stripe"]);
const required = {
  application: ["application.name"], destination: ["destination.origin", "destination.proofFile"],
  program: ["program.name", "program.slug", "program.category", "program.eligibleStripeProductIds"],
  terms: ["terms.commission", "terms.recurrence", "terms.perSaleCap", "terms.disclosureText"],
};
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function entry(root, path, directory = false) {
  // Only fixed paths supplied by this module. Check each ancestor without
  // following links; do not traverse the repository or inspect environment files.
  let current = root;
  try {
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return "unsafe";
      if (index < parts.length - 1 || directory) {
        if (!stat.isDirectory()) return "unsafe";
      } else if (!stat.isFile()) return "unsafe";
    }
    return "present";
  } catch (error) { return error.code === "ENOENT" ? "absent" : "unavailable"; }
}

function inspectRepository(root) {
  const warnings = [];
  let manifest = {};
  try {
    manifest = JSON.parse(readSetupFile(root, "package.json"));
    if (!record(manifest)) throw new Error();
  } catch (error) {
    manifest = {};
    warnings.push(error?.message === "setup_file_missing" ? "package_manifest_missing" : "package_manifest_unavailable");
  }
  const has = name => [manifest.dependencies, manifest.devDependencies].some(value => record(value) && Object.hasOwn(value, name));
  const managers = new Set();
  for (const [file, manager] of [["pnpm-lock.yaml", "pnpm"], ["package-lock.json", "npm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]]) {
    const status = entry(root, file);
    if (status === "present") managers.add(manager);
    else if (status !== "absent") warnings.push("lockfile_unavailable");
  }
  if (typeof manifest.packageManager === "string") {
    const declared = /^(pnpm|npm|yarn|bun)@\d+(?:\.\d+){0,2}(?:\+[A-Za-z0-9.]+)?$/.exec(manifest.packageManager);
    if (declared) managers.add(declared[1]);
    else warnings.push("package_manager_declaration_unrecognized");
  }
  if (managers.size > 1) warnings.push("conflicting_package_managers");
  const appDirectories = ["app", "src/app"].filter(path => {
    const status = entry(root, path, true);
    if (!["present", "absent"].includes(status)) warnings.push("framework_directory_unavailable");
    return status === "present";
  });
  if (appDirectories.length > 1) warnings.push("ambiguous_app_directory");
  return {
    packageManager: managers.size === 1 ? [...managers][0] : "unknown",
    framework: has("next") ? "next" : "generic",
    appDirectories: has("next") ? appDirectories : [],
    adapter: has("next") && appDirectories.length === 1 ? "next_peer_check_required" : "agent_wiring_required",
    packages: { sdkDeclared: has("@commish/sdk"), nextDeclared: has("@commish/next") },
    warnings: [...new Set(warnings)],
  };
}

// Planning is entirely local. Never open progress, credentials, provider clients,
// a browser or a network connection, and never run repository scripts.
export function planSetup(root, parsed) {
  const ready = parsed.kind === "ready";
  const repository = inspectRepository(root);
  const missing = parsed.kind === "input_required"
    ? [...new Set(parsed.fields.flatMap(field => required[field] ?? [field]))] : [];
  return {
    status: "plan", planVersion: 1, mutations: false, networkRequests: false,
    configuration: { status: parsed.kind, invalidFields: parsed.kind === "invalid_config" ? parsed.fields : [],
      missingInputs: missing.map(field => ({ field, source: business.has(field) ? "business_decision" : "repository_or_developer" })),
    },
    repository,
    mode: ready ? parsed.config.mode : null,
    authorization: "browser_pairing_with_recent_totp",
    humanActions: ["approve_workspace_mode_and_scopes", ...(ready && parsed.config.stripe === "connect" ? ["authorize_stripe_if_not_connected"] : [])],
    conditionalHumanActions: ["sign_up_or_sign_in", "verify_email", "enroll_or_verify_authenticator", "select_workspace_if_not_supplied", "confirm_business_choices"],
    nextSteps: ready ? [...(!repository.packages.sdkDeclared ? ["install_sdk"] : []),
      ...(repository.framework === "next" ? ["check_next_adapter_peer_range"] : []),
      "run_setup_without_plan", "publish_destination_proof", "wire_capture_and_checkout", "review_readiness", "complete_attributed_test_conversion"]
      : [parsed.kind === "invalid_config" ? "correct_invalid_configuration" : "supply_missing_inputs", "rerun_setup_plan"],
    verification: { integrationVerified: false, liveEligibilityVerified: false },
    integrationVerified: false,
  };
}
