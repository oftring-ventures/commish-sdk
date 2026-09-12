export async function cliProbe(executable, invoke) {
  const { default: assert } = await import("node:assert/strict");
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, readdirSync, readFileSync, lstatSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "commish-cli-probe-"));
  invoke ??= (cwd) => spawnSync(executable, [], {
    cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 65_536,
  });
  const snapshot = (cwd) => readdirSync(cwd, { recursive: true }).sort().map((name) => {
    const path = join(cwd, name), stat = lstatSync(path);
    assert(stat.isDirectory() || stat.isFile(), "unexpected CLI fixture entry");
    return [name, stat.mode, stat.mtimeMs, stat.isFile() ? readFileSync(path).toString("hex") : null];
  });
  try {
    for (const [index, directories] of [[], ["app"], ["src/app"], ["app", "src/app"]].entries()) {
      const cwd = join(root, `consumer ${index}`);
      mkdirSync(cwd);
      writeFileSync(join(cwd, "keep.txt"), "original consumer file\n");
      for (const dir of directories) {
        mkdirSync(join(cwd, dir, "api/commish/attribution"), { recursive: true });
        writeFileSync(join(cwd, dir, "layout.tsx"), "existing layout\n");
        writeFileSync(join(cwd, dir, "api/commish/attribution/route.ts"), "existing route\n");
      }
      const before = snapshot(cwd), result = invoke(cwd);
      assert.deepEqual(snapshot(cwd), before, "initializer changed consumer files");
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, directories.length ? 0 : 1);
      const app = directories.includes("src/app") ? "src/app" : "app";
      assert.equal(result.stdout, "Commish Next.js initializer (dry run)\n" + (directories.length
        ? `Would add ${app}/api/commish/attribution/route.ts\nWould wrap ${app}/layout.tsx with CommishProvider\nDry run only in v0.1. Apply the documented changes after reviewing them.\n`
        : ""));
      assert.equal(result.stderr, directories.length ? "" : "No Next.js App Router directory found. No files changed.\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
