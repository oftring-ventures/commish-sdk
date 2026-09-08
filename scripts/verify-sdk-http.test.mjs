import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifySdkHttp, httpConsumerScope } from "./verify-sdk-http.mjs";

function packed(root, webhook, implementation = "export {};") {
  const pair = (name, server = false) => ({
    ...(server ? { browser: null } : {}),
    types: `./dist/${name}.d.ts`,
    default: `./dist/${name}.js`,
  });
  const exports = { "./browser": pair("browser") };
  if (root) exports["."] = pair(root, true);
  if (webhook) exports["./webhooks"] = pair("webhooks", true);
  const files = new Map([
    [
      "package/package.json",
      {
        data: Buffer.from(
          JSON.stringify({
            name: "@commish/sdk",
            version: "0.1.0-beta.9",
            type: "module",
            exports,
          }),
        ),
      },
    ],
  ]);
  for (const target of Object.values(exports)
    .flatMap(Object.values)
    .filter((value) => typeof value === "string"))
    files.set(`package/${target.slice(2)}`, {
      data: Buffer.from(target === "./dist/index.js" ? implementation : "export {};"),
    });
  return files;
}
function installed(files, use) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "commish-http-test-")));
  try {
    const sdk = join(root, "node_modules/@commish/sdk");
    for (const [name, entry] of files) {
      const path = join(sdk, name.slice(8));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, entry.data);
    }
    use(root, sdk);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("HTTP scope requires the validated runtime root and all promised targets", () => {
  for (const root of [null, "types", "index"])
    for (const webhook of [false, true]) {
      const files = packed(root, webhook);
      if (root !== "index")
        assert.deepEqual(
          verifySdkHttp("unused", files, () => assert.fail()),
          [],
        );
      else
        installed(files, (consumer, sdk) => {
          let calls = 0;
          assert.deepEqual(
            verifySdkHttp(consumer, files, (command, args, options) => {
              calls++;
              assert.equal(command, process.execPath);
              assert.deepEqual(args, [
                join(consumer, "http-probe.mjs"),
                join(sdk, "dist/index.js"),
              ]);
              assert.equal(options.cwd, consumer);
              assert.equal(options.timeout, 30_000);
              assert.equal(options.maxBuffer, 1_048_576);
              assert.equal(options.stdio, "pipe");
              assert(Object.isFrozen(options.env));
              for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"])
                assert.equal(options.env[name], undefined);
              assert.equal(options.env.NODE_DISABLE_COMPILE_CACHE, "1");
              assert.match(readFileSync(args[0], "utf8"), /import\("@commish\/sdk"\)/);
            }),
            [httpConsumerScope],
          );
          assert.equal(calls, 1);
        });
      for (const name of [...files.keys()].filter((name) => name !== "package/package.json")) {
        const missing = new Map(files);
        missing.delete(name);
        assert.throws(
          () => verifySdkHttp("unused", missing, () => assert.fail()),
          /missing promised SDK target/,
        );
      }
    }
});
test("HTTP execution rejects altered bytes, escaped resolution, invalid shapes and failures", () => {
  for (const failure of ["command", "mutation", "external", "tuple"]) {
    const files = packed("index", false);
    installed(files, (consumer, sdk) => {
      if (failure === "external") {
        const target = join(sdk, "dist/index.js");
        rmSync(target);
        writeFileSync(join(consumer, "outside.js"), "export {};");
        symlinkSync(join(consumer, "outside.js"), target);
      }
      if (failure === "tuple") {
        const manifest = JSON.parse(files.get("package/package.json").data);
        manifest.exports["."].browser = "./dist/index.js";
        files.set("package/package.json", { data: Buffer.from(JSON.stringify(manifest)) });
      }
      let calls = 0;
      assert.throws(() =>
        verifySdkHttp(consumer, files, () => {
          calls++;
          if (failure === "command") throw new Error("controlled subprocess failure");
          writeFileSync(join(sdk, "dist/index.js"), "changed");
        }),
      );
      assert.equal(calls, ["external", "tuple"].includes(failure) ? 0 : 1);
    });
  }
});
test("actual Node import cannot accept a promised runtime root missing Commish", () => {
  const files = packed("index", false, "export {};");
  installed(files, (consumer) => {
    assert.throws(
      () => verifySdkHttp(consumer, files),
      (error) => error.status === 1 && error.stderr.toString().includes("public HTTP client"),
    );
  });
});
