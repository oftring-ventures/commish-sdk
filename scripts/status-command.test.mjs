import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setupFingerprint } from "../packages/sdk/bin/setup-progress.mjs";
import {
  executeStatus,
  runStatusCommand,
  statusHelp,
} from "../packages/sdk/bin/status-command.mjs";

const workspaceId = "wrk_123456789012",
  applicationId = "app_123456789012",
  programId = "prg_123456789012";
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
          webhook: "unknown",
          credentialsFile: "absent",
        },
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
      { kind: "command", command: "commish setup --config <config> --plan --json" },
    ],
  );
  rmSync(join(root, "partial.json"));
  // The path given to --config is never repeated.
  assert(!JSON.stringify([ready, named]).includes(".json --"));
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
    ["met", "met", "unmet"],
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
    [done.status, done.workspaceId, done.applicationId, done.programId, done.nextStep, done.next],
    ["complete", workspaceId, applicationId, programId, null, null],
  );
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
    live.steps.map((item) => item.status),
    ["met", "unmet", "unmet"],
  );
  assert.match(live.next.command, / --mode live /);
  // A setup started from flags has no configuration file but did have its choices.
  rmSync(join(root, "commish.setup.json"));
  const flags = await executeStatus([], { root, env: {}, fetcher: noRequest });
  assert.deepEqual(
    [flags.steps[0].status, flags.steps[0].evidence.configuration],
    ["met", "missing"],
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
  assert.equal(delivered.status, "complete");
  assert(!JSON.stringify(delivered).includes("w".repeat(32)));
  rmSync(join(root, ".commish/setup/test/webhook.json"));
  rmSync(join(root, ".commish/setup/test/webhook.env"));
  write(root, "commish.setup.json", config, 0o644);
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
});

test("text is the default output, --json one object, and errors are sanitized", async (t) => {
  const root = directory(t);
  const run = async (args) => {
    const output = [],
      errors = [];
    const code = await runStatusCommand(args, {
      root,
      env: {},
      fetcher: noRequest,
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
  // Recorded progress that does not parse is an error, never a guess.
  write(root, ".commish/setup/test/program.json", { id: "private-fixture" });
  const broken = await run([]);
  assert.deepEqual(
    [broken.code, broken.output, broken.errors],
    [1, [], ["Status failed: invalid_setup_progress."]],
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
  assert.equal((await executeStatus([], { root, env: {}, fetcher: noRequest })).status, "complete");
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
    /\n {2}unknown {8}resources_provisioned \(webhook_request_not_recorded\)\nNext \(resources_provisioned\): Setup was started from flags, /,
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
      finished.status,
      byStep(finished).resources_provisioned.status,
      byStep(finished).resources_provisioned.evidence.webhook,
    ],
    ["complete", "met", "recorded"],
  );
  rmSync(join(root, ".commish/setup/test/webhook.json"));
  rmSync(join(root, ".commish/setup/test/webhook.env"));
  // Restoring the configuration settles it either way.
  write(root, "commish.setup.json", config, 0o644);
  const none = await read();
  assert.deepEqual(
    [none.status, byStep(none).resources_provisioned.evidence.webhook],
    ["complete", "not_configured"],
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
  assert.equal((await read()).status, "complete");
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
      "commish setup --config commish.setup.json --mode test --app-url <app-url> --no-open --non-interactive --json",
    ],
  );
  assert(!JSON.stringify(local).includes("localhost"));
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
