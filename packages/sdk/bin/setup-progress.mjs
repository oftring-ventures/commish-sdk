import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseSetupConfig } from "./setup-config.mjs";
import { readSetupFile, writeSetupFile } from "./setup-files.mjs";

const fail = code => { throw new Error(code); };
const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, expected) => record(v) && Object.keys(v).sort().join() === [...expected].sort().join();
const date = v => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const uuid = v => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const id = (v, prefix) => typeof v === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{12,}$`).test(v);
const canonical = v => JSON.stringify(v, (_, value) => record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
function read(root, path, validate) {
  let raw;
  try { raw = readSetupFile(root, path, { privateFile: true }); }
  catch (error) { if (error.message === "setup_file_missing") return null; throw error; }
  let value;
  try { value = JSON.parse(raw); } catch { fail("invalid_setup_progress"); }
  if (!validate(value)) fail("invalid_setup_progress");
  return value;
}
export function protectPrivateState(root) {
  const git = args => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 65536,
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, LC_ALL: "C" }, windowsHide: true });
  const check = git(["rev-parse", "--is-inside-work-tree"]);
  const repository = check.status === 0 && check.stdout.trim() === "true";
  if (!repository && !(check.status === 128 && check.stderr.includes("not a git repository"))) fail("setup_git_unavailable");
  if (repository) {
    const tracked = git(["--literal-pathspecs", "ls-files", "--cached", "-z", "--", ".commish"]);
    if (tracked.status !== 0) fail("setup_git_unavailable");
    if (tracked.stdout) fail("setup_state_tracked");
  }
  writeSetupFile(root, ".commish/.gitignore", "*\n");
  if (repository && git(["check-ignore", "--no-index", "--quiet", ".commish/setup/test/intent.json"]).status !== 0)
    fail("setup_state_not_ignored");
}
const schemas = {
  credential: v => keys(v, ["id"]) && id(v.id, "key"),
  workspace: v => keys(v, ["id"]) && id(v.id, "wrk"),
  application: v => keys(v, ["id"]) && id(v.id, "app"),
  program: v => keys(v, ["id"]) && id(v.id, "prg"),
  webhook: v => keys(v, ["id"]) && id(v.id, "whe"),
};
// This journal contains identities only. A new browser grant is required on
// every run; neither session authority nor API/signing keys are stored here.
export function openSetupProgress(root, input, { now = () => new Date(), appUrl = "https://app.commish.sh" } = {}) {
  let endpoint;
  try { endpoint = new URL(appUrl); } catch { fail("invalid_app_url"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
      !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname))) fail("invalid_app_url");
  const parsed = parseSetupConfig(input);
  if (parsed.kind !== "ready") fail("invalid_setup_config");
  const config = parsed.config, fingerprint = createHash("sha256").update(canonical({ config, appOrigin: endpoint.origin })).digest("hex");
  protectPrivateState(root);
  const directory = `.commish/setup/${config.mode}`, path = `${directory}/intent.json`;
  const valid = v => keys(v, ["version", "fingerprint", "id", "createdAt"]) && v.version === 1 &&
    /^[0-9a-f]{64}$/.test(v.fingerprint) && uuid(v.id) && date(v.createdAt);
  let intent = read(root, path, valid);
  if (!intent) {
    const proposed = { version: 1, fingerprint, id: randomUUID(), createdAt: now().toISOString() };
    try { writeSetupFile(root, path, canonical(proposed) + "\n", { privateFile: true }); }
    catch (error) { if (error.message !== "setup_file_conflict") throw error; }
    intent = read(root, path, valid);
  }
  if (!intent || intent.fingerprint !== fingerprint) fail("setup_config_conflict");
  return {
    directory,
    idempotencyKey: name => {
      if (!["credential", "webhook"].includes(name)) fail("invalid_setup_step");
      return `commish-cli:${intent.id}:${name}`;
    },
    read(name) {
      if (!Object.hasOwn(schemas, name)) fail("invalid_setup_step");
      return read(root, `${directory}/${name}.json`, schemas[name]);
    },
    save(name, value) {
      if (!Object.hasOwn(schemas, name) || !schemas[name](value)) fail("invalid_setup_step");
      return writeSetupFile(root, `${directory}/${name}.json`, canonical(value) + "\n", { privateFile: true });
    },
  };
}
