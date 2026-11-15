import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { tokenHash } from "../packages/sdk/bin/management-client.mjs";
import {
  executeStatus,
  runStatusCommand,
  statusHelp,
} from "../packages/sdk/bin/status-command.mjs";

const workspaceId = "wrk_123456789012",
  applicationId = "app_123456789012",
  programId = "prg_123456789012",
  api = "https://app.commish.sh/api/management/v1";
const scopes = ["diagnostics.read", "programs.write", "destinations.write"];
const config = {
  version: 1,
  application: { name: "Guestbook" },
  destination: {
    origin: "https://guestbook.example",
    proofFile: "public/.well-known/commish-verification.txt",
  },
  program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: [] },
  terms: {
    commission: { type: "percentage", basisPoints: 1500 },
    recurrence: { kind: "first_payment" },
    perSaleCap: null,
    disclosureText: "I earn a commission.",
  },
  participantConsent: "commish_hosted",
  webhook: null,
  stripe: "connect",
};
const noRequest = () => assert.fail("unexpected network request");
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "commish-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, path, body, mode = 0o600) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof body === "string" ? body : JSON.stringify(body), {
    mode,
  });
}
// The files a completed `commish setup` leaves behind.
function provisioned(root, { webhook = false } = {}) {
  write(root, "commish.setup.json", config, 0o644);
  const directory = ".commish/setup/test";
  write(root, `${directory}/intent.json`, {
    version: 1,
    fingerprint: "f".repeat(64),
    id: "97961974-684d-46b3-aebb-2ef22ee2cec0",
    createdAt: "2026-11-14T12:04:40.049Z",
  });
  for (const [name, id] of [
    ["workspace", workspaceId],
    ["application", applicationId],
    ["program", programId],
    ["credential", "key_123456789012"],
    ...(webhook ? [["webhook", "whe_123456789012"]] : []),
  ])
    write(root, `${directory}/${name}.json`, { id });
  write(
    root,
    `${directory}/credentials.env`,
    `COMMISH_MODE=test\nCOMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PROGRAM_ID=${programId}\n` +
      `COMMISH_PUBLISHABLE_KEY=cm_test_pk_${"p".repeat(32)}\nCOMMISH_SECRET_KEY=cm_test_sk_${"k".repeat(43)}\n`,
  );
}
const hook = {
  url: "https://guestbook.example/api/commish/webhook",
  eventTypes: ["conversion.created"],
};
function grantFile(root, letter, patch = {}) {
  const token = `cm_mgmt_${patch.mode ?? "test"}_${letter.repeat(43)}`,
    hash = tokenHash(token),
    path = `.commish/management/${hash.slice(0, 24)}/authorization.json`;
  const proposal = {
    challengeHash: hash,
    workspaceId,
    applicationId: null,
    mode: "test",
    kind: "onboarding",
    scopes,
    expiresIn: 86400,
    ...patch,
  };
  write(root, path, { version: 1, baseUrl: api, token, proposal });
  return { token, path, proposal };
}
const grantFor = ({ challengeHash, ...proposal }, status) => ({
  protocol: "commish-management-v1",
  requestId: challengeHash,
  id: `mgt_${challengeHash.slice(0, 24)}`,
  pairingCode: `${challengeHash.slice(0, 4)}-${challengeHash.slice(4, 8)}`.toUpperCase(),
  ...proposal,
  status,
  requestExpiresAt: "2099-01-01T00:00:00Z",
  expiresAt: status === "pending" ? null : "2099-01-01T01:00:00Z",
});
// A management API that knows each stored grant's state.
function server(grants, { fail } = {}) {
  const requests = [];
  const fetcher = async (url, init) => {
    const grant = grants.find(([file]) => init.headers.authorization === `Bearer ${file.token}`);
    requests.push(`${init.method} ${url.slice(api.length)}`);
    assert(grant, "unknown bearer");
    if (fail) return Response.json({ error: { code: fail } }, { status: 503 });
    assert.equal(url, `${api}/grants`);
    return Response.json({ data: grantFor(grant[0].proposal, grant[1]) });
  };
  return { fetcher, requests };
}
const byStep = (result) => Object.fromEntries(result.steps.map((item) => [item.step, item]));
const provision = (config = "commish.setup.json") => ({
  kind: "command",
  command: `commish setup --config ${config} --mode test --no-open --non-interactive --json`,
  humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
});

