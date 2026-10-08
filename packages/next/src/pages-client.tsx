"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { CreatorPage } from "@commish/sdk";

type Visit = {
  identified?: boolean;
  visitToken?: string;
  variation?: "standard" | "alternate";
  captured?: boolean;
  retryable?: boolean;
};
/** One same-origin identity across concurrent tabs; unsupported clients do not measure. */
export async function identifyCreatorPage(
  identify: () => Promise<Visit>,
): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.locks) return false;
  try {
    return await navigator.locks.request(
      "commish-pages-identity",
      { signal: AbortSignal.timeout(1000) },
      async () => (await identify()).identified === true,
    );
  } catch {
    return false;
  }
}
/** Coalesce concurrent starts, but let a later interaction retry an incomplete attempt. */
export function createCreatorPageStart(
  send: (action: string, extra?: Record<string, unknown>) => Promise<Visit>,
  onVisit: (visit: Visit) => void,
): () => Promise<Visit> {
  let pending: Promise<Visit> | null = null;
  return () =>
    (pending ??= identifyCreatorPage(() => send("identify"))
      .then((measurementReady) => send("start", { measurementReady }))
      .catch((): Visit => ({}))
      .then((data) => {
        if (data.retryable || typeof data.captured !== "boolean") pending = null;
        onVisit(data);
        return data;
      }));
}
/** All text is escaped by React. No remotely supplied HTML, scripts, or CSS. */
export function CreatorPageView({
  page,
  integrationPath,
}: {
  page: CreatorPage;
  integrationPath: string;
}) {
  const surface = useRef<HTMLElement>(null);
  const id = useRef<string | null>(null);
  const [variation, setVariation] = useState<"standard" | "alternate">(
    "standard",
  );
  const [visitToken, setVisitToken] = useState<string>();
  const [shopping, setShopping] = useState(false);
  const ready = page.status === "ready";
  const send = useCallback(
    async (
      action: string,
      extra: Record<string, unknown> = {},
    ): Promise<Visit> => {
      if (!id.current) id.current = crypto.randomUUID();
      const response = await fetch(integrationPath, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(action === "identify" ? 750 : 2500),
        body: JSON.stringify({
          action,
          handle: page.canonicalPath.split("/").at(-1),
          captureId: id.current,
          ...(page.status === "ready" ? { revision: page.revision } : {}),
          ...extra,
        }),
      });
      if (!response.ok) return {};
      const data = (await response.json())?.data;
      return data && typeof data === "object" ? data : {};
    },
    [integrationPath, page],
  );
  const start = useMemo(
    () =>
      createCreatorPageStart(send, (data) => {
        if (typeof data.captured === "boolean") {
          setVariation(
            data.variation === "alternate" ? "alternate" : "standard",
          );
          setVisitToken(data.visitToken);
        }
      }),
    [send],
  );
  useEffect(() => {
    if (!ready) return;
    let intersecting = false;
    const visible = () => {
      if (intersecting && document.visibilityState === "visible") void start();
    };
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting);
      visible();
    });
    if (surface.current) observer.observe(surface.current);
    document.addEventListener("visibilitychange", visible);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ready, start]);
  useEffect(() => {
    if (!visitToken) return;
    // After the selected layout commits and a paint, never on SSR or prefetch.
    let frame = 0,
      painted = 0,
      intersecting = false,
      exposed = false;
    const expose = () => {
      if (document.visibilityState !== "visible" || !intersecting || exposed)
        return;
      frame = requestAnimationFrame(() => {
        painted = requestAnimationFrame(() => {
          if (
            document.visibilityState === "visible" &&
            intersecting &&
            !exposed
          ) {
            exposed = true;
            void send("exposure", { visitToken }).catch(() => {});
          }
        });
      });
    };
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting);
      expose();
    });
    if (surface.current) observer.observe(surface.current);
    document.addEventListener("visibilitychange", expose);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(painted);
      document.removeEventListener("visibilitychange", expose);
    };
  }, [variation, visitToken, send]);
  async function shop(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !ready
    )
      return;
    event.preventDefault();
    if (shopping) return;
    setShopping(true);
    const data = await start();
    if (data.visitToken)
      await Promise.race([
        send("click", { visitToken: data.visitToken }).catch(() => ({})),
        new Promise((resolve) => setTimeout(resolve, 350)),
      ]);
    window.location.assign(page.content.cta.url);
  }
  const brand = page.status === "ended" ? page.brand : page.content.brand;
  return (
    <main
      ref={surface}
      className="commish-page"
      data-commish-page={page.pageId}
      data-variation={variation}
    >
      <style>{`
      .commish-page{box-sizing:border-box;max-width:1120px;margin:0 auto;padding:32px 24px 64px;color:#17211f;font-family:system-ui,sans-serif;line-height:1.6}
      .commish-page *{box-sizing:border-box}.commish-page header{display:flex;align-items:center;gap:12px;padding-bottom:40px;font-weight:700}
      .commish-page header img{max-width:150px;max-height:48px}.commish-page h1{font-size:clamp(2rem,5vw,3.75rem);line-height:1.1;letter-spacing:-.04em;margin:16px 0 24px}
      .commish-page h2{font-size:1.4rem;line-height:1.3}.commish-page .cp-grid{display:grid;gap:40px;align-items:center}.commish-page .cp-image{width:100%;border-radius:24px;aspect-ratio:1;object-fit:cover;background:#f1f4f3}
      .commish-page .cp-offer{padding:24px;background:#f3f6f5;border-radius:16px;margin:24px 0}.commish-page .cp-button{display:inline-block;text-align:center;text-decoration:none;background:#17211f;color:white;padding:16px 28px;border-radius:10px;font-weight:650;min-height:48px}
      .commish-page a:focus-visible{outline:3px solid #127d8e;outline-offset:5px}.commish-page blockquote{margin:32px 0;padding-left:24px;border-left:3px solid #98aaa5}
      .commish-page footer{border-top:1px solid #dce5e1;margin-top:48px;padding-top:16px;font-size:.85rem;color:#46534e}.commish-page code{font:700 1.1rem monospace}.commish-page .cp-creator{font-weight:600;font-size:.9rem}
      @media(min-width:760px){.commish-page .cp-grid{grid-template-columns:1fr 1fr}.commish-page[data-variation=alternate] .cp-visual{order:2}}
      .commish-page .cp-grid:not(:has(.cp-visual)){grid-template-columns:1fr;max-width:740px;margin:auto}
      .commish-page[data-variation=alternate] .cp-grid:not(:has(.cp-visual)){text-align:center}
      .commish-page[data-variation=alternate] .cp-grid:not(:has(.cp-visual)) ul{display:inline-block;text-align:left}
      @media(prefers-reduced-motion:reduce){.commish-page *{scroll-behavior:auto}}
    `}</style>
      <header>
        {brand.logoUrl && (
          <img src={brand.logoUrl} alt="" referrerPolicy="no-referrer" />
        )}
        <span>{brand.name}</span>
      </header>
      {page.status === "ended" ? (
        <section>
          <h1>This offer is no longer available</h1>
          <p>You can still explore {brand.name}.</p>
          <a className="cp-button" href={page.storeUrl}>
            Visit the store
          </a>
        </section>
      ) : (
        <>
          <div className="cp-grid">
            {page.content.productImageUrl && (
              <div className="cp-visual">
                <img
                  className="cp-image"
                  src={page.content.productImageUrl}
                  alt={page.content.offer.title}
                  referrerPolicy="no-referrer"
                />
              </div>
            )}
            <section>
              <p className="cp-creator">
                {brand.name} × @{page.creator.handle}
              </p>
              <h1>{page.content.headline}</h1>
              <p>{page.content.description}</p>
              <ul>
                {page.content.benefits.map((benefit, index) => (
                  <li key={index}>{benefit}</li>
                ))}
              </ul>
              <div
                className="cp-offer"
                style={{ borderTop: `3px solid ${brand.accentColor}` }}
              >
                <h2>{page.content.offer.title}</h2>
                <p>{page.content.offer.description}</p>
                {page.couponCode && (
                  <p>
                    Use code <code>{page.couponCode}</code> at checkout. Check
                    store terms for eligibility.
                  </p>
                )}
                <a
                  className="cp-button"
                  href={page.content.cta.url}
                  onClick={shop}
                  aria-busy={shopping}
                >
                  {shopping ? "Opening store…" : page.content.cta.label}
                </a>
              </div>
            </section>
          </div>
          {page.endorsement && (
            <blockquote>
              {page.endorsement.imageUrl && (
                <img
                  src={page.endorsement.imageUrl}
                  alt=""
                  width={64}
                  height={64}
                  referrerPolicy="no-referrer"
                />
              )}
              <p>{page.endorsement.quote}</p>
              <cite>{page.endorsement.author}</cite>
            </blockquote>
          )}
          <footer>
            {page.content.disclosures.map((disclosure, index) => (
              <p key={index}>{disclosure}</p>
            ))}
          </footer>
        </>
      )}
    </main>
  );
}
