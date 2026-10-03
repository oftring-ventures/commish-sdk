import assert from "node:assert/strict";
import test from "node:test";
import { parseSetupConfig } from "../packages/sdk/bin/setup-config.mjs";

const input = { version: 1, application: { name: "Guestbook" }, destination: { origin: "https://Guestbook.example/", proofFile: "public/.well-known/commish-verification.txt" },
  program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: ["prod_guestbook"] },
  terms: { commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" }, perSaleCap: null, disclosureText: "I earn a referral commission." },
  participantConsent: "commish_hosted", webhook: null, stripe: "later" };
test("defaults to TEST and a private draft while preserving explicit business choices", () => {
  const result = parseSetupConfig(input);
  assert.equal(result.kind, "ready"); assert.equal(result.config.mode, "test");
  assert.equal(result.config.destination.origin, "https://guestbook.example");
  assert.equal(result.config.program.visibility, "private"); assert.equal(result.config.program.joinPolicy, "approval");
  assert.equal(result.config.terms.perSaleCap, null); assert.equal(result.config.terms.recurrence.kind, "first_payment");
  assert(!Object.hasOwn(result.config.terms, "effectiveAt"));
  result.config.program.eligibleStripeProductIds.push("prod_other"); assert.equal(input.program.eligibleStripeProductIds.length, 1);
  assert.equal(parseSetupConfig({ ...input, mode: "live" }).config.mode, "live");
});
test("reports fixed actionable missing fields before any authorization", () => {
  for (const [section, field] of [["program", "eligibleStripeProductIds"], ["terms", "commission"], ["terms", "recurrence"], ["terms", "perSaleCap"], ["destination", "proofFile"]]) {
    const config = structuredClone(input); delete config[section][field];
    assert.deepEqual(parseSetupConfig(config), { kind: "input_required", fields: [`${section}.${field}`] });
  }
  const config = structuredClone(input); delete config.participantConsent;
  assert.deepEqual(parseSetupConfig(config), { kind: "input_required", fields: ["participantConsent"] });
  assert.equal(parseSetupConfig({ ...input, program: { ...input.program, eligibleStripeProductIds: [] } }).kind, "ready");
});
test("rejects secret-like unknown fields, unsafe paths and invalid economics without echoing values", () => {
  const bad = [{ ...input, secretKey: "do-not-echo" }, { ...input, mode: "do-not-echo" },
    { ...input, application: { name: "Guestbook", token: "do-not-echo" } },
    ...["../outside", "/outside", "a/../../outside", "a\\outside", ".git/config", ".commish/state.json", ".GIT/commondir", ".COMMISH/state.json", "public/.GIT/commondir"].map(proofFile => ({ ...input, destination: { ...input.destination, proofFile } })),
    { ...input, terms: { ...input.terms, commission: { type: "percentage", basisPoints: 10001 } } },
    { ...input, participantConsent: "automatic" }, { ...input, stripe: true }];
  for (const config of bad) {
    const result = parseSetupConfig(config); assert.equal(result.kind, "invalid_config");
    assert(!JSON.stringify(result).includes("do-not-echo"));
  }
});
test("validates existing/new workspace intent and explicitly selected webhook events", () => {
  for (const workspace of [{ kind: "existing", id: "wrk_123456789012" }, { kind: "new", name: "Guestbook", slug: "guestbook" }])
    assert.equal(parseSetupConfig({ ...input, workspace }).kind, "ready");
  assert.deepEqual(parseSetupConfig({ ...input, workspace: { kind: "existing", id: "invalid" } }).fields, ["workspace"]);
  const hook = { url: "https://guestbook.example/api/commish", eventTypes: ["commission.payable"] };
  assert.equal(parseSetupConfig({ ...input, webhook: hook }).kind, "ready");
  for (const webhook of [{ ...hook, url: "https://user:secret@guestbook.example" }, { ...hook, url: "https://localhost" },
    { ...hook, url: "https://guestbook.example/webhook?token=secret" },
    { ...hook, url: "https://127.0.0.1" }, { ...hook, eventTypes: ["unknown"] }, { ...hook, eventTypes: [] }])
    assert.deepEqual(parseSetupConfig({ ...input, webhook }).fields, ["webhook"]);
});
