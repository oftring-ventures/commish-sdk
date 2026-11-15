import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeAuth } from "../packages/sdk/bin/auth-command.mjs";
import { tokenHash } from "../packages/sdk/bin/management-client.mjs";
import { setupFingerprint } from "../packages/sdk/bin/setup-progress.mjs";
import {
  executeStatus,
  runStatusCommand,
  statusHelp,
} from "../packages/sdk/bin/status-command.mjs";

const workspaceId = "wrk_123456789012",
  applicationId = "app_123456789012",
  programId = "prg_123456789012",
  api = "https://app.commish.sh/api/management/v1";
const scopes = ["diagnostics.read", "programs.write", "destinations.write", "terms.read"];
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
// The intent setup records when it starts: the fingerprint of its configuration.
function intent(root, started = config, appUrl) {
  write(root, `.commish/setup/${started.mode ?? "test"}/intent.json`, {
    version: 1,
    fingerprint: setupFingerprint(started, appUrl).fingerprint,
    id: "97961974-684d-46b3-aebb-2ef22ee2cec0",
    createdAt: "2026-11-14T12:04:40.049Z",
  });
}
// The files a completed `commish setup` leaves behind.
function provisioned(root, { webhook = false } = {}) {
  write(root, "commish.setup.json", config, 0o644);
  const directory = ".commish/setup/test";
  intent(root);
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
function grantFile(root, letter, patch = {}, base = api) {
  const token = `cm_mgmt_${patch.mode ?? "test"}_${letter.repeat(43).slice(0, 43)}`,
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
  // Byte for byte what auth login stores, so the file can be resumed.
  write(root, path, `${JSON.stringify({ version: 1, baseUrl: base, token, proposal })}\n`);
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
const activated = "2026-11-14T21:11:28.86061+00:00";
const met = [
  "program_active",
  "active_terms",
  "verified_origin",
  "stripe_connection",
  "eligible_products",
  "stable_customer_identity",
  "attributed_checkout",
  "provider_event_receipt",
  "attributed_conversion_observed",
  "commission_observed",
];
// A management API that knows each stored grant's state and one diagnostics report.
function server(
  grants,
  {
    checks = {},
    testActivatedAt = activated,
    mode = "test",
    fail,
    failDiagnostics,
    patch,
    base = api,
  } = {},
) {
  const requests = [];
  const fetcher = async (url, init) => {
    const grant = grants.find(([file]) => init.headers.authorization === `Bearer ${file.token}`);
    requests.push(`${init.method} ${url.slice(base.length)}`);
    assert(grant, "unknown bearer");
    if (fail) return Response.json({ error: { code: fail } }, { status: 503 });
    if (failDiagnostics && url !== `${base}/grants`)
      return Response.json(
        { error: { code: failDiagnostics } },
        { status: failDiagnostics === "rate_limited" ? 429 : 404 },
      );
    if (url === `${base}/grants`)
      return Response.json({ data: grantFor(grant[0].proposal, grant[1]) });
    assert.equal(url, `${base}/diagnostics.get?programId=${programId}`);
    return Response.json({
      data: {
        protocol: "commish-management-v1",
        operation: "diagnostics.get",
        workspaceId,
        applicationId: null,
        mode,
        result: {
          report: {
            version: 1,
            mode,
            programId,
            status: "incomplete",
            integrationVerified: false,
            unmetConditions: [],
            checks: [
              ...met.map((code) => ({
                code,
                status: checks[code] ?? "met",
                action: "private-fixture server text",
              })),
              { code: "related_webhook_delivered", status: checks.webhook ?? "not_applicable" },
            ].filter((check) => check.status !== "absent"),
            testActivatedAt,
            ...patch,
          },
        },
      },
    });
  };
  return { fetcher, requests };
}
const diagnosticsRead = `GET /diagnostics.get?programId=${programId}`;
const statuses = (result) => result.steps.map((item) => `${item.step}:${item.status}`);
const byStep = (result) => Object.fromEntries(result.steps.map((item) => [item.step, item]));
const provision = (config = "commish.setup.json") => ({
  kind: "command",
  command: `commish setup --config ${config} --mode test --no-open --non-interactive --json`,
  humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
});

test("a repository that never ran setup is reported offline and left untouched", async (t) => {
  const root = directory(t);
  const result = await executeStatus(["--json"], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    { ...result, steps: result.steps.slice(0, 4) },
    {
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
            webhook: "unknown",
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
    },
  );
  // Nothing was provisioned, so there is no program to ask about.
  assert.deepEqual(
    result.steps.slice(4).map(({ step, ...rest }) => rest),
    Array(8).fill({
      status: "unknown",
      evidence: { source: "diagnostics.get" },
      reason: "program_not_provisioned",
    }),
  );
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
  assert.deepEqual([ready.nextStep, ready.next], ["setup_approved", provision("other.json")]);
  // An incomplete file named with --config is planned with --config too.
  write(root, "partial.json", { version: 1, stripe: "later" }, 0o644);
  const named = await executeStatus(["--config", "partial.json"], {
    root,
    env: {},
    fetcher: noRequest,
  });
  assert.deepEqual(
    [named.nextStep, named.next],
    [
      "configuration",
      { kind: "command", command: "commish setup --config partial.json --plan --json" },
    ],
  );
  rmSync(join(root, "partial.json"));
  // A path that cannot be pasted into a command line as it is becomes a placeholder.
  write(root, "odd name.json", config, 0o644);
  const odd = await executeStatus(["--config", "odd name.json"], {
    root,
    env: {},
    fetcher: noRequest,
  });
  assert.deepEqual(odd.next, provision("<config>"));
  assert(!JSON.stringify(odd).includes("odd name"));
  rmSync(join(root, "odd name.json"));
  assert.deepEqual(readdirSync(root).sort(), ["commish.setup.json", "other.json"]);
});

test("recorded setup progress is reported step by step without revealing key material", async (t) => {
  const root = directory(t);
  write(root, "commish.setup.json", config, 0o644);
  write(root, ".commish/setup/test/workspace.json", { id: workspaceId });
  const approved = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    approved.steps.slice(0, 4).map((item) => item.status),
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
    done.steps.slice(0, 4).map((item) => item.status),
    ["met", "met", "met", "unmet"],
  );
  assert(done.steps.slice(4).every((item) => item.reason === "management_access_required"));
  assert.deepEqual(byStep(done).configuration.evidence, {
    source: "commish.setup.json",
    configuration: "ready",
    setupStartedAt: "2026-11-14T12:04:40.049Z",
    matchesRecordedSetup: true,
  });
  assert.deepEqual(byStep(done).resources_provisioned.evidence, {
    source: ".commish/setup/test",
    applicationId,
    programId,
    credentialId: "key_123456789012",
    webhook: "not_configured",
    credentialsFile: "present",
  });
  for (const secret of ["k".repeat(43), "p".repeat(32)])
    assert(!JSON.stringify(done).includes(secret));
  // Progress is kept per mode: LIVE has recorded nothing here.
  const live = await executeStatus(["--mode", "live"], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    live.steps.slice(0, 4).map((item) => item.status),
    ["met", "unmet", "unmet", "unmet"],
  );
  assert.match(live.next.command, / --mode live /);
  // A setup started from flags has no configuration file but did have its choices.
  rmSync(join(root, "commish.setup.json"));
  const flags = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    [flags.steps[0].status, flags.steps[0].evidence.configuration, flags.nextStep],
    ["met", "missing", "resources_provisioned"],
  );
  // A configured webhook needs its endpoint and signing secret file too.
  write(root, "commish.setup.json", { ...config, webhook: hook }, 0o644);
  intent(root, { ...config, webhook: hook });
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
        webhook: "configured",
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
        statusHelp()
          .steps.slice(4)
          .map((step) => `  unknown        ${step} (program_not_provisioned)\n`)
          .join("") +
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
  assert.deepEqual(management.requests, ["GET /grants", "GET /grants", diagnosticsRead]);
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

test("a pending request is resumed even beside an older grant, in either order", async (t) => {
  const root = directory(t);
  provisioned(root);
  const older = grantFile(root, "a"),
    newer = grantFile(root, "b");
  utimesSync(join(root, older.path), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  utimesSync(join(root, newer.path), new Date(), new Date());
  const resume = (file) => ({
    kind: "command",
    command: `commish auth login --auth-file ${file.path} --mode test --no-open --non-interactive --json`,
    humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
  });
  // The grant expired, a new login is waiting for approval: the next pass resumes it.
  for (const [states, pending] of [
    [
      [
        [newer, "pending"],
        [older, "expired"],
      ],
      newer,
    ],
    [
      [
        [newer, "revoked"],
        [older, "pending"],
      ],
      older,
    ],
  ]) {
    const management = server(states);
    const result = await executeStatus([], { root, env: {}, fetcher: management.fetcher });
    assert.deepEqual(management.requests, ["GET /grants", "GET /grants"]);
    assert.deepEqual(
      [
        byStep(result).management_access.status,
        byStep(result).management_access.evidence.source,
        byStep(result).management_access.evidence.status,
      ],
      ["unmet", pending.path, "pending"],
    );
    assert.deepEqual([result.nextStep, result.next], ["management_access", resume(pending)]);
  }
  // With nothing pending, the newest grant tried is the one described.
  const spent = await executeStatus([], {
    root,
    env: {},
    fetcher: server([
      [newer, "revoked"],
      [older, "expired"],
    ]).fetcher,
  });
  assert.deepEqual(
    [
      byStep(spent).management_access.evidence.source,
      byStep(spent).management_access.evidence.status,
    ],
    [newer.path, "revoked"],
  );
  assert.match(spent.next.command, /^commish auth login --workspace wrk_123456789012 /);
  // An authorized grant still wins over a pending one beside it.
  const usable = await executeStatus([], {
    root,
    env: {},
    fetcher: server([
      [newer, "pending"],
      [older, "authorized"],
    ]).fetcher,
  });
  assert.deepEqual(
    [usable.status, byStep(usable).management_access.evidence.source],
    ["complete", older.path],
  );
});

test("many stored grants do not hide the right one, and a half-published grant is not repaired", async (t) => {
  const root = directory(t);
  provisioned(root);
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let index = 0; index < 70; index++)
    grantFile(
      root,
      `${letters[index % letters.length]}${letters[Math.floor(index / letters.length)]}_`,
      {
        workspaceId: "wrk_999999999999",
      },
    );
  const current = grantFile(root, "a");
  assert.equal(readdirSync(join(root, ".commish/management")).length, 71);
  const management = server([[current, "authorized"]]);
  const result = await executeStatus([], { root, env: {}, fetcher: management.fetcher });
  assert.deepEqual(management.requests, ["GET /grants", diagnosticsRead]);
  assert.equal(byStep(result).management_access.evidence.source, current.path);
  // A stored grant left half-published is skipped; a named one is an error. Neither is repaired.
  const leftover = `${dirname(current.path)}/.commish-setup-authorization.json.97961974-684d-46b3-aebb-2ef22ee2cec0.tmp`;
  linkSync(join(root, current.path), join(root, leftover));
  const before = readdirSync(root, { recursive: true }).sort();
  const skipped = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(byStep(skipped).management_access.evidence, {
    source: "none",
    status: "missing",
  });
  await assert.rejects(
    executeStatus(["--auth-file", current.path], { root, env: {}, fetcher: noRequest }),
    { message: "invalid_authorization_file" },
  );
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
});

test("a named grant for another workspace does not count for this install", async (t) => {
  const root = directory(t);
  provisioned(root);
  const other = grantFile(root, "a", { workspaceId: "wrk_999999999999" });
  for (const [args, env, source] of [
    [["--auth-file", other.path], {}, other.path],
    [[], { COMMISH_MANAGEMENT_TOKEN: other.token }, "COMMISH_MANAGEMENT_TOKEN"],
  ]) {
    const result = await executeStatus(args, {
      root,
      env,
      fetcher: server([[other, "authorized"]]).fetcher,
    });
    assert.deepEqual(byStep(result).management_access.evidence, {
      source,
      status: "authorized",
      kind: "onboarding",
      workspaceId: "wrk_999999999999",
      scopes,
      expiresAt: "2099-01-01T01:00:00Z",
      code: "workspace_mismatch",
    });
    assert.deepEqual(
      [byStep(result).management_access.status, result.nextStep],
      ["unmet", "management_access"],
    );
    // The next command asks for a grant on the workspace setup recorded.
    assert.match(result.next.command, /^commish auth login --workspace wrk_123456789012 /);
  }
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
  assert.deepEqual(explicit.requests, ["GET /grants", diagnosticsRead]);
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
  assert.equal(byStep(down).stripe_connected.reason, "management_access_required");
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

test("a provisioned install reports each remaining step with its evidence and next action", async (t) => {
  const root = directory(t);
  provisioned(root);
  const file = grantFile(root, "a");
  const before = readdirSync(root, { recursive: true }).sort();
  const { fetcher, requests } = server([[file, "authorized"]], {
    testActivatedAt: null,
    checks: {
      verified_origin: "unmet",
      stripe_connection: "unmet",
      program_active: "unmet",
      active_terms: "unmet",
      stable_customer_identity: "unmet",
      attributed_checkout: "unmet",
      attributed_conversion_observed: "unmet",
      commission_observed: "unmet",
    },
  });
  const result = await executeStatus([], { root, env: {}, fetcher });
  assert.deepEqual(requests, ["GET /grants", `GET /diagnostics.get?programId=${programId}`]);
  assert.deepEqual(statuses(result), [
    "configuration:met",
    "setup_approved:met",
    "resources_provisioned:met",
    "management_access:met",
    "destination_verified:unmet",
    "stripe_connected:unmet",
    "eligible_products:met",
    "program_active:unmet",
    "rehearsal:unknown",
    "attributed_test_conversion:unmet",
    "webhook_delivery:not_applicable",
    "integration_activated:unmet",
  ]);
  const steps = byStep(result),
    auth = ` --auth-file ${file.path} --mode test --json`;
  assert.deepEqual(steps.management_access.evidence, {
    source: file.path,
    status: "authorized",
    kind: "onboarding",
    workspaceId,
    scopes,
    expiresAt: "2099-01-01T01:00:00Z",
  });
  assert.deepEqual(steps.resources_provisioned.evidence, {
    source: ".commish/setup/test",
    applicationId,
    programId,
    credentialId: "key_123456789012",
    webhook: "not_configured",
    credentialsFile: "present",
  });
  assert.equal(result.nextStep, "destination_verified");
  assert.deepEqual(result.next, steps.destination_verified.next);
  assert.deepEqual(steps.destination_verified.next, {
    kind: "command",
    before:
      "Deploy public/.well-known/commish-verification.txt so that https://guestbook.example/.well-known/commish-verification.txt serves it.",
    command: `commish manage destinations.verify --body-file commish-destination.json${auth}`,
    bodyFile: "commish-destination.json",
    body: { applicationId, origin: "https://guestbook.example" },
  });
  assert.deepEqual(steps.stripe_connected.next, {
    kind: "browser",
    url: `https://app.commish.sh/cli/setup/workspace/${workspaceId}/stripe?mode=test`,
    actor: "workspace_owner_or_admin",
    action: "connect_stripe",
  });
  assert.deepEqual(steps.program_active.evidence.checks, {
    program_active: "unmet",
    active_terms: "unmet",
  });
  assert.equal(
    steps.program_active.next.command,
    `commish manage programs.activate --body-file commish-activate.json${auth}`,
  );
  assert.equal(steps.program_active.next.body.programId, programId);
  assert.equal(steps.rehearsal.reason, "no_read_operation_reports_the_test_partnership");
  // The step cannot turn met by itself, so its action says what follows.
  assert.deepEqual(steps.rehearsal.next, {
    kind: "command",
    command: `commish test rehearsal --program ${programId} --auth-file ${file.path} --mode test --json`,
    followedBy: {
      kind: "guidance",
      guidance:
        "Open the returned referralUrl and complete a Test purchase in your product. This step is met once that conversion is attributed; running the command again returns the same link.",
    },
  });
  assert.match(steps.attributed_test_conversion.next.guidance, /client_reference_id/);
  assert.equal(
    steps.integration_activated.next.url,
    `https://app.commish.sh/dashboard/workspace/${workspaceId}/programs/${programId}?tab=integration`,
  );
  // Evidence and identifiers only: no bearer, key material or server text.
  const printed = JSON.stringify(result);
  for (const secret of [file.token, "k".repeat(43), "p".repeat(32), "private-fixture"])
    assert(!printed.includes(secret));
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
});

test("a finished install is complete, and the text output names the next action otherwise", async (t) => {
  const root = directory(t);
  provisioned(root);
  const file = grantFile(root, "a");
  const run = async (args, report) => {
    const output = [],
      errors = [];
    const code = await runStatusCommand(args, {
      root,
      env: {},
      fetcher: server([[file, "authorized"]], report).fetcher,
      out: (value) => output.push(value),
      diagnostic: (value) => errors.push(value),
    });
    assert.deepEqual([output.length, errors], [1, []]);
    return [code, output[0]];
  };
  const done = { testActivatedAt: "2026-11-14T21:11:28.86061+00:00" };
  const [code, json] = await run(["--json", "--non-interactive"], done);
  const result = JSON.parse(json);
  assert.deepEqual(
    [code, result.status, result.nextStep, result.next, result.integrationVerified],
    [0, "complete", null, null, false],
  );
  assert.equal(byStep(result).rehearsal.status, "met");
  // The instant is reprinted, never the server's own text.
  assert.equal(
    byStep(result).integration_activated.evidence.testActivatedAt,
    "2026-11-14T21:11:28.860Z",
  );
  const [, legacy] = await run(["--json"], {
    testActivatedAt: "Sat Nov 14 2026 21:11:28 GMT+0000 (private-fixture)",
  });
  assert.equal(
    byStep(JSON.parse(legacy)).integration_activated.evidence.testActivatedAt,
    "2026-11-14T21:11:28.000Z",
  );
  assert(!legacy.includes("private-fixture"));
  const [, text] = await run([], done);
  assert.match(text, /^Commish status \(TEST\): complete\.\n {2}met {12}configuration\n/);
  assert.match(text, /Every step is met\./);
  const [waiting, pending] = await run([], { checks: { stripe_connection: "unmet" } });
  assert.equal(waiting, 2);
  assert.match(pending, /^Commish status \(TEST\): incomplete\.\n/);
  assert.match(
    pending,
    /\nNext \(stripe_connected\): open https:\/\/app\.commish\.sh\/cli\/setup\/workspace\/wrk_123456789012\/stripe\?mode=test in the browser \(connect stripe\)\.\n/,
  );
  // A subscribed webhook that has not delivered is a step of its own.
  const [, hooks] = await run(["--json"], { ...done, checks: { webhook: "unmet" } });
  assert.deepEqual(
    [JSON.parse(hooks).nextStep, JSON.parse(hooks).next.kind],
    ["webhook_delivery", "guidance"],
  );
});

test("a write is only suggested with a grant that can run it, and a rehearsal says what follows", async (t) => {
  const root = directory(t);
  provisioned(root);
  // A read-only session beside nothing else: enough to read, not to act.
  const reader = grantFile(root, "a", {
    kind: "session",
    scopes: ["diagnostics.read"],
    expiresIn: 3600,
  });
  const unmet = {
    testActivatedAt: null,
    checks: {
      verified_origin: "unmet",
      program_active: "unmet",
      attributed_checkout: "unmet",
      attributed_conversion_observed: "unmet",
      commission_observed: "unmet",
    },
  };
  const result = await executeStatus([], {
    root,
    env: {},
    fetcher: server([[reader, "authorized"]], unmet).fetcher,
  });
  const steps = byStep(result),
    login = `commish auth login --workspace ${workspaceId} --workspace-scope --onboarding --scopes resources.read,diagnostics.read,programs.read,programs.write,terms.read,terms.write,destinations.read,destinations.write,credentials.read --mode test --no-open --non-interactive --json`,
    granted = " --auth-file <authorizationFile> --mode test --json";
  assert.equal(steps.management_access.status, "met");
  assert.deepEqual(steps.destination_verified.next, {
    kind: "command",
    command: login,
    humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
    requiredScopes: ["destinations.write"],
    followedBy: {
      kind: "command",
      before:
        "Deploy public/.well-known/commish-verification.txt so that https://guestbook.example/.well-known/commish-verification.txt serves it.",
      command: `commish manage destinations.verify --body-file commish-destination.json${granted}`,
      bodyFile: "commish-destination.json",
      body: { applicationId, origin: "https://guestbook.example" },
    },
  });
  assert.deepEqual(
    [
      steps.program_active.next.command,
      steps.program_active.next.requiredScopes,
      steps.program_active.next.followedBy.command,
      steps.program_active.next.followedBy.before,
    ],
    [
      login,
      ["terms.read", "programs.write"],
      `commish manage programs.activate --body-file commish-activate.json${granted}`,
      `Read the term version to activate: commish manage terms.list --program ${programId}${granted}`,
    ],
  );
  assert.deepEqual(
    [
      steps.rehearsal.next.command,
      steps.rehearsal.next.requiredScopes,
      steps.rehearsal.next.followedBy.command,
      steps.rehearsal.next.followedBy.followedBy.kind,
    ],
    [
      login,
      ["programs.write"],
      `commish test rehearsal --program ${programId} --auth-file <authorizationFile> --mode test --json`,
      "guidance",
    ],
  );
  // No command anywhere names the grant that cannot run it.
  for (const step of ["destination_verified", "program_active", "rehearsal"])
    assert(!JSON.stringify(steps[step].next).includes(reader.path), step);
  // Reads and browser actions are unaffected.
  assert.equal(steps.integration_activated.next.kind, "browser");
  // LIVE: the read-only session status asks for cannot activate either.
  write(root, "commish.setup.json", { ...config, mode: "live" }, 0o644);
  for (const [name, id] of [
    ["workspace", workspaceId],
    ["application", applicationId],
    ["program", programId],
    ["credential", "key_123456789012"],
  ])
    write(root, `.commish/setup/live/${name}.json`, { id });
  write(
    root,
    ".commish/setup/live/credentials.env",
    `COMMISH_MODE=live\nCOMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PROGRAM_ID=${programId}\n` +
      `COMMISH_PUBLISHABLE_KEY=cm_live_pk_${"p".repeat(32)}\nCOMMISH_SECRET_KEY=cm_live_sk_${"k".repeat(43)}\n`,
  );
  const session = grantFile(root, "b", {
    mode: "live",
    kind: "session",
    scopes: ["resources.read", "diagnostics.read", "programs.read", "terms.read"],
    expiresIn: 3600,
  });
  const live = await executeStatus([], {
    root,
    env: {},
    fetcher: server([[session, "authorized"]], {
      mode: "live",
      checks: { program_active: "unmet" },
    }).fetcher,
  });
  assert.deepEqual(
    [live.nextStep, live.next.command, live.next.requiredScopes, live.next.followedBy.command],
    [
      "program_active",
      `commish auth login --workspace ${workspaceId} --workspace-scope --scopes terms.read,programs.write --mode live --no-open --non-interactive --json`,
      ["programs.write"],
      "commish manage programs.activate --body-file commish-activate.json --auth-file <authorizationFile> --mode live --json",
    ],
  );
  // Text mode prints the whole chain.
  rmSync(join(root, ".commish/setup/live"), { recursive: true });
  write(root, "commish.setup.json", config, 0o644);
  const output = [];
  await runStatusCommand([], {
    root,
    env: {},
    fetcher: server([[reader, "authorized"]], {
      testActivatedAt: null,
      checks: { attributed_conversion_observed: "unmet", attributed_checkout: "unmet" },
    }).fetcher,
    out: (value) => output.push(value),
  });
  assert.match(
    output[0],
    /\nNext \(rehearsal\): run commish auth login [^\n]+\nThen a person must open the approval url and confirm the pairing code\.\nAfter that: run commish test rehearsal --program prg_123456789012 --auth-file <authorizationFile> --mode test --json\nAfter that: Open the returned referralUrl and complete a Test purchase in your product\./,
  );
});

test("a failed, partial or malformed diagnostics read is unknown with a reason, never met or unmet", async (t) => {
  const root = directory(t);
  provisioned(root);
  const file = grantFile(root, "a");
  const read = (report) =>
    executeStatus([], { root, env: {}, fetcher: server([[file, "authorized"]], report).fetcher });
  for (const [report, reason] of [
    [{ failDiagnostics: "rate_limited" }, "rate_limited"],
    [{ failDiagnostics: "program_not_found" }, "program_not_found"],
    [{ patch: { testActivatedAt: 5 } }, "invalid_response"],
    [
      { patch: { checks: [{ code: "program_active", status: "private-fixture" }] } },
      "invalid_response",
    ],
    [{ patch: { programId: "prg_999999999999" } }, "invalid_response"],
  ]) {
    const result = await read(report);
    assert.equal(byStep(result).management_access.status, "met");
    assert.deepEqual(
      result.steps.slice(4).map(({ step, ...rest }) => rest),
      Array(8).fill({ status: "unknown", evidence: { source: "diagnostics.get" }, reason }),
    );
    assert.deepEqual([result.status, result.nextStep, result.next], ["incomplete", null, null]);
    assert(!JSON.stringify(result).includes("private-fixture"));
  }
  // A check the report leaves out or did not evaluate is not guessed.
  const partial = await read({
    checks: { stripe_connection: "absent", verified_origin: "not_evaluated" },
  });
  assert.deepEqual(
    [byStep(partial).stripe_connected.status, byStep(partial).stripe_connected.reason],
    ["unknown", "check_not_reported"],
  );
  assert.deepEqual(byStep(partial).destination_verified, {
    step: "destination_verified",
    status: "unknown",
    evidence: { source: "diagnostics.get", checks: { verified_origin: "not_evaluated" } },
    reason: "check_not_reported",
  });
  assert.equal(byStep(partial).eligible_products.status, "met");
});

test("LIVE reports what diagnostics evaluate and marks Test-only steps not applicable", async (t) => {
  const root = directory(t);
  write(root, "commish.setup.json", { ...config, mode: "live" }, 0o644);
  for (const [name, id] of [
    ["workspace", workspaceId],
    ["application", applicationId],
    ["program", programId],
    ["credential", "key_123456789012"],
  ])
    write(root, `.commish/setup/live/${name}.json`, { id });
  write(
    root,
    ".commish/setup/live/credentials.env",
    `COMMISH_MODE=live\nCOMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PROGRAM_ID=${programId}\n` +
      `COMMISH_PUBLISHABLE_KEY=cm_live_pk_${"p".repeat(32)}\nCOMMISH_SECRET_KEY=cm_live_sk_${"k".repeat(43)}\n`,
  );
  const file = grantFile(root, "a", {
    mode: "live",
    kind: "session",
    scopes: ["diagnostics.read"],
    expiresIn: 3600,
  });
  const gates = Object.fromEntries(
    [
      "verified_origin",
      "stripe_connection",
      "eligible_products",
      "stable_customer_identity",
      "attributed_checkout",
      "provider_event_receipt",
    ].map((code) => [code, "absent"]),
  );
  const result = await executeStatus(["--mode", "live"], {
    root,
    env: {},
    fetcher: server([[file, "authorized"]], { mode: "live", checks: gates }).fetcher,
  });
  assert.deepEqual(statuses(result).slice(3), [
    "management_access:met",
    "destination_verified:unknown",
    "stripe_connected:unknown",
    "eligible_products:unknown",
    "program_active:met",
    "rehearsal:not_applicable",
    "attributed_test_conversion:unknown",
    "webhook_delivery:not_applicable",
    "integration_activated:not_applicable",
  ]);
  assert.equal(byStep(result).stripe_connected.reason, "not_evaluated_in_live");
  assert.deepEqual([result.status, result.nextStep], ["incomplete", null]);
  // Without a grant, LIVE asks for a read-only session rather than onboarding.
  rmSync(join(root, ".commish/management"), { recursive: true });
  const none = await executeStatus(["--mode", "live"], { root, env: {}, fetcher: noRequest });
  assert.equal(
    none.next.command,
    `commish auth login --workspace ${workspaceId} --workspace-scope --scopes resources.read,diagnostics.read,programs.read,terms.read,destinations.read --mode live --no-open --non-interactive --json`,
  );
});

test("the mode is the one setup would use: the flag, then the configuration, then the shell", async (t) => {
  const root = directory(t);
  const mode = async (args, env) => {
    const result = await executeStatus(args, { root, env, fetcher: noRequest });
    assert.match(result.steps[1].next.command, new RegExp(` --mode ${result.mode} `));
    assert.equal(result.steps[1].evidence.source, `.commish/setup/${result.mode}/workspace.json`);
    return result.mode;
  };
  // No configuration file: the shell decides, as for the other management commands.
  assert.equal(await mode([], {}), "test");
  assert.equal(await mode([], { COMMISH_MODE: "live" }), "live");
  // A configuration that names no mode is a Test setup, whatever the shell says.
  write(root, "commish.setup.json", config, 0o644);
  assert.equal(await mode([], { COMMISH_MODE: "live" }), "test");
  rmSync(join(root, "commish.setup.json"));
  // A LIVE configuration is reported as LIVE without a flag, even when incomplete.
  write(root, "commish.setup.json", { ...config, mode: "live" }, 0o644);
  assert.equal(await mode([], {}), "live");
  assert.equal(await mode([], { COMMISH_MODE: "test" }), "live");
  assert.equal(await mode(["--mode", "test"], { COMMISH_MODE: "live" }), "test");
  rmSync(join(root, "commish.setup.json"));
  write(root, "commish.setup.json", { version: 1, mode: "live" }, 0o644);
  assert.equal(await mode([], {}), "live");
  // A mode the file cannot mean is not followed.
  rmSync(join(root, "commish.setup.json"));
  write(root, "commish.setup.json", { ...config, mode: "private-fixture" }, 0o644);
  assert.equal(await mode([], {}), "test");
  await assert.rejects(executeStatus([], { root, env: { COMMISH_MODE: "staging" } }), {
    message: "invalid_arguments",
  });
});

test("a state file an interrupted setup left half-published is refused, not repaired", async (t) => {
  const root = directory(t);
  provisioned(root);
  // What a setup killed between publishing a file and removing its temporary link leaves.
  for (const name of ["workspace.json", "credentials.env"]) {
    const leftover = `.commish/setup/test/.commish-setup-${name}.97961974-684d-46b3-aebb-2ef22ee2cec0.tmp`;
    linkSync(join(root, `.commish/setup/test/${name}`), join(root, leftover));
    const before = readdirSync(root, { recursive: true }).sort();
    assert(before.includes(leftover));
    await assert.rejects(executeStatus([], { root, env: {}, fetcher: noRequest }), {
      message: "unsafe_file_permissions",
    });
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
    rmSync(join(root, leftover));
  }
  const repaired = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    repaired.steps.slice(0, 3).map((item) => item.status),
    ["met", "met", "met"],
  );
});

test("a setup started from flags is told to repeat its own command, not one that would fail", async (t) => {
  const root = directory(t);
  // Interrupted after approval: progress is recorded, no configuration file exists.
  intent(root);
  for (const recorded of [false, true]) {
    if (recorded) write(root, ".commish/setup/test/workspace.json", { id: workspaceId });
    const result = await executeStatus([], { root, env: {}, fetcher: noRequest });
    assert.deepEqual(
      [result.steps[0].status, result.steps[0].evidence.configuration],
      ["met", "missing"],
    );
    assert.equal(result.nextStep, recorded ? "resources_provisioned" : "setup_approved");
    assert.deepEqual(result.next, {
      kind: "guidance",
      guidance:
        "Setup was started from flags, so there is no configuration file to rerun. Repeat the original commish setup command with the same flags, or restore its configuration file; setup resumes from the recorded progress.",
      humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
    });
    // No command anywhere names a configuration file that does not exist.
    assert(!JSON.stringify(result).includes("--config"));
  }
  const output = [];
  await runStatusCommand([], { root, env: {}, fetcher: noRequest, out: (v) => output.push(v) });
  assert.match(
    output[0],
    /\nNext \(resources_provisioned\): Setup was started from flags, [^\n]+\nThen a person must open the approval url and confirm the pairing code\.\n/,
  );
  // With the file restored, the ordinary command is offered again.
  write(root, "commish.setup.json", config, 0o644);
  const restored = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(restored.next, provision());
});

test("a credential file counts only when it is the one setup wrote for these resources", async (t) => {
  const root = directory(t);
  provisioned(root);
  const path = join(root, ".commish/setup/test/credentials.env"),
    keys = `COMMISH_PUBLISHABLE_KEY=cm_test_pk_${"p".repeat(32)}\nCOMMISH_SECRET_KEY=cm_test_sk_${"k".repeat(43)}\n`,
    ids = `COMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PROGRAM_ID=${programId}\n`;
  const check = async (body) => {
    rmSync(path);
    write(root, ".commish/setup/test/credentials.env", body);
    const result = await executeStatus([], { root, env: {}, fetcher: noRequest });
    assert(!JSON.stringify(result).includes("private-fixture"));
    if (result.steps[2].status === "unmet")
      // Setup refuses such a file, so no rerun is offered.
      assert.deepEqual(
        [result.steps[2].reason, result.next.kind, /Restore the file/.test(result.next.guidance)],
        ["setup_credential_conflict", "guidance", true],
      );
    return [
      result.steps[2].status,
      result.steps[2].evidence.credentialsFile,
      result.nextStep === "resources_provisioned",
    ];
  };
  for (const body of [
    // Four assignments that are not the keys.
    `COMMISH_MODE=test\n${"COMMISH_GARBAGE=private-fixture\n".repeat(4)}`,
    // The right fields with values that are not keys.
    `COMMISH_MODE=test\n${ids}COMMISH_PUBLISHABLE_KEY=private-fixture\nCOMMISH_SECRET_KEY=private-fixture\n`,
    // Another application or program than the ones recorded.
    `COMMISH_MODE=test\nCOMMISH_APPLICATION_ID=app_999999999999\nCOMMISH_PROGRAM_ID=${programId}\n${keys}`,
    `COMMISH_MODE=test\nCOMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PROGRAM_ID=prg_999999999999\n${keys}`,
    // LIVE keys or a LIVE mode line in the Test file.
    `COMMISH_MODE=test\n${ids}${keys.replaceAll("cm_test_", "cm_live_")}`,
    `COMMISH_MODE=live\n${ids}${keys}`,
    // A missing field, an extra one, and a file without its final newline.
    `COMMISH_MODE=test\n${ids}COMMISH_SECRET_KEY=cm_test_sk_${"k".repeat(43)}\n`,
    `COMMISH_MODE=test\n${ids}${keys}COMMISH_EXTRA=private-fixture\n`,
    `COMMISH_MODE=test\n${ids}${keys}`.slice(0, -1),
  ])
    assert.deepEqual(await check(body), ["unmet", "invalid", true], body.split("\n")[1]);
  assert.deepEqual(await check(`COMMISH_MODE=test\n${ids}${keys}`), ["met", "present", false]);
});

test("without its configuration, a setup that may still owe a webhook is unknown, never complete", async (t) => {
  const root = directory(t);
  provisioned(root);
  rmSync(join(root, "commish.setup.json"));
  const read = () => executeStatus([], { root, env: {}, fetcher: noRequest });
  const repeat = {
    kind: "guidance",
    guidance:
      "Setup was started from flags, so there is no configuration file to rerun. Repeat the original commish setup command with the same flags, or restore its configuration file; setup resumes from the recorded progress.",
    humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
  };
  // A flags-only setup interrupted after the credential and before its webhook, and
  // one that asked for no webhook and finished, leave exactly these files.
  const ambiguous = await read();
  assert.deepEqual(byStep(ambiguous).resources_provisioned, {
    step: "resources_provisioned",
    status: "unknown",
    evidence: {
      source: ".commish/setup/test",
      applicationId,
      programId,
      credentialId: "key_123456789012",
      webhook: "unknown",
      credentialsFile: "present",
    },
    reason: "webhook_request_not_recorded",
    next: repeat,
  });
  assert.deepEqual(
    [ambiguous.status, ambiguous.nextStep, ambiguous.next],
    ["incomplete", "resources_provisioned", repeat],
  );
  const output = [];
  assert.equal(
    await runStatusCommand([], { root, env: {}, fetcher: noRequest, out: (v) => output.push(v) }),
    2,
  );
  assert.match(
    output[0],
    /\n {2}unknown {8}resources_provisioned \(webhook_request_not_recorded\)\n[\s\S]*\nNext \(resources_provisioned\): Setup was started from flags, /,
  );
  // Interrupted after the endpoint was created and before its secret was saved.
  write(root, ".commish/setup/test/webhook.json", { id: "whe_123456789012" });
  const half = byStep(await read()).resources_provisioned;
  assert.deepEqual(
    [half.status, half.evidence.webhook, half.evidence.webhookFile, half.reason],
    ["unmet", "recorded", "absent", undefined],
  );
  // The endpoint is the last resource setup records: with it and its secret, setup finished.
  write(
    root,
    ".commish/setup/test/webhook.env",
    `COMMISH_WEBHOOK_SIGNING_SECRET=whsec_${"w".repeat(32)}\n`,
  );
  const finished = await read();
  assert.deepEqual(
    [
      finished.nextStep,
      byStep(finished).resources_provisioned.status,
      byStep(finished).resources_provisioned.evidence.webhook,
    ],
    ["management_access", "met", "recorded"],
  );
  rmSync(join(root, ".commish/setup/test/webhook.json"));
  rmSync(join(root, ".commish/setup/test/webhook.env"));
  // Restoring the configuration settles it either way.
  write(root, "commish.setup.json", config, 0o644);
  const none = await read();
  assert.deepEqual(
    [
      none.nextStep,
      byStep(none).resources_provisioned.status,
      byStep(none).resources_provisioned.evidence.webhook,
    ],
    ["management_access", "met", "not_configured"],
  );
  write(root, "commish.setup.json", { ...config, webhook: hook }, 0o644);
  intent(root, { ...config, webhook: hook });
  const owed = await read();
  assert.deepEqual(
    [
      byStep(owed).resources_provisioned.status,
      byStep(owed).resources_provisioned.evidence.webhook,
      owed.next,
    ],
    ["unmet", "configured", provision()],
  );
  // A configuration that is present but incomplete says nothing about the webhook either.
  write(root, "commish.setup.json", { version: 1, stripe: "later" }, 0o644);
  const partial = await read();
  assert.deepEqual(
    [
      partial.nextStep,
      byStep(partial).resources_provisioned.status,
      byStep(partial).resources_provisioned.reason,
    ],
    ["configuration", "unknown", "webhook_request_not_recorded"],
  );
});

test("a configuration that is not the recorded setup is a conflict, and nothing recorded counts for it", async (t) => {
  const root = directory(t);
  const read = (args = [], env = {}) => executeStatus(args, { root, env, fetcher: noRequest });
  const restore = {
    kind: "guidance",
    guidance:
      "The configuration, mode or app URL differs from the setup recorded in .commish/setup/test, so rerunning setup fails with setup_config_conflict. Restore the original configuration, or repeat the original commish setup command if it was started with other flags; inspect .commish/setup/test before starting a separate setup.",
    humanAction: "open_the_approval_url_and_confirm_the_pairing_code",
  };
  const conflicted = (result) => {
    assert.deepEqual(byStep(result).configuration, {
      step: "configuration",
      status: "unmet",
      evidence: {
        source: "commish.setup.json",
        configuration: "ready",
        setupStartedAt: "2026-11-14T12:04:40.049Z",
        matchesRecordedSetup: false,
      },
      reason: "setup_config_conflict",
      next: restore,
    });
    assert.deepEqual(
      [result.status, result.nextStep, result.next],
      ["incomplete", "configuration", restore],
    );
    // No step is met for this configuration, and no command that would fail is offered.
    for (const item of result.steps.slice(0, 3)) {
      assert.notEqual(item.status, "met", item.step);
      assert.deepEqual([item.reason, item.next], ["setup_config_conflict", restore], item.step);
    }
    assert(!JSON.stringify(result).includes("commish setup --config"));
  };
  // 1. Started with a webhook, interrupted after the credential, then edited to no webhook.
  provisioned(root);
  intent(root, { ...config, webhook: hook });
  const edited = await read();
  conflicted(edited);
  assert.deepEqual(
    [byStep(edited).setup_approved.status, byStep(edited).resources_provisioned.status],
    ["unknown", "unknown"],
  );
  // The file as it was is the recorded setup again: the webhook is still owed.
  write(root, "commish.setup.json", { ...config, webhook: hook }, 0o644);
  const original = await read();
  assert.deepEqual(
    [
      byStep(original).configuration.status,
      byStep(original).configuration.evidence.matchesRecordedSetup,
      byStep(original).resources_provisioned.status,
      original.next,
    ],
    ["met", true, "unmet", provision()],
  );
  // 2. A finished setup whose application name was changed afterwards.
  intent(root);
  write(root, "commish.setup.json", config, 0o644);
  assert.deepEqual(
    (await read()).steps.slice(0, 3).map((item) => item.status),
    ["met", "met", "met"],
  );
  write(root, "commish.setup.json", { ...config, application: { name: "Renamed" } }, 0o644);
  conflicted(await read());
  // Even a fully recorded webhook does not make it this configuration's setup.
  write(root, ".commish/setup/test/webhook.json", { id: "whe_123456789012" });
  write(
    root,
    ".commish/setup/test/webhook.env",
    `COMMISH_WEBHOOK_SIGNING_SECRET=whsec_${"w".repeat(32)}\n`,
  );
  conflicted(await read());
  rmSync(join(root, ".commish/setup/test/webhook.json"));
  rmSync(join(root, ".commish/setup/test/webhook.env"));
  // 3. Interrupted before provisioning, then edited: the resume command could not succeed.
  for (const name of ["application", "program", "credential"])
    rmSync(join(root, `.commish/setup/test/${name}.json`));
  rmSync(join(root, ".commish/setup/test/credentials.env"));
  const interrupted = await read();
  conflicted(interrupted);
  assert.deepEqual(
    [byStep(interrupted).setup_approved.status, byStep(interrupted).resources_provisioned.status],
    ["unknown", "unmet"],
  );
  const output = [];
  await runStatusCommand([], { root, env: {}, fetcher: noRequest, out: (v) => output.push(v) });
  assert.match(
    output[0],
    /\n {2}unmet {10}configuration \(setup_config_conflict\)\n {2}unknown {8}setup_approved \(setup_config_conflict\)\n[\s\S]*\nNext \(configuration\): The configuration, mode or app URL differs /,
  );
});

test("the mode and the app URL are part of the recorded setup, as they are for setup", async (t) => {
  const root = directory(t);
  const read = (args = []) => executeStatus(args, { root, env: {}, fetcher: noRequest });
  // Setup run against another deployment: the same file is a different setup elsewhere.
  write(root, "commish.setup.json", config, 0o644);
  intent(root, config, "http://localhost:3000");
  write(root, ".commish/setup/test/workspace.json", { id: workspaceId });
  assert.equal(byStep(await read()).configuration.reason, "setup_config_conflict");
  const local = await read(["--app-url", "http://localhost:3000"]);
  assert.deepEqual(
    [byStep(local).configuration.status, byStep(local).setup_approved.status, local.next.command],
    [
      "met",
      "met",
      "commish setup --config commish.setup.json --mode test --app-url http://localhost:3000 --no-open --non-interactive --json",
    ],
  );
  for (const url of ["http://remote.example", "https://app.commish.sh/path", "not a url"])
    await assert.rejects(read(["--app-url", url]), { message: "invalid_arguments" });
  // --mode replaces the file's mode before the comparison, exactly as setup applies it.
  intent(root, { ...config, mode: "live" });
  write(root, ".commish/setup/live/workspace.json", { id: workspaceId });
  const live = await read(["--mode", "live"]);
  assert.deepEqual(
    [live.mode, byStep(live).configuration.status, byStep(live).setup_approved.status],
    ["live", "met", "met"],
  );
  // A LIVE setup recorded from a file that said test is not the file's own LIVE setup.
  write(root, "commish.setup.json", { ...config, mode: "live", stripe: "later" }, 0o644);
  assert.equal(byStep(await read()).configuration.reason, "setup_config_conflict");
});

test("a recorded key without its file gets guidance, because setup would refuse to continue", async (t) => {
  const root = directory(t);
  provisioned(root);
  rmSync(join(root, ".commish/setup/test/credentials.env"));
  const missing = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    [
      byStep(missing).resources_provisioned.status,
      byStep(missing).resources_provisioned.reason,
      missing.nextStep,
      missing.next,
    ],
    [
      "unmet",
      "setup_credential_missing",
      "resources_provisioned",
      {
        kind: "guidance",
        guidance:
          "Setup will not regenerate or replace .commish/setup/test/credentials.env and fails with setup_credential_missing. Restore the file as setup wrote it, or revoke the recorded key (commish manage credentials.revoke) before starting a separate setup.",
      },
    ],
  );
  // A signing-secret file that is not one setup wrote blocks a rerun the same way.
  provisioned(root, { webhook: true });
  write(
    root,
    ".commish/setup/test/webhook.env",
    "COMMISH_WEBHOOK_SIGNING_SECRET=private-fixture\n",
  );
  const altered = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    [
      byStep(altered).resources_provisioned.status,
      byStep(altered).resources_provisioned.evidence.webhookFile,
      byStep(altered).resources_provisioned.reason,
      altered.next,
    ],
    [
      "unmet",
      "invalid",
      "setup_file_conflict",
      {
        kind: "guidance",
        guidance:
          "Setup will not replace .commish/setup/test/webhook.env and fails with setup_file_conflict. Remove the altered file, then rerun the same commish setup command, which saves the signing secret again.",
      },
    ],
  );
  assert(!JSON.stringify(altered).includes("private-fixture"));
  rmSync(join(root, ".commish/setup/test/webhook.json"));
  rmSync(join(root, ".commish/setup/test/webhook.env"));
  rmSync(join(root, ".commish/setup/test/credentials.env"));
  // Before the key is recorded, setup writes the file itself: the ordinary command resumes.
  rmSync(join(root, ".commish/setup/test/credential.json"));
  const fresh = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    [byStep(fresh).resources_provisioned.reason, fresh.next],
    [undefined, provision()],
  );
});

