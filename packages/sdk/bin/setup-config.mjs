import { isAbsolute } from "node:path";
import { setupOrigin, validateSetupProgram, validateSetupTerms, validateSetupWebhook } from "./setup-resources.mjs";
import { validateSetupWorkspace } from "./setup-session.mjs";

const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const known = (v, names) => record(v) && Object.keys(v).every(k => names.includes(k));
const text = (v, max) => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max;
const fields = ["version", "mode", "workspace", "application", "destination", "program", "terms", "participantConsent", "webhook", "stripe"];
const path = v => text(v, 1024) && !isAbsolute(v) && !v.includes("\\") && !v.includes("\0") &&
  !v.split("/").some(part => [".git", ".commish"].includes(part.toLowerCase())) &&
  v.split("/").every(part => part && part !== "." && part !== "..");
const programFields = ["name", "slug", "description", "category", "visibility", "joinPolicy", "attributionPolicy", "eligibleStripeProductIds", "creatorKit"];
const termFields = ["version", "commission", "recurrence", "perSaleCap", "disclosureText", "prohibitedClaims", "effectiveAt"];

// Report only fixed field names, never values or untrusted property names.
// Business choices are validated before authorization or any network request.
export function parseSetupConfig(value) {
  if (!known(value, fields)) return { kind: "invalid_config", fields: ["config"] };
  const missing = [], invalid = [];
  const require = (parent, key, field = key) => { if (!Object.hasOwn(parent ?? {}, key)) missing.push(field); };
  for (const key of ["application", "destination", "program", "terms", "participantConsent", "webhook", "stripe"]) require(value, key);
  if (value.version !== 1) invalid.push("version");
  const mode = value.mode === undefined ? "test" : value.mode;
  if (!["test", "live"].includes(mode)) invalid.push("mode");
  try { validateSetupWorkspace(value.workspace); } catch { invalid.push("workspace"); }
  if (value.application !== undefined && (!known(value.application, ["name"]) || !text(value.application.name, 100))) invalid.push("application.name");
  let origin;
  if (value.destination !== undefined) {
    if (!known(value.destination, ["origin", "proofFile"])) invalid.push("destination");
    else {
      for (const key of ["origin", "proofFile"]) require(value.destination, key, `destination.${key}`);
      origin = setupOrigin(value.destination.origin);
      if (value.destination.origin !== undefined && !origin) invalid.push("destination.origin");
      if (value.destination.proofFile !== undefined && !path(value.destination.proofFile)) invalid.push("destination.proofFile");
    }
  }
  let program, terms;
  if (value.program !== undefined) {
    if (!known(value.program, programFields)) invalid.push("program");
    else {
      for (const key of ["name", "slug", "category", "eligibleStripeProductIds"]) require(value.program, key, `program.${key}`);
      program = { description: "", visibility: "private", joinPolicy: "approval", attributionPolicy: "last_click",
        creatorKit: { summary: "", talkingPoints: [], assets: [] }, ...value.program };
      if (!missing.some(f => f.startsWith("program."))) {
        try { validateSetupProgram({ ...program, applicationId: "app_configuration" }); }
        catch { invalid.push("program"); }
      }
    }
  }
  if (value.terms !== undefined) {
    if (!known(value.terms, termFields)) invalid.push("terms");
    else {
      for (const key of ["commission", "recurrence", "perSaleCap", "disclosureText"]) require(value.terms, key, `terms.${key}`);
      terms = { version: 1, prohibitedClaims: [], ...value.terms };
      if (!missing.some(f => f.startsWith("terms."))) {
        try { validateSetupTerms({ effectiveAt: "2000-01-01T00:00:00.000Z", ...terms, programId: "prg_configuration" }); }
        catch { invalid.push("terms"); }
      }
    }
  }
  if (value.participantConsent !== undefined && value.participantConsent !== "commish_hosted") invalid.push("participantConsent");
  if (value.stripe !== undefined && !["connect", "later"].includes(value.stripe)) invalid.push("stripe");
  if (value.webhook !== undefined && value.webhook !== null) {
    try { validateSetupWebhook(value.webhook); } catch { invalid.push("webhook"); }
  }
  if (invalid.length) return { kind: "invalid_config", fields: invalid };
  if (missing.length) return { kind: "input_required", fields: missing };
  return { kind: "ready", config: structuredClone({ version: 1, mode,
    ...(value.workspace ? { workspace: value.workspace } : {}), application: value.application,
    destination: { origin, proofFile: value.destination.proofFile }, program, terms,
    participantConsent: value.participantConsent, webhook: value.webhook, stripe: value.stripe }) };
}
