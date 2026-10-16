import { assertCreatorPage, type CreatorPage } from "./pages.js";
export type BuyerPromotionSummary = {
  name: string;
  discount: {
    percentOff: number | null;
    amountOff: number | null;
    duration: "once" | "repeating" | "forever";
  } | null;
  trial: { unit: "days" | "months"; count: number } | null;
  code: string | null;
};
export type CreatorPageWithPromotion = {
  protocol: "commish-pages-v2";
  page: CreatorPage;
  buyerPromotion: BuyerPromotionSummary | null;
};
export function assertCreatorPageWithPromotion(
  value: unknown,
): asserts value is CreatorPageWithPromotion {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, expected: string[]) =>
    Object.keys(v).length === expected.length &&
    Object.keys(v).every((key) => expected.includes(key));
  const invalid = () => {
    throw new Error("Invalid creator promotion response");
  };
  if (
    !object(value) ||
    !keys(value, ["protocol", "page", "buyerPromotion"]) ||
    value.protocol !== "commish-pages-v2"
  )
    return invalid();
  assertCreatorPage(value.page);
  const p = value.buyerPromotion;
  if (p === null) return;
  if (
    value.page.status !== "ready" ||
    !object(p) ||
    !keys(p, ["name", "discount", "trial", "code"]) ||
    typeof p.name !== "string" ||
    !p.name ||
    p.name.length > 40 ||
    (p.code !== null && (typeof p.code !== "string" || p.code.length > 64))
  )
    return invalid();
  if (p.discount !== null) {
    const d = p.discount;
    if (
      !object(d) ||
      !keys(d, ["percentOff", "amountOff", "duration"]) ||
      !["once", "repeating", "forever"].includes(String(d.duration)) ||
      (d.percentOff !== null &&
        (typeof d.percentOff !== "number" || d.percentOff <= 0 || d.percentOff > 100)) ||
      (d.amountOff !== null &&
        (typeof d.amountOff !== "number" ||
          !Number.isSafeInteger(d.amountOff) ||
          d.amountOff <= 0)) ||
      (d.percentOff === null) === (d.amountOff === null)
    )
      return invalid();
  }
  if (p.trial !== null) {
    const t = p.trial;
    if (
      !object(t) ||
      !keys(t, ["unit", "count"]) ||
      !["days", "months"].includes(String(t.unit)) ||
      typeof t.count !== "number" ||
      !Number.isSafeInteger(t.count) ||
      t.count < 1 ||
      t.count > (t.unit === "days" ? 730 : 24)
    )
      return invalid();
  }
  if (p.discount === null && p.trial === null) return invalid();
}
