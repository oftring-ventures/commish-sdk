import { createHmac, randomUUID } from "node:crypto";
import { executeApi } from "./api-command.mjs";
import { argumentsFor, CliError, errorReceipt, fail } from "./cli-http.mjs";
import { managementClient } from "./management-client.mjs";
export const testHelp = () => ({
  version: 1,
  status: "help",
  commands: [
    "test fixture --program <id>",
    "test conversion --body-file <path> --idempotency-key <identity>",
    "test webhook --url <loopback-url>",
    "test rehearsal --program <id> [--handle <handle>] --auth-file <path>",
  ],
  defaultMode: "test",
  liveSupported: false,
  fixture:
    "Produces a manual conversion input; supply real referral attribution in a private body file to test attribution. Never re-ingest a Stripe purchase through the manual API.",
  webhook:
    "Signs a synthetic TEST conversion.created event with COMMISH_WEBHOOK_SIGNING_SECRET; verifies only local receiver HTTP acceptance, not a stored conversion, real delivery or payout.",
  rehearsal:
    "Creates the approving owner's Test partnership on an active program and returns its referralUrl, using a management grant with programs.write (the onboarding grant from setup works). The owner needs the creator role; the first rehearsal names their private creator handle. Opening the link and buying in Test is still the proof.",
  output: "JSON only; no signing or integration secret is printed",
});
export async function executeTest(args, options = {}) {
  const env = options.env ?? process.env;
  const { values: v, positionals: p } = argumentsFor(
    args,
    [
      "program",
      "mode",
      "api-url",
      "body-file",
      "idempotency-key",
      "url",
      "handle",
      "auth-file",
      "management-url",
    ],
    ["help", "json", "non-interactive"],
  );
  if (v.help || !p.length) return testHelp();
  if (
    p.length !== 1 ||
    !["fixture", "conversion", "webhook", "rehearsal"].includes(p[0]) ||
    (v.mode ?? env.COMMISH_MODE ?? "test") !== "test"
  )
    fail("test_mode_required");
  if (p[0] !== "rehearsal" && ["handle", "auth-file", "management-url"].some((k) => v[k]))
    fail("invalid_arguments");
  if (p[0] === "rehearsal") {
    if (
      !/^prg_[A-Za-z0-9_-]{12,}$/.test(v.program ?? "") ||
      (v.handle !== undefined && !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(v.handle)) ||
      ["api-url", "body-file", "idempotency-key", "url"].some((k) => v[k])
    )
      fail("invalid_arguments");
    const client = managementClient({
      root: options.root,
      env,
      mode: "test",
      authFile: v["auth-file"],
      url: v["management-url"],
      fetcher: options.fetcher,
      signal: options.signal,
    });
    try {
      const receipt = await client.call("programs.rehearse", {
        programId: v.program,
        ...(v.handle ? { handle: v.handle } : {}),
      });
      const data = receipt.data;
      let link;
      try {
        link = new URL(data?.referralUrl);
      } catch {
        fail("invalid_response");
      }
      if (
        !(
          link.protocol === "https:" ||
          (link.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(link.hostname))
        ) ||
        // The link is this partnership's TEST referral path in the grant's workspace.
        typeof data.programSlug !== "string" ||
        typeof data.creatorHandle !== "string" ||
        link.pathname !==
          `/p/test/${encodeURIComponent(data.programSlug)}/${encodeURIComponent(data.creatorHandle)}` ||
        link.search ||
        link.hash ||
        data.workspaceId !== receipt.context.workspaceId ||
        data.programId !== v.program ||
        !/^mbr_[A-Za-z0-9_-]{12,}$/.test(data.membershipId ?? "") ||
        data.status !== "active" ||
        (data.creatorId !== undefined && !/^cr_[A-Za-z0-9_-]{12,}$/.test(data.creatorId)) ||
        (data.activatedAt !== undefined &&
          (typeof data.activatedAt !== "string" ||
            !Number.isFinite(Date.parse(data.activatedAt)))) ||
        (data.replayed !== undefined && typeof data.replayed !== "boolean")
      )
        fail("invalid_response");
      // Print only the validated, non-secret fields: never the server's whole object.
      const receiptData = Object.fromEntries(
        [
          "membershipId",
          "workspaceId",
          "programId",
          "programSlug",
          "creatorId",
          "creatorHandle",
          "status",
          "activatedAt",
          "replayed",
        ]
          .filter((name) => data[name] !== undefined)
          .map((name) => [name, data[name]]),
      );
      receiptData.referralUrl = link.href;
      return {
        version: 1,
        status: "ok",
        mode: "test",
        data: receiptData,
        integrationVerified: false,
        nextAction:
          "Open referralUrl, complete a Test purchase in your product, then read the conversion and commission with commish doctor --program.",
      };
    } catch (error) {
      // These need the owner, not a retry: say exactly what to do.
      const human = {
        creator_role_required: {
          humanAction: "add_creator_role",
          url: `${new URL(client.baseUrl).origin}/account/roles?role=creator`,
          nextAction:
            "Ask the approving owner or admin to add the creator role at url, then rerun the same command.",
        },
        creator_handle_required: {
          humanAction: "choose_creator_handle",
          nextAction:
            "Ask the owner for a creator handle (3-40 lowercase letters, numbers, hyphens or underscores) and rerun with --handle.",
        },
        creator_handle_unavailable: {
          humanAction: "choose_creator_handle",
          nextAction:
            "That handle is taken or reserved. Ask the owner for another creator handle and rerun with --handle.",
        },
        program_not_active: {
          nextAction: "Activate the program first (commish manage programs.activate), then rerun.",
        },
      }[error instanceof CliError ? error.message : ""];
      if (!human) throw error;
      return {
        version: 1,
        status: "action_required",
        mode: "test",
        code: error.message,
        ...human,
        integrationVerified: false,
      };
    }
  }
  if (p[0] === "fixture") {
    if (
      !/^prg_[A-Za-z0-9_-]{12,}$/.test(v.program ?? "") ||
      ["api-url", "body-file", "idempotency-key", "url"].some((k) => v[k])
    )
      fail("invalid_arguments");
    return {
      version: 1,
      status: "ok",
      mode: "test",
      fixtureOnly: true,
      data: {
        externalId: `commish-cli-test:${randomUUID()}`,
        programId: v.program,
        customerId: `commish-cli-test:${randomUUID()}`,
        amount: 10000,
        currency: "usd",
        occurredAt: new Date().toISOString(),
        metadata: { source: "commish-cli-test-fixture" },
      },
      nextAction:
        "Save data as your body file. Add actual attributionToken or couponCode to exercise attribution; review amount and customer identity.",
    };
  }
  if (p[0] === "conversion") {
    if (v.program || v.url) fail("invalid_arguments");
    return executeApi(
      [
        "conversions",
        "create",
        "--mode",
        "test",
        ...["api-url", "body-file", "idempotency-key"].flatMap((k) =>
          v[k] ? [`--${k}`, v[k]] : [],
        ),
      ],
      options,
    );
  }
  if (["program", "api-url", "body-file", "idempotency-key"].some((k) => v[k]))
    fail("invalid_arguments");
  let url;
  try {
    url = new URL(v.url);
  } catch {
    fail("invalid_arguments");
  }
  // Literal loopback addresses avoid DNS rebinding and accidental remote sends.
  if (
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    fail("loopback_url_required");
  const secret = env.COMMISH_WEBHOOK_SIGNING_SECRET;
  if (!/^whsec_[A-Za-z0-9_-]{12,512}$/.test(secret ?? "")) fail("webhook_secret_required");
  const event = {
    id: `evt_cli_fixture_${randomUUID().replaceAll("-", "")}`,
    type: "conversion.created",
    mode: "test",
    createdAt: new Date().toISOString(),
    data: { conversion_id: "cnv_cli_fixture_123456789", source: "synthetic_cli_fixture" },
  };
  const body = JSON.stringify(event),
    timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  let response;
  try {
    response = await (options.fetcher ?? fetch)(url.href, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        "commish-signature": `t=${timestamp},v1=${signature}`,
      },
      body,
    });
  } catch {
    fail("receiver_unavailable");
  }
  await response.body?.cancel();
  return {
    version: 1,
    status: response.ok ? "accepted" : "rejected",
    mode: "test",
    synthetic: true,
    eventId: event.id,
    httpStatus: response.status,
    integrationVerified: false,
  };
}
export async function runTestCommand(
  args,
  { out = console.log, diagnostic = console.error, ...options } = {},
) {
  try {
    const result = await executeTest(args, options);
    out(JSON.stringify(result));
    return ["rejected", "action_required"].includes(result.status) ? 2 : 0;
  } catch (error) {
    diagnostic(JSON.stringify(errorReceipt(error)));
    return 1;
  }
}
