import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { selectSdkTypes } from "./verify-sdk-types.mjs";

export const webhookConsumerScope = "sdk-webhook-node";
async function webhookProbe(expectedPath) {
  const { default: assert } = await import("node:assert/strict");
  const { createHmac } = await import("node:crypto");
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  assert.equal(
    realpathSync(fileURLToPath(import.meta.resolve("@commish/sdk/webhooks"))),
    expectedPath,
  );
  const { signWebhook, verifyWebhook } = await import("@commish/sdk/webhooks");
  assert.equal(typeof signWebhook, "function", "public webhook signer");
  assert.equal(typeof verifyWebhook, "function", "public webhook verifier");
  const payload = '{"event":"conversion.created","memo":"café"}\n';
  const secret = "whsec_fixture_only";
  const digest = "69247e8c853132093c4013883f4111557d7be5b575a9373b6992355306cd0fad";
  const header = `t=1000,v1=${digest}`;
  const signedHeader = (timestamp, key = secret) =>
    `t=${timestamp},v1=${createHmac("sha256", key).update(`${timestamp}.${payload}`).digest("hex")}`;
  assert.equal(createHmac("sha256", secret).update(`1000.${payload}`).digest("hex"), digest);
  assert.equal(signWebhook(payload, secret, 1000), header, "HMAC signing vector");
  for (const changed of [payload + " ", payload.replace("café", "cafe\u0301"), ""])
    assert.equal(
      verifyWebhook(changed, header, secret, 300, 1000),
      false,
      "payload-byte tampering",
    );
  assert.equal(verifyWebhook(payload, header, secret + " ", 300, 1000), false);
  for (const [now, expected] of [
    [699, false],
    [700, true],
    [1000, true],
    [1300, true],
    [1301, false],
  ])
    assert.equal(verifyWebhook(payload, header, secret, 300, now), expected, "inclusive tolerance");
  assert.equal(verifyWebhook(payload, header, secret, undefined, 1300), true);
  assert.equal(verifyWebhook(payload, header, secret, undefined, 1301), false, "default tolerance");
  assert.equal(verifyWebhook(payload, header, secret, 0, 1000), true);
  assert.equal(verifyWebhook(payload, header, secret, 0, 1001), false);
  assert.equal(verifyWebhook(payload, `t=1000, v1=${digest.toUpperCase()}`, secret, 0, 1000), true);
  for (const invalid of [
    "",
    `t=1000`,
    `v1=${digest}`,
    `t=1000,v2=${digest}`,
    `t=1001,v1=${digest}`,
    `${header},t=1000`,
    `${header},v1=${digest}`,
    `t=1000,v1=${digest.slice(1)}`,
    `t=1000,v1=${digest}00`,
    `t=1000,v1=${"z".repeat(64)}`,
    `t=1000,v1=${"0".repeat(64)}`,
  ])
    assert.equal(verifyWebhook(payload, invalid, secret, 300, 1000), false, "invalid header");
  for (const [timestamp, now] of [
    [-1, 0],
    [1.5, 1],
    [NaN, 0],
    [Infinity, 0],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER],
  ])
    assert.equal(
      verifyWebhook(payload, signedHeader(timestamp), secret, 300, now),
      false,
      "invalid signed timestamp",
    );
  for (const tolerance of [-1, NaN, Infinity])
    assert.equal(verifyWebhook(payload, header, secret, tolerance, 1000), false);
  for (const [now, timestamp] of [
    [-1, 0],
    [1000.5, 1000],
    [NaN, 1000],
    [Infinity, 1000],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER],
  ])
    assert.equal(
      verifyWebhook(payload, signedHeader(timestamp), secret, 300, now),
      false,
      "invalid current time",
    );
  for (const empty of ["", " ", "\t"]) {
    assert.throws(() => signWebhook(payload, empty, 1000));
    assert.equal(
      verifyWebhook(payload, signedHeader(1000, empty), empty, 300, 1000),
      false,
      "empty signing secret",
    );
  }
  for (const timestamp of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => signWebhook(payload, secret, timestamp));
  for (const timestamp of [0, Number.MAX_SAFE_INTEGER]) {
    const expected = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
    assert.equal(signWebhook(payload, secret, timestamp), expected);
    assert.equal(verifyWebhook(payload, expected, secret, 0, timestamp), true);
  }
}

// C1 owns the verified tarball installation and cleanup; this adds no install path.
export function verifySdkWebhooks(consumer, packed, execute = execFileSync) {
  selectSdkTypes(packed);
  const manifest = JSON.parse(packed.get("package/package.json").data);
  if (!Object.hasOwn(manifest.exports, "./webhooks")) return [];
  const root = realpathSync(consumer),
    installed = realpathSync(join(root, "node_modules/@commish/sdk"));
  assert(installed.startsWith(root + sep), "installed SDK escaped consumer");
  const checkBytes = () => {
    for (const [name, entry] of packed) {
      const path = realpathSync(join(installed, name.slice("package/".length)));
      assert(path.startsWith(installed + sep), "installed artifact escaped SDK");
      assert(
        readFileSync(path).equals(entry.data),
        "installed artifact differs from verified archive",
      );
    }
  };
  checkBytes();
  const target = realpathSync(join(installed, "dist/webhooks.js"));
  const probe = join(root, "webhooks-probe.mjs");
  writeFileSync(probe, `await (${webhookProbe.toString()})(process.argv[2]);\n`);
  const env = Object.freeze({
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"].includes(name),
      ),
    ),
    NODE_DISABLE_COMPILE_CACHE: "1",
  });
  execute(process.execPath, [probe, target], {
    cwd: root,
    env,
    stdio: "pipe",
    timeout: 30_000,
    maxBuffer: 1_048_576,
  });
  checkBytes();
  return [webhookConsumerScope];
}
