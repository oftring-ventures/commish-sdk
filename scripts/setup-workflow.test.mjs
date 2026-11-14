import assert from "node:assert/strict";
import test from "node:test";
import { runSetup } from "../packages/sdk/bin/setup-workflow.mjs";

const business = {
  program: {
    name: "Guestbook",
    slug: "guestbook",
    category: "SaaS",
    description: "",
    visibility: "private",
    joinPolicy: "approval",
    attributionPolicy: "last_click",
    eligibleStripeProductIds: [],
    creatorKit: { summary: "", talkingPoints: [], assets: [] },
  },
  terms: {
    version: 1,
    commission: { type: "percentage", basisPoints: 1500 },
    recurrence: { kind: "first_payment" },
    perSaleCap: null,
    disclosureText: "I earn a commission.",
    prohibitedClaims: [],
  },
};
const config = {
  ...business,
  mode: "test",
  destination: { origin: "https://guestbook.example" },
  webhook: null,
  stripe: "connect",
};
const options = { appUrl: "https://app.commish.sh", noOpen: true, waitSeconds: 30 };
function fixture() {
  let time = Date.parse("2026-10-03T12:00:00Z"),
    revoked = 0,
    saved = null;
  const notices = [],
    opened = [],
    authorizations = [],
    handoffs = [];
  const result = {
    status: "configured",
    mode: "test",
    workspaceId: "wrk_123456789012",
    applicationId: "app_123456789012",
    programId: "prg_123456789012",
    proof: null,
    readiness: { program: { applicationId: "app_123456789012" }, stripeStatus: "not_connected" },
    readinessInput: { programId: "prg_123456789012", credentialId: "key_123456789012" },
    integrationVerified: false,
  };
  const session = {
    stripeHandoff: async (input) => {
      handoffs.push(input);
      return {
        path:
          input?.flow === "setup"
            ? `/cli/setup/workspace/${result.workspaceId}/stripe?mode=test`
            : `/dashboard/workspace/${result.workspaceId}/settings?mode=test`,
      };
    },
    verifyDestination: async () => {},
    readReadiness: async () => ({ ...result.readiness, stripeStatus: "connected" }),
    revoke: async () => {
      revoked++;
    },
  };
  const dependencies = {
    progress: () => ({ read: () => saved }),
    notify: (v) => notices.push(v),
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    openBrowser: async (url) => {
      opened.push(url);
      return true;
    },
    authorize: async (input, flags) => {
      authorizations.push({ input, flags });
      return { session, receipt: { expiresAt: new Date(time + 600000).toISOString() } };
    },
    provision: async () => structuredClone(result),
  };
  return {
    dependencies,
    result,
    session,
    notices,
    opened,
    authorizations,
    handoffs,
    revoked: () => revoked,
    saved: (v) => {
      saved = v;
    },
  };
}
test("waits for provider completion with no automatic browser and revokes temporary authority", async () => {
  const f = fixture(),
    result = await runSetup("/repo", config, options, f.dependencies);
  assert.equal(result.status, "configured");
  assert.equal(result.readiness.stripeStatus, "connected");
  assert.equal(result.integrationVerified, false);
  assert.equal(f.revoked(), 1);
  assert.equal(f.opened.length, 0);
  assert.equal(f.notices[0].status, "browser_action_required");
  assert(!JSON.stringify(result).includes("readinessInput"));
  assert(!f.authorizations[0].input.operations.includes("webhook.write"));
  assert.deepEqual(f.authorizations[0].input.setupIntent, { version: 1, ...business });
});
test("a chosen return window is reviewed in the same approval and reported from provisioning", async () => {
  const f = fixture(),
    terms = { ...business.terms, returnWindowDays: 14 };
  f.result.returnWindowDays = 14;
  const result = await runSetup("/repo", { ...config, terms }, options, f.dependencies);
  assert.deepEqual(f.authorizations[0].input.setupIntent, { version: 1, ...business, terms });
  assert.equal(result.returnWindowDays, 14);
});
test("reauthorizes the saved workspace and preserves explicit LIVE and selected scopes", async () => {
  const f = fixture();
  f.saved({ id: "wrk_abcdefghijkl" });
  f.result.mode = "live";
  const result = await runSetup(
    "/repo",
    { ...config, mode: "live", webhook: {}, stripe: "later" },
    options,
    f.dependencies,
  );
  assert.equal(result.mode, "live");
  assert.equal(f.authorizations[0].input.mode, "live");
  assert.deepEqual(f.authorizations[0].input.workspaceRequest, {
    kind: "existing",
    id: "wrk_abcdefghijkl",
  });
  assert(f.authorizations[0].input.operations.includes("webhook.write"));
  assert(!f.authorizations[0].input.operations.includes("stripe.connect"));
});
test("opens a consented provider handoff and reports timeout as resumable action", async () => {
  const f = fixture();
  const result = await runSetup(
    "/repo",
    config,
    { ...options, noOpen: false, waitSeconds: 0 },
    f.dependencies,
  );
  assert.equal(result.status, "action_required");
  assert.equal(result.resume, "rerun_same_command");
  assert.equal(f.opened.length, 1);
  assert.equal(f.revoked(), 1);
  assert.deepEqual(f.handoffs, [{ flow: "setup" }]);
  assert.equal(
    f.opened[0],
    "https://app.commish.sh/cli/setup/workspace/wrk_123456789012/stripe?mode=test",
  );
});
test("continues after publishing proof and transient network failure", async () => {
  const f = fixture();
  f.result.proof = {
    path: "public/proof.txt",
    url: "https://guestbook.example/proof.txt",
    code: "challenge_mismatch",
  };
  let attempts = 0;
  f.session.verifyDestination = async () => {
    if (++attempts === 1) throw new Error("verification_unavailable");
  };
  const result = await runSetup("/repo", config, options, f.dependencies);
  assert.equal(result.proof, null);
  assert.equal(result.status, "configured");
  assert.equal(attempts, 2);
  assert.equal(f.notices[0].status, "publish_required");
});
test("permission, expiry, abort and provisioning failures never leave owned authority live", async () => {
  const expired = fixture();
  expired.session.readReadiness = async () => {
    throw new Error("setup_expired");
  };
  assert.equal(
    (await runSetup("/repo", config, options, expired.dependencies)).code,
    "reauthorization_required",
  );
  assert.equal(expired.revoked(), 1);
  for (const message of ["access_denied", "setup_file_conflict"]) {
    const f = fixture();
    f.dependencies.provision = async () => {
      throw new Error(message);
    };
    await assert.rejects(runSetup("/repo", config, options, f.dependencies), { message });
    assert.equal(f.revoked(), 1);
  }
  const f = fixture(),
    controller = new AbortController();
  f.dependencies.sleep = async () => {
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  };
  await assert.rejects(
    runSetup("/repo", config, options, { ...f.dependencies, signal: controller.signal }),
    /setup_interrupted/,
  );
  assert.equal(f.revoked(), 1);
});

