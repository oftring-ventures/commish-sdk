import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLinkHandoff,
  Commish,
  CommishError,
  createReferralLinkHandler,
  createReferralLinkResolver,
  referralLinkNotice,
} from "../packages/sdk/dist/index.js";

const ready = {
  protocol: "commish-links-v1",
  status: "ready",
  location: "https://brand.example/?commish_ref=token.signature",
};
const client = (respond) => {
  const calls = [];
  const sdk = new Commish({
    secretKey: "cm_live_sk_fixture_123456789012",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  });
  return { sdk, calls };
};
const get = (path = "/c/maya", method = "GET") =>
  new Request(`https://brand.example${path}`, { method });

test("handoff is a scoped, uncached, abortable POST", async () => {
  const { sdk, calls } = client(() => Response.json({ data: ready }));
  const signal = new AbortController().signal;
  assert.deepEqual((await sdk.links.handoff({ handle: "maya", signal })).data, ready);
  assert.match(calls[0].url, /\/links\/maya\/handoff$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[0].init.headers.authorization, "Bearer cm_live_sk_fixture_123456789012");
  await assert.rejects(() => sdk.links.handoff({ handle: "../checkout" }), /Invalid/);
  assert.equal(calls.length, 1);
});

test("route check sends the prefix and validates the receipt", async () => {
  const receipt = {
    verified: true,
    route: {
      origin: "https://brand.example",
      prefix: "/c",
      template: "https://brand.example/c/{creator}",
    },
  };
  const { sdk, calls } = client(() => Response.json({ data: receipt }));
  assert.deepEqual((await sdk.links.verifyRoute()).data, receipt);
  assert.match(calls[0].url, /\/link-route\/verify$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { prefix: "/c" });
  await sdk.links.verifyRoute({ prefix: "/creators", origin: "https://brand.example" });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    prefix: "/creators",
    origin: "https://brand.example",
  });
  await assert.rejects(() => sdk.links.verifyRoute({ prefix: "c" }), /Invalid link prefix/);
  const broken = client(() => Response.json({ data: { verified: "yes", route: null } }));
  await assert.rejects(() => broken.sdk.links.verifyRoute(), /invalid Commish link route/);
});

for (const value of [
  null,
  { ...ready, protocol: "commish-links-v2" },
  { ...ready, location: "http://brand.example/" },
  { ...ready, location: "https://user:pass@brand.example/" },
  { ...ready, location: "//brand.example" },
  { ...ready, extra: true },
  { protocol: "commish-links-v1", status: "paused", reason: "because" },
  { protocol: "commish-links-v1", status: "paused" },
  { protocol: "commish-links-v1", status: "probe", location: ready.location },
  { protocol: "commish-links-v1", status: "later" },
])
  test(`rejects an unsupported handoff ${JSON.stringify(value)}`, () => {
    assert.throws(() => assertLinkHandoff(value), /Unsupported or invalid Commish link response/);
  });

test("a known creator is forwarded with a 307 that is never cached", async () => {
  const { sdk, calls } = client(() => Response.json({ data: ready }));
  const handler = createReferralLinkHandler({ handoff: sdk.links.handoff });
  const response = await handler(get(), "maya");
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), ready.location);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal((await handler(get("/c/maya", "HEAD"), "maya")).status, 307);
});

test("a pause shows a static notice and never redirects", async () => {
  for (const [reason, title] of [
    ["funding_paused", "This referral link is paused"],
    ["promotion", "Promotion is temporarily unavailable"],
  ]) {
    const { sdk } = client(() =>
      Response.json({ data: { protocol: "commish-links-v1", status: "paused", reason } }),
    );
    const response = await createReferralLinkHandler({ handoff: sdk.links.handoff })(get(), "maya");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("retry-after"), "900");
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    const html = await response.text();
    assert.ok(html.includes(title));
    assert.ok(!html.includes("maya"));
  }
});

test("a Commish route check is answered with an empty 204", async () => {
  const { sdk, calls } = client(() =>
    Response.json({ data: { protocol: "commish-links-v1", status: "probe" } }),
  );
  const response = await createReferralLinkHandler({ handoff: sdk.links.handoff })(
    get("/c/cmprobe-0123456789abcdef01234567"),
    "cmprobe-0123456789abcdef01234567",
  );
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.match(calls[0].url, /\/links\/cmprobe-0123456789abcdef01234567\/handoff$/);
});

