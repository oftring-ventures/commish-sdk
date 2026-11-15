import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeApi } from "../packages/sdk/bin/api-command.mjs";
import { executeAuth } from "../packages/sdk/bin/auth-command.mjs";
import { errorReceipt } from "../packages/sdk/bin/cli-http.mjs";
import { executeDoctor } from "../packages/sdk/bin/doctor-command.mjs";
import { executeKeys } from "../packages/sdk/bin/keys-command.mjs";
import { executeManagement } from "../packages/sdk/bin/management-command.mjs";
import { executeTest } from "../packages/sdk/bin/test-command.mjs";

const bin = fileURLToPath(new URL("../packages/sdk/bin/", import.meta.url));
const noRequest = () => assert.fail("unexpected network request");
const secret = { COMMISH_SECRET_KEY: "cm_test_sk_fixture123456789" };
const grant = { COMMISH_MANAGEMENT_TOKEN: `cm_mgmt_test_${"s".repeat(43)}` };
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "commish-non-interactive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("no command reads the terminal, so there is nothing for --non-interactive to switch off", () => {
  const sources = [
    ...readdirSync(bin).map((name) => join(bin, name)),
    fileURLToPath(new URL("../launcher/bin/commish.mjs", import.meta.url)),
  ].filter((path) => path.endsWith(".mjs"));
  assert(sources.length > 20);
  for (const path of sources)
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /node:readline|node:tty|process\.stdin|\.question\(|\bprompt\(/,
      path,
    );
});

test("a missing input fails before any request and is named the way it is supplied", async (t) => {
  const root = directory(t);
  writeFileSync(join(root, "body.json"), "{}");
  const cases = [
    [executeApi, ["api", "getProgram"], secret, "missing_input", ["--param programId=<value>"]],
    [executeApi, ["programs", "retrieve"], secret, "missing_input", ["<programId>"]],
    [
      executeApi,
      ["api", "lookupConversion"],
      secret,
      "missing_input",
      ["--query externalId=<value>"],
    ],
    [
      executeApi,
      ["customers", "identify"],
      secret,
      "mutation_input_required",
      ["--body-file <path>", "--idempotency-key <identity>"],
    ],
    [
      executeApi,
      ["customers", "identify", "--body-file", "body.json"],
      secret,
      "mutation_input_required",
      ["--idempotency-key <identity>"],
    ],
    [executeApi, ["customers", "list"], {}, "invalid_configuration", ["COMMISH_SECRET_KEY"]],
    [executeManagement, ["terms.list"], grant, "missing_input", ["--program <id>"]],
    [
      executeManagement,
      ["programs.activate"],
      grant,
      "mutation_input_required",
      ["--body-file <path>"],
    ],
    [
      executeManagement,
      ["webhooks.secret", "--body-file", "body.json"],
      grant,
      "missing_input",
      ["--output-file <.commish/path>"],
    ],
    [
      executeManagement,
      ["programs.list"],
      {},
      "management_authorization_required",
      ["--auth-file <path> or COMMISH_MANAGEMENT_TOKEN"],
    ],
    [executeDoctor, [], grant, "missing_input", ["--program <id>"]],
    [
      executeAuth,
      ["login"],
      {},
      "missing_input",
      [
        "--workspace <id>",
        "--application <id> or --workspace-scope",
        "--scopes <comma-separated scopes>",
      ],
    ],
    [
      executeAuth,
      ["login", "--workspace", "wrk_123456789012", "--workspace-scope"],
      {},
      "missing_input",
      ["--scopes <comma-separated scopes>"],
    ],
    [
      executeKeys,
      ["rotate"],
      grant,
      "missing_input",
      [
        "--application <id> or --workspace-scope",
        "--key <id>",
        "--label <label>",
        "--idempotency-key <identity>",
      ],
    ],
    [
      executeKeys,
      ["create", "--workspace-scope", "--label", "Server"],
      grant,
      "missing_input",
      ["--idempotency-key <identity>"],
    ],
    [executeTest, ["fixture"], {}, "missing_input", ["--program <id>"]],
    [executeTest, ["rehearsal"], grant, "missing_input", ["--program <id>"]],
    [executeTest, ["webhook"], {}, "missing_input", ["--url <loopback-url>"]],
  ];
  // The flag changes nothing: the same error names the same inputs either way.
  for (const [execute, args, env, code, missing] of cases)
    for (const flags of [[], ["--non-interactive"], ["--non-interactive", "--json"]]) {
      const label = [...args, ...flags].join(" ");
      const error = await execute([...args, ...flags], { root, env, fetcher: noRequest }).then(
        () => assert.fail(label),
        (error) => error,
      );
      assert.deepEqual(errorReceipt(error), { version: 1, status: "error", code, missing }, label);
    }
  assert.deepEqual(readdirSync(root), ["body.json"]);
});