test("retries readiness after proof succeeds even when Stripe is deferred", async () => {
  const f = fixture();
  f.result.proof = { path: "public/proof.txt" };
  let reads = 0;
  f.session.readReadiness = async () => {
    if (++reads === 1) throw new Error("service_unavailable");
    return { ...f.result.readiness, destinationVerified: true };
  };
  const result = await runSetup("/repo", { ...config, stripe: "later" }, options, f.dependencies);
  assert.equal(reads, 2);
  assert.equal(result.readiness.destinationVerified, true);
  assert.equal(result.status, "configured");
});
test("an abort completing in-flight provisioning cannot open a provider browser", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.dependencies.provision = async (...args) => {
    assert.equal(args.at(-1).signal, controller.signal);
    controller.abort();
    return structuredClone(f.result);
  };
  await assert.rejects(
    runSetup(
      "/repo",
      config,
      { ...options, noOpen: false },
      { ...f.dependencies, signal: controller.signal },
    ),
    /setup_interrupted/,
  );
  assert.equal(f.opened.length, 0);
  assert.equal(f.revoked(), 1);
});

const proposal = {
  token: `cm_mgmt_test_${"t".repeat(43)}`,
  request: { challengeHash: "b".repeat(64), scopes: ["programs.write"], expiresIn: 86400 },
};
function grants(stored = []) {
  return {
    propose: () => proposal,
    store: async (root, value, context) => {
      stored.push({ root, value, context });
      return {
        authorizationFile: ".commish/management/bbbbbbbbbbbbbbbbbbbbbbbb/authorization.json",
        scopes: ["programs.write"],
        status: "authorized",
        expiresAt: "2026-10-04T12:00:00.000Z",
      };
    },
  };
}
test("Test setup asks for onboarding access in the same approval and stores what was granted", async () => {
  const f = fixture(),
    stored = [];
  f.dependencies.authorize = async (input, flags) => {
    f.authorizations.push({ input, flags });
    return {
      session: f.session,
      receipt: { workspaceId: "wrk_123456789012", expiresAt: "2026-10-03T12:10:00.000Z" },
      onboarding: { scopes: ["programs.write"], expiresIn: 86400 },
    };
  };
  const result = await runSetup("/repo", config, options, {
    ...f.dependencies,
    onboarding: grants(stored),
  });
  assert.deepEqual(f.authorizations[0].input.onboarding, proposal.request);
  assert.deepEqual(stored, [
    {
      root: "/repo",
      value: proposal,
      context: { workspaceId: "wrk_123456789012", appUrl: options.appUrl, signal: undefined },
    },
  ]);
  assert.equal(result.onboarding.status, "authorized");
  assert.match(result.onboarding.authorizationFile, /^\.commish\/management\//);
  assert(!JSON.stringify([result, f.notices]).includes(proposal.token));
});
test("Live setup, an opt-out and an approval without the link never store a grant", async () => {
  for (const [setup, flags] of [
    [{ ...config, mode: "live" }, options],
    [config, { ...options, onboarding: false }],
    [config, options],
  ]) {
    const f = fixture(),
      stored = [];
    if (setup.mode === "live") f.result.mode = "live";
    const result = await runSetup("/repo", setup, flags, {
      ...f.dependencies,
      onboarding: grants(stored),
    });
    assert.equal(result.onboarding, null);
    assert.equal(stored.length, 0);
    assert.equal(
      f.authorizations[0].input.onboarding !== undefined,
      setup.mode === "test" && flags.onboarding !== false,
    );
  }
});
test("a server without the single consent is provisioned as before, without the grant", async () => {
  const f = fixture(),
    stored = [];
  let attempts = 0;
  f.dependencies.authorize = async (input) => {
    f.authorizations.push({ input });
    if (attempts++ === 0) throw new Error("invalid_request");
    return { session: f.session, receipt: { expiresAt: "2026-10-03T12:10:00.000Z" } };
  };
  const result = await runSetup("/repo", config, options, {
    ...f.dependencies,
    onboarding: grants(stored),
  });
  assert.equal(result.status, "configured");
  assert.equal(result.onboarding, null);
  assert.deepEqual(f.authorizations[0].input.onboarding, proposal.request);
  assert.equal(f.authorizations[1].input.onboarding, undefined);
  assert.equal(f.notices[0].status, "onboarding_unavailable");
  assert.equal(stored.length, 0);
  // Without a proposal the same refusal is a real error.
  const g = fixture();
  g.dependencies.authorize = async () => {
    throw new Error("invalid_request");
  };
  await assert.rejects(
    runSetup("/repo", config, { ...options, onboarding: false }, g.dependencies),
    /invalid_request/,
  );
});
test("a failure after the grant is stored names it, so it can be used or revoked", async () => {
  const linked = (f) => async (input, flags) => {
    f.authorizations.push({ input, flags });
    return {
      session: f.session,
      receipt: { workspaceId: "wrk_123456789012", expiresAt: "2026-10-03T12:10:00.000Z" },
      onboarding: { scopes: ["programs.write"], expiresIn: 86400 },
    };
  };
  // Provisioning refuses after the grant is stored.
  const f = fixture();
  f.dependencies.authorize = linked(f);
  f.dependencies.provision = async () => {
    throw new Error("setup_conflict");
  };
  const failure = await runSetup("/repo", config, options, {
    ...f.dependencies,
    onboarding: grants([]),
  }).catch((error) => error);
  assert.equal(failure.message, "setup_conflict");
  assert.equal(failure.onboarding.status, "authorized");
  assert.match(failure.onboarding.authorizationFile, /^\.commish\/management\//);
  assert(!JSON.stringify(failure.onboarding).includes(proposal.token));
  assert.equal(f.revoked(), 1);
  // An interruption during provisioning keeps the name too.
  const g = fixture(),
    controller = new AbortController();
  g.dependencies.authorize = linked(g);
  g.dependencies.provision = async () => {
    controller.abort();
    throw new Error("private-fixture");
  };
  const interrupted = await runSetup("/repo", config, options, {
    ...g.dependencies,
    onboarding: grants([]),
    signal: controller.signal,
  }).catch((error) => error);
  assert.equal(interrupted.message, "setup_interrupted");
  assert.match(interrupted.onboarding.authorizationFile, /^\.commish\/management\//);
  // A store interrupted after writing its file names it on its own error.
  const h = fixture();
  h.dependencies.authorize = linked(h);
  const named = await runSetup("/repo", config, options, {
    ...h.dependencies,
    onboarding: {
      propose: () => proposal,
      store: async () => {
        throw Object.assign(new Error("setup_interrupted"), {
          onboarding: {
            authorizationFile: ".commish/management/x/authorization.json",
            status: "unconfirmed",
          },
        });
      },
    },
  }).catch((error) => error);
  assert.equal(named.message, "setup_interrupted");
  assert.equal(named.onboarding.authorizationFile, ".commish/management/x/authorization.json");
  // Without a stored grant nothing is attached.
  const i = fixture();
  i.dependencies.provision = async () => {
    throw new Error("setup_conflict");
  };
  const plain = await runSetup("/repo", config, options, i.dependencies).catch((error) => error);
  assert.equal(plain.onboarding, undefined);
});
