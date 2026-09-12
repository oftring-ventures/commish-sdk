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
import { verifySdkWebhooks, webhookConsumerScope } from "./verify-sdk-webhooks.mjs";

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
            version: "0.1.0-beta.10",
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
      data: Buffer.from(target === "./dist/webhooks.js" ? implementation : "export {};"),
    });
  return files;
}
function installed(files, use) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "commish-webhooks-test-")));
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
test("webhook selection follows validated optional presence for every supported root", () => {
  for (const root of [null, "types", "index"]) {
    assert.deepEqual(
      verifySdkWebhooks("unused", packed(root, false), () => assert.fail()),
      [],
    );
    const files = packed(root, true);
    installed(files, (consumer, sdk) => {
      let calls = 0;
      assert.deepEqual(
        verifySdkWebhooks(consumer, files, (command, args, options) => {
          calls++;
          assert.equal(command, process.execPath);
          assert.deepEqual(args, [
            join(consumer, "webhooks-probe.mjs"),
            join(sdk, "dist/webhooks.js"),
          ]);
          assert.equal(options.cwd, consumer);
          assert.equal(options.timeout, 30_000);
          assert.equal(options.maxBuffer, 1_048_576);
          assert.equal(options.stdio, "pipe");
          assert(Object.isFrozen(options.env));
          for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"])
            assert.equal(options.env[name], undefined);
          assert.equal(options.env.NODE_DISABLE_COMPILE_CACHE, "1");
          assert.match(readFileSync(args[0], "utf8"), /import\("@commish\/sdk\/webhooks"\)/);
        }),
        [webhookConsumerScope],
      );
      assert.equal(calls, 1);
    });
    for (const name of ["package/dist/webhooks.js", "package/dist/webhooks.d.ts"]) {
      const missing = new Map(files);
      missing.delete(name);
      assert.throws(
        () => verifySdkWebhooks("unused", missing, () => assert.fail()),
        /missing promised SDK target/,
      );
    }
  }
});
test("runtime failure, changed installed bytes and external resolution cannot produce scope", () => {
  for (const failure of ["command", "mutation", "external", "tuple"]) {
    const files = packed(null, true);
    installed(files, (consumer, sdk) => {
      if (failure === "external") {
        const target = join(sdk, "dist/webhooks.js");
        rmSync(target);
        writeFileSync(join(consumer, "outside.js"), "export {};");
        symlinkSync(join(consumer, "outside.js"), target);
      }
      if (failure === "tuple") {
        const manifest = JSON.parse(files.get("package/package.json").data);
        manifest.exports["./webhooks"].browser = "./dist/webhooks.js";
        files.set("package/package.json", { data: Buffer.from(JSON.stringify(manifest)) });
      }
      let calls = 0;
      assert.throws(() =>
        verifySdkWebhooks(consumer, files, () => {
          calls++;
          if (failure === "command") throw new Error("controlled subprocess failure");
          writeFileSync(join(sdk, "dist/webhooks.js"), "changed");
        }),
      );
      assert.equal(calls, ["external", "tuple"].includes(failure) ? 0 : 1);
    });
  }
});
test("actual Node import rejects missing exports, wrong signatures and permissive verifiers", () => {
  for (const [implementation, diagnostic] of [
    [
      `export function signWebhook() { return "wrong"; }
export function verifyWebhook() { return true; }`,
      "HMAC signing vector",
    ],
    [
      `export function signWebhook() {
  return "t=1000,v1=69247e8c853132093c4013883f4111557d7be5b575a9373b6992355306cd0fad";
}
export function verifyWebhook() { return true; }`,
      "payload-byte tampering",
    ],
    [
      `export function signWebhook() {
  return "t=1000,v1=69247e8c853132093c4013883f4111557d7be5b575a9373b6992355306cd0fad";
}`,
      "public webhook verifier",
    ],
  ]) {
    const files = packed(null, true, implementation);
    installed(files, (consumer) => {
      assert.throws(
        () => verifySdkWebhooks(consumer, files),
        (error) => error.status === 1 && error.stderr.toString().includes(diagnostic),
      );
    });
  }
});