test("unknown handles are the merchant's 404 and never reach Commish when malformed", async () => {
  const { sdk, calls } = client(() =>
    Response.json(
      { error: { code: "link_not_found", message: "Link not found." } },
      { status: 404 },
    ),
  );
  const plain = createReferralLinkHandler({ handoff: sdk.links.handoff });
  assert.equal((await plain(get("/c/nobody"), "nobody")).status, 404);
  const custom = createReferralLinkHandler({
    handoff: sdk.links.handoff,
    notFound: () => new Response("merchant 404", { status: 404 }),
  });
  assert.equal(await (await custom(get("/c/nobody"), "nobody")).text(), "merchant 404");
  assert.equal(calls.length, 2);
  assert.equal(await (await custom(get("/c/NO"), "NO")).text(), "merchant 404");
  assert.equal((await plain(get("/c/x"), "../checkout")).status, 404);
  assert.equal(calls.length, 2);
  assert.equal((await plain(get("/c/maya", "POST"), "maya")).status, 405);
  assert.equal(calls.length, 2);
});

test("an outage or an invalid answer shows a notice instead of sending the buyer on unattributed", async () => {
  for (const respond of [
    () => Response.json({ error: { code: "link_unavailable" } }, { status: 503 }),
    () => Response.json({ data: { ...ready, location: "http://evil.example/" } }),
    () => {
      throw new Error("offline");
    },
  ]) {
    const { sdk } = client(respond);
    const response = await createReferralLinkHandler({ handoff: sdk.links.handoff })(get(), "maya");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.ok((await response.text()).includes("temporarily unavailable"));
  }
  assert.equal(new CommishError("x", 404, "link_not_found").name, "CommishError");
});

const check = "cmprobe-0123456789abcdef01234567";
test("a root path check is forwarded unchanged and never cached or treated as a handoff", async () => {
  const seen = [];
  const { sdk } = client((_url, init) => {
    seen.push(init.headers["x-commish-link-check"]);
    return Response.json({ data: { protocol: "commish-links-v1", status: "probe" } });
  });
  const handler = createReferralLinkHandler({ handoff: sdk.links.handoff });
  const probe = () =>
    handler(
      new Request("https://brand.example/tim", { headers: { "x-commish-link-check": check } }),
      "tim",
    );
  assert.equal((await probe()).status, 204);
  assert.equal((await probe()).status, 204);
  assert.deepEqual(seen, [check, check]);
  const malformed = await handler(
    new Request("https://brand.example/tim", { headers: { "x-commish-link-check": "anything" } }),
    "tim",
  );
  assert.equal(malformed.status, 404);
  assert.equal(seen.length, 2);
  await assert.rejects(
    () => sdk.links.handoff({ handle: "tim", check: "anything" }),
    /Invalid link check/,
  );
});

test("unknown handles are remembered, coalesced and rationed; known creators never are", async () => {
  let calls = 0;
  const { sdk } = client((url) => {
    calls += 1;
    return String(url).includes("/links/maya/")
      ? Response.json({ data: ready })
      : Response.json({ error: { code: "link_not_found" } }, { status: 404 });
  });
  const handler = createReferralLinkHandler({ handoff: sdk.links.handoff, root: true });
  for (let i = 0; i < 5; i += 1)
    assert.equal((await handler(get("/wp-admin"), "wp-admin")).status, 404);
  assert.equal(calls, 1, "a miss is remembered");
  calls = 0;
  await Promise.all(Array.from({ length: 5 }, () => handler(get("/crawler"), "crawler")));
  assert.equal(calls, 1, "a burst on one unknown path asks once");
  calls = 0;
  for (let i = 0; i < 100; i += 1) await handler(get(`/probe-${i}`), `probe-${i}`);
  assert.ok(calls <= 60, "lookups of never-seen handles are bounded per window");
  calls = 0;
  for (let i = 0; i < 5; i += 1) assert.equal((await handler(get("/maya"), "maya")).status, 404);
  assert.equal(calls, 0, "a new handle waits for the next window once the budget is spent");
});

test("a creator seen to resolve is always asked, and each visitor gets their own handoff", async () => {
  let calls = 0;
  const { sdk } = client(() => {
    calls += 1;
    return Response.json({ data: { ...ready, location: `${ready.location}${calls}` } });
  });
  const handler = createReferralLinkHandler({ handoff: sdk.links.handoff });
  const locations = new Set();
  for (let i = 0; i < 70; i += 1)
    locations.add((await handler(get(), "maya")).headers.get("location"));
  assert.equal(calls, 70);
  assert.equal(locations.size, 70);
});

test("root mode answers an outage as not found; the prefix route shows the notice", async () => {
  const offline = () => {
    throw new Error("offline");
  };
  const root = createReferralLinkHandler({
    handoff: client(offline).sdk.links.handoff,
    root: true,
    notFound: () => new Response("merchant 404", { status: 404 }),
  });
  assert.equal(await (await root(get("/tim"), "tim")).text(), "merchant 404");
  const prefix = createReferralLinkHandler({ handoff: client(offline).sdk.links.handoff });
  assert.equal((await prefix(get("/c/tim"), "tim")).status, 503);
});

