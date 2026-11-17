import { createHash, randomBytes } from "node:crypto";
import { readSetupFile, writeSetupFile } from "./setup-files.mjs";

const fail = (code) => {
  throw new Error(code);
};
const id = (value, prefix) =>
  typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{12,}$`).test(value);
function directory(progress, mode) {
  if (!["test", "live"].includes(mode) || progress.directory !== `.commish/setup/${mode}`)
    fail("invalid_setup_step");
  return progress.directory;
}
// The API address as the credential file carries it. The host is a name or a
// bracketed IPv6 address, which is what the loopback `http://[::1]` needs.
const apiUrlPattern = "https?://(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?/api/v1";
// The versioned API of the Commish deployment setup ran against.
function apiUrl(appUrl) {
  let url;
  try {
    url = new URL("/api/v1", appUrl).href;
  } catch {
    fail("invalid_setup_step");
  }
  if (!new RegExp(`^${apiUrlPattern}$`).test(url)) fail("invalid_setup_step");
  return url;
}
function read(root, path) {
  try {
    return readSetupFile(root, path, { privateFile: true });
  } catch (error) {
    if (error.message === "setup_file_missing") return null;
    throw error;
  }
}
// The credential file setup writes, field by field. Returns its values only
// when it is that file for this mode and, where given, these resources.
// The last three lines repeat the public values under the names the Next.js
// adapter reads, and name the API it calls, so the file satisfies
// `commish-next`'s required environment as it is. A file written before they
// were added has the first five lines only and is still that file.
const credentialLayout = new RegExp(
  "^COMMISH_MODE=(test|live)\\n" +
    "COMMISH_APPLICATION_ID=(app_[A-Za-z0-9_-]{12,})\\n" +
    "COMMISH_PROGRAM_ID=(prg_[A-Za-z0-9_-]{12,})\\n" +
    "COMMISH_PUBLISHABLE_KEY=(cm_(?:test|live)_pk_[A-Za-z0-9_-]{32})\\n" +
    "COMMISH_SECRET_KEY=(cm_(?:test|live)_sk_[A-Za-z0-9_-]{43})\\n" +
    "(?:NEXT_PUBLIC_COMMISH_APPLICATION_ID=\\2\\n" +
    "NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY=\\4\\n" +
    `COMMISH_API_URL=(${apiUrlPattern})\\n)?$`,
);
function credentialValues(body, { mode, applicationId, programId }) {
  const values = credentialLayout.exec(body ?? "");
  return values &&
    values[1] === mode &&
    (applicationId == null || values[2] === applicationId) &&
    (programId == null || values[3] === programId) &&
    values[4].startsWith(`cm_${mode}_pk_`) &&
    values[5].startsWith(`cm_${mode}_sk_`)
    ? values
    : null;
}
// The same check as a yes or no, for a caller that must not hold key material.
export const setupCredentialMatches = (body, expected) => credentialValues(body, expected) !== null;
// Persist newly generated credentials before the first request. An uncertain
// response or interrupted run must retry the same key material and intent.
export async function provisionSetupCredential(
  root,
  progress,
  session,
  { mode, applicationId, programId, appUrl = "https://app.commish.sh" },
) {
  const path = `${directory(progress, mode)}/credentials.env`;
  if (!id(applicationId, "app") || !id(programId, "prg")) fail("invalid_setup_step");
  let body = read(root, path);
  if (body === null) {
    if (progress.read("credential")) fail("setup_credential_missing");
    const publishable = `cm_${mode}_pk_${randomBytes(24).toString("base64url")}`;
    const proposed =
      `COMMISH_MODE=${mode}\nCOMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PROGRAM_ID=${programId}\n` +
      `COMMISH_PUBLISHABLE_KEY=${publishable}\n` +
      `COMMISH_SECRET_KEY=cm_${mode}_sk_${randomBytes(32).toString("base64url")}\n` +
      `NEXT_PUBLIC_COMMISH_APPLICATION_ID=${applicationId}\n` +
      `NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY=${publishable}\n` +
      `COMMISH_API_URL=${apiUrl(appUrl)}\n`;
    try {
      writeSetupFile(root, path, proposed, { privateFile: true });
    } catch (error) {
      if (error.message !== "setup_file_conflict") throw error;
    }
    body = read(root, path);
  }
  const values = credentialValues(body, { mode, applicationId, programId });
  if (!values) fail("setup_credential_conflict");
  const receipt = await session.createCredential({
    applicationId,
    label: "Commish CLI",
    publishableKey: values[4],
    secretHash: createHash("sha256").update(values[5]).digest("hex"),
    idempotencyKey: progress.idempotencyKey("credential"),
  });
  if (
    !id(receipt?.apiKey?.id, "key") ||
    receipt.mode !== mode ||
    receipt.apiKey.applicationId !== applicationId ||
    receipt.apiKey.publishableKey !== values[4] ||
    receipt.apiKey.revokedAt !== null
  )
    fail("invalid_response");
  progress.save("credential", { id: receipt.apiKey.id });
  return { path, credentialId: receipt.apiKey.id, applicationId, programId, mode };
}
// Signing material uses its separate binary transport and private file. Neither
// function returns secret values or rewrites an application's customized env.
export async function persistSetupWebhookSecret(
  root,
  progress,
  session,
  { mode, endpointId, input },
) {
  const path = `${directory(progress, mode)}/webhook.env`;
  if (!id(endpointId, "whe")) fail("invalid_setup_step");
  const secret = await session.downloadWebhookSecret(input, endpointId);
  if (
    typeof secret !== "string" ||
    !/^whsec_[A-Za-z0-9_-]{32,}$/.test(secret) ||
    secret.length > 512
  )
    fail("invalid_response");
  writeSetupFile(root, path, `COMMISH_WEBHOOK_SIGNING_SECRET=${secret}\n`, { privateFile: true });
  return { path, endpointId, mode };
}
