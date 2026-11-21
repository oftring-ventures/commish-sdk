import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createCreatorPageHandlers } from "../packages/next/dist/pages-handlers.js";
import {
  createCreatorAliasHandler,
  creatorPageFallbackRewrite,
} from "../packages/next/dist/pages-routing.js";

const page = {
  protocol: "commish-pages-v1",
  pageId: "cpg_123456789012",
  programId: "prg_123456789012",
  status: "ready",
  mode: "test",
  origin: "https://brand.example",
  canonicalPath: "/c/maya",
  preferredPath: "/c/maya",
  rootAliasEnabled: true,
  experimentEnabled: false,
  revision: "c0000000-0000-4000-8000-000000000001",
  creator: { handle: "maya" },
  couponCode: null,
  content: {
    brand: { name: "Brand", logoUrl: null, accentColor: "#123456" },
    headline: "Approved offer",
    description: "Description",
    productImageUrl: null,
    benefits: [],
    offer: { title: "Offer", description: "Terms" },
    cta: { label: "Shop", url: "https://brand.example/shop" },
    disclosures: ["Ad"],
  },
};
const params = (creator) => ({ params: Promise.resolve({ creator }) });
const options = {
  secretKey: "cm_test_sk_fixture_123456789012",
  programId: page.programId,
  origin: page.origin,
};
test("alias helper returns temporary canonical redirects only", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: page });
  try {
    const handler = createCreatorAliasHandler(options);
    const response = await handler(
      new Request(`${page.origin}/maya?next=https://evil.test`),
      params("maya"),
    );
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), `${page.origin}/c/maya`);
    assert.equal(response.headers.get("x-commish-page-id"), page.pageId);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    globalThis.fetch = async () => Response.json({ data: { ...page, rootAliasEnabled: false } });
    assert.equal(
      (await handler(new Request(`${page.origin}/noalias`), params("noalias"))).status,
      404,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(creatorPageFallbackRewrite(), {
    source: "/:creator([a-z0-9][a-z0-9_-]{2,39})",
    destination: "/api/commish/alias/:creator",
  });
});

test("unmatched paths and outages stay merchant 404s", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    const notFound = () => new Response("merchant not found", { status: 404 });
    const handler = createCreatorAliasHandler(options, { notFound });
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("offline");
    };
    const down = await handler(new Request(`${page.origin}/offline`), params("offline"));
    assert.equal(down.status, 404);
    assert.equal(await down.text(), "merchant not found");
    assert.equal(down.headers.get("retry-after"), null);
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json(
        { error: { code: "page_not_found", message: "Not found" } },
        { status: 404 },
      );
    };
    calls = 0;
    for (let i = 0; i < 5; i += 1)
      assert.equal(
        (await handler(new Request(`${page.origin}/wp-admin`), params("wp-admin"))).status,
        404,
      );
    assert.equal(calls, 1, "a miss is remembered instead of re-queried");
    calls = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        handler(new Request(`${page.origin}/crawler`), params("crawler")),
      ),
    );
    assert.equal(calls, 1, "concurrent lookups of one path are coalesced");
    calls = 0;
    for (let i = 0; i < 100; i += 1)
      await handler(new Request(`${page.origin}/probe-${i}`), params(`probe-${i}`));
    assert.ok(calls < 60, "uncached lookups are bounded per window");
  } finally {
    globalThis.fetch = original;
  }
});

