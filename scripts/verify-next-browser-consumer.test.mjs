import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  cpSync,
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
import { stripTypeScriptTypes } from "node:module";
import test, { after } from "node:test";
import { providerTypesLock } from "./provider-types-lock.mjs";
import { nextBrowserTypesScope, nextProviderTypesScope } from "./verify-next-types.mjs";
import {
  nextBrowserScope,
  nextMetadataScope,
  nextProviderLayoutScope,
  verifyNextBrowserConsumer,
  verifyNextProviderConsumer,
} from "./verify-next-browser-consumer.mjs";

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
function fixture(react = false, server = false, framework = react) {
  return ["sdk", "next"].map((name) => {
    const manifest = {
      name: `@commish/${name}`,
      version: "0.1.0-beta.9",
      type: "module",
      engines: { node: ">=24 <25" },
      exports: { "./browser": pair("browser") },
      ...(name === "next" ? { peerDependencies: { "@commish/sdk": "0.1.0-beta.9" } } : {}),
    };
    if (name === "next" && react) manifest.exports["./react"] = pair("provider");
    if (name === "next" && framework) {
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
    if (name === "next" && server)
      packed.get("package/dist/index.js").data = Buffer.from(
        stripTypeScriptTypes(
          readFileSync(new URL("../packages/next/src/index.ts", import.meta.url), "utf8"),
        ),
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
        for (const verify of [verifyNextBrowserConsumer, verifyNextProviderConsumer])
          assert.throws(() =>
            verify(...packages, context, () => {
              called = true;
            }),
          );
        assert.equal(called, false);
      }
    }
});

test("all Next shapes run the actual browser identity probe from isolated paired fixtures", () => {
  for (const [react, framework] of [[false, false], [false, true], [true, true]])
    for (const server of [false, true]) {
      const packages = fixture(react, server, framework),
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
        assert.deepEqual(
          args,
          args[0] === "metadata.mjs" && server
            ? ["metadata.mjs"]
            : ["--conditions=browser", "probe.mjs"],
        );
        return execFileSync(command, args, options);
      };
      assert.deepEqual(verifyNextBrowserConsumer(...packages, context, execute), [
        nextBrowserScope,
        ...(server ? [nextMetadataScope] : []),
        nextBrowserTypesScope,
      ]);
      assert.equal(calls.length, server ? 7 : 6);
      assert(root && !existsSync(root));
    }
});

