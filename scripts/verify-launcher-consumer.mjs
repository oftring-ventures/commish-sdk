import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { releaseVersion } from "./stable-release.mjs";
import { pnpmVersion } from "./toolchain.mjs";

export const launcherConsumerScope = "launcher-cli-installed-version";
const contained = (root, path) => {
  const part = relative(root, realpathSync(path));
  assert(
    part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`),
    "external consumer resolution",
  );
};
async function launcherProbe(bin, version) {
  const { execFileSync } = await import("node:child_process");
  const output = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (output !== `${version}\n`) throw new Error("launcher did not run the released CLI");
}

// Installs `commish` offline with its SDK dependency overridden to the verified SDK
// archive, so the launcher runs exactly the candidate pair's CLI.
export function verifyLauncherConsumer(
  sdk,
  launcher,
  run = (command, args, cwd) =>
    execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000 }),
) {
  const manifest = JSON.parse(launcher.packed.get("package/package.json").data);
  assert.equal(manifest.name, "commish");
  assert.equal(manifest.version, releaseVersion);
  assert.deepEqual(manifest.dependencies, { "@commish/sdk": releaseVersion });
  assert.deepEqual(manifest.bin, { commish: "./bin/commish.mjs" });
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "commish-launcher-consumer-")));
  try {
    writeFileSync(join(consumer, "sdk.tgz"), sdk.archive);
    writeFileSync(join(consumer, "commish.tgz"), launcher.archive);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        packageManager: `pnpm@${pnpmVersion}`,
        dependencies: { commish: "file:./commish.tgz" },
      }),
    );
    // pnpm reads overrides from the workspace file; a package.json override is ignored.
    writeFileSync(
      join(consumer, "pnpm-workspace.yaml"),
      'overrides:\n  "@commish/sdk": file:./sdk.tgz\n',
    );
    run(
      "pnpm",
      ["install", "--offline", "--ignore-scripts", "--config.auto-install-peers=false"],
      consumer,
    );
    const modules = join(consumer, "node_modules"),
      store = join(modules, ".pnpm");
    assert.deepEqual(
      readdirSync(modules).filter((name) => !name.startsWith(".")),
      ["commish"],
    );
    assert.deepEqual(
      readdirSync(store, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
        .map((entry) => entry.name)
        .sort(),
      ["@commish+sdk@file+sdk.tgz", "commish@file+commish.tgz"],
      "launcher must install only the verified SDK archive",
    );
    for (const [installed, packed] of [
      [join(modules, "commish"), launcher.packed],
      [join(store, "@commish+sdk@file+sdk.tgz/node_modules/@commish/sdk"), sdk.packed],
    ])
      for (const [name, entry] of packed) {
        const path = join(installed, name.slice("package/".length));
        contained(consumer, path);
        assert(
          readFileSync(path).equals(entry.data),
          "installed artifact differs from verified archive",
        );
      }
    writeFileSync(
      join(consumer, "launcher-probe.mjs"),
      `await (${launcherProbe.toString()})(${JSON.stringify(join(modules, ".bin/commish"))}, ${JSON.stringify(releaseVersion)});\n`,
    );
    run(process.execPath, ["launcher-probe.mjs"], consumer);
    return [launcherConsumerScope];
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}