test("a repository that never ran setup is reported offline and left untouched", async (t) => {
  const root = directory(t);
  const result = await executeStatus(["--json"], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(result, {
    version: 1,
    status: "incomplete",
    mode: "test",
    workspaceId: null,
    applicationId: null,
    programId: null,
    steps: [
      {
        step: "configuration",
        status: "unmet",
        evidence: { source: "commish.setup.json", configuration: "missing" },
        next: { kind: "command", command: "commish setup --plan --json" },
      },
      {
        step: "setup_approved",
        status: "unmet",
        evidence: { source: ".commish/setup/test/workspace.json", workspaceId: null },
        next: provision(),
      },
      {
        step: "resources_provisioned",
        status: "unmet",
        evidence: {
          source: ".commish/setup/test",
          applicationId: null,
          programId: null,
          credentialId: null,
          credentialsFile: "absent",
        },
        next: provision(),
      },
      {
        step: "management_access",
        status: "unmet",
        evidence: { source: "none", status: "missing" },
        next: provision(),
      },
    ],
    nextStep: "configuration",
    next: { kind: "command", command: "commish setup --plan --json" },
    integrationVerified: false,
  });
  assert.deepEqual(
    result.steps.map((item) => item.step),
    statusHelp().steps,
  );
  // An incomplete configuration names its fields; a complete one asks for approval.
  write(root, "commish.setup.json", { version: 1, stripe: "later" }, 0o644);
  const partial = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.equal(partial.steps[0].evidence.configuration, "input_required");
  assert(partial.steps[0].evidence.fields.includes("terms"));
  write(root, "other.json", config, 0o644);
  const ready = await executeStatus(["--config", "other.json"], {
    root,
    env: {},
    fetcher: noRequest,
  });
  assert.equal(ready.steps[0].status, "met");
  assert.deepEqual([ready.nextStep, ready.next], ["setup_approved", provision("<config>")]);
  // The path given to --config is never repeated.
  assert(!JSON.stringify(ready).includes("other.json"));
  assert.deepEqual(readdirSync(root).sort(), ["commish.setup.json", "other.json"]);
});

test("recorded setup progress is reported step by step without revealing key material", async (t) => {
  const root = directory(t);
  write(root, "commish.setup.json", config, 0o644);
  write(root, ".commish/setup/test/workspace.json", { id: workspaceId });
  const approved = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    approved.steps.map((item) => item.status),
    ["met", "met", "unmet", "unmet"],
  );
  assert.deepEqual([approved.nextStep, approved.next], ["resources_provisioned", provision()]);
  provisioned(root);
  const before = readdirSync(root, { recursive: true }).sort();
  const done = await executeStatus(["--json", "--non-interactive"], {
    root,
    env: { COMMISH_MODE: "test" },
    fetcher: noRequest,
  });
  assert.deepEqual(
    [done.workspaceId, done.applicationId, done.programId, done.nextStep],
    [workspaceId, applicationId, programId, "management_access"],
  );
  assert.deepEqual(
    done.steps.map((item) => item.status),
    ["met", "met", "met", "unmet"],
  );
  assert.deepEqual(byStep(done).configuration.evidence, {
    source: "commish.setup.json",
    configuration: "ready",
    setupStartedAt: "2026-11-14T12:04:40.049Z",
  });
  assert.deepEqual(byStep(done).resources_provisioned.evidence, {
    source: ".commish/setup/test",
    applicationId,
    programId,
    credentialId: "key_123456789012",
    credentialsFile: "present",
  });
  for (const secret of ["k".repeat(43), "p".repeat(32)])
    assert(!JSON.stringify(done).includes(secret));
  // Progress is kept per mode: LIVE has recorded nothing here.
  const live = await executeStatus(["--mode", "live"], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    live.steps.map((item) => item.status),
    ["met", "unmet", "unmet", "unmet"],
  );
  assert.match(live.next.command, / --mode live /);
  // A setup started from flags has no configuration file but did have its choices.
  rmSync(join(root, "commish.setup.json"));
  const flags = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    [flags.steps[0].status, flags.steps[0].evidence.configuration, flags.nextStep],
    ["met", "missing", "management_access"],
  );
  // A configured webhook needs its endpoint and signing secret file too.
  write(root, "commish.setup.json", { ...config, webhook: hook }, 0o644);
  const hooked = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    [byStep(hooked).resources_provisioned.status, byStep(hooked).resources_provisioned.evidence],
    [
      "unmet",
      {
        source: ".commish/setup/test",
        applicationId,
        programId,
        credentialId: "key_123456789012",
        webhookId: null,
        credentialsFile: "present",
        webhookFile: "absent",
      },
    ],
  );
  write(root, ".commish/setup/test/webhook.json", { id: "whe_123456789012" });
  write(
    root,
    ".commish/setup/test/webhook.env",
    `COMMISH_WEBHOOK_SIGNING_SECRET=whsec_${"w".repeat(32)}\n`,
  );
  const delivered = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.equal(byStep(delivered).resources_provisioned.status, "met");
  assert(!JSON.stringify(delivered).includes("w".repeat(32)));
  rmSync(join(root, ".commish/setup/test/webhook.json"));
  rmSync(join(root, ".commish/setup/test/webhook.env"));
  write(root, "commish.setup.json", config, 0o644);
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
});

