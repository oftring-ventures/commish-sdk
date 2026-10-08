import test from "node:test";
import assert from "node:assert/strict";
import { Commish, assertCreatorPage } from "../packages/sdk/dist/index.js";
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
test("server resolution is scoped, uncached, and abortable", async () => {
  let call;
  const sdk = new Commish({
    secretKey: "cm_test_sk_fixture_123456789012",
    fetch: async (url, init) => {
      call = { url, init };
      return Response.json({ data: page });
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(
    (
      await sdk.pages.resolve({
        programId: page.programId,
        handle: "maya",
        signal,
      })
    ).data,
    page,
  );
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.signal, signal);
  assert.match(call.url, /\/pages\/prg_123456789012\/maya$/);
  await assert.rejects(
    () =>
      sdk.pages.resolve({ programId: page.programId, handle: "../checkout" }),
    /Invalid/,
  );
});
for (const value of [
  { ...page, protocol: "unknown" },
  // Brand-authored testimonials are not part of the Pages protocol.
  {
    ...page,
    endorsement: { quote: "Unreviewed", author: "Maya", imageUrl: null },
  },
  { ...page, preferredPath: "//evil.test" },
  { ...page, mode: ["live"] },
  { ...page, mode: { toString: () => "live" } },
  { ...page, preferredPath: [page.canonicalPath] },
  {
    ...page,
    content: { ...page.content, productImageUrl: "javascript:alert(1)" },
  },
  {
    ...page,
    content: {
      ...page.content,
      cta: { label: "Shop", url: "https://evil.test" },
    },
  },
]) {
  test("renderer rejects unsupported or unsafe descriptions", () =>
    assert.throws(() => assertCreatorPage(value)));
}
