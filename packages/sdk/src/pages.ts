/** Versioned public projection. Private profiles and financial terms are absent. */
export type PageBrand = {
  name: string;
  logoUrl: string | null;
  accentColor: string;
};
export type PageContent = {
  brand: PageBrand;
  headline: string;
  description: string;
  productImageUrl: string | null;
  benefits: string[];
  offer: { title: string; description: string };
  cta: { label: string; url: string };
  disclosures: string[];
};
type PageBase = {
  protocol: "commish-pages-v1";
  pageId: string;
  programId: string;
  mode: "test" | "live";
  origin: string;
  canonicalPath: string;
  rootAliasEnabled: boolean;
};
export type CreatorPage = PageBase &
  (
    | {
        status: "ready";
        revision: string;
        creator: { handle: string };
        content: PageContent;
        couponCode: string | null;
        preferredPath: string;
        experimentEnabled: boolean;
      }
    | { status: "ended"; brand: PageBrand; storeUrl: string }
  );

export function pageHandle(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(value))
    throw new TypeError("Invalid creator page handle");
  return value;
}

/** Validate the render boundary even when a merchant supplies a custom transport. */
export function assertCreatorPage(
  value: unknown,
): asserts value is CreatorPage {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, allowed: string[]) =>
    Object.keys(v).every((key) => allowed.includes(key));
  const text = (v: unknown, n: number): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= n;
  const https = (v: unknown): v is string => {
    if (!text(v, 2048)) return false;
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  };
  const asset = (v: unknown) => v === null || https(v);
  const brand = (v: unknown) =>
    object(v) &&
    keys(v, ["name", "logoUrl", "accentColor"]) &&
    text(v.name, 100) &&
    asset(v.logoUrl) &&
    typeof v.accentColor === "string" &&
    /^#[a-fA-F0-9]{6}$/.test(v.accentColor);
  const invalid = () => {
    throw new TypeError("Unsupported or invalid Commish page response");
  };
  if (
    !object(value) ||
    value.protocol !== "commish-pages-v1" ||
    !text(value.pageId, 80) ||
    !/^cpg_[A-Za-z0-9_-]{12,}$/.test(value.pageId) ||
    !text(value.programId, 80) ||
    !/^prg_[A-Za-z0-9_-]{12,}$/.test(value.programId) ||
    typeof value.mode !== "string" ||
    !["test", "live"].includes(value.mode) ||
    !https(value.origin) ||
    new URL(value.origin).origin !== value.origin ||
    typeof value.rootAliasEnabled !== "boolean" ||
    typeof value.canonicalPath !== "string" ||
    !/^\/[a-z][a-z0-9-]{0,29}\/[a-z0-9][a-z0-9_-]{2,39}$/.test(
      value.canonicalPath,
    )
  )
    return invalid();
  if (value.status === "ended") {
    if (
      !keys(value, [
        "protocol",
        "pageId",
        "programId",
        "mode",
        "origin",
        "canonicalPath",
        "rootAliasEnabled",
        "status",
        "brand",
        "storeUrl",
      ]) ||
      !brand(value.brand) ||
      !https(value.storeUrl) ||
      new URL(value.storeUrl).origin !== value.origin
    )
      invalid();
    return;
  }
  const c = value.content;
  if (
    value.status !== "ready" ||
    !keys(value, [
      "protocol",
      "pageId",
      "programId",
      "mode",
      "origin",
      "canonicalPath",
      "rootAliasEnabled",
      "status",
      "revision",
      "creator",
      "content",
      "couponCode",
      "preferredPath",
      "experimentEnabled",
    ]) ||
    !object(c) ||
    !keys(c, [
      "brand",
      "headline",
      "description",
      "productImageUrl",
      "benefits",
      "offer",
      "cta",
      "disclosures",
    ]) ||
    !brand(c.brand) ||
    !text(c.headline, 160) ||
    !text(c.description, 2000) ||
    !asset(c.productImageUrl) ||
    !Array.isArray(c.benefits) ||
    c.benefits.length > 8 ||
    !c.benefits.every((v) => text(v, 240)) ||
    !object(c.offer) ||
    !keys(c.offer, ["title", "description"]) ||
    !text(c.offer.title, 160) ||
    !text(c.offer.description, 1000) ||
    !object(c.cta) ||
    !keys(c.cta, ["label", "url"]) ||
    !text(c.cta.label, 60) ||
    !https(c.cta.url) ||
    new URL(c.cta.url).origin !== value.origin ||
    !Array.isArray(c.disclosures) ||
    !c.disclosures.length ||
    c.disclosures.length > 5 ||
    !c.disclosures.every((v) => text(v, 500)) ||
    !text(value.revision, 36) ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
      value.revision,
    ) ||
    !object(value.creator) ||
    !keys(value.creator, ["handle"]) ||
    typeof value.creator.handle !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{2,39}$/.test(value.creator.handle) ||
    !(value.couponCode === null || text(value.couponCode, 64)) ||
    typeof value.experimentEnabled !== "boolean" ||
    typeof value.rootAliasEnabled !== "boolean" ||
    typeof value.preferredPath !== "string" ||
    ![
      value.canonicalPath,
      "/" + value.canonicalPath.split("/").at(-1),
    ].includes(value.preferredPath)
  )
    invalid();
}
