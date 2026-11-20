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
    destination: "/api/commish/link/:creator",
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
