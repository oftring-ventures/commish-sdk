import { createHmac, randomUUID } from "node:crypto";
import { argumentsFor, errorReceipt, fail } from "./cli-http.mjs";
import { executeApi } from "./api-command.mjs";
export const testHelp = () => ({ version: 1, status: "help", commands: ["test fixture --program <id>", "test conversion --body-file <path> --idempotency-key <identity>", "test webhook --url <loopback-url>"],
  defaultMode: "test", liveSupported: false,
  fixture: "Produces a manual conversion input; supply real referral attribution in a private body file to test attribution. Never re-ingest a Stripe purchase through the manual API.",
  webhook: "Signs a synthetic TEST conversion.created event with COMMISH_WEBHOOK_SIGNING_SECRET; verifies only local receiver HTTP acceptance, not a stored conversion, real delivery or payout.",
  output: "JSON only; no signing or integration secret is printed" });
export async function executeTest(args, options = {}) {
  const env = options.env ?? process.env;
  const { values: v, positionals: p } = argumentsFor(args,
    ["program", "mode", "api-url", "body-file", "idempotency-key", "url"], ["help", "json", "non-interactive"]);
  if (v.help || !p.length) return testHelp();
  if (p.length !== 1 || !["fixture", "conversion", "webhook"].includes(p[0]) || (v.mode ?? env.COMMISH_MODE ?? "test") !== "test") fail("test_mode_required");
  if (p[0] === "fixture") {
    if (!/^prg_[A-Za-z0-9_-]{12,}$/.test(v.program ?? "") || ["api-url", "body-file", "idempotency-key", "url"].some(k => v[k])) fail("invalid_arguments");
    return { version: 1, status: "ok", mode: "test", fixtureOnly: true, data: {
      externalId: `commish-cli-test:${randomUUID()}`, programId: v.program, customerId: `commish-cli-test:${randomUUID()}`,
      amount: 10000, currency: "usd", occurredAt: new Date().toISOString(), metadata: { source: "commish-cli-test-fixture" } },
      nextAction: "Save data as your body file. Add actual attributionToken or couponCode to exercise attribution; review amount and customer identity." };
  }
  if (p[0] === "conversion") {
    if (v.program || v.url) fail("invalid_arguments");
    return executeApi(["conversions", "create", "--mode", "test", ...["api-url", "body-file", "idempotency-key"].flatMap(k => v[k] ? [`--${k}`, v[k]] : [])], options);
  }
  if (["program", "api-url", "body-file", "idempotency-key"].some(k => v[k])) fail("invalid_arguments");
  let url;
  try { url = new URL(v.url); } catch { fail("invalid_arguments"); }
  // Literal loopback addresses avoid DNS rebinding and accidental remote sends.
  if (!["127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail("loopback_url_required");
  const secret = env.COMMISH_WEBHOOK_SIGNING_SECRET;
  if (!/^whsec_[A-Za-z0-9_-]{12,512}$/.test(secret ?? "")) fail("webhook_secret_required");
  const event = { id: `evt_cli_fixture_${randomUUID().replaceAll("-", "")}`, type: "conversion.created", mode: "test",
    createdAt: new Date().toISOString(), data: { conversion_id: "cnv_cli_fixture_123456789", source: "synthetic_cli_fixture" } };
  const body = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  let response;
  try { response = await (options.fetcher ?? fetch)(url.href, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "commish-signature": `t=${timestamp},v1=${signature}` }, body }); }
  catch { fail("receiver_unavailable"); }
  await response.body?.cancel();
  return { version: 1, status: response.ok ? "accepted" : "rejected", mode: "test", synthetic: true,
    eventId: event.id, httpStatus: response.status, integrationVerified: false };
}
export async function runTestCommand(args, { out = console.log, diagnostic = console.error, ...options } = {}) {
  try { const result = await executeTest(args, options); out(JSON.stringify(result)); return result.status === "rejected" ? 2 : 0; }
  catch (error) { diagnostic(JSON.stringify(errorReceipt(error))); return 1; }
}
