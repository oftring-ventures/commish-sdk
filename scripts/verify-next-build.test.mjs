import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyNextBuild } from "./verify-next-build.mjs";
import { cookieRequestProbe, nextBuildFixture, nextServerBuildFixture } from "./fixtures/next-build.mjs";
import { providerProbe } from "./fixtures/next-provider.mjs";
import { captureRequestProbe } from "./fixtures/next-capture.mjs";
import { cliProbe } from "./fixtures/next-cli.mjs";
import { serverMarker } from "./inspect-next-build.mjs";

test("initializer reports both App Router locations without writes and the probe rejects mutation", async () => {
  await cliProbe(fileURLToPath(new URL("../packages/next/bin/init.mjs", import.meta.url)));
  let fixture;
  await assert.rejects(() => cliProbe(null, (cwd) => {
    fixture = cwd;
    writeFileSync(join(cwd, "keep.txt"), "changed");
    return { status: 1, signal: null, stdout: "", stderr: "" };
  }), /initializer changed consumer files/);
  assert(!existsSync(fixture));
  await assert.rejects(() => cliProbe(null, () => ({ status: 0, signal: null, stdout: "", stderr: "" })));
});

test("only declared framework capabilities select a build and invalid inputs fail before commands", async () => {
  const packed = (exports, peerDependencies) => ({
    archive: Buffer.from("test-only"),
    packed: new Map([["package/package.json", { data: Buffer.from(JSON.stringify({ exports, peerDependencies })) }]]),
  });
  let calls = 0;
  const execute = () => {
    calls++;
    throw new Error("unexpected execution");
  };
  assert.deepEqual(await verifyNextBuild(null, packed({}), null, execute), []);
  await assert.rejects(() => verifyNextBuild(null, packed({ "./react": {} }), null, execute));
  const providerExports = {
    "./react": { types: "./dist/provider.d.ts", default: "./dist/provider.js" },
  };
  for (const exports of [
    {},
    { ".": { browser: null, types: "./dist/types.d.ts", default: "./dist/types.js" } },
  ])
    assert.deepEqual(
      await verifyNextBuild(packed(exports), packed(providerExports), null, execute),
      [],
    );
  const sdk = packed({
    ".": { browser: null, types: "./dist/index.d.ts", default: "./dist/index.js" },
  });
  const rootExport = { browser: null, types: "./dist/index.d.ts", default: "./dist/index.js" };
  const peers = { "@commish/sdk": "0.1.0-beta.10", next: ">=16.2.12 <17", react: ">=19.2.8 <20" };
  assert.deepEqual(await verifyNextBuild(sdk, packed({ ".": rootExport }), null, execute), []);
  for (const invalid of [
    packed({ ".": { ...rootExport, browser: "./dist/index.js" } }, peers),
    packed({ ".": rootExport }, { ...peers, next: ">=16" }),
    packed({ ".": rootExport }, { next: peers.next }),
  ]) await assert.rejects(() => verifyNextBuild(sdk, invalid, null, execute), /unsupported server/);
  const root = mkdtempSync(join(tmpdir(), "commish-next-selection-test-"));
  try {
    writeFileSync(join(root, "pnpm-lock.yaml"), "unapproved source lock");
    const provider = packed({
      "./react": { types: "./dist/provider.d.ts", default: "./dist/provider.js" },
    });
    await assert.rejects(
      () =>
        verifyNextBuild(
          sdk,
          provider,
          { build: root, checkout: root, lock: Buffer.from("unapproved source lock") },
          execute,
        ),
      /unsupported framework source lock/,
    );
    await assert.rejects(
      () =>
        verifyNextBuild(
          sdk,
          provider,
          { build: root, checkout: root, lock: Buffer.from("changed") },
          execute,
        ),
      /framework source lock changed/,
    );
    await assert.rejects(() => verifyNextBuild(sdk, packed({ ".": rootExport }, peers),
      { build: root, checkout: root, lock: Buffer.from("unapproved source lock") }, execute),
    /unsupported framework source lock/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert(!existsSync(root));
  }
  assert.equal(calls, 0);
  assert(nextBuildFixture["app/api/artifact/route.ts"].includes(serverMarker));
  assert(
    nextBuildFixture["app/api/artifact/route.ts"].includes(
      "return Response.json({ kind: typeof client })",
    ),
  );
  assert(!nextBuildFixture["app/layout.tsx"].includes('"use client"'));
  assert(nextBuildFixture["app/layout.tsx"].includes("@commish/next/react"));
  assert(!nextServerBuildFixture["app/layout.tsx"].includes("@commish/next/react"));
  assert(nextServerBuildFixture["app/api/artifact/route.ts"].includes("@commish/next'"));
  assert(nextServerBuildFixture["app/api/artifact/route.ts"].includes(serverMarker));
  const options = JSON.parse(nextBuildFixture["tsconfig.json"]).compilerOptions;
  assert.equal(options.skipLibCheck, true);
  assert.equal(options.strict, true);
  assert.equal(options.noEmit, true);
  const { default: config } = await import(
    `data:text/javascript,${encodeURIComponent(nextBuildFixture["next.config.mjs"])}`
  );
  assert.deepEqual(config, { experimental: { cpus: 1 } });
});

test("cookie request probe rejects wrong behavior and closes its loopback server", async () => {
  for (const failure of [null, "metadata", "status"]) {
    let closed = false, port;
    const createApp = () => ({
      async prepare() {},
      async close() { closed = true; },
      getRequestHandler: () => (request, response) => {
        port = request.socket.localPort;
        const value = request.headers.cookie?.split("=")[1] ?? null;
        response.statusCode = failure === "status" ? 500 : 200;
        response.end(JSON.stringify({ attribution: value, unchanged: value === null,
          metadata: { keep: "checkout", ...(value ? { commish_attribution: value } : {}),
            ...(failure === "metadata" ? { unexpected: true } : {}) },
          subscription: { keep: "subscription", ...(value ? {
            commish_attribution: value, commish_customer_id: "consumer_123",
          } : {}) },
        }));
      },
    });
    if (failure) await assert.rejects(() => cookieRequestProbe(createApp));
    else await cookieRequestProbe(createApp);
    assert(closed && port, "request probe must execute and close its app");
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1_000) }));
  }
});

test("capture upstream closes and restores environment after app or probe failure", async () => {
  const original = process.env.COMMISH_CONSUMER_API_URL;
  for (const failure of ["startup", "request"]) {
    let url;
    await assert.rejects(() => captureRequestProbe(async (probe) => {
      url = process.env.COMMISH_CONSUMER_API_URL;
      if (failure === "startup") throw new Error("controlled startup failure");
      await probe(new URL(url).origin);
    }));
    assert.equal(process.env.COMMISH_CONSUMER_API_URL, original);
    await assert.rejects(() => fetch(url, { signal: AbortSignal.timeout(1_000) }));
  }
});

test("provider wiring probe rejects a wrong export and clears controlled hook state", async () => {
  await assert.rejects(() => providerProbe(async () => {
    assert.equal(typeof (await import("react/jsx-runtime")).jsx, "function");
    return { wrong: () => null };
  }), /CommishProvider/);
  assert(!Object.hasOwn(globalThis, Symbol.for("commish.provider.probe")));
  try {
    assert(!import.meta.resolve("react/jsx-runtime").startsWith("data:"), "controlled JSX hook leaked");
  } catch (error) {
    assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
  }
});
