import test from "node:test";
import assert from "node:assert/strict";
import {createCreatorAliasHandler,creatorPageFallbackRewrite} from "../packages/next/dist/pages-routing.js";
import {createCreatorPageHandlers} from "../packages/next/dist/pages-handlers.js";
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
    globalThis.fetch = async () =>
      Response.json({ data: { ...page, rootAliasEnabled: false } });
    assert.equal(
      (await handler(new Request(`${page.origin}/noalias`), params("noalias")))
        .status,
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
    const notFound = () =>
      new Response("merchant not found", { status: 404 });
    const handler = createCreatorAliasHandler(options, { notFound });
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("offline");
    };
    const down = await handler(
      new Request(`${page.origin}/offline`),
      params("offline"),
    );
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
        (await handler(new Request(`${page.origin}/wp-admin`), params("wp-admin")))
          .status,
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
      await handler(
        new Request(`${page.origin}/probe-${i}`),
        params(`probe-${i}`),
      );
    assert.ok(calls < 60, "uncached lookups are bounded per window");
  } finally {
    globalThis.fetch = original;
  }
});

test("same-origin integration rejects forged hosts and unsafe bodies before cookies", async () => {
 const {POST}=createCreatorPageHandlers({options:{secretKey:"cm_test_sk_fixture_123456789012",programId:page.programId,origin:page.origin},publishableKey:"cm_test_pk_fixture_123456789012"});
 for (const origin of ["https://evil.example",null]) {
  const response=await POST(new Request("http://localhost:3000/api/commish/pages",{method:"POST",headers:origin?{origin}:{},body:"{}"}));
  assert.equal(response.status,403);
 }
 assert.equal((await POST(new Request(page.origin,{method:"GET"}))).status,405);
 assert.equal((await POST(new Request(page.origin,{method:"POST",headers:{origin:page.origin,"content-type":"text/plain"},body:"{}"}))).status,415);
 assert.equal((await POST(new Request(page.origin,{method:"POST",headers:{origin:page.origin,"content-type":"application/json"},body:"x".repeat(4097)}))).status,413);
 assert.equal((await POST(new Request(page.origin,{method:"POST",headers:{origin:page.origin,"content-type":"application/json"},body:'{"action":"purchase"}'}))).status,400);
});
