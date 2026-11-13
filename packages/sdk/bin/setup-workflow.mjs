import { setTimeout as delay } from "node:timers/promises";
import { authorizeSetup, openSetupBrowser } from "./setup-authorization.mjs";
import { setupIntent } from "./setup-intent.mjs";
import { proposeSetupOnboarding, storeSetupOnboarding } from "./setup-onboarding.mjs";
import { openSetupProgress } from "./setup-progress.mjs";
import { provisionSetup } from "./setup-provisioning.mjs";

const retryable = [
  "service_unavailable",
  "verification_unavailable",
  "challenge_mismatch",
  "origin_not_public",
  "rate_limited",
];
const reauthorize = [
  "setup_expired",
  "recent_auth_required",
  "mfa_required",
  "authorization_required",
];
export async function runSetup(
  root,
  config,
  options,
  {
    authorize = authorizeSetup,
    progress = openSetupProgress,
    provision = provisionSetup,
    onboarding: grants = { propose: proposeSetupOnboarding, store: storeSetupOnboarding },
    openBrowser = openSetupBrowser,
    notify = () => {},
    now = Date.now,
    signal,
    sleep = (ms) => delay(ms, undefined, { signal }),
  } = {},
) {
  const journal = progress(root, config, { appUrl: options.appUrl });
  const savedWorkspace = journal.read("workspace");
  const operations = [
    "workspace.read",
    "application.write",
    "destination.write",
    "program.write",
    "terms.write",
    "credential.write",
    "readiness.read",
    ...(config.webhook ? ["webhook.write"] : []),
    ...(config.stripe === "connect" ? ["stripe.connect"] : []),
  ];
  const request = {
      mode: config.mode,
      operations,
      setupIntent: setupIntent(config),
      workspaceRequest: savedWorkspace
        ? { kind: "existing", id: savedWorkspace.id }
        : config.workspace,
    },
    flags = { appUrl: options.appUrl, noOpen: options.noOpen, notify, signal, openBrowser };
  // Test setup asks for onboarding access in the same approval, so the work
  // that outlasts the ten-minute session needs no second one.
  let proposal = config.mode === "test" && options.onboarding !== false ? grants.propose() : null;
  let session,
    onboarding = null;
  try {
    let authorized;
    try {
      authorized = await authorize(
        proposal ? { ...request, onboarding: proposal.request } : request,
        flags,
      );
    } catch (error) {
      // A server without the single consent rejects the field: provision as
      // before. A request the server refuses for another reason fails again.
      if (!proposal || error?.message !== "invalid_request" || signal?.aborted) throw error;
      proposal = null;
      notify({ status: "onboarding_unavailable" });
      authorized = await authorize(request, flags);
    }
    session = authorized.session;
    if (signal?.aborted) throw new Error("setup_interrupted");
    onboarding =
      proposal && authorized.onboarding
        ? await grants.store(root, proposal, {
            workspaceId: authorized.receipt.workspaceId,
            appUrl: options.appUrl,
            signal,
          })
        : null;
    if (signal?.aborted) throw new Error("setup_interrupted");
    const { readinessInput, ...provisioned } = await provision(
      root,
      config,
      journal,
      session,
      authorized.receipt,
      { signal },
    );
    if (signal?.aborted) throw new Error("setup_interrupted");
    const result = { ...provisioned, onboarding };
    result.readinessCheckedAt = new Date(now()).toISOString();
    const needsStripe = () =>
      config.stripe === "connect" && result.readiness.stripeStatus !== "connected";
    let refreshPending = false;
    const pending = () => result.proof !== null || needsStripe() || refreshPending;
    if (result.proof) notify({ status: "publish_required", ...result.proof });
    if (needsStripe()) {
      const handoff = await session.stripeHandoff({ flow: "setup" }),
        url = new URL(handoff.path, options.appUrl).href;
      if (signal?.aborted) throw new Error("setup_interrupted");
      notify({
        status: "browser_action_required",
        action: "connect_stripe",
        url,
        mode: result.mode,
      });
      if (!options.noOpen && !(await openBrowser(url)))
        notify({ status: "browser_unavailable", url });
    }
    const deadline = Math.min(
      now() + options.waitSeconds * 1000,
      Date.parse(authorized.receipt.expiresAt) - 1000,
    );
    while (pending() && now() < deadline) {
      if (signal?.aborted) throw new Error("setup_interrupted");
      await sleep(Math.min(2000, deadline - now()));
      try {
        if (result.proof) {
          await session.verifyDestination({
            applicationId: result.applicationId,
            origin: config.destination.origin,
          });
          result.proof = null;
          refreshPending = true;
        }
        result.readiness = await session.readReadiness(readinessInput);
        if (result.readiness.program.applicationId !== result.applicationId)
          throw new Error("setup_config_conflict");
        result.readinessCheckedAt = new Date(now()).toISOString();
        refreshPending = false;
      } catch (error) {
        if (reauthorize.includes(error?.message)) {
          return {
            ...result,
            status: "action_required",
            code: "reauthorization_required",
            resume: "rerun_same_command",
          };
        }
        if (!retryable.includes(error?.message)) throw error;
        notify({ status: "waiting", code: error.message });
        if (error.message === "rate_limited")
          await sleep(Math.max(0, Math.min(60_000, deadline - now())));
      }
    }
    if (signal?.aborted) throw new Error("setup_interrupted");
    return {
      ...result,
      status: pending() ? "action_required" : "configured",
      resume: "rerun_same_command",
    };
  } catch (error) {
    const failure =
      signal?.aborted || error?.name === "AbortError" ? new Error("setup_interrupted") : error;
    // A stored grant outlives the failure; name it so it can be used or revoked.
    const stored = onboarding ?? error?.onboarding;
    if (stored && typeof failure === "object" && failure !== null) failure.onboarding = stored;
    throw failure;
  } finally {
    await session?.revoke().catch(() => {});
  }
}