test("with a conflicting configuration, later actions take nothing from it", async (t) => {
  const root = directory(t);
  provisioned(root);
  const file = grantFile(root, "a");
  write(
    root,
    "commish.setup.json",
    { ...config, destination: { ...config.destination, origin: "https://other.example" } },
    0o644,
  );
  const result = await executeStatus([], {
    root,
    env: {},
    fetcher: server([[file, "authorized"]], { checks: { verified_origin: "unmet" } }).fetcher,
  });
  // The recorded program is still read from the server, but the install is not complete,
  // the first action is to restore the configuration, and no command quotes the edited file.
  assert.deepEqual(
    [result.status, result.nextStep, byStep(result).configuration.reason],
    ["incomplete", "configuration", "setup_config_conflict"],
  );
  assert.deepEqual(
    [byStep(result).destination_verified.status, byStep(result).destination_verified.next.body],
    ["unmet", { applicationId, origin: "<origin>" }],
  );
  assert(!JSON.stringify(result).includes("other.example"));
});

// A printed command has to run as written, in the environment status ran in and
// against the deployment status addressed. These helpers run each one through
// the executable. Every endpoint in these scenarios is a closed loopback port,
// and `run` refuses a command that could reach anything else.
const executable = fileURLToPath(new URL("../packages/sdk/bin/init.mjs", import.meta.url)),
  loop = "http://127.0.0.1:1",
  loopApi = `${loop}/api/management/v1`;
