import { createHash, randomBytes } from "node:crypto";
import { readSetupFile, writeSetupFile } from "./setup-files.mjs";

const fail = code => { throw new Error(code); };
const id = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{12,}$`).test(value);
function directory(progress, mode) {
  if (!["test", "live"].includes(mode) || progress.directory !== `.commish/setup/${mode}`) fail("invalid_setup_step");
  return progress.directory;
}
function read(root, path) {
  try { return readSetupFile(root, path, { privateFile: true }); }
  catch (error) { if (error.message === "setup_file_missing") return null; throw error; }
}
// Persist newly generated credentials before the first request. An uncertain
// response or interrupted run must retry the same key material and intent.
export async function provisionSetupCredential(root, progress, session, { mode, applicationId, programId }) {
  const path = `${directory(progress, mode)}/credentials.env`;
  if (!id(applicationId, "app") || !id(programId, "prg")) fail("invalid_setup_step");
  let body = read(root, path);
  if (body === null) {
    if (progress.read("credential")) fail("setup_credential_missing");
    const proposed = `COMMISH_MODE=${mode}\nCOMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PROGRAM_ID=${programId}\n` +
      `COMMISH_PUBLISHABLE_KEY=cm_${mode}_pk_${randomBytes(24).toString("base64url")}\n` +
      `COMMISH_SECRET_KEY=cm_${mode}_sk_${randomBytes(32).toString("base64url")}\n`;
    try { writeSetupFile(root, path, proposed, { privateFile: true }); }
    catch (error) { if (error.message !== "setup_file_conflict") throw error; }
    body = read(root, path);
  }
  const values = /^COMMISH_MODE=(test|live)\nCOMMISH_APPLICATION_ID=(app_[A-Za-z0-9_-]{12,})\nCOMMISH_PROGRAM_ID=(prg_[A-Za-z0-9_-]{12,})\nCOMMISH_PUBLISHABLE_KEY=(cm_(?:test|live)_pk_[A-Za-z0-9_-]{32})\nCOMMISH_SECRET_KEY=(cm_(?:test|live)_sk_[A-Za-z0-9_-]{43})\n$/.exec(body ?? "");
  if (!values || values[1] !== mode || values[2] !== applicationId || values[3] !== programId ||
      !values[4].startsWith(`cm_${mode}_pk_`) || !values[5].startsWith(`cm_${mode}_sk_`)) fail("setup_credential_conflict");
  const receipt = await session.createCredential({ applicationId, label: "Commish CLI", publishableKey: values[4],
    secretHash: createHash("sha256").update(values[5]).digest("hex"), idempotencyKey: progress.idempotencyKey("credential") });
  if (!id(receipt?.apiKey?.id, "key") || receipt.mode !== mode || receipt.apiKey.applicationId !== applicationId ||
      receipt.apiKey.publishableKey !== values[4] || receipt.apiKey.revokedAt !== null) fail("invalid_response");
  progress.save("credential", { id: receipt.apiKey.id });
  return { path, credentialId: receipt.apiKey.id, applicationId, programId, mode };
}
// Signing material uses its separate binary transport and private file. Neither
// function returns secret values or rewrites an application's customized env.
export async function persistSetupWebhookSecret(root, progress, session, { mode, endpointId, input }) {
  const path = `${directory(progress, mode)}/webhook.env`;
  if (!id(endpointId, "whe")) fail("invalid_setup_step");
  const secret = await session.downloadWebhookSecret(input, endpointId);
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9_-]{32,}$/.test(secret) || secret.length > 512) fail("invalid_response");
  writeSetupFile(root, path, `COMMISH_WEBHOOK_SIGNING_SECRET=${secret}\n`, { privateFile: true });
  return { path, endpointId, mode };
}
