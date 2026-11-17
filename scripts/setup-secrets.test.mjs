import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSetupProgress } from "../packages/sdk/bin/setup-progress.mjs";
import {
  persistSetupWebhookSecret,
  provisionSetupCredential,
  setupCredentialMatches,
} from "../packages/sdk/bin/setup-secrets.mjs";

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
  stripe: "later",
};
function fixture(t, mode = "test") {
  const root = mkdtempSync(join(tmpdir(), "commish-secrets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const progress = openSetupProgress(root, { ...config, mode }),
    calls = [];
  const details = { mode, applicationId: "app_123456789012", programId: "prg_123456789012" };
  const session = {
    async createCredential(input) {
      calls.push(input);
      return {
        mode,
        apiKey: {
          id: "key_123456789012",
          applicationId: input.applicationId,
          publishableKey: input.publishableKey,
          revokedAt: null,
        },
      };
    },
  };
  return { root, progress, calls, details, session };
}
test("uncertain issuance retries the original persisted material and emits metadata only", async (t) => {
  const f = fixture(t),
    original = f.session.createCredential;
  f.session.createCredential = async (input) => {
    await original(input);
    throw new Error("service_unavailable");
  };
  await assert.rejects(
    provisionSetupCredential(f.root, f.progress, f.session, f.details),
    /service_unavailable/,
  );
  const before = readFileSync(join(f.root, f.progress.directory, "credentials.env"), "utf8");
  const secret = before.match(/^COMMISH_SECRET_KEY=(.+)$/m)[1];
  assert.equal(f.calls[0].secretHash, createHash("sha256").update(secret).digest("hex"));
  assert(!JSON.stringify(f.calls).includes(secret));
  f.session.createCredential = original;
  const result = await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert(!JSON.stringify(result).includes(secret));
  assert.equal(readFileSync(join(f.root, result.path), "utf8"), before);
  assert.equal(statSync(join(f.root, result.path)).mode & 0o777, 0o600);
  assert.deepEqual(f.progress.read("credential"), { id: result.credentialId });
  rmSync(join(f.root, result.path));
  await assert.rejects(
    provisionSetupCredential(f.root, f.progress, f.session, f.details),
    /setup_credential_missing/,
  );
  assert.equal(f.calls.length, 2);
});
test("refuses changed identity or customized credentials without issuing replacements", async (t) => {
  const f = fixture(t);
  await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  await assert.rejects(
    provisionSetupCredential(f.root, f.progress, f.session, {
      ...f.details,
      programId: "prg_other1234567",
    }),
    /setup_credential_conflict/,
  );
  writeFileSync(join(f.root, f.progress.directory, "credentials.env"), "CUSTOM=preserve\n", {
    mode: 0o600,
  });
  await assert.rejects(provisionSetupCredential(f.root, f.progress, f.session, f.details), {
    message: "setup_credential_conflict",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(
    readFileSync(join(f.root, f.progress.directory, "credentials.env"), "utf8"),
    "CUSTOM=preserve\n",
  );
});
test("the credential file carries the names the Next.js adapter requires, with the same values", async (t) => {
  const f = fixture(t);
  const result = await provisionSetupCredential(f.root, f.progress, f.session, {
    ...f.details,
    appUrl: "https://app.staging.example.test",
  });
  const body = readFileSync(join(f.root, result.path), "utf8");
  const values = Object.fromEntries(
    body
      .trimEnd()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  assert.deepEqual(Object.keys(values), [
    "COMMISH_MODE",
    "COMMISH_APPLICATION_ID",
    "COMMISH_PROGRAM_ID",
    "COMMISH_PUBLISHABLE_KEY",
    "COMMISH_SECRET_KEY",
    "NEXT_PUBLIC_COMMISH_APPLICATION_ID",
    "NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY",
    "COMMISH_API_URL",
  ]);
  assert.equal(values.NEXT_PUBLIC_COMMISH_APPLICATION_ID, values.COMMISH_APPLICATION_ID);
  assert.equal(values.NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY, values.COMMISH_PUBLISHABLE_KEY);
  // The API of the deployment setup ran against, in the shape every command accepts.
  assert.equal(values.COMMISH_API_URL, "https://app.staging.example.test/api/v1");
  // The secret is never repeated under a public name.
  assert.equal(body.split(values.COMMISH_SECRET_KEY).length, 2);
  // Everything `commish-next` lists as required is in the file as written.
  const required = /requiredEnvironment: \[([^\]]+)\]/
    .exec(readFileSync(new URL("../packages/next/bin/init.mjs", import.meta.url), "utf8"))[1]
    .match(/[A-Z_]+/g);
  assert.equal(required.length, 4);
  assert.deepEqual(
    required.filter((name) => !values[name]),
    [],
  );
  // A rerun reads the file back as its own and issues nothing new.
  await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  assert.equal(readFileSync(join(f.root, result.path), "utf8"), body);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(setupCredentialMatches(body, f.details), true);
});
test("the production API is named when no deployment is given, and an unusable one is refused", async (t) => {
  const f = fixture(t);
  const result = await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  assert.match(
    readFileSync(join(f.root, result.path), "utf8"),
    /\nCOMMISH_API_URL=https:\/\/app\.commish\.sh\/api\/v1\n$/,
  );
  const other = fixture(t);
  for (const appUrl of ["not a url", "ftp://app.commish.sh", "https://user@app.commish.sh"])
    await assert.rejects(
      provisionSetupCredential(other.root, other.progress, other.session, {
        ...other.details,
        appUrl,
      }),
      /invalid_setup_step/,
    );
  assert.equal(other.calls.length, 0);
});
test("a loopback deployment named by its IPv6 address is written and read back", async (t) => {
  // The CLI accepts `http://[::1]:PORT` as a deployment, so setup must too.
  for (const [appUrl, api] of [
    ["http://[::1]:3000", "http://[::1]:3000/api/v1"],
    ["https://app_staging.example.test", "https://app_staging.example.test/api/v1"],
  ]) {
    const f = fixture(t);
    const details = { ...f.details, appUrl };
    const result = await provisionSetupCredential(f.root, f.progress, f.session, details);
    const body = readFileSync(join(f.root, result.path), "utf8");
    assert.equal(body.endsWith(`\nCOMMISH_API_URL=${api}\n`), true);
    assert.equal(setupCredentialMatches(body, f.details), true);
    // A rerun reads the file back as its own and issues nothing new.
    await provisionSetupCredential(f.root, f.progress, f.session, details);
    assert.equal(readFileSync(join(f.root, result.path), "utf8"), body);
  }
});
test("a file written before the Next.js names were added is still setup's own file", async (t) => {
  const f = fixture(t);
  const old =
    `COMMISH_MODE=test\nCOMMISH_APPLICATION_ID=${f.details.applicationId}\nCOMMISH_PROGRAM_ID=${f.details.programId}\n` +
    `COMMISH_PUBLISHABLE_KEY=cm_test_pk_${"p".repeat(32)}\nCOMMISH_SECRET_KEY=cm_test_sk_${"s".repeat(43)}\n`;
  const path = join(f.root, f.progress.directory, "credentials.env");
  mkdirSync(join(f.root, f.progress.directory), { recursive: true });
  writeFileSync(path, old, { mode: 0o600 });
  assert.equal(setupCredentialMatches(old, f.details), true);
  const result = await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  // Reused as it is: the same key, and the file is not rewritten.
  assert.equal(f.calls[0].publishableKey, `cm_test_pk_${"p".repeat(32)}`);
  assert.equal(readFileSync(join(f.root, result.path), "utf8"), old);
  // The added lines must repeat the file's own values, whole, or it is not that file.
  const added = (application, publishable, api) =>
    `${old}NEXT_PUBLIC_COMMISH_APPLICATION_ID=${application}\nNEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY=${publishable}\nCOMMISH_API_URL=${api}\n`;
  const pk = `cm_test_pk_${"p".repeat(32)}`,
    api = "https://app.commish.sh/api/v1";
  assert.equal(setupCredentialMatches(added(f.details.applicationId, pk, api), f.details), true);
  for (const altered of [
    added("app_other1234567", pk, api),
    added(f.details.applicationId, `cm_test_pk_${"q".repeat(32)}`, api),
    added(f.details.applicationId, pk, "https://app.commish.sh"),
    added(f.details.applicationId, pk, "https://app.commish.sh/api/v1?key=1"),
    `${old}NEXT_PUBLIC_COMMISH_APPLICATION_ID=${f.details.applicationId}\n`,
    `${added(f.details.applicationId, pk, api)}EXTRA=1\n`,
  ])
    assert.equal(setupCredentialMatches(altered, f.details), false, altered.slice(old.length));
});
test("LIVE material remains explicitly mode-bound", async (t) => {
  const f = fixture(t, "live"),
    result = await provisionSetupCredential(f.root, f.progress, f.session, f.details);
  assert.equal(result.mode, "live");
  assert.match(f.calls[0].publishableKey, /^cm_live_pk_/);
  await assert.rejects(
    provisionSetupCredential(f.root, f.progress, f.session, { ...f.details, mode: "test" }),
    /invalid_setup_step/,
  );
});
test("writes bound webhook secrets privately and preserves conflicting local configuration", async (t) => {
  const f = fixture(t),
    secret = `whsec_${"x".repeat(43)}`,
    details = { mode: "test", endpointId: "whe_123456789012", input: {} };
  let value = secret;
  const session = { downloadWebhookSecret: async () => value };
  const result = await persistSetupWebhookSecret(f.root, f.progress, session, details);
  assert(!JSON.stringify(result).includes(secret));
  assert.equal(statSync(join(f.root, result.path)).mode & 0o777, 0o600);
  await persistSetupWebhookSecret(f.root, f.progress, session, details);
  value = `whsec_${"y".repeat(43)}`;
  await assert.rejects(
    persistSetupWebhookSecret(f.root, f.progress, session, details),
    /setup_file_conflict/,
  );
  value = { signingSecret: secret };
  await assert.rejects(persistSetupWebhookSecret(f.root, f.progress, session, details), {
    message: "invalid_response",
  });
});