const commandsOf = (action) =>
  action ? [...(action.kind === "command" ? [action] : []), ...commandsOf(action.followedBy)] : [];
function run(root, env, command, substitute = {}) {
  const line = Object.entries(substitute).reduce(
    (text, [from, to]) => text.replaceAll(from, to),
    command,
  );
  // Nothing that needs quoting, and no placeholder left to fill in.
  assert.match(line, /^commish [A-Za-z0-9 ._/:,=-]+$/, line);
  const argv = line.split(" ").slice(1),
    file = argv.includes("--auth-file") ? argv[argv.indexOf("--auth-file") + 1] : null;
  assert(
    argv.includes("--plan") ||
      line.includes(loop) ||
      (!line.includes("-url ") && env.COMMISH_MANAGEMENT_URL === loopApi) ||
      (file && JSON.parse(readFileSync(join(root, file), "utf8")).baseUrl === loopApi),
    `refusing to run a command that could reach a real deployment: ${line}`,
  );
  const result = spawnSync(process.execPath, [executable, ...argv], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: process.env.PATH, ...env },
  });
  const receipt = JSON.parse(result.stdout.trim() || result.stderr.trim().split("\n").at(-1));
  return { exit: result.status, outcome: receipt.code ?? receipt.status, receipt };
}
// The closed port answers nothing, so a command that got as far as its request
// ends in service_unavailable: its arguments, files and environment were accepted.
const reached = { exit: 1, outcome: "service_unavailable" };

