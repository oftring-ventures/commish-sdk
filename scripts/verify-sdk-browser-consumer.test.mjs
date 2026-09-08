import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { browserConsumerScope, verifySdkBrowserConsumer } from "./verify-sdk-browser-consumer.mjs";

function fixture() {
  return new Map(
    Object.entries({
      "package/package.json": JSON.stringify({
        name: "@commish/sdk",
        version: "0.1.0-beta.9",
        type: "module",
        exports: { "./browser": { types: "./dist/browser.d.ts", default: "./dist/browser.js" } },
      }),
      "package/dist/browser.js": "export async function captureReferral() { return false; }",
      "package/dist/browser.d.ts": "export declare function captureReferral(): Promise<boolean>;",
    }).map(([name, data]) => [name, { data: Buffer.from(data) }]),
  );
}
test("consumer isolates the verified artifact, invokes browser conditions, and cleans every exit", () => {
  for (const failure of [
    null,
    "install",
    "identity",
    "bytes",
    "closure",
    "external",
    "probe",
    "behavior",
    "types",
  ]) {
    const packed = fixture(),
      archive = Buffer.from("controlled archive"),
      calls = [];
    if (failure === "types") {
      const manifest = JSON.parse(packed.get("package/package.json").data);
      manifest.exports["."] = { types: "invalid" };
      packed.set("package/package.json", { data: Buffer.from(JSON.stringify(manifest)) });
    }
    let consumer;
    const run = (command, args, cwd) => {
      consumer = cwd;
      calls.push(command);
      if (command === "pnpm") {
        assert.deepEqual(args, [
          "install",
          "--offline",
          "--ignore-scripts",
          "--ignore-workspace",
          "--config.auto-install-peers=false",
        ]);
        assert(readFileSync(join(cwd, "sdk.tgz")).equals(archive));
        assert.equal(
          JSON.parse(readFileSync(join(cwd, "package.json"))).packageManager,
          "pnpm@11.1.3",
        );
        assert.deepEqual(JSON.parse(readFileSync(join(cwd, "package.json"))).dependencies, {
          "@commish/sdk": "file:./sdk.tgz",
        });
        if (failure === "install") throw new Error("controlled installer failure");
        mkdirSync(join(cwd, "node_modules/.pnpm/sdk"), { recursive: true });
        for (const [name, entry] of packed) {
          const path = join(cwd, "node_modules/@commish/sdk", name.slice(8));
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, entry.data);
        }
        if (failure === "identity")
          writeFileSync(join(cwd, "node_modules/@commish/sdk/package.json"), "{}");
        if (failure === "bytes")
          writeFileSync(join(cwd, "node_modules/@commish/sdk/dist/browser.js"), "changed");
        if (failure === "closure") mkdirSync(join(cwd, "node_modules/.pnpm/unexpected"));
        if (failure === "external")
          symlinkSync(import.meta.filename, join(cwd, "node_modules/@commish/sdk/external.js"));
        if (failure === "external")
          packed.set("package/external.js", { data: readFileSync(import.meta.filename) });
      } else {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, ["--conditions=browser", "probe.mjs"]);
        if (failure === "probe") throw new Error("controlled process failure");
        if (failure === "behavior")
          execFileSync(command, args, { cwd, stdio: "pipe", timeout: 10_000 });
      }
    };
    if (failure) assert.throws(() => verifySdkBrowserConsumer(archive, packed, run));
    else {
      assert.deepEqual(verifySdkBrowserConsumer(archive, packed, run), {
        scopes: [browserConsumerScope],
      });
      assert.deepEqual(calls, ["pnpm", process.execPath]);
    }
    assert(consumer && !existsSync(consumer), "consumer is removed after success or failure");
  }
});
test("missing promises and non-SDK dependency closures fail before installation", () => {
  for (const change of [
    (files) => files.delete("package/dist/browser.js"),
    (files) => files.delete("package/dist/browser.d.ts"),
    ...[
      "name",
      "version",
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "exports",
    ].map((field) => (files) => {
      const value = JSON.parse(files.get("package/package.json").data);
      value[field] =
        field === "name" || field === "version" ? "wrong" : { unexpected: "workspace:*" };
      files.set("package/package.json", { data: Buffer.from(JSON.stringify(value)) });
    }),
  ]) {
    const packed = fixture();
    change(packed);
    let installed = false;
    assert.throws(() =>
      verifySdkBrowserConsumer(Buffer.alloc(0), packed, () => {
        installed = true;
      }),
    );
    assert.equal(installed, false, "must fail before installation");
  }
});
