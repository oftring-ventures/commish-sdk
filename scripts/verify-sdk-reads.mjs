import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { selectSdkTypes } from "./verify-sdk-types.mjs";

export const readsConsumerScope = "sdk-reads-node-fetch";
async function readsProbe(expectedPath) {
  const { default: assert } = await import("node:assert/strict");
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  globalThis.fetch = () => assert.fail("uninjected global fetch");
  assert.equal(realpathSync(fileURLToPath(import.meta.resolve("@commish/sdk"))), expectedPath);
  const { Commish, CommishError } = await import("@commish/sdk");
  assert.equal(typeof Commish, "function", "public read client");
  const secretKey = "cm_test_sk_fixture_only_123456";
  const calls = [];
  let respond = () => Response.json({ data: [], next_cursor: null });
  const client = new Commish({
    secretKey,
    fetch: async (url, init) => {
      calls.push(new URL(url));
      assert.equal(init.method, "GET", "read method");
      assert.equal(init.body, undefined, "read body");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), `Bearer ${secretKey}`, "per-page authorization");
      assert.equal(headers.has("idempotency-key"), false, "reads have no mutation key");
      return respond();
    },
  });
  const details = [
    ["conversions", "cnv", "conversions"],
    ["customers", "cst", "customers"],
    ["refunds", "rfd", "refunds"],
    ["commissions", "cms", "commissions"],
    ["webhookDeliveries", "evt", "webhook-deliveries"],
    ["payouts", "pay", "payouts"],
    ["programs", "prg", "programs"],
    ["memberships", "mbr", "memberships"],
  ];
  for (const [group, prefix, route] of details) {
    assert.equal(typeof client[group]?.retrieve, "function", "public read interface");
    const id = `${prefix}_fixture_only_123456`;
    const data =
      group === "payouts"
        ? { id, mode: "test", status: "failed", processedAt: "2026-09-08T00:00:00.123456Z" }
        : group === "webhookDeliveries"
          ? {
              id,
              endpointId: "whe_fixture_only_123456",
              mode: "test",
              eventType: "invitation.created",
              status: "failed",
              attemptCount: 1,
              responseStatus: 503,
              deliveredAt: null,
              createdAt: "2026-09-08T00:00:00Z",
            }
          : { id };
    respond = () => Response.json({ data });
    calls.length = 0;
    assert.deepEqual(await client[group].retrieve(id), { data }, "detail response projection");
    assert.deepEqual(
      calls.map(String),
      [`https://app.commish.sh/api/v1/${route}/${id}`],
      "detail route",
    );
    for (const bad of [null, 12, "", "bad_fixture_only_123456", `${prefix}_short`, `${id}/../x`])
      assert.throws(() => client[group].retrieve(bad), TypeError, "invalid public ID");
    assert.equal(calls.length, 1, "invalid ID cannot fetch");
  }
  const families = [
    [
      "conversions",
      "listRefunds",
      "iterateRefunds",
      "/conversions/cnv_fixture_only_123456/refunds",
      {},
      "cnv_fixture_only_123456",
    ],
    [
      "conversions",
      "listCommissions",
      "iterateCommissions",
      "/conversions/cnv_fixture_only_123456/commissions",
      {},
      "cnv_fixture_only_123456",
    ],
    [
      "customers",
      "list",
      "iterate",
      "/customers",
      { createdAfter: "2026-01-01T00:00:00Z", createdBefore: "2026-09-08T00:00:00Z" },
    ],
    [
      "webhookDeliveries",
      "list",
      "iterate",
      "/webhook-deliveries",
      { endpointId: "whe_fixture_only_123456", status: "failed" },
    ],
    ["memberships", "list", "iterate", "/memberships", {}],
  ];
  const invalidOptions = [
    ...[0, 101, 1.5, Infinity, null, "1"].map((limit) => ({ limit })),
    ...["", "bad+=", "x".repeat(513), null, 12].map((cursor) => ({ cursor })),
  ];
  for (const [group, listMethod, iteratorMethod, path, filters, id] of families) {
    assert.equal(typeof client[group]?.[listMethod], "function", "public list interface");
    assert.equal(typeof client[group]?.[iteratorMethod], "function", "public iterator interface");
    const invoke = (method, options) =>
      id ? client[group][method](id, options) : client[group][method](options);
    calls.length = 0;
    respond = () => Response.json({ data: [], next_cursor: null });
    await invoke(listMethod, {});
    assert.equal(String(calls[0]), `https://app.commish.sh/api/v1${path}`, "default list URL");
    await invoke(listMethod, { ...filters, limit: 100, cursor: "x".repeat(512) });
    assert.deepEqual(
      Object.fromEntries(calls[1].searchParams),
      { limit: "100", cursor: "x".repeat(512), ...filters },
      "list filters and inclusive bounds",
    );
    await invoke(listMethod, { limit: 1, cursor: "_" });
    assert.deepEqual(Object.fromEntries(calls[2].searchParams), { limit: "1", cursor: "_" });
    if (id)
      for (const bad of [null, "cnv_short", "cst_fixture_only_123456", "../conversions"]) {
        assert.throws(() => client[group][listMethod](bad), TypeError, "invalid parent ID");
        await assert.rejects(
          client[group][iteratorMethod](bad).next(),
          TypeError,
          "invalid iterator parent ID",
        );
      }
    for (const options of invalidOptions) {
      assert.throws(() => invoke(listMethod, options), TypeError, "invalid page options");
      await assert.rejects(
        invoke(iteratorMethod, options).next(),
        TypeError,
        "invalid iterator options",
      );
    }
    assert.equal(calls.length, 3, "invalid page options cannot fetch");
    calls.length = 0;
    respond = () =>
      Response.json({
        data: calls.length === 1 ? [{ id: "first" }, { id: "second" }] : [{ id: "last" }],
        next_cursor: calls.length === 1 ? "next_cursor" : null,
      });
    const options = { ...filters, limit: 2, cursor: "initial_cursor" };
    const unchanged = JSON.stringify(options);
    const iterator = invoke(iteratorMethod, options);
    assert.equal(calls.length, 0, "iterator starts lazily");
    assert.deepEqual(await iterator.next(), { done: false, value: { id: "first" } });
    assert.equal(calls.length, 1, "first page only");
    assert.deepEqual(await iterator.next(), { done: false, value: { id: "second" } });
    assert.equal(calls.length, 1, "no page prefetch");
    assert.deepEqual(await iterator.next(), { done: false, value: { id: "last" } });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    assert.equal(calls.length, 2, "null cursor ends iteration");
    for (const [index, url] of calls.entries()) {
      assert.equal(url.pathname, "/api/v1" + path, "iterator route");
      assert.deepEqual(
        Object.fromEntries(url.searchParams),
        { limit: "2", cursor: index ? "next_cursor" : "initial_cursor", ...filters },
        "sequential cursor and preserved filters",
      );
    }
    assert.equal(JSON.stringify(options), unchanged, "iterator options remain unchanged");
  }
  calls.length = 0;
  for (const key of ["createdAfter", "createdBefore"])
    for (const value of ["", "x".repeat(101), null, 12])
      assert.throws(
        () => client.customers.list({ [key]: value }),
        TypeError,
        "customer filter validation",
      );
  for (const value of ["unknown", null, 12])
    assert.throws(
      () => client.webhookDeliveries.list({ status: value }),
      TypeError,
      "delivery status validation",
    );
  assert.throws(
    () => client.webhookDeliveries.list({ endpointId: "evt_fixture_only_123456" }),
    TypeError,
  );
  assert.equal(calls.length, 0, "invalid filters cannot fetch");
  respond = () => Response.json({ data: [], next_cursor: null });
  for (const status of ["pending", "processing", "delivered", "failed"]) {
    await client.webhookDeliveries.list({ status });
    assert.equal(calls.at(-1).searchParams.get("status"), status);
  }
  const invalidPages = [
    { data: {}, next_cursor: null },
    { next_cursor: null },
    ...[undefined, "", "bad+=", "x".repeat(513), 12].map((next_cursor) => ({
      data: [{ id: "withheld" }],
      next_cursor,
    })),
  ];
  for (const page of invalidPages) {
    calls.length = 0;
    respond = () => Response.json(page);
    await assert.rejects(
      client.memberships.iterate().next(),
      /invalid or repeated pagination cursor/,
      "invalid page rejected before yield",
    );
    assert.equal(calls.length, 1);
  }
  for (const repeated of ["initial_cursor", "next_cursor"]) {
    calls.length = 0;
    respond = () =>
      Response.json({
        data: [{ id: calls.length === 1 ? "first" : "withheld" }],
        next_cursor: calls.length === 1 ? "next_cursor" : repeated,
      });
    const iterator = client.memberships.iterate({ cursor: "initial_cursor" });
    assert.deepEqual(await iterator.next(), { done: false, value: { id: "first" } });
    await assert.rejects(
      iterator.next(),
      /invalid or repeated pagination cursor/,
      "repeated page rejected before yield",
    );
    assert.equal(calls.length, 2, "invalid page is not retried");
  }
  calls.length = 0;
  respond = () =>
    Response.json({
      data: calls.length === 1 ? [] : [{ id: "after_empty" }],
      next_cursor: calls.length === 1 ? "next_cursor" : null,
    });
  const empty = client.memberships.iterate();
  assert.deepEqual(await empty.next(), { done: false, value: { id: "after_empty" } });
  assert.deepEqual(await empty.next(), { done: true, value: undefined });
  assert.equal(calls.length, 2, "empty page can advance");
  for (const transport of [false, true]) {
    calls.length = 0;
    const error = new Error("controlled page transport failure");
    respond = () => {
      if (calls.length === 1)
        return Response.json({ data: [{ id: "first" }], next_cursor: "next_cursor" });
      if (transport) throw error;
      return Response.json(
        { error: { code: "page_failed", message: "Page failed", request_id: "page_request" } },
        { status: 503 },
      );
    };
    const iterator = client.memberships.iterate();
    await iterator.next();
    await assert.rejects(
      iterator.next(),
      (caught) =>
        transport
          ? caught === error
          : caught instanceof CommishError &&
            caught.status === 503 &&
            caught.code === "page_failed" &&
            caught.requestId === "page_request",
      "pagination error propagation",
    );
    assert.equal(calls.length, 2, "pagination errors are not retried");
  }
  calls.length = 0;
  respond = () => Response.json({ data: [{ id: "first" }], next_cursor: "next_cursor" });
  const stopped = client.memberships.iterate();
  await stopped.next();
  await stopped.return();
  assert.deepEqual(await stopped.next(), { done: true, value: undefined });
  assert.equal(calls.length, 1, "consumer stop cannot fetch another page");
}

// C1 owns the validated tarball installation and cleanup; no new installer is added.
export function verifySdkReads(consumer, packed, execute = execFileSync) {
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
  const target = realpathSync(join(installed, "dist/index.js")),
    probe = join(root, "reads-probe.mjs");
  writeFileSync(probe, `await (${readsProbe.toString()})(process.argv[2]);\n`);
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
  return [readsConsumerScope];
}