test("every command status prints runs as written, in the same environment and against the same deployment", async (t) => {
  const onboarding =
    "resources.read,diagnostics.read,programs.read,programs.write,terms.read,terms.write,destinations.read,destinations.write,credentials.read";
  const scenario = async (name, { prepare, args = [], env = {}, grants = [], report }, check) => {
    const root = directory(t);
    const files = prepare(root) ?? {};
    const result = await executeStatus(args, {
      root,
      env,
      fetcher: server(
        grants.map(([key, state]) => [files[key], state]),
        { base: loopApi, ...report },
      ).fetcher,
    });
    const commands = result.steps.flatMap((item) => commandsOf(item.next));
    // No bearer or key material in any action.
    for (const secret of [...Object.values(files).map((file) => file.token), "k".repeat(43)])
      assert(!JSON.stringify(result).includes(secret), name);
    await check({ root, env, files, result, commands, next: result.next });
  };
  const only = (commands) => [...new Set(commands.map((action) => action.command))];

  // Planning: the flags status was given are carried, COMMISH_MODE is not consulted.
  await scenario(
    "plan",
    { prepare: () => {}, env: { COMMISH_MODE: "live" } },
    ({ root, env, next }) => {
      assert.equal(next.command, "commish setup --plan --json");
      assert.deepEqual(
        [run(root, env, next.command).exit, run(root, env, next.command).outcome],
        [2, "plan"],
      );
    },
  );
  await scenario(
    "plan with flags",
    {
      prepare: (root) => write(root, "partial.json", { version: 1, stripe: "later" }, 0o644),
      args: ["--config", "partial.json", "--mode", "live", "--app-url", loop],
    },
    ({ root, env, next }) => {
      assert.equal(
        next.command,
        `commish setup --config partial.json --mode live --app-url ${loop} --plan --json`,
      );
      const planned = run(root, env, next.command);
      assert.deepEqual([planned.exit, planned.outcome], [2, "plan"]);
    },
  );
  // Provisioning: the same file, mode and deployment, whatever the shell's mode is.
  await scenario(
    "provision",
    {
      prepare: (root) => write(root, "named.json", config, 0o644),
      args: ["--config", "named.json", "--app-url", loop],
      env: { COMMISH_MODE: "live", COMMISH_MANAGEMENT_TOKEN: `cm_mgmt_test_${"z".repeat(43)}` },
    },
    ({ root, env, commands }) => {
      assert.deepEqual(only(commands), [
        `commish setup --config named.json --mode test --app-url ${loop} --no-open --non-interactive --json`,
      ]);
      // Setup does not read the management token, so nothing has to be unset.
      assert(commands.every((action) => action.environment === undefined));
      assert.deepEqual(
        (({ exit, outcome }) => ({ exit, outcome }))(run(root, env, commands[0].command)),
        reached,
      );
    },
  );
  // A new grant: the endpoint comes from the environment, so no flag is needed.
  await scenario(
    "login, endpoint from the environment",
    { prepare: provisioned, env: { COMMISH_MANAGEMENT_URL: loopApi, COMMISH_MODE: "live" } },
    ({ root, env, next }) => {
      assert.equal(
        next.command,
        `commish auth login --workspace ${workspaceId} --workspace-scope --onboarding --scopes ${onboarding} --mode test --no-open --non-interactive --json`,
      );
      assert.equal(next.environment, undefined);
      const login = run(root, env, next.command);
      assert.deepEqual([login.exit, login.outcome], [1, "service_unavailable"]);
    },
  );
  // A stored grant's own endpoint: the replacement login is sent there, not to production.
  await scenario(
    "login, endpoint from the stored grant",
    {
      prepare: (root) => {
        provisioned(root);
        return { old: grantFile(root, "a", {}, loopApi) };
      },
      grants: [["old", "expired"]],
    },
    ({ root, env, next }) => {
      assert.equal(
        next.command,
        `commish auth login --workspace ${workspaceId} --workspace-scope --onboarding --scopes ${onboarding} --mode test --management-url ${loopApi} --no-open --non-interactive --json`,
      );
      const login = run(root, env, next.command);
      assert.deepEqual([login.exit, login.outcome], [1, "service_unavailable"]);
    },
  );
  // --app-url names the deployment for the login as well.
  await scenario(
    "login, endpoint from --app-url",
    {
      prepare: (root) => {
        provisioned(root);
        intent(root, config, loop);
      },
      args: ["--app-url", loop],
    },
    ({ root, env, result, next }) => {
      assert.equal(byStep(result).configuration.status, "met");
      assert.match(next.command, new RegExp(` --mode test --management-url ${loopApi} --no-open `));
      assert.deepEqual(
        (({ exit, outcome }) => ({ exit, outcome }))(run(root, env, next.command)),
        reached,
      );
    },
  );
  // A token in the environment: the login says it has to be unset, and that is true.
  for (const [state, patch] of [
    ["expired", {}],
    ["revoked", {}],
    ["authorized", { scopes: ["programs.read"] }],
    ["authorized", { workspaceId: "wrk_999999999999" }],
  ]) {
    const holder = {};
    await scenario(
      `login beside a ${state} token`,
      {
        prepare: (root) => {
          provisioned(root);
          holder.grant = grantFile(root, "a", patch, loopApi);
          rmSync(join(root, ".commish/management"), { recursive: true });
          return { token: holder.grant };
        },
        args: ["--management-url", loopApi],
        env: { COMMISH_MANAGEMENT_TOKEN: `cm_mgmt_test_${"a".repeat(43)}` },
        grants: [["token", state]],
      },
      ({ root, env, result, next }) => {
        assert.equal(byStep(result).management_access.evidence.source, "COMMISH_MANAGEMENT_TOKEN");
        assert.deepEqual(next.environment, { unset: ["COMMISH_MANAGEMENT_TOKEN"] });
        assert.match(next.command, new RegExp(` --management-url ${loopApi} `));
        // As the environment stands the command is refused; with the variable unset it runs.
        assert.equal(run(root, env, next.command).outcome, "ambiguous_authorization");
        const { COMMISH_MANAGEMENT_TOKEN: _, ...cleared } = env;
        assert.equal(run(root, cleared, next.command).outcome, "service_unavailable");
      },
    );
  }
  // A pending request is resumed from its own file, which carries its endpoint.
  await scenario(
    "resume",
    {
      prepare: (root) => {
        provisioned(root);
        return { pending: grantFile(root, "a", {}, loopApi) };
      },
      env: { COMMISH_MODE: "live" },
      grants: [["pending", "pending"]],
    },
    ({ root, env, files, next }) => {
      assert.equal(
        next.command,
        `commish auth login --auth-file ${files.pending.path} --mode test --no-open --non-interactive --json`,
      );
      const resumed = run(root, env, next.command);
      assert.deepEqual([resumed.exit, resumed.outcome], [1, "service_unavailable"]);
    },
  );
  // A pending request named by the caller is resumed from that path too.
  await scenario(
    "resume a named file",
    {
      prepare: (root) => {
        provisioned(root);
        const stored = grantFile(root, "a", {}, loopApi);
        mkdirSync(join(root, "grants"));
        writeFileSync(join(root, "grants/pending.json"), readFileSync(join(root, stored.path)), {
          mode: 0o600,
        });
        rmSync(join(root, ".commish/management"), { recursive: true });
        return { pending: stored };
      },
      args: ["--auth-file", "grants/pending.json"],
      grants: [["pending", "pending"]],
    },
    ({ root, env, next }) => {
      assert.equal(
        next.command,
        "commish auth login --auth-file grants/pending.json --mode test --no-open --non-interactive --json",
      );
      assert.equal(run(root, env, next.command).outcome, "service_unavailable");
    },
  );
  // LIVE: a read-only session on the deployment status was pointed at.
  await scenario(
    "LIVE login",
    {
      prepare: (root) => {
        write(root, "commish.setup.json", { ...config, mode: "live" }, 0o644);
        write(root, ".commish/setup/live/workspace.json", { id: workspaceId });
      },
      args: ["--management-url", loopApi],
      env: { COMMISH_MODE: "test" },
    },
    ({ root, env, result }) => {
      const login = byStep(result).management_access.next;
      assert.equal(
        login.command,
        `commish auth login --workspace ${workspaceId} --workspace-scope --scopes resources.read,diagnostics.read,programs.read,terms.read,destinations.read --mode live --management-url ${loopApi} --no-open --non-interactive --json`,
      );
      assert.equal(run(root, env, login.command).outcome, "service_unavailable");
    },
  );
});