test("a malformed value is refused without being named or echoed", async (t) => {
  const root = directory(t);
  for (const [execute, args, env] of [
    [executeDoctor, ["--program", "private-fixture"], grant],
    [executeApi, ["api", "getProgram", "--param", "programId=private-fixture"], secret],
    [
      executeAuth,
      ["login", "--workspace", "private-fixture", "--workspace-scope", "--scopes", "x"],
      {},
    ],
    [executeTest, ["fixture", "--program", "private-fixture"], {}],
  ]) {
    const error = await execute(args, { root, env, fetcher: noRequest }).then(
      () => assert.fail(args.join(" ")),
      (error) => error,
    );
    assert.deepEqual(errorReceipt(error), {
      version: 1,
      status: "error",
      code: error.message,
    });
    assert.notEqual(error.message, "missing_input");
  }
  // A set but malformed credential is not reported as missing.
  await assert.rejects(
    executeApi(["customers", "list"], {
      root,
      env: { COMMISH_SECRET_KEY: "private-fixture" },
      fetcher: noRequest,
    }),
    (error) => error.message === "invalid_configuration" && error.detail.missing === undefined,
  );
});

test("verify and init accept the flag, and verify names the variables that are not set", (t) => {
  const root = directory(t);
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [join(bin, "init.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH, COMMISH_API_URL: "http://127.0.0.1:1/api/v1", ...env },
    });
  for (const args of [
    ["verify", "--json"],
    ["verify", "--non-interactive", "--json"],
  ]) {
    const result = run(args);
    assert.deepEqual([result.status, result.stdout], [1, ""]);
    assert.deepEqual(JSON.parse(result.stderr), {
      status: "error",
      code: "invalid_configuration",
      missing: [
        "COMMISH_SECRET_KEY",
        "COMMISH_PUBLISHABLE_KEY",
        "COMMISH_APPLICATION_ID",
        "COMMISH_PROGRAM_ID",
      ],
      integrationVerified: false,
    });
  }
  const partial = run(["verify", "--non-interactive", "--json"], {
    COMMISH_SECRET_KEY: "private-fixture",
    NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY: "cm_test_pk_fixture123456789",
    NEXT_PUBLIC_COMMISH_APPLICATION_ID: "app_123456789012",
  });
  assert.deepEqual(JSON.parse(partial.stderr).missing, ["COMMISH_PROGRAM_ID"]);
  assert(!partial.stderr.includes("private-fixture"));
  assert.match(run(["verify"]).stderr, /Not set: COMMISH_SECRET_KEY, /);
  assert.equal(run(["verify", "--help", "--non-interactive", "--json"]).status, 0);
  for (const args of [
    ["init", "--non-interactive", "--json"],
    ["init", "--help", "--non-interactive", "--json"],
  ]) {
    const result = run(args);
    assert.deepEqual([result.status, result.stderr], [0, ""], args.join(" "));
    JSON.parse(result.stdout);
  }
  assert.deepEqual(readdirSync(root), []);
});
