import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nextBrowserTypesScope, verifyNextBrowserTypes } from "./verify-next-types.mjs";

// These controls mock compiler execution. Real packed declaration acceptance is separate.
test("Next declaration compiler, project, resolution and mutation boundaries fail closed", () => {
  const cases = [
    [null],
    ["context", /missing Next compiler context/, 0],
    ["overlap", /overlaps source/, 0],
    ["lock", /Next type lock changed/, 0],
    ["compiler-path", /escaped its owned root/, 0],
    ["version", /5\.9\.2/, 0],
    ["actual-version", /wrong actual Next type compiler/, 1],
    ["fixture", /ENOENT.*types-next-browser/, 1],
    ["sdk-link", /escaped its owned root/, 0],
    ["next-bytes", /differs from archive/, 0],
    ["command", /controlled compile failure/, 2],
    ["empty", /empty Next type resolution/, 3],
    ["relative", /relative Next type resolution/, 3],
    ["source", /unapproved Next type resolution/, 3],
    ["unknown-lib", /unapproved Next type resolution/, 3],
    ...["sdk", "next", "fixture"].map((name) => [
      `missing-${name}`,
      /missing Next browser type resolution/,
      3,
    ]),
    ["fixture-change", /Next type fixture changed/, 3],
    ["config-change", /Next type config changed/, 3],
    ["bytes-change", /package changed during Next typecheck/, 3],
    ["mode-change", /Next type package mode changed/, 3],
    ["late-lock", /Next type lock changed/, 3],
  ];
  for (const [failure, message, count] of cases) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "commish-next-types-test-")));
    const build = join(root, "build"),
      checkout = join(root, "checkout"),
      consumer = join(root, "consumer");
    const compiler = join(build, "packages/sdk/node_modules/typescript");
    const write = (path, data) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, data, { mode: 0o644 });
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
      for (const file of ["bin/tsc", "lib/tsc.js", "lib/_tsc.js", "lib/lib.es2022.d.ts"])
        write(join(compiler, file), "");
      mkdirSync(join(build, "scripts/fixtures"), { recursive: true });
      if (failure !== "fixture")
        write(
          join(build, "scripts/fixtures/types-next-browser.ts"),
          readFileSync(new URL("./fixtures/types-next-browser.ts", import.meta.url)),
        );
      const installed = ["sdk", "next"].map((name) =>
        join(consumer, "node_modules/@commish", name),
      );
      const packages = ["sdk", "next"].map((name, index) => {
        const entries = {
          "package.json": JSON.stringify({
            name: `@commish/${name}`,
            version: "0.1.0-beta.9",
            exports: {
              "./browser": { types: "./dist/browser.d.ts", default: "./dist/browser.js" },
            },
          }),
          "dist/browser.js": "export {};\n",
          "dist/browser.d.ts": "export {};\n",
        };
        return new Map(
          Object.entries(entries).map(([path, data]) => {
            write(join(installed[index], path), data);
            return [`package/${path}`, { data: Buffer.from(data), mode: 0o644 }];
          }),
        );
      });
      const context = { build, checkout, lock: Buffer.from("locked") },
        calls = [];
      if (failure === "lock") write(join(build, "pnpm-lock.yaml"), "changed");
      if (failure === "compiler-path" || failure === "sdk-link") {
        const target =
          failure === "compiler-path"
            ? join(compiler, "bin/tsc")
            : join(installed[0], "dist/browser.d.ts");
        rmSync(target);
        write(join(checkout, "outside"), "export {};\n");
        symlinkSync(join(checkout, "outside"), target);
      }
      if (failure === "next-bytes") write(join(installed[1], "dist/browser.d.ts"), "changed");
      const execute = (command, args, options) => {
        calls.push(args);
        assert.equal(command, process.execPath);
        assert.equal(args[0], join(compiler, "bin/tsc"));
        assert.equal(options.cwd, consumer);
        for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"])
          assert.equal(options.env[key], undefined);
        assert.equal(options.env.NODE_DISABLE_COMPILE_CACHE, "1");
        assert(Object.isFrozen(options.env));
        assert.equal(options.timeout, 30_000);
        assert.equal(options.maxBuffer, 1_048_576);
        if (args.includes("--version"))
          return failure === "actual-version" ? "Version 0" : "Version 5.9.2\n";
        const config = join(consumer, "tsconfig.next.json"),
          fixture = join(consumer, "types-next-browser.ts");
        assert.deepEqual(JSON.parse(readFileSync(config)), {
          files: ["types-next-browser.ts"],
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
        if (failure === "command") throw new Error("controlled compile failure");
        if (!args.includes("--listFilesOnly")) return "";
        if (failure === "empty") return "";
        const listed = [
          ...installed.map((path) => join(path, "dist/browser.d.ts")),
          fixture,
          join(compiler, "lib/lib.es2022.d.ts"),
        ];
        if (failure?.startsWith("missing-"))
          listed.splice(["missing-sdk", "missing-next", "missing-fixture"].indexOf(failure), 1);
        if (failure === "relative") listed.push("relative.d.ts");
        if (failure === "source" || failure === "unknown-lib") {
          const extra =
            failure === "source" ? join(build, "source.d.ts") : join(compiler, "lib/unknown.d.ts");
          write(extra, "");
          listed.push(extra);
        }
        if (failure === "fixture-change") write(fixture, "changed");
        if (failure === "config-change") write(config, "{}");
        if (failure === "bytes-change") write(join(installed[0], "dist/browser.js"), "changed");
        if (failure === "mode-change") chmodSync(join(installed[1], "dist/browser.js"), 0o755);
        if (failure === "late-lock") write(join(build, "pnpm-lock.yaml"), "changed");
        return listed.join("\n") + "\n";
      };
      const check = () =>
        verifyNextBrowserTypes(
          failure === "overlap" ? build : consumer,
          ...packages,
          failure === "context" ? undefined : context,
          execute,
        );
      if (failure) {
        assert.throws(check, message, failure);
        assert.equal(calls.length, count, failure);
      } else {
        assert.deepEqual(check(), [nextBrowserTypesScope]);
        assert.equal(calls.length, 3);
        assert.deepEqual(calls[1].slice(1), ["-p", join(consumer, "tsconfig.next.json")]);
        assert(calls[2].includes("--listFilesOnly"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
