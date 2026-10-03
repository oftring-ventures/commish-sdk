const fail = (code) => { throw new Error(code); };
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => record(value) && Object.keys(value).sort().join() === [...names].sort().join();
const id = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{12,}$`).test(value);
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const name = (value) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 100;
function canonicalOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === "/" && url.port !== "0" && url.hostname.length <= 253 &&
      url.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? url.origin : null;
  } catch { return null; }
}

const programFields = ["applicationId", "name", "slug", "description", "category", "visibility", "joinPolicy", "attributionPolicy", "eligibleStripeProductIds", "creatorKit"];
const termFields = ["programId", "version", "commission", "recurrence", "perSaleCap", "disclosureText", "prohibitedClaims", "effectiveAt"];
const same = (left, right) => Array.isArray(left) ? Array.isArray(right) && left.length === right.length && left.every((v, i) => same(v, right[i])) :
  record(left) ? keys(right, Object.keys(left)) && Object.entries(left).every(([key, v]) => same(v, right[key])) : left === right;
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v > 0 && v <= max;
const usd = (v) => keys(v, ["amount", "currency"]) && integer(v.amount) && v.currency === "usd";
const text = (v, max, min = 0) => typeof v === "string" && v === v.trim() && v.length >= min && v.length <= max;
const kit = (v) => keys(v, ["summary", "talkingPoints", "assets"]) && text(v.summary, 1000) &&
  Array.isArray(v.talkingPoints) && v.talkingPoints.length <= 20 && v.talkingPoints.every(p => text(p, 280, 1)) &&
  Array.isArray(v.assets) && v.assets.length <= 20 && v.assets.every(a => {
    if (!keys(a, ["label", "url"]) || !text(a.label, 100, 1) || !text(a.url, 2048, 1)) return false;
    try { const u = new URL(a.url); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
  });
const selected = (source, fields) => Object.fromEntries(fields.map(key => [key, source[key]]));

export function validateSetupProgram(input) {
  if (!keys(input, programFields) || !id(input.applicationId, "app") || !name(input.name) ||
      typeof input.slug !== "string" || input.slug.length < 3 || input.slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) ||
      !text(input.description, 2000) || !text(input.category, 50, 1) ||
      !["public", "unlisted", "private"].includes(input.visibility) || !["instant", "approval"].includes(input.joinPolicy) ||
      !["first_click", "last_click"].includes(input.attributionPolicy) || !Array.isArray(input.eligibleStripeProductIds) || input.eligibleStripeProductIds.length > 100 ||
      input.eligibleStripeProductIds.some(v => typeof v !== "string" || !/^prod_[A-Za-z0-9_-]+$/.test(v)) ||
      !kit(input.creatorKit)) fail("invalid_request");
}
export function validateSetupTerms(input) {
  const commission = input?.commission, recurrence = input?.recurrence;
  if (!keys(input, termFields) || !id(input.programId, "prg") || !integer(input.version, 1_000_000) ||
      !(keys(commission, ["type", "basisPoints"]) && commission.type === "percentage" && integer(commission.basisPoints, 10_000) ||
    keys(commission, ["type", "amount", "currency"]) && commission.type === "fixed" && usd({ amount: commission.amount, currency: commission.currency })) ||
      !(keys(recurrence, ["kind"]) && ["first_payment", "lifetime"].includes(recurrence.kind) ||
    keys(recurrence, ["kind", "months"]) && recurrence.kind === "fixed_months" && integer(recurrence.months, 120)) ||
      input.perSaleCap !== null && !usd(input.perSaleCap) || !text(input.disclosureText, 2000, 1) ||
      !Array.isArray(input.prohibitedClaims) || input.prohibitedClaims.length > 20 || input.prohibitedClaims.some(v => !text(v, 280, 1)) ||
      !date(input.effectiveAt) || new Date(input.effectiveAt).toISOString() !== input.effectiveAt) fail("invalid_request");
}
export const setupOrigin = canonicalOrigin;
const webhookEvents = new Set(["invitation.created", "invitation.accepted", "membership.activated", "conversion.created", "conversion.refunded",
  "commission.pending", "commission.unfunded", "commission.payable", "commission.reversed", "commission.disputed", "sale.dispute_opened",
  "sale.dispute_recovery_required", "funding.failed", "payout.processing", "payout.paid", "payout.failed", "payout.canceled"]);
export function validateSetupWebhook(input) {
  if (!keys(input, ["url", "eventTypes"]) || !text(input.url, 2048, 1) || !/^https:\/\//i.test(input.url) ||
      /[\s\\?#]/.test(input.url) || !Array.isArray(input.eventTypes) || !input.eventTypes.length || input.eventTypes.length > webhookEvents.size ||
      new Set(input.eventTypes).size !== input.eventTypes.length || input.eventTypes.some(e => !webhookEvents.has(e))) fail("invalid_request");
  try {
    const url = new URL(input.url);
    if (!canonicalOrigin(url.origin) || url.username || url.password || url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
        url.hostname.endsWith(".local") || /^\d+$/.test(url.hostname.split(".").at(-1))) fail("invalid_request");
  } catch { fail("invalid_request"); }
}
function webhookInput(input) {
  if (!keys(input, ["url", "eventTypes", "idempotencyKey"]) || !text(input.idempotencyKey, 255, 1)) fail("invalid_request");
  validateSetupWebhook({ url: input.url, eventTypes: input.eventTypes });
  return { url: input.url, eventTypes: [...input.eventTypes].sort(), idempotencyKey: input.idempotencyKey };
}

// Only these reviewed routes can use the closure-held bearer. Public receipts
// are reconstructed field by field, so extra server fields never reach output.
export function createSetupResources(request, context) {
  async function call(operation, path, method, input) {
    const bound = context();
    if (!bound.workspaceId) fail("authorization_required");
    if (!bound.operations.includes(operation)) fail("access_denied");
    const result = await request(method, path, input);
    if (result.workspaceId !== bound.workspaceId || result.mode !== bound.mode || typeof result.replayed !== "boolean") fail("invalid_response");
    return { result, receipt: { protocol: result.protocol, requestId: result.requestId,
      workspaceId: bound.workspaceId, mode: bound.mode, replayed: result.replayed, integrationVerified: false } };
  }
  async function destination(method, input) {
    const origin = canonicalOrigin(input?.origin);
    if (!keys(input, ["applicationId", "origin"]) || !id(input.applicationId, "app") || !origin) fail("invalid_request");
    const { result, receipt } = await call("destination.write", "/api/cli/setup/destinations", method,
      { applicationId: input.applicationId, origin });
    const value = result.destination;
    if (!record(value) || !id(value.id, "org") || value.origin !== origin || !date(value.createdAt)) fail("invalid_response");
    let challenge = null;
    if (value.status === "pending" && method === "POST") {
      if (value.verifiedAt !== null || value.challenge?.path !== "/.well-known/commish-verification.txt" ||
          typeof value.challenge.value !== "string" || !new RegExp(`^cm_verify_${value.id}\\.[A-Za-z0-9_-]{43}$`).test(value.challenge.value)) fail("invalid_response");
      challenge = { path: value.challenge.path, value: value.challenge.value };
    } else if (value.status !== "verified" || !date(value.verifiedAt) || value.challenge !== null) fail("invalid_response");
    return { ...receipt, destination: { id: value.id, origin, status: value.status, createdAt: value.createdAt,
      verifiedAt: value.verifiedAt, challenge } };
  }
  return {
    async stripeHandoff() {
      const { result, receipt } = await call("stripe.connect", "/api/cli/setup/stripe", "POST");
      const path = `/dashboard/workspace/${receipt.workspaceId}/settings?mode=${receipt.mode}`;
      if (result.path !== path || result.action !== "connect_stripe_in_browser") fail("invalid_response");
      return { ...receipt, path, action: "connect_stripe_in_browser" };
    },
    async readReadiness(input) {
      if (!record(input) || !keys(input, ["programId", "credentialId", ...(Object.hasOwn(input, "webhookId") ? ["webhookId"] : [])]) ||
          !id(input.programId, "prg") || !id(input.credentialId, "key") || input.webhookId !== undefined && !id(input.webhookId, "whe")) fail("invalid_request");
      const { result, receipt } = await call("readiness.read", "/api/cli/setup/readiness", "POST", { ...input });
      const p = result.program, stripe = result.stripeConnection, diagnostics = result.integrationDiagnostics, live = result.liveAccess;
      const statuses = ["draft", "active", "paused", "suspended", "archived"], gates = ["verified_origin", "stripe_connection",
        "eligible_products", "stable_customer_identity", "attributed_checkout", "provider_event_receipt"];
      const actions = ["verify_destination", "replace_revoked_credential", "enable_webhook", "configure_effective_terms", "activate_program",
        "review_program_status", "connect_stripe", "enable_live_access", "complete_attributed_test_conversion"];
      if (!record(p) || p.id !== input.programId || !id(p.applicationId, "app") || !statuses.includes(p.status) ||
          [p.activeTermVersion, p.availableTermVersion].some(v => v !== null && !integer(v, 1_000_000)) ||
          typeof result.destinationVerified !== "boolean" || typeof result.credentialActive !== "boolean" ||
          (input.webhookId === undefined ? result.webhookActive !== null : typeof result.webhookActive !== "boolean") ||
          !record(stripe) || stripe.mode !== receipt.mode || !["connected", "not_connected"].includes(stripe.status) ||
          !Array.isArray(result.actions) || new Set(result.actions).size !== result.actions.length || result.actions.some(a => !actions.includes(a))) fail("invalid_response");
      if (receipt.mode === "test" ? live !== null || !record(diagnostics) || diagnostics.programId !== p.id || diagnostics.mode !== "test" ||
          !["ready", "blocked"].includes(diagnostics.status) || !Array.isArray(diagnostics.unmetGates) || new Set(diagnostics.unmetGates).size !== diagnostics.unmetGates.length || diagnostics.unmetGates.some(g => !gates.includes(g)) ||
          diagnostics.status !== (diagnostics.unmetGates.length ? "blocked" : "ready") :
          diagnostics !== null || !record(live) || live.workspaceId !== receipt.workspaceId || !["enabled", "disabled"].includes(live.effectiveLiveAccess)) fail("invalid_response");
      // Select only fixed identifiers, flags and enumerations. Nested provider or
      // future server fields cannot enter a persisted receipt or terminal output.
      return { ...receipt, program: { id: p.id, applicationId: p.applicationId, status: p.status,
        activeTermVersion: p.activeTermVersion, availableTermVersion: p.availableTermVersion },
        destinationVerified: result.destinationVerified, credentialActive: result.credentialActive, webhookActive: result.webhookActive,
        stripeStatus: stripe.status, liveAccess: receipt.mode === "live" ? live.effectiveLiveAccess : null,
        testEvidence: receipt.mode === "test" ? { status: diagnostics.status, unmetGates: [...diagnostics.unmetGates] } : null,
        actions: [...result.actions] };
    },
    async createWebhook(input) {
      const expected = webhookInput(input);
      const { result, receipt } = await call("webhook.write", "/api/cli/setup/webhooks", "POST", expected);
      const value = result.endpoint;
      if (!record(value) || !id(value.id, "whe") || value.mode !== receipt.mode || value.url !== expected.url ||
          !same(value.eventTypes, expected.eventTypes) || value.disabledAt !== null || !date(value.createdAt)) fail("invalid_response");
      return { ...receipt, endpoint: { id: value.id, mode: value.mode, url: value.url, eventTypes: [...value.eventTypes], disabledAt: null, createdAt: value.createdAt } };
    },
    async downloadWebhookSecret(input, endpointId) {
      const expected = webhookInput(input), bound = context();
      if (!id(endpointId, "whe")) fail("invalid_request");
      if (!bound.workspaceId) fail("authorization_required");
      if (!bound.operations.includes("webhook.write")) fail("access_denied");
      // A private in-memory value for the file writer, never a JSON receipt.
      return request("POST", "/api/cli/setup/webhooks/secret", expected, endpointId);
    },
    async createCredential(input) {
      const mode = context().mode;
      if (!keys(input, ["applicationId", "label", "publishableKey", "secretHash", "idempotencyKey"]) ||
          !id(input.applicationId, "app") || !name(input.label) ||
          typeof input.publishableKey !== "string" || !new RegExp(`^cm_${mode}_pk_[A-Za-z0-9_-]{12,}$`).test(input.publishableKey) ||
          typeof input.secretHash !== "string" || !/^[a-f0-9]{64}$/.test(input.secretHash) || !text(input.idempotencyKey, 255, 1)) fail("invalid_request");
      const expected = { ...input };
      const { result, receipt } = await call("credential.write", "/api/cli/setup/credentials", "POST", expected);
      const value = result.apiKey;
      if (!record(value) || !id(value.id, "key") || value.applicationId !== expected.applicationId || value.mode !== mode ||
          value.publishableKey !== expected.publishableKey || value.label !== expected.label || value.revokedAt !== null ||
          value.lastUsedAt !== null && !date(value.lastUsedAt) || !date(value.createdAt)) fail("invalid_response");
      return { ...receipt, apiKey: { id: value.id, applicationId: value.applicationId, mode: value.mode,
        publishableKey: value.publishableKey, label: value.label, revokedAt: null, lastUsedAt: value.lastUsedAt, createdAt: value.createdAt } };
    },
    async createApplication(input) {
      if (!keys(input, ["name"]) || !name(input.name)) fail("invalid_request");
      const expectedName = input.name;
      const { result, receipt } = await call("application.write", "/api/cli/setup/applications", "POST", { name: expectedName });
      const value = result.application;
      if (!record(value) || !id(value.id, "app") || value.name !== expectedName || !date(value.createdAt) ||
          !Array.isArray(value.verifiedOrigins) || value.verifiedOrigins.some(origin => !canonicalOrigin(origin) || canonicalOrigin(origin) !== origin)) fail("invalid_response");
      return { ...receipt, application: { id: value.id, name: value.name, createdAt: value.createdAt, verifiedOrigins: [...value.verifiedOrigins] } };
    },
    async createProgram(input) {
      validateSetupProgram(input);
      const expected = structuredClone(input);
      expected.eligibleStripeProductIds = [...new Set(expected.eligibleStripeProductIds)].sort();
      const { result, receipt } = await call("program.write", "/api/cli/setup/programs", "POST", expected);
      const value = result.program;
      if (!record(value) || !id(value.id, "prg") || value.mode !== receipt.mode || value.status !== "draft" ||
          !same(expected, selected(value, programFields)) || !date(value.createdAt) || !date(value.updatedAt) ||
          value.activeTermVersion !== null && !integer(value.activeTermVersion, 1_000_000)) fail("invalid_response");
      return { ...receipt, program: { id: value.id, ...expected, mode: value.mode, status: value.status,
        activeTermVersion: value.activeTermVersion, createdAt: value.createdAt, updatedAt: value.updatedAt } };
    },
    async createTerms(input) {
      validateSetupTerms(input);
      const expected = structuredClone(input);
      expected.prohibitedClaims = [...new Set(expected.prohibitedClaims)].sort();
      const { result, receipt } = await call("terms.write", "/api/cli/setup/terms", "POST", expected);
      const value = result.term;
      // CLI progress retains millisecond ISO input. SQL may project the same
      // instant with three trailing zero microseconds; do not truncate others.
      const projected = record(value) ? selected(value, termFields) : null;
      if (projected && typeof projected.effectiveAt === "string") projected.effectiveAt = projected.effectiveAt.replace(/(\.\d{3})000Z$/, "$1Z");
      if (!projected || !same(expected, projected) || !date(value.createdAt)) fail("invalid_response");
      return { ...receipt, term: { ...expected, createdAt: value.createdAt } };
    },
    registerDestination: (input) => destination("POST", input),
    verifyDestination: (input) => destination("PUT", input),
  };
}
