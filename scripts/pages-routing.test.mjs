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
  endorsement: null,
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
test("alias helper returns temporary canonical redirects only", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: page });
  try {
    const handler = createCreatorAliasHandler({
      secretKey: "cm_test_sk_fixture_123456789012",
      programId: page.programId,
      origin: page.origin,
    });
    const response = await handler(
      new Request(`${page.origin}/maya?next=https://evil.test`),
      { params: Promise.resolve({ creator: "maya" }) },
    );
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), `${page.origin}/c/maya`);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    globalThis.fetch = async () =>
      Response.json({ data: { ...page, rootAliasEnabled: false } });
    assert.equal(
      (
        await handler(new Request(`${page.origin}/maya`), {
          params: Promise.resolve({ creator: "maya" }),
        })
      ).status,
      404,
    );
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.equal(
      (
        await handler(new Request(`${page.origin}/maya`), {
          params: Promise.resolve({ creator: "maya" }),
        })
      ).status,
      503,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(creatorPageFallbackRewrite(), {
    source: "/:creator([a-z0-9][a-z0-9_-]{2,39})",
    destination: "/api/commish/alias/:creator",
  });
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