test("text is the default output, --json one object, and errors are sanitized", async (t) => {
  const root = directory(t);
  let fetcher = noRequest;
  const run = async (args) => {
    const output = [],
      errors = [];
    const code = await runStatusCommand(args, {
      root,
      env: {},
      fetcher,
      out: (value) => output.push(value),
      diagnostic: (value) => errors.push(value),
    });
    return { code, output, errors };
  };
  assert.deepEqual(await run([]), {
    code: 2,
    output: [
      "Commish status (TEST): incomplete.\n" +
        "  unmet          configuration\n" +
        "  unmet          setup_approved\n" +
        "  unmet          resources_provisioned\n" +
        "  unmet          management_access\n" +
        "Next (configuration): run commish setup --plan --json\n" +
        "Integration remains unverified by this command. Use --json for evidence.",
    ],
    errors: [],
  });
  write(root, "commish.setup.json", config, 0o644);
  assert.match(
    (await run([])).output[0],
    /\nNext \(setup_approved\): run commish setup --config commish\.setup\.json --mode test --no-open --non-interactive --json\nThen a person must open the approval url and confirm the pairing code\.\n/,
  );
  provisioned(root);
  fetcher = server([[grantFile(root, "a"), "authorized"]]).fetcher;
  const done = await run([]);
  assert.equal(done.code, 0);
  assert.match(
    done.output[0],
    /^Commish status \(TEST\): complete\.\n[\s\S]*\nEvery step is met\.\n/,
  );
  const json = await run(["--json"]);
  assert.deepEqual([json.code, json.output.length, json.errors], [0, 1, []]);
  assert.equal(JSON.parse(json.output[0]).status, "complete");
  const help = await run(["--help", "--json"]);
  assert.deepEqual([help.code, JSON.parse(help.output[0])], [0, statusHelp()]);
  assert.match((await run(["--help"])).output[0], /^commish status /);
  for (const [args, code] of [
    [["--json", "--config", "/etc/hosts"], "unsafe_file_path"],
    [["--json", "--mode", "staging"], "invalid_arguments"],
    [["--json", "extra"], "invalid_arguments"],
    [["--json", "--private-fixture"], "invalid_arguments"],
  ]) {
    const failed = await run(args);
    assert.deepEqual([failed.code, failed.output], [1, []], args.join(" "));
    assert.deepEqual(JSON.parse(failed.errors[0]), { version: 1, status: "error", code });
  }
  fetcher = noRequest;
  // Recorded progress that does not parse is an error, never a guess.
  write(root, ".commish/setup/test/program.json", { id: "private-fixture" });
  const broken = await run([]);
  assert.deepEqual(
    [broken.code, broken.output, broken.errors],
    [1, [], ["Status failed: invalid_setup_progress."]],
  );
});