test("installed Node root rejects wrong exports or behavior and cleans its consumer", () => {
  for (const code of [
    "export const wrong = 1;",
    "export const applyCommishStripeMetadata = (input) => input;",
  ]) {
    const packages = fixture(false, true);
    packages[1].packed.get("package/dist/index.js").data = Buffer.from(code);
    let root;
    const execute = (command, args, options) => {
      root = options.cwd;
      if (args[0] === "--version") return "11.1.3\n";
      if (command === "pnpm") return install(root, packages);
      if (args[0] === join(compiler, "bin/tsc")) return compilerResult(args, root);
      return execFileSync(command, args, options);
    };
    assert.throws(
      () => verifyNextBrowserConsumer(...packages, context, execute),
      (error) =>
        error.status === 1 &&
        /Next (root export names|installed metadata behavior)/.test(error.stderr),
    );
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

// The new profile reuses the real browser probe; only installation/compiler calls are mocked.
test("provider layout freezes registry types then extends the exact local pair offline", () => {
  assert.deepEqual(
    verifyNextProviderConsumer(...fixture(), context, () =>
      assert.fail("absent provider installed"),
    ),
    [],
  );
  for (const failure of [
    null,
    "server",
    "integrity",
    "extra",
    "missing-jsx",
    "wrong-type-version",
    "type-link",
    "type-change",
    "lock-change",
    "registry-install",
    "registry-lock",
    "extension-install",
    "paired-version",
    "paired-integrity",
    "paired-peer",
    "paired-extra",
    "extension-types",
    "provider-compiler",
  ]) {
    const preparation = realpathSync(mkdtempSync(join(tmpdir(), "commish-provider-context-")));
    let consumer;
    try {
      const build = join(preparation, "build");
      cpSync(context.build, build, { recursive: true });
      writeFileSync(
        join(build, "scripts/fixtures/types-next-provider.tsx"),
        readFileSync(new URL("./fixtures/types-next-provider.tsx", import.meta.url)),
      );
      // Controlled source context only: inspect's complete lock fingerprint is independently tested.
      const lock = Buffer.from(
        failure === "integrity"
          ? "invalid"
          : "sha512-AnzbBERsrLKtk2XSfTbYRLjQPdy116Sty4q+T+Bp3IC4l6jNBvreVPAHmpq9qhXQM7CXZPjLVmGMw9sy+hxQ3w== sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==",
      );
      writeFileSync(join(build, "pnpm-lock.yaml"), lock);
      const source = { build, checkout: context.checkout, lock },
        packages = fixture(true, failure === "server"),
        calls = [];
      const execute = (command, args, options) => {
        consumer = options.cwd;
        calls.push([command, args]);
        if (command === "pnpm" && args[0] === "--version") return "11.1.3";
        if (command === "pnpm") {
          const registry = args.includes("--frozen-lockfile");
          assert.deepEqual(args, [
            "install",
            ...(registry
              ? ["--frozen-lockfile", "--registry=https://registry.npmjs.org"]
              : ["--offline", "--no-frozen-lockfile"]),
            "--ignore-scripts",
            "--ignore-workspace",
            "--config.auto-install-peers=false",
          ]);
          assert.deepEqual(JSON.parse(readFileSync(join(consumer, "package.json"))).dependencies, {
            ...(registry
              ? {}
              : { "@commish/sdk": "file:./sdk.tgz", "@commish/next": "file:./next.tgz" }),
            "@types/react": "19.2.18",
            csstype: "3.2.3",
          });
          const locks = providerTypesLock(...packages, lock);
          assert.equal(readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8"), locks.registry);
          if (!registry) {
            assert(
              existsSync(join(consumer, "node_modules/@types/react/index.d.ts")),
              "types install precedes pair",
            );
            if (failure === "extension-install")
              throw new Error("controlled extension install failure");
            install(consumer, packages);
            let generated = locks.paired;
            if (failure === "paired-version")
              generated = generated.replace("version: 0.1.0-beta.9", "version: 0.1.0-beta.8");
            if (failure === "paired-integrity")
              generated = generated.replace("integrity: sha512-", "integrity: sha512-changed");
            if (failure === "paired-peer")
              generated = generated.replace("react: '>=19.2.8 <20'", "react: '*'");
            if (failure === "paired-extra") generated += "extra: true\n";
            writeFileSync(join(consumer, "pnpm-lock.yaml"), generated);
            if (failure === "extension-types")
              writeFileSync(join(consumer, "node_modules/@types/react/index.d.ts"), "changed");
            if (failure === "extra") mkdirSync(join(consumer, "node_modules/.pnpm/extra"));
            return "";
          }
          assert(
            !existsSync(join(consumer, "node_modules/@commish")),
            "registry phase has no local pair",
          );
          if (failure === "registry-install")
            throw new Error("controlled registry install failure");
          if (failure === "registry-lock")
            writeFileSync(join(consumer, "pnpm-lock.yaml"), "changed");
          for (const [index, name] of ["@types/react", "csstype"].entries()) {
            const root = join(
              consumer,
              "node_modules/.pnpm",
              `types-${index}`,
              "node_modules",
              name,
            );
            mkdirSync(root, { recursive: true });
            writeFileSync(
              join(root, "package.json"),
              JSON.stringify({ name, version: index ? "3.2.3" : "19.2.18" }),
            );
            for (const file of index
              ? ["index.d.ts"]
              : ["index.d.ts", "jsx-runtime.d.ts", "global.d.ts"])
              writeFileSync(join(root, file), "");
            const link = join(consumer, "node_modules", name);
            mkdirSync(join(link, ".."), { recursive: true });
            symlinkSync(root, link);
          }
          if (failure === "missing-jsx")
            rmSync(join(consumer, "node_modules/@types/react/jsx-runtime.d.ts"));
          if (failure === "wrong-type-version")
            writeFileSync(
              join(consumer, "node_modules/@types/react/package.json"),
              JSON.stringify({ name: "@types/react", version: "19.0.0" }),
            );
          if (failure === "type-link")
            symlinkSync(
              import.meta.filename,
              join(consumer, "node_modules/@types/react/extra.d.ts"),
            );
          return "";
        }
        if (args[0] === join(build, "packages/sdk/node_modules/typescript/bin/tsc")) {
          if (failure === "provider-compiler")
            throw new Error("controlled provider compiler failure");
          if (args.includes("--version")) return "Version 5.9.2";
          if (!args.includes("--listFilesOnly")) return "";
          return [
            "types-next-provider.tsx",
            "node_modules/@commish/next/dist/provider.d.ts",
            "node_modules/@types/react/index.d.ts",
            "node_modules/@types/react/jsx-runtime.d.ts",
            "node_modules/csstype/index.d.ts",
          ]
            .map((path) => join(consumer, path))
            .join("\n");
        }
        assert.deepEqual(args, ["--conditions=browser", "probe.mjs"]);
        const result = execFileSync(command, args, options);
        if (failure === "type-change")
          writeFileSync(join(consumer, "node_modules/@types/react/index.d.ts"), "changed");
        if (failure === "lock-change") writeFileSync(join(consumer, "pnpm-lock.yaml"), "changed");
        return result;
      };
      const check = () => verifyNextProviderConsumer(...packages, source, execute);
      if (failure && failure !== "server")
        assert.throws(
          check,
          {
            integrity: /type integrity absent/,
            extra: /unexpected paired dependency closure/,
            "missing-jsx": /ENOENT/,
            "wrong-type-version": /19.0.0/,
            "type-link": /dependency contains a link/,
            "type-change": /provider types changed during probe/,
            "lock-change": /provider consumer lock changed/,
            "registry-install": /controlled registry install failure/,
            "registry-lock": /provider registry lock changed/,
            "extension-install": /controlled extension install failure/,
            "paired-version": /provider paired lock differs/,
            "paired-integrity": /provider paired lock differs/,
            "paired-peer": /provider paired lock differs/,
            "paired-extra": /provider paired lock differs/,
            "extension-types": /provider types changed during extension/,
            "provider-compiler": /controlled provider compiler failure/,
          }[failure],
        );
      else {
        assert.deepEqual(check(), [nextProviderLayoutScope, nextProviderTypesScope]);
        assert.equal(calls.length, 8);
      }
      if (consumer) assert.equal(existsSync(consumer), false, "provider consumer cleanup");
    } finally {
      rmSync(preparation, { recursive: true, force: true });
    }
  }
});
