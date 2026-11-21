import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createReferralLinkRoute } from "../packages/next/dist/links.js";

const secretKey = "cm_live_sk_fixture_123456789012";
const ready = {
  protocol: "commish-links-v1",
  status: "ready",
  location: "https://brand.example/?commish_ref=token.signature",
};
const visit = (route, creator = "maya") =>
  route(new Request(`https://brand.example/c/${creator}`), {
    params: Promise.resolve({ creator }),
  });

test("the Next route forwards a creator link through the configured key", async (t) => {
  const fetcher = mock.method(globalThis, "fetch", async () => Response.json({ data: ready }));
  t.after(() => fetcher.mock.restore());
  const response = await visit(
    createReferralLinkRoute(() => ({ secretKey, apiUrl: "https://commish.example/api/v1" })),
  );
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), ready.location);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const [url, init] = fetcher.mock.calls[0].arguments;
  assert.equal(url, "https://commish.example/api/v1/links/maya/handoff");
  assert.equal(init.headers.authorization, `Bearer ${secretKey}`);
});

test("missing configuration is a static notice, not an unhandled error or a redirect", async (t) => {
  const fetcher = mock.method(globalThis, "fetch", async () => Response.json({ data: ready }));
  t.after(() => fetcher.mock.restore());
  for (const source of [
    () => ({ secretKey: undefined }),
    () => {
      throw new Error("configuration unavailable");
    },
  ]) {
    const response = await visit(createReferralLinkRoute(source));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal(fetcher.mock.callCount(), 0);
});

test("unknown creators get the merchant's own not-found response", async (t) => {
  const fetcher = mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { code: "link_not_found", message: "Link not found." } },
      { status: 404 },
    ),
  );
  t.after(() => fetcher.mock.restore());
  const response = await visit(
    createReferralLinkRoute({
      secretKey,
      notFound: () => new Response("merchant 404", { status: 404 }),
    }),
    "nobody",
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "merchant 404");
});

test("the root route answers an outage as not found and the rewrite targets it", async (t) => {
  const { referralLinkFallbackRewrite } = await import("../packages/next/dist/links.js");
  assert.deepEqual(referralLinkFallbackRewrite(), {
    source: "/:creator([a-z0-9][a-z0-9_-]{2,39})",
    destination: "/commish-link/:creator",
  });
  assert.throws(
    () => referralLinkFallbackRewrite("https://evil.example"),
    /Invalid link handler path/,
  );
  const fetcher = mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  t.after(() => fetcher.mock.restore());
  const root = createReferralLinkRoute({ secretKey }, { root: true });
  assert.equal((await visit(root, "pricing")).status, 404);
  const prefix = createReferralLinkRoute({ secretKey });
  assert.equal((await visit(prefix, "tim")).status, 503);
});

test("concurrent requests keep their own configuration", async (t) => {
  const fetcher = mock.method(globalThis, "fetch", async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ data: { ...ready, location: `https://brand.example/?via=${url}` } });
  });
  t.after(() => fetcher.mock.restore());
  let turn = 0;
  const route = createReferralLinkRoute(async () => {
    turn += 1;
    return { secretKey, apiUrl: `https://commish-${turn}.example/api/v1` };
  });
  const [first, second] = await Promise.all([visit(route, "maya"), visit(route, "tim")]);
  assert.match(first.headers.get("location"), /commish-1\.example.*links\/maya/);
  assert.match(second.headers.get("location"), /commish-2\.example.*links\/tim/);
});

const digest = async (run) => {
  try {
    await run();
  } catch (error) {
    return String(error?.digest ?? error);
  }
  return "returned";
};
test("the root link page redirects creators and shows the site's own not-found page otherwise", async (t) => {
  const { createReferralLinkPage } = await import("../packages/next/dist/link-page.js");
  const seen = [];
  const fetcher = mock.method(globalThis, "fetch", async (url, init) => {
    seen.push(init.headers);
    if (String(url).includes("/links/maya/")) return Response.json({ data: ready });
    if (String(url).includes("/links/paused/"))
      return Response.json({
        data: { protocol: "commish-links-v1", status: "paused", reason: "funding_paused" },
      });
    return Response.json({ error: { code: "link_not_found" } }, { status: 404 });
  });
  t.after(() => fetcher.mock.restore());
  const Page = createReferralLinkPage(() => ({ secretKey }));
  const open = (creator) => () => Page({ params: Promise.resolve({ creator }) });
  // Next signals a redirect and a not-found page by throwing its own errors.
  const redirected = await digest(open("maya"));
  assert.match(redirected, /^NEXT_REDIRECT;/);
  assert.ok(redirected.includes(ready.location));
  assert.equal(seen[0]["x-commish-link-root"], "1", "marked as a root request");
  assert.match(await digest(open("pricing")), /^NEXT_HTTP_ERROR_FALLBACK;404/);
  assert.match(await digest(open("Not A Handle")), /^NEXT_HTTP_ERROR_FALLBACK;404/);
  const calls = fetcher.mock.callCount();
  assert.match(await digest(open("pricing")), /^NEXT_HTTP_ERROR_FALLBACK;404/);
  assert.equal(fetcher.mock.callCount(), calls, "a miss is remembered");
  // A pause is a notice kept out of indexes; nothing is redirected.
  const paused = await Page({ params: Promise.resolve({ creator: "paused" }) });
  const rendered = JSON.stringify(paused.props);
  assert.ok(rendered.includes("This referral link is paused"));
  assert.ok(rendered.includes("noindex, nofollow"));
});

test("the root link page is the not-found page when unconfigured or when Commish is unreachable", async (t) => {
  const { createReferralLinkPage } = await import("../packages/next/dist/link-page.js");
  const fetcher = mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  t.after(() => fetcher.mock.restore());
  const errors = [];
  const offline = createReferralLinkPage({ secretKey, onError: (error) => errors.push(error) });
  assert.match(
    await digest(() => offline({ params: Promise.resolve({ creator: "tim" }) })),
    /^NEXT_HTTP_ERROR_FALLBACK;404/,
  );
  assert.equal(errors.length, 1, "the failure is still reported");
  const broken = createReferralLinkPage(() => {
    throw new Error("configuration unavailable");
  });
  assert.match(
    await digest(() => broken({ params: Promise.resolve({ creator: "tim" }) })),
    /^NEXT_HTTP_ERROR_FALLBACK;404/,
  );
});
