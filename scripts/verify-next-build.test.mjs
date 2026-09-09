import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyNextBuild } from "./verify-next-build.mjs";
import { nextBuildFixture } from "./fixtures/next-build.mjs";
import { serverMarker } from "./inspect-next-build.mjs";

test("absent provider is not a build scope and unsupported input fails before commands", async () => {
  const packed = (exports) => ({
    archive: Buffer.from("test-only"),
    packed: new Map([["package/package.json", { data: Buffer.from(JSON.stringify({ exports })) }]]),
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
  const options = JSON.parse(nextBuildFixture["tsconfig.json"]).compilerOptions;
  assert.equal(options.skipLibCheck, true);
  assert.equal(options.strict, true);
  assert.equal(options.noEmit, true);
  const { default: config } = await import(
    `data:text/javascript,${encodeURIComponent(nextBuildFixture["next.config.mjs"])}`
  );
  assert.deepEqual(config, { experimental: { cpus: 1 } });
});