test("every command the remaining steps print runs as written too, with the grant it names", async (t) => {
  const onboarding =
    "resources.read,diagnostics.read,programs.read,programs.write,terms.read,terms.write,destinations.read,destinations.write,credentials.read";
  // Everything a diagnostics-backed step can ask for at once.
  const open = {
    testActivatedAt: null,
    checks: {
      verified_origin: "unmet",
      program_active: "unmet",
      attributed_checkout: "unmet",
      attributed_conversion_observed: "unmet",
      commission_observed: "unmet",
    },
  };
  const full = [...scopes, "resources.read"];
  // Each command an action carries: its own, the one inside `before`, and those that follow.
  const expand = (action) =>
    commandsOf(action).flatMap((item) => [
      ...(/(commish manage [^\n]+)$/.exec(item.before ?? "") ?? [])
        .slice(1)
        .map((command) => ({ command, environment: item.environment })),
      item,
    ]);
  const printed = (result) =>
    ["destination_verified", "program_active", "rehearsal"].flatMap((step) =>
      expand(byStep(result)[step].next),
    );
  // Runs one action: writes the body it names, then the command as written.
  const exercise = (root, env, action, substitute) => {
    if (action.bodyFile) writeFileSync(join(root, action.bodyFile), JSON.stringify(action.body));
    return run(root, env, action.command, substitute).outcome;
  };
  const stage = async ({ prepare, args = [], env = {}, state = "authorized", report = open }) => {
    const root = directory(t);
    const file = prepare(root);
    const result = await executeStatus(args, {
      root,
      env,
      fetcher: server([[file, state]], { base: loopApi, ...report }).fetcher,
    });
    assert(!JSON.stringify(result).includes(file.token));
    return { root, env, file, result, actions: printed(result) };
  };
  const stored = (patch) => (root) => {
    provisioned(root);
    return grantFile(root, "a", patch, loopApi);
  };
  const token = (patch) => (root) => {
    const grant = stored(patch)(root);
    rmSync(join(root, ".commish/management"), { recursive: true });
    return grant;
  };
  const bearer = `cm_mgmt_test_${"a".repeat(43)}`;

  // 1. The onboarding grant from a stored file, in a shell that says LIVE.
  const held = await stage({ prepare: stored(), env: { COMMISH_MODE: "live" } });
  const auth = ` --auth-file ${held.file.path} --mode test --json`;
  assert.deepEqual(
    held.actions.map((action) => action.command),
    [
      `commish manage destinations.verify --body-file commish-destination.json${auth}`,
      `commish manage terms.list --program ${programId}${auth}`,
      `commish manage programs.activate --body-file commish-activate.json${auth}`,
      `commish test rehearsal --program ${programId}${auth}`,
    ],
  );
  for (const action of held.actions) {
    assert.equal(action.environment, undefined);
    assert.equal(exercise(held.root, held.env, action), "service_unavailable", action.command);
  }

  // 2. The same grant as a token: no file to name; the endpoint is carried when
  //    the command would not find it by itself, and left out when it would.
  for (const [args, env, endpoint] of [
    [
      ["--management-url", loopApi],
      { COMMISH_MANAGEMENT_TOKEN: bearer },
      ` --management-url ${loopApi}`,
    ],
    [[], { COMMISH_MANAGEMENT_TOKEN: bearer, COMMISH_MANAGEMENT_URL: loopApi }, ""],
    [["--app-url", loop], { COMMISH_MANAGEMENT_TOKEN: bearer }, ` --management-url ${loopApi}`],
  ]) {
    const byToken = await stage({
      prepare: (root) => {
        const grant = token({ scopes: full })(root);
        if (args.includes("--app-url")) intent(root, config, loop);
        return grant;
      },
      args,
      env,
    });
    assert.deepEqual(
      byToken.actions.map((action) => action.command),
      [
        `commish manage destinations.verify --body-file commish-destination.json${endpoint} --mode test --json`,
        `commish manage terms.list --program ${programId}${endpoint} --mode test --json`,
        `commish manage programs.activate --body-file commish-activate.json${endpoint} --mode test --json`,
        `commish test rehearsal --program ${programId}${endpoint} --mode test --json`,
      ],
    );
    for (const action of byToken.actions)
      assert.equal(
        exercise(byToken.root, byToken.env, action),
        "service_unavailable",
        action.command,
      );
  }

  // 3. A read-only stored grant: the login goes to that grant's deployment, and
  //    what follows runs with the file the login leaves behind.
  const reader = await stage({
    prepare: stored({ kind: "session", scopes: ["diagnostics.read"], expiresIn: 3600 }),
  });
  const login = `commish auth login --workspace ${workspaceId} --workspace-scope --onboarding --scopes ${onboarding} --mode test --management-url ${loopApi} --no-open --non-interactive --json`;
  for (const step of ["destination_verified", "program_active", "rehearsal"]) {
    const action = byStep(reader.result)[step].next;
    assert.deepEqual([action.command, action.environment], [login, undefined], step);
    const started = run(reader.root, reader.env, action.command);
    assert.equal(started.outcome, "service_unavailable", step);
    // auth login stores its request before it asks, and names the file.
    const granted = { "<authorizationFile>": started.receipt.authorizationFile };
    assert.match(
      granted["<authorizationFile>"],
      /^\.commish\/management\/[0-9a-f]{24}\/authorization\.json$/,
    );
    const follows = expand(action.followedBy);
    assert.equal(follows.length, step === "program_active" ? 2 : 1, step);
    for (const follow of follows) {
      assert(
        follow.command.endsWith(" --auth-file <authorizationFile> --mode test --json"),
        follow.command,
      );
      assert.equal(
        exercise(reader.root, reader.env, follow, granted),
        "service_unavailable",
        follow.command,
      );
    }
  }

  // 4. A read-only token: the login and what follows both need the variable unset.
  const limited = await stage({
    prepare: token({ kind: "session", scopes: ["diagnostics.read"], expiresIn: 3600 }),
    args: ["--management-url", loopApi],
    env: { COMMISH_MANAGEMENT_TOKEN: bearer },
  });
  const { COMMISH_MANAGEMENT_TOKEN: _, ...cleared } = limited.env;
  const first = byStep(limited.result).program_active.next;
  assert.deepEqual(
    [first.command, first.environment, first.followedBy.environment],
    [login, { unset: ["COMMISH_MANAGEMENT_TOKEN"] }, { unset: ["COMMISH_MANAGEMENT_TOKEN"] }],
  );
  assert.equal(run(limited.root, limited.env, first.command).outcome, "ambiguous_authorization");
  const begun = run(limited.root, cleared, first.command);
  assert.equal(begun.outcome, "service_unavailable");
  const file = { "<authorizationFile>": begun.receipt.authorizationFile };
  assert.equal(
    exercise(limited.root, limited.env, first.followedBy, file),
    "ambiguous_authorization",
  );
  assert.equal(exercise(limited.root, cleared, first.followedBy, file), "service_unavailable");

  // 5. LIVE with the read-only session status itself asks for: a write session
  //    with exactly the scopes the write needs, on the same deployment.
  const live = await stage({
    prepare: (root) => {
      write(root, "commish.setup.json", { ...config, mode: "live" }, 0o644);
      for (const [name, id] of [
        ["workspace", workspaceId],
        ["application", applicationId],
        ["program", programId],
        ["credential", "key_123456789012"],
      ])
        write(root, `.commish/setup/live/${name}.json`, { id });
      write(
        root,
        ".commish/setup/live/credentials.env",
        `COMMISH_MODE=live\nCOMMISH_APPLICATION_ID=${applicationId}\nCOMMISH_PROGRAM_ID=${programId}\n` +
          `COMMISH_PUBLISHABLE_KEY=cm_live_pk_${"p".repeat(32)}\nCOMMISH_SECRET_KEY=cm_live_sk_${"k".repeat(43)}\n`,
      );
      return grantFile(
        root,
        "b",
        {
          mode: "live",
          kind: "session",
          scopes: ["diagnostics.read", "terms.read"],
          expiresIn: 3600,
        },
        loopApi,
      );
    },
    env: { COMMISH_MODE: "test" },
    report: { mode: "live", checks: { program_active: "unmet" } },
  });
  const activate = byStep(live.result).program_active.next;
  assert.equal(
    activate.command,
    `commish auth login --workspace ${workspaceId} --workspace-scope --scopes terms.read,programs.write --mode live --management-url ${loopApi} --no-open --non-interactive --json`,
  );
  const session = run(live.root, live.env, activate.command);
  assert.equal(session.outcome, "service_unavailable");
  assert.equal(
    exercise(live.root, live.env, activate.followedBy, {
      "<authorizationFile>": session.receipt.authorizationFile,
    }),
    "service_unavailable",
  );
});

test("with nothing pointing elsewhere, the suggested login goes to the default deployment", async (t) => {
  const root = directory(t);
  provisioned(root);
  const result = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert(!result.next.command.includes("-url"));
  // Never run for real: its arguments are parsed in process and the request is captured.
  const requests = [];
  await assert.rejects(
    executeAuth(result.next.command.split(" ").slice(2), {
      root,
      env: {},
      fetcher: async (url, init) => {
        requests.push([init.method, url, JSON.parse(init.body).workspaceId]);
        return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
      },
    }),
    { message: "service_unavailable" },
  );
  assert.deepEqual(requests, [["POST", `${api}/grants`, workspaceId]]);
});
