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
    async createApplication(input) {
      if (!keys(input, ["name"]) || !name(input.name)) fail("invalid_request");
      const expectedName = input.name;
      const { result, receipt } = await call("application.write", "/api/cli/setup/applications", "POST", { name: expectedName });
      const value = result.application;
      if (!record(value) || !id(value.id, "app") || value.name !== expectedName || !date(value.createdAt) ||
          !Array.isArray(value.verifiedOrigins) || value.verifiedOrigins.some(origin => !canonicalOrigin(origin) || canonicalOrigin(origin) !== origin)) fail("invalid_response");
      return { ...receipt, application: { id: value.id, name: value.name, createdAt: value.createdAt, verifiedOrigins: [...value.verifiedOrigins] } };
    },
    registerDestination: (input) => destination("POST", input),
    verifyDestination: (input) => destination("PUT", input),
  };
}
