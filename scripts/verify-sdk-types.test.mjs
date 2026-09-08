import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { selectSdkTypes, verifySdkTypes } from "./verify-sdk-types.mjs";

function packed(kind = "types", webhook = false) {
  const pair = (name, server = false) => ({
    ...(server ? { browser: null } : {}),
    types: `./dist/${name}.d.ts`,
    default: `./dist/${name}.js`,
  });
  const exports = { "./browser": pair("browser") };
  if (kind) exports["."] = pair(kind, true);
  if (webhook) exports["./webhooks"] = pair("webhooks", true);
  const files = new Map([
    ["package/package.json", { data: Buffer.from(JSON.stringify({ exports })) }],
  ]);
  for (const value of Object.values(exports)
    .flatMap(Object.values)
    .filter((value) => typeof value === "string"))
    files.set(`package/${value.slice(2)}`, { data: Buffer.from("export {};\n") });
  return files;
}
test("only exact no-root, types-only and runtime-root tuples select type scope", () => {
  for (const kind of [null, "types", "index"])
    for (const webhook of [false, true]) {
      const files = packed(kind, webhook);
      const { exports } = JSON.parse(files.get("package/package.json").data);
      assert.equal(Object.hasOwn(exports, "./webhooks"), webhook);
      assert.equal(selectSdkTypes(files), kind);
      if (kind === null) assert.deepEqual(verifySdkTypes("unused", files), { scopes: [] });
      for (const name of files.keys()) {
        if (name === "package/package.json") continue;
        const missing = new Map(files);
        missing.delete(name);
        assert.throws(() => selectSdkTypes(missing), /missing promised SDK target/);
      }
    }
  for (const mutate of [
    (files) => {
      const manifest = JSON.parse(files.get("package/package.json").data);
      manifest.exports["./unknown"] = manifest.exports["./browser"];
      files.set("package/package.json", { data: Buffer.from(JSON.stringify(manifest)) });
    },
    (files) => files.delete("package/dist/types.d.ts"),
    (files) => files.delete("package/dist/types.js"),
    (files) => {
      const manifest = JSON.parse(files.get("package/package.json").data);
      manifest.exports["."].default = "./dist/unknown.js";
      files.set("package/package.json", { data: Buffer.from(JSON.stringify(manifest)) });
    },
  ]) {
    const files = packed();
    mutate(files);
    assert.throws(() => selectSdkTypes(files));
  }
});
test("compiler context, exact project, resolution, mutation and failure boundaries", () => {
  const typeFailures = [
    null,
    "context",
    "lock",
    "compiler-path",
    "version",
    "actual-version",
    "empty",
    "incomplete",
    "source",
    "sdk-link",
    "mutation",
    "late-lock",
    "command",
  ];
  for (const { kind, webhook = false, failure } of [
    ...typeFailures.map((failure) => ({ kind: "types", failure })),
    { kind: "index", failure: null },
    { kind: "index", webhook: true, failure: null },
    { kind: "index", failure: "fixture" },
    { kind: "index", failure: "fixture-resolution" },
    { kind: "index", failure: "client-command" },
  ]) {
    const names = ["types-common.ts", kind === "types" ? "types-only.ts" : "types-client.ts"];
    const root = mkdtempSync(join(tmpdir(), "commish-types-test-"));
    const build = join(root, "build"),
      checkout = join(root, "checkout"),
      consumer = join(root, "consumer");
    const compiler = join(build, "packages/sdk/node_modules/typescript"),
      sdk = join(consumer, "node_modules/@commish/sdk"),
      files = packed(kind, webhook);
    const write = (file, data) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, data);
    };
    try {
      mkdirSync(checkout);
      write(join(build, "pnpm-lock.yaml"), "locked");
      write(
        join(compiler, "package.json"),
        JSON.stringify({
          name: "typescript",
          version: failure === "version" ? "0" : "5.9.2",
          bin: { tsc: "./bin/tsc" },
        }),
      );
      for (const name of ["bin/tsc", "lib/tsc.js", "lib/_tsc.js", "lib/lib.es2022.d.ts"])
        write(join(compiler, name), "");
      for (const name of names)
        if (!(failure === "fixture" && name === "types-client.ts"))
          write(
            join(build, "scripts/fixtures", name),
            readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
          );
      for (const [name, entry] of files) write(join(sdk, name.slice(8)), entry.data);
      const context = { build, checkout, lock: Buffer.from("locked") },
        calls = [];
      if (failure === "lock") write(join(build, "pnpm-lock.yaml"), "changed");
      if (failure === "compiler-path") {
        rmSync(join(compiler, "bin/tsc"));
        write(join(checkout, "tsc"), "");
        symlinkSync(join(checkout, "tsc"), join(compiler, "bin/tsc"));
      }
      if (failure === "sdk-link") {
        rmSync(join(sdk, `dist/${kind}.d.ts`));
        write(join(checkout, "types.d.ts"), "export {};\n");
        symlinkSync(join(checkout, "types.d.ts"), join(sdk, `dist/${kind}.d.ts`));
      }
      const execute = (command, args, options) => {
        calls.push(args);
        assert.equal(command, process.execPath);
        assert.equal(options.cwd, consumer);
        for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"])
          assert.equal(options.env[key], undefined);
        assert.equal(options.env.NODE_DISABLE_COMPILE_CACHE, "1");
        assert(Object.isFrozen(options.env));
        assert.equal(options.timeout, 30_000);
        assert.equal(options.maxBuffer, 1_048_576);
        if (failure === "command") throw new Error("controlled compiler failure");
        if (args.includes("--version"))
          return failure === "actual-version" ? "Version 0" : "Version 5.9.2\n";
        assert.deepEqual(JSON.parse(readFileSync(join(consumer, "tsconfig.json"))), {
          files: names,
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            types: [],
            skipLibCheck: false,
          },
        });
        if (failure === "client-command") throw new Error("controlled full-root compiler failure");
        if (!args.includes("--listFilesOnly")) return "";
        if (failure === "empty") return "";
        const listed = [
          join(compiler, "lib/lib.es2022.d.ts"),
          join(sdk, `dist/${kind}.d.ts`),
          join(sdk, "dist/browser.d.ts"),
          ...names.map((name) => join(consumer, name)),
        ];
        if (failure === "incomplete") listed.splice(2, 1);
        if (failure === "fixture-resolution") listed.pop();
        if (failure === "source") {
          write(join(build, "packages/sdk/src/types.ts"), "");
          listed.push(join(build, "packages/sdk/src/types.ts"));
        }
        if (failure === "mutation") write(join(sdk, `dist/${kind}.d.ts`), "changed");
        if (failure === "late-lock") write(join(build, "pnpm-lock.yaml"), "changed");
        return listed.join("\n") + "\n";
      };
      const check = () =>
        verifySdkTypes(consumer, files, failure === "context" ? undefined : context, execute);
      if (failure === "fixture") assert.throws(check, /ENOENT.*types-client\.ts/);
      else if (failure === "fixture-resolution")
        assert.throws(check, /missing consumer fixture resolution/);
      else if (failure === "client-command")
        assert.throws(check, /controlled full-root compiler failure/);
      else if (failure) assert.throws(check);
      else {
        assert.deepEqual(check().scopes, [
          "sdk-public-types-external-ts",
          kind === "types" ? "sdk-types-only-root-external-ts" : "sdk-client-types-external-ts",
        ]);
        assert.equal(calls.length, 3);
        assert(calls[2].includes("--listFilesOnly"));
        assert(!calls[1].includes("--listFilesOnly"));
      }
      if (failure === "fixture") assert.equal(calls.length, 1);
      if (failure === "client-command") assert.equal(calls.length, 2);
      if (failure === "fixture-resolution") assert.equal(calls.length, 3);
      if (["context", "lock", "compiler-path", "version"].includes(failure))
        assert.equal(calls.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
