import { validateSetupProgram, validateSetupTerms } from "./setup-resources.mjs";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, names) => record(value) && Object.keys(value).sort().join() === [...names].sort().join();
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// Only non-secret business choices enter browser review. Local paths,
// credentials, provider states and application authority stay out of it.
export function validateSetupIntent(value) {
  if (!exact(value, ["version", "program", "terms"]) || value.version !== 1 ||
      !record(value.program) || !record(value.terms) ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576) throw new Error("invalid_request");
  validateSetupProgram({ ...value.program, applicationId: "app_configuration" });
  validateSetupTerms({ effectiveAt: "2000-01-01T00:00:00.000Z", ...value.terms, programId: "prg_configuration" });
  // These identifiers are supplied by provisioning, never by reviewed choices.
  if (Object.hasOwn(value.program, "applicationId") || Object.hasOwn(value.terms, "programId"))
    throw new Error("invalid_request");
}
export function setupIntent(config) {
  const value = structuredClone({ version: 1, program: config.program, terms: config.terms });
  validateSetupIntent(value);
  value.program.eligibleStripeProductIds = [...new Set(value.program.eligibleStripeProductIds)].sort();
  value.terms.prohibitedClaims = [...new Set(value.terms.prohibitedClaims)].sort();
  return value;
}
export function sameSetupIntent(actual, expected) {
  try {
    validateSetupIntent(actual);
    return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
  } catch { return false; }
}
