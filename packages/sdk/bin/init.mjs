#!/usr/bin/env node
const args = process.argv.slice(2);
const json = args.includes("--json");
if (args[0] === "setup") {
  const { runSetupCommand } = await import("./setup-command.mjs");
  process.exitCode = await runSetupCommand(args.slice(1));
} else if (args[0] === "verify") {
  const fail = (code) => { throw new Error(code); };
  try {
    if (args.slice(1).some((arg) => arg !== "--json") || new Set(args).size !== args.length)
      fail("invalid_arguments");
    const env = process.env;
    const secret = env.COMMISH_SECRET_KEY ?? "";
    const key = secret.match(/^cm_(test|live)_sk_[A-Za-z0-9_-]{12,}$/);
    const publishable = (env.COMMISH_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_COMMISH_PUBLISHABLE_KEY ?? "").match(/^cm_(test|live)_pk_[A-Za-z0-9_-]{12,}$/);
    const applicationId = env.COMMISH_APPLICATION_ID ?? env.NEXT_PUBLIC_COMMISH_APPLICATION_ID;
    const programId = env.COMMISH_PROGRAM_ID;
    if (!key || !publishable || !/^app_[A-Za-z0-9_-]{12,}$/.test(applicationId ?? "") ||
        !/^prg_[A-Za-z0-9_-]{12,}$/.test(programId ?? "")) fail("invalid_configuration");
    const mode = key[1] === "live" ? "live" : "test";
    if (mode !== publishable[1]) fail("key_mode_mismatch");
    let api;
    try { api = new URL(env.COMMISH_API_URL ?? "https://app.commish.sh/api/v1"); }
    catch { fail("invalid_api_url"); }
    if (api.username || api.password || api.search || api.hash ||
        !/^\/api\/v1\/?$/.test(api.pathname) ||
        !(api.protocol === "https:" || api.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(api.hostname))) fail("invalid_api_url");
    const response = await fetch(`${api.href.replace(/\/$/, "")}/programs/${programId}`, {
      method: "GET", headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail(({ 401: "invalid_api_key", 403: "access_denied", 404: "program_not_found" })[response.status] ?? "verification_unavailable");
    }
    const chunks = []; let size = 0;
    if (!response.body) fail("invalid_response");
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 65_536) fail("invalid_response");
      chunks.push(chunk);
    }
    let program;
    try { program = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data; }
    catch { fail("invalid_response"); }
    if (!program || program.id !== programId ||
        !["test", "live"].includes(program.mode) ||
        !["draft", "active", "paused", "suspended", "archived"].includes(program.status)) fail("invalid_response");
    if (program.applicationId !== applicationId) fail("application_mismatch");
    if (program.mode !== mode) fail("program_mode_mismatch");
    const result = {
      status: "configuration_verified", mode, applicationId, programId,
      programStatus: program.status,
      checks: ["secret_key_authenticated", "program_accessible", "application_matches", "mode_matches", "publishable_key_mode_matches"],
      unverified: ["publishable_key_binding", "consumer_wiring", "attribution", "checkout", "webhooks", "refunds", "renewals", "payouts"],
      integrationVerified: false,
    };
    console.log(json ? JSON.stringify(result) :
      `Configuration verified (${result.mode}, program ${programId}, status ${program.status}).\n` +
      "Publishable-key binding and end-to-end integration remain unverified. Use --json for individual checks.");
  } catch (error) {
    const codes = ["invalid_arguments", "invalid_configuration", "key_mode_mismatch", "invalid_api_url",
      "invalid_api_key", "access_denied", "program_not_found", "verification_unavailable",
      "invalid_response", "application_mismatch", "program_mode_mismatch"];
    const code = codes.includes(error?.message) ? error.message : "verification_unavailable";
    console.error(json ? JSON.stringify({ status: "error", code, integrationVerified: false }) : `Verification failed: ${code}.`);
    process.exitCode = 1;
  }
} else {
  const valid = args.length === 0 || args.every((arg) => ["help", "--help", "--json"].includes(arg)) && new Set(args).size === args.length;
  if (!valid) {
    console.error(json ? JSON.stringify({ status: "error", code: "invalid_arguments" }) : "Usage: commish setup [options] | commish verify [--json]");
    process.exitCode = 1;
  } else {
    const help = { status: "help", commands: ["setup [options]", "verify [--json]"],
      requiredEnvironment: ["COMMISH_SECRET_KEY", "COMMISH_PUBLISHABLE_KEY", "COMMISH_APPLICATION_ID", "COMMISH_PROGRAM_ID"],
      integrationVerified: false };
    console.log(json ? JSON.stringify(help) : "Commish developer CLI\n\ncommish setup [options] — authorize and provision from this repository.\ncommish setup --help — configuration and noninteractive flags.\ncommish verify [--json] — check credentials and program configuration.\nA completed attributed TEST conversion is required to verify the integration.");
  }
}
