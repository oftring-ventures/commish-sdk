import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { selectSdkTypes } from "./verify-sdk-types.mjs";

export const httpConsumerScope = "sdk-http-node-fetch";
async function httpProbe(expectedPath) {
  const { default: assert } = await import("node:assert/strict");
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  globalThis.fetch = () => assert.fail("uninjected global fetch");
  assert.equal(realpathSync(fileURLToPath(import.meta.resolve("@commish/sdk"))), expectedPath);
  const { Commish, CommishError } = await import("@commish/sdk");
  assert.equal(typeof Commish, "function", "public HTTP client");
  assert.equal(typeof CommishError, "function", "public HTTP error");
  const secretKey = "cm_test_sk_fixture_only_123456";
  const calls = [];
  let result = () => Response.json({ data: { accepted: true } });
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return result();
  };
  for (const key of [
    undefined,
    null,
    12,
    "",
    "cm_test_sk_short",
    "cm_test_pk_fixture_only_123456",
    secretKey + " ",
  ])
    assert.throws(
      () => new Commish({ secretKey: key, fetch }),
      /Invalid Commish secret key/,
      "constructor validation",
    );
  assert.equal(calls.length, 0);
  const make = (baseUrl) => new Commish({ secretKey, baseUrl, fetch });
  const programId = "prg_fixture_only_123456";
  const conversion = {
    externalId: "sale",
    programId,
    customerId: "cst_fixture_only_123456",
    amount: 1200,
    currency: "usd",
    occurredAt: "2026-01-01T00:00:00Z",
    metadata: { memo: "café" },
  };
  const writes = [
    ["conversions", "create", "/conversions", conversion],
    ["customers", "identify", "/customers/identify", { externalId: "buyer" }],
    [
      "refunds",
      "create",
      "/refunds",
      {
        externalId: "refund",
        conversionId: "cnv_fixture_only_123456",
        amount: 100,
        currency: "usd",
        occurredAt: conversion.occurredAt,
      },
    ],
    [
      "invitations",
      "create",
      `/programs/${programId}/invitations`,
      { programId, email: "creator@example.test" },
    ],
  ];
  for (const [baseUrl, expectedBase] of [
    [undefined, "https://app.commish.sh/api/v1"],
    ["https://consumer.example.test/custom/v1", "https://consumer.example.test/custom/v1"],
    ["https://consumer.example.test/custom/v1/", "https://consumer.example.test/custom/v1"],
  ]) {
    const client = make(baseUrl);
    for (const [group, method, path, input] of writes) {
      const before = calls.length;
      const expectedBody = JSON.stringify(input);
      const response = await client[group][method](input, { idempotencyKey: "  write-key  " });
      assert.deepEqual(response, { data: { accepted: true } }, "successful object response");
      assert.equal(calls.length, before + 1, "one request per write");
      const { url, init } = calls.at(-1),
        headers = new Headers(init.headers);
      assert.equal(url, expectedBase + path, "write URL");
      assert.equal(init.method, "POST", "write method");
      assert.equal(headers.get("authorization"), `Bearer ${secretKey}`, "Bearer authorization");
      assert.equal(headers.get("content-type"), "application/json", "JSON content type");
      assert.equal(headers.get("idempotency-key"), "write-key", "trimmed idempotency");
      assert.equal(init.body, expectedBody, "exact JSON payload");
      assert.equal(JSON.stringify(input), expectedBody, "input remains unchanged");
    }
  }
  const client = make();
  for (const key of ["", " \t ", "x".repeat(256), null, 12]) {
    const before = calls.length;
    await assert.rejects(
      client.customers.identify({ externalId: "buyer" }, { idempotencyKey: key }),
      TypeError,
      "invalid idempotency",
    );
    assert.equal(calls.length, before, "invalid key cannot fetch");
  }
  await client.customers.identify({ externalId: "buyer" }, { idempotencyKey: "x".repeat(255) });
  assert.equal(new Headers(calls.at(-1).init.headers).get("idempotency-key"), "x".repeat(255));
  const beforeGet = calls.length;
  await client.conversions.lookup("buyer /?+");
  const get = calls.at(-1),
    headers = new Headers(get.init.headers);
  assert.equal(calls.length, beforeGet + 1);
  assert.equal(get.url, "https://app.commish.sh/api/v1/conversions?externalId=buyer+%2F%3F%2B");
  assert.equal(get.init.method, "GET");
  assert.equal(get.init.body, undefined);
  assert.equal(headers.get("authorization"), `Bearer ${secretKey}`);
  assert.equal(headers.has("idempotency-key"), false, "GET has no mutation key");
  for (const [body, requestId] of [
    [
      { error: { code: "idempotency_conflict", message: "Conflict", request_id: "body_request" } },
      "body_request",
    ],
    [{ error: { code: "idempotency_conflict", message: "Conflict" } }, "header_request"],
  ]) {
    result = () =>
      Response.json(body, { status: 409, headers: { "x-request-id": "header_request" } });
    const before = calls.length;
    await assert.rejects(
      client.customers.identify({ externalId: "buyer" }, { idempotencyKey: "conflict" }),
      (error) =>
        error instanceof CommishError &&
        error instanceof Error &&
        error.status === 409 &&
        error.code === "idempotency_conflict" &&
        error.message === "Conflict" &&
        error.requestId === requestId,
      "structured HTTP error",
    );
    assert.equal(calls.length, before + 1, "HTTP errors are not retried");
  }
  result = () =>
    new Response("not JSON", { status: 503, headers: { "x-request-id": "fallback_request" } });
  let before = calls.length;
  await assert.rejects(
    client.conversions.lookup("sale"),
    (error) =>
      error instanceof CommishError &&
      error.status === 503 &&
      error.code === "request_failed" &&
      error.message === "Commish request failed" &&
      error.requestId === "fallback_request",
    "non-JSON HTTP error",
  );
  assert.equal(calls.length, before + 1);
  for (const invalid of ["", "not JSON", "null", "false", "42", '"string"']) {
    result = () => new Response(invalid);
    before = calls.length;
    await assert.rejects(
      client.conversions.lookup("sale"),
      (error) =>
        error instanceof CommishError &&
        error.status === 200 &&
        error.code === "invalid_response" &&
        error.message === "Commish returned an invalid response",
      "invalid success response",
    );
    assert.equal(calls.length, before + 1);
  }
  const transport = new Error("controlled transport rejection");
  result = () => {
    throw transport;
  };
  before = calls.length;
  await assert.rejects(
    client.conversions.lookup("sale"),
    (error) => error === transport,
    "transport identity",
  );
  assert.equal(calls.length, before + 1, "transport errors are not retried");
}

// C1 owns the validated tarball installation and cleanup; no new installer is added.
export function verifySdkHttp(consumer, packed, execute = execFileSync) {
  if (selectSdkTypes(packed) !== "index") return [];
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
  const target = realpathSync(join(installed, "dist/index.js"));
  const probe = join(root, "http-probe.mjs");
  writeFileSync(probe, `await (${httpProbe.toString()})(process.argv[2]);\n`);
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
  return [httpConsumerScope];
}
