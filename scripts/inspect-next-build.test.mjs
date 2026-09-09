import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectNextBuild, serverMarker } from "./inspect-next-build.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "commish-next-output-test-"));
  const put = (path, data) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  };
  try {
    put(
      ".next/server/app-paths-manifest.json",
      JSON.stringify({ "/api/artifact/route": "app/api/artifact/route.js" }),
    );
    put(".next/server/app/api/artifact/route.js", `const marker = '${serverMarker}';`);
    put(".next/static/chunks/client.js", "export const provider = true;");
    return run(root, put);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert(!existsSync(root));
  }
}

test("build evidence requires the real server witness before client absence", () => {
  fixture((root, put) => {
    const result = inspectNextBuild(root);
    assert.deepEqual(
      { ...result, sha256: undefined },
      {
        serverFiles: 1,
        clientFiles: 1,
        witness: "server/app/api/artifact/route.js",
        sha256: undefined,
      },
    );
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    put(".next/server/app/api/artifact/route.js", "export const noMarker = true;");
    assert.throws(() => inspectNextBuild(root), /server marker witness missing/);
    put(".next/static/chunks/client.js", serverMarker);
    assert.throws(() => inspectNextBuild(root), /server marker witness missing/);
    put(".next/server/app/api/artifact/route.js", serverMarker);
    assert.throws(() => inspectNextBuild(root), /server marker leaked into client output/);
  });
});

test("invalid route, empty output and linked output never receive build evidence", () => {
  for (const [change, diagnostic] of [
    [
      (root, put) => {
        put("outside-manifest.json", "not JSON: must never be parsed");
        rmSync(join(root, ".next/server/app-paths-manifest.json"));
        symlinkSync(
          join(root, "outside-manifest.json"),
          join(root, ".next/server/app-paths-manifest.json"),
        );
      },
      /framework path escaped owned root/,
    ],
    [(root, put) => put(".next/server/app-paths-manifest.json", "{}"), /missing marker route/],
    [
      (root, put) =>
        put(".next/server/app-paths-manifest.json", '{"/api/artifact/route":"../../outside.js"}'),
      /missing marker route/,
    ],
    [(root) => rmSync(join(root, ".next/static/chunks/client.js")), /empty Next build JavaScript/],
    [
      (root) =>
        symlinkSync(
          join(root, ".next/server/app/api/artifact/route.js"),
          join(root, ".next/static/linked.js"),
        ),
      /inventory contains a link/,
    ],
  ])
    fixture((root, put) => {
      change(root, put);
      assert.throws(() => inspectNextBuild(root), diagnostic);
    });
});
