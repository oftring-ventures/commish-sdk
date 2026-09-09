import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { nextBrowserTypesScope } from "./verify-next-types.mjs";
import { nextBrowserScope, verifyNextBrowserConsumer } from "./verify-next-browser-consumer.mjs";

const owned = realpathSync(mkdtempSync(join(tmpdir(), "commish-next-context-")));
after(() => rmSync(owned, { recursive: true, force: true }));
const context = {
  build: join(owned, "build"),
  checkout: join(owned, "checkout"),
  lock: Buffer.from("locked"),
};
mkdirSync(context.checkout);
const compiler = join(context.build, "packages/sdk/node_modules/typescript");
for (const [name, data] of Object.entries({
  "pnpm-lock.yaml": "locked",
  "packages/sdk/node_modules/typescript/package.json": JSON.stringify({
    name: "typescript",
    version: "5.9.2",
    bin: { tsc: "./bin/tsc" },
  }),
  ...Object.fromEntries(
    ["bin/tsc", "lib/tsc.js", "lib/_tsc.js", "lib/lib.es2022.d.ts"].map((name) => [
      `packages/sdk/node_modules/typescript/${name}`,
      "",
    ]),
  ),
  "scripts/fixtures/types-next-browser.ts": readFileSync(
    new URL("./fixtures/types-next-browser.ts", import.meta.url),
  ),
})) {
  const path = join(context.build, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
}
// Compiler execution is mocked here; the installed browser identity probe remains real.
function compilerResult(args, cwd) {
  if (args.includes("--version")) return "Version 5.9.2\n";
  if (!args.includes("--listFilesOnly")) return "";
  return [
    join(compiler, "lib/lib.es2022.d.ts"),
    join(cwd, "types-next-browser.ts"),
    ...["sdk", "next"].map((name) => join(cwd, "node_modules/@commish", name, "dist/browser.d.ts")),
  ].join("\n");
}
const pair = (name, server = false) => ({
  ...(server ? { browser: null } : {}),
  types: `./dist/${name}.d.ts`,
  default: `./dist/${name}.js`,
});
function fixture(react = false, server = false) {
  return ["sdk", "next"].map((name) => {
    const manifest = {
      name: `@commish/${name}`,
      version: "0.1.0-beta.9",
      type: "module",
      exports: { "./browser": pair("browser") },
      ...(name === "next" ? { peerDependencies: { "@commish/sdk": "0.1.0-beta.9" } } : {}),
    };
    if (name === "next" && react) {
      manifest.exports["./react"] = pair("provider");
      Object.assign(manifest.peerDependencies, { next: ">=16.2.12 <17", react: ">=19.2.8 <20" });
    }
    if (name === "next" && server) {
      manifest.exports["."] = pair("index", true);
      manifest.bin = { "commish-next": "./bin/init.mjs" };
    }
    const packed = new Map([
      ["package/package.json", { data: Buffer.from(JSON.stringify(manifest)), mode: 0o644 }],
    ]);
    for (const target of [
      ...Object.values(manifest.exports).flatMap(Object.values),
      ...Object.values(manifest.bin ?? {}),
    ].filter((value) => typeof value === "string"))
      packed.set(`package/${target.slice(2)}`, {
        data: Buffer.from("export {};\n"),
        mode: target.startsWith("./bin/") ? 0o755 : 0o644,
      });
    packed.get("package/dist/browser.js").data = Buffer.from(
      name === "sdk"
        ? "export async function captureReferral() { return false; }\n"
        : 'export { captureReferral } from "@commish/sdk/browser";\n',
    );
    return { archive: Buffer.from(`${name} controlled archive`), packed };
  });
}
function install(cwd, packages) {
  const store = join(cwd, "node_modules/.pnpm");
  mkdirSync(join(cwd, "node_modules/@commish"), { recursive: true });
  for (const [index, name] of ["sdk", "next"].entries()) {
    const root = join(store, name, "node_modules/@commish", name);
    for (const [path, entry] of packages[index].packed) {
      const target = join(root, path.slice(8));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, entry.data, { mode: entry.mode });
    }
    symlinkSync(root, join(cwd, "node_modules/@commish", name));
  }
  symlinkSync(
    join(store, "sdk/node_modules/@commish/sdk"),
    join(store, "next/node_modules/@commish/sdk"),
  );
}
function changeManifest(pkg, patch) {
  const entry = pkg.packed.get("package/package.json");
  entry.data = Buffer.from(JSON.stringify({ ...JSON.parse(entry.data), ...patch }));
}

