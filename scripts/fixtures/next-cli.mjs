export async function cliProbe(executable, invoke) {
  const { default: assert } = await import("node:assert/strict");
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, readdirSync, readFileSync, lstatSync, rmSync, writeFileSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "commish-cli-probe-"));
  invoke ??= (cwd, args) => spawnSync(executable, args, {
    cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 65_536,
  });
  const snapshot = (cwd) => readdirSync(cwd, { recursive: true }).sort().map((name) => {
    const path = join(cwd, name), stat = lstatSync(path);
    return [name, stat.mode, stat.mtimeMs, stat.isFile() ? readFileSync(path).toString("hex") : null];
  });
  const run = (cwd, args, status = 0) => {
    const result = invoke(cwd, [...args, "--json"]);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, status, result.stderr);
    return JSON.parse(status ? result.stderr : result.stdout);
  };
  try {
    for (const [index, directories] of [[], ["app"], ["src/app"], ["app", "src/app"]].entries()) {
      const cwd = join(root, `consumer ${index}`);
      mkdirSync(cwd);
      writeFileSync(join(cwd, "keep.txt"), "original consumer file\n");
      for (const dir of directories) {
        mkdirSync(join(cwd, dir), { recursive: true });
        writeFileSync(join(cwd, dir, "layout.tsx"), "existing layout\n");
      }
      const before = snapshot(cwd);
      const plan = run(cwd, [], directories.length ? 0 : 1);
      assert.deepEqual(snapshot(cwd), before, "initializer changed consumer files");
      if (!directories.length) {
        run(cwd, ["--write"], 1);
        assert.deepEqual(snapshot(cwd), before);
        continue;
      }
      const app = directories.includes("app") ? "app" : "src/app";
      assert.equal(plan.app, app);
      assert.equal(plan.status, "plan");
      assert.equal(plan.integrationVerified, false);
      assert(plan.next.some((step) => step.includes(`${app}/layout`)));
      const installed = run(cwd, ["init", "--write"]);
      assert.equal(installed.status, "files_installed");
      assert.equal(installed.files.length, 2);
      for (const { path } of installed.files) assert(readFileSync(join(cwd, path), "utf8").includes("@commish/next"));
      for (const dir of directories) assert.equal(readFileSync(join(cwd, dir, "layout.tsx"), "utf8"), "existing layout\n");
      const after = snapshot(cwd);
      assert(run(cwd, ["--write"]).files.every(({ status }) => status === "unchanged"));
      assert.deepEqual(snapshot(cwd), after, "repeat install changed consumer files");
      run(cwd, ["--unknown"], 1);
      assert.deepEqual(snapshot(cwd), after);
    }
    const js = join(root, "javascript consumer");
    mkdirSync(join(js, "app"), { recursive: true });
    writeFileSync(join(js, "app/layout.jsx"), "existing JS layout\n");
    const installedJs = run(js, ["--write"]);
    assert.deepEqual(installedJs.files.map(({ path }) => path), [
      "app/api/commish/attribution/route.js", "app/commish-provider.jsx",
    ]);
    assert(!readFileSync(join(js, "app/commish-provider.jsx"), "utf8").includes("ReactNode"));
    assert(run(js, ["--write"]).files.every(({ status }) => status === "unchanged"));
    // Preflight both targets before writing either; custom code is never overwritten.
    for (const conflict of ["app/commish-provider.tsx", "app/api/commish/attribution/route.ts",
      "app/api/commish/attribution/route.js", "app/commish-provider.jsx",
      "app/api/commish/attribution/page.tsx", "app/api/commish/attribution/page.js"]) {
      const cwd = join(root, `conflict-${conflict.replaceAll("/", "-")}`);
      mkdirSync(join(cwd, "app/api/commish/attribution"), { recursive: true });
      writeFileSync(join(cwd, conflict), "customer code\n");
      const before = snapshot(cwd);
      run(cwd, ["--write"], 1);
      assert.deepEqual(snapshot(cwd), before, "conflict changed consumer files");
    }
    for (const target of ["app", "app/api", "app/commish-provider.tsx"]) {
      const cwd = join(root, `symlink-${target.replaceAll("/", "-")}`);
      mkdirSync(join(cwd, "app"), { recursive: true });
      if (target === "app") rmSync(join(cwd, "app"), { recursive: true });
      symlinkSync(join(root, "outside-does-not-exist"), join(cwd, target));
      const before = snapshot(cwd);
      run(cwd, ["--write"], 1);
      assert.deepEqual(snapshot(cwd), before, "symlink changed consumer files");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
