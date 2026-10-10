// Runs only against a loopback fixture. This verifies the installed executable,
// its wire contract and local files; hosted Auth/provider acceptance is separate.
export async function verifySetupCli(executable) {
  const { default: assert } = await import("node:assert/strict");
  const { execFile } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { createServer } = await import("node:http");
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "commish-setup-installed-"));
  const digest = value => createHash("sha256").update(value).digest("hex");
  const workspaceId = "wrk_123456789012", applicationId = "app_123456789012", programId = "prg_123456789012";
  const endpointId = "whe_123456789012", originId = "org_123456789012", createdAt = new Date().toISOString();
  const webhookSecret = `whsec_${"z".repeat(43)}`, requests = [], bearers = [], authorizations = [];
  let current, denied = true, uncertainKey = true, verified = false, credential;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      requests.push({ path: req.url, method: req.method, body });
      if (req.method === "POST" && ["/api/cli/setup-sessions", "/api/cli/setup-sessions/reviewed"].includes(req.url)) {
        current = body; authorizations.push(body); assert.equal(req.headers.authorization, undefined);
      } else {
        const bearer = req.headers.authorization?.slice(7);
        assert(typeof bearer === "string" && digest(bearer) === current.challengeHash, "bearer binding differs");
        bearers.push(bearer);
      }
      const common = { protocol: "commish-cli-setup-v2", requestId: current.challengeHash, workspaceId,
        mode: current.mode, replayed: true, privateExtra: "server-private-detail" };
      let value;
      if (["/api/cli/setup-sessions", "/api/cli/setup-sessions/reviewed"].includes(req.url)) {
        value = req.method === "POST" ? { ...current, decision: "pending", workspaceRequest: current.workspaceRequest ?? null,
          pairingCode: `${current.challengeHash.slice(0, 4)}-${current.challengeHash.slice(4, 8)}`.toUpperCase(), requestExpiresAt: new Date(Date.now() + 3600000).toISOString() }
          : req.method === "DELETE" ? { status: "revoked" }
          : denied ? { status: "denied", requestExpiresAt: new Date(Date.now() + 3600000).toISOString() }
          : { status: "authorized", operations: current.operations, expiresAt: new Date(Date.now() + 600000).toISOString() };
      } else if (req.url.endsWith("/applications")) {
        value = { application: { id: applicationId, name: body.name, createdAt, verifiedOrigins: [] } };
      } else if (req.url.endsWith("/destinations")) {
        if (req.method === "PUT") verified = true;
        value = { destination: { id: originId, origin: body.origin, createdAt, status: verified ? "verified" : "pending",
          verifiedAt: verified ? createdAt : null, challenge: verified ? null : {
            path: "/.well-known/commish-verification.txt", value: `cm_verify_${originId}.${"a".repeat(43)}` } } };
      } else if (req.url.endsWith("/programs")) {
        value = { program: { ...body, id: programId, mode: current.mode, status: "draft", activeTermVersion: null, createdAt, updatedAt: createdAt } };
      } else if (req.url.endsWith("/terms")) {
        assert(!Object.hasOwn(body, "effectiveAt")); value = { term: { ...body, effectiveAt: createdAt, createdAt } };
      } else if (req.url.endsWith("/credentials")) {
        if (credential) assert(digest(JSON.stringify(body)) === digest(JSON.stringify(credential)), "credential retry changed");
        credential = body;
        if (uncertainKey) {
          uncertainKey = false; res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "service_unavailable", message: "server-private-detail" } })); return;
        }
        value = { apiKey: { ...body, id: "key_123456789012", mode: current.mode, revokedAt: null, lastUsedAt: null, createdAt } };
      } else if (req.url.endsWith("/webhooks/secret")) {
        res.writeHead(200, { "content-type": "application/octet-stream", "x-commish-setup-request-id": current.challengeHash,
          "x-commish-workspace-id": workspaceId, "x-commish-mode": current.mode, "x-commish-webhook-id": endpointId });
        res.end(webhookSecret); return;
      } else if (req.url.endsWith("/webhooks")) {
        value = { endpoint: { ...body, id: endpointId, mode: current.mode, disabledAt: null, createdAt } };
      } else if (req.url.endsWith("/readiness")) {
        value = { program: { id: programId, applicationId, status: "draft", activeTermVersion: null, availableTermVersion: 1 },
          destinationVerified: verified, credentialActive: true, webhookActive: body.webhookId ? true : null,
          stripeConnection: { mode: current.mode, status: "not_connected" }, liveAccess: null,
          integrationDiagnostics: { programId, mode: "test", status: "blocked", unmetGates: ["attributed_checkout"] },
          actions: ["activate_program", "connect_stripe", "complete_attributed_test_conversion"] };
      } else throw new Error("unexpected fixture request");
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { ...common, ...value } }));
    } catch { res.writeHead(500); res.end("fixture contract failed"); }
  });
  const run = args => new Promise((resolve, reject) => {
    execFile(executable, ["setup", "--json", "--no-open", "--non-interactive", "--wait", "0", "--app-url", `http://127.0.0.1:${server.address().port}`, ...args],
      { cwd: root, env: { PATH: process.env.PATH }, timeout: 20000, maxBuffer: 65536 }, (error, stdout, stderr) => {
        try {
          assert(!error?.killed, "setup executable timed out");
          const output = stdout + stderr;
          assert(!/cm_(test|live)_sk_|whsec_|server-private-detail/.test(output), "sensitive output");
          assert(bearers.every(value => !output.includes(value)), "bearer leaked");
          resolve({ code: error?.code ?? 0, result: JSON.parse(stdout), notices: stderr.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) });
        } catch (failure) { reject(failure); }
      });
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    // The installed package must contain every imported runtime module and both
    // reviewed catalogs. These operations work without credentials or a server.
    for (const args of [["api", "list"], ["test", "--help"], ["agent"]]) {
      await new Promise((resolve, reject) => execFile(executable, [...args, "--json"], { cwd: root, env: { PATH: process.env.PATH }, timeout: 10000 }, (error, stdout, stderr) => {
        try { assert.equal(error, null); assert.equal(stderr, ""); assert.doesNotThrow(() => JSON.parse(stdout)); resolve(); } catch (failure) { reject(failure); }
      }));
    }
    assert.equal((await run(["--help"])).result.status, "help");
    assert.equal((await run([])).code, 2); assert.equal(requests.length, 0); assert.deepEqual(readdirSync(root), []);
    const config = { version: 1, workspace: { kind: "new", name: "Guestbook", slug: "guestbook" }, application: { name: "Guestbook" },
      destination: { origin: "https://guestbook.example", proofFile: "public/.well-known/commish-verification.txt" },
      program: { name: "Guestbook", slug: "guestbook", category: "SaaS", eligibleStripeProductIds: [] },
      terms: { commission: { type: "percentage", basisPoints: 1500 }, recurrence: { kind: "first_payment" }, perSaleCap: null, disclosureText: "I earn a commission." },
      participantConsent: "commish_hosted", webhook: { url: "https://guestbook.example/hooks", eventTypes: ["commission.payable"] }, stripe: "later" };
    writeFileSync(join(root, "commish.setup.json"), JSON.stringify(config)); writeFileSync(join(root, "app.ts"), "consumer-owned");
    const planned = await run(["--plan"]);
    assert.equal(planned.code, 0); assert.equal(planned.result.status, "plan");
    assert.equal(planned.result.integrationVerified, false); assert.equal(requests.length, 0);
    assert.deepEqual(readdirSync(root).sort(), ["app.ts", "commish.setup.json"]);
    const deniedResult = await run([]); assert.equal(deniedResult.result.code, "access_denied");
    assert(requests.every(r => /setup-sessions(?:\/reviewed)?$/.test(r.path))); denied = false;
    assert.equal((await run([])).result.code, "service_unavailable");
    const filename = join(root, ".commish/setup/test/credentials.env"), before = readFileSync(filename);
    for (let i = 0; i < 2; i++) {
      const result = await run([]); assert.equal(result.code, 0); assert.equal(result.result.status, "configured");
      assert.equal(result.result.integrationVerified, false); assert.equal(result.result.programId, programId);
      assert(result.notices.some(n => n.status === "authorization_required"));
      assert(readFileSync(filename).equals(before), "credential file was replaced");
    }
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert(readFileSync(join(root, ".commish/setup/test/webhook.env"), "utf8").includes(webhookSecret));
    assert.equal(statSync(join(root, ".commish/setup/test/webhook.env")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(root, "app.ts"), "utf8"), "consumer-owned");
    assert.equal(requests.filter(r => r.path.endsWith("/applications")).length, 1);
    assert.equal(requests.filter(r => r.path.endsWith("/programs")).length, 1);
    assert.equal(requests.filter(r => r.method === "DELETE").length, 4);
    assert.deepEqual(authorizations.at(-1).workspaceRequest, { kind: "existing", id: workspaceId });
    assert(authorizations.every(r => r.mode === "test" && !r.operations.includes("stripe.connect")));
    const count = requests.length; config.program.name = "Changed"; writeFileSync(join(root, "commish.setup.json"), JSON.stringify(config));
    assert.equal((await run([])).result.code, "setup_config_conflict"); assert.equal(requests.length, count);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
}