test("same-origin integration rejects forged hosts and unsafe bodies before cookies", async () => {
  const { POST } = createCreatorPageHandlers({
    options: {
      secretKey: "cm_test_sk_fixture_123456789012",
      programId: page.programId,
      origin: page.origin,
    },
    publishableKey: "cm_test_pk_fixture_123456789012",
  });
  for (const origin of ["https://evil.example", null]) {
    const response = await POST(
      new Request("http://localhost:3000/api/commish/pages", {
        method: "POST",
        headers: origin ? { origin } : {},
        body: "{}",
      }),
    );
    assert.equal(response.status, 403);
  }
  assert.equal((await POST(new Request(page.origin, { method: "GET" }))).status, 405);
  assert.equal(
    (
      await POST(
        new Request(page.origin, {
          method: "POST",
          headers: { origin: page.origin, "content-type": "text/plain" },
          body: "{}",
        }),
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await POST(
        new Request(page.origin, {
          method: "POST",
          headers: { origin: page.origin, "content-type": "application/json" },
          body: "x".repeat(4097),
        }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await POST(
        new Request(page.origin, {
          method: "POST",
          headers: { origin: page.origin, "content-type": "application/json" },
          body: '{"action":"purchase"}',
        }),
      )
    ).status,
    400,
  );
});

test("verified aliases are cached and survive crawler bursts and outages", async () => {
  // Alias state is per module, so start past every budget window the tests above used.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 20_000 });
  const original = globalThis.fetch;
  const alice = {
    ...page,
    programId: "prg_alias_cache_0001",
    canonicalPath: "/c/alice",
    preferredPath: "/c/alice",
    creator: { handle: "alice" },
  };
  let calls = 0,
    outage = false;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (outage) throw new Error("offline");
    if (String(url).endsWith("/alice")) return Response.json({ data: alice });
    return Response.json(
      { error: { code: "page_not_found", message: "Not found" } },
      { status: 404 },
    );
  };
  try {
    const handler = createCreatorAliasHandler({ ...options, programId: alice.programId });
    const alias = async (handle) =>
      (await handler(new Request(`${page.origin}/${handle}`), params(handle))).status;
    for (let i = 0; i < 70; i += 1) assert.equal(await alias("alice"), 307);
    assert.equal(calls, 1, "a verified alias is read once per freshness window");
    const other = createCreatorAliasHandler({
      ...options,
      programId: alice.programId,
      origin: "https://other.example",
    });
    assert.equal(
      (await other(new Request("https://other.example/alice"), params("alice"))).status,
      404,
      "an alias verified for one origin is not reused for another",
    );
    for (let i = 0; i < 60; i += 1) assert.equal(await alias(`scan-${i}`), 404);
    assert.equal(await alias("alice"), 307, "crawler noise does not starve a verified alias");
    mock.timers.tick(61_000);
    outage = true;
    calls = 0;
    assert.equal(
      await alias("alice"),
      307,
      "an outage keeps a recently verified alias redirecting",
    );
    assert.equal(await alias("alice"), 307);
    assert.equal(
      calls,
      1,
      "revalidation during an outage is attempted at most once per failure window",
    );
    assert.equal(await alias("scan-0"), 404, "an unverified path stays a 404 during an outage");
    mock.timers.tick(600_000);
    assert.equal(await alias("alice"), 404, "a stale alias is not served beyond its bound");
  } finally {
    globalThis.fetch = original;
    mock.timers.reset();
  }
});

test("bare root links are served only when the install opts in, and are marked as root requests", async () => {
  const original = globalThis.fetch;
  const calls = [];
  // A fresh lookup window, whatever the earlier tests spent.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 3_600_000 });
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname.split("/").slice(-2).join("/")}`);
      return String(url).includes("/links/")
        ? Response.json({
            data: {
              protocol: "commish-links-v1",
              status: "ready",
              location: `${page.origin}/?commish_ref=token.signature`,
            },
          })
        : Response.json({ error: { code: "page_not_found" } }, { status: 404 });
    };
    // An upgrade alone changes nothing: without the option the path stays a 404
    // and no handoff is asked for.
    const plain = createCreatorAliasHandler(options);
    assert.equal(
      (await plain(new Request(`${page.origin}/upgraded`), params("upgraded"))).status,
      404,
    );
    assert.deepEqual(calls, ["GET prg_123456789012/upgraded"]);
    calls.length = 0;
    const handler = createCreatorAliasHandler(options, { rootLinks: true });
    globalThis.fetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname.split("/").slice(-2).join("/")}`);
      if (String(url).includes("/links/"))
        assert.equal(init.headers["x-commish-link-root"], "1", "marked as a root request");
      return String(url).includes("/links/")
        ? Response.json({
            data: {
              protocol: "commish-links-v1",
              status: "ready",
              location: `${page.origin}/?commish_ref=token.signature`,
            },
          })
        : Response.json({ error: { code: "page_not_found" } }, { status: 404 });
    };
    const response = await handler(new Request(`${page.origin}/barelink`), params("barelink"));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), `${page.origin}/?commish_ref=token.signature`);
    assert.deepEqual(calls, ["GET prg_123456789012/barelink", "POST barelink/handoff"]);
    const check = "cmprobe-0123456789abcdef01234567";
    globalThis.fetch = async (url, init) => {
      calls.push(init.headers?.["x-commish-link-check"] ?? "no-check");
      return String(url).includes("/links/")
        ? Response.json({ data: { protocol: "commish-links-v1", status: "probe" } })
        : Response.json({ error: { code: "page_not_found" } }, { status: 404 });
    };
    const probe = await handler(
      new Request(`${page.origin}/barelink`, { headers: { "x-commish-link-check": check } }),
      params("barelink"),
    );
    assert.equal(probe.status, 204);
    assert.equal(calls.at(-1), check);
    // A check for a creator who has a page alias is not lost in the alias
    // redirect: it goes to the link, and no page lookup is made for it.
    calls.length = 0;
    globalThis.fetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname.split("/").slice(-2).join("/")}`);
      return String(url).includes("/links/")
        ? Response.json({ data: { protocol: "commish-links-v1", status: "probe" } })
        : Response.json({ data: page });
    };
    const aliased = await handler(
      new Request(`${page.origin}/maya`, { headers: { "x-commish-link-check": check } }),
      params("maya"),
    );
    assert.equal(aliased.status, 204);
    assert.deepEqual(calls, ["POST maya/handoff"]);
    const visitor = await handler(new Request(`${page.origin}/maya`), params("maya"));
    assert.equal(visitor.status, 307, "a visitor still gets the page alias redirect");
    assert.equal(visitor.headers.get("location"), `${page.origin}/c/maya`);
  } finally {
    mock.timers.reset();
    globalThis.fetch = original;
  }
});
