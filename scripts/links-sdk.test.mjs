import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLinkHandoff,
  Commish,
  CommishError,
  createReferralLinkHandler,
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