test("the newest authorized grant for this workspace and mode is used; others are skipped", async (t) => {
  const root = directory(t);
  provisioned(root);
  const expired = grantFile(root, "a"),
    current = grantFile(root, "b"),
    foreign = grantFile(root, "c", { workspaceId: "wrk_999999999999" }),
    narrow = grantFile(root, "d", { scopes: ["programs.read"] });
  write(root, ".commish/management/not-a-grant/authorization.json", "{}");
  utimesSync(join(root, expired.path), new Date(), new Date());
  utimesSync(join(root, current.path), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const before = readdirSync(root, { recursive: true }).sort();
  const management = server([
    [expired, "expired"],
    [current, "authorized"],
    [foreign, "authorized"],
    [narrow, "authorized"],
  ]);
  const result = await executeStatus([], { root, env: {}, fetcher: management.fetcher });
  assert.deepEqual(management.requests, ["GET /grants", "GET /grants"]);
  assert.deepEqual([result.status, result.nextStep, result.next], ["complete", null, null]);
  assert.deepEqual(byStep(result).management_access, {
    step: "management_access",
    status: "met",
    evidence: {
      source: current.path,
      status: "authorized",
      kind: "onboarding",
      workspaceId,
      scopes,
      expiresAt: "2099-01-01T01:00:00Z",
    },
  });
  for (const file of [expired, current, foreign, narrow])
    assert(!JSON.stringify(result).includes(file.token));
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
  // Only an expired grant: a new one is the next step, with the scopes setup asks for.
  rmSync(join(root, dirname(current.path)), { recursive: true });
  const stale = await executeStatus([], {
    root,
    env: {},
    fetcher: server([[expired, "expired"]]).fetcher,
  });
  assert.deepEqual(
    [stale.status, stale.nextStep, byStep(stale).management_access.evidence.status],
    ["incomplete", "management_access", "expired"],
  );
  assert.deepEqual(stale.next, {
    kind: "command",
    command: `commish auth login --workspace ${workspaceId} --workspace-scope --onboarding --scopes resources.read,diagnostics.read,programs.read,programs.write,terms.read,terms.write,destinations.read,destinations.write,credentials.read --mode test --no-open --non-interactive --json`,
    humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
  });
  // A pending stored request is resumed, not replaced.
  const pending = await executeStatus([], {
    root,
    env: {},
    fetcher: server([[expired, "pending"]]).fetcher,
  });
  assert.equal(
    pending.next.command,
    `commish auth login --auth-file ${expired.path} --mode test --no-open --non-interactive --json`,
  );
  // A grant that cannot read diagnostics is not enough for the remaining checks.
  const limited = await executeStatus(["--auth-file", narrow.path], {
    root,
    env: {},
    fetcher: server([[narrow, "authorized"]]).fetcher,
  });
  assert.deepEqual(
    [byStep(limited).management_access.status, limited.nextStep],
    ["unmet", "management_access"],
  );
});

test("a named file or token is used as given; an outage is reported, a broken file is an error", async (t) => {
  const root = directory(t);
  provisioned(root);
  const stored = grantFile(root, "a"),
    named = grantFile(root, "b");
  const explicit = server([
    [stored, "authorized"],
    [named, "authorized"],
  ]);
  const result = await executeStatus(["--auth-file", named.path], {
    root,
    env: {},
    fetcher: explicit.fetcher,
  });
  assert.deepEqual(explicit.requests, ["GET /grants"]);
  assert.equal(byStep(result).management_access.evidence.source, named.path);
  rmSync(join(root, ".commish/management"), { recursive: true });
  const token = await executeStatus([], {
    root,
    env: { COMMISH_MANAGEMENT_TOKEN: stored.token },
    fetcher: server([[{ ...stored, proposal: { ...stored.proposal } }, "authorized"]]).fetcher,
  });
  assert.deepEqual(
    [token.status, byStep(token).management_access.evidence.source],
    ["complete", "COMMISH_MANAGEMENT_TOKEN"],
  );
  const again = grantFile(root, "a");
  const down = await executeStatus([], {
    root,
    env: {},
    fetcher: server([[again, "authorized"]], { fail: "service_unavailable" }).fetcher,
  });
  assert.deepEqual(byStep(down).management_access.evidence, {
    source: again.path,
    status: "unavailable",
    code: "service_unavailable",
  });
  assert.equal(down.nextStep, "management_access");
  for (const [args, env, code] of [
    [["--auth-file", "missing.json"], {}, "invalid_authorization_file"],
    [
      ["--auth-file", again.path],
      { COMMISH_MANAGEMENT_TOKEN: again.token },
      "ambiguous_authorization",
    ],
    [["--auth-file", again.path, "--mode", "live"], {}, "key_mode_mismatch"],
    [[], { COMMISH_MANAGEMENT_TOKEN: "private-fixture" }, "management_authorization_required"],
  ])
    await assert.rejects(executeStatus(args, { root, env, fetcher: noRequest }), { message: code });
});

test("LIVE asks for a read-only session, and setup comes first when nothing is recorded", async (t) => {
  const root = directory(t);
  write(root, "commish.setup.json", config, 0o644);
  const fresh = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(byStep(fresh).management_access.next, provision());
  write(root, ".commish/setup/live/workspace.json", { id: workspaceId });
  // A Test grant is never offered for LIVE.
  grantFile(root, "a");
  const live = await executeStatus(["--mode", "live"], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(byStep(live).management_access, {
    step: "management_access",
    status: "unmet",
    evidence: { source: "none", status: "missing" },
    next: {
      kind: "command",
      command: `commish auth login --workspace ${workspaceId} --workspace-scope --scopes resources.read,diagnostics.read,programs.read,terms.read,destinations.read --mode live --no-open --non-interactive --json`,
      humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
    },
  });
});
