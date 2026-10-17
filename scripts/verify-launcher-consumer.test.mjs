import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { releaseVersion } from "./stable-release.mjs";
import { launcherConsumerScope, verifyLauncherConsumer } from "./verify-launcher-consumer.mjs";

const packed = (entries) =>
  new Map(Object.entries(entries).map(([name, data]) => [name, { data: Buffer.from(data) }]));
const fixture = (launcherManifest = {}) => ({
  sdk: {
    archive: Buffer.from("sdk archive"),
    packed: packed({
      "package/package.json": JSON.stringify({ name: "@commish/sdk", version: releaseVersion }),
      "package/bin/init.mjs": "// cli",
    }),
  },
  launcher: {
    archive: Buffer.from("launcher archive"),
    packed: packed({
      "package/package.json": JSON.stringify({
        name: "commish",
        version: releaseVersion,
        dependencies: { "@commish/sdk": releaseVersion },
        bin: { commish: "./bin/commish.mjs" },
        ...launcherManifest,
      }),
      "package/bin/commish.mjs": "// launcher",
    }),
  },
});
// Stands in for pnpm: lays out the isolated store the way an offline install does.
function stubRun(f, failure) {
  let consumer;
  const run = (command, args, cwd) => {
    consumer = cwd;
    if (command !== "pnpm") {
      if (failure === "probe") throw new Error("controlled probe failure");
      assert.equal(command, process.execPath);
      assert(readFileSync(join(cwd, args[0]), "utf8").includes(JSON.stringify(releaseVersion)));
      return;
    }
    assert.deepEqual(args, [
      "install",
      "--offline",
      "--ignore-scripts",
      "--config.auto-install-peers=false",
    ]);
    assert.match(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8"), /file:\.\/sdk\.tgz/);
    const store = join(cwd, "node_modules/.pnpm");
    const place = (root, entries) => {
      for (const [name, entry] of entries) {
        const path = join(root, name.slice("package/".length));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, failure === "bytes" ? "changed" : entry.data);
      }
    };
    const launcher = join(store, "commish@file+commish.tgz/node_modules/commish");
    place(launcher, f.launcher.packed);
    place(join(store, "@commish+sdk@file+sdk.tgz/node_modules/@commish/sdk"), f.sdk.packed);
    if (failure === "extra") mkdirSync(join(store, "left-pad@1.0.0"));
    symlinkSync(launcher, join(cwd, "node_modules/commish"));
  };
  return { run, consumer: () => consumer };
}

test("the launcher installs only the verified SDK archive and runs the released CLI", () => {
  for (const failure of [null, "bytes", "extra", "probe"]) {
    const f = fixture(),
      stub = stubRun(f, failure);
    if (failure) assert.throws(() => verifyLauncherConsumer(f.sdk, f.launcher, stub.run));
    else
      assert.deepEqual(verifyLauncherConsumer(f.sdk, f.launcher, stub.run), [
        launcherConsumerScope,
      ]);
    assert(stub.consumer() && !existsSync(stub.consumer()), "consumer must be removed");
  }
  for (const manifest of [
    { dependencies: { "@commish/sdk": "0.0.1" } },
    { dependencies: { "@commish/sdk": releaseVersion, extra: "1.0.0" } },
    { bin: { commish: "./bin/other.mjs" } },
    { name: "@commish/cli" },
  ]) {
    const f = fixture(manifest);
    assert.throws(() => verifyLauncherConsumer(f.sdk, f.launcher, stubRun(f).run));
  }
});
