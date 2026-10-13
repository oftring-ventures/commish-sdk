import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const inside = (root, path) => {
  const part = relative(root, path);
  return part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};
const child = (root, path) => {
  const actual = realpathSync(path);
  assert(inside(root, actual), "type consumer escaped its owned root");
  return actual;
};
// The source gate validated the whole export map; the type consumer re-checks the
// typed entries it compiles against and ignores the manifest export.
export function selectSdkTypes(packed) {
  const { exports } = JSON.parse(packed.get("package/package.json").data);
  const browser = exports["./browser"];
  assert(
    browser &&
      !Object.hasOwn(browser, "browser") &&
      browser.types === "./dist/browser.d.ts" &&
      browser.default === "./dist/browser.js",
    "unsupported SDK root tuple",
  );
  const targets = [browser.types, browser.default];
  let kind = null;
  for (const [entry, value] of Object.entries(exports)) {
    if (entry === "./browser" || entry === "./package.json") continue;
    assert([".", "./webhooks"].includes(entry), "unsupported SDK root tuple");
    const stem =
      entry === "./webhooks"
        ? "webhooks"
        : value?.types === "./dist/types.d.ts"
          ? "types"
          : "index";
    assert(
      value &&
        value.browser === null &&
        value.types === `./dist/${stem}.d.ts` &&
        value.default === `./dist/${stem}.js`,
      "unsupported SDK root tuple",
    );
    if (entry === ".") kind = stem;
    targets.push(value.types, value.default);
  }
  for (const target of targets)
    assert(packed.has(`package/${target.slice(2)}`), "missing promised SDK target");
  return kind;
}
export function verifySdkTypes(consumer, packed, context, execute = execFileSync) {
  const kind = selectSdkTypes(packed);
  if (kind === null) return { scopes: [] };
  assert(context, "missing owned compiler context");
  const build = realpathSync(context.build),
    checkout = realpathSync(context.checkout);
  consumer = realpathSync(consumer);
  for (const other of [build, checkout])
    assert(
      consumer !== other && !inside(other, consumer) && !inside(consumer, other),
      "consumer overlaps source",
    );
  const checkLock = () =>
    assert(readFileSync(join(build, "pnpm-lock.yaml")).equals(context.lock), "source lock changed");
  checkLock();
  // The source gate requires exact development pins, so the compiler is the version
  // the SDK manifest names, and a reviewed bump needs no edit here.
  const pinned = JSON.parse(readFileSync(child(build, join(build, "packages/sdk/package.json"))))
    .devDependencies?.typescript;
  assert.match(String(pinned), /^[0-9]+\.[0-9]+\.[0-9]+$/, "TypeScript must be pinned exactly");
  const compiler = child(build, join(build, "packages/sdk/node_modules/typescript"));
  const manifest = JSON.parse(readFileSync(join(compiler, "package.json")));
  assert.equal(manifest.name, "typescript");
  assert.equal(manifest.version, pinned);
  assert.equal(manifest.bin.tsc, "./bin/tsc");
  const executable = child(compiler, join(compiler, "bin/tsc"));
  for (const file of ["lib/tsc.js", "lib/_tsc.js"]) child(compiler, join(compiler, file));
  const lib = child(compiler, join(compiler, "lib"));
  const env = Object.freeze({
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"].includes(name),
      ),
    ),
    NODE_DISABLE_COMPILE_CACHE: "1",
  });
  const run = (args) =>
    execute(process.execPath, [executable, ...args], {
      cwd: consumer,
      env,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
      maxBuffer: 1_048_576,
    });
  assert.equal(run(["--version"]).trim(), `Version ${pinned}`, "wrong actual compiler version");
  const names = ["types-common.ts", kind === "types" ? "types-only.ts" : "types-client.ts"];
  for (const name of names)
    writeFileSync(join(consumer, name), readFileSync(join(build, "scripts/fixtures", name)));
  const config = join(consumer, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
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
    }),
  );
  run(["-p", config]);
  const listed = run(["-p", config, "--listFilesOnly"]).trim().split(/\r?\n/).filter(Boolean);
  assert(listed.length, "empty compiler resolution");
  const installed = child(consumer, join(consumer, "node_modules/@commish/sdk"));
  const allowed = new Set(names.map((name) => child(consumer, join(consumer, name))));
  for (const name of packed.keys())
    if (name.endsWith(".d.ts")) allowed.add(child(installed, join(installed, name.slice(8))));
  const resolved = new Set(
    listed.map((path) => {
      assert(isAbsolute(path), "relative compiler resolution");
      const actual = realpathSync(path);
      assert(
        allowed.has(actual) ||
          (dirname(actual) === lib && /^lib\..+\.d\.ts$/.test(basename(actual))),
        "unapproved compiler resolution",
      );
      return actual;
    }),
  );
  for (const target of [`dist/${kind}.d.ts`, "dist/browser.d.ts"])
    assert(
      resolved.has(child(installed, join(installed, target))),
      "missing SDK declaration resolution",
    );
  for (const name of names)
    assert(
      resolved.has(child(consumer, join(consumer, name))),
      "missing consumer fixture resolution",
    );
  for (const [name, entry] of packed)
    assert(
      readFileSync(child(installed, join(installed, name.slice(8)))).equals(entry.data),
      "SDK mutated during compilation",
    );
  checkLock();
  return {
    scopes: [
      "sdk-public-types-external-ts",
      kind === "types" ? "sdk-types-only-root-external-ts" : "sdk-client-types-external-ts",
    ],
    typeCompiler: {
      version: "5.9.2",
      sourceLockSha256: createHash("sha256").update(context.lock).digest("hex"),
    },
  };
}
