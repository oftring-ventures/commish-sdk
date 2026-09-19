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

export async function verifyCliProbe(executable) {
  const { default: assert } = await import("node:assert/strict");
  const { execFile } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = mkdtempSync(join(tmpdir(), "commish-verify-probe-"));
  writeFileSync(join(cwd, "keep.txt"), "consumer-owned");
  let requests = [], httpStatus = 200, payload, redirect;
  const server = createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
    res.writeHead(httpStatus, { "content-type": "application/json", ...(redirect ? { location: redirect } : {}) });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
  const env = {
    PATH: process.env.PATH,
    COMMISH_SECRET_KEY: "cm_test_sk_fixture_only_123456",
    NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY: "cm_test_pk_fixture_only_123456",
    NEXT_PUBLIC_COMMISH_APPLICATION_ID: "app_fixture_only_123456",
    COMMISH_PROGRAM_ID: "prg_fixture_only_123456",
  };
  const run = (changes = {}, args = ["verify", "--json"]) => new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, env: { ...env, ...changes }, timeout: 15_000, maxBuffer: 65_536 },
      (error, stdout, stderr) => {
        try {
          assert(!error?.killed);
          assert(!`${stdout}${stderr}`.includes("fixture_only_123456_secret"));
          assert(!`${stdout}${stderr}`.includes("cm_test_sk_"));
          assert(!`${stdout}${stderr}`.includes("cm_live_sk_"));
          resolve({ code: error?.code ?? 0, body: JSON.parse(error ? stderr : stdout) });
        } catch (failure) { reject(failure); }
      });
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    env.COMMISH_API_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
    for (const mode of ["test", "live"]) {
      for (const status of ["active", "draft", "paused", "suspended", "archived"]) {
        payload = { data: { id: env.COMMISH_PROGRAM_ID, applicationId: env.NEXT_PUBLIC_COMMISH_APPLICATION_ID, mode, status } };
        const result = await run({ COMMISH_SECRET_KEY: `cm_${mode}_sk_fixture_only_123456`, NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY: `cm_${mode}_pk_fixture_only_123456` });
        assert.equal(result.code, 0);
        assert.equal(result.body.status, "configuration_verified");
        assert.equal(result.body.mode, mode);
        assert.equal(result.body.programStatus, status);
        assert.equal(result.body.integrationVerified, false);
        assert(result.body.unverified.includes("publishable_key_binding"));
        assert.equal(requests.at(-1).method, "GET");
        assert.equal(requests.at(-1).url, `/api/v1/programs/${env.COMMISH_PROGRAM_ID}`);
        assert.equal(requests.at(-1).authorization, `Bearer cm_${mode}_sk_fixture_only_123456`);
      }
    }
    const valid = { data: { id: env.COMMISH_PROGRAM_ID, applicationId: env.NEXT_PUBLIC_COMMISH_APPLICATION_ID, mode: "test", status: "active" } };
    payload = valid;
    for (const [changes, expected] of [
      [{ COMMISH_SECRET_KEY: "" }, "invalid_configuration"],
      [{ COMMISH_PROGRAM_ID: "../secret" }, "invalid_configuration"],
      [{ NEXT_PUBLIC_COMMISH_APPLICATION_ID: "wrong" }, "invalid_configuration"],
      [{ NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY: "cm_live_pk_fixture_only_123456" }, "key_mode_mismatch"],
      ...["http://example.com/api/v1", "https://user:password@example.com/api/v1", `${env.COMMISH_API_URL}?key=secret`, `${env.COMMISH_API_URL}#hash`, "not a URL"].map((url) => [{ COMMISH_API_URL: url }, "invalid_api_url"]),
    ]) {
      const before = requests.length;
      const result = await run(changes);
      assert.equal(result.code, 1); assert.equal(result.body.code, expected);
      assert.equal(requests.length, before);
    }
    assert.equal((await run({}, ["verify", "--write", "--json"])).body.code, "invalid_arguments");
    for (const [status, code] of [[401, "invalid_api_key"], [403, "access_denied"], [404, "program_not_found"], [500, "verification_unavailable"]]) {
      httpStatus = status; payload = { error: { message: "fixture_only_123456_secret" } };
      const before = requests.length, result = await run();
      assert.equal(result.code, 1); assert.equal(result.body.code, code);
      assert.equal(requests.length, before + 1, "request retried");
    }
    httpStatus = 302; redirect = `${env.COMMISH_API_URL}/leak`;
    const before = requests.length;
    assert.equal((await run()).body.code, "verification_unavailable");
    assert.equal(requests.length, before + 1, "redirect followed");
    httpStatus = 200; redirect = undefined;
    for (const [body, code] of [
      ["invalid JSON", "invalid_response"], ["x".repeat(65_537), "invalid_response"], [{}, "invalid_response"],
      [{ data: { ...valid.data, id: "prg_other_123456" } }, "invalid_response"],
      [{ data: { ...valid.data, applicationId: "app_other_123456" } }, "application_mismatch"],
      [{ data: { ...valid.data, mode: "live" } }, "program_mode_mismatch"],
      [{ data: { ...valid.data, status: "unknown" } }, "invalid_response"],
    ]) {
      payload = body;
      const result = await run();
      assert.equal(result.code, 1); assert.equal(result.body.code, code);
    }
    assert.deepEqual(readdirSync(cwd), ["keep.txt"]);
    assert.equal(readFileSync(join(cwd, "keep.txt"), "utf8"), "consumer-owned");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
  }
}
