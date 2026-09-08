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
const pair = (name, server = false) => ({
  ...(server ? { browser: null } : {}),
  types: `./dist/${name}.d.ts`,
  default: `./dist/${name}.js`,
});
export function selectSdkTypes(packed) {
  const { exports } = JSON.parse(packed.get("package/package.json").data);
  const expected = { "./browser": pair("browser") };
  let kind = null;
  if (Object.hasOwn(exports, ".")) {
    kind = exports["."]?.types === "./dist/types.d.ts" ? "types" : "index";
    expected["."] = pair(kind, true);
  }
  if (Object.hasOwn(exports, "./webhooks")) expected["./webhooks"] = pair("webhooks", true);
  assert.deepEqual(exports, expected, "unsupported SDK root tuple");
  for (const entry of Object.values(expected)
    .flatMap(Object.values)
    .filter((value) => typeof value === "string"))
    assert(packed.has(`package/${entry.slice(2)}`), "missing promised SDK target");
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
  const compiler = child(build, join(build, "packages/sdk/node_modules/typescript"));
  const manifest = JSON.parse(readFileSync(join(compiler, "package.json")));
  assert.equal(manifest.name, "typescript");
  assert.equal(manifest.version, "5.9.2");
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
  assert.equal(run(["--version"]).trim(), "Version 5.9.2", "wrong actual compiler version");
  const names = ["types-common.ts", ...(kind === "types" ? ["types-only.ts"] : [])];
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
  for (const [name, entry] of packed)
    assert(
      readFileSync(child(installed, join(installed, name.slice(8)))).equals(entry.data),
      "SDK mutated during compilation",
    );
  checkLock();
  return {
    scopes: [
      "sdk-public-types-external-ts",
      ...(kind === "types" ? ["sdk-types-only-root-external-ts"] : []),
    ],
    typeCompiler: {
      version: "5.9.2",
      sourceLockSha256: createHash("sha256").update(context.lock).digest("hex"),
    },
  };
}
