import { randomBytes } from "node:crypto";
import {
  managementCatalog,
  managementClient,
  managementUrl,
  tokenHash,
} from "./management-client.mjs";
import { writeSetupFile } from "./setup-files.mjs";

const limits = managementCatalog.authorization.onboarding;
// The work that outlasts the setup session's ten minutes: verify the
// destination once its proof is deployed, add terms, activate the reviewed
// Test offer and read evidence. Credentials and webhooks stay with setup.
export const setupOnboardingScopes = [
  "resources.read",
  "diagnostics.read",
  "programs.read",
  "programs.write",
  "terms.read",
  "terms.write",
  "destinations.read",
  "destinations.write",
  "credentials.read",
];

// Setup asks for onboarding access in the same approval. The bearer stays in
// memory until that approval binds it to a workspace; only its hash is sent.
export function proposeSetupOnboarding({ random = randomBytes } = {}) {
  const token = `cm_mgmt_test_${random(32).toString("base64url")}`;
  return {
    token,
    request: {
      challengeHash: tokenHash(token),
      scopes: [...setupOnboardingScopes],
      expiresIn: limits.maximumSeconds,
    },
  };
}

// Stores the approved grant where auth, manage and doctor read it, then
// confirms it with its own bearer. A grant that cannot be confirmed is
// reported, never assumed: the commands that use the file fail closed.
export async function storeSetupOnboarding(
  root,
  proposal,
  { workspaceId, appUrl, fetcher = fetch, signal } = {},
) {
  const hash = proposal.request.challengeHash,
    path = `.commish/management/${hash.slice(0, 24)}/authorization.json`,
    baseUrl = managementUrl(new URL("/api/management/v1", appUrl).href, {});
  const state = {
    version: 1,
    baseUrl,
    token: proposal.token,
    proposal: {
      challengeHash: hash,
      workspaceId,
      applicationId: null,
      mode: "test",
      kind: "onboarding",
      scopes: proposal.request.scopes,
      expiresIn: proposal.request.expiresIn,
    },
  };
  const receipt = { authorizationFile: path, scopes: [...proposal.request.scopes] };
  try {
    writeSetupFile(root, path, JSON.stringify(state) + "\n", { privateFile: true });
  } catch (error) {
    // Onboarding is optional. Unstored, the bearer ends with this process, so
    // nothing can use the approved grant; setup continues without it.
    return {
      ...receipt,
      authorizationFile: null,
      status: "unavailable",
      expiresAt: null,
      code: failureCode(error),
    };
  }
  try {
    const grant = await managementClient({
      root,
      env: {},
      mode: "test",
      authFile: path,
      fetcher,
      signal,
    }).status();
    return { ...receipt, status: grant.status, expiresAt: grant.expiresAt };
  } catch (error) {
    const unconfirmed = {
      ...receipt,
      status: "unconfirmed",
      expiresAt: null,
      code: failureCode(error),
    };
    if (signal?.aborted)
      throw Object.assign(new Error("setup_interrupted"), { onboarding: unconfirmed });
    return unconfirmed;
  }
}
const failureCode = (error) =>
  /^[a-z_]{1,64}$/.test(error?.message ?? "") ? error.message : "service_unavailable";
