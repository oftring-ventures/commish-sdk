import assert from "node:assert/strict";
import test from "node:test";
import { setupIntent, sameSetupIntent, validateSetupIntent } from "../packages/sdk/bin/setup-intent.mjs";
import { createSetupSession } from "../packages/sdk/bin/setup-session.mjs";
import { parseSetupConfig } from "../packages/sdk/bin/setup-config.mjs";
const raw = { version: 1, application: { name: "Guestbook" }, destination: { origin: "https://guestbook.example", proofFile: "public/proof.txt" },
  program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: ["prod_b", "prod_a", "prod_b"] },
  terms: { commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" }, perSaleCap: null, disclosureText: "I earn a commission.", prohibitedClaims: ["b", "a", "b"] },
  participantConsent: "commish_hosted", webhook: null, stripe: "later" };
const config = parseSetupConfig(raw).config;
test("projects only business choices and canonicalizes unordered product/claim lists", () => {
  const intent = setupIntent({ ...config, credentialsFile: "private-file", secretKey: "synthetic-do-not-copy" });
  assert.deepEqual(intent.program.eligibleStripeProductIds, ["prod_a", "prod_b"]);
  assert.deepEqual(intent.terms.prohibitedClaims, ["a", "b"]);
  assert(!JSON.stringify(intent).includes("synthetic-do-not-copy"));
  assert.deepEqual(Object.keys(intent).sort(), ["program", "terms", "version"]);
  assert(!Object.hasOwn(intent.terms, "effectiveAt"));
  const explicit = setupIntent({ ...config, terms: { ...config.terms, effectiveAt: "2026-10-05T00:00:00.000Z" } });
  assert.equal(explicit.terms.effectiveAt, "2026-10-05T00:00:00.000Z");
});
test("rejects changed economics, extra properties and missing review without echoing values", () => {
  const expected = setupIntent(config);
  for (const actual of [undefined, { ...expected, version: 2 }, { ...expected, secret: "synthetic-do-not-copy" },
    { ...expected, terms: { ...expected.terms, commission: { type: "percentage", basisPoints: 3000 } } },
    { ...expected, terms: { ...expected.terms, perSaleCap: { amount: 100, currency: "usd" } } },
    { ...expected, program: { ...expected.program, eligibleStripeProductIds: ["prod_other"] } }]) assert.equal(sameSetupIntent(actual, expected), false);
  assert.equal(sameSetupIntent(JSON.parse(JSON.stringify(expected)), expected), true);
  assert.throws(() => validateSetupIntent({ ...expected, secret: "synthetic-do-not-copy" }), { message: "invalid_request" });
  const big = { ...raw, program: { ...raw.program, eligibleStripeProductIds: ["prod_" + "a".repeat(262_144)] } };
  assert.throws(() => setupIntent(parseSetupConfig(big).config), { message: "invalid_request" });
});
test("requires exact server review parity and retains choices across caller mutation/retry", async () => {
  const original = setupIntent(config), input = { operations: ["program.write", "terms.write"], setupIntent: original };
  let change = x => x; const calls = [];
  const session = createSetupSession(input, { fetcher: async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json({ data: change({ protocol: "commish-cli-setup-v2", requestId: body.challengeHash,
      mode: body.mode, operations: body.operations, workspaceRequest: null, setupIntent: body.setupIntent,
      pairingCode: `${body.challengeHash.slice(0,4)}-${body.challengeHash.slice(4,8)}`.toUpperCase(),
      requestExpiresAt: new Date(Date.now()+3600000).toISOString(), decision: "pending" }) });
  } });
  original.terms.commission.basisPoints = 3000;
  await session.begin(); await session.begin(); assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].setupIntent.terms.commission.basisPoints, 1500);
  change = x => { delete x.setupIntent; return x; };
  await assert.rejects(session.begin(), { message: "invalid_response" });
  change = x => ({ ...x, setupIntent: { ...x.setupIntent, terms: { ...x.setupIntent.terms, commission: { type: "percentage", basisPoints: 3000 } } } });
  await assert.rejects(session.begin(), { message: "invalid_response" });
});

test("reviewed pairing accepts the full 256 KiB review capacity", async () => {
  const intent = setupIntent({ ...config, program: { ...config.program, eligibleStripeProductIds: ["prod_" + "a".repeat(261_268)] } });
  const session = createSetupSession({ operations: ["program.write", "terms.write"], setupIntent: intent }, {
    fetcher: async (url, options) => {
      assert.equal(new URL(url).pathname, "/api/cli/setup-sessions/reviewed");
      const body = JSON.parse(options.body);
      return Response.json({ data: { protocol: "commish-cli-setup-v2", requestId: body.challengeHash,
        mode: body.mode, operations: body.operations, workspaceRequest: null, setupIntent: body.setupIntent,
        pairingCode: `${body.challengeHash.slice(0,4)}-${body.challengeHash.slice(4,8)}`.toUpperCase(),
        requestExpiresAt: new Date(Date.now()+3600000).toISOString(), decision: "pending" } });
    },
  });
  await session.begin();
});