test("route check can include the root fallback", async () => {
  const receipt = {
    verified: true,
    route: {
      origin: "https://brand.example",
      prefix: "/c",
      template: "https://brand.example/c/{creator}",
    },
    root: { verified: false },
  };
  const { sdk, calls } = client(() => Response.json({ data: receipt }));
  assert.deepEqual((await sdk.links.verifyRoute({ root: true })).data, receipt);
  assert.deepEqual(JSON.parse(calls[0].init.body), { prefix: "/c", root: true });
  const broken = client(() => Response.json({ data: { ...receipt, root: { verified: "yes" } } }));
  await assert.rejects(
    () => broken.sdk.links.verifyRoute({ root: true }),
    /invalid Commish link route/,
  );
});

test("the handler reports failures to onError, names allowed methods and rejects a bad timeout", async () => {
  const seen = [];
  const rejected = client(() =>
    Response.json({ error: { code: "invalid_api_key" } }, { status: 401 }),
  );
  const handler = createReferralLinkHandler({
    handoff: rejected.sdk.links.handoff,
    onError: (error, context) => {
      seen.push([error.status, context.handle]);
      throw new Error("a failing hook changes nothing");
    },
  });
  assert.equal((await handler(get(), "maya")).status, 503);
  assert.deepEqual(seen, [[401, "maya"]]);
  const missing = client(() =>
    Response.json({ error: { code: "link_not_found" } }, { status: 404 }),
  );
  const quiet = [];
  await createReferralLinkHandler({
    handoff: missing.sdk.links.handoff,
    onError: () => quiet.push(1),
  })(get("/c/nobody"), "nobody");
  assert.equal(quiet.length, 0, "an unknown handle is not an error");
  const refused = await handler(get("/c/maya", "POST"), "maya");
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get("allow"), "GET, HEAD");
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(
      () => createReferralLinkHandler({ handoff: rejected.sdk.links.handoff, timeoutMs }),
      /timeoutMs must be a positive number/,
    );
});

test("a root route marks its requests; a prefix route does not", async () => {
  const seen = [];
  const { sdk } = client((_url, init) => {
    seen.push(init.headers ?? {});
    return Response.json({ data: ready });
  });
  await createReferralLinkHandler({ handoff: sdk.links.handoff, root: true })(get("/maya"), "maya");
  await createReferralLinkHandler({ handoff: sdk.links.handoff })(get("/c/maya"), "maya");
  assert.equal(seen[0]["x-commish-link-root"], "1");
  assert.equal(seen[1]["x-commish-link-root"], undefined);
  // A root check carries both the mark and the value.
  await sdk.links.handoff({ handle: check, check, root: true });
  assert.equal(seen[2]["x-commish-link-root"], "1");
  assert.equal(seen[2]["x-commish-link-check"], check);
});

test("checks have a small allowance of their own and never spend the visitors' budget", async () => {
  let calls = 0;
  const { sdk } = client((url) => {
    calls += 1;
    return String(url).includes("/links/maya/")
      ? Response.json({ data: ready })
      : Response.json({ data: { protocol: "commish-links-v1", status: "probe" } });
  });
  const handler = createReferralLinkHandler({ handoff: sdk.links.handoff, root: true });
  const statuses = [];
  for (let i = 0; i < 25; i += 1)
    statuses.push(
      (
        await handler(
          new Request("https://brand.example/tim", { headers: { "x-commish-link-check": check } }),
          "tim",
        )
      ).status,
    );
  // Room for Commish's largest run on one site: a fallback and ten names.
  assert.equal(calls, 20, "a forged check header cannot become unlimited Commish calls");
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(204));
  assert.deepEqual(statuses.slice(20), Array(5).fill(404));
  calls = 0;
  for (let i = 0; i < 5; i += 1) await handler(get(`/cmprobe-x${i}`), `cmprobe-x${i}`);
  assert.equal(calls, 0, "a check-shaped path shares that allowance");
  assert.equal((await handler(get("/maya"), "maya")).status, 307, "visitors are not affected");
});

test("a spent lookup budget is a notice on the prefix route and not found at the root", async () => {
  const unknown = () => Response.json({ error: { code: "link_not_found" } }, { status: 404 });
  const prefix = createReferralLinkHandler({ handoff: client(unknown).sdk.links.handoff });
  for (let i = 0; i < 60; i += 1) await prefix(get(`/c/scan-${i}`), `scan-${i}`);
  const held = await prefix(get("/c/creator-q"), "creator-q");
  assert.equal(held.status, 503, "a real creator's first visit is never told the link is dead");
  assert.equal(held.headers.get("retry-after"), "60");
  const root = createReferralLinkHandler({
    handoff: client(unknown).sdk.links.handoff,
    root: true,
  });
  for (let i = 0; i < 60; i += 1) await root(get(`/scan-${i}`), `scan-${i}`);
  assert.equal((await root(get("/creator-q"), "creator-q")).status, 404);
});

