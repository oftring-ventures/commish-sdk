import { createHash, randomBytes } from "node:crypto";
import { argumentsFor, errorReceipt, fail } from "./cli-http.mjs";
import { managementClient } from "./management-client.mjs";
import { readSetupFile, writeSetupFile } from "./setup-files.mjs";
import { protectPrivateState } from "./setup-progress.mjs";

export const keysHelp = () => ({ version: 1, status: "help", commands: ["keys create", "keys rotate"],
  flags: ["--auth-file <path>", "--mode test|live", "--management-url <url>", "--application <id>", "--workspace-scope", "--key <id>", "--label <label>", "--idempotency-key <identity>", "--json", "--non-interactive"],
  requiredScopes: { create: ["credentials.write"], rotate: ["credentials.read", "credentials.write"] },
  storage: "Locally generated material is saved privately before issuance, retained across uncertain results, and never printed.",
  retry: "Repeat exactly the same choices and idempotency identity; the CLI reuses the saved key material.",
  revocation: "manage credentials.revoke --body-file <json>" });
const digest = value => createHash("sha256").update(value).digest("hex");
export async function executeKeys(args, options = {}) {
  const root = options.root ?? process.cwd();
  const { values: v, positionals: p } = argumentsFor(args,
    ["auth-file", "mode", "management-url", "application", "key", "label", "idempotency-key"], ["help", "json", "workspace-scope", "non-interactive"]);
  if (v.help || !p.length) return keysHelp();
  if (p.length !== 1 || !["create", "rotate"].includes(p[0]) || Boolean(v.application) === Boolean(v["workspace-scope"]) ||
    v.application && !/^app_[A-Za-z0-9_-]{12,}$/.test(v.application) || !v.label?.trim() || v.label.length > 100 ||
    !/^[\x21-\x7e]{1,255}$/.test(v["idempotency-key"] ?? "") ||
    (p[0] === "rotate" ? !/^key_[A-Za-z0-9_-]{12,}$/.test(v.key ?? "") : v.key !== undefined)) fail("invalid_arguments");
  const client = managementClient({ ...options, authFile: v["auth-file"], mode: v.mode, url: v["management-url"] });
  const grant = await client.status(), applicationId = v.application ?? null;
  if (grant.status !== "authorized" || !grant.scopes.includes("credentials.write") || grant.applicationId !== null && grant.applicationId !== applicationId) fail("scope_denied");
  if (p[0] === "rotate") {
    if (!grant.scopes.includes("credentials.read")) fail("scope_denied");
    let cursor, match; const seen = new Set();
    for (let page = 0; page < 100 && !match; page++) {
      const { data } = await client.call("credentials.list", { limit: 100, ...(applicationId ? { applicationId } : {}), ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data?.items) || data.items.length > 100) fail("invalid_response");
      match = data.items.find(item => item.id === v.key);
      if (match || data.nextCursor === null) break;
      if (typeof data.nextCursor !== "string" || seen.has(data.nextCursor)) fail("invalid_response");
      seen.add(data.nextCursor); cursor = data.nextCursor;
    }
    // A revoked original can be the result of our uncertain prior rotation.
    if (!match || match.applicationId !== applicationId || match.mode !== client.mode) fail("credential_context_mismatch");
  }
  const intent = { operation: `credentials.${p[0]}`, apiUrl: client.baseUrl, workspaceId: grant.workspaceId,
    applicationId, mode: client.mode, keyId: v.key ?? null, label: v.label.trim(), idempotencyKey: v["idempotency-key"] };
  const directory = `.commish/credentials/${digest(JSON.stringify([intent.apiUrl, intent.workspaceId, intent.mode, intent.operation, intent.idempotencyKey]))}`;
  const path = `${directory}/intent.json`;
  protectPrivateState(root);
  let saved;
  try { saved = JSON.parse(readSetupFile(root, path, { privateFile: true })); }
  catch (error) { if (error.message !== "setup_file_missing") throw error; }
  if (!saved) {
    const proposed = { version: 1, intent, secret: `cm_${client.mode}_sk_${randomBytes(32).toString("base64url")}`,
      publishable: applicationId ? `cm_${client.mode}_pk_${randomBytes(24).toString("base64url")}` : null };
    try { writeSetupFile(root, path, JSON.stringify(proposed) + "\n", { privateFile: true }); }
    catch (error) { if (error.message !== "setup_file_conflict") throw error; }
    saved = JSON.parse(readSetupFile(root, path, { privateFile: true }));
  }
  if (saved.version !== 1 || JSON.stringify(saved.intent) !== JSON.stringify(intent) ||
    typeof saved.secret !== "string" || !new RegExp(`^cm_${client.mode}_sk_[A-Za-z0-9_-]{43}$`).test(saved.secret) ||
    (applicationId ? !new RegExp(`^cm_${client.mode}_pk_[A-Za-z0-9_-]{32}$`).test(saved.publishable) : saved.publishable !== null)) fail("credential_intent_conflict");
  const credentialFile = `${directory}/credentials.env`;
  writeSetupFile(root, credentialFile, `COMMISH_MODE=${client.mode}\n` + (applicationId ? `COMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PUBLISHABLE_KEY=${saved.publishable}\n` : "") +
    `COMMISH_SECRET_KEY=${saved.secret}\n`, { privateFile: true });
  const receipt = await client.call(intent.operation, { ...(v.key ? { keyId: v.key } : { applicationId }),
    label: intent.label, publishableKey: saved.publishable, secretHash: digest(saved.secret), idempotencyKey: intent.idempotencyKey });
  const key = receipt.data?.apiKey;
  if (!key || !/^key_[A-Za-z0-9_-]{12,}$/.test(key.id) || key.mode !== client.mode || key.applicationId !== applicationId ||
    key.publishableKey !== saved.publishable || key.revokedAt !== null || v.key && receipt.data.replacedKeyId !== v.key) fail("invalid_response");
  return { ...receipt, credentialFile };
}
export async function runKeysCommand(args, { out = console.log, diagnostic = console.error, ...options } = {}) {
  try { out(JSON.stringify(await executeKeys(args, options))); return 0; }
  catch (error) { diagnostic(JSON.stringify(errorReceipt(error))); return 1; }
}
