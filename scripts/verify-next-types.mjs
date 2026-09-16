import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { readProviderTypeInputs } from "./provider-types-lock.mjs";

export const nextBrowserTypesScope = "next-browser-types-external-ts";
export const nextProviderTypesScope = "next-provider-types-external-ts";
const inside = (root, path) => {
  const part = relative(root, path);
  return part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};
const child = (root, path) => {
  const actual = realpathSync(path);
  assert(inside(root, actual), "Next type path escaped its owned root");
  return actual;
};

// The enclosing paired consumer validates complete manifests, archives and installation.
export function verifyNextBrowserTypes(...args) {
  return verifyNextTypes("browser", ...args);
}

export function verifyNextProviderTypes(...args) {
  return verifyNextTypes("provider", ...args);
}

function verifyNextTypes(kind, consumer, sdk, next, context, execute = execFileSync) {
  assert(context, "missing Next compiler context");
  const build = realpathSync(context.build),
    checkout = realpathSync(context.checkout);
  consumer = realpathSync(consumer);
  for (const source of [build, checkout])
    assert(
      consumer !== source && !inside(source, consumer) && !inside(consumer, source),
      "Next type consumer overlaps source",
    );
  const checkLock = () =>
    assert(
      readFileSync(join(build, "pnpm-lock.yaml")).equals(context.lock),
      "Next type lock changed",
    );
  checkLock();
  const compiler = child(build, join(build, "packages/sdk/node_modules/typescript"));
  const manifest = JSON.parse(readFileSync(join(compiler, "package.json")));
  assert.equal(manifest.name, "typescript");
  assert.equal(manifest.version, "5.9.2");
  assert.equal(manifest.bin.tsc, "./bin/tsc");
  const executable = child(compiler, join(compiler, "bin/tsc"));
  for (const file of ["lib/tsc.js", "lib/_tsc.js"]) child(compiler, join(compiler, file));
  const lib = child(compiler, join(compiler, "lib"));
  const packages = [sdk, next].map((packed, index) => {
    const name = index ? "next" : "sdk";
    const item = JSON.parse(packed.get("package/package.json").data);
    assert.equal(item.name, `@commish/${name}`);
    assert.equal(item.version, "0.1.0-beta.10");
    const entry = kind === "provider" && index ? "provider" : "browser";
    assert.deepEqual(item.exports[entry === "provider" ? "./react" : "./browser"], {
      types: `./dist/${entry}.d.ts`,
      default: `./dist/${entry}.js`,
    });
    const installed = child(consumer, join(consumer, "node_modules/@commish", name));
    const declaration = child(installed, join(installed, `dist/${entry}.d.ts`));
    assert(
      readFileSync(declaration).equals(packed.get(`package/dist/${entry}.d.ts`).data),
      "Next browser declaration differs from archive",
    );
    return { packed, installed, declaration };
  });
  const typeInputs = () =>
    kind === "provider" ? readProviderTypeInputs(consumer) : { roots: [], files: [] };
  const originalTypes = typeInputs();
  const typeRoots = originalTypes.roots;
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
  assert.equal(run(["--version"]).trim(), "Version 5.9.2", "wrong actual Next type compiler");
  const fixtureName = kind === "provider" ? "types-next-provider.tsx" : "types-next-browser.ts";
  const fixture = readFileSync(child(build, join(build, "scripts/fixtures", fixtureName)));
  const fixturePath = join(consumer, fixtureName),
    configPath = join(consumer, "tsconfig.next.json");
  const config = JSON.stringify({
    files: [fixtureName],
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      lib: ["ES2022", "DOM"],
      types: [],
      skipLibCheck: false,
      ...(kind === "provider" ? { jsx: "react-jsx" } : {}),
    },
  });
  writeFileSync(fixturePath, fixture);
  writeFileSync(configPath, config);
  run(["-p", configPath]);
  const listed = run(["-p", configPath, "--listFilesOnly"]).trim().split(/\r?\n/).filter(Boolean);
  assert(listed.length, "empty Next type resolution");
  const required = new Set([
    child(consumer, fixturePath),
    ...packages.filter((_, index) => kind === "browser" || index).map((item) => item.declaration),
    ...typeRoots.flatMap((root, index) =>
      (index ? ["index.d.ts"] : ["index.d.ts", "jsx-runtime.d.ts"]).map((name) =>
        child(consumer, join(root, name)),
      ),
    ),
  ]);
  const resolved = new Set(
    listed.map((path) => {
      assert(isAbsolute(path), "relative Next type resolution");
      const actual = realpathSync(path);
      assert(
        required.has(actual) ||
          (dirname(actual) === lib && /^lib\..+\.d\.ts$/.test(basename(actual))) ||
          typeRoots.some((root) => inside(root, actual) && actual.endsWith(".d.ts")),
        "unapproved Next type resolution",
      );
      return actual;
    }),
  );
  for (const path of required) assert(resolved.has(path), "missing Next browser type resolution");
  assert(readFileSync(fixturePath).equals(fixture), "Next type fixture changed");
  assert.equal(readFileSync(configPath, "utf8"), config, "Next type config changed");
  for (const { packed, installed } of packages)
    for (const [name, entry] of packed) {
      const path = child(installed, join(installed, name.slice(8)));
      assert(readFileSync(path).equals(entry.data), "package changed during Next typecheck");
      assert.equal(
        statSync(path).mode & 0o777,
        entry.mode & 0o777,
        "Next type package mode changed",
      );
    }
  assert.deepEqual(typeInputs(), originalTypes, "Next type dependency changed");
  checkLock();
  return [kind === "provider" ? nextProviderTypesScope : nextBrowserTypesScope];
}