test("at the root an outage is a notice for a creator seen recently, not found otherwise", async () => {
  let offline = false;
  const { sdk } = client(() => {
    if (offline) throw new Error("offline");
    return Response.json({ data: ready });
  });
  const handler = createReferralLinkHandler({ handoff: sdk.links.handoff, root: true });
  assert.equal((await handler(get("/tim"), "tim")).status, 307);
  offline = true;
  const known = await handler(get("/tim"), "tim");
  assert.equal(known.status, 503);
  assert.equal(known.headers.get("location"), null, "never forwarded without the referral");
  assert.equal((await handler(get("/pricing"), "pricing")).status, 404);
});

test("a handoff that never settles ends at the timeout and does not hold later visits", async () => {
  // AbortSignal.timeout's timer does not keep the event loop alive. A server always
  // does; this test holds a referenced timer so Node 22 waits for the timeout too.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const stuck = () => new Promise(() => {});
    const handler = createReferralLinkHandler({ handoff: stuck, timeoutMs: 20 });
    const started = Date.now();
    assert.equal((await handler(get("/c/tim"), "tim")).status, 503);
    assert.equal((await handler(get("/c/tim"), "tim")).status, 503);
    assert.ok(Date.now() - started < 2000);
  } finally {
    clearInterval(keepAlive);
  }
});

test("per-request values replace the handler's own, for configuration read on each request", async () => {
  const errors = [];
  const handler = createReferralLinkHandler({
    handoff: () => {
      throw new Error("unconfigured");
    },
    onError: () => errors.push("default"),
  });
  const { sdk } = client((url) =>
    String(url).includes("/links/maya/")
      ? Response.json({ data: ready })
      : Response.json({ error: { code: "link_not_found" } }, { status: 404 }),
  );
  assert.equal((await handler(get(), "maya", { handoff: sdk.links.handoff })).status, 307);
  const missing = await handler(get("/c/nobody"), "nobody", {
    handoff: sdk.links.handoff,
    notFound: () => new Response("this request's 404", { status: 404 }),
  });
  assert.equal(await missing.text(), "this request's 404");
  await handler(get("/c/other"), "other", { onError: () => errors.push("visit") });
  assert.deepEqual(errors, ["visit"]);
});

test("the resolver reports outcomes for frameworks whose pages cannot return a response", async () => {
  const { sdk } = client((url) =>
    String(url).includes("/links/maya/")
      ? Response.json({ data: ready })
      : String(url).includes("/links/paused/")
        ? Response.json({
            data: { protocol: "commish-links-v1", status: "paused", reason: "promotion" },
          })
        : String(url).includes("/links/tim/")
          ? Response.json({ data: { protocol: "commish-links-v1", status: "probe" } })
          : Response.json({ error: { code: "link_not_found" } }, { status: 404 }),
  );
  const resolve = createReferralLinkResolver({ handoff: sdk.links.handoff, root: true });
  assert.deepEqual(await resolve("maya"), { kind: "redirect", location: ready.location });
  assert.deepEqual(await resolve("paused"), { kind: "paused", reason: "promotion" });
  assert.deepEqual(await resolve("tim", { check }), { kind: "probe" });
  assert.deepEqual(await resolve("nobody"), { kind: "not_found" });
  assert.deepEqual(await resolve("Not A Handle"), { kind: "not_found" });
  assert.deepEqual(await resolve("maya", { check: "anything" }), { kind: "not_found" });
  assert.equal(referralLinkNotice("promotion").title, "Promotion is temporarily unavailable");
  assert.equal(referralLinkNotice(null).title, "This link is temporarily unavailable");
});

test("the root answer of a route check may say whether root links are switched on", async () => {
  const receipt = (root) => ({
    verified: true,
    route: {
      origin: "https://brand.example",
      prefix: "/c",
      template: "https://brand.example/c/{creator}",
    },
    root,
  });
  for (const root of [
    { enabled: false, verified: false },
    { enabled: true, verified: true },
    { enabled: null, verified: false },
  ])
    assert.deepEqual(
      (
        await client(() => Response.json({ data: receipt(root) })).sdk.links.verifyRoute({
          root: true,
        })
      ).data.root,
      root,
    );
  await assert.rejects(
    () =>
      client(() =>
        Response.json({ data: receipt({ enabled: "yes", verified: true }) }),
      ).sdk.links.verifyRoute({ root: true }),
    /invalid Commish link route/,
  );
});
