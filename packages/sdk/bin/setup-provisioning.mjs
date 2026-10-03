import { parseSetupConfig } from "./setup-config.mjs";
import { writeSetupFile } from "./setup-files.mjs";
import { provisionSetupCredential, persistSetupWebhookSecret } from "./setup-secrets.mjs";

// Resume from immutable resource identities; each server command rechecks the
// current grant. Replays never replace customized resources or local files.
export async function provisionSetup(root, input, progress, session, authorization) {
  const parsed = parseSetupConfig(input);
  if (parsed.kind !== "ready") throw new Error("invalid_setup_config");
  const config = parsed.config;
  if (authorization?.status !== "authorized" || authorization.mode !== config.mode ||
      !/^wrk_[A-Za-z0-9_-]{12,}$/.test(authorization.workspaceId ?? "") ||
      config.workspace?.kind === "existing" && config.workspace.id !== authorization.workspaceId) throw new Error("authorization_required");
  progress.save("workspace", { id: authorization.workspaceId });
  let application = progress.read("application");
  if (!application) {
    const receipt = await session.createApplication(config.application);
    application = { id: receipt.application.id }; progress.save("application", application);
  }
  const destinationInput = { applicationId: application.id, origin: config.destination.origin };
  const registered = await session.registerDestination(destinationInput);
  let proof = null;
  if (registered.destination.status === "pending") {
    writeSetupFile(root, config.destination.proofFile, `${registered.destination.challenge.value}\n`);
    try { await session.verifyDestination(destinationInput); }
    catch (error) {
      if (!["challenge_mismatch", "verification_unavailable", "origin_not_public"].includes(error?.message)) throw error;
      proof = { path: config.destination.proofFile, url: `${config.destination.origin}/.well-known/commish-verification.txt`, code: error.message };
    }
  }
  let program = progress.read("program");
  if (!program) {
    const receipt = await session.createProgram({ ...config.program, applicationId: application.id });
    program = { id: receipt.program.id }; progress.save("program", program);
  } else {
    const current = await session.readReadiness({ programId: program.id,
      credentialId: progress.read("credential")?.id ?? "key_cli_setup_unissued" });
    if (current.program.applicationId !== application.id) throw new Error("setup_config_conflict");
  }
  const terms = await session.createTerms({ ...config.terms, programId: program.id });
  const credentials = await provisionSetupCredential(root, progress, session, {
    mode: config.mode, applicationId: application.id, programId: program.id,
  });
  let webhook = null;
  if (config.webhook) {
    const input = { ...config.webhook, idempotencyKey: progress.idempotencyKey("webhook") };
    const receipt = await session.createWebhook(input);
    progress.save("webhook", { id: receipt.endpoint.id });
    webhook = await persistSetupWebhookSecret(root, progress, session, { mode: config.mode, endpointId: receipt.endpoint.id, input });
  }
  const readinessInput = { programId: program.id, credentialId: credentials.credentialId,
    ...(webhook ? { webhookId: webhook.endpointId } : {}) };
  const readiness = await session.readReadiness(readinessInput);
  if (readiness.program.applicationId !== application.id) throw new Error("setup_config_conflict");
  return { status: "configured", mode: config.mode, workspaceId: authorization.workspaceId, applicationId: application.id,
    programId: program.id, termVersion: terms.term.version, effectiveAt: terms.term.effectiveAt,
    credentialsFile: credentials.path, webhookFile: webhook?.path ?? null, proof,
    readiness, readinessInput, integrationVerified: false };
}