test("paired manifests and every promised target fail before commands", () => {
  const mutations = [
    (p) => changeManifest(p[0], { name: "wrong" }),
    (p) => changeManifest(p[1], { name: "wrong" }),
    (p) => changeManifest(p[0], { version: "0.1.0-beta.8" }),
    (p) => changeManifest(p[1], { version: "0.1.0-beta.8" }),
    (p) => changeManifest(p[0], { peerDependencies: { unexpected: "1" } }),
    (p) => changeManifest(p[1], { peerDependencies: { "@commish/sdk": "workspace:*" } }),
    (p) =>
      changeManifest(p[1], {
        exports: { "./browser": pair("browser"), "./unknown": pair("provider") },
      }),
    (p) => changeManifest(p[0], { exports: { "./browser": pair("wrong") } }),
    ...[0, 1].flatMap((index) =>
      ["dependencies", "optionalDependencies"].map(
        (field) => (p) => changeManifest(p[index], { [field]: { unexpected: "1" } }),
      ),
    ),
  ];
  for (const react of [false, true])
    for (const server of [false, true]) {
      const original = fixture(react, server);
      const negatives = [
        ...mutations,
        ...original.flatMap((pkg, index) =>
          [...pkg.packed.keys()].map((name) => (p) => p[index].packed.delete(name)),
        ),
      ];
      for (const mutate of negatives) {
        const packages = fixture(react, server);
        mutate(packages);
        let called = false;
        assert.throws(() =>
          verifyNextBrowserConsumer(...packages, context, () => {
            called = true;
          }),
        );
        assert.equal(called, false);
      }
    }
});

test("all Next shapes run the actual browser identity probe from isolated paired fixtures", () => {
  for (const react of [false, true])
    for (const server of [false, true]) {
      const packages = fixture(react, server),
        calls = [];
      let root;
      const execute = (command, args, options) => {
        root = options.cwd;
        calls.push([command, args]);
        if (args[0] === "--version") return "11.1.3\n";
        if (command === "pnpm") {
          assert.deepEqual(args, [
            "install",
            "--offline",
            "--ignore-scripts",
            "--ignore-workspace",
            "--config.auto-install-peers=false",
          ]);
          assert.equal(
            JSON.parse(readFileSync(join(root, "package.json"))).packageManager,
            "pnpm@11.1.3",
          );
          for (const [index, name] of ["sdk", "next"].entries())
            assert(readFileSync(join(root, `${name}.tgz`)).equals(packages[index].archive));
          install(root, packages);
          return "";
        }
        assert.equal(command, process.execPath);
        if (args[0] === join(compiler, "bin/tsc")) return compilerResult(args, root);
        assert.deepEqual(args, ["--conditions=browser", "probe.mjs"]);
        return execFileSync(command, args, options);
      };
      assert.deepEqual(verifyNextBrowserConsumer(...packages, context, execute), [
        nextBrowserScope,
        nextBrowserTypesScope,
      ]);
      assert.equal(calls.length, 6);
      assert(root && !existsSync(root));
    }
});

test("missing or overlapping source context cannot install", () => {
  const packages = fixture();
  for (const scope of [
    undefined,
    { build: tmpdir(), checkout: import.meta.dirname },
    { build: import.meta.dirname, checkout: tmpdir() },
  ]) {
    let called = false;
    assert.throws(() =>
      verifyNextBrowserConsumer(...packages, scope, () => {
        called = true;
      }),
    );
    assert.equal(called, false);
  }
});

test("first failures suppress the scope and remove the entire owned consumer", () => {
  for (const failure of [
    "version",
    "install",
    "bytes",
    "mode",
    "closure",
    "external",
    "probe",
    "post-bytes",
    "wrapper",
    "exports",
    "types",
  ]) {
    const packages = fixture();
    if (failure === "wrapper")
      packages[1].packed.get("package/dist/browser.js").data = Buffer.from(
        'import { captureReferral as sdk } from "@commish/sdk/browser"; export const captureReferral = (...args) => sdk(...args);\n',
      );
    if (failure === "exports")
      packages[1].packed.get("package/dist/browser.js").data = Buffer.from(
        "export const other = 1;\n",
      );
    let root;
    const execute = (command, args, options) => {
      root = options.cwd;
      if (args[0] === "--version") return failure === "version" ? "wrong\n" : "11.1.3\n";
      const browser = join(root, "node_modules/@commish/next/dist/browser.js");
      if (command === "pnpm") {
        if (failure === "install") throw new Error("controlled install failure");
        install(root, packages);
        if (failure === "bytes") writeFileSync(browser, "changed");
        if (failure === "mode") packages[1].packed.get("package/dist/browser.js").mode = 0o755;
        if (failure === "closure") mkdirSync(join(root, "node_modules/.pnpm/extra"));
        if (failure === "external") {
          symlinkSync(import.meta.filename, join(root, "node_modules/@commish/next/outside.mjs"));
          packages[1].packed.set("package/outside.mjs", {
            data: readFileSync(import.meta.filename),
            mode: 0o644,
          });
        }
        return "";
      }
      if (args[0] === join(compiler, "bin/tsc")) {
        if (failure === "types") throw new Error("controlled Next compiler failure");
        return compilerResult(args, root);
      }
      if (failure === "probe") throw new Error("controlled probe failure");
      const result = execFileSync(command, args, options);
      if (failure === "post-bytes") writeFileSync(browser, "changed after probe");
      return result;
    };
    assert.throws(
      () => verifyNextBrowserConsumer(...packages, context, execute),
      failure === "wrapper" || failure === "exports"
        ? (error) =>
            error.status === 1 &&
            error.stderr.includes(
              failure === "wrapper" ? "Next browser identity" : "Next browser export names",
            )
        : failure === "types"
          ? /controlled Next compiler failure/
          : undefined,
    );
    assert(root && !existsSync(root), failure);
  }
});
